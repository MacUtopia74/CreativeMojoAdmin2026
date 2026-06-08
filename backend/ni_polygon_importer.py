"""In-process Doogal KML → ``postcode_sector_polygons`` importer.

Used by both the CLI script (``scripts/import_ni_postcode_sectors.py``)
and the admin HTTP endpoint (``POST /api/ni/polygons/import-doogal``)
so production can refresh BT polygons without shell access.

Why a separate module: the CLI uses ``pymongo`` (sync) while the FastAPI
endpoint uses ``motor`` (async). The KML parsing is the expensive part
and is identical for both — we share that, and let each caller persist
through its own client.
"""
from __future__ import annotations

import re
import time
from typing import Optional
from xml.etree import ElementTree as ET

import httpx
from shapely.geometry import MultiPolygon, Polygon, mapping
from shapely.ops import unary_union

DOOGAL_KML_URL = "https://www.doogal.co.uk/kml/PostcodeSectors.kml"
KML_NS = {"kml": "http://www.opengis.net/kml/2.2"}
KML_NS_URI = "http://www.opengis.net/kml/2.2"
SIMPLIFY_TOLERANCE = 0.0003  # matches the GB GeoLytix importer

_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (compatible; CreativeMojo-Admin/1.0; "
        "+https://hub.creativemojo.co.uk)"
    ),
}


def _parse_polygon_ring(coords_text: str) -> list[tuple[float, float]]:
    pts: list[tuple[float, float]] = []
    for tok in coords_text.split():
        parts = tok.split(",")
        if len(parts) >= 2:
            try:
                pts.append((float(parts[0]), float(parts[1])))
            except ValueError:
                continue
    return pts


def _placemark_to_geometry(placemark) -> Optional[Polygon | MultiPolygon]:
    polys: list[Polygon] = []
    for poly_el in placemark.findall(".//kml:Polygon", KML_NS):
        outer = poly_el.find(".//kml:outerBoundaryIs/kml:LinearRing/kml:coordinates", KML_NS)
        if outer is None or not outer.text:
            continue
        ring = _parse_polygon_ring(outer.text)
        if len(ring) < 4:
            continue
        inners: list[list[tuple[float, float]]] = []
        for inner_el in poly_el.findall(".//kml:innerBoundaryIs/kml:LinearRing/kml:coordinates", KML_NS):
            if inner_el.text:
                hole = _parse_polygon_ring(inner_el.text)
                if len(hole) >= 4:
                    inners.append(hole)
        try:
            poly = Polygon(ring, inners) if inners else Polygon(ring)
            if not poly.is_valid:
                poly = poly.buffer(0)
            if poly.is_empty:
                continue
            polys.append(poly)
        except Exception:  # noqa: BLE001
            continue
    if not polys:
        return None
    if len(polys) == 1:
        return polys[0]
    try:
        union = unary_union(polys)
        return union if not union.is_empty else None
    except Exception:
        return MultiPolygon(polys)


def _normalise_sector(raw: str) -> Optional[str]:
    if not raw:
        return None
    s = re.sub(r"\s+", "", raw.upper())
    m = re.match(r"^([A-Z]{1,2}\d[A-Z\d]?)(\d)$", s)
    if not m:
        return None
    return f"{m.group(1)} {m.group(2)}"


def _build_docs_from_kml(raw_kml: bytes, area_prefix: str = "BT") -> list[dict]:
    """Parse the KML and return a list of upsert-ready Mongo documents
    matching the existing ``postcode_sector_polygons`` schema."""
    root = ET.fromstring(raw_kml)
    docs: list[dict] = []
    seen: set[str] = set()
    for placemark in root.iter(f"{{{KML_NS_URI}}}Placemark"):
        name_el = placemark.find("kml:name", KML_NS)
        if name_el is None or not name_el.text:
            continue
        raw_name = name_el.text.strip()
        if not raw_name.upper().startswith(area_prefix.upper()):
            continue
        sector = _normalise_sector(raw_name)
        if not sector or sector in seen:
            continue
        seen.add(sector)
        geom = _placemark_to_geometry(placemark)
        if geom is None:
            continue
        try:
            simplified = geom.simplify(SIMPLIFY_TOLERANCE, preserve_topology=True)
            if simplified.is_empty:
                continue
            gj = mapping(simplified)
        except Exception:  # noqa: BLE001
            continue
        district = sector.split(" ", 1)[0] if " " in sector else sector
        area_match = re.match(r"^[A-Z]+", district)
        area = area_match.group(0) if area_match else ""
        docs.append({
            "sector": sector,
            "district": district,
            "area": area,
            "geometry": gj,
            "locale": "",
            "sprawl": "Northern Ireland" if area == "BT" else "",
            "source": "doogal-postcodesectors-kml",
        })
    return docs


async def fetch_doogal_kml() -> bytes:
    """Async download — used by the HTTP endpoint."""
    async with httpx.AsyncClient(timeout=180.0, headers=_HEADERS, follow_redirects=True) as client:
        r = await client.get(DOOGAL_KML_URL)
        r.raise_for_status()
        return r.content


async def import_ni_polygons_async(db, area_prefix: str = "BT") -> dict:
    """End-to-end async import for use inside FastAPI: download → parse
    → upsert → purge legacy synthetic rows. Returns a summary dict.

    Idempotent — upserts by ``sector`` so re-running just refreshes
    geometry; the GB rows are untouched (different prefixes).
    """
    started = time.time()
    raw = await fetch_doogal_kml()
    download_ms = int((time.time() - started) * 1000)

    docs = _build_docs_from_kml(raw, area_prefix=area_prefix)
    if not docs:
        return {
            "ok": False,
            "written": 0,
            "purged": 0,
            "download_ms": download_ms,
            "note": f"No {area_prefix} sectors found in the Doogal KML — schema may have changed.",
        }

    # Upsert in chunks; motor doesn't expose bulk_write with the same
    # signature as pymongo's, but it does support ``ordered=False`` via
    # ``UpdateOne`` lists.
    from pymongo import UpdateOne
    coll = db.postcode_sector_polygons
    BATCH = 200
    written = 0
    ops: list = []
    for doc in docs:
        ops.append(UpdateOne({"sector": doc["sector"]}, {"$set": doc}, upsert=True))
        if len(ops) >= BATCH:
            await coll.bulk_write(ops, ordered=False)
            written += len(ops)
            ops = []
    if ops:
        await coll.bulk_write(ops, ordered=False)
        written += len(ops)

    purged = (await coll.delete_many({"source": "ni-voronoi-synthetic"})).deleted_count
    return {
        "ok": True,
        "written": written,
        "purged": purged,
        "download_ms": download_ms,
        "elapsed_ms": int((time.time() - started) * 1000),
        "source": "doogal-postcodesectors-kml",
        "area": area_prefix,
    }
