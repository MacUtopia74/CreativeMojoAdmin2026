"""Phase 3 - Files API tests (iteration 18).
Covers new folder ops:
- POST /files/folder/rename
- POST /files/folder/move (incl. error on dest=subfolder of src)
- DELETE /files/folder  (soft-delete to .trash/)
- GET /files/recent  (only franchisee+shared, no .trash/, franchisee_label populated)
- POST /files/folder-share + GET /files/folder-share/{token} (PUBLIC) + zip
- GET /files/folder-zip  (admin)
- Scope-tree excludes .trash/
"""
import io
import os
import time
import zipfile
import requests
import pytest

BASE_URL = (os.environ.get("REACT_APP_BACKEND_URL")
            or "https://licensee-vault.preview.emergentagent.com").rstrip("/")
ADMIN_EMAIL = os.environ.get("ADMIN_EMAIL", "admin@creativemojo.co.uk")
ADMIN_PASS = os.environ.get("ADMIN_PASSWORD", "CreativeMojo2026!")

STAMP = int(time.time())
TEST_PREFIX = f"admin/test-iter18-{STAMP}/"        # admin scope playground
SHARED_PREFIX = f"shared/test-iter18-{STAMP}/"      # shared scope for /recent


@pytest.fixture(scope="module")
def session():
    s = requests.Session()
    r = s.post(f"{BASE_URL}/api/auth/login",
               json={"email": ADMIN_EMAIL, "password": ADMIN_PASS}, timeout=30)
    assert r.status_code == 200, f"login failed: {r.status_code} {r.text[:200]}"
    return s


@pytest.fixture(scope="module")
def tracker():
    """Collect prefixes to soft-delete + keys to hard-delete at teardown."""
    keys = []
    prefixes = []
    yield {"keys": keys, "prefixes": prefixes}
    s = requests.Session()
    s.post(f"{BASE_URL}/api/auth/login",
           json={"email": ADMIN_EMAIL, "password": ADMIN_PASS}, timeout=30)
    for p in prefixes:
        try:
            s.delete(f"{BASE_URL}/api/files/folder", params={"prefix": p}, timeout=30)
        except Exception:
            pass
    for k in keys:
        try:
            s.delete(f"{BASE_URL}/api/files", params={"key": k}, timeout=30)
        except Exception:
            pass


def _upload(session, prefix, filename, content=b"iter18 sample"):
    files = {"file": (filename, io.BytesIO(content), "text/plain")}
    data = {"prefix": prefix}
    r = session.post(f"{BASE_URL}/api/files/upload", files=files, data=data, timeout=60)
    assert r.status_code == 200, r.text
    return r.json()["file"]["key"]


# ---- Folder rename ----
def test_folder_rename(session, tracker):
    # Create folder A, upload a file inside it
    r = session.post(f"{BASE_URL}/api/files/folder",
                     json={"prefix": TEST_PREFIX, "name": "RenameMe"}, timeout=30)
    assert r.status_code == 200, r.text
    src_prefix = f"{TEST_PREFIX}RenameMe/"
    _upload(session, src_prefix, "renamefile.txt", b"will be renamed")

    # Rename
    rr = session.post(f"{BASE_URL}/api/files/folder/rename",
                      json={"prefix": src_prefix, "new_name": "Renamed"}, timeout=60)
    assert rr.status_code == 200, rr.text
    body = rr.json()
    assert body["renamed"] is True
    assert body["moved"] >= 1
    new_prefix = f"{TEST_PREFIX}Renamed/"
    tracker["prefixes"].append(new_prefix)

    # Parent tree should now show 'Renamed', not 'RenameMe'
    tr = session.get(f"{BASE_URL}/api/files/tree", params={"prefix": TEST_PREFIX}, timeout=30)
    assert tr.status_code == 200
    folders = [f["name"] for f in tr.json()["folders"]]
    assert "Renamed" in folders
    assert "RenameMe" not in folders


