"""Verify /api/portal/me tags normalization and portal_modules defaults.

Covers the helen.bell whitescreen fix where legacy Airtable franchisee
records stored ``tags`` as a comma-separated string. The endpoint must
always return a list.
"""
import os
import pytest
import requests
from pymongo import MongoClient

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")
if not BASE_URL:
    # Fallback: read from frontend/.env so tests still run if env not exported
    with open("/app/frontend/.env") as fh:
        for line in fh:
            if line.startswith("REACT_APP_BACKEND_URL="):
                BASE_URL = line.split("=", 1)[1].strip().rstrip("/")
                break

MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = os.environ.get("DB_NAME", "creative_mojo_admin")
FRANCHISEE_ID = "febd57cf-600d-4b44-bebc-6a9177984832"
FRANCHISEE_EMAIL = "franchisee.tester@creativemojo.co.uk"
FRANCHISEE_PASSWORD = "FranchiseeTest2026!"
ADMIN_EMAIL = "admin@creativemojo.co.uk"
ADMIN_PASSWORD = "CreativeMojo2026!"

STANDARD_MODULE_KEYS = {
    "map", "calendar", "files",
    "territory_plus", "marketing", "invoicing",
    "bookings", "shape_orders",
}


@pytest.fixture(scope="module")
def mongo():
    client = MongoClient(MONGO_URL)
    yield client[DB_NAME]
    client.close()


@pytest.fixture(scope="module")
def franchisee_session():
    s = requests.Session()
    r = s.post(
        f"{BASE_URL}/api/auth/login",
        json={"email": FRANCHISEE_EMAIL, "password": FRANCHISEE_PASSWORD},
        timeout=20,
    )
    assert r.status_code == 200, f"Franchisee login failed: {r.status_code} {r.text}"
    return s


@pytest.fixture(scope="module")
def admin_session():
    s = requests.Session()
    r = s.post(
        f"{BASE_URL}/api/auth/login",
        json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
        timeout=20,
    )
    assert r.status_code == 200, f"Admin login failed: {r.status_code} {r.text}"
    return s


@pytest.fixture
def restore_tags(mongo):
    """Snapshot original tags value, restore after test."""
    original = mongo.franchisees.find_one({"id": FRANCHISEE_ID}, {"tags": 1, "_id": 0})
    original_tags = original.get("tags") if original else None
    yield original_tags
    # Restore
    mongo.franchisees.update_one(
        {"id": FRANCHISEE_ID}, {"$set": {"tags": original_tags}}
    )


def _set_tags(mongo, value):
    if value is None:
        mongo.franchisees.update_one({"id": FRANCHISEE_ID}, {"$unset": {"tags": ""}})
    else:
        mongo.franchisees.update_one({"id": FRANCHISEE_ID}, {"$set": {"tags": value}})


# --- tests --------------------------------------------------------------

def test_portal_me_returns_tags_list_when_db_has_string(
    mongo, franchisee_session, restore_tags
):
    _set_tags(mongo, "demo, vip")
    r = franchisee_session.get(f"{BASE_URL}/api/portal/me", timeout=20)
    assert r.status_code == 200, r.text
    data = r.json()
    profile = data.get("profile") or data
    tags = profile.get("tags")
    assert isinstance(tags, list), f"tags should be list, got {type(tags).__name__}: {tags!r}"
    assert tags == ["demo", "vip"], f"Expected ['demo','vip'], got {tags!r}"


def test_portal_me_returns_tags_empty_list_when_db_null(
    mongo, franchisee_session, restore_tags
):
    _set_tags(mongo, None)
    r = franchisee_session.get(f"{BASE_URL}/api/portal/me", timeout=20)
    assert r.status_code == 200, r.text
    data = r.json()
    profile = data.get("profile") or data
    tags = profile.get("tags")
    assert tags == [], f"Expected [] for null tags, got {tags!r}"
    assert isinstance(tags, list)


def test_portal_me_returns_tags_unchanged_when_already_list(
    mongo, franchisee_session, restore_tags
):
    _set_tags(mongo, ["Franchisee", "demo"])
    r = franchisee_session.get(f"{BASE_URL}/api/portal/me", timeout=20)
    assert r.status_code == 200, r.text
    data = r.json()
    profile = data.get("profile") or data
    tags = profile.get("tags")
    assert isinstance(tags, list)
    assert tags == ["Franchisee", "demo"], f"Got {tags!r}"


def test_portal_me_returns_portal_modules_with_all_keys(
    franchisee_session, restore_tags
):
    r = franchisee_session.get(f"{BASE_URL}/api/portal/me", timeout=20)
    assert r.status_code == 200, r.text
    data = r.json()
    profile = data.get("profile") or data
    modules = profile.get("portal_modules")
    assert isinstance(modules, dict), f"portal_modules should be dict, got {type(modules).__name__}"
    missing = STANDARD_MODULE_KEYS - set(modules.keys())
    assert not missing, f"Missing module keys: {missing}"
    # All values must be booleans
    for k, v in modules.items():
        assert isinstance(v, bool), f"portal_modules[{k!r}] should be bool, got {type(v).__name__}"


def test_portal_me_handles_semicolon_separator(
    mongo, franchisee_session, restore_tags
):
    _set_tags(mongo, "demo;vip; staff ")
    r = franchisee_session.get(f"{BASE_URL}/api/portal/me", timeout=20)
    assert r.status_code == 200, r.text
    data = r.json()
    profile = data.get("profile") or data
    tags = profile.get("tags")
    assert tags == ["demo", "vip", "staff"], f"Got {tags!r}"


def test_portal_me_handles_non_string_non_list_tags(
    mongo, franchisee_session, restore_tags
):
    """Tags stored as a number or dict (rare/garbage) should fallback to []."""
    _set_tags(mongo, 12345)
    r = franchisee_session.get(f"{BASE_URL}/api/portal/me", timeout=20)
    assert r.status_code == 200, r.text
    data = r.json()
    profile = data.get("profile") or data
    assert profile.get("tags") == [], f"Got {profile.get('tags')!r}"


def test_admin_can_list_franchisees(admin_session):
    """Sanity: admin login + list endpoint still works."""
    r = admin_session.get(f"{BASE_URL}/api/franchisees", timeout=30)
    assert r.status_code == 200, r.text
    data = r.json()
    assert isinstance(data, list) or isinstance(data, dict)
