"""Regression: HQ notes attached to CQC entries per franchisee.

Locks the API contract for `hq_home_notes_routes.py`:

* Notes are keyed by `(franchisee_id, source, home_id)`.
* Notes are decoupled from `franchisee_clients` — a basic-MyTerritory
  franchisee with no `franchisee_clients` docs can still receive HQ
  annotations against CQC entries.
* Empty note strings delete the row (avoids orphan blanks).
* Only admin routes are exposed for write; the portal endpoint is
  read-only.
* Invalid `source` values are rejected with 400.
"""
from __future__ import annotations

import os
from uuid import uuid4

import pytest
import requests


BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")
ADMIN_EMAIL = "admin@creativemojo.co.uk"
ADMIN_PASSWORD = "CreativeMojo2026!"

if not BASE_URL:
    raise RuntimeError("REACT_APP_BACKEND_URL must be set")


def _admin():
    s = requests.Session()
    r = s.post(f"{BASE_URL}/api/auth/login",
               json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD}, timeout=15)
    r.raise_for_status()
    tok = r.json().get("access_token") or r.json().get("token")
    s.headers.update({"Authorization": f"Bearer {tok}"})
    return s


@pytest.fixture(scope="module")
def admin():
    return _admin()


@pytest.fixture()
def franchisee_id():
    # Any valid uuid — the endpoint doesn't check franchisee existence
    # (notes are just annotations), so a fresh scope-limited id keeps
    # test rows isolated.
    return f"hq-notes-test-{uuid4().hex[:12]}"


@pytest.fixture()
def cleanup(admin, franchisee_id):
    yield
    # Best-effort teardown — delete any rows this test created.
    r = admin.get(f"{BASE_URL}/api/admin/franchisees/{franchisee_id}/hq-home-notes",
                  timeout=15)
    for row in (r.json().get("items") or []):
        admin.delete(
            f"{BASE_URL}/api/admin/franchisees/{franchisee_id}"
            f"/hq-home-notes/{row['source']}/{row['home_id']}",
            timeout=15,
        )


