"""Backend API tests for Creative Mojo Admin Phase 1.6 (CRM + Migration).

Covers:
- POST /api/migration/run idempotency
- GET /api/dashboard/stats real counts
- /api/franchisees list + detail (Claire Henshall)
- /api/contracts list + detail (franchisee enrichment)
- /api/contacts list (source + pipeline filters) + PATCH pipeline
- /api/territories
- /api/anniversaries/today
"""
import os
import pytest
import requests

BASE_URL = os.environ["REACT_APP_BACKEND_URL"].rstrip("/")
ADMIN_EMAIL = "admin@creativemojo.co.uk"
ADMIN_PASSWORD = "CreativeMojo2026!"

EXPECTED = {
    "franchisees": 88,
    "contracts": 134,
    "contacts_total": 7632,  # 5958 + 1674
    "legacy_contacts": 5958,
    "web_form_contacts": 1674,
    "territories": 2470,
}


@pytest.fixture(scope="module")
def admin_session():
    s = requests.Session()
    r = s.post(f"{BASE_URL}/api/auth/login",
               json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD})
    if r.status_code != 200:
        pytest.skip(f"Login failed: {r.status_code} {r.text}")
    return s


# ---------------------------------------------------------------------------
# Dashboard stats — real counts after migration
# ---------------------------------------------------------------------------
class TestDashboardStats:
    def test_real_counts_after_migration(self, admin_session):
        r = admin_session.get(f"{BASE_URL}/api/dashboard/stats")
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["franchisees_migrated"] == EXPECTED["franchisees"]
        assert d["contracts_migrated"] == EXPECTED["contracts"]
        assert d["contacts_migrated"] == EXPECTED["contacts_total"]
        assert d["territories_migrated"] == EXPECTED["territories"]
        assert d["last_migration"] is not None
        assert isinstance(d["last_migration"], str)


# ---------------------------------------------------------------------------
# Franchisees
# ---------------------------------------------------------------------------
class TestFranchisees:
    def test_list_returns_88(self, admin_session):
        r = admin_session.get(f"{BASE_URL}/api/franchisees")
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["total"] == EXPECTED["franchisees"]
        assert isinstance(d["items"], list)
        assert len(d["items"]) == EXPECTED["franchisees"]
        # Verify shape
        f = d["items"][0]
        assert "id" in f
        # No mongo _id leak
        assert "_id" not in f

    def test_search_henshall(self, admin_session):
        r = admin_session.get(f"{BASE_URL}/api/franchisees", params={"search": "henshall"})
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["total"] >= 1
        # Find Claire Henshall
        claire = next((x for x in d["items"]
                       if (x.get("last_name") or "").lower() == "henshall"), None)
        assert claire is not None, f"Claire Henshall not found in {[x.get('last_name') for x in d['items']]}"

    def test_franchisee_detail_claire(self, admin_session):
        # First, find Claire's id
        r = admin_session.get(f"{BASE_URL}/api/franchisees", params={"search": "henshall"})
        items = r.json()["items"]
        claire = next(x for x in items if (x.get("last_name") or "").lower() == "henshall")
        cid = claire["id"]
        r = admin_session.get(f"{BASE_URL}/api/franchisees/{cid}")
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["franchisee"]["id"] == cid
        # Claire should have 2-3 contracts and ~93 territories
        assert 2 <= len(d["contracts"]) <= 4, f"Expected 2-4 contracts, got {len(d['contracts'])}"
        assert 80 <= len(d["territories"]) <= 110, f"Expected ~93 territories, got {len(d['territories'])}"
        assert isinstance(d["enquiries"], list)

    def test_franchisee_detail_404(self, admin_session):
        r = admin_session.get(f"{BASE_URL}/api/franchisees/does-not-exist")
        assert r.status_code == 404


# ---------------------------------------------------------------------------
# Contracts
# ---------------------------------------------------------------------------
class TestContracts:
    def test_list_returns_134_with_franchisee_enrichment(self, admin_session):
        r = admin_session.get(f"{BASE_URL}/api/contracts", params={"limit": 1000})
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["total"] == EXPECTED["contracts"]
        assert len(d["items"]) == EXPECTED["contracts"]
        # At least some contracts should have a franchisee object attached
        with_fr = [c for c in d["items"] if c.get("franchisee")]
        assert len(with_fr) > 100, f"Expected most contracts enriched, only {len(with_fr)}"
        sample = with_fr[0]["franchisee"]
        for key in ["id", "organisation", "first_name", "last_name"]:
            assert key in sample, f"Missing {key} in franchisee enrichment: {sample}"

    def test_contract_detail(self, admin_session):
        r = admin_session.get(f"{BASE_URL}/api/contracts", params={"limit": 5})
        cid = r.json()["items"][0]["id"]
        r = admin_session.get(f"{BASE_URL}/api/contracts/{cid}")
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["contract"]["id"] == cid
        # franchisee key present (may be None if unlinked)
        assert "franchisee" in d


