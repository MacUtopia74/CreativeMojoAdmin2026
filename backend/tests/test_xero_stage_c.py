"""Stage C — Xero integration graceful-failure tests + inline Production-status PATCH.

Xero is intentionally UNCONFIGURED in this environment (no XERO_CLIENT_ID/SECRET/
REDIRECT_URI/WEBHOOK_SIGNING_KEY). The Xero routes must therefore return clear
400/401s instead of crashing with a 500.

Also exercises PATCH /api/orders/{id} for the inline Production-status dropdown
on the Orders Active tab.
"""
import os
import time
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "https://licensee-vault.preview.emergentagent.com").rstrip("/")
ADMIN_EMAIL = os.environ.get("ADMIN_EMAIL", "admin@creativemojo.co.uk")
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "CreativeMojo2026!")
PRODUCTION_STATUSES = [
    "Awaiting Assembly",
    "In Production",
    "Awaiting Labels",
    "Ready To Ship",
    "Complete",
]


# --- Fixtures -----------------------------------------------------------------
@pytest.fixture(scope="module")
def admin_session():
    s = requests.Session()
    r = s.post(
        f"{BASE_URL}/api/auth/login",
        json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
        timeout=20,
    )
    if r.status_code != 200:
        pytest.skip(f"Admin login failed: {r.status_code} {r.text[:200]}")
    return s


@pytest.fixture(scope="module")
def sample_order_id(admin_session):
    """Find any existing order to use for PATCH tests."""
    r = admin_session.get(f"{BASE_URL}/api/orders?limit=5", timeout=20)
    if r.status_code != 200:
        pytest.skip(f"/api/orders not available: {r.status_code}")
    data = r.json()
    items = data.get("items") or data.get("orders") or data if isinstance(data, list) else []
    if isinstance(data, dict):
        items = data.get("items") or data.get("orders") or []
    if not items:
        pytest.skip("No orders available to PATCH")
    return items[0].get("id")


# --- Xero graceful-failure tests ---------------------------------------------
class TestXeroUnconfigured:
    def test_status_returns_configured_false(self, admin_session):
        r = admin_session.get(f"{BASE_URL}/api/xero/status", timeout=15)
        assert r.status_code == 200, r.text
        data = r.json()
        assert data.get("configured") is False
        assert data.get("connected") is False
        # redirect_uri may be None when env missing
        assert "redirect_uri" in data

    def test_connect_returns_400_when_unconfigured(self, admin_session):
        r = admin_session.get(f"{BASE_URL}/api/xero/connect", timeout=15)
        assert r.status_code == 400, r.text
        detail = r.json().get("detail", "")
        assert "XERO_CLIENT_ID" in detail or "not configured" in detail.lower()

    def test_contacts_returns_400_when_not_connected(self, admin_session):
        r = admin_session.get(f"{BASE_URL}/api/xero/contacts", timeout=15)
        assert r.status_code == 400, r.text
        detail = r.json().get("detail", "")
        assert "not connected" in detail.lower() or "not configured" in detail.lower()

    def test_create_invoice_returns_400_when_not_connected(self, admin_session, sample_order_id):
        r = admin_session.post(
            f"{BASE_URL}/api/xero/orders/{sample_order_id}/create-invoice",
            timeout=15,
        )
        assert r.status_code == 400, r.text
        detail = r.json().get("detail", "")
        assert "not connected" in detail.lower()
        assert "settings" in detail.lower() or "connect" in detail.lower()

    def test_webhook_returns_401_when_no_signing_key(self):
        # Webhook is intentionally public — no auth needed.
        r = requests.post(
            f"{BASE_URL}/api/xero/webhook",
            data=b'{"events":[]}',
            headers={"Content-Type": "application/json", "x-xero-signature": "AAAA"},
            timeout=15,
        )
        assert r.status_code == 401, f"Expected 401, got {r.status_code}: {r.text[:200]}"


# --- Production-status PATCH tests -------------------------------------------
class TestProductionStatusPatch:
    def test_patch_accepts_awaiting_labels(self, admin_session, sample_order_id):
        # Sanity GET — confirms the order exists. The `finally` block
        # below always resets the order to "Ready To Ship" per the task
        # contract, so we don't need to capture the original status.
        admin_session.get(f"{BASE_URL}/api/orders/{sample_order_id}", timeout=15)

        try:
            r = admin_session.patch(
                f"{BASE_URL}/api/orders/{sample_order_id}",
                json={"production_status": "Awaiting Labels"},
                timeout=15,
            )
            assert r.status_code == 200, r.text
            body = r.json()
            assert body.get("ok") is True
            order = body.get("order") or {}
            assert order.get("production_status") == "Awaiting Labels"

            # GET to verify persistence
            g = admin_session.get(f"{BASE_URL}/api/orders/{sample_order_id}", timeout=15)
            assert g.status_code == 200
            fetched = g.json()
            fetched_order = fetched.get("order") or fetched
            assert fetched_order.get("production_status") == "Awaiting Labels"
        finally:
            # Always reset to Ready To Ship per the task instructions
            admin_session.patch(
                f"{BASE_URL}/api/orders/{sample_order_id}",
                json={"production_status": "Ready To Ship"},
                timeout=15,
            )

    @pytest.mark.parametrize("status", PRODUCTION_STATUSES)
    def test_patch_accepts_all_five_statuses(self, admin_session, sample_order_id, status):
        r = admin_session.patch(
            f"{BASE_URL}/api/orders/{sample_order_id}",
            json={"production_status": status},
            timeout=15,
        )
        assert r.status_code == 200, f"status={status} -> {r.status_code}: {r.text[:200]}"
        body = r.json()
        assert body.get("ok") is True
        assert (body.get("order") or {}).get("production_status") == status

    def test_cleanup_restore_ready_to_ship(self, admin_session, sample_order_id):
        r = admin_session.patch(
            f"{BASE_URL}/api/orders/{sample_order_id}",
            json={"production_status": "Ready To Ship"},
            timeout=15,
        )
        assert r.status_code == 200
        assert (r.json().get("order") or {}).get("production_status") == "Ready To Ship"