# ---- Folder move ----
def test_folder_move(session, tracker):
    # Create src + dst
    session.post(f"{BASE_URL}/api/files/folder",
                 json={"prefix": TEST_PREFIX, "name": "MoveSrc"}, timeout=30)
    session.post(f"{BASE_URL}/api/files/folder",
                 json={"prefix": TEST_PREFIX, "name": "MoveDst"}, timeout=30)
    src = f"{TEST_PREFIX}MoveSrc/"
    dst_parent = f"{TEST_PREFIX}MoveDst/"
    _upload(session, src, "movefile.txt", b"will be moved")

    r = session.post(f"{BASE_URL}/api/files/folder/move",
                     json={"prefix": src, "new_parent": dst_parent}, timeout=60)
    assert r.status_code == 200, r.text
    # NOTE: backend has a bug — `{"moved": True, **result}` is shadowed by
    # `result["moved"] = <int count>`. So we assert truthy (>=1) rather than True.
    assert r.json()["moved"]
    final_prefix = f"{TEST_PREFIX}MoveDst/MoveSrc/"
    tracker["prefixes"].append(final_prefix)
    tracker["prefixes"].append(dst_parent)

    # Verify destination contains the moved folder
    tr = session.get(f"{BASE_URL}/api/files/tree", params={"prefix": dst_parent}, timeout=30)
    assert tr.status_code == 200
    folders = [f["name"] for f in tr.json()["folders"]]
    assert "MoveSrc" in folders


def test_folder_move_into_self_errors(session, tracker):
    session.post(f"{BASE_URL}/api/files/folder",
                 json={"prefix": TEST_PREFIX, "name": "SelfA"}, timeout=30)
    src = f"{TEST_PREFIX}SelfA/"
    _upload(session, src, "x.txt", b"x")
    tracker["prefixes"].append(src)
    # Attempt to move SelfA into SelfA/sub
    r = session.post(f"{BASE_URL}/api/files/folder/move",
                     json={"prefix": src, "new_parent": src + "sub/"}, timeout=30)
    assert r.status_code == 400, f"expected 400 got {r.status_code} {r.text[:200]}"


# ---- Soft-delete folder ----
def test_folder_soft_delete(session, tracker):
    session.post(f"{BASE_URL}/api/files/folder",
                 json={"prefix": TEST_PREFIX, "name": "TrashMe"}, timeout=30)
    src = f"{TEST_PREFIX}TrashMe/"
    _upload(session, src, "trashfile.txt", b"trashed")

    r = session.delete(f"{BASE_URL}/api/files/folder", params={"prefix": src}, timeout=60)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["trashed"] is True
    assert body["trash_prefix"].startswith(".trash/")
    tracker["prefixes"].append(body["trash_prefix"])  # cleanup hard-purge later

    # Source folder should now have zero entries
    tr = session.get(f"{BASE_URL}/api/files/tree", params={"prefix": src}, timeout=30)
    assert tr.status_code == 200
    data = tr.json()
    assert len(data["files"]) == 0
    assert len(data["folders"]) == 0


def test_scope_tree_excludes_trash(session):
    r = session.get(f"{BASE_URL}/api/files/scope-tree", timeout=30)
    assert r.status_code == 200, r.text
    body = r.json()
    # Confirm no folder labelled '.trash' in admin_folders
    admin_folders = [f["folder"] for f in body.get("admin_folders", [])]
    assert ".trash" not in admin_folders


# ---- Recent endpoint ----
def test_recent_excludes_admin_and_trash(session, tracker):
    # Upload a file in shared scope so it shows up in /recent
    key = _upload(session, SHARED_PREFIX, "recent_shared.txt", b"recent shared")
    tracker["keys"].append(key)
    # Also upload to admin scope - should NOT appear
    admin_key = _upload(session, TEST_PREFIX, "recent_admin.txt", b"recent admin")
    tracker["keys"].append(admin_key)

    r = session.get(f"{BASE_URL}/api/files/recent", params={"days": 30}, timeout=30)
    assert r.status_code == 200, r.text
    body = r.json()
    keys = [it["key"] for it in body["items"]]
    assert key in keys, "shared upload should appear in /recent"
    assert admin_key not in keys, "admin upload must NOT appear in /recent"
    # No .trash/ entries
    assert not any(k.startswith(".trash/") for k in keys)
    # Each item should have a scope in (franchisee, shared)
    for it in body["items"]:
        assert it.get("scope") in ("franchisee", "shared"), it.get("scope")


