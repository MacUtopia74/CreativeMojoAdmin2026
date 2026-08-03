"""Regression — franchisee R2 root prefix is IMMUTABLE across renames.

Covers the full rename-safety loop the user asked for after Sam
Whiteman's 0-files-in-portal incident:

    1. Convert a contact into a franchisee (auto-bootstraps R2 root).
    2. Upload a file into the freshly-created root.
    3. Rename the franchisee (organisation change).
    4. Re-run ensure_franchisee_folders — the persisted root MUST NOT
       change, no second slug root is created, all existing files stay
       visible.
    5. Upload another file after the rename — it must land under the
       SAME canonical root, so old + new files live together.
    6. The diagnostic must NOT flag ``multiple_roots_detected`` and
       the panel's root discovery MUST resolve to the canonical root.
"""
import io
import os
import time
import uuid

import pytest
import requests

BASE = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")
EMAIL = os.environ.get("ADMIN_EMAIL", "admin@creativemojo.co.uk")
PASSWORD = os.environ.get("ADMIN_PASSWORD", "CreativeMojo2026!")


# ------------------------------------------------------------------
# Session helpers
# ------------------------------------------------------------------
@pytest.fixture(scope="module")
def s():
    sess = requests.Session()
    r = sess.post(f"{BASE}/api/auth/login", json={"email": EMAIL, "password": PASSWORD}, timeout=20)
    assert r.status_code == 200, f"login failed: {r.status_code} {r.text[:200]}"
    return sess


@pytest.fixture(scope="module")
def scratch():
    """Track things to tidy up so we don't pollute the DB / R2 bucket."""
    return {"contact_ids": [], "franchisee_ids": [], "file_keys": []}


def _make_contact(s, suffix):
    payload = {
        "first_name": "TEST",
        "last_name": f"RenameGuard_{suffix}",
        "email": f"test_rename_guard_{suffix}@example.com",
        "source": "franchise_enquiry",
        "target": "pipeline",
        "establishment_name": f"TEST Rename Guard Original {suffix}",
        "postcode": "se1 7tp",
        "city": "London",
        "telephone": "020 1234 5678",
        "message": "Automated regression contact — safe to delete.",
        "date": "2026-01-15",
    }
    r = s.post(f"{BASE}/api/contacts", json=payload, timeout=20)
    assert r.status_code in (200, 201), f"create contact failed: {r.status_code} {r.text[:200]}"
    body = r.json()
    cid = body.get("id") or body.get("contact", {}).get("id")
    assert cid, f"no contact id: {body}"
    return cid


