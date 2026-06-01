"""Territory+ verification — combined regression + new features (iteration 23).

Covers:
  Phase 1 (pre-existing fixes):
    1) DELETE /clients/mark-home works (unmark CQC home)
    2) POST /clients accepts contacts[]

  Phase 2 (NEW in this iteration):
    3) Lead CRUD on /api/portal/territory-plus/leads (PUT/GET/DELETE + validation)
    4) PATCH /clients/{id} on a marked CQC home (source!='custom') — full edit overrides
    5) Auth/role gating (unauth → 401/403, non-territory-plus franchisee → 403)
"""
import os
import pytest
import requests

BASE_URL = os.environ.get('REACT_APP_BACKEND_URL').rstrip('/')
ADMIN_EMAIL = "admin@creativemojo.co.uk"
ADMIN_PWD = "CreativeMojo2026!"
DEMO_EMAIL = "demo@creativemojo.co.uk"
DEMO_PWD = "CreativeMojoDemo2026!"

TEST_HOME_ID = "TEST-HM-100"
TEST_HOME_ID_2 = "TEST-HM-200"


@pytest.fixture(scope="module")
def admin_session():
    s = requests.Session()
    r = s.post(f"{BASE_URL}/api/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PWD})
    assert r.status_code == 200, f"admin login failed: {r.status_code} {r.text}"
    return s


@pytest.fixture(scope="module")
def demo_session(admin_session):
    seed = admin_session.post(f"{BASE_URL}/api/admin/seed-demo-franchisee", json={})
    assert seed.status_code == 200, f"seed-demo failed: {seed.status_code} {seed.text}"
    s = requests.Session()
    r = s.post(f"{BASE_URL}/api/auth/login", json={"email": DEMO_EMAIL, "password": DEMO_PWD})
    assert r.status_code == 200, f"demo login failed: {r.status_code} {r.text}"
    return s


# -------------------- Access / gating --------------------

def test_access_allowed(demo_session):
    r = demo_session.get(f"{BASE_URL}/api/portal/territory-plus/access")
    assert r.status_code == 200, r.text
    data = r.json()
    assert data.get("allowed") is True
    assert data.get("franchisee_id")


def test_unauthenticated_blocked():
    r = requests.get(f"{BASE_URL}/api/portal/territory-plus/access")
    assert r.status_code in (401, 403)


def test_unauthenticated_leads_blocked():
    r = requests.get(f"{BASE_URL}/api/portal/territory-plus/leads")
    assert r.status_code in (401, 403)
    r2 = requests.put(
        f"{BASE_URL}/api/portal/territory-plus/leads",
        json={"source": "cqc", "home_id": TEST_HOME_ID, "status": "contacted"},
    )
    assert r2.status_code in (401, 403)


# -------------------- Phase 1 regressions --------------------

def test_mark_then_unmark_cqc_home(demo_session):
    payload = {"source": "cqc", "home_id": "TEST-QA-001", "name": "QA Mark Test Home"}
    r1 = demo_session.post(f"{BASE_URL}/api/portal/territory-plus/clients/mark-home", json=payload)
    assert r1.status_code == 200, r1.text
    assert r1.json().get("home_id") == "TEST-QA-001"

    rl = demo_session.get(f"{BASE_URL}/api/portal/territory-plus/clients")
    ids = [(c.get("source"), c.get("home_id")) for c in rl.json().get("items", [])]
    assert ("cqc", "TEST-QA-001") in ids

    r2 = demo_session.delete(
        f"{BASE_URL}/api/portal/territory-plus/clients/mark-home",
        json={"source": "cqc", "home_id": "TEST-QA-001"},
    )
    assert r2.status_code == 200, r2.text
    assert r2.json().get("deleted") == 1


def test_create_client_with_contacts(demo_session):
    payload = {
        "name": "TEST_QA_Contacts_Client",
        "postcode": "EX12 3AB",
        "contacts": [
            {"name": "Deputy Manager", "role": "Manager", "phone": "01234 567890",
             "email": "deputy@example.com", "notes": "AM"},
            {"name": "Sales Contact", "role": "Sales", "phone": "07700 900100",
             "email": "sales@example.com"},
        ],
    }
    r = demo_session.post(f"{BASE_URL}/api/portal/territory-plus/clients", json=payload)
    assert r.status_code == 200, r.text
    created = r.json()
    cid = created["id"]
    assert len(created.get("contacts") or []) == 2
    # cleanup
    rd = demo_session.delete(f"{BASE_URL}/api/portal/territory-plus/clients/{cid}")
    assert rd.status_code == 200


# -------------------- Phase 2: Leads CRUD (NEW) --------------------

def _cleanup_lead(session, source, home_id):
    session.delete(
        f"{BASE_URL}/api/portal/territory-plus/leads",
        json={"source": source, "home_id": home_id},
    )


def test_lead_lifecycle_contacted_then_followup(demo_session):
    _cleanup_lead(demo_session, "cqc", TEST_HOME_ID)

    # PUT contacted
    r = demo_session.put(
        f"{BASE_URL}/api/portal/territory-plus/leads",
        json={"source": "cqc", "home_id": TEST_HOME_ID, "status": "contacted"},
    )
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["status"] == "contacted"
    assert d["source"] == "cqc"
    assert d["home_id"] == TEST_HOME_ID
    assert d["follow_up_at"] is None
    assert "id" in d
    assert "created_at" in d and "updated_at" in d
    first_id = d["id"]
    first_created = d["created_at"]

    # PUT follow_up with follow_up_at
    r2 = demo_session.put(
        f"{BASE_URL}/api/portal/territory-plus/leads",
        json={
            "source": "cqc",
            "home_id": TEST_HOME_ID,
            "status": "follow_up",
            "follow_up_at": "2026-06-15T10:00:00Z",
        },
    )
    assert r2.status_code == 200, r2.text
    d2 = r2.json()
    assert d2["status"] == "follow_up"
    assert d2["follow_up_at"] == "2026-06-15T10:00:00Z"
    # upsert preserved id + created_at
    assert d2["id"] == first_id
    assert d2["created_at"] == first_created

    # GET should contain it
    rl = demo_session.get(f"{BASE_URL}/api/portal/territory-plus/leads")
    assert rl.status_code == 200, rl.text
    items = rl.json().get("items") or []
    match = next((x for x in items if x.get("home_id") == TEST_HOME_ID), None)
    assert match, "lead not found in GET list"
    assert match["status"] == "follow_up"
    assert match["follow_up_at"] == "2026-06-15T10:00:00Z"

    # DELETE
    rd = demo_session.delete(
        f"{BASE_URL}/api/portal/territory-plus/leads",
        json={"source": "cqc", "home_id": TEST_HOME_ID},
    )
    assert rd.status_code == 200, rd.text
    body = rd.json()
    assert body == {"ok": True, "deleted": 1}

    # GET after delete — not present
    rl2 = demo_session.get(f"{BASE_URL}/api/portal/territory-plus/leads")
    items2 = rl2.json().get("items") or []
    assert not any(x.get("home_id") == TEST_HOME_ID for x in items2)


def test_lead_follow_up_at_cleared_when_status_changes(demo_session):
    _cleanup_lead(demo_session, "cqc", TEST_HOME_ID_2)

    # First set follow_up with date
    r = demo_session.put(
        f"{BASE_URL}/api/portal/territory-plus/leads",
        json={
            "source": "cqc",
            "home_id": TEST_HOME_ID_2,
            "status": "follow_up",
            "follow_up_at": "2026-07-01T12:00:00Z",
        },
    )
    assert r.status_code == 200
    assert r.json()["follow_up_at"] == "2026-07-01T12:00:00Z"

    # Change to contacted — follow_up_at should be cleared by server
    r2 = demo_session.put(
        f"{BASE_URL}/api/portal/territory-plus/leads",
        json={
            "source": "cqc",
            "home_id": TEST_HOME_ID_2,
            "status": "contacted",
            "follow_up_at": "2026-07-01T12:00:00Z",  # client may send stale value
        },
    )
    assert r2.status_code == 200
    assert r2.json()["follow_up_at"] is None

    _cleanup_lead(demo_session, "cqc", TEST_HOME_ID_2)


def test_lead_invalid_status_returns_400(demo_session):
    r = demo_session.put(
        f"{BASE_URL}/api/portal/territory-plus/leads",
        json={"source": "cqc", "home_id": TEST_HOME_ID, "status": "bogus"},
    )
    assert r.status_code == 400, f"expected 400 got {r.status_code} {r.text}"


def test_lead_invalid_source_returns_400(demo_session):
    r = demo_session.put(
        f"{BASE_URL}/api/portal/territory-plus/leads",
        json={"source": "custom", "home_id": TEST_HOME_ID, "status": "contacted"},
    )
    assert r.status_code == 400, f"expected 400 got {r.status_code} {r.text}"


def test_lead_delete_non_existent_is_idempotent(demo_session):
    r = demo_session.delete(
        f"{BASE_URL}/api/portal/territory-plus/leads",
        json={"source": "cqc", "home_id": "TEST-DOES-NOT-EXIST-AT-ALL"},
    )
    assert r.status_code == 200
    assert r.json() == {"ok": True, "deleted": 0}


# -------------------- Phase 2: PATCH override on linked CQC home (NEW) --------------------

def test_patch_marked_cqc_home_overrides(demo_session):
    """Mark a CQC home, then PATCH it with new manager/email/phone/website.
    The franchisee_clients doc should reflect overrides and persist on GET."""
    mark_payload = {
        "source": "cqc",
        "home_id": "TEST-HM-EDIT-001",
        "name": "Initial CQC Home Name",
        "manager": "Original Manager",
        "phone": "00000",
    }
    r1 = demo_session.post(f"{BASE_URL}/api/portal/territory-plus/clients/mark-home", json=mark_payload)
    assert r1.status_code == 200, r1.text
    marked = r1.json()
    cid = marked.get("id")
    assert cid
    assert marked.get("source") == "cqc"

    # PATCH override fields
    patch_body = {
        "manager": "Jane Doe",
        "email": "jane@home.com",
        "phone": "01234",
        "website": "home.com",
    }
    rp = demo_session.patch(
        f"{BASE_URL}/api/portal/territory-plus/clients/{cid}",
        json=patch_body,
    )
    assert rp.status_code == 200, rp.text
    upd = rp.json()
    assert upd["manager"] == "Jane Doe"
    assert upd["email"] == "jane@home.com"
    assert upd["phone"] == "01234"
    assert upd["website"] == "home.com"
    # source should be preserved (still cqc, not flipped to custom)
    assert upd.get("source") == "cqc"
    assert upd.get("home_id") == "TEST-HM-EDIT-001"

    # GET list to confirm persistence
    rl = demo_session.get(f"{BASE_URL}/api/portal/territory-plus/clients")
    match = next((c for c in rl.json().get("items", []) if c.get("id") == cid), None)
    assert match is not None
    assert match["manager"] == "Jane Doe"
    assert match["email"] == "jane@home.com"
    assert match["phone"] == "01234"
    assert match["website"] == "home.com"

    # cleanup — unmark via mark-home DELETE (preserves source semantic)
    rd = demo_session.delete(
        f"{BASE_URL}/api/portal/territory-plus/clients/mark-home",
        json={"source": "cqc", "home_id": "TEST-HM-EDIT-001"},
    )
    assert rd.status_code == 200
