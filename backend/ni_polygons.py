"""Generate approximate NI postcode sector polygons via Voronoi tessellation.

Northern Ireland's BT postcode sector polygons aren't published as open
data (LPS/Royal Mail license restricts them), so we synthesise them:

  1. Pull one representative postcode per unique sector from
     ``ni_care_services``.
  2. Resolve every postcode to lat/lng via postcodes.io's bulk endpoint
     (free, no auth, batched 100 at a time).
  3. Compute a Voronoi tessellation across all centroids.
  4. Clip every cell to a bounding box around NI so unbounded outer
     cells become finite usable polygons.
  5. Write each cell as a document in ``postcode_sector_polygons``
     matching the same schema used for England + Scotland.

The result is good enough for franchisee territory drawing: clicking
any BT sector toggles inclusion exactly like an English / Scottish
sector, and the polygon roughly tracks where the care services in that
sector are located. Pixel-perfect borders would need licensed LPS data
— deliberately out of scope.
"""
from __future__ import annotations

import logging
from typing import Optional

import httpx
import numpy as np
from scipy.spatial import Voronoi
from shapely.geometry import Polygon, box
from shapely.ops import unary_union  # noqa: F401  (reserved for future merging)

logger = logging.getLogger("creative-mojo-admin.ni-polygons")

# NI bounding box (rough): lng -8.2 → -5.4, lat 54.0 → 55.4.
# Slightly inflated so every cell has somewhere to clip against.
_NI_BBOX = box(-8.3, 53.95, -5.3, 55.45)

POSTCODES_IO_BULK = "https://api.postcodes.io/postcodes"
_HEADERS = {"User-Agent": "creative-mojo-admin/1.0"}


def _sector_of(postcode: str) -> Optional[str]:
    """``BT9 7AS`` → ``BT9 7`` (matches ``ni_routes.parse_sector`` output)."""
    import re
    m = re.match(r"^\s*([A-Z]{1,2}\d[A-Z\d]?)\s*(\d)", postcode.upper())
    return f"{m.group(1)} {m.group(2)}" if m else None


def _district_of(sector: str) -> Optional[str]:
    return sector.split(" ", 1)[0] if " " in sector else None


async def _resolve_centroids(postcodes: list[str]) -> dict[str, tuple[float, float]]:
    """Bulk-resolve postcodes → {postcode: (lng, lat)}. Skips any the
    API can't resolve. postcodes.io caps each batch at 100."""
    out: dict[str, tuple[float, float]] = {}
    async with httpx.AsyncClient(timeout=30.0, headers=_HEADERS) as client:
        for i in range(0, len(postcodes), 100):
            batch = postcodes[i:i + 100]
            r = await client.post(POSTCODES_IO_BULK, json={"postcodes": batch})
            r.raise_for_status()
            payload = r.json()
            for row in payload.get("result", []) or []:
                q = (row.get("query") or "").upper()
                res = row.get("result") or {}
                lng = res.get("longitude")
                lat = res.get("latitude")
                if lng is None or lat is None:
                    continue
                out[q] = (float(lng), float(lat))
    return out


async def _collect_sector_anchors(db) -> dict[str, str]:
    """Pick one representative postcode per BT sector from
    ``ni_care_services``. Returns ``{sector: postcode}``.

    The choice is deterministic — the first row Mongo returns per
    sector — so the polygon set is stable across runs."""
    anchors: dict[str, str] = {}
    cur = db.ni_care_services.find(
        {"postcode_sector": {"$regex": "^BT"}},
        {"_id": 0, "postcode_sector": 1, "postalCode": 1},
    )
    async for r in cur:
        sec = r.get("postcode_sector")
        pc = (r.get("postalCode") or "").upper()
        if not sec or not pc or sec in anchors:
            continue
        anchors[sec] = pc
    return anchors


