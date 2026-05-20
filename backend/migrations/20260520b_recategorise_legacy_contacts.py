"""Phase 2 of contact re-categorisation — same logic as the May 20 run, but
extended to the legacy ``contacts`` collection (the 5,954 records from
Airtable's "Contacts" table). Many of those have an explicit "Care home
class enquiry" / "Deliverable Art Kit Enquiry" / "Franchise enquiry" value
in ``why_contacting`` but were left with the generic ``legacy_general_enquiry``
source after the original Airtable migration.

After this run, the tab handlers for franchise/licence/care_home/art_kit
also surface matching legacy contacts so cross-collection dupes (e.g.
Caroline Simm) appear in the correct category, not just under "General".
"""
import asyncio
import os
from datetime import datetime, timezone

from motor.motor_asyncio import AsyncIOMotorClient
from dotenv import load_dotenv

load_dotenv("/app/backend/.env")

PIPELINE_SOURCES = {"franchise_enquiry", "licence_enquiry"}


def _value_text(v) -> str:
    """Airtable multi-select columns sometimes arrive as a JSON list or a
    semicolon-joined string. Flatten to one lowercase string for matching."""
    if v is None:
        return ""
    if isinstance(v, list):
        return " ".join(str(x) for x in v).lower()
    return str(v).lower()


def classify_source(reason, why, current):
    val = (_value_text(reason) + " " + _value_text(why)).strip()
    if "care home" in val:
        return "care_home_enquiry"
    if "art kit" in val or "deliverable art" in val:
        return "art_kit_enquiry"
    if "franchise" in val:
        return "franchise_enquiry"
    if "licence" in val or "license" in val:
        return "licence_enquiry"
    if val.strip() == "other":
        return "general_enquiry"
    return current or "legacy_general_enquiry"


async def main(dry_run: bool = False) -> None:
    client = AsyncIOMotorClient(os.environ["MONGO_URL"])
    db = client[os.environ["DB_NAME"]]
    now = datetime.now(timezone.utc).isoformat()

    moves: dict[tuple[str, str], int] = {}
    updates: dict[str, dict] = {}

    cur = db.contacts.find(
        {},
        {"_id": 0, "id": 1, "source": 1, "why_contacting": 1, "reason_for_contacting": 1},
    )
    async for d in cur:
        cur_src = d.get("source") or "legacy_general_enquiry"
        new_src = classify_source(d.get("reason_for_contacting"), d.get("why_contacting"), cur_src)
        key = (cur_src, new_src)
        moves[key] = moves.get(key, 0) + 1
        if new_src != cur_src:
            updates[d["id"]] = {"source": new_src, "updated_at": now, "recategorised_at": now}

    print("=== Legacy contacts re-categorisation plan ===")
    for (frm, to), n in sorted(moves.items(), key=lambda x: -x[1]):
        tag = "" if frm == to else "  [CHANGE]"
        print(f"  {frm:30s} → {to:25s} → {n}{tag}")
    print(f"\nTotal legacy docs to update: {len(updates)}\n")

    if dry_run:
        print("DRY RUN — nothing written.")
        return

    written = 0
    for cid, upd in updates.items():
        await db.contacts.update_one({"id": cid}, {"$set": upd})
        written += 1
    print(f"WROTE {written} updates to contacts (legacy) collection.")


if __name__ == "__main__":
    import sys
    asyncio.run(main(dry_run="--dry-run" in sys.argv))
