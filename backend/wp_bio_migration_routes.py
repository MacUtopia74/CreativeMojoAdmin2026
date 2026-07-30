"""Admin-only endpoints to run the WordPress → website_bio backfill
against the currently-connected database (preview OR production).

Fingerprint-guarded, mirroring the CQC Phase 3 commit pattern.

Endpoints
---------
POST /api/admin/wp-bio-migration/dry-run
    Body:
        source_csv_base64: string  (base64-encoded raw WP export CSV)
    Returns:
        stats + confirmation_token bound to (env fingerprint + CSV md5
        + live-DB match counts). Does not write anything.

POST /api/admin/wp-bio-migration/apply
    Body:
        source_csv_base64        : string
        expected_environment     : "preview" | "production"
        expected_deployment_fingerprint : sha256 hex string
        confirmation_token       : from a fresh dry-run
    Applies the migration with the same rules used on the preview run
    (blank-only inserts, approved overwrite for Anita #0030, held-back
    for Helen Lyons which is written separately via a manual choice
    audit row, 60-char threshold, dedup by typography-normalised key,
    Monica preserved, etc.). Writes durable per-franchisee audit rows
    to `website_bio_migration_log` with
    script_version=`wp_bio_backfill_2026_07_29_v1`.

The endpoint does not download from any remote URL — the CSV must be
posted directly so there is no ambiguity about which file was used.

Idempotency: a franchisee with an audit row `action IN {inserted,
overwrote_approved, inserted_manual_choice_A, inserted_manual_choice_B}`
under the target script_version is not written again. Re-running is a
no-op.
"""
from __future__ import annotations

import base64
import csv
import hashlib
import io
import logging
from datetime import datetime, timezone

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


def _decode_csv(source_csv_base64: str) -> tuple[list[dict], str]:
    """Decode + parse the CSV body. Returns (rows, md5_hex_of_raw)."""
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
    reader = csv.DictReader(io.StringIO(text))
    rows = list(reader)
    if not rows:
        raise HTTPException(422, "CSV has no data rows")
    return rows, md5


def _confirmation_token(env_fp: str, csv_md5: str, plan: dict) -> str:
    """Bind a token to (deployment fingerprint | CSV content | intended
    action digest). If any of these change between dry-run and apply,
    the token no longer validates."""
    digest_input = (
        f"{env_fp}|{csv_md5}|"
        f"{plan['stats']['to_insert']}|{plan['stats']['to_overwrite']}|"
        f"{plan['stats']['to_preserve']}|"
        f"{','.join(sorted(a['franchisee_id'] for a in plan['actions'] if a['will_write']))}"
    )
    return hashlib.sha256(digest_input.encode()).hexdigest()


