"""Gravity Forms backfill — safety net for the live form intake.

The native WP→admin webhook is sometimes flaky (we lost ~8 Licence/Franchise
form submissions between May 14-19 2026). This module pulls entries directly
from the Gravity Forms REST API and inserts any that aren't already in our
``web_form_contacts`` collection.

Runs:
  • On every backend startup (catches anything missed while we were down)
  • Hourly via APScheduler

Endpoint provided for manual trigger from the admin UI:
  POST /api/intake/backfill/run   →   admin-only
  GET  /api/intake/backfill/status →  admin-only

ENV needed (set in backend/.env):
  WP_SITE_URL          (e.g. https://www.creativemojo.com)
  GF_CONSUMER_KEY      (ck_…)
  GF_CONSUMER_SECRET   (cs_…)
  GF_BACKFILL_FORM_IDS (comma-separated form ids — e.g. "17,32")
"""
from __future__ import annotations

import asyncio
import logging
import os
import re
from datetime import datetime, timezone
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException

logger = logging.getLogger("creative-mojo-admin.gf_backfill")

# Pulled from the same intake_routes parsing logic so reuse is consistent.
def _normalise_payload(entry: dict, form_title: str) -> dict:
    """Translate a Gravity Forms REST entry into the same shape our existing
    ``/api/intake/gravity-forms`` webhook handler ingests.

    GF returns field values keyed by numeric IDs (e.g. ``"1.3": "Kelly"`` for
    First Name). To stay compatible with the existing intake logic we map
    them by the **label name** instead, the same way GF's webhook addon
    formats outbound payloads.
    """
    fields: dict[str, str] = {}
    for k, v in entry.items():
        if not v:
            continue
        # Treat all numeric/dotted keys as field values; everything else is
        # entry-level metadata.
        if re.match(r"^\d+(\.\d+)?$", str(k)):
            fields[str(k)] = str(v)
    return {
        "form_id": int(entry["form_id"]),
        "form_title": form_title,
        "entry_id": str(entry["id"]),
        "date": entry.get("date_created"),
        "fields": fields,
    }


# Map of GF numeric field IDs → friendly labels per form. Pulled from the
# fields scraped earlier; extend here if forms change.
FIELD_LABELS_BY_FORM: dict[int, dict[str, str]] = {
    # Franchise Enquiry Contact Form (form_id=17)
    17: {
        "1.3": "First Name",
        "1.6": "Surname Name",
        "2": "Telephone Number",
        "3": "Email",
        "5.1": "1st Line of Address",
        "5.2": "2nd Line of Address (Optional)",
        "5.3": "Town/City",
        "5.4": "County",
        "5.5": "Postcode",
        "8":   "Comments",
        "10":  "How did you hear about us?",
    },
    # Licence Enquiry Contact Form (form_id=32)
    32: {
        "1.3": "First Name",
        "1.6": "Surname Name",
        "2":   "Telephone Number",
        "3":   "Email",
        "5.1": "1st Line of Address",
        "5.2": "2nd Line of Address (Optional)",
        "5.3": "Town/City",
        "5.4": "State/County",
        "5.5": "Postcode/Zip",
        "5.6": "Country",
        "8":   "Comments",
        "10":  "How did you hear about us?",
        "11":  "Facebook",
        "12":  "Google",
    },
}


# Older versions of those same forms used different numeric IDs (the form
# fields were re-numbered at some point). This map covers entries pre-2024-ish.
FIELD_LABELS_LEGACY: dict[str, str] = {
    "9":  "First Name",
    "12": "Surname Name",
    "5":  "Telephone Number",
    "4":  "Email",
    "13": "1st Line of Address",
    "14": "Town/City",
    "15": "County",       # or State on Licence
    "16": "Postcode",     # or Country (5-digit/postcode mismatch handled below)
    "28": "Postcode/Zip",
}


def _pluck(entry: dict, *keys: str) -> Optional[str]:
    """Return the first non-empty value across the given key candidates."""
    for k in keys:
        v = entry.get(k)
        if v is not None and str(v).strip() != "":
            return str(v).strip()
    return None


