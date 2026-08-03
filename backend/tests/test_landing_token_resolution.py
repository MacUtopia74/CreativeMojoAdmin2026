"""Regression — {{landing:<slug>}} CTA token resolution across
preview surfaces, sends, and the anchor-safety net.

Covers the production bug where a raw ``{{landing:<slug>}}`` token
inside an anchor href rendered to
``https://hub.creativemojo.co.uk/admin/%7B%7Blanding:...%7D%7D`` in
the recipient's browser (because email clients treat the raw token as
a relative URL).

The fix has three layers:
  1. Backend `_resolve_landing_tokens` rewrites BOTH resolved and
     unresolved anchor hrefs (unresolved → neutral `#unresolved-…`),
     never leaves a raw token inside a clickable href.
  2. Every send site (`/reply`, `/dbs/applications/{id}/send-email`,
     `/announcements/test-send`) refuses to dispatch when a slug is
     unresolved — 409 with the failing slugs.
  3. The `/admin/landing-pages/resolve` endpoint gives the frontend
     the same mapping so previews match sends exactly.
"""
import asyncio
import os
import re
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
    assert r.status_code == 200, r.text[:200]
    return sess


@pytest.fixture(scope="module")
def scratch():
    return {"page_ids": []}


def _make_landing_page(sess, slug_hint, *, active=True):
    """Create a landing page and return its dict."""
    r = sess.post(
        f"{BASE}/api/admin/landing-pages",
        json={
            "slug": slug_hint,
            "title": f"Regression: {slug_hint}",
            "intro_html": "<p>test</p>",
            "cta_label": "Download",
            "bullets": ["a", "b"],
            "active": active,
        },
        timeout=15,
    )
    assert r.status_code in (200, 201), r.text[:200]
    return r.json()


# ------------------------------------------------------------------
# Backend helper unit tests — imported directly (fast, no HTTP)
# ------------------------------------------------------------------
def _import_helper():
    import sys
    sys.path.insert(0, "/app/backend")
    from resend_routes import _resolve_landing_tokens
    return _resolve_landing_tokens


def _get_db():
    import sys
    sys.path.insert(0, "/app/backend")
    from motor.motor_asyncio import AsyncIOMotorClient
    cli = AsyncIOMotorClient(os.environ["MONGO_URL"])
    return cli, cli[os.environ["DB_NAME"]]


def _run_async(coro):
    """Helper to run a coroutine in a fresh event loop — asyncio.run()
    fails inside pytest when a prior test closed the default loop."""
    import asyncio
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


def _run_resolve(html, *, send_id):
    """Create a fresh motor client + call the resolver on the same
    event loop. Motor pins clients to their creating loop — reusing a
    client across pytest tests raises 'Event loop is closed'."""
    async def _inner():
        from motor.motor_asyncio import AsyncIOMotorClient
        from resend_routes import _resolve_landing_tokens
        cli = AsyncIOMotorClient(os.environ["MONGO_URL"])
        try:
            return await _resolve_landing_tokens(
                cli[os.environ["DB_NAME"]], html, send_id=send_id,
            )
        finally:
            cli.close()
    return _run_async(_inner())


def test_resolve_valid_slug_rewrites_anchor(s, scratch):
    page = _make_landing_page(s, f"reg-valid-{uuid.uuid4().hex[:8]}")
    scratch["page_ids"].append(page["id"])
    html = f'<p>Hi <a href="{{{{landing:{page["slug"]}}}}}">Download pack</a></p>'
    out, unresolved = _run_resolve(html, send_id="test-send-id-1")
    assert unresolved == []
    assert f"/info/{page['slug']}?t=test-send-id-1" in out
    # No raw token remains
    assert "{{landing:" not in out
    assert "%7B%7B" not in out


def test_resolve_invalid_slug_neutralises_href(s):
    slug = f"missing-{uuid.uuid4().hex[:8]}"
    html = f'<p><a href="{{{{landing:{slug}}}}}">Click me</a></p>'
    out, unresolved = _run_resolve(html, send_id=None)
    assert unresolved == [slug]
    # The raw token must never be left inside a clickable href.
    assert "{{landing:" not in re.findall(r'href="([^"]+)"', out)[0]
    assert f"#unresolved-landing-token-{slug}" in out
    assert f'data-cm-landing-unresolved="{slug}"' in out


