"""Regression tests for the contact source re-categorisation work
(May 2026): new ``care_home_enquiry`` + ``art_kit_enquiry`` sources, the
``/api/contacts/counts`` totals endpoint, and the Form-1 reason mapping in
the live webhook.
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
INTAKE_TOKEN = os.environ.get("INTAKE_TOKEN", "cm_intake_8f4a3c8b9e2d7f1a5c8b9e2d7f1a5c8b")


def _session():
    s = requests.Session()
    r = s.post(
        f"{BASE_URL}/api/auth/login",
        json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
        timeout=15,
    )
    assert r.status_code == 200, r.text
    return s


def test_counts_endpoint_returns_all_six_categories():
    s = _session()
    r = s.get(f"{BASE_URL}/api/contacts/counts", timeout=15)
    assert r.status_code == 200, r.text
    body = r.json()
    for key in ("pipeline", "franchise", "licence", "care_home", "art_kit", "general"):
        assert key in body, f"missing key {key} in {body}"
        assert isinstance(body[key], int)
    # Sanity: care_home + art_kit are non-trivial after the migration.
    assert body["care_home"] > 100, body
    assert body["art_kit"] > 50, body


def test_care_home_tab_returns_only_care_home_source():
    s = _session()
    r = s.get(f"{BASE_URL}/api/contacts?tab=care_home&limit=50", timeout=15)
    assert r.status_code == 200, r.text
    items = r.json()["items"]
    assert items, "care_home tab returned no items"
    for it in items:
        assert it["source"] == "care_home_enquiry", it


def test_art_kit_tab_returns_only_art_kit_source():
    s = _session()
    r = s.get(f"{BASE_URL}/api/contacts?tab=art_kit&limit=50", timeout=15)
    assert r.status_code == 200, r.text
    items = r.json()["items"]
    assert items, "art_kit tab returned no items"
    for it in items:
        assert it["source"] == "art_kit_enquiry", it


def test_form1_care_home_reason_routes_to_care_home_source():
    """Submitting Form 1 with reason="Care home class enquiry" must land in
    the care_home tab, NOT the franchise pipeline."""
    mongo = MongoClient(MONGO_URL)
    db = mongo[DB_NAME]
    fake_entry = f"test-care-{uuid.uuid4().hex[:8]}"
    payload = {
        "form_id": 1,
        "form_title": "Contact Form",
        "entry_id": fake_entry,
        "fields": {
            "First Name": "TestFirst",
            "Surname Name": "TestCareHome",
            "Email": f"{uuid.uuid4().hex[:8]}@example.com",
            "Reason for Contacting": "Care home class enquiry",
        },
    }
    try:
        r = requests.post(
            f"{BASE_URL}/api/intake/gravity-forms",
            headers={"X-Intake-Token": INTAKE_TOKEN},
            json=payload,
            timeout=15,
        )
        assert r.status_code == 200, r.text
        doc = db.web_form_contacts.find_one({"gravity_entry_id": fake_entry}, {"_id": 0})
        assert doc is not None
        assert doc["source"] == "care_home_enquiry", doc
        assert doc["in_pipeline"] is False, doc
    finally:
        db.web_form_contacts.delete_many({"gravity_entry_id": fake_entry})
        db.gf_deleted_entries.delete_one({"gravity_entry_id": fake_entry})
        mongo.close()


def test_form1_art_kit_reason_routes_to_art_kit_source():
    mongo = MongoClient(MONGO_URL)
    db = mongo[DB_NAME]
    fake_entry = f"test-art-{uuid.uuid4().hex[:8]}"
    payload = {
        "form_id": 1,
        "form_title": "Contact Form",
        "entry_id": fake_entry,
        "fields": {
            "First Name": "TestFirst",
            "Surname Name": "TestArtKit",
            "Email": f"{uuid.uuid4().hex[:8]}@example.com",
            "Reason for Contacting": "Deliverable Art Kit Enquiry",
        },
    }
    try:
        r = requests.post(
            f"{BASE_URL}/api/intake/gravity-forms",
            headers={"X-Intake-Token": INTAKE_TOKEN},
            json=payload,
            timeout=15,
        )
        assert r.status_code == 200, r.text
        doc = db.web_form_contacts.find_one({"gravity_entry_id": fake_entry}, {"_id": 0})
        assert doc is not None
        assert doc["source"] == "art_kit_enquiry", doc
        assert doc["in_pipeline"] is False, doc
    finally:
        db.web_form_contacts.delete_many({"gravity_entry_id": fake_entry})
        db.gf_deleted_entries.delete_one({"gravity_entry_id": fake_entry})
        mongo.close()
