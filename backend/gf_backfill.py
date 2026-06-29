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
    # Form 33 — short Franchise Enquiry popup (June 2026). The live form
    # uses GF's dotted "composite" field layout, NOT flat numeric IDs:
    #   5.3 — Name (single full-name field, e.g. "Lisa" or "Donna O'Neill")
    #   4   — Email
    #   6   — Phone
    #   7.5 — Postcode (sub-field of an Address block)
    #   9.1 — Anti-spam honeypot acknowledgment (ignored)
    33: {
        "5.3": "Name",
        "4":   "Email",
        "6":   "Phone Number",
        "7.5": "Postcode",
        "9.1": "Anti-Spam Confirmation",
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

async def _fetch_form_meta(form_id: int) -> dict | None:
    """Fetch a GF form's metadata (title + field definitions). Used by
    the discover endpoint to auto-guess field IDs. Returns None on
    failure so the caller degrades gracefully to sample-based detection."""
    base = (os.environ.get("WP_SITE_URL") or "").rstrip("/")
    key = os.environ.get("GF_CONSUMER_KEY") or ""
    secret = os.environ.get("GF_CONSUMER_SECRET") or ""
    if not (base and key and secret):
        return None
    url = f"{base}/wp-json/gf/v2/forms/{int(form_id)}"
    try:
        async with httpx.AsyncClient(timeout=15.0) as http:
            r = await http.get(url, auth=(key, secret))
            if r.status_code != 200:
                return None
            return r.json()
    except Exception:  # noqa: BLE001
        return None




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
    # Form IDs always include the static FORM_IDS_IN_PIPELINE set
    # (currently 17, 32, 33). The GF_BACKFILL_FORM_IDS env var can ADD
    # extra forms (e.g. 1 for general-contact triage) but can no longer
    # *subtract* — historically a stale Production env value silently
    # excluded form 33, causing the Form-33 leads outage. Union >
    # override.
    from form_intake_config import backfill_form_ids
    from gf_form_config_db import (
        list_configs as _list_db_configs,
        backfill_form_ids as _db_backfill_form_ids,
    )

    # Pull DB-managed form configs once; they become the source of
    # truth for field mappings + source assignment. The static
    # form_intake_config module is kept as a safety net so a missing
    # row doesn't kill ingestion of a known form.
    db_configs = await _list_db_configs(db)
    db_configs_by_id: dict[int, dict] = {int(c["form_id"]): c for c in db_configs}

    form_ids: set[int] = set(backfill_form_ids())
    form_ids.update(_db_backfill_form_ids(db_configs))
    env_override = (os.environ.get("GF_BACKFILL_FORM_IDS") or "").strip()
    if env_override:
        form_ids.update(
            int(x) for x in env_override.split(",") if x.strip().isdigit()
        )
    form_ids_list = sorted(form_ids)
    if not form_ids_list:
        raise RuntimeError("No Gravity Forms configured for backfill")

    inserted = 0
    updated = 0
    checked = 0
    errors: list[str] = []
    traces: list[dict] = []  # per-entry outcome — invaluable when a refresh
                             # silently does nothing on Production.

    for form_id in form_ids_list:
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
            {"_id": 0, "gravity_entry_id": 1, "first_name": 1, "last_name": 1,
             "ingested_via": 1, "in_pipeline": 1, "pipeline_status": 1,
             "id": 1, "email": 1, "source": 1},
        ).to_list(len(ids))
        have_by_id = {e["gravity_entry_id"]: e for e in existing_rows}

        # ALSO build an email lookup of EVERY existing row already in the
        # DB. If a person submitted any prior form (Form 17, Form 1
        # care-home enquiry, etc.) and comes back via Form 33, the unique
        # email index would silently 11000 a fresh insert — we instead
        # PROMOTE the existing row into NEW. Critically we do NOT filter
        # by ``source`` here: Paul Dunkserly's original row was a
        # care_home_enquiry, which isn't in PIPELINE_SOURCES, so a
        # source-scoped lookup missed him on prod.
        candidate_emails = [
            (e.get("4") or "").strip().lower()
            for e in entries if (e.get("4") or "").strip()
        ]
        existing_by_email: dict[str, dict] = {}
        if candidate_emails:
            email_rows = await db.web_form_contacts.find(
                {"email": {"$in": candidate_emails}},
                {"_id": 0, "id": 1, "email": 1, "gravity_entry_id": 1,
                 "first_name": 1, "last_name": 1, "ingested_via": 1,
                 "in_pipeline": 1, "pipeline_status": 1, "source": 1,
                 "received_at": 1, "date": 1, "auto_archived_at": 1},
            ).to_list(len(candidate_emails) * 5)  # one person can have multiple rows
            # When there are multiple rows for the same email, prefer the
            # one that's the best PROMOTION candidate: not currently active
            # in the pipeline (so we don't blat an admin's in-flight work),
            # ordered Dormant > Lost > archived > anything-else.
            def _promote_score(r: dict) -> tuple[int, int]:
                stage = (r.get("pipeline_status") or "").lower()
                if not r.get("in_pipeline"):
                    return (0, 0)            # best — out of pipeline
                if stage in ("dormant",):
                    return (1, 0)            # dormant is fine to promote
                if stage in ("lost",):
                    return (2, 0)            # lost is OK too
                return (10, 0)               # active stage — last resort
            for r in sorted(email_rows, key=_promote_score):
                em = (r.get("email") or "").lower()
                if em and em not in existing_by_email:
                    existing_by_email[em] = r

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
            country = None
            postcode = None
            source = None
            in_pipeline_flag = False

            # DB-managed extraction — preferred path. If the form has a
            # row in gf_form_configs, that owns the field layout +
            # source routing. The static if-ladder below remains ONLY
            # as a safety net for forms whose DB row is missing or
            # malformed (e.g. mid-deploy migration window).
            db_cfg = db_configs_by_id.get(int(form_id))
            if db_cfg:
                from gf_form_config_db import extract_from_entry as _extract_db
                extracted = _extract_db(entry, db_cfg)
                first = extracted.get("first_name") or first
                last  = extracted.get("last_name") or last
                email = extracted.get("email") or email
                phone = extracted.get("phone") or phone
                postcode = extracted.get("postcode") or None
                if extracted.get("message"):
                    comments = extracted["message"]
                source = extracted.get("source") or source
                in_pipeline_flag = bool(extracted.get("in_pipeline"))
                # Form-32-style "country" extra still preserved via extras
                extras = db_cfg.get("extras") or {}
                country_fid = extras.get("country_field") if isinstance(extras, dict) else None
                if country_fid:
                    country = (entry.get(country_fid) or "").strip() or None
                # Form title from config if set
                if db_cfg.get("form_title"):
                    form_title = db_cfg["form_title"]
            else:
                # ---- Static fallback (legacy, kept for safety) ----
                if form_id == 32:
                    postcode = (entry.get("28") or "").strip() or None
                    country  = (entry.get("16") or "").strip() or None
                    source = "licence_enquiry"
                    in_pipeline_flag = True
                elif form_id == 33:
                    raw_name = (entry.get("5.3") or entry.get("5") or "").strip()
                    if raw_name:
                        parts = raw_name.split(None, 1)
                        first = parts[0]
                        last = parts[1] if len(parts) > 1 else None
                    email = (entry.get("4") or "").strip().lower() or email
                    phone = (entry.get("6") or "").strip() or phone
                    postcode = (entry.get("7.5") or entry.get("7") or "").strip() or None
                    source = "franchise_enquiry"
                    in_pipeline_flag = True
                elif form_id == 1:
                    postcode = (entry.get("16") or "").strip() or None
                    reason   = (entry.get("20") or "").strip()
                    source   = FORM1_REASON_TO_SOURCE.get(reason.lower(), "general_enquiry")
                    in_pipeline_flag = source in PIPELINE_SOURCES
                else:
                    postcode = (entry.get("16") or "").strip() or None
                    source = "franchise_enquiry"
                    in_pipeline_flag = True
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
            # Email-based fallback: same person might have submitted a
            # different form previously, leaving a row with a different
            # gravity_entry_id. We promote that row back to NEW rather
            # than inserting a duplicate that'd silently 11000 on the
            # unique-email index.
            existing_by_em = existing_by_email.get((email or "").lower()) if email else None
            if existing is None and existing_by_em is not None:
                # Treat as "needs promotion" rather than insert.
                existing = existing_by_em
                # Mark which path so the repair branch below logs cleanly.
                existing["_matched_by"] = "email"

            if existing is None:
                # Brand-new entry — insert. If a unique index trips us
                # up despite the email-lookup miss above, fall back to
                # a post-hoc email promotion so the lead still surfaces.
                doc_core["id"] = _uuid()
                doc_core["created_at"] = now
                wp_status = entry.get("_wp_status")
                if wp_status and wp_status != "active":
                    doc_core["gf_wp_status"] = wp_status
                    doc_core["gf_spam_rescued"] = True
                try:
                    await db.web_form_contacts.insert_one(doc_core)
                    inserted += 1
                    traces.append({"entry_id": eid, "outcome": "inserted",
                                   "email": email, "name": full_name,
                                   "form_id": form_id})
                    if wp_status and wp_status != "active":
                        logger.warning(
                            "GF backfill rescued entry %s from GF status=%s (%s / %s)",
                            eid, wp_status, full_name, email,
                        )
                    else:
                        logger.info("GF backfill inserted entry %s (%s)", eid, full_name)
                except Exception as exc:  # noqa: BLE001
                    # Insert collided — most often the unique-email
                    # index. Recover by finding the existing row and
                    # promoting it (same effect as the email fallback
                    # would have had if we'd seen it up-front).
                    err_str = str(exc)
                    logger.warning("GF backfill insert collided entry %s: %s", eid, err_str)
                    recovered = None
                    if email:
                        recovered = await db.web_form_contacts.find_one(
                            {"email": email},
                            {"_id": 0, "id": 1, "first_name": 1, "last_name": 1,
                             "in_pipeline": 1, "pipeline_status": 1, "source": 1,
                             "ingested_via": 1, "gravity_entry_id": 1},
                        )
                    if recovered:
                        recovered["_matched_by"] = "email_post_insert_collision"
                        existing = recovered  # fall through to promotion branch
                    else:
                        errors.append(f"entry {eid}: {err_str}")
                        traces.append({"entry_id": eid, "outcome": "insert_failed",
                                       "email": email, "name": full_name,
                                       "form_id": form_id, "error": err_str})
                        continue
                else:
                    continue  # successful insert — done with this entry

            # Existing — decide what to do:
            #  (a) name-less stub from the broken Form-33 mapping → repair
            #      first/last names + always force in_pipeline=true, NEW.
            #  (b) matched by email (different gravity_entry_id) AND not
            #      currently in pipeline → promote back into NEW because
            #      the same person re-engaged via Form 33.
            #  (c) matched by email, IN pipeline but NOT in "new" → also
            #      promote to NEW (re-engagement bumps them back up).
            #  (d) otherwise leave alone (admin already worked them).
            is_stub = (
                repair_stubs
                and (existing.get("ingested_via") == "gf_backfill")
                and not (existing.get("first_name") or existing.get("last_name"))
            )
            matched_email = existing.get("_matched_by", "").startswith("email")
            # CRITICAL guard: promotion of an existing row to NEW must ONLY
            # fire when the INBOUND entry itself is a pipeline-eligible
            # enquiry (franchise/licence). Without this, a returning lead
            # filing an art-kit or care-home enquiry via the general
            # contact form would silently get yanked into NEW — which is
            # how Sanora's 11-month-old art_kit row ended up at the top of
            # the kanban.
            re_engaged_by_email = (
                matched_email
                and in_pipeline_flag
                and (
                    not existing.get("in_pipeline")
                    or (existing.get("pipeline_status") or "") in ("dormant", "lost", "")
                )
            )
            if not (is_stub or re_engaged_by_email):
                # Active contact — DON'T re-stage them, but DO merge any
                # newly-populated fields from this fresh submission so we
                # never silently lose richer data when the same person
                # fills more than one form (e.g. Form 33 quick-signup
                # arrives first, then Form 17 with the full address).
                # Per-user requirement: every merge MUST be audited so
                # they can spot what was combined.
                merge_outcome = await _merge_into_active_contact(
                    db, existing, doc_core, eid, form_id, form_title, now,
                )
                merge_outcome.update({
                    "entry_id": eid, "email": email, "name": full_name,
                    "form_id": form_id,
                    "existing_stage": existing.get("pipeline_status"),
                    "existing_id": existing.get("id"),
                })
                traces.append(merge_outcome)
                if merge_outcome.get("outcome") == "merged_into_existing":
                    updated += 1
                continue

            update_set = dict(doc_core)
            update_set.pop("ingested_via", None)  # keep original provenance
            # Always force these — this is the whole point of the repair.
            update_set["in_pipeline"] = True
            update_set["pipeline_status"] = "new"
            update_set["pipeline_updated_at"] = now.isoformat()
            # Don't blat populated names with form-33's first-only "Lisa"
            # if the legacy row already has "Lisa Henshall". Only overwrite
            # name parts that are currently empty.
            if existing.get("first_name") and update_set.get("first_name"):
                if (existing["first_name"] or "").strip().lower() == (update_set["first_name"] or "").strip().lower():
                    pass  # safe to keep update
                else:
                    update_set["first_name"] = existing["first_name"]
            if existing.get("last_name") and not update_set.get("last_name"):
                update_set["last_name"] = existing["last_name"]
            # Match by id when matched-by-email (different gravity_entry_id);
            # otherwise by gravity_entry_id (the normal stub repair path).
            match_query = ({"id": existing["id"]} if matched_email
                           else {"gravity_entry_id": eid})
            try:
                await db.web_form_contacts.update_one(match_query, {"$set": update_set})
                updated += 1
                outcome = "promoted" if matched_email else "repaired_stub"
                traces.append({"entry_id": eid, "outcome": outcome,
                               "email": email, "name": full_name,
                               "form_id": form_id,
                               "matched_existing_id": existing.get("id"),
                               "previous_stage": existing.get("pipeline_status")})
                if matched_email:
                    logger.info(
                        "GF backfill PROMOTED re-engaged contact via email %s (entry %s, %s)",
                        email, eid, full_name,
                    )
                else:
                    logger.info("GF backfill repaired stub entry %s (%s)", eid, full_name)
            except Exception as exc:  # noqa: BLE001
                errors.append(f"repair entry {eid}: {exc}")
                traces.append({"entry_id": eid, "outcome": "promote_failed",
                               "email": email, "name": full_name,
                               "form_id": form_id, "error": str(exc)})

    _backfill_state.update({
        "last_run_at": datetime.now(timezone.utc),
        "last_inserted": inserted,
        "last_updated": updated,
        "last_checked": checked,
        "last_error": "; ".join(errors)[:500] if errors else None,
    })
    return {"inserted": inserted, "updated": updated, "checked": checked,
            "errors": errors, "traces": traces, "form_ids_used": form_ids_list}