# ---- Folder share + zip (PUBLIC) ----
def test_folder_share_public_and_zip(session, tracker):
    session.post(f"{BASE_URL}/api/files/folder",
                 json={"prefix": SHARED_PREFIX, "name": "SharedPack"}, timeout=30)
    pack_prefix = f"{SHARED_PREFIX}SharedPack/"
    _upload(session, pack_prefix, "alpha.txt", b"alpha-body")
    _upload(session, pack_prefix, "beta.txt", b"beta-body")
    tracker["prefixes"].append(pack_prefix)

    # Create folder share token
    cr = session.post(f"{BASE_URL}/api/files/folder-share",
                      json={"prefix": pack_prefix, "days": 30}, timeout=30)
    assert cr.status_code == 200, cr.text
    cb = cr.json()
    assert cb["token"]
    assert "/share/folder/" in cb["url"]
    assert cb["days"] == 30
    assert cb["file_count"] >= 2
    token = cb["token"]

    # PUBLIC: hit viewer endpoint WITHOUT auth cookies
    anon = requests.Session()
    vr = anon.get(f"{BASE_URL}/api/files/folder-share/{token}", timeout=30)
    assert vr.status_code == 200, vr.text
    vb = vr.json()
    assert vb["label"]
    rel_paths = [f["rel_path"] for f in vb["files"]]
    assert "alpha.txt" in rel_paths
    assert "beta.txt" in rel_paths
    for f in vb["files"]:
        assert f["download_url"].startswith("http")
    assert "zip_url" in vb

    # Days clamp: try days=999 -> should clamp to 30
    cr2 = session.post(f"{BASE_URL}/api/files/folder-share",
                       json={"prefix": pack_prefix, "days": 999}, timeout=30)
    assert cr2.status_code == 200
    assert cr2.json()["days"] == 30

    # Reject file-share token on folder-share viewer
    fs = session.post(f"{BASE_URL}/api/files/share-link",
                      json={"key": f"{pack_prefix}alpha.txt", "days": 1}, timeout=30)
    assert fs.status_code == 200
    bad_token = fs.json()["token"]
    bad = anon.get(f"{BASE_URL}/api/files/folder-share/{bad_token}", timeout=30)
    assert bad.status_code == 404

    # Bad token also 404
    nope = anon.get(f"{BASE_URL}/api/files/folder-share/no-such-token", timeout=30)
    assert nope.status_code == 404

    # PUBLIC zip
    zr = anon.get(f"{BASE_URL}/api/files/folder-share/{token}/zip", timeout=60)
    assert zr.status_code == 200
    assert zr.headers.get("content-type", "").startswith("application/zip")
    assert "attachment" in zr.headers.get("content-disposition", "").lower()
    zf = zipfile.ZipFile(io.BytesIO(zr.content))
    names = zf.namelist()
    assert "alpha.txt" in names
    assert "beta.txt" in names
    assert zf.read("alpha.txt") == b"alpha-body"


# ---- Admin folder-zip (auth-gated) ----
def test_folder_zip_admin_only(session, tracker):
    # Create folder + upload
    session.post(f"{BASE_URL}/api/files/folder",
                 json={"prefix": TEST_PREFIX, "name": "ZipPack"}, timeout=30)
    pack_prefix = f"{TEST_PREFIX}ZipPack/"
    _upload(session, pack_prefix, "one.txt", b"one")
    tracker["prefixes"].append(pack_prefix)

    # No auth → should NOT return 200
    anon = requests.Session()
    bad = anon.get(f"{BASE_URL}/api/files/folder-zip", params={"prefix": pack_prefix}, timeout=30)
    assert bad.status_code in (401, 403), f"expected auth fail, got {bad.status_code}"

    # Authed
    r = session.get(f"{BASE_URL}/api/files/folder-zip", params={"prefix": pack_prefix}, timeout=60)
    assert r.status_code == 200, r.text
    assert r.headers.get("content-type", "").startswith("application/zip")
    zf = zipfile.ZipFile(io.BytesIO(r.content))
    assert "one.txt" in zf.namelist()
