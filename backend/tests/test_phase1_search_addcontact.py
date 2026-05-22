"""
Iteration 8 backend tests:
  (a) Smarter multi-token search + relevance scoring on GET /api/contacts
  (b) New admin endpoint POST /api/contacts for manual contact creation

Run:
  REACT_APP_BACKEND_URL=https://...preview.emergentagent.com \
  pytest /app/backend/tests/test_phase1_search_addcontact.py -v \
    --junitxml=/app/test_reports/pytest/phase1_search_addcontact.xml
"""
import os
import uuid
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")
assert BASE_URL, "REACT_APP_BACKEND_URL must be set"

ADMIN_EMAIL = os.environ.get("ADMIN_EMAIL", "admin@creativemojo.co.uk")
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "CreativeMojo2026!")
@pytest.fixture(scope="module")
def session():
    s = requests.Session()
    r = s.post(f"{BASE_URL}/api/auth/login",
               json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
               timeout=20)
    assert r.status_code == 200, f"Admin login failed: {r.status_code} {r.text}"
    return s


@pytest.fixture
def cleanup(session):
    created_ids = []
    yield created_ids
    for cid in created_ids:
        try:
            session.delete(f"{BASE_URL}/api/contacts/{cid}", timeout=15)
        except Exception:
            pass


# ----------------------------- SEARCH RANKING ----------------------------- #
class TestSearchRanking:
    """Multi-token search + relevance scoring."""

    def test_exact_full_name_match_is_first(self, session):
        r = session.get(f"{BASE_URL}/api/contacts",
                        params={"tab": "franchise", "search": "Penny Davies", "limit": 50},
                        timeout=20)
        assert r.status_code == 200, r.text
        items = r.json().get("items", [])
        assert len(items) >= 1, "No results for 'Penny Davies'"
        top = items[0]
        full = f"{(top.get('first_name') or '').lower()} {(top.get('last_name') or '').lower()}".strip()
        assert full == "penny davies", f"First result should be Penny Davies, got {full!r}"

    def test_single_token_davies(self, session):
        r = session.get(f"{BASE_URL}/api/contacts",
                        params={"tab": "franchise", "search": "Davies", "limit": 100},
                        timeout=20)
        assert r.status_code == 200, r.text
        items = r.json()["items"]
        assert len(items) >= 6, f"Expected 6+ Davies records, got {len(items)}"
        # Every record must contain 'davies' in some name/email/postcode/city/etc. field
        for it in items:
            blob = " ".join(str(it.get(k) or "") for k in
                            ("first_name", "last_name", "email", "telephone",
                             "postcode", "city", "establishment_name")).lower()
            assert "davies" in blob, f"'davies' missing from record: {it.get('id')}"

    def test_multi_token_and_filters(self, session):
        # "Penny Davies" with multi-token AND must collapse to the single person
        r = session.get(f"{BASE_URL}/api/contacts",
                        params={"tab": "franchise", "search": "Penny Davies", "limit": 50},
                        timeout=20)
        assert r.status_code == 200
        items = r.json()["items"]
        # Each result must contain BOTH 'penny' AND 'davies' across searchable fields.
        for it in items:
            blob = " ".join(str(it.get(k) or "") for k in
                            ("first_name", "last_name", "email", "telephone",
                             "postcode", "city", "establishment_name")).lower()
            assert "penny" in blob and "davies" in blob, f"AND violated for {it.get('id')}"
        # Should be small set (ideally 1)
        assert len(items) <= 5, f"AND token search returned {len(items)} (expected ~1)"

    def test_empty_whitespace_search(self, session):
        r = session.get(f"{BASE_URL}/api/contacts",
                        params={"tab": "franchise", "search": "   ", "limit": 5},
                        timeout=20)
        assert r.status_code == 200, r.text
        # Should fall back to no-search path; just verify it doesn't error
        assert "items" in r.json()

    def test_regex_special_chars(self, session):
        # 'J.K.' should NOT raise regex error; dots are escaped
        r = session.get(f"{BASE_URL}/api/contacts",
                        params={"tab": "franchise", "search": "J.K.", "limit": 5},
                        timeout=20)
        assert r.status_code == 200, r.text

    def test_case_insensitive_full_name(self, session):
        r = session.get(f"{BASE_URL}/api/contacts",
                        params={"tab": "franchise", "search": "penny davies", "limit": 50},
                        timeout=20)
        assert r.status_code == 200
        items = r.json()["items"]
        assert len(items) >= 1
        top = items[0]
        full = f"{(top.get('first_name') or '').lower()} {(top.get('last_name') or '').lower()}".strip()
        assert full == "penny davies", f"case-insensitive top should be Penny Davies, got {full!r}"


