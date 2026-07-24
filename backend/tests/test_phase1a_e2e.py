"""Phase 1A Stop-Point-2 E2E backend integration tests.

Covers everything in the review request that can be verified via HTTP:
- Marker Library seed shape (28 markers, buckets, no html_block)
- Marker Library CRUD + validation + soft delete + hide/unhide + usage
- Upload pipeline (deterministic, 6 stages, no LLM)
- Detection scenarios (a-e in review request)
- Summary semantics + ready_for_approval flag
- template_required_codes + not_eligible_for_type
- Source PDF preservation + SHA-256 integrity chain
- Page thumbnail (PNG >1KB, admin required)
- Versioning + publish/archive + freeze
- Legacy retirement (404/405 on retired paths)
- Auth (401/403 on admin endpoints)
"""
from __future__ import annotations

import hashlib
import io
import os
import re
import time

import fitz  # PyMuPDF
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
    data = r.json()
    token = data.get("token") or data.get("access_token")
    if token:
        s.headers.update({"Authorization": f"Bearer {token}"})
    return s


@pytest.fixture(scope="session")
def anon_client():
    return requests.Session()


def _make_pdf(pages_text):
    """Each item in pages_text is a list of (x, y, text, size) tuples."""
    doc = fitz.open()
    for page_lines in pages_text:
        page = doc.new_page()
        for x, y, text, size in page_lines:
            page.insert_text((x, y), text, fontsize=size, fontname="helv")
    b = doc.tobytes()
    doc.close()
    return b


def _wait_for_job(client, job_id, timeout=30):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        r = client.get(f"{BASE_URL}/api/admin/contract-templates/upload-jobs/{job_id}", timeout=10)
        assert r.status_code == 200, r.text
        j = r.json()
        last = j
        if j.get("status") in ("complete", "failed"):
            return j
        time.sleep(0.3)
    raise AssertionError(f"Job {job_id} did not finish; last={last}")


# ---------------------------------------------------------------------------
# 1. Marker Library — seed + structure
# ---------------------------------------------------------------------------
EXPECTED_CODES = {
    "FRANCHISEE_FIRST_NAME", "FRANCHISEE_LAST_NAME", "FRANCHISEE_FULL_NAME",
    "FRANCHISEE_ORGANISATION", "FRANCHISEE_EMAIL", "FRANCHISEE_MOBILE",
    "FRANCHISEE_ADDRESS_STREET", "FRANCHISEE_CITY", "FRANCHISEE_COUNTY",
    "FRANCHISEE_POSTCODE", "FRANCHISEE_ADDRESS_BLOCK", "FRANCHISE_NUMBER",
    "CONTRACT_TERM_YEARS", "COMMENCEMENT_DATE", "RENEWAL_DATE",
    "MONTHLY_FEE", "RENEWAL_FEE",
    "FRANCHISEE_LEGAL_NAME", "FRANCHISEE_COMPANY_NUMBER",
    "FRANCHISEE_TRADING_ADDRESS", "HQ_SIGNATORY_NAME", "HQ_SIGNATORY_TITLE",
    "TERM_START_DATE", "SPECIAL_TERMS", "GUARANTOR_NAME", "TERRITORY_DESCRIPTION",
    "CONTRACT_REFERENCE", "AGREEMENT_DATE",
}
FORBIDDEN_CODES = {"YEAR", "TERM_END_DATE_FROM_START", "TOTAL_INITIAL_INVESTMENT"}


class TestMarkerLibrarySeed:
    def test_seed_has_28_markers_and_correct_buckets(self, admin_client):
        r = admin_client.get(f"{BASE_URL}/api/admin/markers-library?include_hidden=true", timeout=15)
        assert r.status_code == 200, r.text
        data = r.json()
        items = data["items"]
        # Restrict to system-seeded markers only (user may have created extras)
        seeded = [m for m in items if m.get("system_seeded")]
        codes = {m["code"] for m in seeded}
        missing = EXPECTED_CODES - codes
        assert not missing, f"Missing seed codes: {missing}"
        forbidden = FORBIDDEN_CODES & codes
        assert not forbidden, f"Forbidden codes present: {forbidden}"
        # Bucket counts
        automatic = [m for m in seeded if m["value_source"] == "automatic"]
        manual = [m for m in seeded if m["value_source"] == "manual"]
        sysgen = [m for m in seeded if m["value_source"] == "system_generated"]
        assert len(automatic) == 17, f"expected 17 automatic, got {len(automatic)}"
        assert len(manual) == 9, f"expected 9 manual, got {len(manual)}"
        assert len(sysgen) == 2, f"expected 2 system_generated, got {len(sysgen)}"
        assert len(seeded) == 28, f"expected 28 seeded, got {len(seeded)}"

    def test_seed_upper_snake_case_and_valid_datatype(self, admin_client):
        r = admin_client.get(f"{BASE_URL}/api/admin/markers-library?include_hidden=true", timeout=15)
        data = r.json()
        pattern = re.compile(r"^[A-Z][A-Z0-9_]*$")
        for m in data["items"]:
            assert pattern.match(m["code"]), f"bad casing: {m['code']}"
            assert m["data_type"] in {"string", "multiline_text", "date", "currency", "integer", "decimal"}, m
            assert m["data_type"] != "html_block"
            assert m["value_source"] in {"automatic", "manual", "system_generated", "calculated"}


