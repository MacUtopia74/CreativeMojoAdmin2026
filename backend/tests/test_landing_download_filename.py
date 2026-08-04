"""Regression — landing-page PDF download filename resolution.

Covers the production bug where the CTA download rendered the R2
UUID (`2ce264d5-…-247d865d3453.pdf`) as the customer-facing filename
because the presigned URL didn't carry a ``Content-Disposition``.

Priority the user asked for:
    1. ``landing_pages.file_name``
    2. ``files_index.name`` / ``files_index.original_name``
    3. Sanitised ``page.title`` / ``page.slug``
    * UUIDs and raw R2 keys are NEVER exposed as the download filename.
"""
import asyncio
import os
import re
import uuid
import urllib.parse

import pytest
import requests

BASE = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")
EMAIL = os.environ.get("ADMIN_EMAIL", "admin@creativemojo.co.uk")
PASSWORD = os.environ.get("ADMIN_PASSWORD", "CreativeMojo2026!")


@pytest.fixture(scope="module")
def s():
    sess = requests.Session()
    r = sess.post(f"{BASE}/api/auth/login", json={"email": EMAIL, "password": PASSWORD}, timeout=20)
    assert r.status_code == 200, r.text[:200]
    return sess


@pytest.fixture(scope="module")
def scratch():
    return {"page_ids": [], "file_keys": []}


def _run(coro):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


def _seed_files_index_row(key, name):
    """Inject a files_index row so the download endpoint's fallback
    lookup finds a human-readable original filename."""
    async def _inner():
        from motor.motor_asyncio import AsyncIOMotorClient
        cli = AsyncIOMotorClient(os.environ["MONGO_URL"])
        try:
            await cli[os.environ["DB_NAME"]].files_index.update_one(
                {"key": key},
                {"$set": {"key": key, "name": name}},
                upsert=True,
            )
        finally:
            cli.close()
    _run(_inner())


def _cleanup_files_index_row(key):
    async def _inner():
        from motor.motor_asyncio import AsyncIOMotorClient
        cli = AsyncIOMotorClient(os.environ["MONGO_URL"])
        try:
            await cli[os.environ["DB_NAME"]].files_index.delete_one({"key": key})
        finally:
            cli.close()
    _run(_inner())


def _make_page(sess, *, slug_hint, title, file_key, file_name=None):
    r = sess.post(f"{BASE}/api/admin/landing-pages", json={
        "slug": slug_hint,
        "title": title,
        "intro_html": "<p>x</p>",
        "cta_label": "Download",
        "file_key": file_key,
        "file_name": file_name,
        "active": True,
    }, timeout=15)
    assert r.status_code in (200, 201), r.text[:300]
    return r.json()


def _parse_content_disposition_from_url(url: str) -> str:
    """Read the ``response-content-disposition`` query param — that's
    what R2 signs into the presigned URL. R2 will echo it back as the
    real Content-Disposition when the browser hits the URL."""
    parsed = urllib.parse.urlparse(url)
    q = urllib.parse.parse_qs(parsed.query)
    values = q.get("response-content-disposition") or q.get("ResponseContentDisposition") or []
    assert values, f"no response-content-disposition on {url!r}"
    return values[0]


# ------------------------------------------------------------------
def test_file_name_field_used_when_present(s, scratch):
    slug = f"reg-fname-{uuid.uuid4().hex[:6]}"
    key = f"admin/landing-tests/{uuid.uuid4().hex}.pdf"
    _seed_files_index_row(key, "should-not-be-used.pdf")
    scratch["file_keys"].append(key)
    page = _make_page(s, slug_hint=slug, title="Reg fname priority",
                      file_key=key,
                      file_name="Creative-Mojo-Franchise-Pack-Aug-2026.pdf")
    scratch["page_ids"].append(page["id"])

    r = s.get(f"{BASE}/api/public/landing/{page['slug']}/download",
              allow_redirects=False, timeout=15)
    assert r.status_code == 302, r.text[:200]
    disp = _parse_content_disposition_from_url(r.headers["location"])
    assert "attachment;" in disp
    assert 'filename="Creative-Mojo-Franchise-Pack-Aug-2026.pdf"' in disp
    assert "filename*=UTF-8''" in disp
    # Never leak the UUID / R2 key.
    assert key.split("/")[-1] not in disp
    assert "admin/landing-tests" not in disp


