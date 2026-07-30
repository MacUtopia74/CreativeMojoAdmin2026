"""Admin-only endpoints to run the WordPress → website_bio backfill
against the currently-connected database (preview OR production).

This is a **one-off** migration. The bundled CSV (`wp_bio_bundled/
franchises_wp.csv`) is the exact WordPress export approved on preview
and is SHA-256 checksummed at request time. Once the production run
is verified, the entire router is removed by the follow-up commit —
the durable audit collection `website_bio_migration_log` is kept.

Endpoints
---------
POST /api/admin/wp-bio-migration/bundled-dry-run
    No body required. Reads the bundled CSV + applies the two
    HQ-approved manual inclusions (Samantha Whiteman #0095 and Helen
    Lyons #0006 Option A). Returns the full plan + a
    `baseline_deviation_report` that compares live-DB totals against
    the ratified preview baseline.

POST /api/admin/wp-bio-migration/bundled-apply
    Body:
        expected_environment            : "preview" | "production"
        expected_deployment_fingerprint : sha256 hex string
        confirmation_token              : from a fresh dry-run
        typed_confirmation              : must be exactly "PROCEED"
    Refuses to run if the plan contains any conflicts, name mismatches,
    or no-matches (i.e. Samantha not found under #0095), or if the
    manual inclusions do not resolve to exactly {Samantha, Helen} as
    approved.

The endpoint does NOT accept any uploaded CSV, so there is no reusable
upload facility.
"""
from __future__ import annotations

import base64
import csv
import hashlib
import io
import logging
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Body, Depends, HTTPException

from environment_identity import environment_identity
from wp_bio_migration_core import (
    SCRIPT_VERSION,
    APPROVED_OVERWRITE_FRANCHISE_NUMBERS,
    HOLD_BACK_FRANCHISE_NUMBERS,
    MIN_CHARS,
    build_plan,
)

logger = logging.getLogger("creative-mojo-admin.wp-bio-migration")

# ---- Bundled artefacts (one-off, checksum-verified) -------------------------
BUNDLED_CSV_PATH = (
    Path(__file__).parent / "wp_bio_bundled" / "franchises_wp.csv"
)
BUNDLED_CSV_SHA256 = (
    "b45f03770e17082ec629b6f4744a12d9806e492934f49c13b6d4fc6ffb6557f8"
)
BUNDLED_CSV_MD5 = "94d10f5ee8bcc8bd57bc4ba4d0efab00"  # populated at load


# Ratified preview baseline. Any deviation is surfaced to the UI so
# the operator can inspect before typing PROCEED.
PREVIEW_BASELINE_STATS = {
    "wp_rows_matched": 29,
    "wp_rows_unmatched": 15,
    "to_insert": 21,
    "to_overwrite": 1,
    "to_preserve": 1,
    "to_skip_short": 2,
    "to_skip_placeholder": 0,
    "to_skip_pending_manual_choice": 0,   # Helen overridden
    "to_skip_blank_content": 0,
    "manual_inclusions_to_apply": 2,      # Samantha + Helen
    "manual_inclusions_skipped_no_match": 0,
    "manual_inclusions_skipped_name_mismatch": 0,
    "manual_inclusions_skipped_conflict": 0,
}