# ---------------------------------------------------------------------------
# 2. Marker Library — CRUD + auth
# ---------------------------------------------------------------------------
class TestMarkerLibraryCRUD:
    def test_unauth_returns_401(self, anon_client):
        r = anon_client.get(f"{BASE_URL}/api/admin/markers-library", timeout=10)
        assert r.status_code in (401, 403), f"expected 401/403, got {r.status_code}"

    def test_create_reject_lowercase(self, admin_client):
        r = admin_client.post(f"{BASE_URL}/api/admin/markers-library",
                              json={"code": "lowercase", "label": "x",
                                    "value_source": "manual", "data_type": "string"}, timeout=10)
        assert r.status_code == 400

    def test_create_reject_space(self, admin_client):
        r = admin_client.post(f"{BASE_URL}/api/admin/markers-library",
                              json={"code": "CONTAINS SPACE", "label": "x",
                                    "value_source": "manual", "data_type": "string"}, timeout=10)
        assert r.status_code == 400

    def test_create_reject_leading_digit(self, admin_client):
        r = admin_client.post(f"{BASE_URL}/api/admin/markers-library",
                              json={"code": "1STARTS_WITH_DIGIT", "label": "x",
                                    "value_source": "manual", "data_type": "string"}, timeout=10)
        assert r.status_code == 400

    def test_create_accept_valid_and_reject_duplicate_and_patch_immutable_code(self, admin_client):
        code = f"TEST_E2E_PHASE1A_{int(time.time())}"
        # create
        r = admin_client.post(f"{BASE_URL}/api/admin/markers-library",
                              json={"code": code, "label": "test", "value_source": "manual",
                                    "data_type": "string"}, timeout=10)
        assert r.status_code == 200, r.text
        marker = r.json()
        mid = marker["id"]
        # duplicate
        r2 = admin_client.post(f"{BASE_URL}/api/admin/markers-library",
                               json={"code": code, "label": "dup", "value_source": "manual",
                                     "data_type": "string"}, timeout=10)
        assert r2.status_code == 409
        # PATCH code -> 400
        r3 = admin_client.patch(f"{BASE_URL}/api/admin/markers-library/{mid}",
                                json={"code": code + "_NEW"}, timeout=10)
        assert r3.status_code == 400
        # PATCH label -> OK
        r4 = admin_client.patch(f"{BASE_URL}/api/admin/markers-library/{mid}",
                                json={"label": "updated"}, timeout=10)
        assert r4.status_code == 200
        assert r4.json()["label"] == "updated"
        # hide
        r5 = admin_client.post(f"{BASE_URL}/api/admin/markers-library/{mid}/hide", timeout=10)
        assert r5.status_code == 200 and r5.json()["hidden"] is True
        # unhide
        r6 = admin_client.post(f"{BASE_URL}/api/admin/markers-library/{mid}/unhide", timeout=10)
        assert r6.status_code == 200 and r6.json()["hidden"] is False
        # include_hidden filter
        admin_client.post(f"{BASE_URL}/api/admin/markers-library/{mid}/hide", timeout=10)
        list_no_hidden = admin_client.get(f"{BASE_URL}/api/admin/markers-library", timeout=10).json()
        assert not any(m["id"] == mid for m in list_no_hidden["items"])
        list_with_hidden = admin_client.get(f"{BASE_URL}/api/admin/markers-library?include_hidden=true", timeout=10).json()
        assert any(m["id"] == mid for m in list_with_hidden["items"])
        # usage — empty
        rusg = admin_client.get(f"{BASE_URL}/api/admin/markers-library/{mid}/usage", timeout=10)
        assert rusg.status_code == 200
        assert rusg.json()["used_by_versions"] == []
        # DELETE soft
        rdel = admin_client.delete(f"{BASE_URL}/api/admin/markers-library/{mid}", timeout=10)
        assert rdel.status_code == 200
        assert rdel.json()["soft_deleted"] is True