# ----------------------------- POST /api/contacts ----------------------------- #
class TestCreateContact:
    """Manual admin contact creation."""

    def test_create_franchise(self, session, cleanup):
        suffix = uuid.uuid4().hex[:6]
        payload = {
            "target": "franchise",
            "first_name": "TEST",
            "last_name": f"AddedFranchise_{suffix}",
            "email": f"test.franchise.{suffix}@example.com",
        }
        r = session.post(f"{BASE_URL}/api/contacts", json=payload, timeout=15)
        assert r.status_code == 200, r.text
        c = r.json()["contact"]
        cleanup.append(c["id"])
        assert c["source"] == "franchise_enquiry"
        assert c["in_pipeline"] is False
        assert c["manually_added_by"] == ADMIN_EMAIL
        assert c["email"] == payload["email"].lower()

    def test_create_licence(self, session, cleanup):
        suffix = uuid.uuid4().hex[:6]
        r = session.post(f"{BASE_URL}/api/contacts", json={
            "target": "licence",
            "first_name": "TEST",
            "last_name": f"LicenceAdd_{suffix}",
        }, timeout=15)
        assert r.status_code == 200, r.text
        c = r.json()["contact"]
        cleanup.append(c["id"])
        assert c["source"] == "licence_enquiry"
        assert c["in_pipeline"] is False

    def test_create_general(self, session, cleanup):
        suffix = uuid.uuid4().hex[:6]
        r = session.post(f"{BASE_URL}/api/contacts", json={
            "target": "general",
            "first_name": "TEST",
            "last_name": f"GeneralAdd_{suffix}",
        }, timeout=15)
        assert r.status_code == 200, r.text
        c = r.json()["contact"]
        cleanup.append(c["id"])
        assert c["source"] == "general_enquiry"
        assert c["in_pipeline"] is False

    def test_create_pipeline_with_stage(self, session, cleanup):
        suffix = uuid.uuid4().hex[:6]
        r = session.post(f"{BASE_URL}/api/contacts", json={
            "target": "pipeline",
            "pipeline_status": "qualified",
            "first_name": "TEST",
            "last_name": f"PipelineAdd_{suffix}",
            "email": f"test.pipe.{suffix}@example.com",
        }, timeout=15)
        assert r.status_code == 200, r.text
        c = r.json()["contact"]
        cleanup.append(c["id"])
        assert c["source"] == "franchise_enquiry"
        assert c["in_pipeline"] is True
        assert c["pipeline_status"] == "qualified"

    def test_missing_required_fields(self, session):
        r = session.post(f"{BASE_URL}/api/contacts", json={"target": "franchise"}, timeout=10)
        assert r.status_code == 400, r.text
        assert "At least one of" in r.text

    def test_invalid_target(self, session):
        r = session.post(f"{BASE_URL}/api/contacts",
                         json={"target": "foobar", "first_name": "X"}, timeout=10)
        assert r.status_code == 400
        assert "target must be one of" in r.text

    def test_invalid_pipeline_status(self, session):
        r = session.post(f"{BASE_URL}/api/contacts", json={
            "target": "pipeline",
            "pipeline_status": "invalid_stage",
            "first_name": "X",
        }, timeout=10)
        assert r.status_code == 400
        assert "pipeline_status must be one of" in r.text

    def test_normalises_email_and_postcode(self, session, cleanup):
        suffix = uuid.uuid4().hex[:6]
        r = session.post(f"{BASE_URL}/api/contacts", json={
            "target": "franchise",
            "first_name": "TEST",
            "last_name": f"Norm_{suffix}",
            "email": f"MiXeDCaSe.{suffix}@Example.COM",
            "postcode": "sw1a 1aa",
        }, timeout=15)
        assert r.status_code == 200, r.text
        c = r.json()["contact"]
        cleanup.append(c["id"])
        assert c["email"] == f"mixedcase.{suffix}@example.com"
        assert c["postcode"] == "SW1A 1AA"

    def test_requires_auth(self):
        r = requests.post(f"{BASE_URL}/api/contacts",
                          json={"target": "franchise", "first_name": "x"},
                          timeout=10)
        assert r.status_code in (401, 403), f"Expected 401/403, got {r.status_code}"

    def test_created_visible_in_tab_and_deletable(self, session):
        suffix = uuid.uuid4().hex[:6]
        r = session.post(f"{BASE_URL}/api/contacts", json={
            "target": "licence",
            "first_name": "TEST",
            "last_name": f"VisLic_{suffix}",
            "email": f"vis.lic.{suffix}@example.com",
        }, timeout=15)
        assert r.status_code == 200
        cid = r.json()["contact"]["id"]
        try:
            # Should appear when searching the licence tab
            r2 = session.get(f"{BASE_URL}/api/contacts",
                             params={"tab": "licence", "search": f"VisLic_{suffix}", "limit": 10},
                             timeout=15)
            assert r2.status_code == 200
            ids = [it["id"] for it in r2.json()["items"]]
            assert cid in ids, "Created licence contact not visible in licence tab"
        finally:
            d = session.delete(f"{BASE_URL}/api/contacts/{cid}", timeout=15)
            assert d.status_code in (200, 204)
        # Should no longer be returned
        r3 = session.get(f"{BASE_URL}/api/contacts/{cid}", timeout=10)
        assert r3.status_code == 404
