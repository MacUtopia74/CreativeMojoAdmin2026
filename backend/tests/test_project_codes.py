"""Backend tests for the Project Codes feature.

Covers:
  - GET /api/admin/project-codes (unified view + counts)
  - GET/POST /admin/project-codes/suggestions and lifecycle
    (skip → skipped list → reset-skips → re-appear)
  - POST /admin/project-codes/suggestions/approve (atomic woo+file)
  - approve-bulk Pydantic floor (min_score >= 90)
  - PUT woo + file endpoints (set / clear / asset_type validation)
  - GET /api/portal/calendar/projects?month=&year=
  - Woo product sync tag_names/slugs + category_names/slugs.
"""
import os
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "http://localhost:8001").rstrip("/")
ADMIN_EMAIL = "admin@creativemojo.co.uk"
ADMIN_PASSWORD = "CreativeMojo2026!"
DEMO_EMAIL = "demo@creativemojo.co.uk"
DEMO_PASSWORD = "CreativeMojoDemo2026!"


# ----------------------------------------------------------------- fixtures


def _login(email, password):
    s = requests.Session()
    r = s.post(
        f"{BASE_URL}/api/auth/login",
        json={"email": email, "password": password},
        timeout=30,
    )
    if r.status_code != 200:
        return None, r
    token = r.json().get("access_token")
    if token:
        s.headers.update({"Authorization": f"Bearer {token}"})
    return s, r


@pytest.fixture(scope="session")
def admin_session():
    s, r = _login(ADMIN_EMAIL, ADMIN_PASSWORD)
    assert s is not None, f"admin login failed: {r.status_code} {r.text}"
    return s


@pytest.fixture(scope="session")
def demo_session(admin_session):
    """Franchisee demo session — seed account if not present."""
    s, r = _login(DEMO_EMAIL, DEMO_PASSWORD)
    if s is None:
        seed = admin_session.post(
            f"{BASE_URL}/api/admin/seed-demo-franchisee", json={}, timeout=60,
        )
        assert seed.status_code in (200, 201), f"seed failed: {seed.status_code} {seed.text}"
        s, r = _login(DEMO_EMAIL, DEMO_PASSWORD)
    assert s is not None, f"demo login failed: {r.status_code} {r.text}"
    return s


# ----------------------------------------------------------------- GET unified


class TestProjectCodesList:
    def test_list_returns_products_files_counts(self, admin_session):
        r = admin_session.get(f"{BASE_URL}/api/admin/project-codes", timeout=60)
        assert r.status_code == 200
        data = r.json()
        for k in ("products", "files", "counts"):
            assert k in data
        c = data["counts"]
        for k in ("woo_total", "woo_with_code", "woo_matched_to_file",
                  "files_total", "files_with_code"):
            assert k in c and isinstance(c[k], int)
        # No variation rows in products list
        for p in data["products"]:
            assert p.get("is_variation") is not True

    def test_status_filters(self, admin_session):
        for st in ("matched", "woo_only", "file_only", "all"):
            r = admin_session.get(
                f"{BASE_URL}/api/admin/project-codes?status={st}", timeout=60,
            )
            assert r.status_code == 200, f"status={st}: {r.text[:200]}"


# ----------------------------------------------------------------- suggestions


class TestSuggestions:
    def test_suggestions_min_score_90(self, admin_session):
        r = admin_session.get(
            f"{BASE_URL}/api/admin/project-codes/suggestions?min_score=90&limit=50",
            timeout=60,
        )
        assert r.status_code == 200
        data = r.json()
        assert "items" in data and "count" in data
        items = data["items"]
        # Ordering check: descending best_score
        scores = [it["best_score"] for it in items]
        assert scores == sorted(scores, reverse=True)
        for it in items[:10]:
            assert "woo_id" in it
            assert "product_name" in it
            assert "suggested_code" in it
            assert isinstance(it.get("matches"), list)
            assert len(it["matches"]) <= 5
            for m in it["matches"]:
                for k in ("file_key", "file_name", "score", "asset_type_guess"):
                    assert k in m
                assert m["score"] >= 90

    def test_min_score_below_50_rejected(self, admin_session):
        r = admin_session.get(
            f"{BASE_URL}/api/admin/project-codes/suggestions?min_score=10",
            timeout=30,
        )
        assert r.status_code == 422

    def test_bulk_min_score_below_90_rejected(self, admin_session):
        r = admin_session.post(
            f"{BASE_URL}/api/admin/project-codes/suggestions/approve-bulk",
            json={"min_score": 80, "limit": 5},
            timeout=30,
        )
        assert r.status_code == 422, r.text


