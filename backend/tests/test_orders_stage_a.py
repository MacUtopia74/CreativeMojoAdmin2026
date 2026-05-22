"""Regression tests for Phase 2 Stage A — WooCommerce orders read-only sync.

Covers:
1. ``GET /api/orders/counts`` returns the four expected buckets.
2. ``GET /api/orders?tab=active`` returns only non-terminal, non-draft rows.
3. ``GET /api/orders?tab=completed`` returns only ``status='completed'``.
4. ``GET /api/orders?search=...`` filters by customer / SKU / Woo number.
5. ``POST /api/intake/woocommerce`` rejects a request with no signature.
"""
import os

import requests

BASE_URL = os.environ["REACT_APP_BACKEND_URL"].rstrip("/")
ADMIN_EMAIL = os.environ.get("ADMIN_EMAIL", "admin@creativemojo.co.uk")
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "CreativeMojo2026!")
def _login():
    s = requests.Session()
    r = s.post(f"{BASE_URL}/api/auth/login",
               json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD}, timeout=15)
    assert r.status_code == 200, r.text
    return s


def test_orders_counts_returns_four_buckets():
    s = _login()
    r = s.get(f"{BASE_URL}/api/orders/counts", timeout=15)
    assert r.status_code == 200, r.text
    body = r.json()
    for key in ("active", "completed", "draft", "all"):
        assert key in body, body
        assert isinstance(body[key], int)
    assert body["active"] >= 1, body
    assert body["all"] == body["active"] + body["completed"] + body["draft"]


def test_orders_active_tab_excludes_completed():
    s = _login()
    r = s.get(f"{BASE_URL}/api/orders?tab=active&limit=100", timeout=15)
    assert r.status_code == 200
    items = r.json()["items"]
    assert items, "active tab returned no orders"
    for it in items:
        assert it["status"] == "active", it
        assert not it.get("is_draft"), it


def test_orders_completed_tab_only_completed():
    s = _login()
    r = s.get(f"{BASE_URL}/api/orders?tab=completed&limit=100", timeout=15)
    assert r.status_code == 200
    items = r.json()["items"]
    for it in items:
        assert it["status"] == "completed", it


def test_orders_search_finds_customer():
    s = _login()
    r = s.get(f"{BASE_URL}/api/orders?tab=all&search=Haven&limit=10", timeout=15)
    assert r.status_code == 200
    items = r.json()["items"]
    assert any("Haven" in (it.get("customer_label") or "") for it in items), items


def test_woocommerce_webhook_rejects_unsigned_request():
    """Even with no signature header, webhook must return 401 — preventing
    forged orders being injected into our mirror."""
    r = requests.post(
        f"{BASE_URL}/api/intake/woocommerce",
        json={"id": 99999, "status": "processing", "billing": {}, "line_items": []},
        timeout=15,
    )
    assert r.status_code == 401, r.text


def test_products_autocomplete_returns_seed_data():
    s = _login()
    r = s.get(f"{BASE_URL}/api/woo/products/autocomplete?q=World&limit=10", timeout=15)
    assert r.status_code == 200, r.text
    items = r.json()["items"]
    assert any("World Cup" in (it.get("name") or "") for it in items), items
