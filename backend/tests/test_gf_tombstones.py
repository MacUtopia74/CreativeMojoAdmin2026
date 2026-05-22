"""Regression test: deleting a contact that originated from Gravity Forms
must tombstone its ``gravity_entry_id`` so the hourly backfill and the live
webhook cannot re-create it.

Bug context: An admin deleted "Paul Caldeira-Dunkerley" twice from the kanban
NEW column, and the GF backfill kept re-inserting it on the next cycle because
nothing recorded the deletion intent.
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


def _login_session():
    s = requests.Session()
    r = s.post(
        f"{BASE_URL}/api/auth/login",
        json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
        timeout=15,
    )
    assert r.status_code == 200, r.text
    return s


def test_delete_gf_contact_creates_tombstone_and_blocks_intake():
    s = _login_session()
    mongo = MongoClient(MONGO_URL)
    db = mongo[DB_NAME]

    fake_entry_id = f"test-{uuid.uuid4().hex[:10]}"
    contact_id = str(uuid.uuid4())
    db.web_form_contacts.insert_one({
        "id": contact_id,
        "gravity_entry_id": fake_entry_id,
        "form_id": "17",
        "first_name": "Test",
        "last_name": "Tombstone",
        "email": "tombstone-test@example.com",
        "source": "franchise_enquiry",
        "in_pipeline": True,
        "pipeline_status": "new",
    })
    db.gf_deleted_entries.delete_one({"gravity_entry_id": fake_entry_id})

    try:
        # Delete the contact via API.
        r = s.delete(f"{BASE_URL}/api/contacts/{contact_id}", timeout=15)
        assert r.status_code == 200, r.text
        assert r.json().get("ok") is True

        # Contact must be gone.
        assert db.web_form_contacts.find_one({"id": contact_id}) is None

        # Tombstone must exist.
        tomb = db.gf_deleted_entries.find_one(
            {"gravity_entry_id": fake_entry_id}, {"_id": 0}
        )
        assert tomb is not None
        assert tomb["form_id"] == "17"
        assert tomb["deleted_by"] == ADMIN_EMAIL

        # Live webhook must refuse to recreate it.
        intake_token = os.environ.get("INTAKE_TOKEN", "cm_intake_8f4a3c8b9e2d7f1a5c8b9e2d7f1a5c8b")
        r2 = requests.post(
            f"{BASE_URL}/api/intake/gravity-forms",
            headers={"X-Intake-Token": intake_token},
            json={
                "form_id": 17,
                "form_title": "Franchise Enquiry Contact Form",
                "entry_id": fake_entry_id,
                "fields": {"First Name": "Test", "Last Name": "Tombstone"},
            },
            timeout=15,
        )
        assert r2.status_code == 200, r2.text
        body = r2.json()
        assert body.get("skipped") == "tombstoned", body

        # And no row was created.
        assert db.web_form_contacts.find_one({"gravity_entry_id": fake_entry_id}) is None
    finally:
        db.web_form_contacts.delete_many({"gravity_entry_id": fake_entry_id})
        db.gf_deleted_entries.delete_one({"gravity_entry_id": fake_entry_id})
        mongo.close()
