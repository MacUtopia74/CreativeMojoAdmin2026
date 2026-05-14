"""Iter 9 backend: verify POST /api/contacts persists manually_added_by + created_at"""
import os
import pytest
import requests
from datetime import datetime

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")
ADMIN = {"email": "admin@creativemojo.co.uk", "password": "CreativeMojo2026!"}


@pytest.fixture(scope="module")
def auth_session():
    s = requests.Session()
    r = s.post(f"{BASE_URL}/api/auth/login", json=ADMIN, timeout=15)
    assert r.status_code == 200, f"login failed: {r.status_code} {r.text}"
    return s


def test_post_contacts_stores_manual_flag_and_created_at(auth_session):
    payload = {
        "target": "franchise",
        "first_name": "TEST_Iter9",
        "last_name": "ManualQA",
        "email": "TEST_iter9_manualqa@example.com",
    }
    r = auth_session.post(f"{BASE_URL}/api/contacts", json=payload, timeout=15)
    assert r.status_code in (200, 201), r.text
    contact = r.json().get("contact") or r.json()
    cid = contact.get("id")
    assert cid, f"no id returned: {contact}"

    try:
        # Check audit fields on create response
        assert contact.get("manually_added_by") == ADMIN["email"], contact
        assert contact.get("created_at"), "created_at missing"
        # parse ISO
        try:
            datetime.fromisoformat(str(contact["created_at"]).replace("Z", "+00:00"))
        except Exception as e:
            pytest.fail(f"created_at not iso: {contact['created_at']} ({e})")

        # GET via list and verify persistence
        g = auth_session.get(
            f"{BASE_URL}/api/contacts",
            params={"tab": "franchise", "search": "ManualQA", "limit": 50},
            timeout=15,
        )
        assert g.status_code == 200, g.text
        items = g.json().get("items", [])
        found = next((x for x in items if x.get("id") == cid), None)
        assert found, f"created contact not in GET response (got {len(items)} items)"
        assert found.get("manually_added_by") == ADMIN["email"]
        assert found.get("created_at")
    finally:
        d = auth_session.delete(f"{BASE_URL}/api/contacts/{cid}", timeout=15)
        assert d.status_code in (200, 204), f"cleanup failed: {d.status_code} {d.text}"


def test_imported_contact_has_no_manual_flag(auth_session):
    """Penny Davies (imported) must NOT have manually_added_by set."""
    r = auth_session.get(
        f"{BASE_URL}/api/contacts",
        params={"tab": "franchise", "search": "Penny Davies", "limit": 5},
        timeout=15,
    )
    assert r.status_code == 200, r.text
    items = r.json().get("items", [])
    assert items, "Penny Davies not found"
    penny = items[0]
    assert not penny.get("manually_added_by"), f"unexpected manually_added_by: {penny.get('manually_added_by')}"
