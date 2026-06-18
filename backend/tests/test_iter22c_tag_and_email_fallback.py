"""Iteration 22c — verify the fixes after Samantha Whiteman regression:

1. Convert sets the "Franchisee" / "Worldwide Licencee" tag so the
   franchisee appears under the Active / Worldwide tabs (not just "All").
2. Convert finds the territory plan via EMAIL fallback when the plan
   was attached to a SIBLING contact record (same email, different id).
3. Backfill repairs both: tags AND email-fallback territory link.
"""

import os
import time
import pytest
import requests
import asyncio
from motor.motor_asyncio import AsyncIOMotorClient
from dotenv import load_dotenv

load_dotenv('/app/backend/.env')

BASE = os.environ["REACT_APP_BACKEND_URL"].rstrip("/")
EMAIL = os.environ.get("ADMIN_EMAIL", "admin@creativemojo.co.uk")
PASSWORD = os.environ.get("ADMIN_PASSWORD", "CreativeMojo2026!")
MONGO_URL = os.environ["MONGO_URL"]
DB_NAME = os.environ["DB_NAME"]


def _mongo_strip_tags(fid):
    async def _work():
        client = AsyncIOMotorClient(MONGO_URL)
        db = client[DB_NAME]
        await db.franchisees.update_one(
            {"id": fid},
            {"$set": {"tags": ["Converted from enquiry"], "territory_sectors": []}},
        )
        client.close()
    asyncio.run(_work())


@pytest.fixture(scope="module")
def s():
    sess = requests.Session()
    r = sess.post(f"{BASE}/api/auth/login", json={"email": EMAIL, "password": PASSWORD})
    assert r.status_code == 200
    return sess


@pytest.fixture(scope="module")
def cleanup():
    return {"contacts": [], "franchisees": [], "plans": []}


def _make_contact(s, suffix, email=None, source="franchise_enquiry", target="pipeline"):
    payload = {
        "first_name": "TEST",
        "last_name": f"Tag_{suffix}",
        "email": email or f"TEST_tag_{suffix}@example.com",
        "source": source,
        "target": target,
        "establishment_name": f"TEST Tag Org {suffix}",
        "postcode": "CO7 0",
        "city": "Colchester",
    }
    r = s.post(f"{BASE}/api/contacts", json=payload)
    assert r.status_code in (200, 201), r.text
    return r.json().get("id") or r.json().get("contact", {}).get("id")


def _make_plan(s, contact_id, sectors, home_count=None):
    r = s.post(f"{BASE}/api/territory-plans", json={
        "contact_id": contact_id, "name": "TEST tag plan",
        "sectors": sectors, "home_count": home_count,
    })
    assert r.status_code in (200, 201)
    return r.json()["id"]


# ---------- 1. Convert sets "Franchisee" tag ----------
def test_convert_sets_franchisee_tag(s, cleanup):
    cid = _make_contact(s, "tag_f")
    cleanup["contacts"].append(cid)
    r = s.post(f"{BASE}/api/contacts/{cid}/convert-to-franchisee")
    assert r.status_code == 200, r.text
    fr = r.json()["franchisee"]
    cleanup["franchisees"].append(fr["id"])
    tags = fr.get("tags") or []
    assert "Franchisee" in tags, f"missing 'Franchisee' tag — got {tags}"
    assert "Converted from enquiry" in tags
    assert "Worldwide Licencee" not in tags


# ---------- 2. Convert a licence_enquiry sets "Worldwide Licencee" tag ----------
def test_convert_sets_worldwide_licencee_tag(s, cleanup):
    # licence_enquiry needs target=licence per existing helper rules
    payload = {
        "first_name": "TEST", "last_name": "Tag_lic", "source": "licence_enquiry",
        "target": "licence", "email": "TEST_tag_lic@example.com",
        "establishment_name": "TEST Lic Org", "postcode": "N1 9G",
    }
    r = s.post(f"{BASE}/api/contacts", json=payload)
    assert r.status_code in (200, 201)
    cid = r.json().get("id") or r.json().get("contact", {}).get("id")
    cleanup["contacts"].append(cid)

    r = s.post(f"{BASE}/api/contacts/{cid}/convert-to-franchisee")
    assert r.status_code == 200, r.text
    fr = r.json()["franchisee"]
    cleanup["franchisees"].append(fr["id"])
    tags = fr.get("tags") or []
    assert "Worldwide Licencee" in tags, f"missing 'Worldwide Licencee' tag — got {tags}"
    assert "Franchisee" not in tags


# ---------- 3. Convert finds plan via EMAIL fallback (Samantha scenario) ----------
def test_convert_finds_plan_via_email_fallback(s, cleanup):
    """Two contact records share the same email. The plan is tied to the
    'sibling' contact (not the one being converted). Convert must still
    pull the territory across via email-based fallback."""
    shared_email = f"TEST_samantha_{int(time.time())}@example.com"
    # Sibling (older record, parked outside the pipeline) — plan attached here
    sibling_id = _make_contact(s, "sib", email=shared_email, target="general")
    cleanup["contacts"].append(sibling_id)
    plan_id = _make_plan(s, sibling_id, ["TN32 5", "TN33 9", "BN27 4"], home_count=150)
    cleanup["plans"].append(plan_id)

    # Active record being converted (different contact_id, same email)
    convert_id = _make_contact(s, "conv", email=shared_email)
    cleanup["contacts"].append(convert_id)

    r = s.post(f"{BASE}/api/contacts/{convert_id}/convert-to-franchisee")
    assert r.status_code == 200, r.text
    body = r.json()
    cleanup["franchisees"].append(body["franchisee"]["id"])
    assert body["territory_linked"] is True, f"email-fallback failed: {body}"
    assert body["linked_plan_id"] == plan_id
    assert sorted(body["territory_sectors"]) == sorted(["BN27 4", "TN32 5", "TN33 9"])
    assert body["territory_home_count"] == 150


# ---------- 4. Backfill retags an already-converted row missing the tag ----------
def test_backfill_retags(s, cleanup):
    cid = _make_contact(s, "rtag")
    cleanup["contacts"].append(cid)
    r = s.post(f"{BASE}/api/contacts/{cid}/convert-to-franchisee")
    assert r.status_code == 200
    fid = r.json()["franchisee"]["id"]
    cleanup["franchisees"].append(fid)

    # Strip the Franchisee tag + territory to simulate a pre-fix row.
    # PATCH /franchisees doesn't allow tag edits, so write directly.
    _mongo_strip_tags(fid)

    # Run backfill
    r = s.post(f"{BASE}/api/admin/backfill/convert-territories?dry_run=false")
    assert r.status_code == 200, r.text
    body = r.json()
    retagged = [x for x in body.get("retagged_rows", []) if x["franchisee_id"] == fid]
    assert retagged and retagged[0]["added_tag"] == "Franchisee"

    # Confirm tag now on the franchisee
    fr = s.get(f"{BASE}/api/franchisees/{fid}").json()
    fr = fr.get("franchisee", fr)
    assert "Franchisee" in (fr.get("tags") or [])


# ---------- Cleanup ----------
def test_zz_cleanup(s, cleanup):
    for fid in cleanup["franchisees"]:
        s.delete(f"{BASE}/api/franchisees/{fid}")
    for cid in cleanup["contacts"]:
        s.delete(f"{BASE}/api/contacts/{cid}")
    for pid in cleanup["plans"]:
        s.delete(f"{BASE}/api/territory-plans/{pid}")
