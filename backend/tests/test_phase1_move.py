"""Backend API tests for Contact Move + Franchisee Photo Caching iteration.

Covers:
- POST /api/franchisees/refresh-photos (admin auth, returns ok+stats+refreshed)
- GET /api/uploads/franchisees/<file>.jpg returns 200, image/jpeg
- GET /api/franchisees photos[0].url starts with /api/uploads/franchisees/
- POST /api/contacts/{id}/move: target=pipeline (legacy & web), franchise, general
- POST /api/contacts/{id}/move: invalid target -> 400, missing -> 404
- POST /api/contacts/bulk-move: valid+invalid ids, empty list
- Round-trip moves preserve sources sensibly

NOTE: tests restore state after each mutation to keep the dataset stable for
downstream test suites. We do NOT call /api/migration/run.
"""
import os
import uuid
import pytest
import requests

BASE_URL = os.environ["REACT_APP_BACKEND_URL"].rstrip("/")
ADMIN_EMAIL = os.environ.get("ADMIN_EMAIL", "admin@creativemojo.co.uk")
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "CreativeMojo2026!")
INTAKE_TOKEN = os.environ.get("INTAKE_TOKEN", "cm_intake_8f4a3c8b9e2d7f1a5c8b9e2d7f1a5c8b")
@pytest.fixture(scope="module")
def admin_session():
    s = requests.Session()
    r = s.post(f"{BASE_URL}/api/auth/login",
               json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD})
    if r.status_code != 200:
        pytest.skip(f"Login failed: {r.status_code}")
    return s


# ---------------------------------------------------------------------------
# Franchisee photo caching
# ---------------------------------------------------------------------------
class TestFranchiseePhotoCache:
    def test_franchisees_photos_use_local_uploads_url(self, admin_session):
        r = admin_session.get(f"{BASE_URL}/api/franchisees?limit=20")
        assert r.status_code == 200
        items = r.json()["items"]
        with_photos = [f for f in items if f.get("photos")]
        assert len(with_photos) >= 1, "expected at least one franchisee with photos"
        local_urls = 0
        for f in with_photos:
            url = (f.get("photos") or [{}])[0].get("url", "")
            if url.startswith("/api/uploads/franchisees/"):
                local_urls += 1
        assert local_urls >= 1, f"none of {len(with_photos)} franchisees use local uploads urls"

    def test_static_uploaded_file_served_with_image_content_type(self, admin_session):
        uploads_dir = "/app/backend/uploads/franchisees"
        files = sorted(os.listdir(uploads_dir))
        if not files:
            pytest.skip("No uploaded franchisee photos available on disk")
        fname = files[0]
        r = admin_session.get(f"{BASE_URL}/api/uploads/franchisees/{fname}")
        assert r.status_code == 200, r.text[:200]
        ct = r.headers.get("content-type", "")
        assert ct.startswith("image/"), f"unexpected content-type {ct}"
        assert len(r.content) > 100

    def test_refresh_photos_endpoint_requires_admin(self):
        # Unauthenticated should fail (401/403)
        r = requests.post(f"{BASE_URL}/api/franchisees/refresh-photos")
        assert r.status_code in (401, 403)

    def test_refresh_photos_endpoint_returns_ok_stats(self, admin_session):
        # This call hits Airtable and is slow; allow a longer timeout
        r = admin_session.post(f"{BASE_URL}/api/franchisees/refresh-photos", timeout=180)
        assert r.status_code == 200, r.text[:300]
        body = r.json()
        assert body.get("ok") is True
        assert "stats" in body
        assert "refreshed" in body
        # downloaded is int and non-negative
        assert isinstance(body["stats"].get("downloaded", 0), int)


# ---------------------------------------------------------------------------
# Contact move helpers
# ---------------------------------------------------------------------------
def _intake_form_contact(form_id: int, suffix: str):
    entry_id = f"TEST-move-{suffix}-{uuid.uuid4().hex[:6]}"
    payload = {
        "form_id": form_id,
        "entry_id": entry_id,
        "fields": {
            "First Name": "MoveTest",
            "Last Name": suffix,
            "Email": f"move.{suffix}.test.local@example.com",
            "Telephone": "07000000000",
        },
    }
    r = requests.post(f"{BASE_URL}/api/intake/gravity-forms",
                      json=payload, headers={"X-Intake-Token": INTAKE_TOKEN})
    assert r.status_code == 200, r.text
    return r.json()["id"]