def build_wp_bio_migration_router(db, require_role):
    router = APIRouter()

    @router.post("/admin/wp-bio-migration/dry-run")
    async def dry_run(
        body: dict = Body(...),
        _user: dict = Depends(require_role("admin")),
    ):
        identity = environment_identity()
        rows, csv_md5 = _decode_csv((body or {}).get("source_csv_base64"))
        plan = await build_plan(db, rows)
        token = _confirmation_token(identity["deployment_fingerprint"],
                                    csv_md5, plan)
        return {
            "environment": identity,
            "csv_md5": csv_md5,
            "csv_row_count": len(rows),
            "script_version": SCRIPT_VERSION,
            "stats": plan["stats"],
            "held_back_franchise_numbers": sorted(HOLD_BACK_FRANCHISE_NUMBERS),
            "approved_overwrite_franchise_numbers": sorted(
                APPROVED_OVERWRITE_FRANCHISE_NUMBERS),
            "min_chars_threshold": MIN_CHARS,
            "actions_preview": plan["actions"],
            "confirmation_token": token,
        }

    @router.post("/admin/wp-bio-migration/apply")
    async def apply_migration(
        body: dict = Body(...),
        user: dict = Depends(require_role("admin")),
    ):
        identity = environment_identity()

        # 1) env_name safety.
        if identity["environment_name"] == "unset":
            raise HTTPException(500, detail={
                "error": "environment_name_unset",
                "identity": identity,
            })

        # 2) client opts into a specific environment_name.
        expected_env = (body or {}).get("expected_environment")
        if expected_env != identity["environment_name"]:
            raise HTTPException(403, detail={
                "error": "expected_environment_mismatch",
                "you_asked_to_run_on": expected_env,
                "you_are_actually_on": identity["environment_name"],
                "identity": identity,
                "hint": ("The client must explicitly opt into the target "
                         "environment_name. Refuse to run."),
            })

        # 3) client-supplied deployment fingerprint must match server.
        expected_fp = (body or {}).get("expected_deployment_fingerprint")
        if expected_fp != identity["deployment_fingerprint"]:
            raise HTTPException(403, detail={
                "error": "expected_deployment_fingerprint_mismatch",
                "you_asked_to_run_on_fingerprint": expected_fp,
                "you_are_actually_on_fingerprint": identity["deployment_fingerprint"],
                "identity": identity,
                "hint": ("Re-run /admin/wp-bio-migration/dry-run to capture "
                         "the current deployment_fingerprint."),
            })

        rows, csv_md5 = _decode_csv((body or {}).get("source_csv_base64"))
        plan = await build_plan(db, rows)

        # 4) confirmation_token binds the caller to the exact plan we
        #    just computed. A stale token from a previous dry-run
        #    (before, say, someone added a manual bio) will fail.
        our_token = _confirmation_token(identity["deployment_fingerprint"],
                                        csv_md5, plan)
        client_token = (body or {}).get("confirmation_token")
        if client_token != our_token:
            raise HTTPException(403, detail={
                "error": "confirmation_token_mismatch",
                "current_token": our_token,
                "hint": ("Re-run /admin/wp-bio-migration/dry-run and use the "
                         "confirmation_token from the response body."),
            })

        # 5) Apply per-action write. Reuse plan.actions computed above.
        now = datetime.now(timezone.utc)
        results = {
            "inserted": 0,
            "overwrote_approved": 0,
            "preserved_existing": 0,
            "skipped_pending_manual_choice": 0,
            "skipped_short_content": 0,
            "skipped_placeholder": 0,
            "skipped_blank_content": 0,
            "skipped_already_migrated": 0,
            "show_flag_enabled": 0,
        }
        applied_rows: list[dict] = []
        for a in plan["actions"]:
            action = a["action"]
            results[action] = results.get(action, 0) + 1

            # Idempotency: does this franchisee already have a "write"
            # row in the log under this script_version?
            prior = await db.website_bio_migration_log.find_one(
                {"franchisee_id": a["franchisee_id"],
                 "script_version": SCRIPT_VERSION,
                 "action": {"$in": [
                     "inserted", "overwrote_approved",
                     "inserted_manual_choice_A", "inserted_manual_choice_B",
                 ]}},
                {"_id": 0, "action": 1},
            )
            if prior:
                results["skipped_already_migrated"] += 1
                continue

            if action == "inserted":
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
                # Ensure show flag on for pre-existing bios.
                await db.franchisees.update_one(
                    {"id": a["franchisee_id"]},
                    {"$set": {"show_website_bio": True}},
                )
                results["show_flag_enabled"] += 1
                applied_rows.append({"franchise_number": a["franchise_number"],
                                     "name": a["name"], "action": action,
                                     "chars": a["chars"]})
            # skipped_* branches: no franchisee write, only audit row.

            # Write / upsert the audit row for every action (idempotent).
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
                    "migration_method": "email_high_confidence",
                    "match_confidence": "high" if action in
                        ("inserted", "overwrote_approved") else "n/a",
                    "biography_char_count": a["chars"],
                    "action": action,
                    "inserted_or_overwritten":
                        "overwritten" if action == "overwrote_approved"
                        else "inserted" if action == "inserted"
                        else "n/a",
                    "previous_website_bio": a.get("previous_bio"),
                    "final_show_website_bio":
                        action in ("inserted", "overwrote_approved",
                                   "preserved_existing"),
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
                }},
                upsert=True,
            )

        return {
            "status": "ok",
            "environment": identity,
            "script_version": SCRIPT_VERSION,
            "csv_md5": csv_md5,
            "results": results,
            "applied_rows": applied_rows,
            "unmatched_wp_rows": plan["unmatched_wp_rows"],
            "guarantees": {
                "writes_only": [
                    "franchisees.website_bio (only if blank OR approved overwrite)",
                    "franchisees.show_website_bio (set to true where bio ends populated)",
                    "franchisees.website_bio_source (provenance)",
                    "franchisees.website_bio_migrated_at (timestamp)",
                    "website_bio_migration_log (one audit row per franchisee)",
                ],
                "no_writes_to": [
                    "any other franchisee field",
                    "users, contacts, franchisee_clients, hq_home_notes",
                    "franchisees for ex-franchisees or HQ records",
                ],
            },
        }

    return router
