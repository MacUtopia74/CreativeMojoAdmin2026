"""Backend API tests for Phase 1 iteration: in_pipeline flag,
promote/demote/delete actions on contacts.

Covers:
- Startup backfill: 1674 web_form_contacts have in_pipeline=true
- POST /api/intake/gravity-forms form_id=1 → in_pipeline=false
- POST /api/intake/gravity-forms form_id=17 → in_pipeline=true, pipeline_status='new'
- POST /api/intake/gravity-forms form_id=32 → in_pipeline=true, pipeline_status='new'
- GET /api/contacts?in_pipeline=true/false filter behaviour
- GET /api/contacts (no filter) returns both collections
- GET /api/contacts?source=general_enquiry / licence_enquiry
- PATCH /promote on web_form_contact (general) → in_pipeline=true
- PATCH /promote on legacy contact → moved to web_form_contacts, promoted_from_legacy=true
- PATCH /demote → in_pipeline=false
- PATCH /demote on non-existent → 404
- DELETE on web_form_contact, legacy, non-existent
- PATCH /pipeline also sets in_pipeline=true (implicit promote)
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


def _intake(form_id: int, entry_suffix: str, email_suffix: str):
    """Submit a gravity-forms intake and return the inserted contact id."""
    entry_id = f"TEST-pipe-{entry_suffix}-{uuid.uuid4().hex[:6]}"
    payload = {
        "form_id": form_id,
        "entry_id": entry_id,
        "fields": {
            "First Name": "PipeTest",
            "Last Name": entry_suffix,
            "Email": f"pipe.{email_suffix}.test.local@example.com",
            "Telephone": "07000000000",
        },
    }
    r = requests.post(
        f"{BASE_URL}/api/intake/gravity-forms",
        json=payload,
        headers={"X-Intake-Token": INTAKE_TOKEN},
    )
    assert r.status_code == 200, r.text
    return r.json()["id"], entry_id


@pytest.fixture(scope="module", autouse=True)
def restore_data_after_module(admin_session):
    """After this module runs (which deletes/promotes legacy contacts),
    re-run migration to restore baseline counts for downstream tests."""
    yield
    try:
        admin_session.post(f"{BASE_URL}/api/migration/run", timeout=120)
    except Exception:
        pass


@pytest.fixture(scope="module")
def created_ids(admin_session):
    """Create one of each form_id, return mapping. Cleanup at end."""
    ids = {}
    ids["form1"], _ = _intake(1, "form1", "f1")
    ids["form17"], _ = _intake(17, "form17", "f17")
    ids["form32"], _ = _intake(32, "form32", "f32")
    yield ids
    # Cleanup — delete any TEST-pipe records
    for cid in list(ids.values()):
        try:
            admin_session.delete(f"{BASE_URL}/api/contacts/{cid}")
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Startup backfill
# ---------------------------------------------------------------------------
class TestStartupBackfill:
    def test_at_least_1674_in_pipeline_true(self, admin_session):
        r = admin_session.get(f"{BASE_URL}/api/contacts?in_pipeline=true&limit=2000")
        assert r.status_code == 200
        items = r.json()["items"]
        # 1674 franchise/licence + maybe a few test data submissions
        assert len(items) >= 1674, f"Got {len(items)}"
        # Every item must have in_pipeline == True
        for it in items:
            assert it.get("in_pipeline") is True, it.get("id")

    def test_legacy_count_unchanged(self, admin_session):
        r = admin_session.get(f"{BASE_URL}/api/dashboard/stats")
        assert r.status_code == 200
        # 5958 legacy + 1674 web_form_contacts; new test submissions add a few
        assert r.json()["contacts_migrated"] >= 7632


# ---------------------------------------------------------------------------
# Intake form_id → in_pipeline mapping
# ---------------------------------------------------------------------------
class TestIntakeInPipelineFlag:
    def test_form1_creates_non_pipeline_record(self, admin_session, created_ids):
        cid = created_ids["form1"]
        r = admin_session.get(f"{BASE_URL}/api/contacts/{cid}")
        assert r.status_code == 200
        c = r.json()["contact"]
        assert c["form_id"] == 1
        assert c["source"] == "general_enquiry"
        assert c.get("in_pipeline") is False
        assert c.get("pipeline_status") is None

    def test_form17_creates_pipeline_record_new_stage(self, admin_session, created_ids):
        cid = created_ids["form17"]
        r = admin_session.get(f"{BASE_URL}/api/contacts/{cid}")
        assert r.status_code == 200
        c = r.json()["contact"]
        assert c["form_id"] == 17
        assert c["source"] == "franchise_enquiry"
        assert c.get("in_pipeline") is True
        assert c.get("pipeline_status") == "new"

    def test_form32_creates_pipeline_record_new_stage(self, admin_session, created_ids):
        cid = created_ids["form32"]
        r = admin_session.get(f"{BASE_URL}/api/contacts/{cid}")
        assert r.status_code == 200
        c = r.json()["contact"]
        assert c["form_id"] == 32
        assert c["source"] == "licence_enquiry"
        assert c.get("in_pipeline") is True
        assert c.get("pipeline_status") == "new"


# ---------------------------------------------------------------------------
# GET /api/contacts filters
# ---------------------------------------------------------------------------
class TestContactsFilters:
    def test_in_pipeline_true_excludes_legacy(self, admin_session, created_ids):
        r = admin_session.get(f"{BASE_URL}/api/contacts?in_pipeline=true&limit=2000")
        items = r.json()["items"]
        # All must have in_pipeline=true and not be legacy general_enquiry
        ids = {x["id"] for x in items}
        assert created_ids["form17"] in ids
        assert created_ids["form32"] in ids
        assert created_ids["form1"] not in ids
        # No legacy items
        sources = {x.get("source") for x in items}
        assert "legacy_general_enquiry" not in sources

    def test_in_pipeline_false_excludes_franchise(self, admin_session, created_ids):
        r = admin_session.get(f"{BASE_URL}/api/contacts?in_pipeline=false&limit=2000")
        items = r.json()["items"]
        ids = {x["id"] for x in items}
        assert created_ids["form1"] in ids
        assert created_ids["form17"] not in ids
        assert created_ids["form32"] not in ids
        # No source=franchise_enquiry or licence_enquiry should appear
        for it in items:
            if it.get("source") in ("franchise_enquiry", "licence_enquiry"):
                # If found, must be in_pipeline=false (e.g. demoted) — still OK
                assert it.get("in_pipeline") is not True

    def test_no_filter_returns_both_collections(self, admin_session):
        r = admin_session.get(f"{BASE_URL}/api/contacts?limit=2000")
        items = r.json()["items"]
        sources = {x.get("source") for x in items}
        # Must contain both legacy + web_form types
        assert "legacy_general_enquiry" in sources
        assert "franchise_enquiry" in sources or "licence_enquiry" in sources

    def test_source_general_enquiry_returns_form1(self, admin_session, created_ids):
        r = admin_session.get(f"{BASE_URL}/api/contacts?source=general_enquiry&limit=500")
        items = r.json()["items"]
        ids = {x["id"] for x in items}
        assert created_ids["form1"] in ids
        for it in items:
            assert it.get("source") == "general_enquiry"

    def test_source_licence_enquiry_only_licence(self, admin_session, created_ids):
        r = admin_session.get(f"{BASE_URL}/api/contacts?source=licence_enquiry&limit=2000")
        items = r.json()["items"]
        ids = {x["id"] for x in items}
        assert created_ids["form32"] in ids
        for it in items:
            assert it.get("source") == "licence_enquiry"


# ---------------------------------------------------------------------------
# PATCH /promote
# ---------------------------------------------------------------------------
class TestPromote:
    def test_promote_general_web_contact_sets_in_pipeline_true(self, admin_session, created_ids):
        cid = created_ids["form1"]
        r = admin_session.patch(f"{BASE_URL}/api/contacts/{cid}/promote")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["ok"] is True
        assert body["in_pipeline"] is True
        assert body["pipeline_status"] == "new"
        # Verify persistence
        g = admin_session.get(f"{BASE_URL}/api/contacts/{cid}")
        c = g.json()["contact"]
        assert c["in_pipeline"] is True
        assert c["pipeline_status"] == "new"
        # Cleanup: demote so subsequent tests see form1 as non-pipeline
        admin_session.patch(f"{BASE_URL}/api/contacts/{cid}/demote")

    def test_promote_legacy_moves_to_web_form_contacts(self, admin_session):
        # Find a legacy contact (source=legacy_general_enquiry)
        r = admin_session.get(f"{BASE_URL}/api/contacts?source=legacy_general_enquiry&limit=1")
        items = r.json()["items"]
        if not items:
            pytest.skip("No legacy contact available")
        legacy = items[0]
        legacy_id = legacy["id"]
        # Promote it
        p = admin_session.patch(f"{BASE_URL}/api/contacts/{legacy_id}/promote")
        assert p.status_code == 200, p.text
        # Verify still gettable
        g = admin_session.get(f"{BASE_URL}/api/contacts/{legacy_id}")
        assert g.status_code == 200
        data = g.json()
        c = data["contact"]
        assert c["in_pipeline"] is True
        assert c["pipeline_status"] == "new"
        assert c.get("promoted_from_legacy") is True
        # Source collection now web_form_contacts
        assert data.get("_source_collection") == "web_form_contacts"
        # Cleanup: delete the migrated copy so legacy total isn't permanently
        # off-by-one across regression runs. Note: this still loses the
        # original legacy record (moved + deleted), so a /api/migration/run
        # is needed to fully restore counts. Documented in test report.
        admin_session.delete(f"{BASE_URL}/api/contacts/{legacy_id}")

    def test_promote_nonexistent_returns_404(self, admin_session):
        r = admin_session.patch(f"{BASE_URL}/api/contacts/does-not-exist-xyz/promote")
        assert r.status_code == 404


# ---------------------------------------------------------------------------
# PATCH /demote
# ---------------------------------------------------------------------------
class TestDemote:
    def test_demote_pipeline_record(self, admin_session, created_ids):
        cid = created_ids["form17"]
        r = admin_session.patch(f"{BASE_URL}/api/contacts/{cid}/demote")
        assert r.status_code == 200
        assert r.json()["in_pipeline"] is False
        g = admin_session.get(f"{BASE_URL}/api/contacts/{cid}")
        c = g.json()["contact"]
        assert c["in_pipeline"] is False
        assert c["pipeline_status"] is None
        # Re-promote so other tests still find it as a pipeline record
        admin_session.patch(f"{BASE_URL}/api/contacts/{cid}/promote")

    def test_demote_nonexistent_returns_404(self, admin_session):
        r = admin_session.patch(f"{BASE_URL}/api/contacts/does-not-exist-xyz/demote")
        assert r.status_code == 404


# ---------------------------------------------------------------------------
# PATCH /pipeline implicitly promotes
# ---------------------------------------------------------------------------
class TestPipelineUpdateImplicitPromote:
    def test_pipeline_update_sets_in_pipeline_true(self, admin_session):
        # Create a fresh form1 (non-pipeline) record
        cid, _ = _intake(1, "implicit", "implicit")
        try:
            r = admin_session.patch(
                f"{BASE_URL}/api/contacts/{cid}/pipeline",
                json={"pipeline_status": "contacted"},
            )
            assert r.status_code == 200
            g = admin_session.get(f"{BASE_URL}/api/contacts/{cid}")
            c = g.json()["contact"]
            assert c["pipeline_status"] == "contacted"
            assert c["in_pipeline"] is True, "PATCH /pipeline should imply in_pipeline=true"
        finally:
            admin_session.delete(f"{BASE_URL}/api/contacts/{cid}")


# ---------------------------------------------------------------------------
# DELETE /api/contacts/{id}
# ---------------------------------------------------------------------------
class TestDelete:
    def test_delete_web_form_contact(self, admin_session):
        cid, _ = _intake(1, "del-web", "delw")
        r = admin_session.delete(f"{BASE_URL}/api/contacts/{cid}")
        assert r.status_code == 200
        assert r.json().get("ok") is True
        g = admin_session.get(f"{BASE_URL}/api/contacts/{cid}")
        assert g.status_code == 404

    def test_delete_legacy_contact(self, admin_session):
        # Find a legacy contact (use one we don't care about)
        r = admin_session.get(f"{BASE_URL}/api/contacts?source=legacy_general_enquiry&limit=10")
        items = r.json()["items"]
        if not items:
            pytest.skip("No legacy contact available")
        # Use the last (oldest) to minimise disruption
        legacy_id = items[-1]["id"]
        d = admin_session.delete(f"{BASE_URL}/api/contacts/{legacy_id}")
        assert d.status_code == 200
        g = admin_session.get(f"{BASE_URL}/api/contacts/{legacy_id}")
        assert g.status_code == 404

    def test_delete_nonexistent_returns_404(self, admin_session):
        r = admin_session.delete(f"{BASE_URL}/api/contacts/does-not-exist-xyz-123")
        assert r.status_code == 404
