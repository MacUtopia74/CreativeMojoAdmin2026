"""Phase 1A — Async upload flow tests.

Covers:
- POST /api/admin/contract-templates/upload-pdf-async (immediate 200 with job_id)
- GET  /api/admin/contract-templates/upload-jobs/{job_id} (polling)
- Full E2E: job progresses uploading → extracting → converting → verifying → creating → complete
- Failure & validation paths (bad type, empty file, non-pdf, bad job_id)
- Auth guard on both endpoints
- Backward compat: sync /upload-pdf endpoint still works (implicitly covered by phase1a suite)

Uses a tiny synthetic PDF so the LLM cleanup returns in <60s.
"""
from __future__ import annotations

import io
import os
import time
import pytest
import requests

BASE_URL = os.environ.get(
    "REACT_APP_BACKEND_URL",
    "https://licensee-vault.preview.emergentagent.com",
).rstrip("/")

ADMIN_EMAIL = "admin@creativemojo.co.uk"
ADMIN_PASSWORD = "CreativeMojo2026!"
E2E_PREFIX = "e2e-async-"

VALID_STAGES = [
    "uploading", "extracting", "converting", "verifying", "creating", "complete"
]
STAGE_PROGRESS = {
    "uploading": 5, "extracting": 25, "converting": 70,
    "verifying": 85, "creating": 95, "complete": 100,
}


@pytest.fixture(scope="module")
def admin_headers():
    r = requests.post(
        f"{BASE_URL}/api/auth/login",
        json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
        timeout=30,
    )
    assert r.status_code == 200, r.text
    tok = r.json().get("access_token") or r.json().get("token")
    assert tok
    return {"Authorization": f"Bearer {tok}"}


def _tiny_pdf() -> bytes:
    import fitz
    doc = fitz.open()
    page = doc.new_page()
    page.insert_text(
        (72, 72),
        "1. Introduction\n\nThis is an async upload test contract.\n"
        "The parties agree to the following terms.\n"
        "1.1 Term. The contract runs for five years.\n"
        "1.2 Fees. The franchisee pays £10,000 up front.\n",
        fontsize=12,
    )
    buf = io.BytesIO()
    doc.save(buf)
    doc.close()
    return buf.getvalue()


# --------------------------------------------------------------------- auth
class TestAuthGuardAsync:
    def test_upload_async_requires_auth(self):
        files = {"pdf": ("x.pdf", b"%PDF-1.4 tiny", "application/pdf")}
        data = {"name": "unauth", "contract_type": "other"}
        r = requests.post(
            f"{BASE_URL}/api/admin/contract-templates/upload-pdf-async",
            files=files, data=data, timeout=15,
        )
        assert r.status_code in (401, 403), r.status_code

    def test_get_job_requires_auth(self):
        r = requests.get(
            f"{BASE_URL}/api/admin/contract-templates/upload-jobs/does-not-matter",
            timeout=15,
        )
        assert r.status_code in (401, 403), r.status_code


# --------------------------------------------------------------------- validation
class TestValidation:
    def test_non_pdf_rejected(self, admin_headers):
        files = {"pdf": ("bad.txt", b"not a pdf", "text/plain")}
        data = {"name": f"{E2E_PREFIX}bad-ext", "contract_type": "other"}
        r = requests.post(
            f"{BASE_URL}/api/admin/contract-templates/upload-pdf-async",
            headers=admin_headers, files=files, data=data, timeout=15,
        )
        assert r.status_code == 400, f"{r.status_code} {r.text[:200]}"

    def test_empty_file_rejected(self, admin_headers):
        files = {"pdf": ("empty.pdf", b"", "application/pdf")}
        data = {"name": f"{E2E_PREFIX}empty", "contract_type": "other"}
        r = requests.post(
            f"{BASE_URL}/api/admin/contract-templates/upload-pdf-async",
            headers=admin_headers, files=files, data=data, timeout=15,
        )
        assert r.status_code == 400, f"{r.status_code} {r.text[:200]}"

    def test_invalid_contract_type_rejected(self, admin_headers):
        files = {"pdf": ("x.pdf", _tiny_pdf(), "application/pdf")}
        data = {"name": f"{E2E_PREFIX}badtype", "contract_type": "nonsense"}
        r = requests.post(
            f"{BASE_URL}/api/admin/contract-templates/upload-pdf-async",
            headers=admin_headers, files=files, data=data, timeout=15,
        )
        assert r.status_code == 400, f"{r.status_code} {r.text[:200]}"

    def test_nonexistent_job_404(self, admin_headers):
        r = requests.get(
            f"{BASE_URL}/api/admin/contract-templates/upload-jobs/does-not-exist-uuid",
            headers=admin_headers, timeout=15,
        )
        assert r.status_code == 404, f"{r.status_code} {r.text[:200]}"


# --------------------------------------------------------------------- fast response
class TestImmediateResponse:
    def test_upload_returns_immediately(self, admin_headers):
        pdf_bytes = _tiny_pdf()
        files = {"pdf": ("fast.pdf", pdf_bytes, "application/pdf")}
        data = {"name": f"{E2E_PREFIX}fast", "contract_type": "other"}
        start = time.monotonic()
        r = requests.post(
            f"{BASE_URL}/api/admin/contract-templates/upload-pdf-async",
            headers=admin_headers, files=files, data=data, timeout=15,
        )
        elapsed = time.monotonic() - start
        assert r.status_code == 200, r.text
        # Should return immediately — well under 3 seconds (allow 5s for edge overhead)
        assert elapsed < 5.0, f"Upload took {elapsed:.2f}s (should be <5s)"
        body = r.json()
        assert body.get("job_id"), body
        assert body["status"] == "running"
        assert body["stage"] == "uploading"
        assert body["progress"] == 5
        assert "Uploading" in body["message"]


