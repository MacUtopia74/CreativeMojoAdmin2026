"""Stop Point 3 — Evidence pack corrections end-to-end regression.

Covers the four HQ blockers plus source-integrity assertions:
1. marker-summary rollup: substitution not required + occurrence overrides
2. evidence-pack ZIP contents + manifest correctness
3. source.pdf byte-identity + /integrity-check
4. preview.pdf has no residual [[ tokens
5. sample-preview.pdf headers (redaction, residual tokens, source integrity)
"""
from __future__ import annotations

import hashlib
import io
import json
import os
import zipfile

import fitz  # pymupdf
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "https://licensee-vault.preview.emergentagent.com").rstrip("/")
TEMPLATE_ID = "c12c8ce1-423b-4667-b5f7-da897546fa23"
EXPECTED_SHA = "e3f7ac7720f0777e323f1cca46138832e63cf4cf6511a57f778e91d6deb04c88"
ADMIN_EMAIL = "admin@creativemojo.co.uk"
ADMIN_PASSWORD = "CreativeMojo2026!"


@pytest.fixture(scope="module")
def admin_token():
    r = requests.post(
        f"{BASE_URL}/api/auth/login",
        json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
        timeout=30,
    )
    assert r.status_code == 200, f"login failed: {r.status_code} {r.text[:400]}"
    tok = r.json().get("access_token") or r.json().get("token")
    assert tok, f"no token in login response: {r.json()}"
    return tok


@pytest.fixture(scope="module")
def auth_headers(admin_token):
    return {"Authorization": f"Bearer {admin_token}"}


@pytest.fixture(scope="module")
def marker_summary(auth_headers):
    r = requests.get(
        f"{BASE_URL}/api/admin/contract-templates/{TEMPLATE_ID}/marker-summary",
        headers=auth_headers,
        timeout=60,
    )
    assert r.status_code == 200, f"marker-summary failed: {r.status_code} {r.text[:400]}"
    return r.json()


@pytest.fixture(scope="module")
def evidence_zip(auth_headers):
    r = requests.post(
        f"{BASE_URL}/api/admin/contract-templates/{TEMPLATE_ID}/evidence-pack",
        headers=auth_headers,
        timeout=120,
    )
    assert r.status_code == 200, f"evidence-pack failed: {r.status_code} {r.text[:400]}"
    ct = r.headers.get("content-type", "")
    assert "application/zip" in ct, f"unexpected content-type: {ct}"
    return zipfile.ZipFile(io.BytesIO(r.content))


# -- 1. marker-summary rollup ---------------------------------------------

class TestMarkerSummary:
    def test_substitution_groups_not_required(self, marker_summary):
        groups = marker_summary.get("substitution_groups")
        assert isinstance(groups, list) and groups, "substitution_groups missing/empty"
        families = {g.get("font_family") for g in groups}
        for g in groups:
            assert g.get("substitution_required") is False, (
                f"group {g.get('font_family')} substitution_required != False: {g}"
            )
        assert "Arial-BoldMT" in families, f"Arial-BoldMT missing: {families}"
        assert "ArialMT" in families, f"ArialMT missing: {families}"

    def test_all_acknowledged_flag(self, marker_summary):
        assert marker_summary.get("all_substitutions_acknowledged") is True

    def test_franchisee_legal_name_p3_overrides(self, marker_summary):
        # marker-summary returns a flat list where each entry is one occurrence
        occs = [
            m for m in marker_summary.get("markers", [])
            if m.get("code") == "FRANCHISEE_LEGAL_NAME" and m.get("page") == 3
        ]
        assert occs, "no FRANCHISEE_LEGAL_NAME occurrences on page 3"
        for o in occs:
            assert o.get("font_size_override") is not None, f"missing font_size_override: {o}"
            assert float(o.get("font_size_override")) == 11.0, o
            assert o.get("min_font_size") is not None, f"missing min_font_size: {o}"
            assert float(o.get("min_font_size")) == 11.0, o

    def test_monthly_fee_p4_right_aligned(self, marker_summary):
        occs = [
            m for m in marker_summary.get("markers", [])
            if m.get("code") == "MONTHLY_FEE" and m.get("page") == 4
        ]
        assert occs, "no MONTHLY_FEE occurrences on page 4"
        for o in occs:
            assert o.get("alignment") == "right", o

    def test_franchisee_org_p5_right_aligned(self, marker_summary):
        occs = [
            m for m in marker_summary.get("markers", [])
            if m.get("code") == "FRANCHISEE_ORGANISATION" and m.get("page") == 5
        ]
        assert occs, "no FRANCHISEE_ORGANISATION occurrences on page 5"
        for o in occs:
            assert o.get("alignment") == "right", o


# -- 2. evidence pack ZIP + manifest --------------------------------------

REQUIRED_FILES = {"README.md", "manifest.json", "source.pdf", "preview.pdf",
                  "markers.csv", "audit_log.jsonl"}