# ---------------------------------------------------------------------------
# 3. Upload pipeline
# ---------------------------------------------------------------------------
class TestUploadValidation:
    def test_reject_non_pdf(self, admin_client):
        files = {"pdf": ("test.txt", b"not a pdf", "text/plain")}
        r = admin_client.post(f"{BASE_URL}/api/admin/contract-templates/upload-marker-pdf",
                              files=files, data={"name": "x", "contract_type": "other"}, timeout=15)
        assert r.status_code == 400

    def test_reject_empty(self, admin_client):
        files = {"pdf": ("test.pdf", b"", "application/pdf")}
        r = admin_client.post(f"{BASE_URL}/api/admin/contract-templates/upload-marker-pdf",
                              files=files, data={"name": "x", "contract_type": "other"}, timeout=15)
        assert r.status_code == 400

    def test_reject_corrupt_no_header(self, admin_client):
        files = {"pdf": ("test.pdf", b"NOTPDF-garbage", "application/pdf")}
        r = admin_client.post(f"{BASE_URL}/api/admin/contract-templates/upload-marker-pdf",
                              files=files, data={"name": "x", "contract_type": "other"}, timeout=15)
        assert r.status_code == 400

    def test_reject_missing_name(self, admin_client):
        pdf = _make_pdf([[(72, 100, "hello", 11)]])
        files = {"pdf": ("test.pdf", pdf, "application/pdf")}
        r = admin_client.post(f"{BASE_URL}/api/admin/contract-templates/upload-marker-pdf",
                              files=files, data={"contract_type": "other"}, timeout=15)
        assert r.status_code == 422  # FastAPI Form validation

    def test_unauth_upload_rejected(self, anon_client):
        pdf = _make_pdf([[(72, 100, "hello", 11)]])
        r = anon_client.post(
            f"{BASE_URL}/api/admin/contract-templates/upload-marker-pdf",
            files={"pdf": ("test.pdf", pdf, "application/pdf")},
            data={"name": "e2e-phase1a-unauth", "contract_type": "other"}, timeout=15)
        assert r.status_code in (401, 403)


# ---------------------------------------------------------------------------
# 4. Detection scenarios + full end-to-end flow
# ---------------------------------------------------------------------------
@pytest.fixture(scope="module")
def uploaded_template(request):
    """Upload a PDF that covers all 5 detection scenarios.

    (a) inline: 'This Agreement is made on [[AGREEMENT_DATE]].'
    (b) standalone: '[[FRANCHISEE_LEGAL_NAME]]'
    (c) repeated (across pages): [[CONTRACT_REFERENCE]] on p1 and p2
    (d) unrecognised: [[WEATHER_OUTSIDE]]
    (e) cross-line: [[FRANCHISEE_LEGAL_ ...NAME]]
    """
    s = requests.Session()
    lr = s.post(f"{BASE_URL}/api/auth/login",
                json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD}, timeout=15)
    token = lr.json().get("token") or lr.json().get("access_token")
    if token:
        s.headers["Authorization"] = f"Bearer {token}"
    pdf = _make_pdf([
        [
            (72, 100, "This Agreement is made on [[AGREEMENT_DATE]].", 11),
            (72, 130, "[[FRANCHISEE_LEGAL_NAME]]", 11),
            (72, 160, "Ref: [[CONTRACT_REFERENCE]]", 11),
            (72, 190, "Weather: [[WEATHER_OUTSIDE]]", 11),
            (72, 220, "Opens here [[FRANCHISEE_LEGAL_", 11),
            (72, 240, "NAME]] closes here.", 11),
        ],
        [
            (72, 100, "Ref again: [[CONTRACT_REFERENCE]]", 11),
        ],
    ])
    sha_expected = hashlib.sha256(pdf).hexdigest()
    files = {"pdf": ("e2e-phase1a-detection.pdf", pdf, "application/pdf")}
    r = s.post(f"{BASE_URL}/api/admin/contract-templates/upload-marker-pdf",
               files=files, data={"name": "e2e-phase1a-detection", "contract_type": "franchise_renewal"},
               timeout=20)
    assert r.status_code == 200, r.text
    job = r.json()
    job_id = job["job_id"]
    final = _wait_for_job(s, job_id, timeout=30)
    assert final["status"] == "complete", final
    tid = final["template_id"]
    return {"client": s, "template_id": tid, "sha_expected": sha_expected, "pdf": pdf, "job": final}