# ------------------------------------------------------------------
def test_falls_back_to_files_index_name(s, scratch):
    """No file_name on page → fall through to files_index.name."""
    slug = f"reg-idxname-{uuid.uuid4().hex[:6]}"
    key = f"admin/landing-tests/{uuid.uuid4().hex}.pdf"
    _seed_files_index_row(key, "Original-Upload-Name.pdf")
    scratch["file_keys"].append(key)
    page = _make_page(s, slug_hint=slug, title="Reg idx fallback",
                      file_key=key, file_name=None)
    scratch["page_ids"].append(page["id"])

    r = s.get(f"{BASE}/api/public/landing/{page['slug']}/download",
              allow_redirects=False, timeout=15)
    assert r.status_code == 302, r.text[:200]
    disp = _parse_content_disposition_from_url(r.headers["location"])
    assert 'filename="Original-Upload-Name.pdf"' in disp


# ------------------------------------------------------------------
def test_falls_back_to_title_when_indexed_name_is_uuid(s, scratch):
    """Both page.file_name and files_index.name are UUIDs → fall
    through to the sanitised title. This is EXACTLY the production
    ``2ce264d5-…-247d865d3453.pdf`` case."""
    slug = f"reg-uuid-fallback-{uuid.uuid4().hex[:6]}"
    fake_uuid = str(uuid.uuid4())
    key = f"admin/landing-tests/{fake_uuid}.pdf"
    # files_index.name looks like a UUID → skipped.
    _seed_files_index_row(key, f"{fake_uuid}.pdf")
    scratch["file_keys"].append(key)
    page = _make_page(
        s, slug_hint=slug,
        title="Creative Mojo Franchise Information Pack Aug 2026",
        file_key=key,
        # file_name also a UUID — was the historical bug shape.
        file_name=f"{fake_uuid}.pdf",
    )
    scratch["page_ids"].append(page["id"])

    r = s.get(f"{BASE}/api/public/landing/{page['slug']}/download",
              allow_redirects=False, timeout=15)
    assert r.status_code == 302, r.text[:200]
    disp = _parse_content_disposition_from_url(r.headers["location"])
    assert fake_uuid not in disp, f"UUID leaked into {disp!r}"
    # Must fall back to a sanitised human filename.
    assert 'filename="Creative Mojo Franchise Information Pack Aug 2026.pdf"' in disp


# ------------------------------------------------------------------
def test_utf8_filename_extended_form(s, scratch):
    """Filenames containing non-ASCII characters must still be encoded
    via ``filename*=UTF-8''…`` per RFC 5987."""
    slug = f"reg-utf8-{uuid.uuid4().hex[:6]}"
    key = f"admin/landing-tests/{uuid.uuid4().hex}.pdf"
    scratch["file_keys"].append(key)
    page = _make_page(
        s, slug_hint=slug, title="UTF-8 test",
        file_key=key,
        file_name="Café Résumé — 2026.pdf",
    )
    scratch["page_ids"].append(page["id"])

    r = s.get(f"{BASE}/api/public/landing/{page['slug']}/download",
              allow_redirects=False, timeout=15)
    assert r.status_code == 302, r.text[:200]
    disp = _parse_content_disposition_from_url(r.headers["location"])
    # ASCII fallback is stripped of non-ASCII but keeps spaces (RFC 6266)
    m = re.search(r'filename="([^"]+)"', disp)
    assert m, disp
    # Extended form carries the full UTF-8 name (percent-encoded)
    assert "filename*=UTF-8''" in disp
    assert "Caf%C3%A9" in disp or "Caf%c3%a9" in disp


# ------------------------------------------------------------------
def test_download_visit_is_recorded(s, scratch):
    """The rename fix must not break download tracking."""
    slug = f"reg-track-dl-{uuid.uuid4().hex[:6]}"
    key = f"admin/landing-tests/{uuid.uuid4().hex}.pdf"
    scratch["file_keys"].append(key)
    page = _make_page(s, slug_hint=slug, title="Track test",
                      file_key=key, file_name="pack.pdf")
    scratch["page_ids"].append(page["id"])

    before = s.get(f"{BASE}/api/admin/landing-pages/{page['id']}/stats", timeout=15).json()
    r = s.get(f"{BASE}/api/public/landing/{page['slug']}/download",
              allow_redirects=False, timeout=15)
    assert r.status_code == 302
    after = s.get(f"{BASE}/api/admin/landing-pages/{page['id']}/stats", timeout=15).json()
    assert (after["downloads"] or 0) == (before["downloads"] or 0) + 1


# ------------------------------------------------------------------
def test_zz_cleanup(s, scratch):
    for k in scratch["file_keys"]:
        _cleanup_files_index_row(k)
    for pid in scratch["page_ids"]:
        try:
            s.delete(f"{BASE}/api/admin/landing-pages/{pid}", timeout=10)
        except Exception:
            pass
