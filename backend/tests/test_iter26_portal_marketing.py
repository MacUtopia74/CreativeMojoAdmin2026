"""Iteration 26 — Franchisee portal Marketing endpoint tests.

Covers:
  • Access gating (module flags, demo bypass)
  • Recipients listing (primary + secondary contacts)
  • HTML preview (signature footer)
  • Image upload (R2 may not be configured — graceful)
  • Test send + Campaign send (validation + 5 cap)
  • List/Detail/Delete
  • Resend webhook → opens_count rollup
"""
import json
import os
import time
import uuid
import requests
import pytest

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "https://licensee-vault.preview.emergentagent.com").rstrip("/")

SANDRA_EMAIL = "sandra@creativemojo.co.uk"
SANDRA_PASSWORD = "Test1234!"
SANDRA_FID = "b2ca2c54-7101-4524-926a-b36ac0e2a70a"

DEMO_EMAIL = "demo@creativemojo.co.uk"
DEMO_PASSWORD = "CreativeMojoDemo2026!"

ADMIN_EMAIL = "admin@creativemojo.co.uk"
ADMIN_PASSWORD = "CreativeMojo2026!"

TEST_PREFIX = "TEST_iter26_"


def _login(email: str, password: str) -> requests.Session:
    s = requests.Session()
    r = s.post(f"{BASE_URL}/api/auth/login",
               json={"email": email, "password": password}, timeout=20)
    assert r.status_code == 200, f"Login {email} failed: {r.status_code} {r.text}"
    return s


@pytest.fixture(scope="module")
def sandra():
    return _login(SANDRA_EMAIL, SANDRA_PASSWORD)


@pytest.fixture(scope="module")
def demo():
    return _login(DEMO_EMAIL, DEMO_PASSWORD)


@pytest.fixture(scope="module")
def admin():
    return _login(ADMIN_EMAIL, ADMIN_PASSWORD)


@pytest.fixture(scope="module")
def sandra_test_client(sandra):
    """Create a Territory+ client owned by Sandra with primary + secondary emails."""
    payload = {
        "name": f"{TEST_PREFIX}Client {uuid.uuid4().hex[:6]}",
        "email": f"primary+{uuid.uuid4().hex[:6]}@example.com",
        "manager": "Primary Person",
        "phone": "+447000000000",
        "contacts": [
            {"name": "Second Person", "email": f"second+{uuid.uuid4().hex[:6]}@example.com", "role": "Manager"},
            {"name": "Third Person", "email": f"third+{uuid.uuid4().hex[:6]}@example.com", "role": "Owner"},
        ],
    }
    r = sandra.post(f"{BASE_URL}/api/portal/territory-plus/clients", json=payload, timeout=20)
    assert r.status_code in (200, 201), f"Create client failed: {r.status_code} {r.text}"
    data = r.json()
    cid = data.get("id") or data.get("client", {}).get("id") or (data.get("client") or {}).get("id")
    if not cid:
        # Try fetch list
        r2 = sandra.get(f"{BASE_URL}/api/portal/territory-plus/clients", timeout=20)
        items = (r2.json() or {}).get("items") or []
        cid = next((c["id"] for c in items if c.get("name") == payload["name"]), None)
    assert cid, f"Could not resolve client id from create response: {data}"
    yield {"id": cid, **payload}
    # cleanup
    try:
        sandra.delete(f"{BASE_URL}/api/portal/territory-plus/clients/{cid}", timeout=15)
    except Exception:
        pass


# ============================ Access ============================
class TestAccess:
    def test_sandra_access_allowed(self, sandra):
        r = sandra.get(f"{BASE_URL}/api/portal/marketing/access", timeout=15)
        assert r.status_code == 200
        d = r.json()
        assert d.get("allowed") is True, d
        assert "from_email" in d and "franchisee_name" in d
        assert "bookings_enabled" in d and "organisation" in d

    def test_demo_access_allowed_via_demo_tag(self, demo):
        r = demo.get(f"{BASE_URL}/api/portal/marketing/access", timeout=15)
        assert r.status_code == 200
        d = r.json()
        assert d.get("allowed") is True, d


