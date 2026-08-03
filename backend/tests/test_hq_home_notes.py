"""Regression: HQ notes attached to CQC entries per franchisee.

Locks the append-only API contract for ``hq_home_notes_routes.py``:

* Notes are keyed by ``(franchisee_id, source, home_id)``.
* Each POST **appends** a new entry — no overwrite semantics; the
  history is preserved as an audit trail.
* Empty note strings are rejected with 400 (no "silent delete of the
  last note" behaviour that could accidentally wipe the trail).
* Only admin routes are exposed for writes; the portal endpoint is
  read-only and scoped to the caller's franchisee_id.
* Admins can delete a specific entry by id for typo cleanup.
* Notes are decoupled from ``franchisee_clients`` — a basic-MyTerritory
  franchisee with no ``franchisee_clients`` docs can still receive HQ
  annotations against CQC entries.
* Each entry carries who added it (`updated_by`) and a human-readable
  ``updated_by_name`` for the portal display.
* Invalid ``source`` values are rejected with 400.
* Every entry in ``map[key]`` list is newest-first.
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
    return f"hq-notes-test-{uuid4().hex[:12]}"


def _list(admin, fid):
    r = admin.get(f"{BASE_URL}/api/admin/franchisees/{fid}/hq-home-notes",
                  timeout=15)
    r.raise_for_status()
    return r.json()


def _cleanup_franchisee(admin, fid):
    j = _list(admin, fid)
    for entry in (j.get("items") or []):
        admin.delete(
            f"{BASE_URL}/api/admin/franchisees/{fid}/hq-home-notes/entry/{entry['id']}",
            timeout=15,
        )


@pytest.fixture()
def cleanup(admin, franchisee_id):
    yield
    _cleanup_franchisee(admin, franchisee_id)


class TestHqHomeNotes:
    def test_list_empty_by_default(self, admin, franchisee_id, cleanup):
        j = _list(admin, franchisee_id)
        assert j == {"items": [], "map": {}}

    def test_post_appends_entry(self, admin, franchisee_id, cleanup):
        r = admin.post(
            f"{BASE_URL}/api/admin/franchisees/{franchisee_id}/hq-home-notes/cqc/1-987",
            json={"note": "Spoke to Kate"}, timeout=15,
        )
        assert r.status_code == 200, r.text
        entry = r.json()["entry"]
        assert entry["note"] == "Spoke to Kate"
        assert entry["updated_at"]
        assert entry["updated_by"]
        # The name field must always be populated (falls back to email
        # so the franchisee portal can label the note).
        assert entry["updated_by_name"]

        j = _list(admin, franchisee_id)
        assert "cqc:1-987" in j["map"]
        assert len(j["map"]["cqc:1-987"]) == 1
        assert j["map"]["cqc:1-987"][0]["note"] == "Spoke to Kate"

    def test_second_save_appends_not_overwrites(self, admin, franchisee_id, cleanup):
        """The critical audit-trail contract — a second save on the
        same (source, home_id) key MUST leave the first entry intact
        and add a new one at the top of the list."""
        admin.post(
            f"{BASE_URL}/api/admin/franchisees/{franchisee_id}/hq-home-notes/cqc/1-42",
            json={"note": "First"}, timeout=15,
        ).raise_for_status()
        admin.post(
            f"{BASE_URL}/api/admin/franchisees/{franchisee_id}/hq-home-notes/cqc/1-42",
            json={"note": "Second"}, timeout=15,
        ).raise_for_status()

        j = _list(admin, franchisee_id)
        entries = j["map"]["cqc:1-42"]
        assert len(entries) == 2, "second save must APPEND, not overwrite"
        # Newest first — "Second" was written second, so it must be
        # entries[0].
        assert entries[0]["note"] == "Second"
        assert entries[1]["note"] == "First"
        # Ids are distinct (audit trail).
        assert entries[0]["id"] != entries[1]["id"]

    def test_empty_note_rejected(self, admin, franchisee_id, cleanup):
        r = admin.post(
            f"{BASE_URL}/api/admin/franchisees/{franchisee_id}/hq-home-notes/cqc/1-11",
            json={"note": ""}, timeout=15,
        )
        assert r.status_code == 400
        r = admin.post(
            f"{BASE_URL}/api/admin/franchisees/{franchisee_id}/hq-home-notes/cqc/1-11",
            json={"note": "   "}, timeout=15,
        )
        assert r.status_code == 400
        # Nothing persisted.
        j = _list(admin, franchisee_id)
        assert "cqc:1-11" not in j["map"]

    def test_delete_removes_specific_entry_only(self, admin, franchisee_id, cleanup):
        admin.post(
            f"{BASE_URL}/api/admin/franchisees/{franchisee_id}/hq-home-notes/cqc/1-99",
            json={"note": "One"}, timeout=15,
        ).raise_for_status()
        r = admin.post(
            f"{BASE_URL}/api/admin/franchisees/{franchisee_id}/hq-home-notes/cqc/1-99",
            json={"note": "Two"}, timeout=15,
        )
        two_id = r.json()["entry"]["id"]
        # Delete only "Two".
        r = admin.delete(
            f"{BASE_URL}/api/admin/franchisees/{franchisee_id}/hq-home-notes/entry/{two_id}",
            timeout=15,
        )
        assert r.status_code == 200
        assert r.json()["deleted"] is True
        # "One" survives.
        j = _list(admin, franchisee_id)
        remaining = [e["note"] for e in j["map"]["cqc:1-99"]]
        assert remaining == ["One"], remaining

    def test_delete_missing_entry_404(self, admin, franchisee_id, cleanup):
        r = admin.delete(
            f"{BASE_URL}/api/admin/franchisees/{franchisee_id}/hq-home-notes/entry/nonexistent-id",
            timeout=15,
        )
        assert r.status_code == 404

    def test_invalid_source_rejected(self, admin, franchisee_id, cleanup):
        r = admin.post(
            f"{BASE_URL}/api/admin/franchisees/{franchisee_id}/hq-home-notes/purple/1-1",
            json={"note": "no"}, timeout=15,
        )
        assert r.status_code == 400
        assert "source" in r.text.lower()

    def test_notes_are_scoped_per_franchisee(self, admin):
        f1 = f"hq-notes-scope-A-{uuid4().hex[:6]}"
        f2 = f"hq-notes-scope-B-{uuid4().hex[:6]}"
        try:
            admin.post(
                f"{BASE_URL}/api/admin/franchisees/{f1}/hq-home-notes/cqc/1-x",
                json={"note": "A's note"}, timeout=15,
            ).raise_for_status()
            admin.post(
                f"{BASE_URL}/api/admin/franchisees/{f2}/hq-home-notes/cqc/1-x",
                json={"note": "B's note"}, timeout=15,
            ).raise_for_status()
            m1 = _list(admin, f1)["map"]
            m2 = _list(admin, f2)["map"]
            assert m1["cqc:1-x"][0]["note"] == "A's note"
            assert m2["cqc:1-x"][0]["note"] == "B's note"
            # No leakage across franchisees.
            assert "cqc:1-x" not in {k for k, v in m1.items() if any(e["note"] == "B's note" for e in v)}
        finally:
            _cleanup_franchisee(admin, f1)
            _cleanup_franchisee(admin, f2)

    def test_portal_endpoint_returns_own_franchisee_history(self, admin):
        """A franchisee sees the FULL history for their own franchisee_id
        via the portal endpoint (read-only)."""
        FRANCHISEE_ID = "febd57cf-600d-4b44-bebc-6a9177984832"
        try:
            for text in ("Portal Note One", "Portal Note Two"):
                admin.post(
                    f"{BASE_URL}/api/admin/franchisees/{FRANCHISEE_ID}/hq-home-notes/cqc/portal-history",
                    json={"note": text}, timeout=15,
                ).raise_for_status()

            fr = requests.Session()
            r = fr.post(f"{BASE_URL}/api/auth/login",
                        json={"email": "franchisee.tester@creativemojo.co.uk",
                              "password": "FranchiseeTest2026!"}, timeout=15)
            r.raise_for_status()
            tok = r.json().get("access_token") or r.json().get("token")
            fr.headers.update({"Authorization": f"Bearer {tok}"})
            r = fr.get(f"{BASE_URL}/api/portal/hq-home-notes", timeout=15)
            assert r.status_code == 200
            entries = r.json()["map"].get("cqc:portal-history") or []
            texts = [e["note"] for e in entries]
            assert "Portal Note One" in texts
            assert "Portal Note Two" in texts
            # Newest first.
            assert texts.index("Portal Note Two") < texts.index("Portal Note One")

            # Franchisee cannot POST (write) via any admin route.
            r = fr.post(
                f"{BASE_URL}/api/admin/franchisees/{FRANCHISEE_ID}/hq-home-notes/cqc/portal-history",
                json={"note": "hack"}, timeout=15,
            )
            assert r.status_code == 403
            # Nor delete.
            r = fr.delete(
                f"{BASE_URL}/api/admin/franchisees/{FRANCHISEE_ID}/hq-home-notes/entry/{entries[0]['id']}",
                timeout=15,
            )
            assert r.status_code == 403
        finally:
            _cleanup_franchisee(admin, FRANCHISEE_ID)
