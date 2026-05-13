"""Backend API tests for Creative Mojo Admin Phase 1.

Tests cover:
- Auth (login, logout, me, brute-force lockout, user creation)
- Dashboard stats
- Airtable inspector (tables, records, count)
- MongoDB invariants (email index, bcrypt $2b$ hash)
"""
import os
import time
import uuid
import pytest
import requests
from pymongo import MongoClient

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "https://licensee-vault.preview.emergentagent.com").rstrip("/")
ADMIN_EMAIL = "admin@creativemojo.co.uk"
ADMIN_PASSWORD = "CreativeMojo2026!"
MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = os.environ.get("DB_NAME", "creative_mojo_admin")

# Known Airtable table IDs from the request
TBL_FRANCHISEES = "tblr998vIDCugVJAG"
TBL_CONTRACTS = "tbl7bsJdGm2JLr0xg"


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------
@pytest.fixture(scope="session")
def api_client():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


@pytest.fixture(scope="session")
def admin_session(api_client):
    """Logged-in admin session with httpOnly cookies."""
    s = requests.Session()
    r = s.post(f"{BASE_URL}/api/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD})
    if r.status_code != 200:
        pytest.skip(f"Admin login failed: {r.status_code} {r.text}")
    assert "access_token" in s.cookies
    return s


@pytest.fixture(scope="session")
def mongo_db():
    cli = MongoClient(MONGO_URL)
    return cli[DB_NAME]


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------
def test_health(api_client):
    r = api_client.get(f"{BASE_URL}/api/health")
    assert r.status_code == 200
    assert r.json() == {"ok": True}


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------
class TestAuth:
    def test_login_success_sets_cookies(self):
        s = requests.Session()
        r = s.post(f"{BASE_URL}/api/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD})
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["email"] == ADMIN_EMAIL
        assert data["role"] == "admin"
        assert "id" in data
        assert "password_hash" not in data
        # httpOnly cookies set
        assert "access_token" in s.cookies
        assert "refresh_token" in s.cookies

    def test_login_wrong_password(self, api_client):
        r = api_client.post(f"{BASE_URL}/api/auth/login",
                            json={"email": ADMIN_EMAIL, "password": "wrong-password-xyz"})
        assert r.status_code == 401
        assert "Invalid email or password" in r.json().get("detail", "")

    def test_me_without_cookie_returns_401(self, api_client):
        r = requests.get(f"{BASE_URL}/api/auth/me")
        assert r.status_code == 401

    def test_me_with_cookie_returns_user(self, admin_session):
        r = admin_session.get(f"{BASE_URL}/api/auth/me")
        assert r.status_code == 200
        data = r.json()
        assert data["email"] == ADMIN_EMAIL
        assert data["role"] == "admin"

    def test_logout_clears_cookies(self):
        s = requests.Session()
        login = s.post(f"{BASE_URL}/api/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD})
        assert login.status_code == 200
        r = s.post(f"{BASE_URL}/api/auth/logout")
        assert r.status_code == 200
        assert r.json() == {"ok": True}
        # After logout, /me should 401
        me = s.get(f"{BASE_URL}/api/auth/me")
        assert me.status_code == 401

    def test_admin_can_create_user(self, admin_session, mongo_db):
        unique_email = f"test_user_{uuid.uuid4().hex[:8]}@test.com"
        r = admin_session.post(f"{BASE_URL}/api/auth/users", json={
            "email": unique_email,
            "password": "TestPass123!",
            "name": "TEST User",
            "role": "admin",
        })
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["email"] == unique_email
        assert body["role"] == "admin"
        assert "id" in body
        # Verify persisted
        doc = mongo_db.users.find_one({"email": unique_email})
        assert doc is not None
        assert doc["password_hash"].startswith("$2b$")
        # Cleanup
        mongo_db.users.delete_one({"email": unique_email})

    def test_create_user_requires_auth(self, api_client):
        r = api_client.post(f"{BASE_URL}/api/auth/users", json={
            "email": "TEST_unauth@test.com", "password": "x", "name": "x", "role": "admin"
        })
        assert r.status_code == 401


# ---------------------------------------------------------------------------
# MongoDB invariants
# ---------------------------------------------------------------------------
class TestMongoInvariants:
    def test_users_email_unique_index(self, mongo_db):
        indexes = mongo_db.users.index_information()
        email_indexes = [v for k, v in indexes.items() if any(x[0] == "email" for x in v.get("key", []))]
        assert any(idx.get("unique") for idx in email_indexes), "users.email unique index missing"

    def test_admin_bcrypt_hash(self, mongo_db):
        doc = mongo_db.users.find_one({"email": ADMIN_EMAIL})
        assert doc is not None, "Admin user not seeded"
        assert doc["password_hash"].startswith("$2b$"), f"Hash prefix invalid: {doc['password_hash'][:4]}"
        assert doc["role"] == "admin"


# ---------------------------------------------------------------------------
# Dashboard
# ---------------------------------------------------------------------------
class TestDashboard:
    def test_dashboard_stats(self, admin_session):
        r = admin_session.get(f"{BASE_URL}/api/dashboard/stats")
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["users"] >= 1
        assert data["franchisees_migrated"] == 0
        assert data["contracts_migrated"] == 0
        assert data["contacts_migrated"] == 0
        # Airtable summary should be populated
        at = data.get("airtable")
        assert at is not None, "Airtable summary missing"
        assert at["tables"] == 14, f"Expected 14 tables, got {at['tables']}"
        assert at["total_fields"] == 342, f"Expected 342 total fields, got {at['total_fields']}"

    def test_dashboard_requires_auth(self, api_client):
        r = api_client.get(f"{BASE_URL}/api/dashboard/stats")
        assert r.status_code == 401


# ---------------------------------------------------------------------------
# Airtable Inspector
# ---------------------------------------------------------------------------
class TestAirtable:
    def test_list_tables_returns_14(self, admin_session):
        r = admin_session.get(f"{BASE_URL}/api/airtable/tables")
        assert r.status_code == 200, r.text
        data = r.json()
        assert "tables" in data
        assert len(data["tables"]) == 14, f"Expected 14 tables, got {len(data['tables'])}"

        # Expected specific tables
        by_id = {t["id"]: t for t in data["tables"]}
        assert TBL_FRANCHISEES in by_id
        franchisees = by_id[TBL_FRANCHISEES]
        assert franchisees["field_count"] == 85, f"Franchisees expected 85 fields, got {franchisees['field_count']}"

        assert TBL_CONTRACTS in by_id
        contracts = by_id[TBL_CONTRACTS]
        assert contracts["field_count"] == 41, f"Contracts expected 41 fields, got {contracts['field_count']}"

        # Contacts table - find by name
        contacts = next((t for t in data["tables"] if t["name"].lower() == "contacts"), None)
        assert contacts is not None, "Contacts table not found"
        assert contacts["field_count"] == 35, f"Contacts expected 35 fields, got {contacts['field_count']}"

    def test_tables_requires_admin(self, api_client):
        r = api_client.get(f"{BASE_URL}/api/airtable/tables")
        assert r.status_code == 401

    def test_table_records_sample(self, admin_session):
        r = admin_session.get(f"{BASE_URL}/api/airtable/tables/{TBL_FRANCHISEES}/records?limit=10")
        assert r.status_code == 200, r.text
        data = r.json()
        assert "records" in data
        assert isinstance(data["records"], list)
        assert len(data["records"]) <= 10
        if data["records"]:
            rec = data["records"][0]
            assert "id" in rec
            assert "fields" in rec

    def test_table_count_contracts(self, admin_session):
        # This paginates entire table - allow longer timeout
        r = admin_session.get(f"{BASE_URL}/api/airtable/tables/{TBL_CONTRACTS}/count", timeout=90)
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["table_id"] == TBL_CONTRACTS
        assert data["count"] == 134, f"Expected 134 contracts, got {data['count']}"


# ---------------------------------------------------------------------------
# Brute-force lockout (RUN LAST - uses fake email to avoid locking real admin)
# ---------------------------------------------------------------------------
class TestBruteForceLockout:
    def test_lockout_after_5_failures(self, api_client):
        fake_email = f"TEST_brute_{uuid.uuid4().hex[:8]}@test.com"
        # First 5 attempts should return 401
        for i in range(5):
            r = api_client.post(f"{BASE_URL}/api/auth/login",
                                json={"email": fake_email, "password": "wrong"})
            assert r.status_code == 401, f"Attempt {i+1}: expected 401, got {r.status_code}"
        # 6th attempt should be locked out (429)
        r = api_client.post(f"{BASE_URL}/api/auth/login",
                            json={"email": fake_email, "password": "wrong"})
        assert r.status_code == 429, f"Expected 429 lockout, got {r.status_code}: {r.text}"
        assert "Too many failed attempts" in r.json().get("detail", "")
