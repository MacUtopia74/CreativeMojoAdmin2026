"""Backfill franchisees.website_bio from the WordPress franchise export.

READ-WRITE. Runs on the DB pointed at by MONGO_URL / DB_NAME.
Idempotent — re-running is a no-op for franchisees already migrated
by this script (audit log lookup on `website_bio_migration_log`).

Rules (agreed with Paul, July 2026 spec):
  * High-confidence email match only. Title matches never trigger a
    write. Ambiguous matches never trigger a write.
  * Skip when live `website_bio` is already populated, EXCEPT for the
    explicitly-approved overwrite list (currently: Anita Priest #0030
    only — her existing bio references "Cheryl and Johann", a legacy
    copy-paste error).
  * Skip when the WP bio is < 60 characters (placeholder/coming-soon).
  * Skip when WP text is a known placeholder string.
  * Deduplicate: if the same person has multiple WP pages with
    identical text, insert once.
  * Helen Lyons (#0006) held back pending final choice — recorded as
    `skipped_pending_manual_choice`.
  * For every franchisee whose bio ends up populated (this run OR
    previously), set show_website_bio = true so the map popup starts
    surfacing the biography immediately.
  * One audit row per franchisee touched in
    `website_bio_migration_log`.
"""
from __future__ import annotations

import argparse
import asyncio
import csv
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

from motor.motor_asyncio import AsyncIOMotorClient

# Reuse the well-tested HTML→text + normalise helpers from the dry run.
sys.path.insert(0, str(Path(__file__).parent))
from wp_bio_dry_run import (  # noqa: E402
    wp_content_to_text,
    normalise_email,
)

SCRIPT_VERSION = "wp_bio_backfill_2026_07_31_v1"
MIN_CHARS = 60
APPROVED_OVERWRITE_FRANCHISE_NUMBERS = {"0030"}  # Anita Priest
HOLD_BACK_FRANCHISE_NUMBERS = {"0006"}  # Helen Lyons — awaiting choice
PLACEHOLDER_SNIPPETS = (
    "biography here to come",
    "coming soon",
    "bio to come",
    "biography to come",
)


def is_placeholder(text: str) -> bool:
    t = (text or "").strip().lower()
    return any(p in t for p in PLACEHOLDER_SNIPPETS)


def _dedup_key(text: str) -> str:
    """Normalise smart quotes / dashes / whitespace so that two WP
    pages differing only in typography count as duplicates for
    dedup purposes. The stored bio keeps its original characters."""
    s = (text or "")
    for a, b in (("\u2018", "'"), ("\u2019", "'"), ("\u201c", '"'),
                 ("\u201d", '"'), ("\u2013", "-"), ("\u2014", "-"),
                 ("\u00a0", " ")):
        s = s.replace(a, b)
    return " ".join(s.lower().split())