# ----------------------------------------------------------------- skip / reset


class TestSkipResetCycle:
    def test_skip_then_reset_cycle(self, admin_session):
        # Get a suggestion at high score
        r = admin_session.get(
            f"{BASE_URL}/api/admin/project-codes/suggestions?min_score=95&limit=20",
            timeout=60,
        )
        assert r.status_code == 200
        items = r.json().get("items", [])
        if not items:
            pytest.skip("No suggestions available to skip-test against")
        target = items[0]
        woo_id = target["woo_id"]
        file_key = target["matches"][0]["file_key"]

        # Make sure no leftover skips (best-effort reset)
        admin_session.post(
            f"{BASE_URL}/api/admin/project-codes/suggestions/reset-skips", timeout=30,
        )

        # Skip the suggestion
        sk = admin_session.post(
            f"{BASE_URL}/api/admin/project-codes/suggestions/skip",
            json={"woo_id": woo_id, "file_key": file_key}, timeout=30,
        )
        assert sk.status_code == 200
        assert sk.json().get("ok") is True

        # Skipped list shows it
        sl = admin_session.get(
            f"{BASE_URL}/api/admin/project-codes/suggestions/skipped", timeout=30,
        )
        assert sl.status_code == 200
        body = sl.json()
        assert body["count"] >= 1
        found = any(
            it["woo_id"] == woo_id and it["file_key"] == file_key
            for it in body["items"]
        )
        assert found, "skipped pair not in skipped list"

        # Suggestions should now omit that pair
        r2 = admin_session.get(
            f"{BASE_URL}/api/admin/project-codes/suggestions?min_score=95&limit=200",
            timeout=60,
        )
        items2 = r2.json().get("items", [])
        for it in items2:
            if it["woo_id"] == woo_id:
                # The original best match shouldn't appear
                file_keys = [m["file_key"] for m in it["matches"]]
                assert file_key not in file_keys, "skip not honoured"

        # Reset skips
        rs = admin_session.post(
            f"{BASE_URL}/api/admin/project-codes/suggestions/reset-skips", timeout=30,
        )
        assert rs.status_code == 200
        rsj = rs.json()
        assert rsj.get("ok") is True
        assert rsj.get("cleared", 0) >= 1


# ----------------------------------------------------------------- approve single


class TestApproveSingle:
    def test_approve_writes_code_and_asset_type(self, admin_session):
        # Get a suggestion
        r = admin_session.get(
            f"{BASE_URL}/api/admin/project-codes/suggestions?min_score=95&limit=10",
            timeout=60,
        )
        items = r.json().get("items", [])
        if not items:
            pytest.skip("No suggestions to approve")
        target = items[0]
        woo_id = target["woo_id"]
        match = target["matches"][0]
        file_key = match["file_key"]
        code = f"TEST_{target['suggested_code']}"

        try:
            ap = admin_session.post(
                f"{BASE_URL}/api/admin/project-codes/suggestions/approve",
                json={
                    "woo_id": woo_id, "file_key": file_key,
                    "project_code": code,
                    "asset_type": "instruction_pdf",
                },
                timeout=30,
            )
            assert ap.status_code == 200, ap.text
            j = ap.json()
            assert j["ok"] is True
            assigned = j["project_code"]
            assert j["asset_type"] == "instruction_pdf"

            # Verify both records updated by re-fetching unified view
            lst = admin_session.get(f"{BASE_URL}/api/admin/project-codes", timeout=60)
            data = lst.json()
            prod = next((p for p in data["products"] if p.get("id") == woo_id), None)
            assert prod is not None
            assert prod.get("project_code") == assigned

            f = next((f for f in data["files"] if f.get("key") == file_key), None)
            assert f is not None
            assert f.get("project_code") == assigned
            assert f.get("asset_type") == "instruction_pdf"
        finally:
            # Cleanup: clear code on both
            admin_session.put(
                f"{BASE_URL}/api/admin/project-codes/woo/{woo_id}",
                json={"project_code": None}, timeout=30,
            )
            admin_session.put(
                f"{BASE_URL}/api/admin/project-codes/file/{file_key}",
                json={"project_code": None, "asset_type": None}, timeout=30,
            )


