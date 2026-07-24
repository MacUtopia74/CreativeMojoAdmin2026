"""
Iteration 45 - end-to-end backend validation for DOCX upload flow (Phase 1A DOCX import).
Uses the real Paloma DOCX + reference PDF staged under /tmp.
"""
import os
import time
import requests
import pytest

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")
if not BASE_URL:
    with open("/app/frontend/.env") as f:
        for line in f:
            if line.startswith("REACT_APP_BACKEND_URL="):
                BASE_URL = line.split("=", 1)[1].strip().rstrip("/")

ADMIN_EMAIL = "admin@creativemojo.co.uk"
ADMIN_PASSWORD = "CreativeMojo2026!"

PALOMA_DOCX = "/tmp/paloma.docx"
PALOMA_PDF = "/tmp/paloma-ref.pdf"


@pytest.fixture(scope="module")
def auth_session():
    s = requests.Session()
    r = s.post(f"{BASE_URL}/api/auth/login",
               json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
               timeout=20)
    assert r.status_code == 200, f"admin login failed: {r.status_code} {r.text[:400]}"
    body = r.json()
    tok = body.get("access_token") or body.get("token")
    if tok:
        s.headers.update({"Authorization": f"Bearer {tok}"})
    return s


def _poll(session, jid, timeout=45):
    """Poll job until complete/failed or timeout. Returns final job doc."""
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        r = session.get(f"{BASE_URL}/api/admin/contract-templates/upload-jobs/{jid}", timeout=15)
        assert r.status_code == 200, r.text[:400]
        last = r.json()
        if last.get("status") in ("complete", "failed"):
            return last
        time.sleep(1.0)
    return last


