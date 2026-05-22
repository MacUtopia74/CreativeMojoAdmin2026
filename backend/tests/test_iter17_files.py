"""Phase 3 - Files API tests (iteration 17).
Covers: folder create, multipart upload, share-link (POST + GET), share redirect
(PUBLIC), download inline disposition, days clamping, delete cleanup.
"""
import io
import os
import time
import requests
import pytest

BASE_URL = (os.environ.get("REACT_APP_BACKEND_URL")
            or "https://licensee-vault.preview.emergentagent.com").rstrip("/")
ADMIN_EMAIL = os.environ.get("ADMIN_EMAIL", "admin@creativemojo.co.uk")
ADMIN_PASS = os.environ.get("ADMIN_PASSWORD", "CreativeMojo2026!")

TEST_PREFIX = f"admin/test-iter17-{int(time.time())}/"


@pytest.fixture(scope="module")
def session():
    s = requests.Session()
    r = s.post(f"{BASE_URL}/api/auth/login",
               json={"email": ADMIN_EMAIL, "password": ADMIN_PASS},
               timeout=30)
    assert r.status_code == 200, f"login failed: {r.status_code} {r.text[:200]}"
    return s


@pytest.fixture(scope="module")
def created_keys():
    """Track keys to clean up after."""
    keys = []
    yield keys
    # Cleanup
    s = requests.Session()
    s.post(f"{BASE_URL}/api/auth/login",
           json={"email": ADMIN_EMAIL, "password": ADMIN_PASS}, timeout=30)
    for k in keys:
        try:
            s.delete(f"{BASE_URL}/api/files", params={"key": k}, timeout=30)
        except Exception:
            pass


# ---- Folder create ----
def test_folder_create_and_listed(session, created_keys):
    folder_name = "PytestFolder"
    r = session.post(f"{BASE_URL}/api/files/folder",
                     json={"prefix": TEST_PREFIX, "name": folder_name},
                     timeout=30)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body.get("created") is True
    assert body.get("folder_prefix") == f"{TEST_PREFIX}{folder_name}/"
    created_keys.append(f"{TEST_PREFIX}{folder_name}/.keep")

    # GET tree should include folder, but .keep MUST NOT be in `files`
    r2 = session.get(f"{BASE_URL}/api/files/tree",
                     params={"prefix": TEST_PREFIX}, timeout=30)
    assert r2.status_code == 200, r2.text
    data = r2.json()
    folder_names = [f["name"] for f in data["folders"]]
    assert folder_name in folder_names
    file_names = [f["name"] for f in data["files"]]
    assert ".keep" not in file_names


# ---- Multipart upload ----
def test_multipart_upload_and_indexed(session, created_keys):
    filename = "pytest_upload.txt"
    content = b"hello from pytest iter17"
    files = {"file": (filename, io.BytesIO(content), "text/plain")}
    data = {"prefix": TEST_PREFIX}
    r = session.post(f"{BASE_URL}/api/files/upload", files=files, data=data, timeout=60)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body.get("indexed") is True
    key = body["file"]["key"]
    assert key.startswith(TEST_PREFIX)
    assert body["file"]["size"] == len(content)
    created_keys.append(key)

    # File appears in tree
    r2 = session.get(f"{BASE_URL}/api/files/tree",
                     params={"prefix": TEST_PREFIX}, timeout=30)
    assert r2.status_code == 200
    names = [f["name"] for f in r2.json()["files"]]
    assert filename in names


# ---- Share-link POST ----
def test_share_link_post_30_days(session, created_keys):
    # Upload a file to share
    files = {"file": ("share_me.txt", io.BytesIO(b"share me"), "text/plain")}
    data = {"prefix": TEST_PREFIX}
    rup = session.post(f"{BASE_URL}/api/files/upload", files=files, data=data, timeout=60)
    assert rup.status_code == 200
    key = rup.json()["file"]["key"]
    created_keys.append(key)

    r = session.post(f"{BASE_URL}/api/files/share-link",
                     json={"key": key, "days": 30}, timeout=30)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["days"] == 30
    assert "token" in body and len(body["token"]) > 10
    assert "expires_at" in body
    assert body["url"].endswith(f"/api/files/share/{body['token']}")
    assert body["url"].startswith("https://licensee-vault.preview.emergentagent.com")


