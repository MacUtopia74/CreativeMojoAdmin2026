"""One-off: copy each franchisee's postcode sectors from the
legacy `territories` collection (imported from Airtable) into
`franchisees.territory_sectors`, plus compute home counts.
Safe to re-run."""
import asyncio
import os
from datetime import datetime, timezone

from dotenv import load_dotenv
from motor.motor_asyncio import AsyncIOMotorClient


async def main() -> None:
    load_dotenv("/app/backend/.env")
    client = AsyncIOMotorClient(os.environ["MONGO_URL"])
    db = client[os.environ["DB_NAME"]]

    # Group territories by franchisee
    pipeline = [
        {"$group": {"_id": "$franchisee_id", "sectors": {"$addToSet": "$postcode"}}},
    ]
    grouped = await db.territories.aggregate(pipeline).to_list(1000)
    print(f"Found {len(grouped)} franchisees with legacy territory data")
    updated = 0
    skipped_existing = 0
    for row in grouped:
        fid = row["_id"]
        if not fid:
            continue
        sectors = sorted({s.strip().upper() for s in (row.get("sectors") or []) if s and s.strip()})
        if not sectors:
            continue
        # Don't clobber a hand-locked territory unless it's empty
        current = await db.franchisees.find_one({"id": fid}, {"_id": 0, "territory_sectors": 1, "organisation": 1})
        if not current:
            continue
        if current.get("territory_sectors"):
            skipped_existing += 1
            continue
        homes = await db.cqc_locations.count_documents({"postcode_sector": {"$in": sectors}})
        await db.franchisees.update_one(
            {"id": fid},
            {"$set": {
                "territory_sectors": sectors,
                "territory_home_count": homes,
                "territory_updated_at": datetime.now(timezone.utc),
                "territory_updated_by": "legacy-import",
            }},
        )
        updated += 1
        print(f"  {current.get('organisation','?')[:50]:50s}  {len(sectors)} sectors  {homes} homes")
    print(f"\nDone. Updated: {updated}.  Skipped (already had territory): {skipped_existing}.")


if __name__ == "__main__":
    asyncio.run(main())
