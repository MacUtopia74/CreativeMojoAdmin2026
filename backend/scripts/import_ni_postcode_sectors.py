"""CLI wrapper around ``ni_polygon_importer`` so the same logic can
be run from a shell on local/dev:

    cd /app/backend && python scripts/import_ni_postcode_sectors.py

For production refreshes prefer the admin endpoint:
    POST /api/ni/polygons/import-doogal
(also driven by the "Refresh sector polygons" button on the NI
Definitions admin page).
"""
from __future__ import annotations

import os
import sys
import time
from pathlib import Path

import httpx
from pymongo import MongoClient, UpdateOne

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from ni_polygon_importer import (  # noqa: E402
    DOOGAL_KML_URL,
    _HEADERS,
    _build_docs_from_kml,
)

LOCAL_CACHE = Path("/tmp/doogal_postcode_sectors.kml")


def _download_kml() -> bytes:
    if LOCAL_CACHE.exists() and LOCAL_CACHE.stat().st_size > 1_000_000:
        print(f"Using cached {LOCAL_CACHE} ({LOCAL_CACHE.stat().st_size:,} bytes)")
        return LOCAL_CACHE.read_bytes()
    print(f"Downloading {DOOGAL_KML_URL} …")
    with httpx.Client(timeout=180.0, headers=_HEADERS, follow_redirects=True) as client:
        r = client.get(DOOGAL_KML_URL)
        r.raise_for_status()
    LOCAL_CACHE.write_bytes(r.content)
    print(f"  saved {len(r.content):,} bytes → {LOCAL_CACHE}")
    return r.content


def main(area_prefix: str = "BT") -> int:
    mongo_url = os.environ.get("MONGO_URL")
    db_name = os.environ.get("DB_NAME")
    if not mongo_url or not db_name:
        print("ERROR: MONGO_URL and DB_NAME must be set in env")
        return 1
    client = MongoClient(mongo_url)
    db = client[db_name]
    coll = db.postcode_sector_polygons

    raw = _download_kml()
    print("Parsing KML …")
    started = time.time()
    docs = _build_docs_from_kml(raw, area_prefix=area_prefix)
    if not docs:
        print(f"No {area_prefix} sectors found — schema may have changed.")
        return 2

    ops = [UpdateOne({"sector": d["sector"]}, {"$set": d}, upsert=True) for d in docs]
    written = 0
    BATCH = 200
    for i in range(0, len(ops), BATCH):
        coll.bulk_write(ops[i:i + BATCH], ordered=False)
        written += min(BATCH, len(ops) - i)
        print(f"  wrote {written}… ({time.time() - started:.1f}s)")

    purged = coll.delete_many({"source": "ni-voronoi-synthetic"}).deleted_count
    print(
        f"\nDone. Wrote {written} {area_prefix}* sectors (elapsed "
        f"{time.time() - started:.1f}s). Purged {purged} prior synthetic rows."
    )
    print(f"Collection total now: {coll.estimated_document_count():,}")
    return 0


if __name__ == "__main__":
    try:
        from dotenv import load_dotenv
        load_dotenv(ROOT / ".env")
    except Exception:
        pass
    sys.exit(main())