class TestHqHomeNotes:
    def test_list_empty_by_default(self, admin, franchisee_id, cleanup):
        r = admin.get(f"{BASE_URL}/api/admin/franchisees/{franchisee_id}/hq-home-notes",
                      timeout=15)
        assert r.status_code == 200
        assert r.json() == {"items": [], "map": {}}

    def test_put_creates_note(self, admin, franchisee_id, cleanup):
        r = admin.put(
            f"{BASE_URL}/api/admin/franchisees/{franchisee_id}/hq-home-notes/cqc/1-987",
            json={"note": "Spoke to Kate"}, timeout=15,
        )
        assert r.status_code == 200, r.text
        assert r.json()["created"] is True
        assert r.json()["note"] == "Spoke to Kate"

        r = admin.get(f"{BASE_URL}/api/admin/franchisees/{franchisee_id}/hq-home-notes",
                      timeout=15)
        assert r.status_code == 200
        m = r.json()["map"]
        assert "cqc:1-987" in m
        assert m["cqc:1-987"]["note"] == "Spoke to Kate"

    def test_put_updates_existing_note(self, admin, franchisee_id, cleanup):
        admin.put(
            f"{BASE_URL}/api/admin/franchisees/{franchisee_id}/hq-home-notes/cqc/1-42",
            json={"note": "First"}, timeout=15,
        )
        r = admin.put(
            f"{BASE_URL}/api/admin/franchisees/{franchisee_id}/hq-home-notes/cqc/1-42",
            json={"note": "Second"}, timeout=15,
        )
        assert r.status_code == 200
        assert r.json()["created"] is False
        assert r.json()["note"] == "Second"

    def test_empty_note_deletes_row(self, admin, franchisee_id, cleanup):
        admin.put(
            f"{BASE_URL}/api/admin/franchisees/{franchisee_id}/hq-home-notes/cqc/1-11",
            json={"note": "To delete"}, timeout=15,
        )
        r = admin.put(
            f"{BASE_URL}/api/admin/franchisees/{franchisee_id}/hq-home-notes/cqc/1-11",
            json={"note": ""}, timeout=15,
        )
        assert r.status_code == 200
        assert r.json().get("deleted") is True

        r = admin.get(f"{BASE_URL}/api/admin/franchisees/{franchisee_id}/hq-home-notes",
                      timeout=15)
        assert "cqc:1-11" not in r.json()["map"]

    def test_delete_removes_row(self, admin, franchisee_id, cleanup):
        admin.put(
            f"{BASE_URL}/api/admin/franchisees/{franchisee_id}/hq-home-notes/cqc/1-99",
            json={"note": "Bye"}, timeout=15,
        )
        r = admin.delete(
            f"{BASE_URL}/api/admin/franchisees/{franchisee_id}/hq-home-notes/cqc/1-99",
            timeout=15,
        )
        assert r.status_code == 200
        assert r.json()["deleted"] == 1

    def test_invalid_source_rejected(self, admin, franchisee_id, cleanup):
        r = admin.put(
            f"{BASE_URL}/api/admin/franchisees/{franchisee_id}/hq-home-notes/purple/1-1",
            json={"note": "no"}, timeout=15,
        )
        assert r.status_code == 400
        assert "source" in r.text.lower()

    def test_notes_are_scoped_per_franchisee(self, admin, cleanup):
        f1 = f"hq-notes-scope-A-{uuid4().hex[:6]}"
        f2 = f"hq-notes-scope-B-{uuid4().hex[:6]}"
        admin.put(
            f"{BASE_URL}/api/admin/franchisees/{f1}/hq-home-notes/cqc/1-x",
            json={"note": "A's note"}, timeout=15,
        )
        admin.put(
            f"{BASE_URL}/api/admin/franchisees/{f2}/hq-home-notes/cqc/1-x",
            json={"note": "B's note"}, timeout=15,
        )
        m1 = admin.get(f"{BASE_URL}/api/admin/franchisees/{f1}/hq-home-notes", timeout=15).json()["map"]
        m2 = admin.get(f"{BASE_URL}/api/admin/franchisees/{f2}/hq-home-notes", timeout=15).json()["map"]
        assert m1["cqc:1-x"]["note"] == "A's note"
        assert m2["cqc:1-x"]["note"] == "B's note"
        # Cleanup
        admin.delete(f"{BASE_URL}/api/admin/franchisees/{f1}/hq-home-notes/cqc/1-x", timeout=15)
        admin.delete(f"{BASE_URL}/api/admin/franchisees/{f2}/hq-home-notes/cqc/1-x", timeout=15)

    def test_portal_endpoint_returns_notes_for_own_franchisee_only(self, admin, cleanup):
        # Use the existing franchisee.tester@ account.
        # First seed an HQ note for its franchisee_id.
        FRANCHISEE_ID = "febd57cf-600d-4b44-bebc-6a9177984832"
        admin.put(
            f"{BASE_URL}/api/admin/franchisees/{FRANCHISEE_ID}/hq-home-notes/cqc/portal-visible",
            json={"note": "Visible to franchisee"}, timeout=15,
        )
        # Log in as franchisee and hit /portal/hq-home-notes.
        fr = requests.Session()
        r = fr.post(f"{BASE_URL}/api/auth/login",
                    json={"email": "franchisee.tester@creativemojo.co.uk",
                          "password": "FranchiseeTest2026!"}, timeout=15)
        r.raise_for_status()
        tok = r.json().get("access_token") or r.json().get("token")
        fr.headers.update({"Authorization": f"Bearer {tok}"})
        r = fr.get(f"{BASE_URL}/api/portal/hq-home-notes", timeout=15)
        assert r.status_code == 200
        m = r.json()["map"]
        assert "cqc:portal-visible" in m
        assert m["cqc:portal-visible"]["note"] == "Visible to franchisee"
        # Franchisee cannot write via portal.
        r = fr.put(
            f"{BASE_URL}/api/admin/franchisees/{FRANCHISEE_ID}/hq-home-notes/cqc/portal-visible",
            json={"note": "hack"}, timeout=15,
        )
        assert r.status_code == 403
        # Cleanup
        admin.delete(
            f"{BASE_URL}/api/admin/franchisees/{FRANCHISEE_ID}/hq-home-notes/cqc/portal-visible",
            timeout=15,
        )