def _looks_legacy(entry: dict) -> bool:
    """Detect legacy GF field-ID layout vs the current one."""
    # If any current-shape primary key has a value, treat as current.
    for k in ("1.3", "1.6", "2", "3"):
        v = entry.get(k)
        if v not in (None, "", []):
            return False
    # Else if a legacy-shape key has a value, treat as legacy.
    for k in ("9", "12", "5", "4"):
        v = entry.get(k)
        if v not in (None, "", []):
            return True
    return False


# In-process status — exposed by /api/intake/backfill/status.
_backfill_state: dict = {
    "last_run_at": None,
    "last_inserted": 0,
    "last_checked": 0,
    "last_error": None,
}


async def _fetch_recent_entries(form_id: int, limit: int = 50) -> list[dict]:
    """Most-recent ``limit`` entries from one Gravity Form."""
    base = os.environ.get("WP_SITE_URL")
    key = os.environ.get("GF_CONSUMER_KEY")
    secret = os.environ.get("GF_CONSUMER_SECRET")
    if not (base and key and secret):
        raise RuntimeError("WP_SITE_URL / GF_CONSUMER_KEY / GF_CONSUMER_SECRET not set")
    url = f"{base.rstrip('/')}/wp-json/gf/v2/entries"
    params = {
        "form_ids": str(form_id),
        "paging[page_size]": str(limit),
        "sorting[key]": "id",
        "sorting[direction]": "DESC",
    }
    async with httpx.AsyncClient(timeout=20.0) as http:
        r = await http.get(url, params=params, auth=(key, secret))
    if r.status_code != 200:
        raise RuntimeError(f"GF API {r.status_code}: {r.text[:300]}")
    return r.json().get("entries") or []


async def run_backfill(db, limit_per_form: int = 50) -> dict:
    """Pull the most-recent N entries per form and insert anything missing.
    Returns ``{inserted, checked, errors}``."""
    form_ids = [
        int(x) for x in (os.environ.get("GF_BACKFILL_FORM_IDS") or "").split(",")
        if x.strip().isdigit()
    ]
    if not form_ids:
        raise RuntimeError("GF_BACKFILL_FORM_IDS env not configured")

    inserted = 0
    checked = 0
    errors: list[str] = []

    for form_id in form_ids:
        try:
            entries = await _fetch_recent_entries(form_id, limit=limit_per_form)
        except Exception as exc:
            errors.append(f"form {form_id}: {exc}")
            logger.warning("GF backfill fetch failed (form %s): %s", form_id, exc)
            continue
        checked += len(entries)

        # Which entry_ids are already in our DB?
        ids = [str(e["id"]) for e in entries]
        existing = await db.web_form_contacts.find(
            {"gravity_entry_id": {"$in": ids}},
            {"_id": 0, "gravity_entry_id": 1},
        ).to_list(len(ids))
        have = {e["gravity_entry_id"] for e in existing}
        labels = FIELD_LABELS_BY_FORM.get(form_id, {})

        # Form title — pulled once. (GF response embeds form_id; we just
        # construct a sensible default so downstream consumers know which form.)
        form_title = "Gravity Form (id %s)" % form_id
        # We could call /wp-json/gf/v2/forms/{id} for the real title but it
        # adds a round-trip per form per run. Hard-code the two known ones.
        if form_id == 17:
            form_title = "Franchise Enquiry Contact Form"
        elif form_id == 32:
            form_title = "Licence Enquiry Contact Form"

        for entry in entries:
            eid = str(entry["id"])
            if eid in have:
                continue
            # Skip obvious spam (consistent with our manual backfill earlier).
            email = entry.get("3") or ""
            first = entry.get("1.3") or entry.get("1.2") or ""
            last = entry.get("1.6") or entry.get("1.4") or ""
            full_name = f"{first} {last}".strip()
            if _looks_like_spam(full_name, email):
                logger.info("GF backfill skipping spam entry %s (%s / %s)", eid, full_name, email)
                continue

            # Build the friendly-labelled fields dict (same shape as the
            # native webhook produces — keeps the downstream ingest path
            # identical).
            friendly: dict[str, str] = {}
            for key, val in entry.items():
                if val in (None, "", []) or not re.match(r"^\d+(\.\d+)?$", str(key)):
                    continue
                label = labels.get(key)
                if label:
                    friendly[label] = str(val)

            # Insert via the same path our webhook uses — call it directly.
            # We can't reuse the FastAPI dependency without HTTP self-call,
            # so we replicate the insert here. The shape must match exactly.
            now = datetime.now(timezone.utc)
            doc = {
                "id": _uuid(),
                "first_name": first or None,
                "last_name": last or None,
                "email": (email or None) and email.strip().lower(),
                "telephone": entry.get("2") or None,
                "address_line_1": entry.get("5.1") or None,
                "address_line_2": entry.get("5.2") or None,
                "town_city": entry.get("5.3") or None,
                "county": entry.get("5.4") or None,
                "postcode": entry.get("5.5") or None,
                "country": entry.get("5.6") or None,
                "comments": entry.get("8") or None,
                "heard_about_us": entry.get("10") or None,
                "facebook": entry.get("11") or None,
                "google": entry.get("12") or None,
                "raw_fields": friendly,
                "form_id": str(form_id),
                "form_title": form_title,
                "source": "licence_enquiry" if form_id == 32 else "franchise_enquiry",
                "gravity_entry_id": eid,
                "date": entry.get("date_created"),
                "created_at": now,
                "in_pipeline": True,
                "ingested_via": "gf_backfill",
            }
            try:
                await db.web_form_contacts.insert_one(doc)
                inserted += 1
                logger.info("GF backfill inserted entry %s (%s)", eid, full_name)
            except Exception as exc:  # noqa: BLE001
                errors.append(f"entry {eid}: {exc}")

    _backfill_state.update({
        "last_run_at": datetime.now(timezone.utc),
        "last_inserted": inserted,
        "last_checked": checked,
        "last_error": "; ".join(errors)[:500] if errors else None,
    })
    return {"inserted": inserted, "checked": checked, "errors": errors}


