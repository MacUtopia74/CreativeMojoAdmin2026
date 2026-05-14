"""Iter13 tests: dashboard funnel filtered by in_pipeline + pipeline_funnel_by_source"""
import os
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "https://licensee-vault.preview.emergentagent.com").rstrip("/")
ADMIN_EMAIL = "admin@creativemojo.co.uk"
ADMIN_PASS = "CreativeMojo2026!"


@pytest.fixture(scope="module")
def session():
    s = requests.Session()
    r = s.post(f"{BASE_URL}/api/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASS})
    assert r.status_code == 200, f"login failed: {r.status_code} {r.text}"
    return s


# ------------ Dashboard funnel ------------
class TestDashboardFunnel:
    def test_pipeline_funnel_filtered(self, session):
        r = session.get(f"{BASE_URL}/api/dashboard/stats")
        assert r.status_code == 200
        data = r.json()
        funnel = data["pipeline_funnel"]
        assert funnel.get("new") == 24, funnel
        assert funnel.get("demo_booked") == 1, funnel
        assert funnel.get("converted") == 2, funnel
        # ensure stale 1664 count is gone
        assert all(v < 100 for v in funnel.values()), funnel

    def test_pipeline_funnel_by_source(self, session):
        r = session.get(f"{BASE_URL}/api/dashboard/stats")
        data = r.json()
        assert "pipeline_funnel_by_source" in data
        src = data["pipeline_funnel_by_source"]
        assert set(src.keys()) >= {"franchise", "licence", "other"}
        assert src["franchise"].get("new") == 9
        assert src["franchise"].get("demo_booked") == 1
        assert src["franchise"].get("converted") == 2
        assert src["licence"].get("new") == 15
        assert src["other"] == {} or all(v == 0 for v in src["other"].values())

    def test_recent_enquiries_in_pipeline_only(self, session):
        r = session.get(f"{BASE_URL}/api/dashboard/stats")
        data = r.json()
        rec = data["recent_enquiries"]
        assert len(rec) == 5
        # All May 2026 (not 2019/2020)
        for item in rec:
            d = item.get("date") or ""
            assert d.startswith("2026-05"), f"unexpected date {d} for {item.get('first_name')}"
        # Expected names
        names = [f"{i['first_name']} {i['last_name']}" for i in rec]
        expected = ["Sally Hare", "Tracy Wilkinson", "Sue Gadler", "Karen Kinnersley", "Mary Fetterplace"]
        assert names == expected, names


# ------------ Regression: pipeline tab still 27 ------------
class TestPipelineTabRegression:
    def test_pipeline_tab_27(self, session):
        r = session.get(f"{BASE_URL}/api/contacts?tab=pipeline&limit=100")
        assert r.status_code == 200
        d = r.json()
        items = d["items"]
        assert len(items) == 27
        assert all(it.get("in_pipeline") is True for it in items)
        # 15 licence + 12 franchise
        licence_n = sum(1 for it in items if it.get("source") == "licence_enquiry")
        franchise_n = sum(1 for it in items if it.get("source") == "franchise_enquiry")
        assert licence_n == 15
        assert franchise_n == 12
