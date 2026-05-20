"""One-shot migration: re-categorise contact sources.

Background
----------
The original Airtable migration lumped almost all `web_form_contacts` into
``source='franchise_enquiry'`` regardless of the user's actual "Reason for
contacting". That's why care-home and art-kit enquiries were buried in the
Franchise list. The reason text was preserved in `why_contacting`
(legacy / Airtable) and `reason_for_contacting` (Form 1) so we can recover
the right category from existing data.

Run once:
    python -m backend.migrations.20260520_recategorise_sources

Idempotent — safe to re-run.
"""
import asyncio
import os
from datetime import datetime, timezone

from motor.motor_asyncio import AsyncIOMotorClient
from dotenv import load_dotenv

load_dotenv("/app/backend/.env")

PIPELINE_SOURCES = {"franchise_enquiry", "licence_enquiry"}


def classify_source(reason: str | None, why: str | None, current: str | None) -> str:
    val = (reason or why or "").strip().lower()
    if "care home" in val:
        return "care_home_enquiry"
    if "art kit" in val or "deliverable art" in val:
        return "art_kit_enquiry"
    if val == "other":
        return "general_enquiry"
    if "franchise" in val:
        return "franchise_enquiry"
    if "licence" in val or "license" in val:
        return "licence_enquiry"
    return current or "general_enquiry"


async def main(dry_run: bool = False) -> None:
    client = AsyncIOMotorClient(os.environ["MONGO_URL"])
    db = client[os.environ["DB_NAME"]]
    now = datetime.now(timezone.utc).isoformat()

    cur = db.web_form_contacts.find(
        {},
        {
            "_id": 0, "id": 1, "source": 1, "in_pipeline": 1, "pipeline_status": 1,
            "why_contacting": 1, "reason_for_contacting": 1,
        },
    )
    source_updates: dict[str, dict] = {}
    moves: dict[tuple[str, str], int] = {}
    pipe_off_count = 0
    pipe_off_ids: list[str] = []

    async for d in cur:
        cur_src = d.get("source") or "general_enquiry"
        new_src = classify_source(d.get("reason_for_contacting"), d.get("why_contacting"), cur_src)
        key = (cur_src, new_src)
        moves[key] = moves.get(key, 0) + 1
        upd: dict = {}
        if new_src != cur_src:
            upd["source"] = new_src
        if d.get("in_pipeline") and new_src not in PIPELINE_SOURCES:
            upd["in_pipeline"] = False
            upd["pipeline_status"] = None
            pipe_off_count += 1
            pipe_off_ids.append(d["id"])
        if upd:
            upd["updated_at"] = now
            upd["recategorised_at"] = now
            source_updates[d["id"]] = upd

    print("=== Re-categorisation plan ===")
    for (frm, to), n in sorted(moves.items(), key=lambda x: -x[1]):
        tag = "" if frm == to else "  [CHANGE]"
        print(f"  {frm:25s} → {to:25s} → {n}{tag}")
    print(f"\nin_pipeline=False forced on {pipe_off_count} records.")
    print(f"Total docs to update: {len(source_updates)}\n")

    if dry_run:
        print("DRY RUN — nothing written.")
        return

    written = 0
    for cid, upd in source_updates.items():
        await db.web_form_contacts.update_one({"id": cid}, {"$set": upd})
        written += 1
    print(f"WROTE {written} updates to web_form_contacts.")


if __name__ == "__main__":
    import sys
    asyncio.run(main(dry_run="--dry-run" in sys.argv))