# --------------------------------------------------------------------- E2E flow
class TestE2EFlow:
    def test_full_conversion_reaches_complete(self, admin_headers):
        pdf_bytes = _tiny_pdf()
        files = {"pdf": ("e2e-async.pdf", pdf_bytes, "application/pdf")}
        data = {"name": f"{E2E_PREFIX}e2e-flow", "contract_type": "new_franchise"}
        r = requests.post(
            f"{BASE_URL}/api/admin/contract-templates/upload-pdf-async",
            headers=admin_headers, files=files, data=data, timeout=15,
        )
        assert r.status_code == 200, r.text
        job_id = r.json()["job_id"]

        # Poll every 1.5s for up to 90s
        deadline = time.monotonic() + 90
        seen_stages = set()
        last_progress = 0
        job = None
        while time.monotonic() < deadline:
            gr = requests.get(
                f"{BASE_URL}/api/admin/contract-templates/upload-jobs/{job_id}",
                headers=admin_headers, timeout=15,
            )
            assert gr.status_code == 200, gr.text
            job = gr.json()
            # Verify expected shape of response
            for field in ["id", "status", "stage", "progress", "message",
                          "template_id", "error", "pdf_filename", "byte_size",
                          "template_name", "contract_type", "created_by",
                          "created_at", "updated_at"]:
                assert field in job, f"Missing field '{field}' in job: {job}"
            assert job["id"] == job_id
            assert job["pdf_filename"] == "e2e-async.pdf"
            assert job["byte_size"] == len(pdf_bytes)
            assert job["template_name"] == f"{E2E_PREFIX}e2e-flow"
            assert job["contract_type"] == "new_franchise"

            seen_stages.add(job["stage"])
            # Progress should be monotonic non-decreasing
            assert job["progress"] >= last_progress, \
                f"Progress went backwards: {last_progress} -> {job['progress']}"
            last_progress = job["progress"]

            if job["status"] in ("complete", "failed"):
                break
            time.sleep(1.5)

        assert job is not None
        assert job["status"] == "complete", \
            f"Job did not complete: status={job.get('status')}, stage={job.get('stage')}, error={job.get('error')}"
        assert job["stage"] == "complete"
        assert job["progress"] == 100
        assert job["template_id"], "template_id must be set on completion"
        assert job["error"] is None

        # Must have progressed through at least some intermediate stages
        # (uploading is guaranteed; extracting/converting/verifying/creating may
        # happen too fast for polling to catch each one, but at least 2 stages
        # should be observed)
        assert len(seen_stages) >= 2, f"Only saw stages: {seen_stages}"

        # Verify the created template is a full contract_templates doc
        tid = job["template_id"]
        tr = requests.get(
            f"{BASE_URL}/api/admin/contract-templates/{tid}",
            headers=admin_headers, timeout=15,
        )
        assert tr.status_code == 200, tr.text
        tpl = tr.json()
        assert tpl["id"] == tid
        assert tpl["status"] == "draft"
        assert tpl["current_version"] == 1
        assert tpl["contract_type"] == "new_franchise"
        assert tpl["name"] == f"{E2E_PREFIX}e2e-flow"
        assert tpl.get("source_pdf") is not None
        assert tpl["source_pdf"].get("byte_size") == len(pdf_bytes)
        assert tpl.get("current_content_html")
        assert tpl.get("conversion_report") is not None
        assert "total_missing" in tpl["conversion_report"]
        assert "total_added" in tpl["conversion_report"]

        # Verify appears in list
        lr = requests.get(
            f"{BASE_URL}/api/admin/contract-templates",
            headers=admin_headers, timeout=15,
        )
        assert lr.status_code == 200
        ids = [it["id"] for it in lr.json()["items"]]
        assert tid in ids, "New async-created template must appear in list"

        # Cleanup
        requests.post(
            f"{BASE_URL}/api/admin/contract-templates/{tid}/archive",
            headers=admin_headers, timeout=15,
        )


# --------------------------------------------------------------------- backward compat
class TestBackCompatSync:
    """The original sync /upload-pdf endpoint must still work identically."""

    def test_sync_upload_still_works(self, admin_headers):
        pdf_bytes = _tiny_pdf()
        files = {"pdf": ("sync.pdf", pdf_bytes, "application/pdf")}
        data = {"name": f"{E2E_PREFIX}sync-compat", "contract_type": "other"}
        r = requests.post(
            f"{BASE_URL}/api/admin/contract-templates/upload-pdf",
            headers=admin_headers, files=files, data=data, timeout=180,
        )
        assert r.status_code == 200, r.text[:400]
        doc = r.json()
        assert doc["status"] == "draft"
        assert doc["conversion_approved"] is False
        assert doc["current_version"] == 1
        assert doc["source_pdf"] is not None
        assert doc["conversion_report"] is not None

        # Cleanup
        requests.post(
            f"{BASE_URL}/api/admin/contract-templates/{doc['id']}/archive",
            headers=admin_headers, timeout=15,
        )
