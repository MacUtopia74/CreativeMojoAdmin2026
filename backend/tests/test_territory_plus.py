"""Territory+ verification — three bug fixes from production:
1) DELETE /clients/mark-home works (unmark CQC home)
2) POST /clients accepts contacts[] (additional contacts persist)
3) (Frontend) Care groups filter buttons visible — checked separately
"""
import os
import pytest
import requests

BASE_URL = os.environ.get('REACT_APP_BACKEND_URL').rstrip('/')
ADMIN_EMAIL = "admin@creativemojo.co.uk"
ADMIN_PWD = "CreativeMojo2026!"
DEMO_EMAIL = "demo@creativemojo.co.uk"
DEMO_PWD = "CreativeMojoDemo2026!"


@pytest.fixture(scope="module")
def admin_session():
    s = requests.Session()
    r = s.post(f"{BASE_URL}/api/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PWD})
    assert r.status_code == 200, f"admin login failed: {r.status_code} {r.text}"
    return s


@pytest.fixture(scope="module")
def demo_session(admin_session):
    # Make sure demo franchisee exists & has territory_plus enabled
    seed = admin_session.post(f"{BASE_URL}/api/admin/seed-demo-franchisee", json={})
    assert seed.status_code == 200, f"seed-demo failed: {seed.status_code} {seed.text}"
    s = requests.Session()
    r = s.post(f"{BASE_URL}/api/auth/login", json={"email": DEMO_EMAIL, "password": DEMO_PWD})
    assert r.status_code == 200, f"demo login failed: {r.status_code} {r.text}"
    return s


def test_access_allowed(demo_session):
    r = demo_session.get(f"{BASE_URL}/api/portal/territory-plus/access")
    assert r.status_code == 200, r.text
    data = r.json()
    assert data.get("allowed") is True, f"demo should have territory_plus access: {data}"
    assert data.get("franchisee_id")


def test_mark_then_unmark_cqc_home(demo_session):
    """Bug #1 — DELETE /mark-home must NOT 404."""
    payload = {"source": "cqc", "home_id": "TEST-QA-001", "name": "QA Mark Test Home"}
    # POST mark
    r1 = demo_session.post(f"{BASE_URL}/api/portal/territory-plus/clients/mark-home", json=payload)
    assert r1.status_code == 200, f"mark failed: {r1.status_code} {r1.text}"
    d1 = r1.json()
    assert d1.get("source") == "cqc"
    assert d1.get("home_id") == "TEST-QA-001"

    # Verify it appears in list
    rl = demo_session.get(f"{BASE_URL}/api/portal/territory-plus/clients")
    assert rl.status_code == 200
    ids = [(c.get("source"), c.get("home_id")) for c in rl.json().get("items", [])]
    assert ("cqc", "TEST-QA-001") in ids

    # DELETE mark — this is the bug that was failing in prod
    r2 = demo_session.delete(
        f"{BASE_URL}/api/portal/territory-plus/clients/mark-home",
        json={"source": "cqc", "home_id": "TEST-QA-001"},
    )
    assert r2.status_code == 200, f"unmark failed: {r2.status_code} {r2.text}"
    d2 = r2.json()
    assert d2.get("ok") is True
    assert d2.get("deleted") == 1

    # Verify gone from list (persistence)
    rl2 = demo_session.get(f"{BASE_URL}/api/portal/territory-plus/clients")
    ids2 = [(c.get("source"), c.get("home_id")) for c in rl2.json().get("items", [])]
    assert ("cqc", "TEST-QA-001") not in ids2


def test_mark_then_unmark_idempotent(demo_session):
    # double-unmark should still 200 (deleted=0)
    r = demo_session.delete(
        f"{BASE_URL}/api/portal/territory-plus/clients/mark-home",
        json={"source": "cqc", "home_id": "TEST-QA-DOES-NOT-EXIST"},
    )
    assert r.status_code == 200
    assert r.json().get("deleted") == 0


def test_create_client_with_contacts(demo_session):
    """Bug #2 — POST /clients must accept and persist contacts[]."""
    payload = {
        "name": "TEST_QA_Contacts_Client",
        "postcode": "EX12 3AB",
        "contacts": [
            {"name": "Deputy Manager", "role": "Manager", "phone": "01234 567890",
             "email": "deputy@example.com", "notes": "Best time to call: AM"},
            {"name": "Sales Contact", "role": "Sales", "phone": "07700 900100",
             "email": "sales@example.com", "notes": ""},
        ],
    }
    r = demo_session.post(f"{BASE_URL}/api/portal/territory-plus/clients", json=payload)
    assert r.status_code == 200, f"create with contacts failed: {r.status_code} {r.text}"
    created = r.json()
    cid = created.get("id")
    assert cid
    assert created.get("name") == "TEST_QA_Contacts_Client"
    assert isinstance(created.get("contacts"), list)
    assert len(created["contacts"]) == 2
    assert created["contacts"][0]["name"] == "Deputy Manager"
    assert created["contacts"][1]["role"] == "Sales"

    # GET list and verify contacts persist
    rl = demo_session.get(f"{BASE_URL}/api/portal/territory-plus/clients")
    assert rl.status_code == 200
    match = next((c for c in rl.json().get("items", []) if c.get("id") == cid), None)
    assert match, "newly-created client not found in list"
    assert isinstance(match.get("contacts"), list)
    assert len(match["contacts"]) == 2
    assert {c["name"] for c in match["contacts"]} == {"Deputy Manager", "Sales Contact"}

    # PATCH to update contacts and verify
    patch_body = {"contacts": [{"name": "Solo Contact", "role": "Owner"}]}
    rp = demo_session.patch(
        f"{BASE_URL}/api/portal/territory-plus/clients/{cid}",
        json=patch_body,
    )
    assert rp.status_code == 200, f"patch contacts failed: {rp.status_code} {rp.text}"
    upd = rp.json()
    assert isinstance(upd.get("contacts"), list)
    assert len(upd["contacts"]) == 1
    assert upd["contacts"][0]["name"] == "Solo Contact"

    # cleanup
    rd = demo_session.delete(f"{BASE_URL}/api/portal/territory-plus/clients/{cid}")
    assert rd.status_code == 200


def test_unauthenticated_blocked():
    r = requests.get(f"{BASE_URL}/api/portal/territory-plus/access")
    assert r.status_code in (401, 403)
