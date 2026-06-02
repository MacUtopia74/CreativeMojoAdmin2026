"""Iteration 25 backend tests:
- PATCH /api/franchisees/:id/portal-modules accepts 'bookings' key (default false).
- GET /api/portal/me returns portal_modules with 'bookings' backfilled.
- POST /api/orders persists customer contact info (phone, first_name, last_name, billing dict).
- GET /api/orders/{id} returns the persisted contact info.
- 'Make Ex-Licensee' relies on franchisee tag 'Worldwide Licencee' — sanity check the tag exists
  on at least one franchisee (or can be added) so the UI test can find a target.
"""
import os
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "https://licensee-vault.preview.emergentagent.com").rstrip("/")
ADMIN_EMAIL = "admin@creativemojo.co.uk"
ADMIN_PASSWORD = "CreativeMojo2026!"
SANDRA_FRANCHISEE_ID = "b2ca2c54-7101-4524-926a-b36ac0e2a70a"
DEMO_FRANCHISEE_EMAIL = "demo@creativemojo.co.uk"
DEMO_FRANCHISEE_PASSWORD = "CreativeMojoDemo2026!"


@pytest.fixture(scope="session")
def admin_session():
    s = requests.Session()
    r = s.post(f"{BASE_URL}/api/auth/login",
               json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
               timeout=20)
    assert r.status_code == 200, f"Admin login failed: {r.status_code} {r.text[:200]}"
    return s


@pytest.fixture(scope="session")
def demo_session():
    s = requests.Session()
    r = s.post(f"{BASE_URL}/api/auth/login",
               json={"email": DEMO_FRANCHISEE_EMAIL, "password": DEMO_FRANCHISEE_PASSWORD},
               timeout=20)
    if r.status_code != 200:
        pytest.skip(f"Demo login not available: {r.status_code}")
    return s


# ---------------------------------------------------------------------------
# Portal modules — bookings toggle
# ---------------------------------------------------------------------------
class TestPortalModulesBookings:
    def test_patch_bookings_true_then_false(self, admin_session):
        # Toggle bookings ON for Sandra's franchisee
        r = admin_session.patch(
            f"{BASE_URL}/api/franchisees/{SANDRA_FRANCHISEE_ID}/portal-modules",
            json={"bookings": True}, timeout=15,
        )
        assert r.status_code == 200, f"PATCH failed: {r.status_code} {r.text[:300]}"
        data = r.json()
        assert data.get("ok") is True
        modules = data.get("portal_modules") or {}
        assert "bookings" in modules, "Response must include 'bookings' key"
        assert modules["bookings"] is True

        # Sanity: still has the four core+plus modules
        for key in ("map", "calendar", "files", "territory_plus", "marketing", "invoicing"):
            assert key in modules, f"Missing key {key}"

        # Toggle OFF — cleanup (reset state per agent instructions)
        r2 = admin_session.patch(
            f"{BASE_URL}/api/franchisees/{SANDRA_FRANCHISEE_ID}/portal-modules",
            json={"bookings": False}, timeout=15,
        )
        assert r2.status_code == 200
        assert r2.json()["portal_modules"]["bookings"] is False

    def test_patch_ignores_unknown_keys(self, admin_session):
        r = admin_session.patch(
            f"{BASE_URL}/api/franchisees/{SANDRA_FRANCHISEE_ID}/portal-modules",
            json={"bookings": False, "nonsense_key": True}, timeout=15,
        )
        assert r.status_code == 200
        modules = r.json()["portal_modules"]
        assert "nonsense_key" not in modules


class TestPortalMeBackfill:
    def test_portal_me_includes_bookings(self, demo_session):
        r = demo_session.get(f"{BASE_URL}/api/portal/me", timeout=15)
        assert r.status_code == 200, f"/portal/me failed: {r.status_code} {r.text[:200]}"
        body = r.json()
        # /portal/me returns {profile: {...}, user: {...}} — portal_modules lives under profile
        profile = body.get("profile") or body
        modules = profile.get("portal_modules") or {}
        # The key must exist regardless of value
        assert "bookings" in modules, f"portal_modules missing 'bookings': {modules}"
        assert isinstance(modules["bookings"], bool)