# ---- HQ-approved manual inclusions (frozen; no user input) -----------------
SAMANTHA_BIO = (
    "Hello, I'm Sam.\n\n"
    "I'm just thrilled to have joined Creative Mojo, where I plan to use "
    "my creativity, my inclusive non-judgemental nature and people skills "
    "to bring joy, social interaction and inclusion to my workshops, but "
    "most of all for us all to have fun!\n\n"
    "I will be bringing more than 20 years of experience in mediation and "
    "reunion work within Children's Services, which I have loved. Now it "
    "is time for a new adventure, so please come along.\n\n"
    "I offer group sessions as well as one-to-one bookings, which can "
    "take place weekly, fortnightly or monthly and last either one hour "
    "or an hour and a half. I cover Bexhill, Hastings and the High Weald "
    "Area of Outstanding Natural Beauty in East Sussex, including "
    "Heathfield, Wadhurst, Staplehurst and up to Tunbridge Wells.\n\n"
    "I look forward to meeting you soon."
)
HELEN_OPTION_A_BIO = (
    "Hello, I'm Helen,\n\n"
    "I have run the Clacton-On-Sea Creative Mojo franchise since January "
    "2018 and have recently expanded to include Colchester. After a 15 "
    "year career in the NHS I was ready for a change and wanted to do "
    "something worthwhile and rewarding whilst also improving my "
    "work:life balance. I have always enjoyed being creative and am "
    "thrilled to now have a job that enables me to bring the joy of arts "
    "and crafts to residents of different backgrounds and abilities. It "
    "is a privilege and a joy to work with such a wide range of amazing "
    "people."
)
MANUAL_INCLUSIONS_FROZEN = [
    {
        "franchise_number": "0095",
        "expected_franchisee_name": "Samantha Whiteman",
        "text": SAMANTHA_BIO,
        "action": "inserted_manual_approved_samantha_whiteman",
        "note": ("HQ-approved manual biography for new franchisee "
                 "Samantha Whiteman (Bexhill, Hastings & High Weald AONB). "
                 "Not sourced from the WordPress export; provided by Paul "
                 "on 2026-07-30 for the one-off backfill."),
    },
    {
        "franchise_number": "0006",
        "expected_franchisee_name": "Helen Lyons",
        "text": HELEN_OPTION_A_BIO,
        "action": "inserted_manual_choice_A",
        "override_hold_back": True,
        "note": ("Paul-approved Option A (Colchester & Districts, 550c). "
                 "Option B (Clacton, 501c) was rejected."),
    },
]


def _load_bundled_csv() -> tuple[list[dict], str]:
    """Load the bundled CSV and verify its SHA-256. Raises 500 if the
    checksum doesn't match — protects against on-disk tampering."""
    if not BUNDLED_CSV_PATH.exists():
        raise HTTPException(500, detail="bundled CSV missing on this deploy")
    raw = BUNDLED_CSV_PATH.read_bytes()
    actual = hashlib.sha256(raw).hexdigest()
    if actual != BUNDLED_CSV_SHA256:
        raise HTTPException(500, detail={
            "error": "bundled_csv_checksum_mismatch",
            "expected_sha256": BUNDLED_CSV_SHA256,
            "actual_sha256": actual,
            "hint": ("The bundled WordPress export has been modified or "
                     "corrupted. Refuse to run."),
        })
    md5 = hashlib.md5(raw).hexdigest()
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = raw.decode("utf-8", errors="replace")
    rows = list(csv.DictReader(io.StringIO(text)))
    return rows, md5


def _decode_csv(source_csv_base64: str) -> tuple[list[dict], str]:
    """Legacy path used by preview verification tests only."""
    if not source_csv_base64:
        raise HTTPException(422, "source_csv_base64 is required")
    try:
        raw = base64.b64decode(source_csv_base64, validate=True)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(422, f"source_csv_base64 not valid base64: {exc}")
    md5 = hashlib.md5(raw).hexdigest()
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = raw.decode("utf-8", errors="replace")
    return list(csv.DictReader(io.StringIO(text))), md5


def _confirmation_token(env_fp: str, csv_md5: str, plan: dict) -> str:
    """Bind a token to (deployment fingerprint | CSV content | intended
    action digest). If any of these change between dry-run and apply,
    the token no longer validates."""
    digest_input = (
        f"{env_fp}|{csv_md5}|"
        f"{plan['stats']['to_insert']}|{plan['stats']['to_overwrite']}|"
        f"{plan['stats']['to_preserve']}|"
        f"{','.join(sorted(a['franchisee_id'] for a in plan['actions'] if a['will_write'] and a['franchisee_id']))}"
    )
    return hashlib.sha256(digest_input.encode()).hexdigest()


def _baseline_deviation_report(plan: dict) -> dict:
    """Compare live-DB plan stats to the ratified preview baseline and
    highlight any deviation that should block the apply step."""
    live = plan["stats"]
    rows = []
    hard_block = False
    for k, expected in PREVIEW_BASELINE_STATS.items():
        actual = live.get(k)
        matches = actual == expected
        # Hard-blocking conditions.
        if k.startswith("manual_inclusions_skipped_") and actual and actual > 0:
            hard_block = True
        if k == "manual_inclusions_to_apply" and actual != 2:
            hard_block = True
        rows.append({
            "metric": k, "expected": expected, "actual": actual,
            "matches": matches,
        })
    # Extra hard-blockers based on individual actions.
    manual_ids_writing = {
        a["franchise_number"] for a in plan["actions"]
        if a["will_write"] and a["action"].startswith("inserted_manual")
    }
    samantha_writes = "0095" in manual_ids_writing
    helen_writes    = "0006" in manual_ids_writing
    anita_writes = any(
        a["will_write"] and a["action"] == "overwrote_approved"
        and a["franchise_number"] == "0030"
        for a in plan["actions"]
    )
    if not samantha_writes or not helen_writes:
        hard_block = True
    return {
        "rows": rows,
        "hard_block": hard_block,
        "samantha_0095_writes": samantha_writes,
        "helen_0006_option_A_writes": helen_writes,
        "anita_0030_overwrite_queued": anita_writes,
    }


