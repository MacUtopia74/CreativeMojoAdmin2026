"""Build Voronoi polygons for every postcode sector.

UK does not openly publish postcode-sector polygon boundaries.
We approximate them by:
  1. Reading each sector's representative postcode centroid (lat/lng)
     from `postcodes_cache` (already populated by `geocode_sectors.py`).
  2. Computing a Voronoi tessellation in WGS-84 of all those points.
  3. Clipping each cell to a buffered UK bounding box so the cells
     do not extend to infinity at the coastline.
  4. Writing one GeoJSON `Polygon` per sector to `sector_geometries`.

Re-run any time `postcodes_cache` changes (e.g. after a CQC re-import).
"""
from __future__ import annotations
import asyncio
import os

import numpy as np
from dotenv import load_dotenv
from motor.motor_asyncio import AsyncIOMotorClient
from scipy.spatial import Voronoi
from shapely.geometry import Polygon, box, mapping


def voronoi_finite_polygons(vor: Voronoi, radius: float = 25.0):
    """Reconstruct infinite Voronoi regions into finite polygons.

    Based on a classic recipe — clips at a bounding box later.
    Returns list of region polygons (one per input point, indexed
    by `vor.point_region`).
    """
    new_regions = []
    new_vertices = vor.vertices.tolist()
    centre = vor.points.mean(axis=0)

    all_ridges: dict = {}
    for (p1, p2), (v1, v2) in zip(vor.ridge_points, vor.ridge_vertices):
        all_ridges.setdefault(p1, []).append((p2, v1, v2))
        all_ridges.setdefault(p2, []).append((p1, v1, v2))

    for p1, region_idx in enumerate(vor.point_region):
        vertices = vor.regions[region_idx]
        if all(v >= 0 for v in vertices):
            new_regions.append([tuple(vor.vertices[v]) for v in vertices])
            continue

        ridges = all_ridges.get(p1, [])
        finite = [v for v in vertices if v >= 0]
        new_region = [tuple(vor.vertices[v]) for v in finite]
        for p2, v1, v2 in ridges:
            if v2 < 0:
                v1, v2 = v2, v1
            if v1 >= 0:
                continue
            t = vor.points[p2] - vor.points[p1]
            t /= np.linalg.norm(t)
            n = np.array([-t[1], t[0]])
            midpoint = vor.points[[p1, p2]].mean(axis=0)
            direction = np.sign(np.dot(midpoint - centre, n)) * n
            far_point = vor.vertices[v2] + direction * radius
            new_region.append(tuple(far_point))
        # Sort vertices ccw around centroid
        if len(new_region) >= 3:
            arr = np.asarray(new_region)
            c = arr.mean(axis=0)
            angles = np.arctan2(arr[:, 1] - c[1], arr[:, 0] - c[0])
            order = np.argsort(angles)
            new_region = [tuple(arr[i]) for i in order]
        new_regions.append(new_region)
    return new_regions, new_vertices


async def main() -> None:
    load_dotenv("/app/backend/.env")
    client = AsyncIOMotorClient(os.environ["MONGO_URL"])
    db = client[os.environ["DB_NAME"]]

    # Pull one centroid per sector (geocode_sectors.py guarantees uniqueness)
    rows = await db.postcodes_cache.find(
        {"sector": {"$ne": None}, "latitude": {"$ne": None}, "longitude": {"$ne": None}},
        {"_id": 0, "sector": 1, "latitude": 1, "longitude": 1},
    ).to_list(20000)
    # Dedupe to one point per sector (some sectors may have multiple cached postcodes)
    by_sector: dict[str, tuple[float, float]] = {}
    for r in rows:
        if r["sector"] not in by_sector:
            by_sector[r["sector"]] = (r["longitude"], r["latitude"])
    sectors = list(by_sector.keys())
    pts = np.array([by_sector[s] for s in sectors])
    print(f"Building Voronoi for {len(sectors)} sectors…")

    vor = Voronoi(pts)
    regions, _ = voronoi_finite_polygons(vor)
    # Clip box covering UK + buffer (handles infinite cells along coasts)
    uk_box = box(-8.5, 49.5, 2.5, 61.0)

    written = 0
    coll = db.sector_geometries
    await coll.create_index("sector", unique=True)
    bulk = []
    from pymongo import UpdateOne
    for sector, region in zip(sectors, regions):
        if len(region) < 3:
            continue
        try:
            poly = Polygon(region)
            if not poly.is_valid:
                poly = poly.buffer(0)
            clipped = poly.intersection(uk_box)
            if clipped.is_empty:
                continue
            # Multi-polygon possible after clipping — take the largest part
            if clipped.geom_type == "MultiPolygon":
                clipped = max(clipped.geoms, key=lambda g: g.area)
            geom = mapping(clipped)
        except Exception:  # noqa: BLE001
            continue
        district = sector.split(" ")[0]
        bulk.append(UpdateOne(
            {"sector": sector},
            {"$set": {"sector": sector, "district": district, "geometry": geom}},
            upsert=True,
        ))
        if len(bulk) >= 500:
            await coll.bulk_write(bulk, ordered=False)
            written += len(bulk)
            print(f"  wrote {written}")
            bulk = []
    if bulk:
        await coll.bulk_write(bulk, ordered=False)
        written += len(bulk)
    print(f"Done. Total sector polygons stored: {written}")


if __name__ == "__main__":
    asyncio.run(main())