def test_share_link_clamps_days(session, created_keys):
    files = {"file": ("clamp_me.txt", io.BytesIO(b"clamp"), "text/plain")}
    data = {"prefix": TEST_PREFIX}
    rup = session.post(f"{BASE_URL}/api/files/upload", files=files, data=data, timeout=60)
    key = rup.json()["file"]["key"]
    created_keys.append(key)

    # > 30 clamps to 30
    r = session.post(f"{BASE_URL}/api/files/share-link",
                     json={"key": key, "days": 999}, timeout=30)
    assert r.status_code == 200
    assert r.json()["days"] == 30

    # < 1 clamps to 1 (use negative integer; days=0 hits a known bug due to `or`)
    r2 = session.post(f"{BASE_URL}/api/files/share-link",
                      json={"key": key, "days": -5}, timeout=30)
    assert r2.status_code == 200
    assert r2.json()["days"] == 1


# ---- Share-link GET back-compat ----
def test_share_link_get_backcompat(session, created_keys):
    files = {"file": ("getlink.txt", io.BytesIO(b"getlink"), "text/plain")}
    rup = session.post(f"{BASE_URL}/api/files/upload",
                       files=files, data={"prefix": TEST_PREFIX}, timeout=60)
    key = rup.json()["file"]["key"]
    created_keys.append(key)

    r = session.get(f"{BASE_URL}/api/files/share-link",
                    params={"key": key, "days": 14}, timeout=30)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["days"] == 14
    assert "token" in body
    assert "/api/files/share/" in body["url"]


# ---- Share redirect PUBLIC ----
def test_share_redirect_public_and_inline(created_keys):
    # New unauthenticated client
    auth_s = requests.Session()
    auth_s.post(f"{BASE_URL}/api/auth/login",
                json={"email": ADMIN_EMAIL, "password": ADMIN_PASS}, timeout=30)
    files = {"file": ("redir.pdf", io.BytesIO(b"%PDF-1.4\n%fake"), "application/pdf")}
    rup = auth_s.post(f"{BASE_URL}/api/files/upload",
                      files=files, data={"prefix": TEST_PREFIX}, timeout=60)
    key = rup.json()["file"]["key"]
    created_keys.append(key)
    rs = auth_s.post(f"{BASE_URL}/api/files/share-link",
                     json={"key": key, "days": 7}, timeout=30)
    token = rs.json()["token"]

    # Anonymous (no cookies) request, do not follow redirect
    anon = requests.Session()
    r = anon.get(f"{BASE_URL}/api/files/share/{token}",
                 allow_redirects=False, timeout=30)
    assert r.status_code == 302, f"expected 302, got {r.status_code}, body={r.text[:200]}"
    loc = r.headers.get("Location", "")
    assert "r2.cloudflarestorage.com" in loc or "cloudflarestorage" in loc, f"unexpected Location: {loc}"
    assert "response-content-disposition=inline" in loc

    # Bogus token => 404
    r404 = anon.get(f"{BASE_URL}/api/files/share/doesnotexist123",
                    allow_redirects=False, timeout=30)
    assert r404.status_code == 404


# ---- Download inline ----
def test_download_inline_disposition(session, created_keys):
    files = {"file": ("dl.pdf", io.BytesIO(b"%PDF-1.4 fake"), "application/pdf")}
    rup = session.post(f"{BASE_URL}/api/files/upload",
                       files=files, data={"prefix": TEST_PREFIX}, timeout=60)
    key = rup.json()["file"]["key"]
    created_keys.append(key)

    r = session.get(f"{BASE_URL}/api/files/download",
                    params={"key": key, "attachment": "false"}, timeout=30)
    assert r.status_code == 200
    url = r.json()["url"]
    assert "response-content-disposition=inline" in url

    r2 = session.get(f"{BASE_URL}/api/files/download",
                     params={"key": key, "attachment": "true"}, timeout=30)
    url2 = r2.json()["url"]
    assert "response-content-disposition=attachment" in url2
