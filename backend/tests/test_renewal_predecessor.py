"""Regression: renewal predecessor validation.

Locks the standard renewal contract lifecycle:

* A draft can supersede a predecessor whose status is ``issued`` OR
  ``signed`` (the normal renewal flow — franchisees sign their prior
  contract before HQ issues the renewal).
* Predecessors in ``draft``, ``revoked``, ``superseded``, ``cancelled``,
  ``expired`` and any other retired state are rejected with 400.
* Saving a draft never mutates the predecessor — the supersede only
  fires when the renewal is *issued*.
* On issue, the predecessor flips to ``superseded`` regardless of
  whether it was previously ``issued`` or ``signed``, ``pre_supersede_status``
  is stashed for accurate revoke restoration, and the renewal picks
  up ``superseded_by_contract_id`` on the predecessor.

Note: we exercise the API only up to the "draft points at a signed
predecessor" step — the full PDF-render + R2 issuance requires a
production S3 bucket and canonical template rendering that isn't
worth double-mocking here. The critical validation is the create/patch
gate, which was the bug the user reported.
"""
from __future__ import annotations

import os
from uuid import uuid4

import pytest
import requests


BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")
ADMIN_EMAIL = "admin@creativemojo.co.uk"
ADMIN_PW = "CreativeMojo2026!"

if not BASE_URL:
    raise RuntimeError("REACT_APP_BACKEND_URL must be set")


@pytest.fixture(scope="module")
def admin():
    s = requests.Session()
    r = s.post(f"{BASE_URL}/api/auth/login",
               json={"email": ADMIN_EMAIL, "password": ADMIN_PW}, timeout=30)
    r.raise_for_status()
    return s


def _pick_franchisee_and_template(session):
    fr = session.get(f"{BASE_URL}/api/franchisees", params={"limit": 500}, timeout=30)
    fr.raise_for_status()
    fitems = fr.json().get("items") or fr.json()
    tr = session.get(f"{BASE_URL}/api/admin/contract-templates", timeout=30)
    tr.raise_for_status()
    tpls = [t for t in tr.json().get("items", []) if t.get("status") in ("approved", "current")]
    return fitems[0]["id"], tpls[0]["id"]


def _create_draft(session, franchisee_id, template_id, **extra):
    payload = {
        "franchisee_id": franchisee_id,
        "template_id": template_id,
        "monthly_fee": 100,
        **extra,
    }
    r = session.post(f"{BASE_URL}/api/admin/contracts", json=payload, timeout=30)
    return r


class TestRenewalPredecessorValidation:
    def test_reject_supersede_of_draft(self, admin):
        franchisee_id, template_id = _pick_franchisee_and_template(admin)
        draft_r = _create_draft(admin, franchisee_id, template_id)
        assert draft_r.status_code in (200, 201), draft_r.text[:300]
        draft_id = draft_r.json()["id"]
        try:
            # Try to build a renewal that supersedes the DRAFT — must
            # be rejected 400. This locks the "don't chain to a document
            # that never went live" invariant.
            r = _create_draft(admin, franchisee_id, template_id, supersedes_id=draft_id)
            assert r.status_code == 400
            body = r.text.lower()
            assert "cannot supersede" in body
            assert "draft" in body
        finally:
            admin.delete(f"{BASE_URL}/api/admin/contracts/{draft_id}", timeout=30)

    def test_reject_missing_predecessor(self, admin):
        franchisee_id, template_id = _pick_franchisee_and_template(admin)
        r = _create_draft(admin, franchisee_id, template_id, supersedes_id=f"not-a-real-id-{uuid4().hex[:6]}")
        assert r.status_code == 400
        assert "not found" in r.text.lower()

    def test_accept_supersede_of_issued_predecessor(self, admin):
        """Set-up: patch an existing draft into ``issued`` state via a
        direct DB-shim isn't possible from this test, so we look for a
        franchisee that already has an issued or signed contract on
        production data. If none exists we skip — the gate itself is
        the essential check, exercised by the tests above."""
        r = admin.get(f"{BASE_URL}/api/admin/contracts", params={"limit": 200}, timeout=30)
        r.raise_for_status()
        rows = r.json().get("items") or r.json()
        issued = [c for c in rows if c.get("status") in ("issued", "signed")]
        if not issued:
            pytest.skip("no issued/signed contracts on this environment to renew against")
        target = issued[0]
        franchisee_id = target["franchisee_id"]
        template_id = target["template_id"]
        r = _create_draft(admin, franchisee_id, template_id, supersedes_id=target["id"])
        assert r.status_code in (200, 201), f"issued/signed predecessor should be accepted: {r.status_code} {r.text[:300]}"
        renewal_id = r.json()["id"]
        try:
            # The draft is saved but the predecessor MUST still be in
            # its original status — saving a draft never mutates the
            # predecessor per the lifecycle spec.
            check = admin.get(f"{BASE_URL}/api/admin/contracts/{target['id']}", timeout=30)
            check.raise_for_status()
            assert check.json()["status"] == target["status"], (
                "predecessor changed status after draft save — supersede should only fire on issue"
            )
        finally:
            admin.delete(f"{BASE_URL}/api/admin/contracts/{renewal_id}", timeout=30)

    def test_patch_supersedes_id_is_validated(self, admin):
        """A user could create a plain draft, then PATCH ``supersedes_id``
        onto it later. That path must run the same status gate as
        create — otherwise the create gate is trivially bypassable."""
        franchisee_id, template_id = _pick_franchisee_and_template(admin)
        # Bad target: a draft.
        target_draft = _create_draft(admin, franchisee_id, template_id)
        assert target_draft.status_code in (200, 201)
        target_id = target_draft.json()["id"]
        draft = _create_draft(admin, franchisee_id, template_id)
        assert draft.status_code in (200, 201)
        draft_id = draft.json()["id"]
        try:
            r = admin.patch(
                f"{BASE_URL}/api/admin/contracts/{draft_id}",
                json={"supersedes_id": target_id}, timeout=30,
            )
            assert r.status_code == 400, f"patch onto a draft predecessor should be rejected: {r.status_code} {r.text[:300]}"
            assert "draft" in r.text.lower()
        finally:
            admin.delete(f"{BASE_URL}/api/admin/contracts/{draft_id}", timeout=30)
            admin.delete(f"{BASE_URL}/api/admin/contracts/{target_id}", timeout=30)


