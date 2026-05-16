"""Import GB postcode sector boundaries from GeoLytix shapefile into MongoDB.

Source: Edinburgh DataShare (GeoLytix 2012, OGL licence)
  https://datashare.ed.ac.uk/handle/10283/2597

Reads `/app/backend/data/GB_Postcodes/PostalSector.shp` (British National
Grid, EPSG:27700), reprojects every polygon to WGS84 (EPSG:4326), applies a
mild Douglas-Peucker simplification to keep payload size reasonable, and
writes into `postcode_sector_polygons` keyed by the Royal Mail sector
code (e.g. ``"AB10 1"``, ``"CO15 2"``).

Run once per Mongo install:
    cd /app/backend && python scripts/import_postcode_sectors.py
"""
from __future__ import annotations

import os
import sys
import time
from pathlib import Path

import shapefile
from pymongo import MongoClient, UpdateOne
from pyproj import Transformer
from shapely.geometry import Polygon, MultiPolygon, mapping, shape
from shapely.ops import transform as shp_transform

ROOT = Path(__file__).resolve().parent.parent
SHP = ROOT / "data" / "GB_Postcodes" / "PostalSector"

# Simplify tolerance in degrees. ~0.0003° ≈ 30 m at UK latitudes — barely
# visible at city zoom levels, cuts payload by ~70%.
SIMPLIFY_TOLERANCE = 0.0003

# pyproj transformer: OSGB36 BNG (EPSG:27700) → WGS84 (EPSG:4326)
_BNG_TO_WGS = Transformer.from_crs(27700, 4326, always_xy=True)


def _project(geom):
    return shp_transform(lambda x, y, z=None: _BNG_TO_WGS.transform(x, y), geom)


def _shape_to_polygon(s):
    """pyshp polygon shape → shapely Polygon/MultiPolygon. Splits parts."""
    parts = list(s.parts) + [len(s.points)]
    rings = [s.points[parts[i]:parts[i + 1]] for i in range(len(parts) - 1)]
    if not rings:
        return None
    if len(rings) == 1:
        return Polygon(rings[0])
    # Multiple rings — first is the outer ring of the first polygon, others
    # may be holes or separate outer rings. We treat them as separate polys
    # (good enough for sector polygons — there are no true holes).
    polys = [Polygon(r) for r in rings if len(r) >= 4]
    polys = [p for p in polys if p.is_valid and p.area > 0]
    if not polys:
        return None
    return MultiPolygon(polys) if len(polys) > 1 else polys[0]


def main() -> int:
    if not (ROOT / "data" / "GB_Postcodes" / "PostalSector.shp").exists():
        print(f"ERROR: shapefile missing at {SHP}.shp — run the download first.")
        return 1

    mongo_url = os.environ.get("MONGO_URL")
    db_name = os.environ.get("DB_NAME")
    if not mongo_url or not db_name:
        print("ERROR: MONGO_URL and DB_NAME must be set in env")
        return 1

    client = MongoClient(mongo_url)
    db = client[db_name]
    coll = db.postcode_sector_polygons

    reader = shapefile.Reader(str(SHP))
    total = len(reader)
    print(f"Reading {total} sector polygons from {SHP}.shp")

    started = time.time()
    batch: list[UpdateOne] = []
    written = 0
    skipped = 0

    for i in range(total):
        rec = reader.record(i).as_dict()
        sec = (rec.get("RMSect") or "").strip().upper()
        if not sec:
            skipped += 1
            continue
        # Normalise — the field already has a space (e.g. "AB10 1"). If it
        # ever doesn't, insert one between out-code and the sector digit.
        if " " not in sec and len(sec) >= 2 and sec[-1].isdigit():
            sec = f"{sec[:-1]} {sec[-1]}"
        shp_obj = reader.shape(i)
        try:
            geom = _shape_to_polygon(shp_obj)
            if geom is None:
                skipped += 1
                continue
            geom = _project(geom).simplify(SIMPLIFY_TOLERANCE, preserve_topology=True)
            if geom.is_empty:
                skipped += 1
                continue
            gj = mapping(geom)
            doc = {
                "sector": sec,
                "district": (rec.get("PostDist") or "").strip().upper(),
                "area": (rec.get("PostArea") or "").strip().upper(),
                "ref_postcode": (rec.get("RefPC") or "").strip().upper(),
                "locale": rec.get("Locale") or "",
                "sprawl": rec.get("Sprawl") or "",
                "postcode_count": int(rec.get("PCCnt") or 0),
                "geometry": gj,
            }
            batch.append(UpdateOne({"sector": sec}, {"$set": doc}, upsert=True))
            written += 1
        except Exception as exc:  # noqa: BLE001
            print(f"  skip {sec}: {exc}")
            skipped += 1

        if len(batch) >= 500:
            coll.bulk_write(batch, ordered=False)
            batch.clear()
            elapsed = time.time() - started
            rate = written / max(0.01, elapsed)
            print(f"  {written}/{total} ({rate:.1f}/s)…")

    if batch:
        coll.bulk_write(batch, ordered=False)

    # Indexes
    coll.create_index("sector", unique=True)
    coll.create_index("district")
    coll.create_index("area")
    # GeoJSON 2dsphere index for spatial queries (e.g. "what sector contains
    # this lat/lng?" — used by the public postcode-lookup embed).
    coll.create_index([("geometry", "2dsphere")])

    print(f"Done — wrote {written}, skipped {skipped} in {time.time() - started:.1f}s")
    print(f"Collection counts: {coll.estimated_document_count()}")
    return 0


if __name__ == "__main__":
    # Load .env if present (script run standalone)
    try:
        from dotenv import load_dotenv
        load_dotenv(ROOT / ".env")
    except Exception:
        pass
    sys.exit(main())
