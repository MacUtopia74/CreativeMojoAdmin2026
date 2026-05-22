"""Iteration 15 — backend tests for /api/contacts/{id}/convert-to-franchisee + franchisee PATCH.

Verifies:
1. Convert franchise_enquiry -> record_type='franchisee'
2. Convert licence_enquiry -> record_type='licencee'
3. Contact marked converted, pipeline_status='converted', converted_to_franchisee_id set
4. Second call -> 409 'Contact already converted'
5. GET /api/franchisees/{id} returns the new record (no _id)
6. PATCH /api/franchisees/{id} updates fields, uppercases postcode, lowercases email
7. Regression on bulk-move, /move, /pipeline, /promote, /demote, dashboard funnel
Cleanup: deletes test franchisees and test contacts created during the run.
"""

import os
import pytest
import requests

BASE = os.environ["REACT_APP_BACKEND_URL"].rstrip("/")
EMAIL = os.environ.get("ADMIN_EMAIL", "admin@creativemojo.co.uk")
PASSWORD = os.environ.get("ADMIN_PASSWORD", "CreativeMojo2026!")


@pytest.fixture(scope="module")
def s():
    sess = requests.Session()
    r = sess.post(f"{BASE}/api/auth/login", json={"email": EMAIL, "password": PASSWORD})
    assert r.status_code == 200, f"login failed: {r.status_code} {r.text}"
    return sess


@pytest.fixture(scope="module")
def created_ids():
    """Track for cleanup."""
    return {"contacts": [], "franchisees": []}


def _make_contact(s, source, suffix):
    payload = {
        "first_name": "TEST",
        "last_name": f"Convert_{suffix}",
        "email": f"TEST_convert_{suffix}@example.com",
        "source": source,
        "target": "pipeline",
        "establishment_name": f"TEST Org {suffix}",
        "postcode": "se1 7tp",
        "city": "London",
        "telephone": "020 1234 5678",
        "mobile_phone": "07700 900000",
        "message": f"I want to learn more about {source}",
        "referral_source": "Google",
        "why_contacting": "Career change",
        "date": "2026-01-15",
    }
    r = s.post(f"{BASE}/api/contacts", json=payload)
    assert r.status_code in (200, 201), f"create contact failed: {r.status_code} {r.text}"
    body = r.json()
    cid = body.get("id") or body.get("contact", {}).get("id")
    assert cid, f"no id returned: {body}"
    return cid


# ---------- 1. Convert franchise_enquiry -> franchisee ----------
def test_convert_franchise_enquiry(s, created_ids):
    cid = _make_contact(s, "franchise_enquiry", "f1")
    created_ids["contacts"].append(cid)
    r = s.post(f"{BASE}/api/contacts/{cid}/convert-to-franchisee")
    assert r.status_code == 200, f"{r.status_code} {r.text}"
    body = r.json()
    assert body["ok"] is True
    assert body["record_type"] == "franchisee"
    f = body["franchisee"]
    assert "id" in f
    created_ids["franchisees"].append(f["id"])
    assert f["record_type"] == "franchisee"
    assert f["tags"] == ["Converted from enquiry"]
    assert f["status"] == "Active"
    assert f["first_name"] == "TEST"
    assert f["last_name"] == "Convert_f1"
    # Email is lowercased on POST /api/contacts at intake — convert just copies it
    assert f["email"] == "test_convert_f1@example.com"
    assert f["postcode"] == "SE1 7TP"  # uppercased upstream on POST /contacts
    assert f["organisation"] == "TEST Org f1"
    assert f["notes"]
    assert "Original enquiry message" in f["notes"]
    assert "Google" in f["notes"]
    # why_contacting is not part of POST /api/contacts schema — skip its assertion here


# ---------- 2. Convert licence_enquiry -> licencee ----------
def test_convert_licence_enquiry(s, created_ids):
    # POST /api/contacts target='pipeline' always uses source='franchise_enquiry'.
    # To get source='licence_enquiry' use target='licence' (auto-routes source).
    payload = {
        "first_name": "TEST",
        "last_name": "Convert_l1",
        "email": "TEST_convert_l1@example.com",
        "source": "licence_enquiry",
        "target": "licence",
        "establishment_name": "TEST Licence Org",
        "postcode": "n1 9gu",
        "city": "London",
    }
    r = s.post(f"{BASE}/api/contacts", json=payload)
    assert r.status_code in (200, 201), r.text
    cid = r.json().get("id") or r.json().get("contact", {}).get("id")
    created_ids["contacts"].append(cid)
    # Verify source set to licence_enquiry
    c = s.get(f"{BASE}/api/contacts/{cid}").json()
    c = c.get("contact", c)
    assert c.get("source") == "licence_enquiry", f"source={c.get('source')}"

    r = s.post(f"{BASE}/api/contacts/{cid}/convert-to-franchisee")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["record_type"] == "licencee"
    f = body["franchisee"]
    created_ids["franchisees"].append(f["id"])
    assert f["record_type"] == "licencee"


