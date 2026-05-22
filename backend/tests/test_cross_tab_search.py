"""Regression test: search must be cross-tab so contacts living in non-default
tabs (General, Care Home, Art Kit) still surface when admins search from the
default Sales Pipeline tab. Bug context: Ali Imperiale
(aliimperiale@btinternet.com) was in the legacy ``contacts`` collection but
the default Pipeline-tab search couldn't see her.
"""
import os
import uuid

import requests
from pymongo import MongoClient

BASE_URL = os.environ["REACT_APP_BACKEND_URL"].rstrip("/")
ADMIN_EMAIL = os.environ.get("ADMIN_EMAIL", "admin@creativemojo.co.uk")
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "CreativeMojo2026!")
MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = os.environ.get("DB_NAME", "creative_mojo_admin")


def _login():
    s = requests.Session()
    r = s.post(
        f"{BASE_URL}/api/auth/login",
        json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
        timeout=15,
    )
    assert r.status_code == 200, r.text
    return s


def test_search_finds_legacy_contact_from_pipeline_tab():
    """Searching ``aliimperiale@btinternet.com`` from the Pipeline tab must
    return Ali Imperiale even though she's in the legacy ``contacts``
    collection with source ``legacy_general_enquiry``."""
    s = _login()
    r = s.get(
        f"{BASE_URL}/api/contacts",
        params={"tab": "pipeline", "search": "aliimperiale", "limit": 10},
        timeout=15,
    )
    assert r.status_code == 200, r.text
    items = r.json()["items"]
    assert len(items) >= 1, "Expected to find Ali Imperiale via global search"
    emails = [(it.get("email") or "").lower() for it in items]
    assert "aliimperiale@btinternet.com" in emails, emails


def test_search_finds_seeded_contact_from_any_tab():
    """Seed a temporary contact in the legacy collection, then prove the
    Pipeline-tab search finds it. Cleanup afterwards."""
    mongo = MongoClient(MONGO_URL)
    db = mongo[DB_NAME]
    fake_id = str(uuid.uuid4())
    unique_token = f"xtest{uuid.uuid4().hex[:8]}"
    db.contacts.insert_one({
        "id": fake_id,
        "first_name": "XSearchTest",
        "last_name": unique_token,
        "email": f"{unique_token}@example.com",
        "source": "legacy_general_enquiry",
    })
    try:
        s = _login()
        for tab in ("pipeline", "franchise", "care_home", "art_kit", "general"):
            r = s.get(
                f"{BASE_URL}/api/contacts",
                params={"tab": tab, "search": unique_token, "limit": 10},
                timeout=15,
            )
            assert r.status_code == 200
            items = r.json()["items"]
            ids = [it["id"] for it in items]
            assert fake_id in ids, f"tab={tab} did not return seeded contact ({ids})"
    finally:
        db.contacts.delete_one({"id": fake_id})
        mongo.close()


def test_pipeline_tab_without_search_still_restricts():
    """Defensive: without a search term, the Pipeline tab must still only
    return ``in_pipeline=True`` contacts (we didn't break the tab scope)."""
    s = _login()
    r = s.get(
        f"{BASE_URL}/api/contacts",
        params={"tab": "pipeline", "limit": 20},
        timeout=15,
    )
    assert r.status_code == 200
    items = r.json()["items"]
    assert items, "Pipeline tab returned no contacts"
    for it in items:
        assert it.get("in_pipeline") is True, it
