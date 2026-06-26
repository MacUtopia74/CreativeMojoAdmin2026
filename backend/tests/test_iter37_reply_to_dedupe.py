"""Iteration 37 — Reply-To fallback, Mark-as-Replied, Lead Temp +15 boost.

Tests against the live preview backend (cookie-auth via /api/auth/login).
We do NOT actually fire resend.Emails.send — it is real money and explicitly
prohibited by the testing brief.  Instead:

  • Reply-To logic is verified by (a) reading the resend_routes.py source
    and asserting the precedence chain, AND (b) verifying that the
    template the route would consult has default_from='paul@creativemojo.co.uk'.

  • Mark-as-replied / Unmark / Temperature are exercised end-to-end
    against the seeded send doc (fb8ed962-…) belonging to contact
    28247df1-….
"""
from __future__ import annotations
import os
import re
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "https://licensee-vault.preview.emergentagent.com").rstrip("/")
ADMIN_EMAIL = "admin@creativemojo.co.uk"
ADMIN_PASSWORD = "CreativeMojo2026!"

# Seeded fixtures (per agent-to-agent context note)
SEND_ID = "fb8ed962-87eb-4f2f-a8e8-262519326e58"
CONTACT_ID = "28247df1-57f4-4b94-81fb-ae6a8f91fa24"
FRANCHISE_TPL_ID = "8ebca28f-d01b-49e0-a0d5-2926f1d7b38a"


# ----- fixtures ---------------------------------------------------------
@pytest.fixture(scope="session")
def admin_session():
    s = requests.Session()
    r = s.post(f"{BASE_URL}/api/auth/login",
               json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD}, timeout=15)
    assert r.status_code == 200, f"login failed {r.status_code}: {r.text}"
    return s


@pytest.fixture(autouse=True)
def _reset_marker(admin_session):
    """Ensure no leftover replied marker contaminates the test run."""
    admin_session.delete(f"{BASE_URL}/api/email/sends/{SEND_ID}/mark-replied", timeout=15)
    yield
    admin_session.delete(f"{BASE_URL}/api/email/sends/{SEND_ID}/mark-replied", timeout=15)


# ----- 1. Reply-To fallback chain --------------------------------------
class TestReplyToFallback:
    """Static + integration verification that the route prefers template.default_from."""

    def test_franchise_template_has_paul_as_default_from(self, admin_session):
        r = admin_session.get(f"{BASE_URL}/api/email-templates", timeout=10)
        assert r.status_code == 200
        items = r.json() if isinstance(r.json(), list) else r.json().get("items", [])
        tpl = next((t for t in items if t.get("id") == FRANCHISE_TPL_ID), None)
        assert tpl is not None, "Franchise Enquiry Reply template missing"
        assert tpl.get("default_from") == "paul@creativemojo.co.uk", \
            f"default_from must be paul@…, got {tpl.get('default_from')!r}"

    def test_source_implements_template_first_precedence(self):
        """Static check: reply_to comes from template.default_from BEFORE logged-in user."""
        src = open("/app/backend/resend_routes.py").read()
        # locate the relevant block
        block = src[src.find("Reply-to precedence"):src.find("Reply-to precedence") + 1500]
        # The template lookup must happen first
        assert "template_reply_to" in block
        assert "default_from" in block
        # user.get('email') must appear only in the else-branch (fallback)
        m = re.search(r"if template_reply_to:\s*reply_to = template_reply_to\s*else:\s*reply_to = \(user\.get\(.email.\)", block)
        assert m, "Expected `if template_reply_to: reply_to = template_reply_to else: reply_to = user.email` ordering"