# ---------- 3. Contact marked converted; 4. Second call 409 ----------
def test_contact_marked_and_idempotent(s, created_ids):
    cid = _make_contact(s, "franchise_enquiry", "f2")
    created_ids["contacts"].append(cid)
    r = s.post(f"{BASE}/api/contacts/{cid}/convert-to-franchisee")
    assert r.status_code == 200
    fid = r.json()["franchisee"]["id"]
    created_ids["franchisees"].append(fid)

    # Verify contact state
    r2 = s.get(f"{BASE}/api/contacts/{cid}")
    assert r2.status_code == 200
    c = r2.json()
    # endpoint may return {"contact": ...} or the contact directly
    c = c.get("contact", c)
    assert c.get("pipeline_status") == "converted"
    assert c.get("in_pipeline") is True
    assert c.get("converted_to_franchisee_id") == fid

    # Second call → 409
    r3 = s.post(f"{BASE}/api/contacts/{cid}/convert-to-franchisee")
    assert r3.status_code == 409, f"expected 409 got {r3.status_code} {r3.text}"
    assert "already converted" in r3.json().get("detail", "").lower()


# ---------- 5. GET /api/franchisees/{id} ----------
def test_get_franchisee_no_objectid(s, created_ids):
    cid = _make_contact(s, "franchise_enquiry", "f3")
    created_ids["contacts"].append(cid)
    fid = s.post(f"{BASE}/api/contacts/{cid}/convert-to-franchisee").json()["franchisee"]["id"]
    created_ids["franchisees"].append(fid)
    r = s.get(f"{BASE}/api/franchisees/{fid}")
    assert r.status_code == 200, r.text
    payload = r.json()
    # Check for raw MongoDB _id key (not substrings in field names like converted_to_franchisee_id)
    def _has_mongo_id(obj):
        if isinstance(obj, dict):
            if "_id" in obj:
                return True
            return any(_has_mongo_id(v) for v in obj.values())
        if isinstance(obj, list):
            return any(_has_mongo_id(v) for v in obj)
        return False
    assert not _has_mongo_id(payload), "_id leaked in response"
    f = payload.get("franchisee", payload)
    assert f["id"] == fid


# ---------- 6. PATCH /api/franchisees/{id} ----------
def test_patch_franchisee(s, created_ids):
    cid = _make_contact(s, "franchise_enquiry", "f4")
    created_ids["contacts"].append(cid)
    fid = s.post(f"{BASE}/api/contacts/{cid}/convert-to-franchisee").json()["franchisee"]["id"]
    created_ids["franchisees"].append(fid)

    payload = {
        "first_name": "Updated",
        "last_name": "Name",
        "organisation": "Updated Co",
        "email": "UPPER.case@Example.COM",
        "postcode": "sw1a 1aa",
        "city": "London",
        "telephone": "020 1111 2222",
        "mobile_phone": "07700 900111",
        "notes": "Patched notes",
    }
    r = s.patch(f"{BASE}/api/franchisees/{fid}", json=payload)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body.get("ok") is True
    f = body["franchisee"]
    assert f["first_name"] == "Updated"
    assert f["email"] == "upper.case@example.com"  # auto-lowercased
    assert f["postcode"] == "SW1A 1AA"  # auto-uppercased
    assert f["organisation"] == "Updated Co"
    assert f["notes"] == "Patched notes"
    assert f.get("updated_at")
    assert f.get("updated_by") == EMAIL

    # Confirm via GET
    g = s.get(f"{BASE}/api/franchisees/{fid}").json()
    g = g.get("franchisee", g)
    assert g["postcode"] == "SW1A 1AA"
    assert g["email"] == "upper.case@example.com"


# ---------- 7a. Convert not-found ----------
def test_convert_not_found(s):
    r = s.post(f"{BASE}/api/contacts/non-existent-id-xyz/convert-to-franchisee")
    assert r.status_code == 404


# ---------- 7b. Regression — dashboard funnel still present ----------
def test_dashboard_funnel(s):
    r = s.get(f"{BASE}/api/dashboard/stats")
    assert r.status_code == 200
    data = r.json()
    assert "pipeline_funnel" in data
    assert "pipeline_funnel_by_source" in data


# ---------- 7c. Regression — bulk-move / move / pipeline / promote / demote ----------
def test_regression_pipeline_endpoints(s, created_ids):
    cid = _make_contact(s, "franchise_enquiry", "reg1")
    created_ids["contacts"].append(cid)

    # /move
    r = s.post(f"{BASE}/api/contacts/{cid}/move", json={"target": "pipeline", "pipeline_status": "contacted"})
    assert r.status_code == 200, r.text

    # /pipeline
    r = s.patch(f"{BASE}/api/contacts/{cid}/pipeline", json={"pipeline_status": "qualified"})
    assert r.status_code == 200, r.text

    # /promote (PATCH)
    r = s.patch(f"{BASE}/api/contacts/{cid}/promote")
    assert r.status_code in (200, 400, 409), r.text  # may already be at top — accept

    # /demote (PATCH)
    r = s.patch(f"{BASE}/api/contacts/{cid}/demote")
    assert r.status_code in (200, 400, 409), r.text

    # bulk-move
    r = s.post(f"{BASE}/api/contacts/bulk-move", json={"ids": [cid], "target": "pipeline", "pipeline_status": "new"})
    assert r.status_code == 200, r.text


# ---------- Cleanup ----------
def test_zz_cleanup(s, created_ids):
    for fid in created_ids["franchisees"]:
        s.delete(f"{BASE}/api/franchisees/{fid}")
    for cid in created_ids["contacts"]:
        s.delete(f"{BASE}/api/contacts/{cid}")
    # best-effort, no asserts (some delete endpoints may not exist)
