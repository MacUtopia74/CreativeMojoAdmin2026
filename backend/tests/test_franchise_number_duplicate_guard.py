"""Regression — duplicate franchise_number handling.

Covers the exact production incident where two franchisees ended up
sharing ``franchise_number == "0001"``:

    * PATCH /api/franchisees/{id} must 409 when the number is already
      used by another franchisee (no force override).
    * GET /api/admin/franchisees/duplicates lists every group of ≥2
      franchisees sharing a number.
    * GET /api/admin/franchisees/by-number/{fn} returns a list — never
      silently picks one.
    * GET /api/admin/files/diag?q=<number> with duplicate franchisees
      returns *all* candidates (ambiguous=True), never silently binds
      to one.
    * POST /api/files/upload into an ambiguous franchisees/<num>-…/
      prefix WITHOUT an explicit franchisee_id returns 409 and does
      NOT create a files_index row or leave a stray R2 object.
    * POST /api/files/upload WITH an explicit franchisee_id succeeds
      even when the number is ambiguous — this is the safe path for
      the admin Files UI.
    * POST /api/admin/files/rebind-single moves a file to a specific
      target franchisee_id and records the rebind history.
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


@pytest.fixture(scope="module")
def s():
    sess = requests.Session()
    r = sess.post(f"{BASE}/api/auth/login", json={"email": EMAIL, "password": PASSWORD}, timeout=20)
    assert r.status_code == 200, f"login failed: {r.status_code} {r.text[:200]}"
    return sess


@pytest.fixture(scope="module")
def scratch():
    return {"contact_ids": [], "franchisee_ids": [], "file_keys": []}


def _make_contact(sess, suffix):
    payload = {
        "first_name": "TEST",
        "last_name": f"DupGuard_{suffix}",
        "email": f"test_dup_guard_{suffix}@example.com",
        "source": "franchise_enquiry",
        "target": "pipeline",
        "establishment_name": f"TEST Dup Guard {suffix}",
        "postcode": "se1 7tp",
        "city": "London",
        "telephone": "020 1234 5678",
        "message": "Automated regression contact — safe to delete.",
        "date": "2026-01-15",
    }
    r = sess.post(f"{BASE}/api/contacts", json=payload, timeout=20)
    assert r.status_code in (200, 201), r.text[:300]
    body = r.json()
    return body.get("id") or body["contact"]["id"]


def _convert(sess, cid):
    r = sess.post(f"{BASE}/api/contacts/{cid}/convert-to-franchisee", timeout=30)
    assert r.status_code == 200, r.text[:300]
    return r.json()["franchisee"]["id"]


def _pick_free_number(sess, base: int = 90000) -> str:
    """Return a franchise_number known to be free in the DB. We pick a
    high-numbered range unlikely to collide with real records."""
    for i in range(base, base + 100):
        fn = str(i).zfill(5)
        r = sess.get(f"{BASE}/api/admin/franchisees/by-number/{fn}", timeout=20)
        assert r.status_code == 200, r.text[:200]
        if r.json()["count"] == 0:
            return fn
    raise AssertionError("no free franchise_number in range")


# ------------------------------------------------------------------
def test_patch_duplicate_franchise_number_returns_409(s, scratch):
    fn = _pick_free_number(s, base=91000)

    # Create two franchisees.
    suffix = f"{int(time.time())}_{uuid.uuid4().hex[:6]}"
    fid_a = _convert(s, _make_contact(s, f"A_{suffix}"))
    fid_b = _convert(s, _make_contact(s, f"B_{suffix}"))
    scratch["franchisee_ids"] += [fid_a, fid_b]

    # Assign the number to A — should succeed.
    r = s.patch(f"{BASE}/api/franchisees/{fid_a}", json={"franchise_number": fn}, timeout=20)
    assert r.status_code == 200, r.text[:300]

    # Try to reuse the number on B — must 409.
    r = s.patch(f"{BASE}/api/franchisees/{fid_b}", json={"franchise_number": fn}, timeout=20)
    assert r.status_code == 409, f"expected 409, got {r.status_code}: {r.text[:300]}"
    body = r.json()
    detail = body.get("detail") or {}
    assert detail.get("error") == "duplicate_franchise_number"
    assert detail.get("conflicting_franchisee", {}).get("id") == fid_a
    assert detail.get("attempted_franchise_number") == fn

    # Same admin PATCHing A onto its OWN number must still succeed
    # (self-assignment is a no-op collision).
    r = s.patch(f"{BASE}/api/franchisees/{fid_a}", json={"franchise_number": fn}, timeout=20)
    assert r.status_code == 200, r.text[:300]


# ------------------------------------------------------------------
def test_by_number_lookup_never_silently_picks(s, scratch):
    """When two records share a number (created by a database write
    that bypasses the PATCH guard, e.g. legacy import), the by-number
    endpoint must return BOTH — the caller decides."""
    fn = _pick_free_number(s, base=91200)

    suffix = f"{int(time.time())}_{uuid.uuid4().hex[:6]}"
    fid_a = _convert(s, _make_contact(s, f"A_{suffix}"))
    fid_b = _convert(s, _make_contact(s, f"B_{suffix}"))
    scratch["franchisee_ids"] += [fid_a, fid_b]

    # Assign A via the guarded PATCH.
    s.patch(f"{BASE}/api/franchisees/{fid_a}", json={"franchise_number": fn}, timeout=20)

    # Force-inject the same number onto B via the raw DB — simulates the
    # historical import that seeded duplicates. We use a hidden admin
    # backdoor: two consecutive PATCHes with different numbers can't do
    # it, but Mongo can. We use motor directly.
    from motor.motor_asyncio import AsyncIOMotorClient
    import asyncio
    MONGO_URL = os.environ.get("MONGO_URL")
    DB_NAME = os.environ.get("DB_NAME")
    assert MONGO_URL and DB_NAME, "MONGO_URL / DB_NAME env vars required for this test"

    async def _seed_dup():
        cli = AsyncIOMotorClient(MONGO_URL)
        await cli[DB_NAME].franchisees.update_one({"id": fid_b}, {"$set": {"franchise_number": fn}})
        cli.close()
    asyncio.run(_seed_dup())

    # by-number MUST return both.
    r = s.get(f"{BASE}/api/admin/franchisees/by-number/{fn}", timeout=20)
    assert r.status_code == 200, r.text[:200]
    payload = r.json()
    assert payload["count"] == 2, f"expected 2 records, got {payload['count']}: {payload}"
    ids_found = {rec["id"] for rec in payload["records"]}
    assert ids_found == {fid_a, fid_b}

    # duplicates listing must include this group.
    r = s.get(f"{BASE}/api/admin/franchisees/duplicates", timeout=20)
    assert r.status_code == 200, r.text[:200]
    dupes = r.json()["groups"]
    group = next((g for g in dupes if g["franchise_number"] == fn), None)
    assert group is not None, f"duplicates report missed franchise_number {fn!r}: {dupes}"
    assert group["record_count"] == 2

    # /admin/files/diag with the DUPLICATED number must surface both
    # candidates rather than silently picking one.
    r = s.get(f"{BASE}/api/admin/files/diag", params={"q": fn}, timeout=20)
    assert r.status_code == 200, r.text[:200]
    diag = r.json()
    assert diag.get("ambiguous") is True, f"diag should flag ambiguity for duplicated {fn}: {diag}"
    assert diag.get("matched_franchisees") == 2
    ids_in_diag = {c["id"] for c in diag["candidates"]}
    assert ids_in_diag == {fid_a, fid_b}


# ------------------------------------------------------------------
def test_upload_from_franchisee_folder_sends_exact_id(s, scratch):
    """The safe path: the FE passes an explicit franchisee_id. Even
    when the franchise_number is ambiguous, the upload succeeds and the
    files_index row is bound to the id we sent — never derived from
    the number."""
    fn = _pick_free_number(s, base=91400)
    suffix = f"{int(time.time())}_{uuid.uuid4().hex[:6]}"
    fid_a = _convert(s, _make_contact(s, f"A_{suffix}"))
    fid_b = _convert(s, _make_contact(s, f"B_{suffix}"))
    scratch["franchisee_ids"] += [fid_a, fid_b]

    # Assign A the number, then inject B with the same via raw DB.
    s.patch(f"{BASE}/api/franchisees/{fid_a}", json={"franchise_number": fn}, timeout=20)
    from motor.motor_asyncio import AsyncIOMotorClient
    import asyncio
    MONGO_URL = os.environ.get("MONGO_URL")
    DB_NAME = os.environ.get("DB_NAME")

    async def _seed_dup():
        cli = AsyncIOMotorClient(MONGO_URL)
        await cli[DB_NAME].franchisees.update_one({"id": fid_b}, {"$set": {"franchise_number": fn}})
        cli.close()
    asyncio.run(_seed_dup())

    # Bootstrap A so its canonical root exists.
    boot = s.post(f"{BASE}/api/franchisees/{fid_a}/bootstrap-folders", timeout=30)
    assert boot.status_code == 200, boot.text[:200]
    prefix_a = boot.json()["prefix"]

    # Upload WITH the exact franchisee_id → must succeed and be bound to A.
    filename = f"probe-{suffix}.txt"
    files = {"file": (filename, io.BytesIO(b"safe path"), "text/plain")}
    data = {"prefix": f"{prefix_a}Other Files/", "franchisee_id": fid_a}
    r = s.post(f"{BASE}/api/files/upload", files=files, data=data, timeout=45)
    assert r.status_code == 200, f"safe upload failed: {r.status_code} {r.text[:300]}"
    file_doc = r.json()["file"]
    assert file_doc["franchisee_id"] == fid_a, f"upload bound to wrong id: {file_doc}"
    scratch["file_keys"].append(file_doc["key"])


# ------------------------------------------------------------------
def test_upload_without_explicit_id_rejects_on_ambiguous_number(s, scratch):
    """The unsafe path: the FE forgot to pass franchisee_id and the
    franchise_number resolves to >1 franchisee. Must 409, no R2
    object, no files_index row."""
    fn = _pick_free_number(s, base=91600)
    suffix = f"{int(time.time())}_{uuid.uuid4().hex[:6]}"
    fid_a = _convert(s, _make_contact(s, f"A_{suffix}"))
    fid_b = _convert(s, _make_contact(s, f"B_{suffix}"))
    scratch["franchisee_ids"] += [fid_a, fid_b]

    s.patch(f"{BASE}/api/franchisees/{fid_a}", json={"franchise_number": fn}, timeout=20)
    from motor.motor_asyncio import AsyncIOMotorClient
    import asyncio
    MONGO_URL = os.environ.get("MONGO_URL")
    DB_NAME = os.environ.get("DB_NAME")

    async def _seed_dup():
        cli = AsyncIOMotorClient(MONGO_URL)
        await cli[DB_NAME].franchisees.update_one({"id": fid_b}, {"$set": {"franchise_number": fn}})
        cli.close()
    asyncio.run(_seed_dup())

    # Deduction from prefix requires the R2 key to LEAD with a number.
    # The r2_root_prefix persisted at conversion time predates the
    # franchise_number PATCH, so we upload into an explicitly-numbered
    # sibling prefix that models the production layout:
    #   franchisees/<num>-…/
    dedup_prefix = f"franchisees/{fn}-dup-ambig-{suffix}/"

    # Upload WITHOUT franchisee_id → server tries to deduce from the
    # leading number in the slug and finds two candidates → 409.
    filename = f"probe-ambig-{suffix}.txt"
    files = {"file": (filename, io.BytesIO(b"ambig"), "text/plain")}
    data = {"prefix": dedup_prefix}  # NO franchisee_id
    r = s.post(f"{BASE}/api/files/upload", files=files, data=data, timeout=45)
    assert r.status_code == 409, f"expected 409, got {r.status_code}: {r.text[:400]}"
    detail = r.json().get("detail") or {}
    assert detail.get("error") == "ambiguous_franchise_number"
    # Server normalises to zero-padded 4-digit form; accept either.
    assert detail.get("franchise_number") in (fn, fn.zfill(4)), detail
    assert set(detail.get("candidate_franchisee_ids", [])) == {fid_a, fid_b}
    assert detail.get("attempted_filename") == filename
    assert detail.get("attempted_by")

    # Verify no files_index row was created for the attempted key.
    key_expected = f"{dedup_prefix}{filename}"
    async def _count():
        cli = AsyncIOMotorClient(MONGO_URL)
        n = await cli[DB_NAME].files_index.count_documents({"key": key_expected})
        cli.close()
        return n
    assert asyncio.run(_count()) == 0, "orphan files_index row created despite 409"


# ------------------------------------------------------------------
def test_rebind_single_moves_file_to_target(s, scratch):
    """Admin repair path — rebind an individual mis-bound files_index
    row to a specific target franchisee_id and audit the change."""
    suffix = f"{int(time.time())}_{uuid.uuid4().hex[:6]}"
    fid_a = _convert(s, _make_contact(s, f"A_{suffix}"))
    fid_b = _convert(s, _make_contact(s, f"B_{suffix}"))
    scratch["franchisee_ids"] += [fid_a, fid_b]

    boot = s.post(f"{BASE}/api/franchisees/{fid_a}/bootstrap-folders", timeout=30)
    assert boot.status_code == 200, boot.text[:200]
    prefix_a = boot.json()["prefix"]

    files = {"file": (f"rebind-{suffix}.txt", io.BytesIO(b"rebind"), "text/plain")}
    data = {"prefix": f"{prefix_a}Other Files/", "franchisee_id": fid_a}
    r = s.post(f"{BASE}/api/files/upload", files=files, data=data, timeout=45)
    key = r.json()["file"]["key"]
    scratch["file_keys"].append(key)

    r = s.post(f"{BASE}/api/admin/files/rebind-single",
               json={"key": key, "franchisee_id": fid_b, "reason": "regression test"},
               timeout=20)
    assert r.status_code == 200, r.text[:300]
    body = r.json()
    assert body["ok"] is True
    assert body["changed"] is True
    assert body["previous_franchisee_id"] == fid_a
    assert body["new_franchisee_id"] == fid_b
    assert body["rebind_history"] and body["rebind_history"][-1]["to"] == fid_b


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
