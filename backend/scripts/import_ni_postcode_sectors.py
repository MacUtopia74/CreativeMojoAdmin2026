"""Import Northern Ireland (BT) postcode sector polygons from Doogal's
whole-UK KML into the same ``postcode_sector_polygons`` collection used
by the GeoLytix 2012 GB shapefile importer.

Source: https://www.doogal.co.uk/kml/PostcodeSectors.kml
  Doogal's UK postcode sector polygons (Chris Bell, free / OGL-derived).
  This is the only freely redistributable dataset covering BT codes
  with proper sector-level geometry — methodologically equivalent to
  the GeoLytix file used for GB (both build sectors from postcode unit
  centroids), so a BT row imported here is shape-for-shape compatible
  with an EX or AB row already in the collection.

Run once:
    cd /app/backend && python scripts/import_ni_postcode_sectors.py

Idempotent — uses ``UpdateOne(upsert=True)`` keyed on the sector code,
so re-running just refreshes the BT geometry without touching GB rows.
The import script also deletes any prior synthetic Voronoi rows tagged
``source: ni-voronoi-synthetic`` so they don't shadow the real polygons.
"""
from __future__ import annotations

import os
import re
import sys
import time
from pathlib import Path
from xml.etree import ElementTree as ET

import httpx
from pymongo import MongoClient, UpdateOne
from shapely.geometry import Polygon, MultiPolygon, mapping
from shapely.ops import unary_union

ROOT = Path(__file__).resolve().parent.parent

DOOGAL_KML_URL = "https://www.doogal.co.uk/kml/PostcodeSectors.kml"
KML_NS = {"kml": "http://www.opengis.net/kml/2.2"}
_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (compatible; CreativeMojo-Admin/1.0; "
        "+https://hub.creativemojo.co.uk)"
    ),
}

# Match the existing GB simplification tolerance so render quality is uniform.
SIMPLIFY_TOLERANCE = 0.0003

# Cache the file once locally so a re-run doesn't re-download 50MB.
LOCAL_CACHE = Path("/tmp/doogal_postcode_sectors.kml")


def _download_kml() -> bytes:
    if LOCAL_CACHE.exists() and LOCAL_CACHE.stat().st_size > 1_000_000:
        print(f"Using cached {LOCAL_CACHE} ({LOCAL_CACHE.stat().st_size:,} bytes)")
        return LOCAL_CACHE.read_bytes()
    print(f"Downloading {DOOGAL_KML_URL} …")
    with httpx.Client(timeout=120.0, headers=_HEADERS, follow_redirects=True) as client:
        r = client.get(DOOGAL_KML_URL)
        r.raise_for_status()
    LOCAL_CACHE.write_bytes(r.content)
    print(f"  saved {len(r.content):,} bytes → {LOCAL_CACHE}")
    return r.content


def _parse_polygon_ring(coords_text: str) -> list[tuple[float, float]]:
    """KML ``<coordinates>`` text → list of (lng, lat) tuples.

    KML stores ``lng,lat[,alt]`` whitespace-separated. We drop altitude
    since the polygons are 2D."""
    pts: list[tuple[float, float]] = []
    for tok in coords_text.split():
        parts = tok.split(",")
        if len(parts) >= 2:
            try:
                pts.append((float(parts[0]), float(parts[1])))
            except ValueError:
                continue
    return pts


def _placemark_to_geometry(placemark) -> Polygon | MultiPolygon | None:
    """Walk every ``<Polygon><outerBoundaryIs><LinearRing><coordinates>``
    descendant of a ``<Placemark>`` and union them. Doogal stores each
    sector as a ``<MultiGeometry>`` of multiple ``<Polygon>`` parts
    (the sector can have disjoint pieces — e.g. islands)."""
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
        except Exception as e:  # noqa: BLE001
            print(f"  bad poly: {e}")
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


def _normalise_sector(raw: str) -> str | None:
    if not raw:
        return None
    s = re.sub(r"\s+", "", raw.upper())
    m = re.match(r"^([A-Z]{1,2}\d[A-Z\d]?)(\d)$", s)
    if not m:
        return None
    return f"{m.group(1)} {m.group(2)}"


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
    root = ET.fromstring(raw)

    batch: list[UpdateOne] = []
    written = 0
    skipped = 0
    seen_sectors: set[str] = set()

    for placemark in root.iter("{http://www.opengis.net/kml/2.2}Placemark"):
        name_el = placemark.find("kml:name", KML_NS)
        if name_el is None or not name_el.text:
            skipped += 1
            continue
        raw_name = name_el.text.strip()
        if not raw_name.upper().startswith(area_prefix.upper()):
            continue
        sector = _normalise_sector(raw_name)
        if not sector:
            skipped += 1
            continue
        # Some KMLs accidentally include duplicate placemarks per sector
        # (e.g. a folder grouping). Keep the first one we see.
        if sector in seen_sectors:
            continue
        seen_sectors.add(sector)
        geom = _placemark_to_geometry(placemark)
        if geom is None:
            skipped += 1
            continue
        try:
            simplified = geom.simplify(SIMPLIFY_TOLERANCE, preserve_topology=True)
            if simplified.is_empty:
                skipped += 1
                continue
            gj = mapping(simplified)
        except Exception as e:  # noqa: BLE001
            print(f"  skip {sector}: {e}")
            skipped += 1
            continue

        district = sector.split(" ", 1)[0] if " " in sector else sector
        area = re.match(r"^[A-Z]+", district).group(0) if district else ""
        doc = {
            "sector": sector,
            "district": district,
            "area": area,
            "geometry": gj,
            "locale": "",
            "sprawl": "Northern Ireland" if area == "BT" else "",
            "source": "doogal-postcodesectors-kml",
        }
        batch.append(UpdateOne({"sector": sector}, {"$set": doc}, upsert=True))
        written += 1

        if len(batch) >= 200:
            coll.bulk_write(batch, ordered=False)
            batch.clear()
            print(f"  wrote {written}… ({time.time() - started:.1f}s elapsed)")

    if batch:
        coll.bulk_write(batch, ordered=False)

    # Tear down any synthetic Voronoi polygons we inserted earlier — the
    # real Doogal ones supersede them.
    purged = coll.delete_many({"source": "ni-voronoi-synthetic"}).deleted_count
    print(
        f"\nDone. Wrote {written} {area_prefix}* sectors, skipped {skipped} "
        f"(elapsed {time.time() - started:.1f}s). Purged {purged} prior synthetic rows."
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
