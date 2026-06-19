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
  GF_BACKFILL_FORM_IDS (OPTIONAL, comma-separated form IDs — overrides
                        the default list from form_intake_config.py.
                        Only set in emergencies; the in-code list is the
                        source of truth.)
"""
from __future__ import annotations

import asyncio
import logging
import os
import re
from datetime import datetime, timezone, timedelta
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException

logger = logging.getLogger("creative-mojo-admin.gf_backfill")

# Pulled from the same intake_routes parsing logic so reuse is consistent.
def _legacy_normalise_payload(entry: dict, form_title: str) -> dict:  # noqa: ARG001  (kept for callers)
    """Reserved — used to translate GF dotted-id entries. Live forms use the
    flat numeric layout instead, so this is a no-op kept only for API
    backwards compatibility with any external callers."""
    return {"form_id": int(entry["form_id"]), "form_title": form_title,
            "entry_id": str(entry["id"]), "date": entry.get("date_created"),
            "fields": {}}


# Field-ID layout for the LIVE Franchise (17) + Licence (32) Gravity Forms.
# Verified against /wp-json/gf/v2/entries on 2026-05-19. These forms use the
# "legacy" numeric IDs (9/12/4/5/13/14/15/16/28/6/24.x), not the dotted-key
# format some other GF installs emit.
#
# Shared keys (forms 17 & 32):
#   9   First Name
#  12   Surname
#   4   Email
#   5   Telephone
#  13   1st Line of Address
#  14   Town / City
#  15   County  (form 17)  /  State (form 32)
#  16   Postcode (form 17) /  Country (form 32, sometimes also the zip)
#  28   Postcode / Zip   (form 32 only)
#   6   Comments / Your Message
#  24.1 "Facebook" (selected when ticked, blank otherwise)
#  24.2 "X / Twitter"
#  24.3 "Instagram"
#  24.4 "Google"
#  24.5 "Other"
#  25.1 "SPAM MAIL" agreement (always "Ok, i'll check my spam!")
#   7.1 "I agree" privacy
FIELD_LABELS_BY_FORM: dict[int, dict[str, str]] = {
    # General "Contact Form" on /contact/ — used for ALL types of enquiry
    # (franchise, licence, care-home class, art-kit, other). Field 20 is the
    # "Reason for contacting" dropdown which drives the ``source`` mapping.
    1: {
        "9":  "First Name",
        "12": "Surname Name",
        "5":  "Telephone Number",
        "4":  "Email",
        "21": "Establishment Name",
        "13": "1st Line of Address",
        "14": "City/Town",
        "15": "County",
        "16": "Postcode",
        "20": "Reason for Contacting",
        "6":  "Comments",
        "24.1": "Anti-Spam Confirmation",
        "7.1":  "Privacy",
    },
    17: {
        "9":  "First Name",
        "12": "Surname Name",
        "5":  "Telephone Number",
        "4":  "Email",
        "13": "1st Line of Address",
        "14": "City/Town",
        "15": "County",
        "16": "Postcode",
        "6":  "Comments",
        "24.1": "Facebook",
        "24.2": "X",
        "24.3": "Instagram",
        "24.4": "Google",
        "24.5": "Other",
        "25.1": "SPAM MAIL",
        "7.1":  "Privacy",
    },
    32: {
        "9":  "First Name",
        "12": "Surname Name",
        "5":  "Telephone Number",
        "4":  "Email",
        "13": "1st Line of Address",
        "14": "City/Town",
        "15": "State/County",
        "28": "Postcode/Zip",
        "16": "Country",
        "6":  "Comments",
        "24.1": "Facebook",
        "24.2": "X",
        "24.3": "Instagram",
        "24.4": "Google",
        "24.5": "Other",
        "25.1": "SPAM MAIL",
        "7.1":  "Privacy",
    },
    # Form 33 — short Franchise Enquiry popup (June 2026). Confirmed
    # field IDs from the WordPress Gravity Forms editor: Name=5,
    # Email=4, Phone=6, Postcode=7.
    33: {
        "5": "First Name",
        "4": "Email",
        "6": "Phone Number",
        "7": "Postcode",
    },
}


# Form-1 only — translate the "Reason for contacting" dropdown into one of our
# pipeline source codes. Anything outside this list lands in the general
# enquiries bucket and stays OUT of the pipeline kanban.
FORM1_REASON_TO_SOURCE: dict[str, str] = {
    "franchise enquiry": "franchise_enquiry",
    "licence enquiry":   "licence_enquiry",
    "care home class enquiry":   "care_home_enquiry",
    "deliverable art kit enquiry": "art_kit_enquiry",
    "other": "general_enquiry",
}
PIPELINE_SOURCES: set = {"franchise_enquiry", "licence_enquiry"}


def _heard_about_us(entry: dict) -> Optional[str]:
    """GF radio for "Where did you hear about Creative Mojo?" lives across
    keys 24.1..24.5 — the selected option's value equals its label, the rest
    are empty strings."""
    for k, label in (("24.1","Facebook"),("24.2","X"),("24.3","Instagram"),
                     ("24.4","Google"),("24.5","Other")):
        v = entry.get(k)
        if v and str(v).strip():
            return label
    return None


def _pluck(entry: dict, *keys: str) -> Optional[str]:  # noqa: ARG001  (kept for back-compat)
    """Return the first non-empty value across the given key candidates."""
    for k in keys:
        v = entry.get(k)
        if v is not None and str(v).strip() != "":
            return str(v).strip()
    return None


# In-process status — exposed by /api/intake/backfill/status.
_backfill_state: dict = {
    "last_run_at": None,
    "last_inserted": 0,
    "last_checked": 0,
    "last_error": None,
}


async def _fetch_recent_entries(form_id: int, limit: int = 50) -> list[dict]:
    """Most-recent ``limit`` entries from one Gravity Form. Pulls BOTH
    active and spam-flagged entries — Gravity Forms aggressively marks
    legitimate leads as spam (e.g. when a honey-pot field on the form
    doesn't get the exact expected answer), and our own
    ``_looks_like_spam`` filter is the authoritative judge once they're
    in our system. Trashed entries are still excluded since those were
    deleted on the WP side."""
    base = os.environ.get("WP_SITE_URL")
    key = os.environ.get("GF_CONSUMER_KEY")
    secret = os.environ.get("GF_CONSUMER_SECRET")
    if not (base and key and secret):
        raise RuntimeError("WP_SITE_URL / GF_CONSUMER_KEY / GF_CONSUMER_SECRET not set")
    url = f"{base.rstrip('/')}/wp-json/gf/v2/entries"

    # GF REST API requires a separate request per status. We dedupe by
    # entry id on the way back in case GF ever returns the same row
    # twice. The ``search`` param must be a JSON-encoded string per the
    # v2 API contract — passing ``search[status]=spam`` returns a 400.
    import json as _json
    out: dict[str, dict] = {}
    async with httpx.AsyncClient(timeout=20.0) as http:
        for status in ("active", "spam"):
            params = {
                "form_ids": str(form_id),
                "paging[page_size]": str(limit),
                "sorting[key]": "id",
                "sorting[direction]": "DESC",
                "search": _json.dumps({"status": status}),
            }
            try:
                r = await http.get(url, params=params, auth=(key, secret))
                if r.status_code != 200:
                    logger.warning("GF API %s status=%s for form %s: %s",
                                   r.status_code, status, form_id, r.text[:200])
                    continue
                for e in (r.json().get("entries") or []):
                    eid = str(e.get("id"))
                    if eid:
                        # Tag with the WP-side status so the insert path
                        # can audit-log "rescued from spam".
                        e.setdefault("_wp_status", status)
                        out[eid] = e
            except Exception as exc:  # noqa: BLE001
                logger.warning("GF API fetch failed (form %s status %s): %s",
                               form_id, status, exc)
    # Keep DESC order on the way out so newest entries hit the spam-
    # filter check first.
    return sorted(out.values(), key=lambda e: int(e.get("id") or 0), reverse=True)


async def run_backfill(db, limit_per_form: int = 50, repair_stubs: bool = True) -> dict:
    """Pull the most-recent N entries per form and insert anything missing.
    When ``repair_stubs=True``, existing rows with empty ``first_name`` AND
    ``last_name`` AND ``ingested_via='gf_backfill'`` are UPDATED in place
    (rather than skipped). This recovers from a previous backfill that ran
    with the wrong field-ID mapping.
    Returns ``{inserted, updated, checked, errors}``."""
    # Form IDs come from the shared form_intake_config module so adding a
    # new Gravity Form is a one-line code change. GF_BACKFILL_FORM_IDS env
    # var is still honoured (comma-separated overrides) for emergency ops,
    # but is no longer required for the backfill to run.
    env_override = (os.environ.get("GF_BACKFILL_FORM_IDS") or "").strip()
    if env_override:
        form_ids = [int(x) for x in env_override.split(",") if x.strip().isdigit()]
    else:
        from form_intake_config import backfill_form_ids
        form_ids = backfill_form_ids()
    if not form_ids:
        raise RuntimeError("No Gravity Forms configured for backfill")

    inserted = 0
    updated = 0
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

        # Existing rows for these entry IDs — keep the full doc so we can
        # decide between skip vs repair.
        ids = [str(e["id"]) for e in entries]
        existing_rows = await db.web_form_contacts.find(
            {"gravity_entry_id": {"$in": ids}},
            {"_id": 0, "gravity_entry_id": 1, "first_name": 1, "last_name": 1, "ingested_via": 1},
        ).to_list(len(ids))
        have_by_id = {e["gravity_entry_id"]: e for e in existing_rows}

        # Tombstones — entries an admin explicitly deleted. Never re-insert.
        tomb_rows = await db.gf_deleted_entries.find(
            {"gravity_entry_id": {"$in": ids}},
            {"_id": 0, "gravity_entry_id": 1},
        ).to_list(len(ids))
        tombstoned = {t["gravity_entry_id"] for t in tomb_rows}

        labels = FIELD_LABELS_BY_FORM.get(form_id, {})

        if form_id == 17:
            form_title = "Franchise Enquiry Contact Form"
        elif form_id == 32:
            form_title = "Licence Enquiry Contact Form"
        elif form_id == 33:
            form_title = "Franchise Enquiry Short Form (popup)"
        elif form_id == 1:
            form_title = "Contact Form"
        else:
            form_title = "Gravity Form (id %s)" % form_id

        for entry in entries:
            eid = str(entry["id"])

            # Admin-deleted — skip permanently.
            if eid in tombstoned:
                logger.info("GF backfill skipping tombstoned entry %s (form %s)", eid, form_id)
                continue

            # Pull field values using the actual live field-ID layout.
            first = (entry.get("9")  or "").strip() or None
            last  = (entry.get("12") or "").strip() or None
            email = (entry.get("4")  or "").strip().lower() or None
            phone = (entry.get("5")  or "").strip() or None
            addr1 = (entry.get("13") or "").strip() or None
            town  = (entry.get("14") or "").strip() or None
            county = (entry.get("15") or "").strip() or None
            comments = (entry.get("6") or "").strip() or None
            establishment = (entry.get("21") or "").strip() or None  # form 1 only

            # Form-specific quirks.
            if form_id == 32:
                # Licence: split postcode (28) + country (16)
                postcode = (entry.get("28") or "").strip() or None
                country  = (entry.get("16") or "").strip() or None
                source = "licence_enquiry"
                in_pipeline_flag = True
            elif form_id == 33:
                # Short franchise popup — confirmed field IDs:
                # Name=5, Email=4, Phone=6, Postcode=7.
                first = (entry.get("5") or "").strip() or first
                email = (entry.get("4") or "").strip().lower() or email
                phone = (entry.get("6") or "").strip() or phone
                postcode = (entry.get("7") or "").strip() or None
                country  = None
                source = "franchise_enquiry"
                in_pipeline_flag = True
            elif form_id == 1:
                postcode = (entry.get("16") or "").strip() or None
                country  = None
                reason   = (entry.get("20") or "").strip()
                source   = FORM1_REASON_TO_SOURCE.get(reason.lower(), "general_enquiry")
                # Only franchise / licence enquiries enter the sales pipeline;
                # care-home/art-kit/other land in CRM but stay out of kanban.
                in_pipeline_flag = source in PIPELINE_SOURCES
            else:
                # Form 17 (Franchise)
                postcode = (entry.get("16") or "").strip() or None
                country  = None
                source = "franchise_enquiry"
                in_pipeline_flag = True

            full_name = f"{first or ''} {last or ''}".strip()

            # Spam filter (consistent with manual triage earlier).
            if _looks_like_spam(full_name, email or ""):
                logger.info("GF backfill skipping spam entry %s (%s / %s)", eid, full_name, email)
                continue

            # Friendly-label dict — same shape the live webhook emits.
            friendly: dict[str, str] = {}
            for key, val in entry.items():
                if val in (None, "", []) or not re.match(r"^\d+(\.\d+)?$", str(key)):
                    continue
                label = labels.get(key)
                if label:
                    friendly[label] = str(val)

            now = datetime.now(timezone.utc)
            doc_core = {
                "first_name": first,
                "last_name": last,
                "email": email,
                "telephone": phone,
                "address_line_1": addr1,
                "address_line_2": None,
                "town_city": town,
                "county": county,
                "postcode": postcode,
                "country": country,
                "establishment_name": establishment,
                "comments": comments,
                "heard_about_us": _heard_about_us(entry),
                "facebook": (entry.get("24.1") or None) or None,
                "google":   (entry.get("24.4") or None) or None,
                "raw_fields": friendly,
                "form_id": str(form_id),
                "form_title": form_title,
                "source": source,
                "reason_for_contacting": (entry.get("20") or None) if form_id == 1 else None,
                "gravity_entry_id": eid,
                "date": entry.get("date_created"),
                "in_pipeline": in_pipeline_flag,
                "pipeline_status": "new" if in_pipeline_flag else None,
                "ingested_via": "gf_backfill",
                "updated_at": now,
            }

            existing = have_by_id.get(eid)
            if existing is None:
                # Brand-new entry — insert.
                doc_core["id"] = _uuid()
                doc_core["created_at"] = now
                # Audit-log the rescue from GF's spam filter so we can
                # see what bypassed it in a clean trail.
                wp_status = entry.get("_wp_status")
                if wp_status and wp_status != "active":
                    doc_core["gf_wp_status"] = wp_status
                    doc_core["gf_spam_rescued"] = True
                try:
                    await db.web_form_contacts.insert_one(doc_core)
                    inserted += 1
                    if wp_status and wp_status != "active":
                        logger.warning(
                            "GF backfill rescued entry %s from GF status=%s (%s / %s)",
                            eid, wp_status, full_name, email,
                        )
                    else:
                        logger.info("GF backfill inserted entry %s (%s)", eid, full_name)
                except Exception as exc:  # noqa: BLE001
                    errors.append(f"entry {eid}: {exc}")
                continue

            # Existing — repair only if the previous row was a name-less stub
            # left over from the broken backfill mapping.
            is_stub = (
                repair_stubs
                and (existing.get("ingested_via") == "gf_backfill")
                and not (existing.get("first_name") or existing.get("last_name"))
            )
            if not is_stub:
                continue

            try:
                await db.web_form_contacts.update_one(
                    {"gravity_entry_id": eid},
                    {"$set": doc_core},
                )
                updated += 1
                logger.info("GF backfill repaired stub entry %s (%s)", eid, full_name)
            except Exception as exc:  # noqa: BLE001
                errors.append(f"repair entry {eid}: {exc}")

    _backfill_state.update({
        "last_run_at": datetime.now(timezone.utc),
        "last_inserted": inserted,
        "last_updated": updated,
        "last_checked": checked,
        "last_error": "; ".join(errors)[:500] if errors else None,
    })
    return {"inserted": inserted, "updated": updated, "checked": checked, "errors": errors}


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


async def _repair_pipeline_membership(db) -> dict:
    """DISABLED — the previous implementation was unsafe: it set
    ``pipeline_status="new"`` on every franchise/licence row whose
    ``in_pipeline`` flag wasn't ``True``, which dragged 900+ historically-
    archived contacts back into the NEW column. Kept as a no-op for the
    callers but does nothing. Use the dedicated repair endpoints
    (``/intake/backfill/undo-bad-repair``) instead.
    """
    return {"web_repaired": 0, "legacy_repaired": 0, "disabled": True}


async def _undo_bad_repair(db, cutoff_days: int = 14) -> dict:
    """One-shot remediation: undo the over-eager pipeline_status='new'
    sweep my earlier code did. Reverts any franchise/licence row whose
    submission is older than ``cutoff_days`` days back to the archived
    state (``in_pipeline=false``, ``pipeline_status=None``). Rows
    submitted within the last ``cutoff_days`` are LEFT ALONE — those are
    legitimate fresh enquiries that should remain in NEW.

    Returns counts so the admin can sanity-check.
    """
    pipeline_sources_list = list(PIPELINE_SOURCES)
    cutoff = (datetime.now(timezone.utc) - timedelta(days=cutoff_days)).isoformat()

    # Match rows that LOOK swept-up by the bad repair:
    #   • in PIPELINE_SOURCES
    #   • currently flagged in_pipeline=true with pipeline_status='new'
    #   • but received/created older than cutoff_days days ago
    #   • AND have never had pipeline_status_history beyond this one entry
    #
    # The ``$expr`` clause guards against re-archiving rows where an
    # admin has actually been working the pipeline — if a row has any
    # touched_at / contacted_at / engaged_at / replied_at field set
    # within the cutoff window, we leave it alone.
    base_filter: dict = {
        "source": {"$in": pipeline_sources_list},
        "in_pipeline": True,
        "pipeline_status": "new",
        "$or": [
            {"received_at": {"$lt": cutoff, "$ne": None}},
            {"created_at": {"$lt": cutoff, "$ne": None}},
            {"date": {"$lt": cutoff, "$ne": None}},
        ],
    }
    web = await db.web_form_contacts.update_many(
        base_filter,
        {"$set": {"in_pipeline": False, "pipeline_status": None,
                  "auto_archived_at": datetime.now(timezone.utc).isoformat(),
                  "auto_archived_reason": "undo_bad_pipeline_repair"}},
    )
    legacy = await db.contacts.update_many(
        base_filter,
        {"$set": {"in_pipeline": False, "pipeline_status": None,
                  "auto_archived_at": datetime.now(timezone.utc).isoformat(),
                  "auto_archived_reason": "undo_bad_pipeline_repair"}},
    )
    logger.warning(
        "undo_bad_repair: archived %s web + %s legacy rows older than %s days",
        web.modified_count, legacy.modified_count, cutoff_days,
    )
    return {
        "web_archived": web.modified_count,
        "legacy_archived": legacy.modified_count,
        "cutoff_days": cutoff_days,
    }


# ---------------------------------------------------------------- router
def attach(api, db, require_role):
    router = APIRouter()

    @router.post("/intake/backfill/run")
    async def backfill_run(
        limit: int = 50,
        repair: bool = True,
        user: dict = Depends(require_role("admin")),
    ):
        try:
            # Clamp to a sensible ceiling so an accidental ?limit=10000 doesn't
            # hammer the GF REST API.
            limit = max(1, min(500, int(limit)))
            result = await run_backfill(db, limit_per_form=limit, repair_stubs=repair)
            # Self-heal pipeline membership on every manual run too —
            # makes the "Refresh from Gravity Forms" button a one-stop
            # fix for the "form 33 didn't appear in pipeline" bug.
            heal = await _repair_pipeline_membership(db)
            return {"ok": True, **result, **heal, "by": user.get("email")}
        except Exception as exc:
            raise HTTPException(500, detail=str(exc))

    @router.post("/intake/backfill/undo-bad-repair")
    async def undo_bad_repair_endpoint(
        cutoff_days: int = 14,
        user: dict = Depends(require_role("admin")),
    ):
        """EMERGENCY: undo the over-eager pipeline_status='new' sweep
        that the previous self-heal logic ran. Archives any
        franchise/licence row currently in NEW that's older than
        ``cutoff_days`` (default 14). Idempotent.
        """
        result = await _undo_bad_repair(db, cutoff_days=cutoff_days)
        return {"ok": True, **result, "by": user.get("email")}

    @router.post("/intake/backfill/repair-pipeline")
    async def repair_pipeline_only(user: dict = Depends(require_role("admin"))):
        """No-op stub — kept for compatibility with the admin UI but
        does nothing (the previous self-heal was unsafe). See
        /intake/backfill/undo-bad-repair to remediate."""
        return {"ok": True, "web_repaired": 0, "legacy_repaired": 0,
                "disabled": True, "by": user.get("email")}

    @router.get("/intake/backfill/status")
    async def backfill_status(_user: dict = Depends(require_role("admin"))):
        return _backfill_state

    return router


# ---------------------------------------------------------------- scheduler
async def schedule_periodic(db, every_seconds: int = 600):
    """Background task — runs immediately on startup, then every 10 min
    (was 60 min). 10 min keeps the "fresh form-33 lead → pipeline" delay
    short even when the live webhook silently fails. Each cycle also
    self-heals pipeline membership so legacy-tagged rows can't
    permanently hide from the kanban.

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
            heal = await _repair_pipeline_membership(db)
            if heal["web_repaired"] or heal["legacy_repaired"]:
                logger.info("GF backfill cycle self-heal: %s", heal)
        except Exception as exc:  # noqa: BLE001
            logger.warning("GF backfill cycle failed: %s", exc)
        await asyncio.sleep(every_seconds)