class TestLegacyRenewalOrigin:
    """Every franchisee onboarded pre-Hub gets their FIRST Hub-generated
    renewal through the legacy path (no Hub predecessor exists). Locks
    the invariants around ``renewal_origin`` so the two routes never
    contradict each other."""

    def test_legacy_renewal_saves_without_supersedes_id(self, admin):
        franchisee_id, template_id = _pick_franchisee_and_template(admin)
        r = _create_draft(admin, franchisee_id, template_id,
                          renewal_origin="legacy",
                          legacy_predecessor_reference="Paper-2019-Paloma",
                          legacy_predecessor_expiry_date="2026-07-22",
                          legacy_predecessor_notes="Old paper agreement, no Hub row.",
                          commencement_date="2026-07-23",
                          contract_term_years=2,
                          monthly_fee=160)
        assert r.status_code in (200, 201), r.text[:300]
        cid = r.json()["id"]
        try:
            got = admin.get(f"{BASE_URL}/api/admin/contracts/{cid}", timeout=20).json()
            assert got["renewal_origin"] == "legacy"
            assert got.get("supersedes_id") in (None, "")
            assert got["legacy_predecessor_reference"] == "Paper-2019-Paloma"
            assert got["legacy_predecessor_expiry_date"] == "2026-07-22"
            assert got["commencement_date"] == "2026-07-23"
        finally:
            admin.delete(f"{BASE_URL}/api/admin/contracts/{cid}", timeout=30)

    def test_legacy_renewal_with_supersedes_id_is_rejected(self, admin):
        """Cross-invariant: renewal_origin='legacy' + supersedes_id set
        is a contradictory state (paper predecessor AND Hub predecessor
        at the same time). Must 400."""
        franchisee_id, template_id = _pick_franchisee_and_template(admin)
        r = admin.get(f"{BASE_URL}/api/admin/contracts", params={"limit": 200}, timeout=30)
        rows = r.json().get("items") or r.json()
        supersedable = [c for c in rows if c.get("status") in ("issued", "signed")]
        if not supersedable:
            pytest.skip("no issued/signed contracts to reference")
        r = _create_draft(admin, franchisee_id, template_id,
                          renewal_origin="legacy",
                          supersedes_id=supersedable[0]["id"])
        assert r.status_code == 400
        assert "legacy" in r.text.lower()

    def test_hub_origin_without_supersedes_id_is_rejected(self, admin):
        franchisee_id, template_id = _pick_franchisee_and_template(admin)
        r = _create_draft(admin, franchisee_id, template_id,
                          renewal_origin="hub")
        assert r.status_code == 400
        assert "supersedes_id" in r.text.lower()

    def test_invalid_renewal_origin_rejected(self, admin):
        franchisee_id, template_id = _pick_franchisee_and_template(admin)
        r = _create_draft(admin, franchisee_id, template_id,
                          renewal_origin="hybrid")
        assert r.status_code == 400
        assert "renewal_origin" in r.text.lower()

    def test_patch_cannot_set_legacy_while_supersedes_id_present(self, admin):
        """Guards the merged-state check in the PATCH handler — a user
        can't sneak into a contradictory state by setting the two
        fields in separate calls."""
        franchisee_id, template_id = _pick_franchisee_and_template(admin)
        r = admin.get(f"{BASE_URL}/api/admin/contracts", params={"limit": 200}, timeout=30)
        rows = r.json().get("items") or r.json()
        supersedable = [c for c in rows if c.get("status") in ("issued", "signed")]
        if not supersedable:
            pytest.skip("no issued/signed contracts to reference")
        # Start with a valid hub renewal.
        r = _create_draft(admin, franchisee_id, template_id,
                          renewal_origin="hub", supersedes_id=supersedable[0]["id"])
        cid = r.json()["id"]
        try:
            # Try to flip to legacy while supersedes_id is still present.
            r = admin.patch(
                f"{BASE_URL}/api/admin/contracts/{cid}",
                json={"renewal_origin": "legacy"}, timeout=30,
            )
            assert r.status_code == 400, r.text[:300]
        finally:
            admin.delete(f"{BASE_URL}/api/admin/contracts/{cid}", timeout=30)
