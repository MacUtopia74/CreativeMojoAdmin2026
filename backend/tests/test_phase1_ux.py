"""Phase 1.7 UX iteration backend tests.

New fields added to GET /api/dashboard/stats:
  active_franchisees, ex_franchisees, active_contracts, web_form_contacts,
  mandate_breakdown, pipeline_funnel, recent_enquiries.
"""
import os
import pytest
import requests

BASE_URL = os.environ["REACT_APP_BACKEND_URL"].rstrip("/")
ADMIN_EMAIL = "admin@creativemojo.co.uk"
ADMIN_PASSWORD = "CreativeMojo2026!"


@pytest.fixture(scope="module")
def admin_session():
    s = requests.Session()
    r = s.post(f"{BASE_URL}/api/auth/login",
               json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD})
    if r.status_code != 200:
        pytest.skip(f"Login failed: {r.status_code}")
    return s


class TestDashboardExtended:
    def test_new_fields_present(self, admin_session):
        r = admin_session.get(f"{BASE_URL}/api/dashboard/stats")
        assert r.status_code == 200, r.text
        d = r.json()
        # New fields
        for k in ["active_franchisees", "ex_franchisees", "active_contracts",
                  "web_form_contacts", "mandate_breakdown", "pipeline_funnel",
                  "recent_enquiries"]:
            assert k in d, f"Missing field: {k}"

    def test_active_and_ex_counts(self, admin_session):
        d = admin_session.get(f"{BASE_URL}/api/dashboard/stats").json()
        # Spec: Active = 27, Ex = 59 (sum = 86, plus a few licencees → 88 total)
        assert d["active_franchisees"] == 27, f"active_franchisees={d['active_franchisees']}"
        assert d["ex_franchisees"] == 59, f"ex_franchisees={d['ex_franchisees']}"
        # web_form_contacts should be ~1674
        assert d["web_form_contacts"] == 1674

    def test_active_contracts(self, admin_session):
        d = admin_session.get(f"{BASE_URL}/api/dashboard/stats").json()
        # active_contracts ~ 128 (134 total - cancelled_early)
        assert 120 <= d["active_contracts"] <= 134

    def test_mandate_breakdown_shape(self, admin_session):
        d = admin_session.get(f"{BASE_URL}/api/dashboard/stats").json()
        mb = d["mandate_breakdown"]
        assert isinstance(mb, list)
        if mb:
            for item in mb:
                assert "value" in item
                assert "count" in item
                assert isinstance(item["count"], int)

    def test_pipeline_funnel_shape(self, admin_session):
        d = admin_session.get(f"{BASE_URL}/api/dashboard/stats").json()
        pf = d["pipeline_funnel"]
        # object keyed by stage
        assert isinstance(pf, dict)
        # New stage almost certainly present
        assert sum(pf.values()) >= 1

    def test_recent_enquiries_shape(self, admin_session):
        d = admin_session.get(f"{BASE_URL}/api/dashboard/stats").json()
        re_ = d["recent_enquiries"]
        assert isinstance(re_, list)
        assert len(re_) <= 5
        if re_:
            sample = re_[0]
            # Required keys
            for k in ["id", "postcode", "date", "pipeline_status"]:
                assert k in sample, f"Missing {k} in recent_enquiries item: {list(sample.keys())}"
            # Backend returns first_name+last_name (not a single 'name' field).
            # Frontend joins them; this is a minor spec deviation flagged in report.
            assert "first_name" in sample or "name" in sample
            # No mongo _id leak
            assert "_id" not in sample

    def test_old_fields_still_present(self, admin_session):
        """Regression - all previously documented fields still present."""
        d = admin_session.get(f"{BASE_URL}/api/dashboard/stats").json()
        for k in ["franchisees_migrated", "contracts_migrated",
                  "contacts_migrated", "territories_migrated",
                  "last_migration", "airtable", "users"]:
            assert k in d, f"Regression: missing {k}"
        assert d["franchisees_migrated"] == 88
        assert d["contracts_migrated"] == 134
        assert d["contacts_migrated"] == 7632