def _voronoi_polygons(points: list[tuple[float, float]]) -> list[Polygon]:
    """Build clipped Voronoi cells for each point.

    Returns a list aligned to the input order: ``out[i]`` is the cell
    containing ``points[i]``. Empty (degenerate) cells become None.
    """
    if len(points) < 3:
        # Voronoi needs ≥3 points to define cells. With 1–2 points we
        # just draw a circle around each one.
        return [_NI_BBOX.intersection(Polygon([
            (lng - 0.05, lat - 0.04),
            (lng + 0.05, lat - 0.04),
            (lng + 0.05, lat + 0.04),
            (lng - 0.05, lat + 0.04),
        ])) for (lng, lat) in points]

    arr = np.array(points)
    # Add 4 distant sentinel points so every "real" cell is finite —
    # outer-cell ridges go off to infinity otherwise.
    sentinels = np.array([[-50, -50], [50, -50], [50, 50], [-50, 50]])
    extended = np.vstack([arr, sentinels])
    vor = Voronoi(extended)

    out: list[Optional[Polygon]] = []
    for idx in range(len(points)):  # ignore sentinel cells
        region_idx = vor.point_region[idx]
        verts = vor.regions[region_idx]
        if not verts or -1 in verts:
            out.append(None)
            continue
        coords = [tuple(vor.vertices[v]) for v in verts]
        try:
            poly = Polygon(coords)
            if not poly.is_valid:
                poly = poly.buffer(0)
            clipped = poly.intersection(_NI_BBOX)
            if clipped.is_empty:
                out.append(None)
                continue
            # Voronoi can produce MultiPolygon after clipping — keep the
            # piece containing the anchor point.
            if clipped.geom_type == "MultiPolygon":
                from shapely.geometry import Point
                pt = Point(points[idx])
                pieces = [g for g in clipped.geoms]
                pieces.sort(key=lambda g: 0 if g.contains(pt) else 1)
                clipped = pieces[0]
            out.append(clipped)
        except Exception as e:  # pragma: no cover — defensive
            logger.warning("Voronoi cell %d failed: %s", idx, e)
            out.append(None)
    return out


def _polygon_to_geojson(poly: Polygon) -> dict:
    """Shapely polygon → GeoJSON Polygon dict matching the existing
    sector polygons stored in Mongo."""
    if poly.geom_type != "Polygon":
        # If somehow we still have a MultiPolygon at this point, pick
        # the largest ring — territory drawing tolerates a single ring.
        if poly.geom_type == "MultiPolygon":
            poly = max(poly.geoms, key=lambda g: g.area)
        else:
            raise ValueError(f"Unsupported geometry: {poly.geom_type}")
    # Round to 5dp (~1.1m) — same precision as the stored ONS data.
    ring = [[round(x, 5), round(y, 5)] for x, y in poly.exterior.coords]
    return {"type": "Polygon", "coordinates": [ring]}


async def generate_ni_sector_polygons(db) -> dict:
    """End-to-end generator. Returns counts for the route to surface.

    Idempotent: drops every existing BT-prefixed polygon before
    inserting the fresh set, so running this monthly after each XLSX
    refresh picks up any new sectors that appeared in the latest data.
    """
    anchors = await _collect_sector_anchors(db)
    if not anchors:
        return {"sectors": 0, "polygons": 0, "missing": 0, "note": "No BT sectors found in ni_care_services."}
    postcodes = list(anchors.values())
    centroids = await _resolve_centroids(postcodes)

    sector_points: list[tuple[str, tuple[float, float]]] = []
    missing: list[str] = []
    for sec, pc in anchors.items():
        coord = centroids.get(pc.upper())
        if coord is None:
            missing.append(sec)
            continue
        sector_points.append((sec, coord))

    if not sector_points:
        return {"sectors": len(anchors), "polygons": 0, "missing": len(missing),
                "note": "postcodes.io could not resolve any BT postcodes."}

    points = [p for _, p in sector_points]
    cells = _voronoi_polygons(points)

    # Replace any existing BT polygons in a single atomic batch.
    await db.postcode_sector_polygons.delete_many({"sector": {"$regex": "^BT"}})

    docs = []
    for (sector, (lng, lat)), cell in zip(sector_points, cells):
        if cell is None or cell.is_empty:
            missing.append(sector)
            continue
        district = _district_of(sector) or sector
        docs.append({
            "sector": sector,
            "area": "BT",
            "district": district,
            "geometry": _polygon_to_geojson(cell),
            "locale": None,                         # not derivable without LPS data
            "postcode_count": None,                  # unknown — anchor only
            "ref_postcode": anchors[sector].replace(" ", ""),
            "sprawl": "Northern Ireland",
            "source": "ni-voronoi-synthetic",
            "centroid": [round(lng, 6), round(lat, 6)],
        })
    if docs:
        # MongoDB ``insert_many`` is plenty fast for ~250 docs. The
        # ``sector`` unique index already exists on the collection.
        await db.postcode_sector_polygons.insert_many(docs)
    return {
        "sectors": len(anchors),
        "polygons": len(docs),
        "missing": len(missing),
        "missing_sectors": missing[:25],
    }
