"""Backend API tests for Phase 1 WordPress Plugin Intake (Gravity Forms).

Tests:
- POST /api/intake/gravity-forms with valid/invalid tokens
- Form ID → source mapping (1=general, 17=franchise, 32=licence, unknown=form_X)
- Fuzzy field label mapping (case-insensitive)
- Persistence in web_form_contacts (source, pipeline_status=new, form_id)
- GET /api/intake/config (admin auth, contains form_mapping with 3 entries)
- GET /api/intake/recent (admin auth, descending order)
- GET /api/intake/download-plugin (admin auth, zip mime + Content-Disposition)
- 401 on missing admin auth for protected intake endpoints
"""
import os
import io
import uuid
import zipfile
import pytest
import requests
from pymongo import MongoClient

BASE_URL = os.environ["REACT_APP_BACKEND_URL"].rstrip("/")
ADMIN_EMAIL = "admin@creativemojo.co.uk"
ADMIN_PASSWORD = "CreativeMojo2026!"
INTAKE_TOKEN = "cm_intake_8f4a3c8b9e2d7f1a5c8b9e2d7f1a5c8b"
MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = os.environ.get("DB_NAME", "creative_mojo_admin")


@pytest.fixture(scope="module")
def admin_session():
    s = requests.Session()
    r = s.post(f"{BASE_URL}/api/auth/login",
               json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD})
    if r.status_code != 200:
        pytest.skip(f"Login failed: {r.status_code} {r.text}")
    return s


@pytest.fixture(scope="module")
def mongo_db():
    cli = MongoClient(MONGO_URL)
    yield cli[DB_NAME]
    # Cleanup TEST_ entries created during test run
    cli[DB_NAME].web_form_contacts.delete_many(
        {"gravity_entry_id": {"$regex": "^TEST-"}}
    )


def _payload(form_id: int, entry_id: str, fields: dict, form_title: str = "Test Form"):
    return {
        "form_id": form_id,
        "form_title": form_title,
        "entry_id": entry_id,
        "date": None,
        "fields": fields,
    }


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------
class TestIntakeAuth:
    def test_missing_token_returns_401(self):
        r = requests.post(f"{BASE_URL}/api/intake/gravity-forms",
                          json=_payload(17, "TEST-noauth-1",
                                        {"Email": "noauth@test.com"}))
        assert r.status_code == 401, r.text

    def test_wrong_token_returns_401(self):
        r = requests.post(f"{BASE_URL}/api/intake/gravity-forms",
                          headers={"X-Intake-Token": "wrong-token-xyz"},
                          json=_payload(17, "TEST-wrongtok-1",
                                        {"Email": "wrongtok@test.com"}))
        assert r.status_code == 401, r.text


# ---------------------------------------------------------------------------
# Form ID → source mapping + persistence
# ---------------------------------------------------------------------------
class TestIntakeFormMapping:
    def test_franchise_form_17(self, mongo_db):
        entry_id = f"TEST-{uuid.uuid4().hex[:8]}"
        payload = _payload(17, entry_id, {
            "First Name": "TestFirst17",
            "Last Name": "TestLast17",
            "Email": "test17@example.com",
            "Telephone Number": "0123456789",
            "Name of establishment": "TEST Franchise Co",
            "Postcode": "AB1 2CD",
        })
        r = requests.post(f"{BASE_URL}/api/intake/gravity-forms",
                          headers={"X-Intake-Token": INTAKE_TOKEN}, json=payload)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["ok"] is True
        assert body["source"] == "franchise_enquiry"
        assert "id" in body

        # Verify persistence with all fields mapped
        doc = mongo_db.web_form_contacts.find_one({"id": body["id"]})
        assert doc is not None
        assert doc["source"] == "franchise_enquiry"
        assert doc["form_id"] == 17
        assert doc["pipeline_status"] == "new"
        assert doc["gravity_entry_id"] == entry_id
        assert doc["first_name"] == "TestFirst17"
        assert doc["last_name"] == "TestLast17"
        assert doc["email"] == "test17@example.com"
        assert doc["telephone"] == "0123456789"
        assert doc["establishment_name"] == "TEST Franchise Co"
        assert doc["postcode"] == "AB1 2CD"

    def test_general_form_1(self, mongo_db):
        entry_id = f"TEST-{uuid.uuid4().hex[:8]}"
        r = requests.post(f"{BASE_URL}/api/intake/gravity-forms",
                          headers={"X-Intake-Token": INTAKE_TOKEN},
                          json=_payload(1, entry_id, {"email": "gen1@test.com"}))
        assert r.status_code == 200, r.text
        assert r.json()["source"] == "general_enquiry"

    def test_licence_form_32(self, mongo_db):
        entry_id = f"TEST-{uuid.uuid4().hex[:8]}"
        r = requests.post(f"{BASE_URL}/api/intake/gravity-forms",
                          headers={"X-Intake-Token": INTAKE_TOKEN},
                          json=_payload(32, entry_id, {"Email": "lic32@test.com"}))
        assert r.status_code == 200, r.text
        assert r.json()["source"] == "licence_enquiry"

    def test_unknown_form_99(self, mongo_db):
        entry_id = f"TEST-{uuid.uuid4().hex[:8]}"
        r = requests.post(f"{BASE_URL}/api/intake/gravity-forms",
                          headers={"X-Intake-Token": INTAKE_TOKEN},
                          json=_payload(99, entry_id, {"Email": "unk@test.com"}))
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["source"] == "form_99"
        # Still persisted
        doc = mongo_db.web_form_contacts.find_one({"id": body["id"]})
        assert doc is not None
        assert doc["form_id"] == 99