def _uuid() -> str:
    import uuid
    return str(uuid.uuid4())


# Fields we'll auto-merge from a duplicate submission into an active
# contact. Anything not in this list is NEVER copied (we don't want
# overwriting things like ``id``, ``pipeline_status``, audit timestamps).
# Special cases (raw_fields dict merge, merged_from_history append) are
# handled explicitly in _merge_into_active_contact.
_MERGEABLE_FIELDS: tuple[str, ...] = (
    "first_name", "last_name", "telephone",
    "address_line_1", "address_line_2", "town_city", "county",
    "postcode", "country", "establishment_name",
    "comments", "heard_about_us", "facebook", "google",
    "reason_for_contacting",
)


def _is_empty(val) -> bool:
    """Truthy-empty: missing, None, empty string, or just whitespace."""
    if val is None:
        return True
    if isinstance(val, str) and not val.strip():
        return True
    return False


async def _merge_into_active_contact(
    db, existing: dict, doc_core: dict, eid: str,
    form_id: int, form_title: str, now: datetime,
) -> dict:
    """Auto-merge a duplicate Gravity submission into an existing active
    contact. Only fields that are EMPTY on the existing record get
    populated — admin-edited values are never overwritten. Always logs
    a ``merged_from_history`` entry so the admin can see what merged.

    Returns a trace dict with outcome ``merged_into_existing`` (if any
    new fields were copied) or ``skip_already_active`` (if the inbound
    entry added nothing new — still logs the history entry so the
    admin sees the submission was seen-and-considered, just not used).
    """
    survivor_id = existing.get("id")
    # Need the full doc to know which fields are empty vs populated.
    full = await db.web_form_contacts.find_one(
        {"id": survivor_id},
        {"_id": 0, **{f: 1 for f in _MERGEABLE_FIELDS},
         "raw_fields": 1, "merged_from_history": 1, "gravity_entry_id": 1},
    ) or {}

    # Guard: re-processing the contact's own original submission isn't
    # a "merge" at all — it's the same row being scanned by a later
    # refresh. Silently noop so the history stays clean.
    if (full.get("gravity_entry_id") or "") == str(eid):
        return {"outcome": "skip_self"}

    merge_set: dict = {}
    filled_keys: list[str] = []
    for field in _MERGEABLE_FIELDS:
        new_val = doc_core.get(field)
        if _is_empty(new_val):
            continue
        if _is_empty(full.get(field)):
            merge_set[field] = new_val
            filled_keys.append(field)

    # raw_fields: union the two dicts, existing keys win (preserve any
    # admin edits / earlier-form data).
    new_raw = doc_core.get("raw_fields") or {}
    existing_raw = full.get("raw_fields") or {}
    if isinstance(new_raw, dict) and new_raw:
        merged_raw = {**new_raw, **existing_raw}  # existing wins
        if merged_raw != existing_raw:
            merge_set["raw_fields"] = merged_raw

    # Always append a history entry — even when no fields were
    # absorbed, the admin should be able to see we received a second
    # submission and intentionally didn't overwrite anything.
    history_entry = {
        "loser_gravity_entry_id": eid,
        "loser_form_id": str(form_id),
        "loser_form_title": form_title,
        "merged_at": now.isoformat() if hasattr(now, "isoformat") else str(now),
        "merged_by": "gf_backfill_auto",
        "fields_added": filled_keys,
    }
    history = list(full.get("merged_from_history") or [])
    # De-dupe: if we've already logged this exact gravity entry merging
    # into this contact, don't add it again on the next refresh.
    already = any(
        (h.get("loser_gravity_entry_id") == eid) for h in history
    )
    if already:
        # Already processed — silent skip, no further action.
        return {"outcome": "skip_already_merged"}
    history.append(history_entry)
    merge_set["merged_from_history"] = history
    merge_set["updated_at"] = now

    await db.web_form_contacts.update_one(
        {"id": survivor_id}, {"$set": merge_set}
    )
    logger.info(
        "GF backfill MERGED entry %s (form %s) into active contact %s; "
        "added fields=%s",
        eid, form_id, survivor_id, filled_keys or "none (history-only)",
    )
    return {
        "outcome": "merged_into_existing" if filled_keys else "merge_history_only",
        "fields_added": filled_keys,
    }


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

    Date fields can be stored as ISO strings OR datetime objects on
    different code paths — we test both shapes against both forms of
    the cutoff so the filter never silently misses rows.
    """
    pipeline_sources_list = list(PIPELINE_SOURCES)
    cutoff_dt = datetime.now(timezone.utc) - timedelta(days=cutoff_days)
    cutoff_iso = cutoff_dt.isoformat()

    # Match franchise/licence rows currently sitting in NEW that are
    # genuinely OLD. Any of the timestamp fields can give us age, so
    # match if ANY says "older than cutoff" — covers webhook intake
    # (received_at), backfill (received_at), and legacy migrations
    # (date/created_at).
    date_or: list[dict] = []
    for field in ("received_at", "created_at", "date"):
        # Datetime form
        date_or.append({field: {"$lt": cutoff_dt, "$ne": None}})
        # ISO-string form
        date_or.append({field: {"$lt": cutoff_iso, "$ne": None, "$type": "string"}})

    base_filter: dict = {
        "source": {"$in": pipeline_sources_list},
        "in_pipeline": True,
        "pipeline_status": "new",
        "$or": date_or,
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
    # Diagnostic count — how many rows are currently in NEW for each
    # source. Helps the admin sanity-check what just happened.
    web_remaining_new = await db.web_form_contacts.count_documents({
        "source": {"$in": pipeline_sources_list},
        "in_pipeline": True, "pipeline_status": "new",
    })
    logger.warning(
        "undo_bad_repair: archived %s web + %s legacy rows older than %s days "
        "(%s rows still in NEW)",
        web.modified_count, legacy.modified_count, cutoff_days, web_remaining_new,
    )
    return {
        "web_archived": web.modified_count,
        "legacy_archived": legacy.modified_count,
        "web_still_in_new": web_remaining_new,
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

    @router.get("/intake/backfill/diagnose/{form_id}")
    async def diagnose_form(
        form_id: int,
        limit: int = 20,
        _user: dict = Depends(require_role("admin")),
    ):
        """Read-only diagnostic. Hits the Gravity Forms REST API directly
        for ``form_id`` and reports — for each entry returned by WP —
        whether our intake would insert it, skip it (already exists,
        tombstoned, spam), and what the parsed name/email would be.

        Use this when a form's submissions aren't appearing in the CRM
        to figure out where the pipeline is breaking.
        """
        limit = max(1, min(100, int(limit)))
        try:
            entries = await _fetch_recent_entries(form_id, limit=limit)
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "form_id": form_id, "error": str(exc),
                    "hint": "Check WP_SITE_URL / GF_CONSUMER_KEY / GF_CONSUMER_SECRET in backend/.env"}

        if not entries:
            return {
                "ok": True, "form_id": form_id, "wp_entries": 0,
                "diagnosis": "Gravity Forms REST API returned ZERO entries for this form. "
                             "Either the form has no submissions yet, the form_id is wrong, "
                             "or the GF REST credentials don't have read access to this form.",
                "entries": [],
            }

        ids = [str(e["id"]) for e in entries]
        existing = await db.web_form_contacts.find(
            {"gravity_entry_id": {"$in": ids}},
            {"_id": 0, "gravity_entry_id": 1, "first_name": 1, "last_name": 1,
             "email": 1, "in_pipeline": 1, "pipeline_status": 1, "source": 1,
             "ingested_via": 1},
        ).to_list(len(ids))
        have_by_id = {e["gravity_entry_id"]: e for e in existing}
        # Email-based fallback lookup — the same person might have submitted
        # an earlier form (e.g. Form 17 / Form 1) and exist under a different
        # gravity_entry_id. Surface that so we can see exactly why an insert
        # would be skipped or collide on a unique-email index.
        candidate_emails = [
            (e.get("4") or "").strip().lower() for e in entries
            if (e.get("4") or "").strip()
        ]
        existing_by_email: dict[str, dict] = {}
        if candidate_emails:
            email_rows = await db.web_form_contacts.find(
                {"email": {"$in": candidate_emails}},
                {"_id": 0, "id": 1, "email": 1, "gravity_entry_id": 1,
                 "first_name": 1, "last_name": 1, "form_id": 1,
                 "source": 1, "in_pipeline": 1, "pipeline_status": 1,
                 "ingested_via": 1, "received_at": 1, "date": 1,
                 "auto_archived_at": 1, "auto_archived_reason": 1},
            ).to_list(len(candidate_emails) * 5)
            # Use the same "best promotion candidate" sort that
            # run_backfill uses so the diagnose verdict matches reality.
            def _ps(r: dict) -> tuple[int, int]:
                stage = (r.get("pipeline_status") or "").lower()
                if not r.get("in_pipeline"):
                    return (0, 0)
                if stage == "dormant":
                    return (1, 0)
                if stage == "lost":
                    return (2, 0)
                return (10, 0)
            for r in sorted(email_rows, key=_ps):
                em = (r.get("email") or "").lower()
                if em and em not in existing_by_email:
                    existing_by_email[em] = r
        tomb_rows = await db.gf_deleted_entries.find(
            {"gravity_entry_id": {"$in": ids}},
            {"_id": 0, "gravity_entry_id": 1},
        ).to_list(len(ids))
        tombstoned = {t["gravity_entry_id"] for t in tomb_rows}

        out_rows: list[dict] = []
        for entry in entries:
            eid = str(entry["id"])
            # Mirror the field extraction used by run_backfill
            if form_id == 33:
                raw_name = (entry.get("5.3") or "").strip()
                if raw_name:
                    parts = raw_name.split(None, 1)
                    first = parts[0]
                    last = parts[1] if len(parts) > 1 else None
                else:
                    first = last = None
                email = (entry.get("4") or "").strip().lower() or None
            else:
                first = (entry.get("9")  or "").strip() or None
                last  = (entry.get("12") or "").strip() or None
                email = (entry.get("4")  or "").strip().lower() or None
            full_name = f"{first or ''} {last or ''}".strip()
            is_spam = _looks_like_spam(full_name, email or "")
            existing_row = have_by_id.get(eid)
            email_match = existing_by_email.get((email or "").lower()) if email else None
            verdict: str
            if eid in tombstoned:
                verdict = "skip_tombstoned"
            elif existing_row:
                verdict = "already_in_db"
            elif email_match:
                # Dormant / lost / out-of-pipeline → we promote on backfill.
                # Anything else means an admin is actively working it.
                em_stage = (email_match.get("pipeline_status") or "").lower()
                em_active = email_match.get("in_pipeline") and em_stage not in ("dormant", "lost", "")
                verdict = "duplicate_email_already_in_pipeline" if em_active \
                         else "duplicate_email_would_promote"
            elif is_spam:
                verdict = "skip_spam_filter"
            else:
                verdict = "would_insert"
            # Snapshot every populated numeric/dotted field so we can see
            # exactly where the real values live (e.g. 9.3 = First Name on
            # a "Normal" GF Name field, vs 5 = First Name on a "Simple" one).
            raw_fields = {
                k: str(v) for k, v in entry.items()
                if re.match(r"^\d+(\.\d+)?$", str(k)) and v not in (None, "", [])
            }
            out_rows.append({
                "entry_id": eid,
                "wp_status": entry.get("_wp_status"),
                "date_created": entry.get("date_created"),
                "first_name": first, "last_name": last, "email": email,
                "verdict": verdict,
                "existing_in_db": existing_row,
                "email_match_existing": email_match,
                "raw_fields": raw_fields,
            })

        summary = {
            "would_insert": sum(1 for r in out_rows if r["verdict"] == "would_insert"),
            "already_in_db": sum(1 for r in out_rows if r["verdict"] == "already_in_db"),
            "duplicate_email_would_promote":
                sum(1 for r in out_rows if r["verdict"] == "duplicate_email_would_promote"),
            "duplicate_email_already_in_pipeline":
                sum(1 for r in out_rows if r["verdict"] == "duplicate_email_already_in_pipeline"),
            "skip_spam_filter": sum(1 for r in out_rows if r["verdict"] == "skip_spam_filter"),
            "skip_tombstoned": sum(1 for r in out_rows if r["verdict"] == "skip_tombstoned"),
        }
        return {"ok": True, "form_id": form_id, "wp_entries": len(entries),
                "summary": summary, "entries": out_rows}

    @router.post("/intake/backfill/undo-bad-art-kit-promotion")
    async def undo_bad_art_kit_promotion(
        user: dict = Depends(require_role("admin")),
    ):
        """One-shot cleanup for the v24.2 over-promotion bug: any row
        currently in pipeline_status='new' whose ``source`` is anything
        other than franchise_enquiry / licence_enquiry should NEVER have
        been promoted to NEW. Pushes them back out of the pipeline
        (in_pipeline=False, pipeline_status=null). Idempotent.
        """
        from form_intake_config import PIPELINE_SOURCES
        moved = 0
        for coll_name in ("web_form_contacts", "contacts"):
            coll = db[coll_name]
            res = await coll.update_many(
                {"in_pipeline": True, "pipeline_status": "new",
                 "source": {"$nin": list(PIPELINE_SOURCES)}},
                {"$set": {
                    "in_pipeline": False,
                    "pipeline_status": None,
                    "pipeline_updated_at": datetime.now(timezone.utc).isoformat(),
                    "auto_archived_reason": "undo_bad_art_kit_promotion",
                }},
            )
            moved += res.modified_count
        logger.warning(
            "undo_bad_art_kit_promotion: removed %s non-pipeline rows from NEW (by %s)",
            moved, user.get("email"),
        )
        return {"ok": True, "moved_out_of_new": moved, "by": user.get("email")}

    @router.post("/intake/backfill/contacted-to-dormant")
    async def contacted_to_dormant(
        cutoff_days: int = 60,
        user: dict = Depends(require_role("admin")),
    ):
        """Auto-move "Contacted" pipeline rows older than ``cutoff_days``
        days into the "Dormant" stage. Reversible: only changes
        ``pipeline_status`` from ``"contacted"`` → ``"dormant"`` for rows
        whose newest activity date is older than the cutoff. Idempotent.

        Date detection is permissive — the row is "old" if EVERY
        timestamp we know about (received_at, pipeline_updated_at,
        last_touched_at, updated_at, created_at, date) is older than
        the cutoff. A single recent timestamp keeps the row in
        Contacted.
        """
        cutoff_dt = datetime.now(timezone.utc) - timedelta(days=cutoff_days)
        cutoff_iso = cutoff_dt.isoformat()
        cutoff_date_str = cutoff_dt.strftime("%Y-%m-%d")

        # Activity fields = was a HUMAN action recorded on this row?
        # If yes, keep it in Contacted (someone's still working it).
        activity_fields = ("pipeline_updated_at", "last_touched_at", "last_human_touch_at")
        # Arrival fields = when did the lead originally come in?
        # Used as the fallback when no human-activity field exists.
        # NOTE: ``created_at`` and ``updated_at`` are EXCLUDED on purpose —
        # those reflect DB-write events (migrations, schema patches, etc),
        # not user activity, so they'd pin every legacy row as "fresh".
        arrival_fields = ("received_at", "date")

        def _to_iso(v) -> str | None:
            if not v:
                return None
            if isinstance(v, datetime):
                if v.tzinfo is None:
                    v = v.replace(tzinfo=timezone.utc)
                return v.isoformat()
            return str(v)

        def _row_is_old(doc: dict) -> bool:
            # 1) If a human touched it after the cutoff → not old.
            for fld in activity_fields:
                iso = _to_iso(doc.get(fld))
                if iso and iso >= cutoff_iso[: len(iso)]:
                    return False
            # 2) Otherwise check arrival date — old enough → move it.
            #    If no arrival date at all, treat as old (safer for stale stubs).
            for fld in arrival_fields:
                iso = _to_iso(doc.get(fld))
                if not iso:
                    continue
                # Date-only strings (e.g. "2025-10-15") compare cleanly
                # against cutoff_date_str ("2025-04-20") via lexicographic.
                if len(iso) <= 10:
                    return iso < cutoff_date_str
                return iso < cutoff_iso
            return True

        moved_web = 0
        moved_legacy = 0
        for coll_name, counter in (("web_form_contacts", "web"), ("contacts", "legacy")):
            coll = db[coll_name]
            cursor = coll.find(
                {"in_pipeline": True, "pipeline_status": "contacted"},
                {"_id": 0, "id": 1,
                 **{f: 1 for f in activity_fields + arrival_fields}},
            )
            stale_ids: list[str] = []
            async for doc in cursor:
                if _row_is_old(doc) and doc.get("id"):
                    stale_ids.append(doc["id"])
            if stale_ids:
                res = await coll.update_many(
                    {"id": {"$in": stale_ids},
                     "in_pipeline": True, "pipeline_status": "contacted"},
                    {"$set": {
                        "pipeline_status": "dormant",
                        "pipeline_updated_at": datetime.now(timezone.utc).isoformat(),
                        "auto_dormant_reason": f"contacted_to_dormant_{cutoff_days}d",
                    }},
                )
                if counter == "web":
                    moved_web = res.modified_count
                else:
                    moved_legacy = res.modified_count
        logger.warning(
            "contacted_to_dormant: moved %s web + %s legacy rows older than %s days",
            moved_web, moved_legacy, cutoff_days,
        )
        return {
            "ok": True, "cutoff_days": cutoff_days,
            "web_moved": moved_web, "legacy_moved": moved_legacy,
            "by": user.get("email"),
        }

    # =====================================================================
    # Form-config CRUD — the "Manage Gravity Forms" admin UI lives here.
    # =====================================================================
    from gf_form_config_db import (
        list_configs as _cfg_list,
        get_config as _cfg_get,
        upsert_config as _cfg_upsert,
        delete_config as _cfg_delete,
        auto_guess_field_map as _cfg_guess,
        extract_from_entry as _cfg_extract,
        KNOWN_SOURCES as _CFG_SOURCES,
        PIPELINE_SOURCES as _CFG_PIPELINE,
        STANDARD_FIELDS as _CFG_STD_FIELDS,
    )

    @router.get("/intake/forms-config")
    async def forms_config_list(_user: dict = Depends(require_role("admin"))):
        configs = await _cfg_list(db)
        return {
            "ok": True,
            "configs": configs,
            "known_sources": list(_CFG_SOURCES),
            "pipeline_sources": list(_CFG_PIPELINE),
            "standard_fields": list(_CFG_STD_FIELDS),
        }

    @router.get("/intake/forms-config/{form_id}")
    async def forms_config_get(form_id: int, _user: dict = Depends(require_role("admin"))):
        cfg = await _cfg_get(db, form_id)
        if not cfg:
            raise HTTPException(404, detail=f"Form {form_id} not configured")
        return cfg

    @router.post("/intake/forms-config")
    async def forms_config_create(payload: dict, user: dict = Depends(require_role("admin"))):
        try:
            cfg = await _cfg_upsert(db, payload, allow_create=True)
        except ValueError as exc:
            raise HTTPException(400, detail=str(exc))
        logger.warning("forms_config_create: form_id=%s by %s", payload.get("form_id"), user.get("email"))
        return {"ok": True, "config": cfg}

    @router.put("/intake/forms-config/{form_id}")
    async def forms_config_update(form_id: int, payload: dict, user: dict = Depends(require_role("admin"))):
        payload = dict(payload)
        payload["form_id"] = form_id
        try:
            cfg = await _cfg_upsert(db, payload, allow_create=False)
        except ValueError as exc:
            raise HTTPException(400, detail=str(exc))
        logger.warning("forms_config_update: form_id=%s by %s", form_id, user.get("email"))
        return {"ok": True, "config": cfg}

    @router.delete("/intake/forms-config/{form_id}")
    async def forms_config_delete(form_id: int, user: dict = Depends(require_role("admin"))):
        ok = await _cfg_delete(db, form_id)
        if not ok:
            raise HTTPException(404, detail=f"Form {form_id} not configured")
        logger.warning("forms_config_delete: form_id=%s by %s", form_id, user.get("email"))
        return {"ok": True, "deleted": form_id}

    @router.get("/intake/forms-config/{form_id}/discover")
    async def forms_config_discover(form_id: int, _user: dict = Depends(require_role("admin"))):
        """Fetch the GF form metadata + a recent entry sample, and return
        a best-guess field map the admin can review before saving. Powers
        the "Auto-detect fields" button in the Add Form wizard."""
        # GF form metadata (labels + sub-inputs for composite fields)
        gf_form_meta = await _fetch_form_meta(form_id)
        # Recent entries to show as a preview
        try:
            entries = await _fetch_recent_entries(form_id, limit=5)
        except Exception as exc:  # noqa: BLE001
            entries = []
            meta_err = str(exc)
        else:
            meta_err = None
        sample = entries[0] if entries else {}
        guesses = _cfg_guess(sample, gf_form_meta)
        return {
            "ok": True,
            "form_id": form_id,
            "form_title": (gf_form_meta or {}).get("title") if gf_form_meta else None,
            "gf_form_meta": gf_form_meta,
            "guessed_field_map": guesses,
            "sample_entries": entries,
            "meta_error": meta_err,
        }

    @router.post("/intake/forms-config/{form_id}/preview")
    async def forms_config_preview(form_id: int, payload: dict | None = None,
                                   _user: dict = Depends(require_role("admin"))):
        """Dry-run: applies the supplied (or saved) config to the latest
        GF entries WITHOUT writing anything. Powers the "Test Import"
        button. Returns per-entry outcome predictions so the admin can
        sanity-check a mapping before going live."""
        payload = payload or {}
        if payload.get("form_id"):
            cfg = dict(payload)
            cfg["form_id"] = form_id
        else:
            cfg = await _cfg_get(db, form_id)
            if not cfg:
                raise HTTPException(404, detail=f"Form {form_id} not configured. Send a config in the body to preview an unsaved mapping.")
        try:
            entries = await _fetch_recent_entries(form_id, limit=10)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(502, detail=f"Gravity Forms fetch failed: {exc}")

        ids = [str(e["id"]) for e in entries]
        existing = await db.web_form_contacts.find(
            {"gravity_entry_id": {"$in": ids}},
            {"_id": 0, "gravity_entry_id": 1, "first_name": 1, "last_name": 1, "email": 1, "in_pipeline": 1, "pipeline_status": 1},
        ).to_list(len(ids))
        by_eid = {e["gravity_entry_id"]: e for e in existing}
        emails_in_entries = [
            (e.get(cfg.get("field_map", {}).get("email") or "4") or "").strip().lower()
            for e in entries
        ]
        emails_in_entries = [e for e in emails_in_entries if e]
        email_rows = await db.web_form_contacts.find(
            {"email": {"$in": emails_in_entries}},
            {"_id": 0, "email": 1, "first_name": 1, "last_name": 1, "in_pipeline": 1, "pipeline_status": 1, "source": 1, "gravity_entry_id": 1, "id": 1},
        ).to_list(None) if emails_in_entries else []
        by_email: dict[str, dict] = {}
        for r in email_rows:
            em = (r.get("email") or "").lower()
            if em and em not in by_email:
                by_email[em] = r

        rows: list[dict] = []
        for e in entries:
            eid = str(e["id"])
            extracted = _cfg_extract(e, cfg)
            preexisting = by_eid.get(eid)
            em_match = by_email.get(extracted.get("email") or "") if extracted.get("email") else None
            if preexisting:
                outcome = "already_in_db"
            elif em_match:
                em_active = em_match.get("in_pipeline") and (em_match.get("pipeline_status") or "") not in ("dormant", "lost", "")
                if not extracted["in_pipeline"]:
                    outcome = "would_insert_or_update_non_pipeline"
                elif em_active:
                    outcome = "skip_already_active"
                else:
                    outcome = "would_promote_existing"
            else:
                outcome = "would_insert"
            rows.append({
                "entry_id": eid,
                "name": f"{extracted['first_name'] or ''} {extracted['last_name'] or ''}".strip() or extracted.get("raw_full_name"),
                "email": extracted.get("email"),
                "phone": extracted.get("phone"),
                "postcode": extracted.get("postcode"),
                "source": extracted["source"],
                "in_pipeline": extracted["in_pipeline"],
                "outcome": outcome,
            })

        summary = {}
        for r in rows:
            summary[r["outcome"]] = summary.get(r["outcome"], 0) + 1
        return {"ok": True, "form_id": form_id, "preview": rows, "summary": summary}

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