class TestEvidencePack:
    def test_zip_contains_required_files(self, evidence_zip):
        names = set(evidence_zip.namelist())
        missing = REQUIRED_FILES - names
        assert not missing, f"missing files in evidence pack: {missing} (have {names})"

    def test_manifest_template_hash(self, evidence_zip):
        manifest = json.loads(evidence_zip.read("manifest.json"))
        assert manifest["template"]["pdf_sha256"] == EXPECTED_SHA

    def test_manifest_substitution_rollup(self, evidence_zip):
        manifest = json.loads(evidence_zip.read("manifest.json"))
        assert manifest.get("substitution_acknowledgements") == {}
        assert manifest.get("all_substitutions_acknowledged") is True
        groups = manifest.get("substitution_groups")
        assert isinstance(groups, list) and groups, "substitution_groups missing/empty"
        for g in groups:
            assert g.get("substitution_required") is False, g
            assert g.get("acknowledged") is False, g

    def test_manifest_preview_report(self, evidence_zip):
        manifest = json.loads(evidence_zip.read("manifest.json"))
        pr = manifest.get("preview_report", {})
        assert pr.get("residual_token_count") == 0, pr
        assert pr.get("redaction_verified") is True, pr
        occs = pr.get("occurrences", [])
        assert occs, "no occurrences in preview_report"
        for o in occs:
            assert o.get("overflow") is False, o
            assert float(o.get("final_size")) == 11.0, o
            assert o.get("substitution_required") is False, o


# -- 3. source integrity ---------------------------------------------------

class TestSourceIntegrity:
    def test_source_pdf_hash_matches(self, evidence_zip):
        src = evidence_zip.read("source.pdf")
        digest = hashlib.sha256(src).hexdigest()
        assert digest == EXPECTED_SHA, f"source.pdf hash drift: {digest} != {EXPECTED_SHA}"

    def test_integrity_check_endpoint(self, auth_headers):
        r = requests.get(
            f"{BASE_URL}/api/admin/contract-templates/{TEMPLATE_ID}/integrity-check",
            headers=auth_headers,
            timeout=30,
        )
        assert r.status_code == 200, f"integrity-check failed: {r.status_code} {r.text[:400]}"
        data = r.json()
        assert data.get("ok") is True, data
        # sha256s should match — accept various shapes
        for key in ("pdf_sha256", "expected_sha256", "actual_sha256", "sha256"):
            if key in data:
                assert data[key] == EXPECTED_SHA, f"{key}={data[key]}"


# -- 4. preview PDF has no residual tokens ---------------------------------

class TestPreviewRedaction:
    def test_no_double_bracket_in_preview(self, evidence_zip):
        preview = evidence_zip.read("preview.pdf")
        doc = fitz.open(stream=io.BytesIO(preview), filetype="pdf")
        try:
            offenders = []
            for i, page in enumerate(doc, start=1):
                text = page.get_text() or ""
                if "[[" in text:
                    offenders.append((i, text[:200]))
            assert not offenders, f"residual [[ tokens on pages: {offenders}"
        finally:
            doc.close()


# -- 5. sample-preview.pdf response headers --------------------------------

class TestSamplePreviewHeaders:
    def test_sample_preview_headers(self, auth_headers):
        r = requests.post(
            f"{BASE_URL}/api/admin/contract-templates/{TEMPLATE_ID}/sample-preview.pdf",
            headers=auth_headers,
            timeout=120,
        )
        assert r.status_code == 200, f"sample-preview failed: {r.status_code} {r.text[:400]}"
        h = {k.lower(): v for k, v in r.headers.items()}
        assert h.get("x-preview-redaction-verified") == "1", h
        assert h.get("x-preview-residual-tokens") == "0", h
        assert h.get("x-source-integrity-status") == "ok", h


# -- 6. idempotency (evidence pack must not mutate template) ---------------

class TestIdempotency:
    def test_evidence_pack_is_idempotent(self, auth_headers):
        # snapshot marker-summary before + after a second call
        def snapshot():
            r = requests.get(
                f"{BASE_URL}/api/admin/contract-templates/{TEMPLATE_ID}/marker-summary",
                headers=auth_headers,
                timeout=60,
            )
            r.raise_for_status()
            return r.json()

        before = snapshot()
        r = requests.post(
            f"{BASE_URL}/api/admin/contract-templates/{TEMPLATE_ID}/evidence-pack",
            headers=auth_headers,
            timeout=120,
        )
        assert r.status_code == 200
        # source hash inside zip must still match
        zf = zipfile.ZipFile(io.BytesIO(r.content))
        assert hashlib.sha256(zf.read("source.pdf")).hexdigest() == EXPECTED_SHA
        after = snapshot()
        # markers list length & occurrence counts unchanged
        b_markers = before.get("markers", [])
        a_markers = after.get("markers", [])
        assert len(b_markers) == len(a_markers), "marker count drift"
        b_occ = sum(len(m.get("occurrences", [])) for m in b_markers)
        a_occ = sum(len(m.get("occurrences", [])) for m in a_markers)
        assert b_occ == a_occ, "occurrence count drift"