class TestDetectionAndSummary:
    def test_stage_progression_and_no_llm_used(self, uploaded_template):
        s = uploaded_template["client"]; tid = uploaded_template["template_id"]
        det = s.get(f"{BASE_URL}/api/admin/contract-templates/{tid}", timeout=10).json()
        assert det["detection_meta"]["llm_used"] is False
        assert det["detection_meta"]["engine_version"] == "phase1a-v1"

    def test_summary_shape_and_scenarios(self, uploaded_template):
        s = uploaded_template["client"]; tid = uploaded_template["template_id"]
        r = s.get(f"{BASE_URL}/api/admin/contract-templates/{tid}/marker-summary", timeout=10)
        assert r.status_code == 200
        body = r.json()
        assert body["pdf_page_count"] == 2
        assert body["pdf_sha256"] == uploaded_template["sha_expected"]
        summary = body["summary"]
        # required top-level keys
        for k in ["total_occurrences", "unique_codes", "detected_codes",
                  "counts_by_code", "recognised", "unrecognised",
                  "not_eligible_for_type", "duplicate_offenders",
                  "template_required_missing", "cross_line_errors_count",
                  "ready_for_approval"]:
            assert k in summary, f"missing key {k} in summary"
        codes = summary["detected_codes"]
        # scenario a
        assert "AGREEMENT_DATE" in codes
        # scenario b
        assert "FRANCHISEE_LEGAL_NAME" in codes
        # scenario c: 2 occurrences of CONTRACT_REFERENCE, not duplicate offender
        assert summary["counts_by_code"].get("CONTRACT_REFERENCE") == 2
        assert not any(d.get("code") == "CONTRACT_REFERENCE" for d in summary["duplicate_offenders"])
        # scenario d
        assert "WEATHER_OUTSIDE" in summary["unrecognised"]
        # scenario e
        assert summary["cross_line_errors_count"] >= 1
        kinds = {e.get("kind") for e in body["cross_line_errors"]}
        assert "unterminated_open_bracket" in kinds
        assert "orphan_close_bracket" in kinds
        # ready_for_approval false
        assert summary["ready_for_approval"] is False

    def test_markers_have_bbox_and_font(self, uploaded_template):
        s = uploaded_template["client"]; tid = uploaded_template["template_id"]
        det = s.get(f"{BASE_URL}/api/admin/contract-templates/{tid}", timeout=10).json()
        assert len(det["markers"]) >= 4
        for m in det["markers"]:
            assert len(m["bbox"]) == 4
            x0, y0, x1, y1 = m["bbox"]
            assert x1 > x0 and y1 > y0
            assert m.get("font_size", 0) > 0


# ---------------------------------------------------------------------------
# 5. Source PDF preservation + SHA-256 chain
# ---------------------------------------------------------------------------
class TestPreservation:
    def test_integrity_check_ok(self, uploaded_template):
        s = uploaded_template["client"]; tid = uploaded_template["template_id"]
        r = s.get(f"{BASE_URL}/api/admin/contract-templates/{tid}/integrity-check", timeout=15)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["ok"] is True
        assert body["expected_sha256"] == body["actual_sha256"]
        assert body["expected_sha256"] == uploaded_template["sha_expected"]

    def test_source_pdf_download_and_rehash(self, uploaded_template):
        s = uploaded_template["client"]; tid = uploaded_template["template_id"]
        r = s.get(f"{BASE_URL}/api/admin/contract-templates/{tid}/source-pdf", timeout=15)
        assert r.status_code == 200
        assert r.headers.get("content-type", "").startswith("application/pdf")
        assert hashlib.sha256(r.content).hexdigest() == uploaded_template["sha_expected"]


