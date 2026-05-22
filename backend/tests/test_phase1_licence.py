"""Backend tests for iteration 7 - Licence Contacts tab + referral_source.

Covers:
- GET /api/contacts?tab=licence  -> only source=licence_enquiry, in_pipeline != True
- GET /api/contacts?tab=franchise -> only source=franchise_enquiry (no licence)
- Move target=licence on franchise/general/legacy contact
- Move target=licence on licence_enquiry record in pipeline
- Move target=franchise on a licence_enquiry record -> source becomes franchise_enquiry
- Bulk-move target=licence with 3 valid ids
- Intake gravity-forms: form_id=32 (spread-key Instagram), 17 (single label), 1 (no referral)
- _detect_referral_source helper unit tests (imported directly)
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


def _intake(form_id: int, suffix: str, extra_fields: dict | None = None, token: str = INTAKE_TOKEN):
    entry_id = f"TEST-lic-{suffix}-{uuid.uuid4().hex[:6]}"
    fields = {
        "First Name": "LicTest",
        "Last Name": suffix,
        "Email": f"lic.{suffix}.{uuid.uuid4().hex[:4]}@example.com",
        "Telephone": "07000000000",
    }
    if extra_fields:
        fields.update(extra_fields)
    payload = {"form_id": form_id, "entry_id": entry_id, "fields": fields}
    r = requests.post(f"{BASE_URL}/api/intake/gravity-forms",
                      json=payload, headers={"X-Intake-Token": token})
    assert r.status_code == 200, r.text
    return r.json()["id"]


# ---------------------------------------------------------------------------
# GET /api/contacts?tab=licence / tab=franchise
# ---------------------------------------------------------------------------
class TestTabFilters:
    def test_tab_licence_returns_only_licence_enquiry_not_in_pipeline(self, admin_session):
        r = admin_session.get(f"{BASE_URL}/api/contacts?tab=licence&limit=10")
        assert r.status_code == 200, r.text
        body = r.json()
        items = body.get("items", [])
        assert len(items) >= 1, "expected at least 1 licence contact (Sally Hare)"
        for it in items:
            assert it.get("source") == "licence_enquiry", f"unexpected source {it.get('source')}"
            assert it.get("in_pipeline") is not True, f"item {it.get('id')} in pipeline"
        # Verify Sally Hare is present
        names = [(it.get("first_name") or "") + " " + (it.get("last_name") or "") for it in items]
        assert any("Sally" in n and "Hare" in n for n in names), f"Sally Hare not found in {names}"

    def test_tab_franchise_excludes_licence_records(self, admin_session):
        r = admin_session.get(f"{BASE_URL}/api/contacts?tab=franchise&limit=2000")
        assert r.status_code == 200
        body = r.json()
        items = body.get("items", [])
        assert len(items) >= 1000, f"expected 1000+ franchise contacts, got {len(items)}"
        for it in items:
            assert it.get("source") == "franchise_enquiry", \
                f"item {it.get('id')} has source {it.get('source')}, expected franchise_enquiry"
            assert it.get("in_pipeline") is not True


# ---------------------------------------------------------------------------
# POST /api/contacts/{id}/move target=licence
# ---------------------------------------------------------------------------
class TestMoveTargetLicence:
    def test_move_franchise_contact_to_licence(self, admin_session):
        # Create a franchise_enquiry record and move to licence
        cid = _intake(17, "fran-to-lic")
        try:
            r = admin_session.post(f"{BASE_URL}/api/contacts/{cid}/move",
                                   json={"target": "licence"})
            assert r.status_code == 200, r.text
            assert r.json()["ok"] is True
            g = admin_session.get(f"{BASE_URL}/api/contacts/{cid}").json()
            c = g["contact"]
            assert c["source"] == "licence_enquiry"
            assert c["in_pipeline"] is False
            # And it appears in tab=licence listing
            listing = admin_session.get(f"{BASE_URL}/api/contacts?tab=licence&limit=2000").json()
            ids = [it["id"] for it in listing.get("items", [])]
            assert cid in ids, "moved contact not found in tab=licence"
        finally:
            admin_session.delete(f"{BASE_URL}/api/contacts/{cid}")

    def test_move_general_contact_to_licence(self, admin_session):
        cid = _intake(1, "gen-to-lic")
        try:
            r = admin_session.post(f"{BASE_URL}/api/contacts/{cid}/move",
                                   json={"target": "licence"})
            assert r.status_code == 200
            c = admin_session.get(f"{BASE_URL}/api/contacts/{cid}").json()["contact"]
            assert c["source"] == "licence_enquiry"
            assert c["in_pipeline"] is False
        finally:
            admin_session.delete(f"{BASE_URL}/api/contacts/{cid}")

    def test_move_licence_in_pipeline_back_to_licence_tab(self, admin_session):
        # Create a licence_enquiry record, push to pipeline, then move back to licence tab
        cid = _intake(32, "lic-pipe-back", extra_fields={"Instagram": "Instagram"})
        try:
            # Push to pipeline
            r1 = admin_session.post(f"{BASE_URL}/api/contacts/{cid}/move",
                                    json={"target": "pipeline", "pipeline_status": "new"})
            assert r1.status_code == 200
            c1 = admin_session.get(f"{BASE_URL}/api/contacts/{cid}").json()["contact"]
            assert c1["in_pipeline"] is True
            assert c1["source"] == "licence_enquiry"  # source preserved
            # Move back to licence tab
            r2 = admin_session.post(f"{BASE_URL}/api/contacts/{cid}/move",
                                    json={"target": "licence"})
            assert r2.status_code == 200
            c2 = admin_session.get(f"{BASE_URL}/api/contacts/{cid}").json()["contact"]
            assert c2["source"] == "licence_enquiry"
            assert c2["in_pipeline"] is False
            # Appears in tab=licence
            listing = admin_session.get(f"{BASE_URL}/api/contacts?tab=licence&limit=2000").json()
            assert any(it["id"] == cid for it in listing.get("items", []))
        finally:
            admin_session.delete(f"{BASE_URL}/api/contacts/{cid}")

    def test_move_licence_to_franchise_changes_source(self, admin_session):
        cid = _intake(32, "lic-to-fran", extra_fields={"Instagram": "Instagram"})
        try:
            # confirm starting state
            c0 = admin_session.get(f"{BASE_URL}/api/contacts/{cid}").json()["contact"]
            assert c0["source"] == "licence_enquiry"
            r = admin_session.post(f"{BASE_URL}/api/contacts/{cid}/move",
                                   json={"target": "franchise"})
            assert r.status_code == 200
            c = admin_session.get(f"{BASE_URL}/api/contacts/{cid}").json()["contact"]
            assert c["source"] == "franchise_enquiry"
            assert c["in_pipeline"] is False
        finally:
            admin_session.delete(f"{BASE_URL}/api/contacts/{cid}")


# ---------------------------------------------------------------------------
# Bulk-move target=licence
# ---------------------------------------------------------------------------
class TestBulkMoveLicence:
    def test_bulk_move_3_to_licence(self, admin_session):
        ids = [_intake(1, f"bulk-lic-{i}") for i in range(3)]
        try:
            r = admin_session.post(
                f"{BASE_URL}/api/contacts/bulk-move",
                json={"ids": ids, "target": "licence"},
            )
            assert r.status_code == 200, r.text
            body = r.json()
            assert body["moved"] == 3
            assert body.get("not_found", 0) == 0
            for cid in ids:
                c = admin_session.get(f"{BASE_URL}/api/contacts/{cid}").json()["contact"]
                assert c["source"] == "licence_enquiry"
                assert c["in_pipeline"] is False
        finally:
            for cid in ids:
                admin_session.delete(f"{BASE_URL}/api/contacts/{cid}")


# ---------------------------------------------------------------------------
# Intake referral_source detection
# ---------------------------------------------------------------------------
class TestIntakeReferralSource:
    def test_intake_form32_spread_keys_instagram(self, admin_session):
        cid = _intake(32, "form32-ig",
                      extra_fields={"Instagram": "Instagram", "Instagram Name": "Instagram"})
        try:
            c = admin_session.get(f"{BASE_URL}/api/contacts/{cid}").json()["contact"]
            assert c["referral_source"] == "Instagram"
            assert c["source"] == "licence_enquiry"
            assert c["in_pipeline"] is False
        finally:
            admin_session.delete(f"{BASE_URL}/api/contacts/{cid}")

    def test_intake_form17_single_label_facebook(self, admin_session):
        cid = _intake(17, "form17-fb",
                      extra_fields={"Where did you hear about Creative Mojo?": "Facebook"})
        try:
            c = admin_session.get(f"{BASE_URL}/api/contacts/{cid}").json()["contact"]
            assert c["referral_source"] == "Facebook"
            assert c["source"] == "franchise_enquiry"
            assert c["in_pipeline"] is False
        finally:
            admin_session.delete(f"{BASE_URL}/api/contacts/{cid}")

    def test_intake_form1_no_referral_keys(self, admin_session):
        cid = _intake(1, "form1-none")
        try:
            c = admin_session.get(f"{BASE_URL}/api/contacts/{cid}").json()["contact"]
            assert c.get("referral_source") in (None, "")
            assert c["in_pipeline"] is False
        finally:
            admin_session.delete(f"{BASE_URL}/api/contacts/{cid}")


# ---------------------------------------------------------------------------
# Unit test for _detect_referral_source helper (imported from server)
# ---------------------------------------------------------------------------
class TestDetectReferralSourceHelper:
    @pytest.fixture(scope="class")
    def detect(self):
        # Import lazily so missing pkgs in non-backend envs don't break collection
        import sys
        sys.path.insert(0, "/app/backend")
        from server import _detect_referral_source  # noqa
        return _detect_referral_source

    def test_spread_keys_instagram(self, detect):
        assert detect({"Instagram": "Instagram", "Instagram Name": "Instagram"}) == "Instagram"

    def test_single_labelled_google(self, detect):
        assert detect({"Where did you hear about us": "Google"}) == "Google"

    def test_empty_returns_none(self, detect):
        assert detect({}) is None

    def test_no_matches_returns_none(self, detect):
        assert detect({"random": "value", "First Name": "Bob"}) is None

    def test_facebook_spread_key(self, detect):
        assert detect({"Facebook": "Facebook"}) == "Facebook"

    def test_x_spread_key(self, detect):
        assert detect({"X": "X"}) == "X"
