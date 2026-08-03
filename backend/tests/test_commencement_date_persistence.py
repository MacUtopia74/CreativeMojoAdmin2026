"""Regression: commencement_date persists verbatim across draft
create → patch → reopen → issue, and today's date never quietly
replaces a manually-selected historical value.

Locks the guarantees the user asked for after the "system repeatedly
changes it back to today's date" report:

* POST /admin/contracts stores the exact commencement_date supplied.
* PATCH /admin/contracts/{id} lets HQ update commencement_date to a
  historical value without any today-date sanity clamp.
* GET returns the value byte-for-byte.
* Setting supersedes_id (renewal path) does NOT alter commencement_date.
* Empty / missing commencement_date is left untouched by the backend
  (no auto-default to today).
"""
from __future__ import annotations

import os
from uuid import uuid4

import pytest
import requests

BASE = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")
ADMIN_EMAIL = "admin@creativemojo.co.uk"
ADMIN_PW = "CreativeMojo2026!"


@pytest.fixture(scope="module")
def s():
    sess = requests.Session()
    r = sess.post(f"{BASE}/api/auth/login",
                  json={"email": ADMIN_EMAIL, "password": ADMIN_PW}, timeout=20)
    assert r.status_code == 200
    return sess


def _pick(session):
    r = session.get(f"{BASE}/api/franchisees", params={"limit": 500}, timeout=30)
    fitems = r.json().get("items") or r.json()
    r = session.get(f"{BASE}/api/admin/contract-templates", timeout=30)
    tpls = [t for t in r.json().get("items", []) if t.get("status") in ("approved", "current")]
    return fitems[0]["id"], tpls[0]["id"]


class TestCommencementDatePersistence:
    def test_historical_commencement_is_stored_verbatim(self, s):
        """The exact scenario the user reported: type 28/07/2026 into
        the renewal modal, save, reopen — the date must not have
        rolled forward to today."""
        franchisee_id, template_id = _pick(s)
        historical = "2026-07-28"
        r = s.post(f"{BASE}/api/admin/contracts", json={
            "franchisee_id": franchisee_id,
            "template_id": template_id,
            "commencement_date": historical,
            "term_start_date": historical,
            "contract_term_years": 5,
            "monthly_fee": 200,
        }, timeout=30)
        assert r.status_code in (200, 201), r.text[:300]
        contract_id = r.json()["id"]
        try:
            # Read back.
            r = s.get(f"{BASE}/api/admin/contracts/{contract_id}", timeout=20)
            assert r.status_code == 200
            got = r.json()
            assert got.get("commencement_date") == historical, (
                f"commencement_date silently rewritten: expected {historical!r} "
                f"got {got.get('commencement_date')!r}"
            )
            assert got.get("term_start_date") == historical
        finally:
            s.delete(f"{BASE}/api/admin/contracts/{contract_id}", timeout=30)

    def test_patch_does_not_default_to_today(self, s):
        """A PATCH with only ``monthly_fee`` must not touch
        commencement_date. This exercises the "editing another field
        must not reset the date" invariant."""
        franchisee_id, template_id = _pick(s)
        historical = "2026-07-28"
        r = s.post(f"{BASE}/api/admin/contracts", json={
            "franchisee_id": franchisee_id, "template_id": template_id,
            "commencement_date": historical, "monthly_fee": 100,
        }, timeout=30)
        contract_id = r.json()["id"]
        try:
            r = s.patch(f"{BASE}/api/admin/contracts/{contract_id}",
                        json={"monthly_fee": 275}, timeout=30)
            assert r.status_code == 200
            r = s.get(f"{BASE}/api/admin/contracts/{contract_id}", timeout=20)
            assert r.json().get("commencement_date") == historical
            assert r.json().get("monthly_fee") == 275
        finally:
            s.delete(f"{BASE}/api/admin/contracts/{contract_id}", timeout=30)

    def test_patch_can_move_commencement_to_historical(self, s):
        """HQ must be able to move the commencement backwards to a
        historical value (retrospective issuance for late renewals)."""
        franchisee_id, template_id = _pick(s)
        r = s.post(f"{BASE}/api/admin/contracts", json={
            "franchisee_id": franchisee_id, "template_id": template_id,
            "commencement_date": "2026-08-15",
        }, timeout=30)
        contract_id = r.json()["id"]
        try:
            r = s.patch(f"{BASE}/api/admin/contracts/{contract_id}",
                        json={"commencement_date": "2026-07-28"}, timeout=30)
            assert r.status_code == 200
            r = s.get(f"{BASE}/api/admin/contracts/{contract_id}", timeout=20)
            assert r.json().get("commencement_date") == "2026-07-28"
        finally:
            s.delete(f"{BASE}/api/admin/contracts/{contract_id}", timeout=30)

    def test_setting_supersedes_id_does_not_touch_commencement(self, s):
        """Attaching a renewal predecessor via PATCH must not mutate
        commencement_date."""
        franchisee_id, template_id = _pick(s)
        # Find an issued/signed contract to point at.
        r = s.get(f"{BASE}/api/admin/contracts", params={"limit": 200}, timeout=30)
        rows = r.json().get("items") or r.json()
        candidates = [c for c in rows if c.get("status") in ("issued", "signed")]
        if not candidates:
            pytest.skip("no issued/signed contracts available")
        target = candidates[0]
        r = s.post(f"{BASE}/api/admin/contracts", json={
            "franchisee_id": target["franchisee_id"],
            "template_id": template_id,
            "commencement_date": "2026-07-28",
        }, timeout=30)
        contract_id = r.json()["id"]
        try:
            r = s.patch(f"{BASE}/api/admin/contracts/{contract_id}",
                        json={"supersedes_id": target["id"]}, timeout=30)
            assert r.status_code == 200
            r = s.get(f"{BASE}/api/admin/contracts/{contract_id}", timeout=20)
            assert r.json().get("commencement_date") == "2026-07-28"
            assert r.json().get("supersedes_id") == target["id"]
        finally:
            s.delete(f"{BASE}/api/admin/contracts/{contract_id}", timeout=30)

    def test_missing_commencement_not_auto_defaulted(self, s):
        """A draft that never gets a commencement_date must not have
        one filled in automatically. Backend leaves the field ``None``
        so issuance can raise a clear "missing value" error rather than
        silently issuing with today's date."""
        franchisee_id, template_id = _pick(s)
        r = s.post(f"{BASE}/api/admin/contracts", json={
            "franchisee_id": franchisee_id, "template_id": template_id,
        }, timeout=30)
        contract_id = r.json()["id"]
        try:
            r = s.get(f"{BASE}/api/admin/contracts/{contract_id}", timeout=20)
            assert r.json().get("commencement_date") in (None, "")
        finally:
            s.delete(f"{BASE}/api/admin/contracts/{contract_id}", timeout=30)