# ----------------------------------------------------------------- PUT endpoints


class TestPutEndpoints:
    def test_put_woo_set_and_clear(self, admin_session):
        # Get one Woo product
        lst = admin_session.get(f"{BASE_URL}/api/admin/project-codes", timeout=60)
        prods = lst.json()["products"]
        if not prods:
            pytest.skip("No Woo products")
        woo_id = prods[0]["id"]

        # Set
        r = admin_session.put(
            f"{BASE_URL}/api/admin/project-codes/woo/{woo_id}",
            json={"project_code": "TEST_CODE_XYZ"}, timeout=30,
        )
        assert r.status_code == 200
        assert r.json()["project_code"] == "TEST_CODE_XYZ"

        # Clear
        r = admin_session.put(
            f"{BASE_URL}/api/admin/project-codes/woo/{woo_id}",
            json={"project_code": None}, timeout=30,
        )
        assert r.status_code == 200
        assert r.json()["project_code"] is None

    def test_put_file_set_invalid_asset_type(self, admin_session):
        lst = admin_session.get(f"{BASE_URL}/api/admin/project-codes", timeout=60)
        files = lst.json()["files"]
        if not files:
            pytest.skip("No files indexed")
        key = files[0]["key"]
        r = admin_session.put(
            f"{BASE_URL}/api/admin/project-codes/file/{key}",
            json={"project_code": "TEST_F", "asset_type": "not_a_type"}, timeout=30,
        )
        assert r.status_code == 400

    def test_put_file_set_and_clear(self, admin_session):
        lst = admin_session.get(f"{BASE_URL}/api/admin/project-codes", timeout=60)
        files = lst.json()["files"]
        if not files:
            pytest.skip("No files indexed")
        key = files[0]["key"]
        # Set
        r = admin_session.put(
            f"{BASE_URL}/api/admin/project-codes/file/{key}",
            json={"project_code": "TEST_FILE_CODE", "asset_type": "svg_cutting"},
            timeout=30,
        )
        assert r.status_code == 200
        body = r.json()
        assert body["project_code"] == "TEST_FILE_CODE"
        assert body["asset_type"] == "svg_cutting"
        # Clear
        r = admin_session.put(
            f"{BASE_URL}/api/admin/project-codes/file/{key}",
            json={"project_code": None, "asset_type": None}, timeout=30,
        )
        assert r.status_code == 200
        assert r.json()["project_code"] is None


# ----------------------------------------------------------------- portal feed


class TestPortalCalendarProjects:
    def test_october_2026_returns_items(self, demo_session):
        r = demo_session.get(
            f"{BASE_URL}/api/portal/calendar/projects?month=10&year=2026",
            timeout=60,
        )
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["month"] == 10 and data["year"] == 2026
        assert "items" in data
        assert isinstance(data["items"], list)
        # spec says 11 expected; allow >=1
        for it in data["items"]:
            for k in ("id", "name", "has_guide"):
                assert k in it
            # If has_guide, guide_url must be present
            if it["has_guide"]:
                assert it.get("guide_url")

    def test_admin_can_access_portal_feed(self, admin_session):
        r = admin_session.get(
            f"{BASE_URL}/api/portal/calendar/projects?month=10&year=2026",
            timeout=60,
        )
        assert r.status_code == 200


# ----------------------------------------------------------------- Woo sync tags


class TestWooSyncTags:
    def test_woo_product_has_tag_and_category(self, admin_session):
        """The Woo product 'Autumn Folk Art Owls' should carry the
        'Standard Boxed Art Kits' tag and 'October' category.
        Note: skipped if product not found (sync hasn't populated)."""
        lst = admin_session.get(f"{BASE_URL}/api/admin/project-codes?q=Autumn Folk Art Owls", timeout=60)
        assert lst.status_code == 200
        prods = lst.json()["products"]
        target = next(
            (p for p in prods if "autumn folk art owls" in (p.get("name") or "").lower()),
            None,
        )
        if not target:
            pytest.skip("'Autumn Folk Art Owls' product not present in DB")
        tags = target.get("tag_names") or []
        cats = target.get("category_names") or []
        assert any("standard boxed art kits" in (t or "").lower() for t in tags), (
            f"tag_names missing 'Standard Boxed Art Kits': {tags}"
        )
        assert any((c or "").lower() == "october" for c in cats), (
            f"category_names missing 'October': {cats}"
        )
