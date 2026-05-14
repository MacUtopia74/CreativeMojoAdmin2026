"""Phase 1.5 — GoCardless integration tests.

Two test styles:
  - HTTP tests against the running supervisor backend (for happy-path live read)
  - In-process FastAPI TestClient tests for webhook HMAC verification
    (so we can mutate the webhook secret without touching the real env)
"""
import os
import hmac
import hashlib
import json
import sys
import asyncio
import pytest
import httpx
from dotenv import load_dotenv

load_dotenv("/app/backend/.env")
sys.path.insert(0, "/app/backend")

API = "http://localhost:8001/api"
EMAIL = os.environ.get("ADMIN_EMAIL", "admin@creativemojo.co.uk")
PASSWORD = os.environ.get("ADMIN_PASSWORD", "CreativeMojo2026!")


def _login_client() -> httpx.Client:
    """Return an OPEN httpx.Client with Bearer token. (We bypass the cookie
    flow because the backend sets `Secure` on cookies which httpx refuses to
    transmit over plain http://localhost.)"""
    c = httpx.Client(base_url=API, timeout=120)
    r = c.post("/auth/login", json={"email": EMAIL, "password": PASSWORD})
    assert r.status_code == 200, f"login failed: {r.status_code} {r.text}"
    # Extract the access_token from Set-Cookie headers
    token = None
    for sc in r.headers.get_list("set-cookie"):
        if sc.startswith("access_token="):
            token = sc.split("=", 1)[1].split(";", 1)[0]
            break
    assert token, f"no access_token cookie in login response: {r.headers}"
    c.headers["Authorization"] = f"Bearer {token}"
    return c


def test_gocardless_status_endpoint():
    c = _login_client()
    try:
        r = c.get("/gocardless/status")
        assert r.status_code == 200
        body = r.json()
        assert "configured" in body
        assert "environment" in body
        assert "webhook_secret_set" in body
    finally:
        c.close()


def test_gocardless_alerts_endpoint_default():
    c = _login_client()
    try:
        r = c.get("/gocardless/alerts")
        assert r.status_code == 200
        body = r.json()
        assert body["window_hours"] == 24
        assert "items" in body and isinstance(body["items"], list)
        for key in ("mandate_cancelled", "mandate_failed", "mandate_expired", "payment_failed"):
            assert key in body["by_type"]
    finally:
        c.close()


def test_gocardless_alerts_custom_window():
    c = _login_client()
    try:
        r = c.get("/gocardless/alerts", params={"hours": 168})
        assert r.status_code == 200
        assert r.json()["window_hours"] == 168
    finally:
        c.close()


def test_dry_run_sync_does_not_write():
    """Live read-only dry-run; tolerant of upstream API failure."""
    if not os.environ.get("GOCARDLESS_ACCESS_TOKEN"):
        pytest.skip("GOCARDLESS_ACCESS_TOKEN not configured")
    c = _login_client()
    try:
        r = c.post("/gocardless/mandates/sync", params={"dry_run": "true"}, timeout=180)
        if r.status_code == 502:
            pytest.skip(f"GoCardless API unavailable: {r.text}")
        assert r.status_code == 200, f"unexpected: {r.status_code} {r.text}"
        body = r.json()
        assert body["dry_run"] is True
        assert body["committed_count"] == 0, "dry-run must NOT write to DB"
        assert body["customers_scanned"] >= 0
        assert body["franchisees_total"] >= 0
    finally:
        c.close()


def test_webhook_missing_signature_rejected():
    """Public webhook endpoint — no auth needed; rejects without signature."""
    r = httpx.post(f"{API}/webhooks/gocardless", json={"events": []}, timeout=10)
    assert r.status_code == 498


# ---- In-process tests (so we can mutate the webhook secret) ---------------
@pytest.fixture(scope="module")
def app_client():
    """In-process FastAPI TestClient that lets us swap the webhook secret."""
    # Set the secret BEFORE importing server so the module reads it
    os.environ["GOCARDLESS_WEBHOOK_SECRET"] = "test_webhook_secret_iter16"
    # Reload gocardless_integration to pick up the new env var
    import importlib
    import gocardless_integration as gc_mod
    importlib.reload(gc_mod)
    # Reload server.py so the new router is wired
    if "server" in sys.modules:
        del sys.modules["server"]
    import server  # noqa: F401
    from fastapi.testclient import TestClient
    client = TestClient(server.app)
    yield client
    client.close()


def _sig(body: bytes, secret: str) -> str:
    return hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


def test_webhook_bad_signature_rejected(app_client):
    body = json.dumps({"events": []}).encode()
    r = app_client.post("/api/webhooks/gocardless", content=body,
                        headers={"Webhook-Signature": "deadbeef" * 8,
                                 "Content-Type": "application/json"})
    assert r.status_code == 498


def _run_async(coro):
    """Run an async coroutine using a fresh loop, properly closed."""
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()
        asyncio.set_event_loop(None)


def test_webhook_good_signature_processes_events(app_client):
    """Single test exercising BOTH a mandate_cancelled and a payment_failed
    event through the verified webhook path (consolidated to avoid module-scoped
    TestClient portal state across separate requests)."""
    payload = {
        "events": [
            {
                "id": "EV_TEST_iter16_cancel",
                "resource_type": "mandates",
                "action": "cancelled",
                "links": {"mandate": "MD_NONEXISTENT_iter16"},
                "details": {"cause": "bank_account_closed", "description": "Test"},
            },
            {
                "id": "EV_TEST_iter16_payfail",
                "resource_type": "payments",
                "action": "failed",
                "links": {"payment": "PM_X", "mandate": "MD_Y"},
                "details": {"cause": "insufficient_funds", "description": "no money"},
            },
        ]
    }
    body = json.dumps(payload).encode()
    r = app_client.post("/api/webhooks/gocardless", content=body,
                        headers={"Webhook-Signature": _sig(body, "test_webhook_secret_iter16"),
                                 "Content-Type": "application/json"})
    assert r.status_code == 200, r.text
    assert r.json()["processed"] == 2
    # Verify two alert rows were written
    from pymongo import MongoClient
    cli = MongoClient(os.environ["MONGO_URL"])
    db = cli[os.environ["DB_NAME"]]
    cancel_row = db.gocardless_alerts.find_one({"raw_event_id": "EV_TEST_iter16_cancel"})
    fail_row = db.gocardless_alerts.find_one({"raw_event_id": "EV_TEST_iter16_payfail"})
    # Cleanup BEFORE assertions so the DB stays clean even on failure
    db.gocardless_alerts.delete_many({"raw_event_id": {"$regex": "^EV_TEST_iter16"}})
    db.gocardless_events.delete_many({"events.id": {"$regex": "^EV_TEST_iter16"}})
    cli.close()
    assert cancel_row is not None
    assert cancel_row["type"] == "mandate_cancelled"
    assert cancel_row["cause"] == "bank_account_closed"
    assert fail_row is not None
    assert fail_row["type"] == "payment_failed"
    assert fail_row["cause"] == "insufficient_funds"