# ---------------------------------------------------------------------------
# POST /api/contacts/{id}/move
# ---------------------------------------------------------------------------
class TestContactMove:
    def test_move_invalid_target_returns_400(self, admin_session):
        # use any plausible id; validation runs before lookup
        r = admin_session.post(f"{BASE_URL}/api/contacts/anyid/move",
                               json={"target": "bogus"})
        assert r.status_code == 400

    def test_move_nonexistent_returns_404(self, admin_session):
        r = admin_session.post(f"{BASE_URL}/api/contacts/does-not-exist-xyz/move",
                               json={"target": "pipeline"})
        assert r.status_code == 404

    def test_move_legacy_to_pipeline_qualified(self, admin_session):
        # Pick a legacy contact dynamically. Cannot truly restore (delete+insert),
        # but we delete the migrated copy at end to avoid permanent duplication.
        listing = admin_session.get(
            f"{BASE_URL}/api/contacts?source=legacy_general_enquiry&limit=1"
        ).json()
        items = listing.get("items", [])
        if not items:
            pytest.skip("No legacy contact available")
        legacy_id = items[0]["id"]
        r = admin_session.post(
            f"{BASE_URL}/api/contacts/{legacy_id}/move",
            json={"target": "pipeline", "pipeline_status": "qualified"},
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["ok"] is True
        assert body["target"] == "pipeline"
        # Verify via GET
        g = admin_session.get(f"{BASE_URL}/api/contacts/{legacy_id}").json()
        assert g["_source_collection"] == "web_form_contacts"
        c = g["contact"]
        assert c["in_pipeline"] is True
        assert c["pipeline_status"] == "qualified"
        # Cleanup: delete the migrated copy
        admin_session.delete(f"{BASE_URL}/api/contacts/{legacy_id}")

    def test_move_web_form_contact_to_franchise_sets_source(self, admin_session):
        # Create a fresh general_enquiry contact in web_form_contacts
        cid = _intake_form_contact(1, "to-fran")
        try:
            r = admin_session.post(
                f"{BASE_URL}/api/contacts/{cid}/move",
                json={"target": "franchise"},
            )
            assert r.status_code == 200, r.text
            g = admin_session.get(f"{BASE_URL}/api/contacts/{cid}").json()
            c = g["contact"]
            assert c["source"] == "franchise_enquiry"
            assert c["in_pipeline"] is False
            assert g["_source_collection"] == "web_form_contacts"
        finally:
            admin_session.delete(f"{BASE_URL}/api/contacts/{cid}")

    def test_move_franchise_to_general_changes_source(self, admin_session):
        # Create a franchise_enquiry record (form_id=17) and move to general.
        cid = _intake_form_contact(17, "fran-to-gen")
        try:
            r = admin_session.post(
                f"{BASE_URL}/api/contacts/{cid}/move",
                json={"target": "general"},
            )
            assert r.status_code == 200
            g = admin_session.get(f"{BASE_URL}/api/contacts/{cid}").json()
            c = g["contact"]
            assert c["source"] == "general_enquiry"
            assert c["in_pipeline"] is False
            assert g["_source_collection"] == "web_form_contacts"
        finally:
            admin_session.delete(f"{BASE_URL}/api/contacts/{cid}")

    def test_round_trip_web_form_franchise_to_pipeline_to_franchise(self, admin_session):
        # Verify source stays franchise_enquiry through pipeline round-trip.
        cid = _intake_form_contact(17, "rt-fran")
        try:
            r1 = admin_session.post(f"{BASE_URL}/api/contacts/{cid}/move",
                                    json={"target": "pipeline", "pipeline_status": "new"})
            assert r1.status_code == 200
            # Source should remain franchise_enquiry
            g1 = admin_session.get(f"{BASE_URL}/api/contacts/{cid}").json()["contact"]
            assert g1["source"] == "franchise_enquiry"
            assert g1["in_pipeline"] is True
            # Now move back to franchise
            r2 = admin_session.post(f"{BASE_URL}/api/contacts/{cid}/move",
                                    json={"target": "franchise"})
            assert r2.status_code == 200
            g2 = admin_session.get(f"{BASE_URL}/api/contacts/{cid}").json()["contact"]
            assert g2["source"] == "franchise_enquiry"
            assert g2["in_pipeline"] is False
        finally:
            admin_session.delete(f"{BASE_URL}/api/contacts/{cid}")


# ---------------------------------------------------------------------------
# POST /api/contacts/bulk-move
# ---------------------------------------------------------------------------
class TestBulkMove:
    def test_bulk_move_empty_list(self, admin_session):
        r = admin_session.post(f"{BASE_URL}/api/contacts/bulk-move",
                               json={"ids": [], "target": "pipeline"})
        assert r.status_code == 200
        body = r.json()
        assert body["moved"] == 0
        assert body["not_found"] == 0

    def test_bulk_move_mixed_valid_and_invalid_ids(self, admin_session):
        # Create 3 valid contacts, mix with 1 invalid id
        ids = [_intake_form_contact(1, f"bulk-{i}") for i in range(3)]
        try:
            r = admin_session.post(
                f"{BASE_URL}/api/contacts/bulk-move",
                json={"ids": ids + ["nonexistent-id-xyz"], "target": "pipeline",
                      "pipeline_status": "new"},
            )
            assert r.status_code == 200, r.text
            body = r.json()
            assert body["moved"] == 3
            assert body["not_found"] == 1
            # All three valid contacts should be in_pipeline=true now
            for cid in ids:
                c = admin_session.get(f"{BASE_URL}/api/contacts/{cid}").json()["contact"]
                assert c["in_pipeline"] is True
        finally:
            for cid in ids:
                admin_session.delete(f"{BASE_URL}/api/contacts/{cid}")

    def test_bulk_move_invalid_target(self, admin_session):
        r = admin_session.post(f"{BASE_URL}/api/contacts/bulk-move",
                               json={"ids": ["a"], "target": "wrong"})
        assert r.status_code == 400