def _uuid() -> str:
    import uuid
    return str(uuid.uuid4())


_SPAM_PATTERNS = [
    re.compile(r"iclub-china", re.I),
    re.compile(r"@yandex\\.", re.I),
    re.compile(r"viagra|cialis|crypto-?invest|forex-bot", re.I),
]


def _looks_like_spam(name: str, email: str) -> bool:
    blob = f"{name} {email}".lower()
    # Repeated-word names like "MiltonIdova MiltonIdova"
    parts = name.split()
    if len(parts) >= 2 and len(set(parts)) == 1 and len(parts[0]) > 4:
        return True
    return any(p.search(blob) for p in _SPAM_PATTERNS)


# ---------------------------------------------------------------- router
def attach(api, db, require_role):
    router = APIRouter()

    @router.post("/intake/backfill/run")
    async def backfill_run(user: dict = Depends(require_role("admin"))):
        try:
            result = await run_backfill(db, limit_per_form=50)
            return {"ok": True, **result, "by": user.get("email")}
        except Exception as exc:
            raise HTTPException(500, detail=str(exc))

    @router.get("/intake/backfill/status")
    async def backfill_status(_user: dict = Depends(require_role("admin"))):
        return _backfill_state

    return router


# ---------------------------------------------------------------- scheduler
async def schedule_periodic(db, every_seconds: int = 3600):
    """Background task — runs immediately on startup, then every hour.
    Survives single failures (logs + continues).
    """
    # 30-second startup delay so we don't compete with the rest of the boot.
    await asyncio.sleep(30)
    while True:
        try:
            result = await run_backfill(db, limit_per_form=50)
            if result["inserted"]:
                logger.info("GF backfill cycle: inserted %s of %s checked",
                            result["inserted"], result["checked"])
        except Exception as exc:  # noqa: BLE001
            logger.warning("GF backfill cycle failed: %s", exc)
        await asyncio.sleep(every_seconds)
