"""Regression: draft-only contract Preview PDF.

Locks the invariants HQ needs to trust:

* Only draft contracts can be previewed. Issued/signed/superseded
  contracts return 409 so the caller falls through to the standard
  download path.
* Previewing does NOT change ``contract.status``.
* Previewing does NOT write anything to R2 (no ``personalised.pdf``
  key appears).
* Previewing does NOT expose the draft to the franchisee — the
  ``/portal/contracts`` list still excludes drafts after a preview.
* The returned PDF carries the ``PREVIEW - NOT FOR ISSUE`` watermark
  on every page.
"""
from __future__ import annotations

import os
import time

import fitz
import pytest
import requests


BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")
ADMIN_EMAIL = "admin@creativemojo.co.uk"
ADMIN_PASSWORD = "CreativeMojo2026!"
FRANCHISEE_EMAIL = "franchisee.tester@creativemojo.co.uk"
FRANCHISEE_PASSWORD = "FranchiseeTest2026!"
FRANCHISEE_ID = "febd57cf-600d-4b44-bebc-6a9177984832"

if not BASE_URL:
    raise RuntimeError("REACT_APP_BACKEND_URL must be set")


def _login(email, password):
    s = requests.Session()
    r = s.post(f"{BASE_URL}/api/auth/login",
               json={"email": email, "password": password}, timeout=15)
    r.raise_for_status()
    tok = r.json().get("access_token") or r.json().get("token")
    s.headers.update({"Authorization": f"Bearer {tok}"})
    return s


@pytest.fixture(scope="module")
def admin():
    return _login(ADMIN_EMAIL, ADMIN_PASSWORD)


@pytest.fixture(scope="module")
def franchisee():
    return _login(FRANCHISEE_EMAIL, FRANCHISEE_PASSWORD)


def _pdf_with_markers(codes):
    doc = fitz.open()
    p = doc.new_page(width=595, height=842)
    y = 100
    for c in codes:
        p.insert_text((72, y), f"[[{c}]]", fontsize=11, fontname="helv")
        y += 30
    p2 = doc.new_page(width=595, height=842)
    p2.insert_text((72, 100), "Signing page.", fontsize=11, fontname="helv")
    b = doc.tobytes()
    doc.close()
    return b


def _wait_job(client, job_id, timeout=45):
    deadline = time.time() + timeout
    while time.time() < deadline:
        r = client.get(
            f"{BASE_URL}/api/admin/contract-templates/upload-jobs/{job_id}",
            timeout=10,
        )
        r.raise_for_status()
        j = r.json()
        if j.get("status") in ("complete", "failed"):
            return j
        time.sleep(0.3)
    raise AssertionError("upload job timed out")


@pytest.fixture(scope="module")
def draft_contract(admin):
    pdf = _pdf_with_markers(["AGREEMENT_DATE", "FRANCHISEE_ORGANISATION", "CONTRACT_REFERENCE"])
    files = {"pdf": (f"preview-regression-{int(time.time())}.pdf", pdf, "application/pdf")}
    data = {"name": f"preview-regression-{int(time.time())}", "contract_type": "other"}
    r = admin.post(f"{BASE_URL}/api/admin/contract-templates/upload-marker-pdf",
                   files=files, data=data, timeout=30)
    r.raise_for_status()
    job = _wait_job(admin, r.json()["job_id"])
    assert job["status"] == "complete", job
    tid = job["template_id"]
    r = admin.post(f"{BASE_URL}/api/admin/contract-templates/{tid}/approve", timeout=30)
    assert r.status_code == 200, r.text
    r = admin.post(f"{BASE_URL}/api/admin/contracts",
                   json={"template_id": tid, "franchisee_id": FRANCHISEE_ID},
                   timeout=15)
    assert r.status_code == 200, r.text
    return r.json()


class TestDraftPreviewPDF:
    def test_preview_returns_pdf_with_watermark(self, admin, draft_contract):
        cid = draft_contract["id"]
        r = admin.post(f"{BASE_URL}/api/admin/contracts/{cid}/preview-pdf",
                       timeout=30)
        assert r.status_code == 200, r.text
        assert r.headers.get("content-type", "").startswith("application/pdf")
        assert "no-store" in (r.headers.get("cache-control") or "").lower()
        assert "DRAFT" in (r.headers.get("content-disposition") or "")
        assert r.headers.get("x-preview-watermark") == "PREVIEW-NOT-FOR-ISSUE"
        assert r.content.startswith(b"%PDF")
        # Every page carries the watermark
        doc = fitz.open(stream=r.content, filetype="pdf")
        try:
            for i, page in enumerate(doc):
                text = page.get_text("text")
                assert "PREVIEW - NOT FOR ISSUE" in text, (
                    f"Page {i+1} is missing the preview watermark"
                )
        finally:
            doc.close()

    def test_preview_does_not_change_status(self, admin, draft_contract):
        cid = draft_contract["id"]
        r = admin.post(f"{BASE_URL}/api/admin/contracts/{cid}/preview-pdf", timeout=30)
        assert r.status_code == 200
        r = admin.get(f"{BASE_URL}/api/admin/contracts/{cid}", timeout=15)
        assert r.status_code == 200
        c = r.json()
        assert c["status"] == "draft"
        assert not c.get("personalised_pdf_r2_key")
        assert not c.get("personalised_pdf_sha256")
        assert not c.get("issued_at")

    def test_preview_does_not_expose_to_franchisee(self, franchisee, draft_contract):
        cid = draft_contract["id"]
        # Portal list must never include drafts. Empty is fine — the
        # test franchisee's issued contract from earlier E2E runs may
        # already be signed, but the DRAFT under test must not appear.
        r = franchisee.get(f"{BASE_URL}/api/portal/contracts", timeout=15)
        assert r.status_code == 200
        ids = [i["id"] for i in r.json()["items"]]
        assert cid not in ids, "Draft leaked into franchisee portal list"
        # And a direct GET must 404 (portal endpoint requires
        # status in {issued,signed,superseded} + owner match).
        r = franchisee.get(f"{BASE_URL}/api/portal/contracts/{cid}", timeout=15)
        assert r.status_code in (403, 404)

    def test_preview_can_be_run_multiple_times(self, admin, draft_contract):
        # Idempotency — the preview endpoint may be pressed many times
        # by HQ without any accumulating state.
        cid = draft_contract["id"]
        for _ in range(3):
            r = admin.post(f"{BASE_URL}/api/admin/contracts/{cid}/preview-pdf", timeout=30)
            assert r.status_code == 200
        r = admin.get(f"{BASE_URL}/api/admin/contracts/{cid}", timeout=15)
        assert r.json()["status"] == "draft"

    def test_preview_rejected_after_issue(self, admin, draft_contract):
        cid = draft_contract["id"]
        # Resolve + issue the contract, then confirm the preview
        # endpoint refuses (409) — the standard personalised-pdf
        # endpoint is the correct path for issued contracts.
        r = admin.post(f"{BASE_URL}/api/admin/contracts/{cid}/resolve-variables", timeout=30)
        assert r.status_code == 200, r.text
        r = admin.post(f"{BASE_URL}/api/admin/contracts/{cid}/issue", timeout=60)
        assert r.status_code == 200, r.text
        assert r.json()["status"] == "issued"

        r = admin.post(f"{BASE_URL}/api/admin/contracts/{cid}/preview-pdf", timeout=15)
        assert r.status_code == 409
        assert "draft" in r.text.lower()