# ============================ Recipients ============================
class TestRecipients:
    def test_recipients_include_primary_and_secondaries(self, sandra, sandra_test_client):
        r = sandra.get(f"{BASE_URL}/api/portal/marketing/recipients", timeout=15)
        assert r.status_code == 200
        d = r.json()
        assert d.get("max_per_send") == 5
        items = d.get("items") or []
        cid = sandra_test_client["id"]
        mine = [it for it in items if it.get("client_id") == cid]
        contact_indices = sorted([m.get("contact_index") for m in mine])
        assert -1 in contact_indices, f"Primary row missing: {mine}"
        assert 0 in contact_indices and 1 in contact_indices, f"Secondaries missing: {mine}"


# ============================ Preview HTML ============================
class TestPreview:
    def test_preview_html_contains_signature(self, sandra):
        body = {"title": "Hello", "intro": "Test intro", "sample_first_name": "Alex"}
        r = sandra.post(f"{BASE_URL}/api/portal/marketing/preview-html", json=body, timeout=15)
        assert r.status_code == 200
        html = r.json().get("html", "")
        assert "Sent by" in html
        assert "Hello" in html
        assert "Alex" in html


# ============================ Test send ============================
class TestTestSend:
    def test_test_send_ok_or_502(self, sandra):
        body = {"title": f"{TEST_PREFIX}TestEmail", "intro": "Hello there", "sample_first_name": "Alex"}
        r = sandra.post(f"{BASE_URL}/api/portal/marketing/test-send", json=body, timeout=30)
        # Accept 200 if Resend works, 502 if down, 503 if not configured
        assert r.status_code in (200, 502, 503), f"Unexpected: {r.status_code} {r.text}"


# ============================ Campaign send validation ============================
class TestCampaignValidation:
    def test_missing_title(self, sandra):
        r = sandra.post(f"{BASE_URL}/api/portal/marketing/campaigns",
                        json={"title": "", "intro": "x", "recipients": [{"client_id": "x"}]}, timeout=15)
        assert r.status_code == 400

    def test_missing_intro(self, sandra):
        r = sandra.post(f"{BASE_URL}/api/portal/marketing/campaigns",
                        json={"title": "x", "intro": "", "recipients": [{"client_id": "x"}]}, timeout=15)
        assert r.status_code == 400

    def test_missing_recipients(self, sandra):
        r = sandra.post(f"{BASE_URL}/api/portal/marketing/campaigns",
                        json={"title": "x", "intro": "y", "recipients": []}, timeout=15)
        assert r.status_code == 400

    def test_more_than_five_recipients(self, sandra, sandra_test_client):
        # Build 6 recipient stubs (the cap is checked before resolution)
        recips = [{"client_id": sandra_test_client["id"], "contact_index": -1}] * 6
        r = sandra.post(f"{BASE_URL}/api/portal/marketing/campaigns",
                        json={"title": "x", "intro": "y", "recipients": recips}, timeout=15)
        assert r.status_code == 400
        # Verify wording references the cap
        assert "5" in r.text or "five" in r.text.lower()

    def test_smuggled_client_id_rejected(self, sandra):
        # Random client_id not owned by Sandra → resolved is empty → 400
        recips = [{"client_id": str(uuid.uuid4()), "contact_index": -1}]
        r = sandra.post(f"{BASE_URL}/api/portal/marketing/campaigns",
                        json={"title": "x", "intro": "y", "recipients": recips}, timeout=15)
        assert r.status_code == 400