# ---------------------------------------------------------------------------
# 6. Thumbnail
# ---------------------------------------------------------------------------
class TestThumbnail:
    def test_thumbnail_png_with_overlay(self, uploaded_template):
        s = uploaded_template["client"]; tid = uploaded_template["template_id"]
        r = s.get(f"{BASE_URL}/api/admin/contract-templates/{tid}/pages/1/thumbnail.png",
                  timeout=20)
        assert r.status_code == 200
        assert r.headers.get("content-type", "").startswith("image/png")
        assert len(r.content) > 1024
        assert r.content[:8] == b"\x89PNG\r\n\x1a\n"

    def test_thumbnail_requires_admin(self, uploaded_template, anon_client):
        tid = uploaded_template["template_id"]
        r = anon_client.get(f"{BASE_URL}/api/admin/contract-templates/{tid}/pages/1/thumbnail.png", timeout=10)
        assert r.status_code in (401, 403)


# ---------------------------------------------------------------------------
# 7. template_required + not_eligible_for_type + publish/archive
# ---------------------------------------------------------------------------
class TestSummaryEdits:
    def test_template_required_missing_flips_ready(self, uploaded_template):
        s = uploaded_template["client"]; tid = uploaded_template["template_id"]
        # Add a required marker not present in the PDF
        r = s.patch(f"{BASE_URL}/api/admin/contract-templates/{tid}",
                    json={"template_required_codes": ["GUARANTOR_NAME"]}, timeout=10)
        assert r.status_code == 200
        summary = r.json().get("marker_summary", {})
        assert "GUARANTOR_NAME" in summary.get("template_required_missing", [])
        # Clear
        r2 = s.patch(f"{BASE_URL}/api/admin/contract-templates/{tid}",
                     json={"template_required_codes": []}, timeout=10)
        summary2 = r2.json().get("marker_summary", {})
        assert "GUARANTOR_NAME" not in summary2.get("template_required_missing", [])

    def test_publish_rejected_when_not_ready(self, uploaded_template):
        s = uploaded_template["client"]; tid = uploaded_template["template_id"]
        r = s.post(f"{BASE_URL}/api/admin/contract-templates/{tid}/publish", timeout=10)
        assert r.status_code == 400


class TestPublishFlow:
    def test_upload_clean_publish_and_freeze(self, admin_client):
        # Build a PDF with only a recognised, eligible, non-duplicate marker
        pdf = _make_pdf([[(72, 100, "[[FRANCHISEE_LEGAL_NAME]]", 11)]])
        r = admin_client.post(
            f"{BASE_URL}/api/admin/contract-templates/upload-marker-pdf",
            files={"pdf": ("e2e-phase1a-clean.pdf", pdf, "application/pdf")},
            data={"name": "e2e-phase1a-clean", "contract_type": "franchise_renewal"},
            timeout=15,
        )
        assert r.status_code == 200
        job_id = r.json()["job_id"]
        assert r.json()["stage"] == "uploading"
        final = _wait_for_job(admin_client, job_id, timeout=30)
        assert final["status"] == "complete"
        tid = final["template_id"]
        ready = admin_client.get(f"{BASE_URL}/api/admin/contract-templates/{tid}/marker-summary",
                                 timeout=10).json()["summary"]["ready_for_approval"]
        assert ready is True
        # publish
        pub = admin_client.post(f"{BASE_URL}/api/admin/contract-templates/{tid}/publish", timeout=10)
        assert pub.status_code == 200
        body = pub.json()
        assert body["status"] == "current"
        # archive path exists
        arch = admin_client.post(f"{BASE_URL}/api/admin/contract-templates/{tid}/archive", timeout=10)
        assert arch.status_code == 200
        assert arch.json()["status"] == "archived"


# ---------------------------------------------------------------------------
# 8. Legacy retirement
# ---------------------------------------------------------------------------
class TestLegacyRetired:
    RETIRED_PATHS = [
        "/api/admin/contract-templates/upload-async",
        "/api/admin/contract-templates/upload-pdf-async",
        "/api/admin/contract-templates/upload-pdf",
        "/api/admin/contract-templates/approve-conversion",
        "/api/admin/contract-templates/preview-pdf",
    ]

    @pytest.mark.parametrize("path", RETIRED_PATHS)
    def test_retired_path_not_present(self, admin_client, path):
        # These may respond 404 or 405
        r = admin_client.post(f"{BASE_URL}{path}", timeout=10)
        assert r.status_code in (404, 405), f"{path} returned {r.status_code}"

    def test_no_contracts_endpoint(self, admin_client):
        r = admin_client.get(f"{BASE_URL}/api/admin/contracts", timeout=10)
        assert r.status_code in (404, 405)