# ---------------------------------------------------------------------------
# Contacts
# ---------------------------------------------------------------------------
class TestContacts:
    def test_filter_franchise_enquiry(self, admin_session):
        r = admin_session.get(f"{BASE_URL}/api/contacts",
                              params={"source": "franchise_enquiry", "limit": 2000})
        assert r.status_code == 200, r.text
        d = r.json()
        # Expect ~1674
        assert 1600 <= len(d["items"]) <= 1700, f"Got {len(d['items'])}"
        # All items should be web form / franchise_enquiry source
        sources = {x.get("source") for x in d["items"]}
        assert sources == {"franchise_enquiry"}, f"Mixed sources: {sources}"

    def test_filter_legacy(self, admin_session):
        r = admin_session.get(f"{BASE_URL}/api/contacts",
                              params={"source": "legacy_general_enquiry", "limit": 2000})
        assert r.status_code == 200, r.text
        d = r.json()
        # Cap at 2000, but actual data has 5958 — pagination not implemented, just verify ceiling
        assert len(d["items"]) == 2000 or len(d["items"]) == EXPECTED["legacy_contacts"]
        sources = {x.get("source") for x in d["items"]}
        assert sources == {"legacy_general_enquiry"}, f"Mixed sources: {sources}"

    def test_filter_pipeline_status_new(self, admin_session):
        r = admin_session.get(f"{BASE_URL}/api/contacts",
                              params={"pipeline_status": "new", "limit": 2000})
        assert r.status_code == 200, r.text
        d = r.json()
        # All should have pipeline_status == new
        statuses = {x.get("pipeline_status") for x in d["items"]}
        assert statuses.issubset({"new"}), f"Unexpected statuses: {statuses}"

    def test_pipeline_update_valid(self, admin_session):
        # Pick a web form contact (most likely to be updateable)
        r = admin_session.get(f"{BASE_URL}/api/contacts",
                              params={"source": "franchise_enquiry", "limit": 5})
        cid = r.json()["items"][0]["id"]

        # Update to 'contacted'
        r = admin_session.patch(f"{BASE_URL}/api/contacts/{cid}/pipeline",
                                json={"pipeline_status": "contacted"})
        assert r.status_code == 200, r.text
        assert r.json()["pipeline_status"] == "contacted"

        # Verify persisted by listing with that filter
        r = admin_session.get(f"{BASE_URL}/api/contacts",
                              params={"pipeline_status": "contacted", "limit": 2000})
        ids = {x["id"] for x in r.json()["items"]}
        assert cid in ids

    def test_pipeline_update_invalid(self, admin_session):
        r = admin_session.get(f"{BASE_URL}/api/contacts",
                              params={"source": "franchise_enquiry", "limit": 1})
        cid = r.json()["items"][0]["id"]
        r = admin_session.patch(f"{BASE_URL}/api/contacts/{cid}/pipeline",
                                json={"pipeline_status": "invalid-stage-xyz"})
        assert r.status_code == 400

    def test_pipeline_update_404(self, admin_session):
        r = admin_session.patch(f"{BASE_URL}/api/contacts/does-not-exist/pipeline",
                                json={"pipeline_status": "contacted"})
        assert r.status_code == 404


# ---------------------------------------------------------------------------
# Territories
# ---------------------------------------------------------------------------
class TestTerritories:
    def test_list_all(self, admin_session):
        r = admin_session.get(f"{BASE_URL}/api/territories")
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["total"] == EXPECTED["territories"]

    def test_filter_by_franchisee(self, admin_session):
        # Get Claire's id
        r = admin_session.get(f"{BASE_URL}/api/franchisees", params={"search": "henshall"})
        claire = next(x for x in r.json()["items"]
                      if (x.get("last_name") or "").lower() == "henshall")
        r = admin_session.get(f"{BASE_URL}/api/territories",
                              params={"franchisee_id": claire["id"]})
        assert r.status_code == 200
        d = r.json()
        assert 80 <= d["total"] <= 110, f"Expected ~93 territories for Claire, got {d['total']}"


# ---------------------------------------------------------------------------
# Anniversaries
# ---------------------------------------------------------------------------
class TestAnniversaries:
    def test_today_no_error(self, admin_session):
        r = admin_session.get(f"{BASE_URL}/api/anniversaries/today")
        assert r.status_code == 200, r.text
        d = r.json()
        assert "today" in d
        assert "count" in d
        assert "anniversaries" in d
        assert isinstance(d["anniversaries"], list)
        assert d["count"] == len(d["anniversaries"])


# ---------------------------------------------------------------------------
# Migration runner — idempotent
# ---------------------------------------------------------------------------
class TestMigrationRun:
    """Marked last because it's slow (~30-60s) and rebuilds collections."""
    def test_run_returns_counts(self, admin_session):
        r = admin_session.post(f"{BASE_URL}/api/migration/run", timeout=180)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["ok"] is True
        c = d["counts"]
        assert c["franchisees"] == EXPECTED["franchisees"]
        assert c["contracts"] == EXPECTED["contracts"]
        assert c["contacts"] == EXPECTED["legacy_contacts"]
        assert c["web_form_contacts"] == EXPECTED["web_form_contacts"]
        assert c["territories"] == EXPECTED["territories"]

    def test_run_requires_admin(self):
        r = requests.post(f"{BASE_URL}/api/migration/run")
        assert r.status_code == 401
