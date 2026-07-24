"""Phase 1B Turn B — Occurrence CRUD + substitution ack + per-marker PNG.

E2E backend tests that hit the deployed backend via HTTP. Each test
uploads a synthetic marker PDF (so we don't disturb any real templates)
then exercises the Turn B routes.
"""
from __future__ import annotations

import io
import os
import time

import fitz
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")
ADMIN_EMAIL = "admin@creativemojo.co.uk"
ADMIN_PASSWORD = "CreativeMojo2026!"

if not BASE_URL:
    raise RuntimeError("REACT_APP_BACKEND_URL must be set")


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------
@pytest.fixture(scope="session")
def admin_client():
    s = requests.Session()
    r = s.post(
        f"{BASE_URL}/api/auth/login",
        json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
        timeout=15,
    )
    assert r.status_code == 200, f"Admin login failed: {r.status_code} {r.text[:200]}"
    tok = r.json().get("token") or r.json().get("access_token")
    if tok:
        s.headers.update({"Authorization": f"Bearer {tok}"})
    return s


def _make_marker_pdf() -> bytes:
    """Two-page PDF with a mixture of markers."""
    doc = fitz.open()
    p1 = doc.new_page(width=595, height=842)
    p1.insert_text((72, 120), "AGREEMENT DATED [[AGREEMENT_DATE]]", fontsize=11, fontname="helv")
    p1.insert_text((72, 180), "This agreement is between the Franchisor and", fontsize=11, fontname="helv")
    p1.insert_text((72, 210), "[[FRANCHISEE_LEGAL_NAME]] of address:", fontsize=11, fontname="helv")
    p2 = doc.new_page(width=595, height=842)
    p2.insert_text((72, 120), "Monthly fee is [[MONTHLY_FEE]] payable on the first of each month.", fontsize=11, fontname="helv")
    data = doc.tobytes()
    doc.close()
    return data


def _wait_job(client, job_id, timeout=30):
    deadline = time.time() + timeout
    while time.time() < deadline:
        r = client.get(f"{BASE_URL}/api/admin/contract-templates/upload-jobs/{job_id}", timeout=10)
        assert r.status_code == 200
        j = r.json()
        if j.get("status") in ("complete", "failed"):
            return j
        time.sleep(0.3)
    raise AssertionError("upload job timed out")


@pytest.fixture(scope="module")
def uploaded_template(admin_client):
    pdf_bytes = _make_marker_pdf()
    files = {"pdf": ("turnb-test.pdf", pdf_bytes, "application/pdf")}
    data = {"name": "turnb-e2e-template", "contract_type": "franchise_renewal"}
    r = admin_client.post(
        f"{BASE_URL}/api/admin/contract-templates/upload-marker-pdf",
        files=files, data=data, timeout=30,
    )
    assert r.status_code == 200, r.text
    job = _wait_job(admin_client, r.json()["job_id"])
    assert job["status"] == "complete", job
    tid = job["template_id"]
    yield tid
    # cleanup: archive so it doesn't clutter the list
    try:
        admin_client.post(f"{BASE_URL}/api/admin/contract-templates/{tid}/archive", timeout=10)
    except Exception:
        pass


# ---------------------------------------------------------------------------
# 1. Occurrence IDs & substitution groups exposed in marker-summary
# ---------------------------------------------------------------------------
class TestSummarySurfaceForTurnB:
    def test_summary_has_occurrence_ids(self, admin_client, uploaded_template):
        r = admin_client.get(
            f"{BASE_URL}/api/admin/contract-templates/{uploaded_template}/marker-summary",
            timeout=15,
        )
        assert r.status_code == 200
        data = r.json()
        assert len(data["markers"]) == 3
        for m in data["markers"]:
            assert m.get("occurrence_id"), "every occurrence must carry a UUID"
            # Turn A invariant still holds
            assert m.get("token_bbox") and m.get("render_bbox")

    def test_summary_has_substitution_groups(self, admin_client, uploaded_template):
        r = admin_client.get(
            f"{BASE_URL}/api/admin/contract-templates/{uploaded_template}/marker-summary",
            timeout=15,
        )
        data = r.json()
        assert "substitution_groups" in data
        assert isinstance(data["substitution_groups"], list)
        assert "all_substitutions_acknowledged" in data


