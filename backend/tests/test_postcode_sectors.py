"""Regression tests for the ONS postcode-sector boundary endpoints (Phase 4).

These tests assume:
  • The dev MongoDB has been seeded via
    ``backend/scripts/import_postcode_sectors.py`` (≥ 9 000 docs in
    ``postcode_sector_polygons``).
  • The default admin user from .env exists and can log in.

Run:  pytest /app/backend/tests/test_postcode_sectors.py -q
"""
from __future__ import annotations

import os
import httpx
import pytest

BASE = os.environ.get("REACT_APP_BACKEND_URL", "https://licensee-vault.preview.emergentagent.com").rstrip("/")
API = f"{BASE}/api"
EMAIL = os.environ.get("ADMIN_EMAIL", "admin@creativemojo.co.uk")
PASSWORD = os.environ.get("ADMIN_PASSWORD", "CreativeMojo2026!")


@pytest.fixture(scope="module")
def client():
    c = httpx.Client(timeout=30.0)
    r = c.post(f"{API}/auth/login", json={"email": EMAIL, "password": PASSWORD})
    assert r.status_code == 200, r.text
    yield c
    c.close()


def test_sector_polygons_returns_real_geometry(client):
    r = client.get(f"{API}/territory/sector-polygons", params={"sectors": "CO15 1,EX15 1,AB10 1"})
    assert r.status_code == 200
    data = r.json()
    assert data["count"] == 3
    secs = {s["sector"]: s for s in data["sectors"]}
    for code in ("CO15 1", "EX15 1", "AB10 1"):
        assert code in secs, f"missing {code}"
        geom = secs[code]["geometry"]
        assert geom and geom["type"] in ("Polygon", "MultiPolygon")
        coords = geom["coordinates"]
        # WGS84 sanity — UK longitudes are roughly -8 → +2, lat 49 → 61
        flat = []
        def walk(c):
            if isinstance(c[0], (int, float)):
                flat.append(c)
            else:
                for x in c:
                    walk(x)
        walk(coords)
        for lng, lat in flat[:5]:
            assert -8 < lng < 3, f"lng {lng} out of UK bounds"
            assert 49 < lat < 61, f"lat {lat} out of UK bounds"


def test_sector_polygons_normalises_input(client):
    """Accepts assorted spacings — co7 0, CO70, "ex15 1" — all map back."""
    r = client.get(f"{API}/territory/sector-polygons", params={"sectors": "co7 0,co70,ex151"})
    data = r.json()
    secs = {s["sector"] for s in data["sectors"]}
    assert {"CO7 0", "EX15 1"} <= secs


def test_sectors_near_uses_real_polygons(client):
    """Spatial $geoIntersects should return adjacent CO sectors around
    Colchester (51.89, 0.90)."""
    r = client.get(f"{API}/territory/sectors-near", params={"lat": 51.89, "lon": 0.90, "radius_km": 5})
    assert r.status_code == 200
    data = r.json()
    assert data["count"] >= 5
    for s in data["sectors"][:5]:
        assert s["geometry"]["type"] in ("Polygon", "MultiPolygon")
        assert s["sector"].startswith("CO")


def test_unknown_sector_returns_null_geometry(client):
    """NI postcodes (BT…) aren't in the GB dataset — endpoint should still
    return the row with geometry=null so the UI can flag it gracefully."""
    r = client.get(f"{API}/territory/sector-polygons", params={"sectors": "ZZ99 9"})
    data = r.json()
    assert data["count"] == 1
    assert data["sectors"][0]["geometry"] is None


def test_legacy_alias_still_works(client):
    """The old `/sector-geometries` endpoint name now aliases to the same
    handler — guard against any rogue cached frontend bundle calling it."""
    r = client.get(f"{API}/territory/sector-geometries", params={"sectors": "CO15 1"})
    assert r.status_code == 200
    assert r.json()["sectors"][0]["geometry"]["type"] in ("Polygon", "MultiPolygon")
