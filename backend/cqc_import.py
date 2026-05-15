"""One-off importer for the CQC spreadsheet.

  • Reads /app/_uploads/cqc.xlsx
  • Derives `postcode_sector` (e.g. "EX15 1NB" → "EX15 1") and
    `postcode_district` ("EX15") for every row
  • Upserts to `cqc_locations` keyed by CQC Location ID

Usage:
    python -m cqc_import /app/_uploads/cqc.xlsx
"""
from __future__ import annotations
import asyncio
import os
import re
import sys
from typing import Optional

import pandas as pd
from dotenv import load_dotenv
from motor.motor_asyncio import AsyncIOMotorClient

# UK postcodes: outward = 2-4 chars, then space, then inward = 3 chars.
# Sector = outward + first char of inward. District = outward.
_POSTCODE_RE = re.compile(r"^\s*([A-Z]{1,2}\d[A-Z\d]?)\s*(\d)([A-Z]{2})\s*$", re.I)


def parse_postcode(raw: Optional[str]) -> tuple[Optional[str], Optional[str], Optional[str]]:
    """Return (normalised_full, sector, district) or (None, None, None)."""
    if not raw or not isinstance(raw, str):
        return None, None, None
    m = _POSTCODE_RE.match(raw.upper())
    if not m:
        return None, None, None
    out, sec_digit, unit = m.group(1), m.group(2), m.group(3)
    full = f"{out} {sec_digit}{unit}"
    sector = f"{out} {sec_digit}"
    return full, sector, out


async def main(path: str) -> None:
    load_dotenv("/app/backend/.env")
    df = pd.read_excel(path)
    print(f"Loaded {len(df)} rows from {path}")
    client = AsyncIOMotorClient(os.environ["MONGO_URL"])
    db = client[os.environ["DB_NAME"]]
    coll = db.cqc_locations
    await coll.create_index("location_id", unique=True)
    await coll.create_index("postcode_sector")
    await coll.create_index("postcode_district")
    await coll.create_index("service_types")

    bulk: list = []
    skipped = 0
    for _, row in df.iterrows():
        loc_id = str(row.get("CQC Location ID (for office use only)") or "").strip()
        if not loc_id:
            skipped += 1
            continue
        pc_raw = str(row.get("Postcode") or "").strip()
        full, sector, district = parse_postcode(pc_raw)
        services = str(row.get("Service types") or "")
        specialisms = str(row.get("Specialisms/services") or "")
        doc = {
            "location_id": loc_id,
            "provider_id": str(row.get("CQC Provider ID (for office use only)") or ""),
            "name": str(row.get("Name") or "").strip(),
            "address": str(row.get("Address") or "").strip(),
            "postcode": full or pc_raw,
            "postcode_sector": sector,
            "postcode_district": district,
            "phone": str(row.get("Phone number") or "").strip(),
            "website": str(row.get("Service's website (if available)") or "").strip() or None,
            "service_types": [s.strip() for s in services.split("|") if s.strip()] if "|" in services else ([services] if services else []),
            "specialisms": [s.strip() for s in specialisms.split("|") if s.strip()] if specialisms else [],
            "provider_name": str(row.get("Provider name") or "").strip(),
            "local_authority": str(row.get("Local authority") or "").strip(),
            "region": str(row.get("Region") or "").strip(),
            "location_url": str(row.get("Location URL") or "").strip(),
            "last_check": str(row.get("Date of latest check") or "").strip(),
            "imported_at": "2026-05-15T00:00:00Z",
        }
        bulk.append(doc)
        if len(bulk) >= 500:
            await _flush(coll, bulk)
            bulk = []
    if bulk:
        await _flush(coll, bulk)
    total = await coll.count_documents({})
    by_district = await coll.aggregate([
        {"$group": {"_id": "$postcode_district", "n": {"$sum": 1}}},
        {"$sort": {"n": -1}},
        {"$limit": 5},
    ]).to_list(5)
    print(f"Done. skipped={skipped}  total in cqc_locations={total}")
    print("Top districts:", by_district)


async def _flush(coll, bulk: list) -> None:
    from pymongo import UpdateOne
    ops = [UpdateOne({"location_id": d["location_id"]}, {"$set": d}, upsert=True) for d in bulk]
    res = await coll.bulk_write(ops, ordered=False)
    print(f"  wrote: matched={res.matched_count} upserted={res.upserted_count}")


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1] if len(sys.argv) > 1 else "/app/_uploads/cqc.xlsx"))
