"""Iteration 22e — verify full address details carry across on Convert
and the backfill repairs already-converted franchisees missing them.

Covers:
1. Convert: contact with address_line_1 / address_line_2 / county /
   country populated → franchisee gets the same.
2. Backfill: existing franchisee row with empty address but a source
   contact that has it → row filled.
3. Backfill never overwrites a value the franchisee already has.
"""
import os
import asyncio
import pytest
import requests
from motor.motor_asyncio import AsyncIOMotorClient
from dotenv import load_dotenv

load_dotenv('/app/backend/.env')

BASE = os.environ["REACT_APP_BACKEND_URL"].rstrip("/")
EMAIL = os.environ.get("ADMIN_EMAIL", "admin@creativemojo.co.uk")
PASSWORD = os.environ.get("ADMIN_PASSWORD", "CreativeMojo2026!")
MONGO_URL = os.environ["MONGO_URL"]
DB_NAME = os.environ["DB_NAME"]


@pytest.fixture(scope="module")
def s():
    sess = requests.Session()
    r = sess.post(f"{BASE}/api/auth/login", json={"email": EMAIL, "password": PASSWORD})
    assert r.status_code == 200
    return sess


@pytest.fixture(scope="module")
def cleanup():
    return {"contacts": [], "franchisees": []}


def _make_contact(s, suffix, **extra):
    payload = {
        "first_name": "TEST", "last_name": f"ADDR_{suffix}",
        "email": f"TEST_addr_{suffix}@example.com",
        "source": "franchise_enquiry", "target": "pipeline",
        "establishment_name": f"TEST ADDR Org {suffix}",
        "address_line_1": "2 Wordsworth Cottages",
        "city": "Robertsbridge",
        "county": "East Sussex",
        "postcode": "TN32 5JG",
        "country": "United Kingdom",
    }
    payload.update(extra)
    r = s.post(f"{BASE}/api/contacts", json=payload)
    assert r.status_code in (200, 201), r.text
    return r.json().get("id") or r.json().get("contact", {}).get("id")


def _mongo_strip_address(fid):
    async def _work():
        c = AsyncIOMotorClient(MONGO_URL)
        db = c[DB_NAME]
        await db.franchisees.update_one(
            {"id": fid},
            {"$unset": {"address_street": "", "address_line_2": "", "county": "", "country": ""}},
        )
        c.close()
    asyncio.run(_work())


# ---------- 1. Convert copies all address fields ----------
def test_convert_copies_address(s, cleanup):
    cid = _make_contact(s, "full", address_line_2="Flat 3")
    cleanup["contacts"].append(cid)
    r = s.post(f"{BASE}/api/contacts/{cid}/convert-to-franchisee")
    assert r.status_code == 200, r.text
    fr = r.json()["franchisee"]
    cleanup["franchisees"].append(fr["id"])
    assert fr.get("address_street") == "2 Wordsworth Cottages"
    assert fr.get("address_line_2") == "Flat 3"
    assert fr.get("city") == "Robertsbridge"
    assert fr.get("county") == "East Sussex"
    assert fr.get("postcode") == "TN32 5JG"
    assert fr.get("country") == "United Kingdom"


# ---------- 2. Backfill fills missing address on existing franchisee ----------
def test_backfill_address(s, cleanup):
    cid = _make_contact(s, "bf_addr")
    cleanup["contacts"].append(cid)
    r = s.post(f"{BASE}/api/contacts/{cid}/convert-to-franchisee")
    assert r.status_code == 200
    fid = r.json()["franchisee"]["id"]
    cleanup["franchisees"].append(fid)

    # Simulate a pre-fix row: address fields stripped.
    _mongo_strip_address(fid)

    r = s.post(f"{BASE}/api/admin/backfill/convert-territories?dry_run=false")
    assert r.status_code == 200, r.text
    body = r.json()
    rows = [x for x in body.get("address_rows", []) if x["franchisee_id"] == fid]
    assert rows, f"expected address_rows entry for {fid}: keys={list(body.keys())}"
    # Should report all four missing fields
    fields = set(rows[0]["fields"])
    assert "address_street" in fields
    assert "county" in fields
    assert "country" in fields

    # Confirm on the actual record
    fr = s.get(f"{BASE}/api/franchisees/{fid}").json()
    fr = fr.get("franchisee", fr)
    assert fr.get("address_street") == "2 Wordsworth Cottages"
    assert fr.get("county") == "East Sussex"
    assert fr.get("country") == "United Kingdom"


# ---------- 3. Backfill does NOT overwrite an existing address ----------
def test_backfill_preserves_existing_address(s, cleanup):
    cid = _make_contact(s, "preserve", county="East Sussex")
    cleanup["contacts"].append(cid)
    r = s.post(f"{BASE}/api/contacts/{cid}/convert-to-franchisee")
    assert r.status_code == 200
    fid = r.json()["franchisee"]["id"]
    cleanup["franchisees"].append(fid)

    # Manually override the county to a different value via direct mongo
    async def _override():
        c = AsyncIOMotorClient(MONGO_URL)
        db = c[DB_NAME]
        await db.franchisees.update_one({"id": fid}, {"$set": {"county": "MANUAL OVERRIDE"}})
        c.close()
    asyncio.run(_override())

    # Run backfill — must not clobber MANUAL OVERRIDE
    r = s.post(f"{BASE}/api/admin/backfill/convert-territories?dry_run=false")
    assert r.status_code == 200
    fr = s.get(f"{BASE}/api/franchisees/{fid}").json()
    fr = fr.get("franchisee", fr)
    assert fr.get("county") == "MANUAL OVERRIDE", f"backfill clobbered county: {fr.get('county')}"


# ---------- Cleanup ----------
def test_zz_cleanup(s, cleanup):
    for fid in cleanup["franchisees"]:
        s.delete(f"{BASE}/api/franchisees/{fid}")
    for cid in cleanup["contacts"]:
        s.delete(f"{BASE}/api/contacts/{cid}")