# ------------------------------------------------------------------
# The scenario
# ------------------------------------------------------------------
def test_rename_does_not_create_second_root(s, scratch):
    # 1) Convert contact → franchisee (bootstraps R2 root + persists it).
    suffix = f"{int(time.time())}_{uuid.uuid4().hex[:6]}"
    cid = _make_contact(s, suffix)
    scratch["contact_ids"].append(cid)

    conv = s.post(f"{BASE}/api/contacts/{cid}/convert-to-franchisee", timeout=30)
    assert conv.status_code == 200, f"convert failed: {conv.status_code} {conv.text[:300]}"
    franchisee = conv.json()["franchisee"]
    fid = franchisee["id"]
    scratch["franchisee_ids"].append(fid)

    # PATCH-assign a franchise number so the derived slug is predictable.
    r = s.patch(f"{BASE}/api/franchisees/{fid}", json={"franchise_number": "9997"}, timeout=20)
    assert r.status_code == 200, r.text[:200]

    # Explicit bootstrap so the r2_root_prefix gets persisted (the
    # convert flow also does this but we re-issue to make the test
    # independent of that side-effect ordering).
    boot = s.post(f"{BASE}/api/franchisees/{fid}/bootstrap-folders", timeout=30)
    assert boot.status_code == 200, boot.text[:200]
    original_prefix = boot.json().get("prefix")
    assert original_prefix and original_prefix.startswith("franchisees/"), \
        f"unexpected bootstrap prefix: {original_prefix!r}"

    # Read back the franchisee — canonical prefix must be persisted.
    fr = s.get(f"{BASE}/api/franchisees/{fid}", timeout=20)
    assert fr.status_code == 200, fr.text[:200]
    payload = fr.json()
    fdoc = payload.get("franchisee") or payload
    assert fdoc.get("r2_root_prefix") == original_prefix, \
        f"r2_root_prefix not persisted correctly: {fdoc.get('r2_root_prefix')!r} vs {original_prefix!r}"

    # 2) Upload a file into the original root.
    file_a_key = _upload_probe(s, prefix=f"{original_prefix}Other Files/", filename=f"pre-rename-{suffix}.txt",
                               franchisee_id=fid, body=b"before rename")
    scratch["file_keys"].append(file_a_key)

    # Confirm the file is visible via /files/tree under the canonical root.
    tree = s.get(f"{BASE}/api/files/tree",
                 params={"prefix": f"{original_prefix}Other Files/"}, timeout=20).json()
    assert any(f["key"] == file_a_key for f in tree.get("files", [])), \
        f"uploaded file not visible before rename: keys={[f['key'] for f in tree.get('files', [])]}"

    # 3) Rename the franchisee — organisation change + first-name tweak,
    #    both of which feed derive_franchisee_prefix. If the code
    #    regressed and used the freshly-derived slug, this would create
    #    a second root under a new prefix.
    new_org = f"TEST Rename Guard RENAMED {suffix}"
    r = s.patch(f"{BASE}/api/franchisees/{fid}",
                json={"organisation": new_org, "first_name": "Renamed"},
                timeout=20)
    assert r.status_code == 200, r.text[:200]

    # 4) Re-run ensure_franchisee_folders via the bootstrap endpoint.
    #    The prefix returned MUST equal the ORIGINAL prefix.
    boot2 = s.post(f"{BASE}/api/franchisees/{fid}/bootstrap-folders", timeout=30)
    assert boot2.status_code == 200, boot2.text[:200]
    prefix_after_rename = boot2.json().get("prefix")
    assert prefix_after_rename == original_prefix, (
        "R2 root prefix drifted after rename!\n"
        f"  original  = {original_prefix!r}\n"
        f"  after     = {prefix_after_rename!r}\n"
        "This means the immutability guarantee has regressed — renaming "
        "an organisation is now spawning a second R2 root, exactly the "
        "bug the r2_root_prefix persistence was introduced to prevent."
    )

    # The freshly-derived slug (from the NEW org name) MUST differ
    # from the canonical prefix — otherwise the test itself is broken
    # and isn't actually exercising the rename path.
    diag = s.get(f"{BASE}/api/admin/files/diag", params={"q": fid}, timeout=30)
    assert diag.status_code == 200, diag.text[:300]
    diag_data = diag.json()
    assert diag_data.get("canonical_r2_prefix") == original_prefix
    assert diag_data.get("fresh_r2_prefix_from_current_fields") != original_prefix, (
        "Test sanity: renaming should have changed the freshly-derived slug. "
        f"Fresh: {diag_data.get('fresh_r2_prefix_from_current_fields')!r} vs "
        f"Canonical: {original_prefix!r}"
    )
    assert diag_data.get("canonical_matches_fresh") is False, \
        "Diag should flag canonical vs fresh mismatch after a rename"
    assert diag_data.get("multiple_roots_detected") is False, \
        "No second root should have been created by the rename"

    # 5) Existing file still visible.
    tree_after_rename = s.get(f"{BASE}/api/files/tree",
                              params={"prefix": f"{original_prefix}Other Files/"},
                              timeout=20).json()
    assert any(f["key"] == file_a_key for f in tree_after_rename.get("files", [])), \
        "pre-rename file disappeared after rename"

    # 6) Upload another file — must land under the SAME canonical root.
    file_b_key = _upload_probe(s, prefix=f"{original_prefix}Other Files/", filename=f"post-rename-{suffix}.txt",
                               franchisee_id=fid, body=b"after rename")
    scratch["file_keys"].append(file_b_key)
    assert file_b_key.startswith(original_prefix), \
        f"post-rename upload landed outside canonical root: {file_b_key!r}"

    # 7) The panel's root discovery must resolve to exactly the
    #    canonical prefix (with a single candidate). This is the check
    #    that guarantees the panel won't render 0 files after a rename.
    disc = diag_data.get("root_discovery_simulation") or {}
    assert disc.get("returned_folder_count") == 1, \
        f"expected 1 candidate root folder, got: {disc}"
    picked = disc.get("panel_would_pick") or {}
    assert picked.get("key") == original_prefix, \
        f"panel would pick the wrong root: {picked!r} vs {original_prefix!r}"


# ------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------
def _upload_probe(s, *, prefix: str, filename: str, franchisee_id: str, body: bytes) -> str:
    """Multipart-upload a tiny probe file and return the resulting key."""
    files = {"file": (filename, io.BytesIO(body), "text/plain")}
    data = {"prefix": prefix, "franchisee_id": franchisee_id}
    r = s.post(f"{BASE}/api/files/upload", files=files, data=data, timeout=45)
    assert r.status_code == 200, f"upload failed: {r.status_code} {r.text[:200]}"
    key = r.json()["file"]["key"]
    assert key.startswith(prefix), f"upload key not under expected prefix: {key!r}"
    return key


# ------------------------------------------------------------------
# Cleanup — best-effort, doesn't block the test if a delete 404s.
# ------------------------------------------------------------------
def test_zz_cleanup(s, scratch):
    for k in scratch["file_keys"]:
        try:
            s.delete(f"{BASE}/api/files", params={"key": k}, timeout=15)
        except Exception:
            pass
    for fid in scratch["franchisee_ids"]:
        try:
            s.delete(f"{BASE}/api/franchisees/{fid}", timeout=15)
        except Exception:
            pass
    for cid in scratch["contact_ids"]:
        try:
            s.delete(f"{BASE}/api/contacts/{cid}", timeout=15)
        except Exception:
            pass