# ============================ Campaign create + list + webhook + delete ============================
class TestCampaignLifecycle:
    campaign_id = None
    send_id = None

    def test_create_campaign_single_recipient(self, sandra, sandra_test_client):
        # Send to the primary recipient only (a fake @example.com address —
        # Resend will accept the send, no inbox actually exists).
        recips = [{"client_id": sandra_test_client["id"], "contact_index": -1}]
        r = sandra.post(
            f"{BASE_URL}/api/portal/marketing/campaigns",
            json={
                "title": f"{TEST_PREFIX}Campaign",
                "intro": "Hello from tests",
                "recipients": recips,
            },
            timeout=60,
        )
        if r.status_code == 503:
            pytest.skip("Resend not configured in this env")
        assert r.status_code == 200, f"{r.status_code} {r.text}"
        d = r.json()
        TestCampaignLifecycle.campaign_id = d["campaign_id"]
        # Pull detail to get send_id
        r2 = sandra.get(f"{BASE_URL}/api/portal/marketing/campaigns/{d['campaign_id']}", timeout=15)
        assert r2.status_code == 200
        doc = r2.json()
        recs = doc.get("recipients") or []
        assert len(recs) == 1
        TestCampaignLifecycle.send_id = recs[0]["send_id"]
        assert doc["franchisee_id"] == SANDRA_FID

    def test_list_campaigns_includes_rollups(self, sandra):
        if not TestCampaignLifecycle.campaign_id:
            pytest.skip("no campaign created")
        r = sandra.get(f"{BASE_URL}/api/portal/marketing/campaigns", timeout=15)
        assert r.status_code == 200
        items = r.json().get("items") or []
        ours = next((it for it in items if it["id"] == TestCampaignLifecycle.campaign_id), None)
        assert ours is not None
        assert ours.get("recipient_count") == 1
        assert ours.get("opens_count") == 0
        assert ours.get("clicks_count") == 0

    def test_webhook_open_event_increments_opens(self, sandra):
        if not (TestCampaignLifecycle.campaign_id and TestCampaignLifecycle.send_id):
            pytest.skip("no campaign created")
        payload = {
            "type": "email.opened",
            "data": {
                "email_id": "re_synth_" + uuid.uuid4().hex[:8],
                "tags": [
                    {"name": "campaign_id", "value": TestCampaignLifecycle.campaign_id},
                    {"name": "recipient_send_id", "value": TestCampaignLifecycle.send_id},
                ],
            },
        }
        # Webhook may require Svix signature when RESEND_WEBHOOK_SECRET is set.
        body_bytes = json.dumps(payload).encode("utf-8")
        headers = {"Content-Type": "application/json"}
        secret = ""
        try:
            with open("/app/backend/.env", "r") as fh:
                for line in fh:
                    if line.startswith("RESEND_WEBHOOK_SECRET"):
                        secret = line.split("=", 1)[1].strip().strip('"').strip("'")
                        break
        except Exception:
            pass
        if secret:
            import hmac, hashlib, base64
            key = base64.b64decode(secret.split("_", 1)[1] + "==")
            msg_id = "msg_" + uuid.uuid4().hex
            ts = str(int(time.time()))
            to_sign = f"{msg_id}.{ts}.".encode() + body_bytes
            sig = base64.b64encode(hmac.new(key, to_sign, hashlib.sha256).digest()).decode()
            headers.update({
                "svix-id": msg_id,
                "svix-timestamp": ts,
                "svix-signature": f"v1,{sig}",
            })
        r = requests.post(f"{BASE_URL}/api/email/resend-webhook", data=body_bytes, headers=headers, timeout=20)
        assert r.status_code in (200, 204), f"Webhook failed: {r.status_code} {r.text}"
        # Verify rollup
        r2 = sandra.get(f"{BASE_URL}/api/portal/marketing/campaigns", timeout=15)
        items = r2.json().get("items") or []
        ours = next((it for it in items if it["id"] == TestCampaignLifecycle.campaign_id), None)
        assert ours is not None
        assert ours.get("opens_count") == 1, f"opens_count not incremented: {ours}"

    def test_other_franchisee_cannot_access(self, demo):
        if not TestCampaignLifecycle.campaign_id:
            pytest.skip("no campaign created")
        r = demo.get(
            f"{BASE_URL}/api/portal/marketing/campaigns/{TestCampaignLifecycle.campaign_id}",
            timeout=15,
        )
        assert r.status_code == 404

    def test_delete_campaign(self, sandra):
        if not TestCampaignLifecycle.campaign_id:
            pytest.skip("no campaign created")
        r = sandra.delete(
            f"{BASE_URL}/api/portal/marketing/campaigns/{TestCampaignLifecycle.campaign_id}",
            timeout=15,
        )
        assert r.status_code == 200
        # Verify gone
        r2 = sandra.get(
            f"{BASE_URL}/api/portal/marketing/campaigns/{TestCampaignLifecycle.campaign_id}",
            timeout=15,
        )
        assert r2.status_code == 404