# ----- 2. Mark-as-Replied (idempotent + undo) --------------------------
class TestMarkAsReplied:
    def test_first_post_appends_event_and_sets_last_event(self, admin_session):
        r = admin_session.post(f"{BASE_URL}/api/email/sends/{SEND_ID}/mark-replied", timeout=10)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body.get("ok") is True
        assert body.get("already_marked") is None or body.get("already_marked") is False
        ev = body.get("event")
        assert ev and ev.get("type") == "replied"
        assert ev.get("at")
        assert ev.get("marked_by") == ADMIN_EMAIL

        # GET to verify persistence + last_event
        r2 = admin_session.get(f"{BASE_URL}/api/email/sends?contact_id={CONTACT_ID}", timeout=10)
        assert r2.status_code == 200
        send = next(s for s in r2.json().get("items", []) if s["id"] == SEND_ID)
        assert send["last_event"] == "replied", f"last_event should flip to replied, got {send['last_event']}"
        replied_events = [e for e in send.get("events", []) if e.get("type") == "replied"]
        assert len(replied_events) == 1

    def test_second_post_is_idempotent(self, admin_session):
        admin_session.post(f"{BASE_URL}/api/email/sends/{SEND_ID}/mark-replied", timeout=10)
        r = admin_session.post(f"{BASE_URL}/api/email/sends/{SEND_ID}/mark-replied", timeout=10)
        assert r.status_code == 200
        body = r.json()
        assert body.get("ok") is True
        assert body.get("already_marked") is True, f"expected already_marked=True, got {body!r}"

        # confirm still exactly 1 replied event
        r2 = admin_session.get(f"{BASE_URL}/api/email/sends?contact_id={CONTACT_ID}", timeout=10)
        send = next(s for s in r2.json().get("items", []) if s["id"] == SEND_ID)
        replied_events = [e for e in send.get("events", []) if e.get("type") == "replied"]
        assert len(replied_events) == 1, f"duplicate replied event! {replied_events}"

    def test_delete_removes_marker_and_recomputes_last_event(self, admin_session):
        admin_session.post(f"{BASE_URL}/api/email/sends/{SEND_ID}/mark-replied", timeout=10)
        r = admin_session.delete(f"{BASE_URL}/api/email/sends/{SEND_ID}/mark-replied", timeout=10)
        assert r.status_code == 200
        assert r.json().get("ok") is True

        # verify last_event recomputed (back to 'sent' since that's only other event)
        r2 = admin_session.get(f"{BASE_URL}/api/email/sends?contact_id={CONTACT_ID}", timeout=10)
        send = next(s for s in r2.json().get("items", []) if s["id"] == SEND_ID)
        assert send["last_event"] == "sent", f"expected last_event back to 'sent', got {send['last_event']}"
        replied_events = [e for e in send.get("events", []) if e.get("type") == "replied"]
        assert len(replied_events) == 0

    def test_mark_unknown_send_404(self, admin_session):
        r = admin_session.post(f"{BASE_URL}/api/email/sends/does-not-exist/mark-replied", timeout=10)
        assert r.status_code == 404


# ----- 3. Lead Temperature +15 boost -----------------------------------
class TestTemperatureBoost:
    def test_replied_adds_15_to_score(self, admin_session):
        # Baseline (no replied marker)
        r0 = admin_session.get(f"{BASE_URL}/api/contacts/{CONTACT_ID}/temperature", timeout=10)
        assert r0.status_code == 200
        base = r0.json()
        base_score = base["score"]
        replied_bucket = next(d for d in base["details"] if d["label"] == "Marked as replied")
        assert replied_bucket["count"] == 0
        assert replied_bucket["weight"] == 15
        assert replied_bucket["max"] == 15

        # Mark replied → score lifts by exactly 15
        admin_session.post(f"{BASE_URL}/api/email/sends/{SEND_ID}/mark-replied", timeout=10)
        r1 = admin_session.get(f"{BASE_URL}/api/contacts/{CONTACT_ID}/temperature", timeout=10)
        lifted = r1.json()
        lifted_bucket = next(d for d in lifted["details"] if d["label"] == "Marked as replied")
        assert lifted_bucket["count"] == 1
        assert lifted["score"] == pytest.approx(base_score + 15, abs=0.1), \
            f"score should rise by 15 (base={base_score}, lifted={lifted['score']})"

        # Undo → score drops back
        admin_session.delete(f"{BASE_URL}/api/email/sends/{SEND_ID}/mark-replied", timeout=10)
        r2 = admin_session.get(f"{BASE_URL}/api/contacts/{CONTACT_ID}/temperature", timeout=10)
        back = r2.json()
        back_bucket = next(d for d in back["details"] if d["label"] == "Marked as replied")
        assert back_bucket["count"] == 0
        assert back["score"] == pytest.approx(base_score, abs=0.1)


# ----- 4. Regression: list_sends still works ---------------------------
class TestRegression:
    def test_list_sends_returns_seeded_doc(self, admin_session):
        r = admin_session.get(f"{BASE_URL}/api/email/sends?contact_id={CONTACT_ID}", timeout=10)
        assert r.status_code == 200
        items = r.json().get("items", [])
        assert any(s["id"] == SEND_ID for s in items)

    def test_landing_pages_admin_still_loads(self, admin_session):
        r = admin_session.get(f"{BASE_URL}/api/landing-pages", timeout=10)
        # 200 (with items) or 404/empty are both acceptable; just verify no 5xx
        assert r.status_code < 500, f"landing-pages admin route crashed: {r.status_code}"

    def test_email_templates_still_loads(self, admin_session):
        r = admin_session.get(f"{BASE_URL}/api/email-templates", timeout=10)
        assert r.status_code == 200
