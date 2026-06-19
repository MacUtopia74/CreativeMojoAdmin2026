"""DB-backed Gravity Forms intake configuration.

Replaces the static ``form_intake_config.py`` mapping with a MongoDB
collection so non-developers can add a new Gravity Form via the admin UI
without touching code or env vars. Static config is still imported once
on startup to SEED the collection — after that the DB is the source of
truth and the static module is kept only as a safety fallback if a
form's row goes missing.

Schema (collection ``gf_form_configs``)::

    {
      "form_id": int,                     # unique
      "form_title": str | None,
      "source": str,                      # franchise_enquiry / licence_enquiry / ...
      "in_pipeline": bool,                # show in sales kanban?
      "field_map": {                      # GF field-ID strings (dotted allowed)
        "first_name": "9.3" | None,
        "last_name":  "9.6" | None,
        "full_name":  "5.3" | None,       # falls back to split first+last
        "email":      "4",
        "phone":      "6",
        "postcode":   "7.5",
        "message":    "20" | None,
      },
      "reason_routing": {                 # Form 1 only — sub-route by Reason
        "<reason text lowercased>": "<source>",
        ...
      },
      "created_at": ISODate,
      "updated_at": ISODate,
    }
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Iterable

logger = logging.getLogger(__name__)

COLLECTION = "gf_form_configs"

# Canonical pipeline-eligible source categories. The UI lets admins pick
# from this set when configuring a form — keeps things consistent with
# the kanban tab labels.
KNOWN_SOURCES: tuple[str, ...] = (
    "franchise_enquiry",
    "licence_enquiry",
    "care_home_enquiry",
    "art_kit_enquiry",
    "general_enquiry",
)
PIPELINE_SOURCES: frozenset[str] = frozenset({"franchise_enquiry", "licence_enquiry"})

# Standard fields the CRM cares about. The admin maps each to a GF
# field ID (string, dotted allowed). All optional except email — without
# email we can't dedupe.
STANDARD_FIELDS: tuple[str, ...] = (
    "first_name", "last_name", "full_name",
    "email", "phone", "postcode", "message",
)


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ---------------------------------------------------------------------------
# Seed migration — copy the static intake config into MongoDB on first run.
# Subsequent startups become no-ops (we only insert forms that aren't there).
# ---------------------------------------------------------------------------
_STATIC_SEED: list[dict] = [
    {
        "form_id": 1,
        "form_title": "General Contact Form",
        "source": "general_enquiry",
        "in_pipeline": False,
        "field_map": {
            "first_name": "9",
            "last_name":  "12",
            "full_name":  None,
            "email":      "4",
            "phone":      "5",
            "postcode":   "16",
            "message":    "6",
        },
        # Form 1's "Reason for contacting" sub-routes the lead — these
        # carry over from the original FORM1_REASON_TO_SOURCE map.
        "reason_routing": {
            "franchise enquiry":            "franchise_enquiry",
            "licence enquiry":              "licence_enquiry",
            "care home class enquiry":      "care_home_enquiry",
            "deliverable art kit enquiry":  "art_kit_enquiry",
            "other":                        "general_enquiry",
        },
        "reason_field": "20",
    },
    {
        "form_id": 17,
        "form_title": "Franchise Enquiry Contact Form",
        "source": "franchise_enquiry",
        "in_pipeline": True,
        "field_map": {
            "first_name": "9",
            "last_name":  "12",
            "full_name":  None,
            "email":      "4",
            "phone":      "5",
            "postcode":   "16",
            "message":    "6",
        },
    },
    {
        "form_id": 32,
        "form_title": "Licence Enquiry",
        "source": "licence_enquiry",
        "in_pipeline": True,
        "field_map": {
            "first_name": "9",
            "last_name":  "12",
            "full_name":  None,
            "email":      "4",
            "phone":      "5",
            "postcode":   "28",
            "message":    "6",
        },
        "extras": {"country_field": "16"},
    },
    {
        "form_id": 33,
        "form_title": "Franchise Enquiry (Short Popup)",
        "source": "franchise_enquiry",
        "in_pipeline": True,
        "field_map": {
            "first_name": None,
            "last_name":  None,
            "full_name":  "5.3",   # composite "Name" sub-field, split on whitespace
            "email":      "4",
            "phone":      "6",
            "postcode":   "7.5",
            "message":    None,
        },
    },
]


async def seed_if_empty(db) -> int:
    """Insert the static defaults into Mongo if a form_id isn't already
    in the collection. Idempotent — safe to call on every boot.
    Returns the number of docs inserted."""
    inserted = 0
    for cfg in _STATIC_SEED:
        existing = await db[COLLECTION].find_one(
            {"form_id": cfg["form_id"]}, {"_id": 1}
        )
        if existing:
            continue
        doc = dict(cfg)
        doc["created_at"] = _now()
        doc["updated_at"] = _now()
        await db[COLLECTION].insert_one(doc)
        inserted += 1
        logger.info("gf_form_configs seeded form_id=%s", cfg["form_id"])
    return inserted


# ---------------------------------------------------------------------------
# Lookup helpers
# ---------------------------------------------------------------------------
async def list_configs(db) -> list[dict]:
    cursor = db[COLLECTION].find({}, {"_id": 0}).sort("form_id", 1)
    return await cursor.to_list(length=None)


async def get_config(db, form_id: int) -> dict | None:
    return await db[COLLECTION].find_one({"form_id": int(form_id)}, {"_id": 0})


async def upsert_config(db, payload: dict, *, allow_create: bool = True) -> dict:
    """Save (insert or update) a form config. Validates source + field_map."""
    form_id = int(payload["form_id"])
    src = payload.get("source")
    if src not in KNOWN_SOURCES:
        raise ValueError(f"Unknown source '{src}'. Allowed: {KNOWN_SOURCES}")
    field_map_in = payload.get("field_map") or {}
    field_map: dict[str, str | None] = {}
    for k in STANDARD_FIELDS:
        v = field_map_in.get(k)
        field_map[k] = (str(v).strip() if v not in (None, "") else None)
    if not field_map.get("email"):
        raise ValueError("field_map.email is required — we can't dedupe without it.")
    if not (field_map.get("first_name") or field_map.get("full_name")):
        raise ValueError("Either field_map.first_name OR field_map.full_name must be set.")

    doc: dict = {
        "form_id": form_id,
        "form_title": (payload.get("form_title") or "").strip() or None,
        "source": src,
        "in_pipeline": bool(payload.get("in_pipeline")) if payload.get("in_pipeline") is not None
                       else (src in PIPELINE_SOURCES),
        "field_map": field_map,
        "reason_routing": payload.get("reason_routing") or None,
        "reason_field": payload.get("reason_field") or None,
        "extras": payload.get("extras") or None,
        "updated_at": _now(),
    }
    existing = await db[COLLECTION].find_one({"form_id": form_id}, {"_id": 0})
    if existing is None:
        if not allow_create:
            raise ValueError(f"Form {form_id} not configured.")
        doc["created_at"] = _now()
        await db[COLLECTION].insert_one(doc)
        logger.info("gf_form_configs inserted form_id=%s", form_id)
    else:
        await db[COLLECTION].update_one({"form_id": form_id}, {"$set": doc})
        logger.info("gf_form_configs updated form_id=%s", form_id)
    return await get_config(db, form_id)  # canonical re-read


async def delete_config(db, form_id: int) -> bool:
    res = await db[COLLECTION].delete_one({"form_id": int(form_id)})
    if res.deleted_count:
        logger.warning("gf_form_configs deleted form_id=%s", form_id)
    return bool(res.deleted_count)


# ---------------------------------------------------------------------------
# Field extraction — the single function the backfill uses to turn a raw
# GF entry into normalized CRM fields. Replaces the per-form ``if form_id ==
# 17/32/33`` ladder in gf_backfill.run_backfill.
# ---------------------------------------------------------------------------
def extract_from_entry(entry: dict, cfg: dict) -> dict:
    """Apply ``cfg.field_map`` to a raw GF entry. Returns a dict of
    normalized CRM fields, plus a resolved ``source`` / ``in_pipeline``
    pair that accounts for Form-1-style reason routing.

    Output keys: first_name, last_name, email, phone, postcode, message,
    source, in_pipeline, raw_full_name."""
    fm = cfg.get("field_map") or {}

    def _pick(key: str) -> str | None:
        gf_id = fm.get(key)
        if not gf_id:
            return None
        val = entry.get(gf_id)
        if val in (None, ""):
            return None
        return str(val).strip() or None

    # Full name handling: if cfg uses a combined "Name" field, split it.
    raw_full = _pick("full_name")
    first = _pick("first_name")
    last = _pick("last_name")
    if raw_full and not first:
        parts = raw_full.split(None, 1)
        first = parts[0]
        last = parts[1] if len(parts) > 1 else last
    # Defensive: if first_name accidentally contains a full name (single
    # field webhook with no separate last_name mapping), split it too.
    if first and not last and " " in first.strip():
        parts = first.strip().split(None, 1)
        first = parts[0]
        last = parts[1] if len(parts) > 1 else None

    email = (_pick("email") or "").lower() or None
    phone = _pick("phone")
    postcode = _pick("postcode")
    message = _pick("message")

    # Source: reason_routing wins if configured (Form 1 style).
    source = cfg.get("source") or "general_enquiry"
    routing = cfg.get("reason_routing") or {}
    reason_field = cfg.get("reason_field")
    if routing and reason_field:
        reason_val = (entry.get(reason_field) or "").strip().lower()
        if reason_val and reason_val in routing:
            source = routing[reason_val]
    in_pipeline = source in PIPELINE_SOURCES

    return {
        "first_name": first,
        "last_name": last,
        "email": email,
        "phone": phone,
        "postcode": postcode,
        "message": message,
        "source": source,
        "in_pipeline": in_pipeline,
        "raw_full_name": raw_full,
    }


def backfill_form_ids(configs: Iterable[dict]) -> list[int]:
    """All form IDs the periodic backfill should pull. Includes ALL
    configured forms — pipeline-eligible or not — so non-pipeline forms
    (care-home, art-kit) still get their leads ingested into the CRM as
    contacts, just not promoted into the kanban."""
    return sorted({int(c["form_id"]) for c in configs if c.get("form_id") is not None})


def auto_guess_field_map(sample_entry: dict, gf_form_meta: dict | None = None) -> dict:
    """Best-effort guess of which GF field ID maps to which CRM field,
    used to prefill the UI when admin clicks 'Auto-detect fields'.

    Strategy: look at the GF form metadata (if available) for fields
    whose label contains 'email', 'phone', 'postcode', 'name', etc.
    Fall back to inspecting the sample entry's values (regex on email
    addresses, UK postcodes) when no metadata is given."""
    guesses: dict[str, str | None] = {k: None for k in STANDARD_FIELDS}

    if gf_form_meta and isinstance(gf_form_meta.get("fields"), list):
        for f in gf_form_meta["fields"]:
            label = (f.get("label") or "").strip().lower()
            fid = str(f.get("id") or "")
            inputs = f.get("inputs") or []
            if not fid:
                continue
            # Composite name fields expose sub-inputs (.3 first, .6 last)
            if f.get("type") == "name" and inputs:
                for sub in inputs:
                    sid = str(sub.get("id") or "")
                    slabel = (sub.get("label") or "").lower()
                    if "first" in slabel:
                        guesses["first_name"] = sid
                    elif "last" in slabel:
                        guesses["last_name"] = sid
                # If no sub-inputs got picked, use the parent as full_name
                if not guesses["first_name"]:
                    guesses["full_name"] = fid
                continue
            if f.get("type") == "address" and inputs:
                # Find sub-input for postcode / zip
                for sub in inputs:
                    sid = str(sub.get("id") or "")
                    slabel = (sub.get("label") or "").lower()
                    if "zip" in slabel or "postal" in slabel or "postcode" in slabel:
                        guesses["postcode"] = sid
                continue
            if f.get("type") == "email" or "email" in label:
                guesses["email"] = fid
            elif f.get("type") == "phone" or "phone" in label or "telephone" in label or "mobile" in label:
                guesses["phone"] = fid
            elif "postcode" in label or "postal" in label or "zip" in label:
                guesses["postcode"] = fid
            elif "message" in label or "comments" in label or "notes" in label or "enquiry" in label:
                guesses["message"] = fid
            elif label in ("name", "your name", "full name") and not guesses.get("full_name"):
                guesses["full_name"] = fid

    # Sample-value fallback for whatever we couldn't infer from metadata
    if sample_entry and not guesses["email"]:
        for k, v in sample_entry.items():
            if isinstance(v, str) and "@" in v and "." in v:
                guesses["email"] = str(k)
                break
    return guesses