def test_resolve_inactive_slug_treated_as_unresolved(s, scratch):
    page = _make_landing_page(s, f"reg-inactive-{uuid.uuid4().hex[:8]}", active=False)
    scratch["page_ids"].append(page["id"])
    html = f'<a href="{{{{landing:{page["slug"]}}}}}">x</a>'
    out, unresolved = _run_resolve(html, send_id="s2")
    assert unresolved == [page["slug"]], out
    assert "#unresolved-landing-token-" in out


def test_resolve_ignores_ordinary_urls_and_other_tokens(s):
    html = (
        '<p>Hi {{first_name}}, see <a href="https://creativemojo.co.uk/x">this</a> '
        'and <a href="mailto:sam@example.com">email me</a>.</p>'
    )
    out, unresolved = _run_resolve(html, send_id=None)
    assert unresolved == []
    # Unchanged content
    assert "{{first_name}}" in out
    assert "https://creativemojo.co.uk/x" in out
    assert "mailto:sam@example.com" in out


def test_resolve_appends_tracking_only_when_send_id(s, scratch):
    page = _make_landing_page(s, f"reg-track-{uuid.uuid4().hex[:8]}")
    scratch["page_ids"].append(page["id"])
    html = f'<a href="{{{{landing:{page["slug"]}}}}}">x</a>'
    # WITH send_id — ?t= appended.
    out_with, _ = _run_resolve(html, send_id="abc123")
    # WITHOUT send_id (preview path) — no tracking param.
    out_no, _ = _run_resolve(html, send_id=None)
    assert "?t=abc123" in out_with
    assert "?t=" not in out_no


# ------------------------------------------------------------------
# HTTP-level: preview endpoint mirrors the send resolver.
# ------------------------------------------------------------------
def test_preview_resolve_endpoint_matches_send(s, scratch):
    page = _make_landing_page(s, f"reg-preview-{uuid.uuid4().hex[:8]}")
    scratch["page_ids"].append(page["id"])
    r = s.get(f"{BASE}/api/admin/landing-pages/resolve",
              params={"slugs": f"{page['slug']},missing-slug-xyz"}, timeout=15)
    assert r.status_code == 200, r.text[:200]
    data = r.json()["resolved"]
    assert data[page["slug"]].endswith(f"/info/{page['slug']}")
    assert data["missing-slug-xyz"] is None


# ------------------------------------------------------------------
# End-to-end: send-reply refuses to dispatch on unresolved slug.
# We seed a throw-away contact, then attempt to send a reply whose
# body carries an anchor with a bogus landing token → 409.
# ------------------------------------------------------------------
def test_send_reply_aborts_on_unresolved(s, scratch):
    # Create a throw-away contact so the send has a valid target.
    r = s.post(f"{BASE}/api/contacts", json={
        "first_name": "TEST", "last_name": f"LandingReject_{uuid.uuid4().hex[:6]}",
        "email": f"landing-reject-{uuid.uuid4().hex[:6]}@example.com",
        "source": "franchise_enquiry", "target": "pipeline",
        "postcode": "se1 7tp", "message": "regression",
    }, timeout=15)
    assert r.status_code in (200, 201), r.text[:200]
    cid = r.json().get("id") or r.json()["contact"]["id"]

    bad_slug = f"bogus-slug-{uuid.uuid4().hex[:6]}"
    payload = {
        "contact_id": cid,
        "to": [f"landing-reject-test-{uuid.uuid4().hex[:6]}@example.com"],
        "subject": "Regression: unresolved landing",
        "body_html": f'<p><a href="{{{{landing:{bad_slug}}}}}">Click</a></p>',
    }
    r = s.post(f"{BASE}/api/email/send-reply", json=payload, timeout=20)
    # Cleanup the contact
    s.delete(f"{BASE}/api/contacts/{cid}", timeout=15)
    assert r.status_code == 409, f"expected 409, got {r.status_code}: {r.text[:300]}"
    detail = r.json().get("detail") or {}
    assert detail.get("error") == "unresolved_landing_tokens"
    assert bad_slug in detail.get("unresolved_slugs", [])


# ------------------------------------------------------------------
def test_zz_cleanup(s, scratch):
    for pid in scratch["page_ids"]:
        try:
            s.delete(f"{BASE}/api/admin/landing-pages/{pid}", timeout=10)
        except Exception:
            pass
