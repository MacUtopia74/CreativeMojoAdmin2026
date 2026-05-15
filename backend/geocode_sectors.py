"""One-off bulk geocoder for every distinct CQC postcode sector.

Picks one sample postcode per sector, batches in groups of 100 to
postcodes.io's bulk endpoint, and caches results in `postcodes_cache`.
Once this runs, the territory `sectors-near` endpoint is instant.
"""
from __future__ import annotations
import asyncio
import os
from datetime import datetime, timezone

import httpx
from dotenv import load_dotenv
from motor.motor_asyncio import AsyncIOMotorClient

POSTCODES_IO_BULK = "https://api.postcodes.io/postcodes"
BATCH = 100


async def main() -> None:
    load_dotenv("/app/backend/.env")
    client = AsyncIOMotorClient(os.environ["MONGO_URL"])
    db = client[os.environ["DB_NAME"]]
    # Distinct sectors with at least one sample postcode
    rows = await db.cqc_locations.aggregate([
        {"$match": {"postcode_sector": {"$ne": None}}},
        {"$group": {
            "_id": "$postcode_sector",
            "sample_postcode": {"$first": "$postcode"},
            "district": {"$first": "$postcode_district"},
        }},
    ]).to_list(20000)
    print(f"Distinct sectors: {len(rows)}")
    already = await db.postcodes_cache.distinct("sector")
    cached_set = set(already)
    todo = [r for r in rows if r["_id"] not in cached_set and r.get("sample_postcode")]
    print(f"Already cached: {len(cached_set)}  · to geocode: {len(todo)}")
    async with httpx.AsyncClient(timeout=20.0) as http:
        for i in range(0, len(todo), BATCH):
            chunk = todo[i:i + BATCH]
            payload = {"postcodes": [r["sample_postcode"] for r in chunk]}
            try:
                r = await http.post(POSTCODES_IO_BULK, json=payload)
                r.raise_for_status()
                for raw_row, res in zip(chunk, r.json().get("result", [])):
                    info = res.get("result") if res else None
                    if not info:
                        continue
                    pc = info.get("postcode") or raw_row["sample_postcode"]
                    sec = raw_row["_id"]
                    await db.postcodes_cache.update_one(
                        {"_id": pc},
                        {"$set": {
                            "_id": pc,
                            "postcode": pc,
                            "sector": sec,
                            "district": raw_row.get("district") or sec.split(" ")[0],
                            "latitude": info.get("latitude"),
                            "longitude": info.get("longitude"),
                            "admin_district": info.get("admin_district"),
                            "region": info.get("region"),
                            "country": info.get("country"),
                            "cached_at": datetime.now(timezone.utc),
                        }},
                        upsert=True,
                    )
            except Exception as exc:  # noqa: BLE001
                print(f"  batch {i // BATCH} failed: {exc}")
            done = min(i + BATCH, len(todo))
            print(f"  geocoded {done}/{len(todo)}")
    # Ensure indexes for fast bbox queries
    await db.postcodes_cache.create_index([("latitude", 1), ("longitude", 1)])
    await db.postcodes_cache.create_index("sector")
    total = await db.postcodes_cache.count_documents({})
    print(f"Done. postcodes_cache size = {total}")


if __name__ == "__main__":
    asyncio.run(main())
