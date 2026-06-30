"""Iteration 38 - File Vault search hardening (Cloudflare 520 fix).

Verifies /api/files/search:
- Franchisee + admin login work
- Various query shapes return HTTP 200 with valid JSON envelope
- Never returns 5xx (the cause of CF 520)
- Folder-scoped search regression
- Validation (q < 2 chars) returns 422, not 5xx
"""
import os
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")
if not BASE_URL:
    # fall back to frontend .env which the test runner can read
    with open("/app/frontend/.env") as fh:
        for line in fh:
            if line.startswith("REACT_APP_BACKEND_URL="):
                BASE_URL = line.strip().split("=", 1)[1].rstrip("/")

ADMIN = ("admin@creativemojo.co.uk", "CreativeMojo2026!")
FRANCHISEE = ("franchisee.tester@creativemojo.co.uk", "FranchiseeTest2026!")

ENVELOPE_KEYS = {"items", "files", "folders", "count"}


# ---------- helpers ----------
def _login(email, password):
    s = requests.Session()
    r = s.post(
        f"{BASE_URL}/api/auth/login",
        json={"email": email, "password": password},
        timeout=20,
    )
    assert r.status_code == 200, f"login failed for {email}: {r.status_code} {r.text[:200]}"
    body = r.json()
    token = body.get("access_token") or body.get("token")
    if token:
        s.headers.update({"Authorization": f"Bearer {token}"})
    return s


@pytest.fixture(scope="module")
def admin_client():
    return _login(*ADMIN)


@pytest.fixture(scope="module")
def franchisee_client():
    return _login(*FRANCHISEE)


def _assert_envelope(body):
    assert isinstance(body, dict), f"body not a dict: {type(body)}"
    missing = ENVELOPE_KEYS - set(body.keys())
    assert not missing, f"missing keys {missing} in body: {body}"
    assert isinstance(body["items"], list)
    assert isinstance(body["files"], list)
    assert isinstance(body["folders"], list)
    assert isinstance(body["count"], int)


# ---------- franchisee tests (the bug repro) ----------
class TestFranchiseeSearch:
    def test_armed_forces_day_no_5xx(self, franchisee_client):
        """The exact query string that produced the CF 520 in production."""
        r = franchisee_client.get(
            f"{BASE_URL}/api/files/search",
            params={"q": "Armed Forces Day", "limit": 200},
            timeout=20,
        )
        assert r.status_code == 200, f"got {r.status_code}: {r.text[:300]}"
        _assert_envelope(r.json())

    def test_single_word_craft(self, franchisee_client):
        r = franchisee_client.get(
            f"{BASE_URL}/api/files/search", params={"q": "craft", "limit": 200}, timeout=20
        )
        assert r.status_code == 200
        _assert_envelope(r.json())

    def test_single_word_training(self, franchisee_client):
        r = franchisee_client.get(
            f"{BASE_URL}/api/files/search", params={"q": "training", "limit": 200}, timeout=20
        )
        assert r.status_code == 200
        _assert_envelope(r.json())

    def test_multi_word_shared_brand(self, franchisee_client):
        r = franchisee_client.get(
            f"{BASE_URL}/api/files/search",
            params={"q": "shared brand", "limit": 200},
            timeout=20,
        )
        assert r.status_code == 200
        _assert_envelope(r.json())

    def test_short_query_returns_422_not_5xx(self, franchisee_client):
        r = franchisee_client.get(
            f"{BASE_URL}/api/files/search", params={"q": "a"}, timeout=20
        )
        # Must be a structured 422 (Pydantic), never 5xx.
        assert r.status_code == 422, f"expected 422, got {r.status_code}: {r.text[:200]}"
        assert r.status_code < 500


# ---------- admin regression ----------
class TestAdminSearch:
    def test_admin_global_search(self, admin_client):
        r = admin_client.get(
            f"{BASE_URL}/api/files/search",
            params={"q": "Armed Forces Day", "limit": 200},
            timeout=20,
        )
        assert r.status_code == 200
        _assert_envelope(r.json())

    def test_admin_simple_query(self, admin_client):
        r = admin_client.get(
            f"{BASE_URL}/api/files/search", params={"q": "training"}, timeout=20
        )
        assert r.status_code == 200
        _assert_envelope(r.json())

    def test_admin_folder_scoped_search(self, admin_client):
        """Regression: folder-scoped search continues to work."""
        # Discover a folder prefix from the admin tree listing
        tree = admin_client.get(f"{BASE_URL}/api/files/tree", timeout=20)
        folder_prefix = None
        if tree.status_code == 200:
            body = tree.json()
            folders = body.get("folders") or []
            if folders:
                folder_prefix = folders[0].get("prefix") or folders[0].get("path")
        if not folder_prefix:
            # fall back: just pass an arbitrary prefix; endpoint must still 200.
            folder_prefix = "brand/"
        r = admin_client.get(
            f"{BASE_URL}/api/files/search",
            params={"q": "a4", "prefix": folder_prefix, "limit": 50},
            timeout=20,
        )
        assert r.status_code == 200, f"folder-scoped search failed: {r.status_code} {r.text[:200]}"
        body = r.json()
        _assert_envelope(body)
        # If any items returned, every key must start with folder_prefix
        for it in body["items"]:
            k = it.get("key") or ""
            assert k.startswith(folder_prefix.rstrip("/")), (
                f"folder scope violated: {k} not under {folder_prefix}"
            )


# ---------- additional adversarial inputs ----------
class TestAdversarialQueries:
    @pytest.mark.parametrize(
        "q",
        [
            "...",                      # punctuation only
            "  spaces  ",               # leading/trailing spaces
            "régulière",                # unicode
            "file.pdf",                 # dotted token
            "[bracket]",                # regex meta
            "$test^",                   # regex meta
            "a/b/c",                    # path-ish
            "🎉 party",                  # emoji
        ],
    )
    def test_no_5xx_on_weird_inputs(self, franchisee_client, q):
        r = franchisee_client.get(
            f"{BASE_URL}/api/files/search", params={"q": q, "limit": 50}, timeout=20
        )
        # Either 200 (handled) or 422 (validation). NEVER 5xx.
        assert r.status_code < 500, f"5xx on q={q!r}: {r.status_code} {r.text[:200]}"
        if r.status_code == 200:
            _assert_envelope(r.json())