class TestDocxUploadEndpoint:
    def test_upload_async_endpoint_docx(self, auth_session):
        with open(PALOMA_DOCX, "rb") as f:
            files = {"file": ("paloma.docx", f, "application/vnd.openxmlformats-officedocument.wordprocessingml.document")}
            data = {"name": "e2e-docx-paloma-plain", "contract_type": "franchise_renewal"}
            r = auth_session.post(f"{BASE_URL}/api/admin/contract-templates/upload-async",
                                  files=files, data=data, timeout=30)
        assert r.status_code == 200, r.text[:400]
        body = r.json()
        assert body["stage"] == "uploading"
        assert body["status"] == "running"
        assert body["progress"] == 5
        assert body["source_kind"] == "docx"
        assert "job_id" in body

        final = _poll(auth_session, body["job_id"], timeout=30)
        assert final["status"] == "complete", f"job did not complete: {final}"
        assert final["progress"] == 100
        assert final.get("template_id")

        tpl = auth_session.get(f"{BASE_URL}/api/admin/contract-templates/{final['template_id']}", timeout=15).json()
        assert tpl["import_type"] == "docx"
        assert tpl.get("source_docx"), "source_docx missing"
        assert tpl["source_docx"].get("r2_key")
        assert tpl["source_docx"].get("byte_size", 0) > 0
        assert tpl["current_version"] == 1
        assert tpl["conversion_approved"] is False
        assert tpl.get("source_pdf") in (None, {}, ""), "no reference PDF was supplied"
        rep = tpl.get("conversion_report") or {}
        assert rep.get("import_type") == "docx"
        for k in ("score", "image_count", "table_count", "heading_count", "page_break_count", "generated_at"):
            assert k in rep, f"conversion_report missing {k}"
        assert isinstance(rep.get("mammoth_warnings"), list)
        # cleanup
        auth_session.post(f"{BASE_URL}/api/admin/contract-templates/{tpl['id']}/archive", timeout=10)

    def test_upload_async_docx_with_reference_pdf(self, auth_session):
        with open(PALOMA_DOCX, "rb") as fd, open(PALOMA_PDF, "rb") as fp:
            files = {
                "file": ("paloma.docx", fd, "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
                "reference_pdf": ("paloma-ref.pdf", fp, "application/pdf"),
            }
            data = {"name": "e2e-docx-paloma-with-ref", "contract_type": "franchise_renewal"}
            r = auth_session.post(f"{BASE_URL}/api/admin/contract-templates/upload-async",
                                  files=files, data=data, timeout=60)
        assert r.status_code == 200, r.text[:400]
        body = r.json()
        assert body["source_kind"] == "docx"
        final = _poll(auth_session, body["job_id"], timeout=40)
        assert final["status"] == "complete", final
        tpl_id = final["template_id"]
        tpl = auth_session.get(f"{BASE_URL}/api/admin/contract-templates/{tpl_id}", timeout=15).json()
        assert tpl["import_type"] == "docx"
        assert tpl.get("source_pdf"), "reference PDF should be stored"
        assert tpl["source_pdf"].get("role") == "reference"
        # source-docx download
        r = auth_session.get(f"{BASE_URL}/api/admin/contract-templates/{tpl_id}/source-docx",
                             timeout=30)
        assert r.status_code == 200
        assert "wordprocessingml" in r.headers.get("content-type", "")
        assert len(r.content) > 10000
        # source-pdf (reference) download
        r = auth_session.get(f"{BASE_URL}/api/admin/contract-templates/{tpl_id}/source-pdf",
                             timeout=30)
        assert r.status_code == 200
        assert r.headers.get("content-type", "").startswith("application/pdf")

        # save id for other tests via env
        os.environ["ITER45_TPL_ID"] = tpl_id

    def test_upload_async_rejects_unknown_extension(self, auth_session):
        files = {"file": ("readme.txt", b"hello", "text/plain")}
        data = {"name": "e2e-docx-badext", "contract_type": "franchise_renewal"}
        r = auth_session.post(f"{BASE_URL}/api/admin/contract-templates/upload-async",
                              files=files, data=data, timeout=15)
        assert r.status_code == 400
        assert "docx" in r.text.lower() or "pdf" in r.text.lower()

    def test_source_docx_requires_auth(self, auth_session):
        tpl_id = os.environ.get("ITER45_TPL_ID")
        if not tpl_id:
            pytest.skip("dependency test not run")
        anon = requests.Session()
        r = anon.get(f"{BASE_URL}/api/admin/contract-templates/{tpl_id}/source-docx", timeout=15)
        assert r.status_code in (401, 403)

    def test_source_docx_404_when_no_source(self, auth_session):
        # Create a blank template (no docx)
        r = auth_session.post(f"{BASE_URL}/api/admin/contract-templates",
                              json={"name": "e2e-docx-blank", "contract_type": "franchise_renewal"},
                              timeout=15)
        assert r.status_code in (200, 201), r.text[:200]
        tpl_id = r.json()["id"]
        r2 = auth_session.get(f"{BASE_URL}/api/admin/contract-templates/{tpl_id}/source-docx", timeout=15)
        assert r2.status_code == 404
        auth_session.post(f"{BASE_URL}/api/admin/contract-templates/{tpl_id}/archive", timeout=10)

    def test_paloma_content_quality(self, auth_session):
        """Check verbatim score >= 99% and content shape."""
        tpl_id = os.environ.get("ITER45_TPL_ID")
        if not tpl_id:
            pytest.skip("dependency test not run")
        tpl = auth_session.get(f"{BASE_URL}/api/admin/contract-templates/{tpl_id}", timeout=20).json()
        rep = tpl.get("conversion_report") or {}
        score = rep.get("score", 0)
        assert score >= 0.99, f"verbatim score too low: {score}"
        html = tpl.get("current_content_html", "")
        assert "<table" in html.lower(), "no table in imported html"
        assert "<img" in html.lower(), "no image in imported html"
        assert rep.get("image_count", 0) >= 1
        assert rep.get("table_count", 0) >= 1
        assert rep.get("heading_count", 0) >= 1

    def test_cleanup(self, auth_session):
        tpl_id = os.environ.get("ITER45_TPL_ID")
        if tpl_id:
            auth_session.post(f"{BASE_URL}/api/admin/contract-templates/{tpl_id}/archive", timeout=10)