# ---------------------------------------------------------------------------
# 2. Occurrence CRUD
# ---------------------------------------------------------------------------
class TestOccurrenceCRUD:
    def _oid_for(self, admin_client, tid, code):
        r = admin_client.get(f"{BASE_URL}/api/admin/contract-templates/{tid}/marker-summary")
        for m in r.json()["markers"]:
            if m["code"] == code:
                return m["occurrence_id"]
        raise AssertionError(f"no occurrence for {code}")

    def test_patch_render_bbox(self, admin_client, uploaded_template):
        oid = self._oid_for(admin_client, uploaded_template, "AGREEMENT_DATE")
        r = admin_client.patch(
            f"{BASE_URL}/api/admin/contract-templates/{uploaded_template}/markers/{oid}",
            json={"render_bbox": [50, 100, 300, 130]},
        )
        assert r.status_code == 200, r.text
        occ = r.json()["occurrence"]
        assert occ["render_bbox"] == [50, 100, 300, 130]
        # Legacy bbox mirror stays in sync
        assert occ["bbox"] == [50, 100, 300, 130]
        # token_bbox stays untouched (character-tight)
        assert occ["token_bbox"] != occ["render_bbox"]

    def test_patch_alignment_and_font_override(self, admin_client, uploaded_template):
        oid = self._oid_for(admin_client, uploaded_template, "AGREEMENT_DATE")
        r = admin_client.patch(
            f"{BASE_URL}/api/admin/contract-templates/{uploaded_template}/markers/{oid}",
            json={"alignment": "right", "font_size_override": 12.5, "min_font_size": 8},
        )
        assert r.status_code == 200
        occ = r.json()["occurrence"]
        assert occ["alignment"] == "right"
        assert occ["font_size_override"] == 12.5
        assert occ["min_font_size"] == 8

    def test_patch_rejects_invalid_alignment(self, admin_client, uploaded_template):
        oid = self._oid_for(admin_client, uploaded_template, "AGREEMENT_DATE")
        r = admin_client.patch(
            f"{BASE_URL}/api/admin/contract-templates/{uploaded_template}/markers/{oid}",
            json={"alignment": "diagonal"},
        )
        assert r.status_code == 400
        assert "alignment" in r.json()["detail"].lower()

    def test_patch_rejects_bad_bbox(self, admin_client, uploaded_template):
        oid = self._oid_for(admin_client, uploaded_template, "AGREEMENT_DATE")
        r = admin_client.patch(
            f"{BASE_URL}/api/admin/contract-templates/{uploaded_template}/markers/{oid}",
            json={"render_bbox": [100, 100, 90, 90]},  # x1<x0, y1<y0
        )
        assert r.status_code == 400

    def test_patch_ignores_unknown_fields(self, admin_client, uploaded_template):
        oid = self._oid_for(admin_client, uploaded_template, "AGREEMENT_DATE")
        r = admin_client.patch(
            f"{BASE_URL}/api/admin/contract-templates/{uploaded_template}/markers/{oid}",
            json={"code": "OWNED", "token_bbox": [0, 0, 1, 1]},  # not editable
        )
        # No editable fields → 400
        assert r.status_code == 400

    def test_patch_404_on_bad_occurrence(self, admin_client, uploaded_template):
        r = admin_client.patch(
            f"{BASE_URL}/api/admin/contract-templates/{uploaded_template}/markers/nonexistent-oid",
            json={"alignment": "left"},
        )
        assert r.status_code == 404

    def test_add_new_occurrence(self, admin_client, uploaded_template):
        r = admin_client.post(
            f"{BASE_URL}/api/admin/contract-templates/{uploaded_template}/markers",
            json={
                "code": "FRANCHISEE_ADDRESS_BLOCK",
                "page": 1,
                "render_bbox": [100, 300, 400, 380],
                "font_size": 11,
                "alignment": "left",
            },
        )
        assert r.status_code == 200, r.text
        occ = r.json()["occurrence"]
        assert occ["manually_added"] is True
        assert occ["code"] == "FRANCHISEE_ADDRESS_BLOCK"
        assert occ["occurrence_id"]

    def test_add_rejects_unknown_code(self, admin_client, uploaded_template):
        r = admin_client.post(
            f"{BASE_URL}/api/admin/contract-templates/{uploaded_template}/markers",
            json={
                "code": "MADE_UP_CODE",
                "page": 1,
                "render_bbox": [100, 300, 400, 380],
            },
        )
        assert r.status_code == 400

    def test_add_rejects_page_out_of_range(self, admin_client, uploaded_template):
        r = admin_client.post(
            f"{BASE_URL}/api/admin/contract-templates/{uploaded_template}/markers",
            json={
                "code": "FRANCHISEE_LEGAL_NAME",
                "page": 99,
                "render_bbox": [100, 300, 400, 380],
            },
        )
        assert r.status_code == 400

    def test_delete_occurrence(self, admin_client, uploaded_template):
        # First add a marker to delete
        r = admin_client.post(
            f"{BASE_URL}/api/admin/contract-templates/{uploaded_template}/markers",
            json={
                "code": "MONTHLY_FEE",
                "page": 2,
                "render_bbox": [100, 500, 300, 520],
            },
        )
        assert r.status_code == 200
        new_oid = r.json()["occurrence"]["occurrence_id"]
        # Delete it
        r = admin_client.delete(
            f"{BASE_URL}/api/admin/contract-templates/{uploaded_template}/markers/{new_oid}",
        )
        assert r.status_code == 200
        assert r.json()["removed"] == new_oid
        # Second delete = 404
        r = admin_client.delete(
            f"{BASE_URL}/api/admin/contract-templates/{uploaded_template}/markers/{new_oid}",
        )
        assert r.status_code == 404


