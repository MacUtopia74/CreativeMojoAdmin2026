"""Iteration 36 — email fix verification:

1. _resolve_landing_tokens must resolve to production hub.creativemojo.co.uk,
   NOT to the preview cluster URL (even when request_base is the cluster URL
   and PUBLIC_BASE_URL env is unset).
2. GET /api/email-templates/{id} must return signature_html that contains
   'EX15&nbsp;1NB' so the postcode stays on the same line as 'Devon EX15'.
"""
import os
import sys
import asyncio
import pytest
import requests

# Make /app/backend importable
sys.path.insert(0, "/app/backend")

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")
if not BASE_URL:
    # Try frontend/.env directly
    try:
        with open("/app/frontend/.env") as fh:
            for line in fh:
                if line.startswith("REACT_APP_BACKEND_URL"):
                    BASE_URL = line.split("=", 1)[1].strip().rstrip("/")
                    break
    except Exception:
        pass

ADMIN_EMAIL = "admin@creativemojo.co.uk"
ADMIN_PWD = "CreativeMojo2026!"


# ---------------------------------------------------------------- fixtures
@pytest.fixture(scope="module")
def admin_session():
    s = requests.Session()
    r = s.post(f"{BASE_URL}/api/auth/login",
               json={"email": ADMIN_EMAIL, "password": ADMIN_PWD})
    assert r.status_code == 200, f"login failed: {r.status_code} {r.text}"
    return s


# ---------------------------------------------------------------- 1) landing url
class TestLandingUrlResolution:
    """The resolver must NEVER hand back the preview cluster URL."""

    def test_resolve_landing_tokens_uses_production_hub(self):
        # Ensure PUBLIC_BASE_URL is NOT set so we exercise the prod fallback path
        os.environ.pop("PUBLIC_BASE_URL", None)

        from motor.motor_asyncio import AsyncIOMotorClient
        import resend_routes

        async def _run():
            client = AsyncIOMotorClient(os.environ["MONGO_URL"])
            db = client[os.environ["DB_NAME"]]
            # Seed a landing page that matches the slug we'll embed
            slug = "creative-mojo-franchise-pack"
            existing = await db.landing_pages.find_one({"slug": slug})
            created = False
            if not existing:
                await db.landing_pages.insert_one({
                    "id": "test-iter36",
                    "slug": slug,
                    "active": True,
                    "title": "Test landing page",
                })
                created = True
            try:
                body = (
                    '<p>Hi friend,</p>'
                    '<p><a href="{{landing:' + slug + '}}">Click</a></p>'
                )
                cluster_base = (
                    "https://licensee-vault.cluster-7.deploy.emergentcf.cloud"
                )
                out = await resend_routes._resolve_landing_tokens(
                    db, body, send_id="test-123", request_base=cluster_base,
                )
                return out
            finally:
                if created:
                    await db.landing_pages.delete_one({"id": "test-iter36"})
                client.close()

        out = asyncio.run(_run())
        expected = (
            "https://hub.creativemojo.co.uk/info/"
            "creative-mojo-franchise-pack?t=test-123"
        )
        assert expected in out, (
            f"Expected production URL in output but got: {out!r}"
        )
        for forbidden in ("licensee-vault", "cluster", "emergentcf"):
            assert forbidden not in out, (
                f"Forbidden token '{forbidden}' leaked into output: {out!r}"
            )

    def test_resolve_landing_tokens_honours_public_base_url_override(self):
        # Verify PUBLIC_BASE_URL still wins when explicitly set (staging path)
        os.environ["PUBLIC_BASE_URL"] = "https://staging.example.com"

        from motor.motor_asyncio import AsyncIOMotorClient
        import resend_routes

        async def _run():
            client = AsyncIOMotorClient(os.environ["MONGO_URL"])
            db = client[os.environ["DB_NAME"]]
            slug = "creative-mojo-franchise-pack"
            existing = await db.landing_pages.find_one({"slug": slug})
            created = False
            if not existing:
                await db.landing_pages.insert_one({
                    "id": "test-iter36b", "slug": slug, "active": True,
                })
                created = True
            try:
                body = '<a href="{{landing:' + slug + '}}">x</a>'
                out = await resend_routes._resolve_landing_tokens(
                    db, body, send_id="abc",
                    request_base="https://anything.example",
                )
                return out
            finally:
                if created:
                    await db.landing_pages.delete_one({"id": "test-iter36b"})
                client.close()

        try:
            out = asyncio.run(_run())
            assert (
                "https://staging.example.com/info/"
                "creative-mojo-franchise-pack?t=abc"
            ) in out
        finally:
            os.environ.pop("PUBLIC_BASE_URL", None)


# ---------------------------------------------------------------- 2) postcode wrap
class TestPostcodeWrapFix:
    """signature_html must keep 'Devon EX15 1NB' on one line via &nbsp;."""

    def test_signature_html_in_seed_module(self):
        from seed_email_templates import SIGNATURE_HTML
        # Both occurrences (signature line + registered-address footer)
        # use the &nbsp; entity to keep the postcode glued to EX15.
        count = SIGNATURE_HTML.count("EX15&nbsp;1NB")
        assert count >= 2, (
            f"Expected at least 2 occurrences of 'EX15&nbsp;1NB' in "
            f"SIGNATURE_HTML, found {count}"
        )
        # And the broken pattern (space) must not be present anywhere.
        assert "EX15 1NB" not in SIGNATURE_HTML, (
            "Found 'EX15 1NB' (plain space) in SIGNATURE_HTML — "
            "postcode will wrap onto its own line."
        )

    def test_get_email_template_includes_fixed_signature(self, admin_session):
        # Pick any template and assert response carries the fixed signature
        r = admin_session.get(f"{BASE_URL}/api/email-templates")
        assert r.status_code == 200, r.text
        data = r.json()
        items = data.get("items") or data
        assert items and len(items) > 0, "no email templates seeded"
        tpl_id = items[0]["id"]

        r2 = admin_session.get(f"{BASE_URL}/api/email-templates/{tpl_id}")
        assert r2.status_code == 200, r2.text
        tpl = r2.json()
        sig = tpl.get("signature_html") or ""
        assert sig, "signature_html missing from GET /email-templates/{id}"
        assert sig.count("EX15&nbsp;1NB") >= 2, (
            f"Expected 2 occurrences of EX15&nbsp;1NB in signature_html, "
            f"got {sig.count('EX15&nbsp;1NB')}. Signature head: {sig[:300]}"
        )
        assert "EX15 1NB" not in sig, (
            "Plain-space 'EX15 1NB' leaked into signature_html"
        )


# ---------------------------------------------------------------- 3) regression: /info
class TestInfoPageRegression:
    def test_public_landing_page_loads(self):
        slug = "creative-mojo-franchise-pack"
        r = requests.get(f"{BASE_URL}/api/landing-pages/{slug}")
        # Endpoint may differ — just check that the slug resolves SOMEWHERE
        # (200) or that the public page itself is reachable.
        public = requests.get(f"{BASE_URL}/info/{slug}", allow_redirects=True)
        assert public.status_code == 200, (
            f"Public /info/{slug} returned {public.status_code}"
        )
        # Should at minimum embed the slug or a hub.creativemojo reference
        assert "Mojo" in public.text or "mojo" in public.text.lower()