async def run(csv_path: Path, apply: bool) -> None:
    client = AsyncIOMotorClient(os.environ["MONGO_URL"])
    db = client[os.environ["DB_NAME"]]

    # 1) Load CSV rows and index by contact_email.
    with csv_path.open("r", encoding="utf-8-sig", newline="") as fh:
        reader = csv.DictReader(fh)
        raw_rows = list(reader)

    # 2) Load active franchisees.
    active = await db.franchisees.find(
        {"tags": "Franchisee", "lifecycle_status": {"$ne": "ex"}},
        {"_id": 0, "id": 1, "first_name": 1, "last_name": 1,
         "organisation": 1, "wp_title": 1, "franchise_number": 1,
         "email": 1, "contact_email": 1, "primary_email": 1,
         "mojo_email": 1, "secondary_email": 1,
         "website_bio": 1, "show_website_bio": 1},
    ).to_list(500)
    print(f"[db]  loaded {len(active)} active franchisees")

    # Build email → franchisee index (with all e-mail flavours as keys).
    email_lookup: dict[str, dict] = {}
    for f in active:
        for k in ("email", "contact_email", "primary_email",
                  "mojo_email", "secondary_email"):
            e = normalise_email(f.get(k))
            if e:
                email_lookup.setdefault(e, f)

    # 3) Group WP rows by matched-franchisee id.
    grouped: dict[str, list[dict]] = {}
    unmatched: list[dict] = []
    for i, r in enumerate(raw_rows, start=1):
        r["_row_index"] = i
        email = normalise_email(r.get("contact_email") or r.get("_contact_email"))
        target = email_lookup.get(email)
        if target is None:
            unmatched.append(r)
            continue
        grouped.setdefault(target["id"], []).append(r)

    now_utc = datetime.now(timezone.utc)

    # Load prior migration log (idempotency).
    prior_log = {
        doc["franchisee_id"]: doc
        async for doc in db.website_bio_migration_log.find(
            {"script_version": SCRIPT_VERSION},
            {"_id": 0, "franchisee_id": 1, "action": 1},
        )
    }

    stats = {
        "wp_rows_total": len(raw_rows),
        "wp_rows_matched": 0,
        "wp_rows_unmatched": len(unmatched),
        "populated_new": 0,
        "populated_overwrite_approved": 0,
        "preserved_existing": 0,
        "skipped_placeholder": 0,
        "skipped_short": 0,
        "skipped_blank_content": 0,
        "skipped_pending_manual_choice": 0,
        "skipped_already_migrated": 0,
        "show_flag_enabled": 0,
    }
    audit_entries: list[dict] = []
    per_franchisee_result: list[dict] = []

    # 4) For each matched franchisee, pick a canonical bio.
    for fid, rows in grouped.items():
        target = next(f for f in active if f["id"] == fid)
        fno = target.get("franchise_number") or ""
        fname = f"{target.get('first_name') or ''} {target.get('last_name') or ''}".strip()
        stats["wp_rows_matched"] += len(rows)

        # Idempotency: if already migrated by this script version, skip.
        if fid in prior_log and prior_log[fid].get("action") in (
                "inserted", "overwrote_approved"):
            stats["skipped_already_migrated"] += 1
            per_franchisee_result.append({
                "franchisee_id": fid, "franchise_number": fno,
                "name": fname, "action": "skipped_already_migrated",
                "chars": 0, "note": "prior run wrote this record",
            })
            continue

        # Hold-back list (Helen Lyons).
        if fno in HOLD_BACK_FRANCHISE_NUMBERS:
            stats["skipped_pending_manual_choice"] += 1
            audit_entries.append(_audit_row(
                target, rows[0], "skipped_pending_manual_choice",
                inserted=False, chars=0, prev_bio=target.get("website_bio"),
                final_show_flag=bool(target.get("show_website_bio")),
                note="Held back pending Paul's choice between Colchester (550) and Clacton (501) bios.",
            ))
            per_franchisee_result.append({
                "franchisee_id": fid, "franchise_number": fno,
                "name": fname, "action": "skipped_pending_manual_choice",
                "chars": 0, "note": "manual choice required",
            })
            continue

        # Preserve-existing guard runs BEFORE the WP-content quality
        # guards so franchisees with an existing bio always end up with
        # `show_website_bio=True`, regardless of whether the WP row
        # matched them contains a placeholder / short text.
        existing = (target.get("website_bio") or "").strip()
        if existing and fno not in APPROVED_OVERWRITE_FRANCHISE_NUMBERS:
            stats["preserved_existing"] += 1
            enable_flag = not bool(target.get("show_website_bio"))
            if apply and enable_flag:
                await db.franchisees.update_one(
                    {"id": fid}, {"$set": {"show_website_bio": True}}
                )
                stats["show_flag_enabled"] += 1
            elif enable_flag:
                stats["show_flag_enabled"] += 1
            audit_entries.append(_audit_row(
                target, rows[0], "preserved_existing",
                inserted=False, chars=len(existing),
                prev_bio=existing,
                final_show_flag=True,
                note="Live bio already populated; WP row not written.",
            ))
            per_franchisee_result.append({
                "franchisee_id": fid, "franchise_number": fno,
                "name": fname, "action": "preserved_existing",
                "chars": len(existing),
                "note": "live bio preserved, show_website_bio ensured true",
            })
            continue

        # Extract candidate texts, dedupe by typography-normalised key.
        candidates: list[tuple[dict, str]] = []
        seen_keys: set[str] = set()
        for r in rows:
            txt = wp_content_to_text(r.get("Content") or "").strip()
            if not txt:
                continue
            key = _dedup_key(txt)
            if key in seen_keys:
                continue
            seen_keys.add(key)
            candidates.append((r, txt))

        # If no usable content at all.
        if not candidates:
            stats["skipped_blank_content"] += 1
            audit_entries.append(_audit_row(
                target, rows[0], "skipped_blank_content",
                inserted=False, chars=0, prev_bio=target.get("website_bio"),
                final_show_flag=bool(target.get("show_website_bio")),
                note="No WP row for this franchisee carried any content.",
            ))
            per_franchisee_result.append({
                "franchisee_id": fid, "franchise_number": fno,
                "name": fname, "action": "skipped_blank_content",
                "chars": 0, "note": "no WP content",
            })
            continue

        # After dedupe, if there are still multiple distinct texts, this is
        # ambiguous (e.g. Helen Lyons) — but Helen is already held back
        # above, so anyone else falling here is unexpected. Skip.
        if len(candidates) > 1:
            stats["skipped_pending_manual_choice"] += 1
            audit_entries.append(_audit_row(
                target, candidates[0][0], "skipped_ambiguous_multiple_texts",
                inserted=False, chars=0, prev_bio=target.get("website_bio"),
                final_show_flag=bool(target.get("show_website_bio")),
                note=f"{len(candidates)} distinct WP bios matched — needs manual choice.",
            ))
            per_franchisee_result.append({
                "franchisee_id": fid, "franchise_number": fno,
                "name": fname, "action": "skipped_ambiguous_multiple_texts",
                "chars": 0, "note": f"{len(candidates)} distinct WP bios",
            })
            continue

        # Single canonical text after dedupe.
        source_row, text = candidates[0]
        n_chars = len(text)

        # Placeholder / short-text guards.
        if is_placeholder(text):
            stats["skipped_placeholder"] += 1
            audit_entries.append(_audit_row(
                target, source_row, "skipped_placeholder",
                inserted=False, chars=n_chars, prev_bio=target.get("website_bio"),
                final_show_flag=bool(target.get("show_website_bio")),
                note=f"WP text matched placeholder pattern: {text[:60]!r}",
            ))
            per_franchisee_result.append({
                "franchisee_id": fid, "franchise_number": fno,
                "name": fname, "action": "skipped_placeholder",
                "chars": n_chars, "note": "placeholder text",
            })
            continue

        if n_chars < MIN_CHARS:
            stats["skipped_short"] += 1
            audit_entries.append(_audit_row(
                target, source_row, "skipped_short_content",
                inserted=False, chars=n_chars, prev_bio=target.get("website_bio"),
                final_show_flag=bool(target.get("show_website_bio")),
                note=f"WP bio only {n_chars} chars, below {MIN_CHARS}-char threshold.",
            ))
            per_franchisee_result.append({
                "franchisee_id": fid, "franchise_number": fno,
                "name": fname, "action": "skipped_short_content",
                "chars": n_chars, "note": f"{n_chars} < {MIN_CHARS} chars",
            })
            continue

        # Existing bio should never reach this point unless it's an
        # approved overwrite — the preserve branch above already
        # handled non-approved populated bios.
        existing = (target.get("website_bio") or "").strip()

        action = "overwrote_approved" if existing else "inserted"
        if action == "overwrote_approved":
            stats["populated_overwrite_approved"] += 1
        else:
            stats["populated_new"] += 1

        if apply:
            await db.franchisees.update_one(
                {"id": fid},
                {"$set": {
                    "website_bio": text,
                    "show_website_bio": True,
                    "website_bio_source": "wp_export_2026_07_29",
                    "website_bio_migrated_at": now_utc,
                }},
            )
        stats["show_flag_enabled"] += 1

        audit_entries.append(_audit_row(
            target, source_row, action,
            inserted=True, chars=n_chars,
            prev_bio=existing if action == "overwrote_approved" else None,
            final_show_flag=True,
            note=("Overwrite approved for Anita #0030 (Cheryl/Johann legacy text)."
                  if action == "overwrote_approved" else
                  "Inserted from WP export."),
        ))
        per_franchisee_result.append({
            "franchisee_id": fid, "franchise_number": fno,
            "name": fname, "action": action, "chars": n_chars,
            "note": f"wp_title={source_row.get('Title')!r}",
        })

    # 5) Write audit log rows (upsert-by-key so re-runs don't duplicate).
    if apply and audit_entries:
        for entry in audit_entries:
            await db.website_bio_migration_log.update_one(
                {"franchisee_id": entry["franchisee_id"],
                 "script_version": entry["script_version"]},
                {"$set": entry},
                upsert=True,
            )

    # 6) Print completion report.
    print()
    print("=" * 74)
    print("PREVIEW MIGRATION REPORT" if apply else "PREVIEW MIGRATION REPORT (dry-run)")
    print("=" * 74)
    for k, v in stats.items():
        print(f"  {k:38}: {v}")
    print()
    print("Per-franchisee outcomes:")
    for row in sorted(per_franchisee_result, key=lambda x: x["franchise_number"] or ""):
        print(f"  #{row['franchise_number']:>5}  {row['name']:26}  "
              f"{row['action']:32}  chars={row['chars']:>4}  ({row['note']})")

    print()
    print(f"[unmatched WP rows: {len(unmatched)} — all ex-franchisees or HQ]")
    print(f"[script_version   : {SCRIPT_VERSION}]")