def build_wp_bio_migration_router(db, require_role):
    router = APIRouter()

    @router.post("/admin/wp-bio-migration/bundled-dry-run")
    async def bundled_dry_run(
        _user: dict = Depends(require_role("admin")),
    ):
        identity = environment_identity()
        rows, csv_md5 = _load_bundled_csv()
        plan = await build_plan(db, rows,
                                manual_inclusions=MANUAL_INCLUSIONS_FROZEN)
        token = _confirmation_token(identity["deployment_fingerprint"],
                                    csv_md5, plan)
        return {
            "environment": identity,
            "csv_sha256": BUNDLED_CSV_SHA256,
            "csv_md5": csv_md5,
            "csv_row_count": len(rows),
            "script_version": SCRIPT_VERSION,
            "stats": plan["stats"],
            "baseline_stats": PREVIEW_BASELINE_STATS,
            "baseline_deviation": _baseline_deviation_report(plan),
            "held_back_franchise_numbers": sorted(HOLD_BACK_FRANCHISE_NUMBERS),
            "approved_overwrite_franchise_numbers": sorted(
                APPROVED_OVERWRITE_FRANCHISE_NUMBERS),
            "min_chars_threshold": MIN_CHARS,
            "actions_preview": plan["actions"],
            "confirmation_token": token,
        }

    @router.post("/admin/wp-bio-migration/bundled-apply")
    async def bundled_apply(
        body: dict = Body(...),
        user: dict = Depends(require_role("admin")),
    ):
        identity = environment_identity()
        if identity["environment_name"] == "unset":
            raise HTTPException(500, detail={
                "error": "environment_name_unset", "identity": identity})

        expected_env = (body or {}).get("expected_environment")
        if expected_env != identity["environment_name"]:
            raise HTTPException(403, detail={
                "error": "expected_environment_mismatch",
                "you_asked_to_run_on": expected_env,
                "you_are_actually_on": identity["environment_name"]})

        expected_fp = (body or {}).get("expected_deployment_fingerprint")
        if expected_fp != identity["deployment_fingerprint"]:
            raise HTTPException(403, detail={
                "error": "expected_deployment_fingerprint_mismatch",
                "you_asked_to_run_on_fingerprint": expected_fp,
                "you_are_actually_on_fingerprint":
                    identity["deployment_fingerprint"]})

        if (body or {}).get("typed_confirmation") != "PROCEED":
            raise HTTPException(403, detail={
                "error": "typed_confirmation_required",
                "hint": 'Body must contain "typed_confirmation": "PROCEED".'})

        rows, csv_md5 = _load_bundled_csv()
        plan = await build_plan(db, rows,
                                manual_inclusions=MANUAL_INCLUSIONS_FROZEN)

        # Baseline gate.
        deviation = _baseline_deviation_report(plan)
        if deviation["hard_block"]:
            raise HTTPException(409, detail={
                "error": "baseline_hard_block",
                "deviation": deviation,
                "hint": ("Live DB state prevents a clean apply. Re-run "
                         "dry-run and inspect the deviation report."),
            })

        our_token = _confirmation_token(identity["deployment_fingerprint"],
                                        csv_md5, plan)
        if (body or {}).get("confirmation_token") != our_token:
            raise HTTPException(403, detail={
                "error": "confirmation_token_mismatch",
                "current_token": our_token,
                "hint": ("Re-run /admin/wp-bio-migration/bundled-dry-run "
                         "and use the fresh confirmation_token.")})

        now = datetime.now(timezone.utc)
        results = {
            "inserted": 0, "overwrote_approved": 0, "preserved_existing": 0,
            "skipped_pending_manual_choice": 0, "skipped_short_content": 0,
            "skipped_placeholder": 0, "skipped_blank_content": 0,
            "skipped_already_migrated": 0, "show_flag_enabled": 0,
        }
        applied_rows: list[dict] = []
        for a in plan["actions"]:
            action = a["action"]
            results[action] = results.get(action, 0) + 1

            if not a["franchisee_id"]:
                continue

            prior = await db.website_bio_migration_log.find_one(
                {"franchisee_id": a["franchisee_id"],
                 "script_version": SCRIPT_VERSION,
                 "action": {"$regex": "^(inserted|overwrote_approved)"}},
                {"_id": 0, "action": 1},
            )
            if prior:
                results["skipped_already_migrated"] += 1
                continue

            if action == "inserted" or action.startswith("inserted_manual"):
                await db.franchisees.update_one(
                    {"id": a["franchisee_id"]},
                    {"$set": {
                        "website_bio": a["text"],
                        "show_website_bio": True,
                        "website_bio_source": (
                            "wp_export_2026_07_29"
                            if action == "inserted"
                            else "hq_manual_2026_07_29"),
                        "website_bio_migrated_at": now,
                    }},
                )
                results["show_flag_enabled"] += 1
                applied_rows.append({"franchise_number": a["franchise_number"],
                                     "name": a["name"], "action": action,
                                     "chars": a["chars"]})
            elif action == "overwrote_approved":
                await db.franchisees.update_one(
                    {"id": a["franchisee_id"]},
                    {"$set": {
                        "website_bio": a["text"],
                        "show_website_bio": True,
                        "website_bio_source": "wp_export_2026_07_29",
                        "website_bio_migrated_at": now,
                    }},
                )
                results["show_flag_enabled"] += 1
                applied_rows.append({"franchise_number": a["franchise_number"],
                                     "name": a["name"], "action": action,
                                     "chars": a["chars"]})
            elif action == "preserved_existing":
                await db.franchisees.update_one(
                    {"id": a["franchisee_id"]},
                    {"$set": {"show_website_bio": True}})
                results["show_flag_enabled"] += 1
                applied_rows.append({"franchise_number": a["franchise_number"],
                                     "name": a["name"], "action": action,
                                     "chars": a["chars"]})

            await db.website_bio_migration_log.update_one(
                {"franchisee_id": a["franchisee_id"],
                 "script_version": SCRIPT_VERSION},
                {"$set": {
                    "franchisee_id": a["franchisee_id"],
                    "franchise_number": a["franchise_number"],
                    "franchisee_name": a["name"],
                    "source_wp_permalink": a.get("source_permalink") or "",
                    "source_wp_title": a.get("source_title") or "",
                    "source_wp_row_index": a.get("source_row_index"),
                    "migration_method": ("hq_manual"
                        if action.startswith("inserted_manual")
                        else "email_high_confidence"),
                    "match_confidence": "high" if action in
                        ("inserted", "overwrote_approved") else "n/a",
                    "biography_char_count": a["chars"],
                    "action": action,
                    "inserted_or_overwritten":
                        "overwritten" if action == "overwrote_approved"
                        else "inserted" if action == "inserted"
                            or action.startswith("inserted_manual")
                        else "n/a",
                    "previous_website_bio": a.get("previous_bio"),
                    "final_show_website_bio":
                        action in ("inserted", "overwrote_approved",
                                   "preserved_existing")
                        or action.startswith("inserted_manual"),
                    "migrated_at": now,
                    "script_version": SCRIPT_VERSION,
                    "note": a.get("note") or "",
                    "environment_identity": {
                        "environment_name": identity["environment_name"],
                        "deployment_fingerprint":
                            identity["deployment_fingerprint"],
                        "datastore_fingerprint":
                            identity["datastore_fingerprint"],
                    },
                    "operator_email": user.get("email"),
                    "csv_md5": csv_md5,
                    "csv_sha256": BUNDLED_CSV_SHA256,
                }},
                upsert=True,
            )

        return {
            "status": "ok",
            "environment": identity,
            "script_version": SCRIPT_VERSION,
            "csv_sha256": BUNDLED_CSV_SHA256,
            "csv_md5": csv_md5,
            "results": results,
            "applied_rows": applied_rows,
            "unmatched_wp_rows": plan["unmatched_wp_rows"],
        }

    return router