# ---------------------------------------------------------------------------
# Orders — manual create with contact info
# ---------------------------------------------------------------------------
class TestOrdersManualCreate:
    created_ids = []

    def test_create_order_with_billing(self, admin_session):
        payload = {
            "customer_label": "QA Test Customer Iter25",
            "customer_email": "qatest+iter25@example.com",
            "customer_phone": "+44 7700 900123",
            "first_name": "Quinn",
            "last_name": "Tester",
            "billing": {
                "first_name": "Quinn",
                "last_name": "Tester",
                "phone": "+44 7700 900123",
                "address_1": "10 Test Street",
                "address_2": "Suite 5",
                "city": "London",
                "postcode": "SW1A 1AA",
                "country": "GB",
            },
            "line_items": [
                {"name": "QA Sample Product", "quantity": 1, "subtotal": "10.00"}
            ],
        }
        r = admin_session.post(f"{BASE_URL}/api/orders", json=payload, timeout=20)
        assert r.status_code == 200, f"POST /api/orders failed: {r.status_code} {r.text[:300]}"
        data = r.json()
        assert data.get("ok") is True
        oid = data.get("id")
        assert oid, f"No id in response: {data}"
        TestOrdersManualCreate.created_ids.append(oid)

        order = data.get("order") or {}
        assert order.get("customer_phone") == "+44 7700 900123"
        billing = order.get("billing") or {}
        assert billing.get("first_name") == "Quinn"
        assert billing.get("last_name") == "Tester"
        assert billing.get("phone") == "+44 7700 900123"
        assert billing.get("address_1") == "10 Test Street"
        assert billing.get("address_2") == "Suite 5"
        assert billing.get("city") == "London"
        assert billing.get("postcode") == "SW1A 1AA"
        assert billing.get("country") == "GB"

    def test_get_order_returns_persisted_billing(self, admin_session):
        assert TestOrdersManualCreate.created_ids, "No order created in prior test"
        oid = TestOrdersManualCreate.created_ids[-1]
        r = admin_session.get(f"{BASE_URL}/api/orders/{oid}", timeout=15)
        assert r.status_code == 200, f"GET order failed: {r.status_code} {r.text[:200]}"
        order = r.json()
        assert order.get("customer_phone") == "+44 7700 900123"
        billing = order.get("billing") or {}
        assert billing.get("first_name") == "Quinn"
        assert billing.get("last_name") == "Tester"
        assert billing.get("address_1") == "10 Test Street"
        assert billing.get("address_2") == "Suite 5"
        assert billing.get("city") == "London"
        assert billing.get("postcode") == "SW1A 1AA"
        assert billing.get("country") == "GB"

    def test_create_order_without_billing_still_works(self, admin_session):
        """Backward compat: existing minimal payload still creates an order."""
        payload = {
            "customer_label": "QA Test Customer Minimal Iter25",
            "line_items": [{"name": "Minimal", "quantity": 1, "subtotal": "5.00"}],
        }
        r = admin_session.post(f"{BASE_URL}/api/orders", json=payload, timeout=20)
        assert r.status_code == 200
        oid = r.json().get("id")
        assert oid
        TestOrdersManualCreate.created_ids.append(oid)


# ---------------------------------------------------------------------------
# Worldwide Licencee tag — locate a franchisee for the UI test
# ---------------------------------------------------------------------------
class TestWorldwideLicenseeTag:
    def test_find_or_tag_worldwide_licencee(self, admin_session):
        # Search franchisees for one already carrying the tag
        r = admin_session.get(f"{BASE_URL}/api/franchisees", timeout=20)
        assert r.status_code == 200, f"/franchisees list failed: {r.status_code}"
        data = r.json()
        # Endpoint may return list or {items: [...]}
        items = data if isinstance(data, list) else (data.get("items") or data.get("franchisees") or [])
        licensees = [f for f in items if isinstance(f, dict)
                     and "Worldwide Licencee" in (f.get("tags") or [])]
        if licensees:
            assert licensees[0].get("id"), "Found licensee but no id"
            print(f"Existing licensee id={licensees[0].get('id')} name={licensees[0].get('name')}")
        else:
            # Skip — main agent / UI test can add the tag manually.
            pytest.skip("No franchisee currently carries 'Worldwide Licencee' tag — "
                        "frontend test must add the tag or use a known licensee id.")