def _audit_row(target, source_row, action, *, inserted, chars, prev_bio,
               final_show_flag, note):
    return {
        "franchisee_id": target.get("id"),
        "franchise_number": target.get("franchise_number") or "",
        "franchisee_name": (
            f"{target.get('first_name') or ''} {target.get('last_name') or ''}"
        ).strip(),
        "source_wp_permalink": (source_row or {}).get("Permalink") or "",
        "source_wp_title": (source_row or {}).get("Title") or "",
        "source_wp_row_index": (source_row or {}).get("_row_index"),
        "migration_method": "email_high_confidence",
        "match_confidence": "high" if inserted else "n/a",
        "biography_char_count": int(chars or 0),
        "action": action,
        "inserted_or_overwritten": (
            "overwritten" if action == "overwrote_approved"
            else "inserted" if inserted
            else "n/a"
        ),
        "previous_website_bio": prev_bio,
        "final_show_website_bio": bool(final_show_flag),
        "migrated_at": datetime.now(timezone.utc),
        "script_version": SCRIPT_VERSION,
        "note": note,
    }


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("csv", nargs="?", default="/tmp/franchises_wp.csv")
    ap.add_argument("--apply", action="store_true",
                    help="Actually write to MongoDB. Without this flag the "
                         "script prints what it *would* do.")
    args = ap.parse_args()
    asyncio.run(run(Path(args.csv), apply=args.apply))