# ---------------------------------------------------------------------------
# Admin-only endpoints
# ---------------------------------------------------------------------------
class TestIntakeAdminEndpoints:
    def test_config_returns_endpoint_token_mapping(self, admin_session):
        r = admin_session.get(f"{BASE_URL}/api/intake/config")
        assert r.status_code == 200, r.text
        d = r.json()
        assert "endpoint_url" in d
        assert d["endpoint_url"].endswith("/api/intake/gravity-forms")
        assert d["intake_token"] == INTAKE_TOKEN
        mapping = d["form_mapping"]
        assert isinstance(mapping, list)
        assert len(mapping) == 3
        ids = {m["form_id"] for m in mapping}
        assert ids == {1, 17, 32}
        sources = {m["source_tag"] for m in mapping}
        assert sources == {"general_enquiry", "franchise_enquiry", "licence_enquiry"}

    def test_config_requires_admin(self):
        r = requests.get(f"{BASE_URL}/api/intake/config")
        assert r.status_code == 401

    def test_recent_descending_with_form_id(self, admin_session):
        r = admin_session.get(f"{BASE_URL}/api/intake/recent", params={"limit": 20})
        assert r.status_code == 200, r.text
        d = r.json()
        assert "items" in d
        assert "count" in d
        assert isinstance(d["items"], list)
        # Every item must have form_id (per endpoint filter)
        for it in d["items"]:
            assert "form_id" in it
            assert it["form_id"] is not None
            assert "_id" not in it
        # Descending by received_at
        ts = [it.get("received_at") for it in d["items"] if it.get("received_at")]
        assert ts == sorted(ts, reverse=True)

    def test_recent_requires_admin(self):
        r = requests.get(f"{BASE_URL}/api/intake/recent")
        assert r.status_code == 401

    def test_download_plugin_zip(self, admin_session):
        r = admin_session.get(f"{BASE_URL}/api/intake/download-plugin")
        assert r.status_code == 200, r.text
        assert r.headers.get("content-type", "").startswith("application/zip")
        assert "attachment" in r.headers.get("content-disposition", "").lower()
        assert "creative-mojo-intake.zip" in r.headers.get("content-disposition", "")
        # Valid zip with expected files
        zf = zipfile.ZipFile(io.BytesIO(r.content))
        names = zf.namelist()
        assert any(n.endswith("creative-mojo-intake.php") for n in names), names
        assert any(n.endswith("readme.txt") for n in names), names
        # Reasonable size (1KB-50KB)
        assert 500 < len(r.content) < 50000

    def test_download_plugin_requires_admin(self):
        r = requests.get(f"{BASE_URL}/api/intake/download-plugin")
        assert r.status_code == 401


# ---------------------------------------------------------------------------
# Case-insensitive field mapping
# ---------------------------------------------------------------------------
class TestFieldMapping:
    def test_case_insensitive_email(self, mongo_db):
        entry_id = f"TEST-{uuid.uuid4().hex[:8]}"
        r = requests.post(f"{BASE_URL}/api/intake/gravity-forms",
                          headers={"X-Intake-Token": INTAKE_TOKEN},
                          json=_payload(17, entry_id, {
                              "email": "lower@test.com",
                              "first name": "lower",
                          }))
        assert r.status_code == 200
        doc = mongo_db.web_form_contacts.find_one({"id": r.json()["id"]})
        assert doc["email"] == "lower@test.com"
        assert doc["first_name"] == "lower"
