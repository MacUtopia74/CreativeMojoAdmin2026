"""
Iter11 backend tests:
- Airtable email backfill (web_form_contacts.email field is a real email, not recXXX...)
- Sally Hare pipeline reply flow (PATCH /api/contacts/{id}/pipeline) + cleanup
"""
import os
import re
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
SALLY_ID = "937bbeb7-6571-474e-a3c2-0237235cdba3"

ADMIN_EMAIL = os.environ.get("ADMIN_EMAIL", "admin@creativemojo.co.uk")
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "CreativeMojo2026!")


@pytest.fixture(scope="module")
def client():
    s = requests.Session()
    r = s.post(
        f"{BASE_URL}/api/auth/login",
        json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
        timeout=15,
    )
    assert r.status_code == 200, f"login failed: {r.status_code} {r.text}"
    return s


class TestEmailBackfill:
    def test_pipeline_new_emails_are_real(self, client):
        r = client.get(
            f"{BASE_URL}/api/contacts",
            params={"tab": "pipeline", "limit": 50, "pipeline_status": "new"},
            timeout=15,
        )
        assert r.status_code == 200
        items = r.json().get("items", [])
        assert len(items) >= 1, "expected at least one 'new' pipeline contact"
        bad = []
        for c in items:
            email = c.get("email") or ""
            if not EMAIL_RE.match(email):
                bad.append((c.get("id"), email))
        assert not bad, f"contacts with bogus/recID emails: {bad}"

    def test_pipeline_all_emails_are_real(self, client):
        r = client.get(
            f"{BASE_URL}/api/contacts",
            params={"tab": "pipeline", "limit": 100},
            timeout=15,
        )
        assert r.status_code == 200
        items = r.json().get("items", [])
        bad = [
            (c.get("id"), c.get("email"))
            for c in items
            if c.get("email") and not EMAIL_RE.match(c.get("email"))
        ]
        assert not bad, f"pipeline contacts with recID-like emails: {bad}"

    def test_sample_5_pipeline_new(self, client):
        r = client.get(
            f"{BASE_URL}/api/contacts",
            params={"tab": "pipeline", "limit": 20, "pipeline_status": "new"},
            timeout=15,
        )
        items = r.json().get("items", [])[:5]
        assert len(items) == 5
        for c in items:
            assert EMAIL_RE.match(c.get("email") or ""), f"bad email: {c}"

    def test_sally_hare_present_and_new(self, client):
        r = client.get(f"{BASE_URL}/api/contacts/{SALLY_ID}", timeout=15)
        assert r.status_code == 200
        body = r.json()
        c = body.get("contact", body)
        assert c["email"] == "sallyhare6119@gmail.com"
        # State at start of test run must be 'new'
        assert c["pipeline_status"] == "new", (
            f"Expected Sally Hare in 'new', got {c.get('pipeline_status')}. "
            f"Previous run may have left state. Restoring..."
        )


class TestReplyPipelineAdvance:
    def test_patch_pipeline_new_to_contacted_and_back(self, client):
        # Capture starting state
        r0 = client.get(f"{BASE_URL}/api/contacts/{SALLY_ID}", timeout=15)
        assert r0.status_code == 200
        body0 = r0.json()
        c0 = body0.get("contact", body0)
        starting = c0["pipeline_status"]
        try:
            # advance: new -> contacted
            r1 = client.patch(
                f"{BASE_URL}/api/contacts/{SALLY_ID}/pipeline",
                json={"pipeline_status": "contacted"},
                timeout=15,
            )
            assert r1.status_code == 200, r1.text
            r2 = client.get(f"{BASE_URL}/api/contacts/{SALLY_ID}", timeout=15)
            body2 = r2.json()
            c2 = body2.get("contact", body2)
            assert c2["pipeline_status"] == "contacted"
        finally:
            # cleanup: restore to starting state ('new')
            client.patch(
                f"{BASE_URL}/api/contacts/{SALLY_ID}/pipeline",
                json={"pipeline_status": starting},
                timeout=15,
            )
            check = client.get(f"{BASE_URL}/api/contacts/{SALLY_ID}", timeout=15)
            bodyc = check.json()
            cc = bodyc.get("contact", bodyc)
            assert cc["pipeline_status"] == starting