# ---------------------------------------------------------------------------
# 3. Substitution acknowledgements
# ---------------------------------------------------------------------------
class TestSubstitutionAck:
    def test_ack_flow(self, admin_client, uploaded_template):
        # Fetch groups
        r = admin_client.get(
            f"{BASE_URL}/api/admin/contract-templates/{uploaded_template}/marker-summary",
        )
        groups = r.json()["substitution_groups"]
        assert groups, "must have at least one substitution group"
        family = groups[0]["font_family"]
        # Set ack=true
        r = admin_client.post(
            f"{BASE_URL}/api/admin/contract-templates/{uploaded_template}/substitution-acknowledgements",
            json={"font_family": family, "acknowledged": True},
        )
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["acknowledged"] is True
        assert data["font_family"] == family
        # Confirm it's persisted in the summary
        r = admin_client.get(
            f"{BASE_URL}/api/admin/contract-templates/{uploaded_template}/marker-summary",
        )
        for g in r.json()["substitution_groups"]:
            if g["font_family"] == family:
                assert g["acknowledged"] is True
                assert g["acknowledged_by"] == ADMIN_EMAIL
        # Toggle back off
        r = admin_client.post(
            f"{BASE_URL}/api/admin/contract-templates/{uploaded_template}/substitution-acknowledgements",
            json={"font_family": family, "acknowledged": False},
        )
        assert r.status_code == 200
        assert r.json()["acknowledged"] is False

    def test_ack_rejects_unknown_family(self, admin_client, uploaded_template):
        r = admin_client.post(
            f"{BASE_URL}/api/admin/contract-templates/{uploaded_template}/substitution-acknowledgements",
            json={"font_family": "Papyrus-Impossible", "acknowledged": True},
        )
        assert r.status_code == 400


# ---------------------------------------------------------------------------
# 4. Per-marker sample-preview PNG
# ---------------------------------------------------------------------------
class TestMarkerPng:
    def test_png_endpoint_returns_valid_image(self, admin_client, uploaded_template):
        r = admin_client.get(
            f"{BASE_URL}/api/admin/contract-templates/{uploaded_template}/marker-summary",
        )
        oid = next(m["occurrence_id"] for m in r.json()["markers"] if m["code"] == "AGREEMENT_DATE")
        r = admin_client.get(
            f"{BASE_URL}/api/admin/contract-templates/{uploaded_template}/markers/{oid}/sample-preview.png",
            params={"dpi": 150, "pad": 20},
        )
        assert r.status_code == 200, r.text
        assert r.headers["content-type"] == "image/png"
        # PNG magic bytes
        assert r.content.startswith(b"\x89PNG\r\n\x1a\n")
        # Headers surface the marker metadata for UI use
        assert r.headers.get("x-marker-code") == "AGREEMENT_DATE"
        assert r.headers.get("x-marker-page") == "1"

    def test_png_endpoint_404_for_bad_oid(self, admin_client, uploaded_template):
        r = admin_client.get(
            f"{BASE_URL}/api/admin/contract-templates/{uploaded_template}/markers/deadbeef/sample-preview.png",
        )
        assert r.status_code == 404

    def test_png_dpi_bounds(self, admin_client, uploaded_template):
        r = admin_client.get(
            f"{BASE_URL}/api/admin/contract-templates/{uploaded_template}/marker-summary",
        )
        oid = r.json()["markers"][0]["occurrence_id"]
        # dpi=50 below floor (72) → 422
        r = admin_client.get(
            f"{BASE_URL}/api/admin/contract-templates/{uploaded_template}/markers/{oid}/sample-preview.png",
            params={"dpi": 50},
        )
        assert r.status_code == 422


# ---------------------------------------------------------------------------
# 5. Auth
# ---------------------------------------------------------------------------
class TestTurnBAuth:
    def test_unauth_patch_denied(self, uploaded_template):
        anon = requests.Session()
        r = anon.patch(
            f"{BASE_URL}/api/admin/contract-templates/{uploaded_template}/markers/anything",
            json={"alignment": "left"},
        )
        assert r.status_code in (401, 403)

    def test_unauth_png_denied(self, uploaded_template):
        anon = requests.Session()
        r = anon.get(
            f"{BASE_URL}/api/admin/contract-templates/{uploaded_template}/markers/x/sample-preview.png",
        )
        assert r.status_code in (401, 403)
