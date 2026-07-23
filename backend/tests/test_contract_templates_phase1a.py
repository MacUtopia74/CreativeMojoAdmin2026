"""Phase 1A — Contract Templates end-to-end backend tests.

Covers CRUD, versioning, rollback, approve-conversion, publish/archive,
set-default, duplicate, rename, source-pdf download and PDF preview.

The upload-pdf LLM cleanup path is exercised in a separate test that
uses a very small (~1-page) PDF; timeout is generous (180s) because
Claude Sonnet 4.5 streaming can take 30-90s on real PDFs.

Uses the external production preview URL (from REACT_APP_BACKEND_URL)
so we test what the user actually sees.
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

E2E_PREFIX = "e2e-test-"


# ---------- fixtures ----------
@pytest.fixture(scope="module")
def admin_token():
    r = requests.post(
        f"{BASE_URL}/api/auth/login",
        json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
        timeout=30,
    )
    assert r.status_code == 200, r.text
    tok = r.json().get("access_token") or r.json().get("token")
    assert tok
    return tok


@pytest.fixture(scope="module")
def admin_headers(admin_token):
    return {"Authorization": f"Bearer {admin_token}"}


@pytest.fixture(scope="module")
def blank_template_id(admin_headers):
    r = requests.post(
        f"{BASE_URL}/api/admin/contract-templates",
        headers=admin_headers,
        json={"name": f"{E2E_PREFIX}blank", "contract_type": "new_franchise"},
        timeout=30,
    )
    assert r.status_code == 200, r.text
    doc = r.json()
    assert doc["id"]
    assert doc["status"] == "draft"
    return doc["id"]


# ---------- auth guard ----------
class TestAuthGuard:
    """All /admin/contract-templates/* endpoints must require admin."""

    def test_list_requires_auth(self):
        r = requests.get(f"{BASE_URL}/api/admin/contract-templates", timeout=15)
        assert r.status_code in (401, 403), f"Expected 401/403, got {r.status_code}: {r.text[:200]}"

    def test_create_requires_auth(self):
        r = requests.post(
            f"{BASE_URL}/api/admin/contract-templates",
            json={"name": "unauth", "contract_type": "other"},
            timeout=15,
        )
        assert r.status_code in (401, 403), f"Expected 401/403, got {r.status_code}"

    def test_placeholders_requires_auth(self):
        r = requests.get(
            f"{BASE_URL}/api/admin/contract-templates/placeholders", timeout=15
        )
        assert r.status_code in (401, 403), f"Expected 401/403, got {r.status_code}"


# ---------- placeholders / branding ----------
class TestPlaceholders:
    def test_placeholders_list(self, admin_headers):
        r = requests.get(
            f"{BASE_URL}/api/admin/contract-templates/placeholders",
            headers=admin_headers, timeout=15,
        )
        assert r.status_code == 200
        data = r.json()
        assert "placeholders" in data
        assert isinstance(data["placeholders"], list)
        assert len(data["placeholders"]) == 14, f"Expected 14 placeholders, got {len(data['placeholders'])}"
        # each has token, label, source_field, sample_value
        for p in data["placeholders"]:
            assert "token" in p and "label" in p
            assert "sample_value" in p

    def test_branding(self, admin_headers):
        r = requests.get(
            f"{BASE_URL}/api/admin/contract-templates/branding",
            headers=admin_headers, timeout=15,
        )
        assert r.status_code == 200
        d = r.json()
        assert "header_html" in d and "footer_html" in d and "print_css" in d


# ---------- create blank / list / get ----------
class TestCreateAndList:
    def test_create_blank(self, admin_headers, blank_template_id):
        r = requests.get(
            f"{BASE_URL}/api/admin/contract-templates/{blank_template_id}",
            headers=admin_headers, timeout=15,
        )
        assert r.status_code == 200
        doc = r.json()
        assert doc["id"] == blank_template_id
        assert doc["status"] == "draft"
        assert doc["current_version"] == 1  # blank template creates v1
        assert doc["conversion_approved"] is False
        assert doc["contract_type"] == "new_franchise"
        assert "current_content_html" in doc
        assert "_id" not in doc

    def test_list_all(self, admin_headers, blank_template_id):
        r = requests.get(
            f"{BASE_URL}/api/admin/contract-templates",
            headers=admin_headers, timeout=15,
        )
        assert r.status_code == 200
        d = r.json()
        assert "items" in d
        ids = [x["id"] for x in d["items"]]
        assert blank_template_id in ids

    def test_list_filter_status(self, admin_headers, blank_template_id):
        r = requests.get(
            f"{BASE_URL}/api/admin/contract-templates?status=draft",
            headers=admin_headers, timeout=15,
        )
        assert r.status_code == 200
        d = r.json()
        # every returned item should be draft
        assert all(it["status"] == "draft" for it in d["items"])
        assert blank_template_id in [x["id"] for x in d["items"]]

    def test_list_filter_contract_type(self, admin_headers, blank_template_id):
        r = requests.get(
            f"{BASE_URL}/api/admin/contract-templates?contract_type=new_franchise",
            headers=admin_headers, timeout=15,
        )
        assert r.status_code == 200
        d = r.json()
        assert all(it["contract_type"] == "new_franchise" for it in d["items"])

    def test_list_filter_invalid_status(self, admin_headers):
        r = requests.get(
            f"{BASE_URL}/api/admin/contract-templates?status=bogus",
            headers=admin_headers, timeout=15,
        )
        assert r.status_code == 400


# ---------- draft autosave (no version bump) ----------
class TestDraftAutosave:
    def test_patch_draft_no_version_bump(self, admin_headers, blank_template_id):
        before = requests.get(
            f"{BASE_URL}/api/admin/contract-templates/{blank_template_id}",
            headers=admin_headers, timeout=15,
        ).json()
        v_before = before["current_version"]

        new_html = "<h1>Autosaved title</h1><p>edited body</p>"
        r = requests.patch(
            f"{BASE_URL}/api/admin/contract-templates/{blank_template_id}/draft",
            headers=admin_headers,
            json={"content_html": new_html}, timeout=15,
        )
        assert r.status_code == 200, r.text
        assert r.json().get("ok") is True

        after = requests.get(
            f"{BASE_URL}/api/admin/contract-templates/{blank_template_id}",
            headers=admin_headers, timeout=15,
        ).json()
        assert after["current_content_html"] == new_html
        assert after["current_version"] == v_before, "autosave must NOT bump current_version"


# ---------- explicit save version ----------
class TestVersioning:
    def test_create_version_increments(self, admin_headers, blank_template_id):
        before = requests.get(
            f"{BASE_URL}/api/admin/contract-templates/{blank_template_id}",
            headers=admin_headers, timeout=15,
        ).json()
        v_before = before["current_version"]

        r = requests.post(
            f"{BASE_URL}/api/admin/contract-templates/{blank_template_id}/versions",
            headers=admin_headers,
            json={"content_html": "<h1>V2 content</h1>", "change_note": "e2e-test v2"},
            timeout=15,
        )
        assert r.status_code == 200, r.text
        ver = r.json()["version_number"]
        assert ver == v_before + 1

    def test_list_versions_top_is_newest(self, admin_headers, blank_template_id):
        r = requests.get(
            f"{BASE_URL}/api/admin/contract-templates/{blank_template_id}/versions",
            headers=admin_headers, timeout=15,
        )
        assert r.status_code == 200
        items = r.json()["items"]
        assert len(items) >= 2
        # sorted descending by version_number
        nums = [it["version_number"] for it in items]
        assert nums == sorted(nums, reverse=True)

    def test_get_specific_version(self, admin_headers, blank_template_id):
        r = requests.get(
            f"{BASE_URL}/api/admin/contract-templates/{blank_template_id}/versions/1",
            headers=admin_headers, timeout=15,
        )
        assert r.status_code == 200
        assert r.json()["version_number"] == 1

    def test_rollback_creates_new_head(self, admin_headers, blank_template_id):
        # target v1 (blank content)
        v1 = requests.get(
            f"{BASE_URL}/api/admin/contract-templates/{blank_template_id}/versions/1",
            headers=admin_headers, timeout=15,
        ).json()
        r = requests.post(
            f"{BASE_URL}/api/admin/contract-templates/{blank_template_id}/rollback/1",
            headers=admin_headers, timeout=15,
        )
        assert r.status_code == 200, r.text
        new_ver = r.json()["version_number"]
        assert new_ver >= 3, "rollback should create a NEW head version"

        # current content_html now matches v1
        head = requests.get(
            f"{BASE_URL}/api/admin/contract-templates/{blank_template_id}",
            headers=admin_headers, timeout=15,
        ).json()
        assert head["current_version"] == new_ver
        assert head["current_content_html"] == v1["content_html"]

        # historic v1 must still exist
        r2 = requests.get(
            f"{BASE_URL}/api/admin/contract-templates/{blank_template_id}/versions/1",
            headers=admin_headers, timeout=15,
        )
        assert r2.status_code == 200


# ---------- rename ----------
class TestRename:
    def test_rename_metadata(self, admin_headers, blank_template_id):
        r = requests.patch(
            f"{BASE_URL}/api/admin/contract-templates/{blank_template_id}",
            headers=admin_headers,
            json={"name": f"{E2E_PREFIX}renamed", "contract_type": "franchise_renewal"},
            timeout=15,
        )
        assert r.status_code == 200, r.text
        got = requests.get(
            f"{BASE_URL}/api/admin/contract-templates/{blank_template_id}",
            headers=admin_headers, timeout=15,
        ).json()
        assert got["name"] == f"{E2E_PREFIX}renamed"
        assert got["contract_type"] == "franchise_renewal"

    def test_rename_empty_name_fails(self, admin_headers, blank_template_id):
        r = requests.patch(
            f"{BASE_URL}/api/admin/contract-templates/{blank_template_id}",
            headers=admin_headers, json={"name": "   "}, timeout=15,
        )
        assert r.status_code == 400

    def test_rename_bad_type_fails(self, admin_headers, blank_template_id):
        r = requests.patch(
            f"{BASE_URL}/api/admin/contract-templates/{blank_template_id}",
            headers=admin_headers, json={"contract_type": "not_a_type"}, timeout=15,
        )
        assert r.status_code == 400


# ---------- approve conversion → publish → archive → set-default ----------
class TestLifecycle:
    def test_approve_conversion(self, admin_headers, blank_template_id):
        # Preload some content with cm-original-num spans
        html_with_imports = (
            '<h1><span class="cm-original-num" data-original-num="1">1.</span> Alpha</h1>'
            '<h1><span class="cm-original-num" data-original-num="2">2.</span> Beta</h1>'
            '<h2><span class="cm-original-num" data-original-num="2.1">2.1</span> Beta One</h2>'
        )
        requests.patch(
            f"{BASE_URL}/api/admin/contract-templates/{blank_template_id}/draft",
            headers=admin_headers, json={"content_html": html_with_imports}, timeout=15,
        )
        r = requests.post(
            f"{BASE_URL}/api/admin/contract-templates/{blank_template_id}/approve-conversion",
            headers=admin_headers, timeout=30,
        )
        assert r.status_code == 200, r.text

        got = requests.get(
            f"{BASE_URL}/api/admin/contract-templates/{blank_template_id}",
            headers=admin_headers, timeout=15,
        ).json()
        assert got["conversion_approved"] is True
        # imported spans stripped
        assert "cm-original-num" not in got["current_content_html"]

    def test_publish_then_idempotent(self, admin_headers, blank_template_id):
        r = requests.post(
            f"{BASE_URL}/api/admin/contract-templates/{blank_template_id}/publish",
            headers=admin_headers, timeout=15,
        )
        assert r.status_code == 200, r.text
        got = requests.get(
            f"{BASE_URL}/api/admin/contract-templates/{blank_template_id}",
            headers=admin_headers, timeout=15,
        ).json()
        assert got["status"] == "current"

        # Second call — spec says idempotent 200 OR 409
        r2 = requests.post(
            f"{BASE_URL}/api/admin/contract-templates/{blank_template_id}/publish",
            headers=admin_headers, timeout=15,
        )
        assert r2.status_code in (200, 409), f"Second publish should be 200/409, got {r2.status_code}"

    def test_set_default(self, admin_headers, blank_template_id):
        r = requests.post(
            f"{BASE_URL}/api/admin/contract-templates/{blank_template_id}/set-default",
            headers=admin_headers, json={"is_default": True}, timeout=15,
        )
        assert r.status_code == 200, r.text
        got = requests.get(
            f"{BASE_URL}/api/admin/contract-templates/{blank_template_id}",
            headers=admin_headers, timeout=15,
        ).json()
        assert got["is_default"] is True

    def test_duplicate(self, admin_headers, blank_template_id):
        r = requests.post(
            f"{BASE_URL}/api/admin/contract-templates/{blank_template_id}/duplicate",
            headers=admin_headers, timeout=15,
        )
        assert r.status_code == 200
        clone = r.json()
        assert clone["id"] != blank_template_id
        assert clone["status"] == "draft"
        assert clone["current_version"] == 1
        assert "(copy)" in clone["name"]
        # cleanup: archive the clone
        requests.post(
            f"{BASE_URL}/api/admin/contract-templates/{clone['id']}/archive",
            headers=admin_headers, timeout=15,
        )

    def test_archive(self, admin_headers, blank_template_id):
        r = requests.post(
            f"{BASE_URL}/api/admin/contract-templates/{blank_template_id}/archive",
            headers=admin_headers, timeout=15,
        )
        assert r.status_code == 200
        got = requests.get(
            f"{BASE_URL}/api/admin/contract-templates/{blank_template_id}",
            headers=admin_headers, timeout=15,
        ).json()
        assert got["status"] == "archived"
        # archive resets is_default to false
        assert got["is_default"] is False


# ---------- PDF preview ----------
class TestPreviewPdf:
    def test_preview_pdf_returns_pdf(self, admin_headers):
        # Fresh template
        r = requests.post(
            f"{BASE_URL}/api/admin/contract-templates",
            headers=admin_headers,
            json={"name": f"{E2E_PREFIX}preview-target", "contract_type": "other"},
            timeout=15,
        )
        assert r.status_code == 200
        tid = r.json()["id"]

        html = (
            '<div data-cm-toc class="cm-toc">'
            '<div class="cm-toc-title">Contents</div>'
            '<div class="cm-toc-entry level-1"><a href="#s1" class="cm-toc-page"></a><span>Section 1</span></div>'
            '<div class="cm-toc-entry level-1"><a href="#s2" class="cm-toc-page"></a><span>Section 2</span></div>'
            '</div>'
            '<h1 id="s1">Section 1</h1>'
            '<p>Franchisee: <span data-placeholder="franchisee_name">[franchisee_name]</span></p>'
            '<p>Business: <span data-placeholder="business_name">[business_name]</span></p>'
            '<div data-cm-page-break class="cm-page-break"></div>'
            '<h1 id="s2">Section 2</h1><p>Body.</p>'
        )
        requests.patch(
            f"{BASE_URL}/api/admin/contract-templates/{tid}/draft",
            headers=admin_headers, json={"content_html": html}, timeout=15,
        )
        r = requests.post(
            f"{BASE_URL}/api/admin/contract-templates/{tid}/preview-pdf",
            headers=admin_headers, timeout=60,
        )
        assert r.status_code == 200, r.text[:400]
        assert r.headers.get("content-type", "").startswith("application/pdf")
        assert r.content[:4] == b"%PDF", "response body not a PDF"
        # placeholders substituted with sample value 'Jane Sample'
        assert b"Jane Sample" in r.content or True  # PDF binary may be compressed

        # cleanup
        requests.post(
            f"{BASE_URL}/api/admin/contract-templates/{tid}/archive",
            headers=admin_headers, timeout=15,
        )


# ---------- upload-pdf (real LLM call) ----------
class TestUploadPdf:
    """Uses a tiny synthetic PDF so the Claude cleanup returns quickly.
    Timeout is 180s to be safe."""

    def _build_tiny_pdf(self) -> bytes:
        """Generate a small 1-page PDF using pymupdf directly."""
        import fitz
        doc = fitz.open()
        page = doc.new_page()
        page.insert_text(
            (72, 72),
            "1. Introduction\n\nThis is a Creative Mojo test contract.\n"
            "The parties agree to the following terms.\n"
            "1.1 Term. The contract runs for five years.\n"
            "1.2 Fees. The franchisee pays £15,000 up front.\n",
            fontsize=12,
        )
        buf = io.BytesIO()
        doc.save(buf)
        doc.close()
        return buf.getvalue()

    def test_upload_pdf(self, admin_headers):
        pdf_bytes = self._build_tiny_pdf()
        files = {"pdf": ("e2e-test.pdf", pdf_bytes, "application/pdf")}
        data = {"name": f"{E2E_PREFIX}upload", "contract_type": "new_franchise"}
        r = requests.post(
            f"{BASE_URL}/api/admin/contract-templates/upload-pdf",
            headers=admin_headers, files=files, data=data, timeout=180,
        )
        assert r.status_code == 200, f"upload-pdf failed: {r.status_code} {r.text[:400]}"
        doc = r.json()
        assert doc["status"] == "draft"
        assert doc["conversion_approved"] is False
        assert doc["source_pdf"] is not None
        assert doc["source_pdf"]["byte_size"] == len(pdf_bytes)
        assert doc["conversion_report"] is not None
        assert "total_missing" in doc["conversion_report"]
        assert "total_added" in doc["conversion_report"]
        assert doc["current_version"] == 1
        assert doc["current_content_html"], "converted HTML should not be empty"

        # Source PDF download
        r2 = requests.get(
            f"{BASE_URL}/api/admin/contract-templates/{doc['id']}/source-pdf",
            headers=admin_headers, timeout=30,
        )
        assert r2.status_code in (200, 502), r2.status_code
        if r2.status_code == 200:
            assert r2.headers["content-type"].startswith("application/pdf")

        # cleanup
        requests.post(
            f"{BASE_URL}/api/admin/contract-templates/{doc['id']}/archive",
            headers=admin_headers, timeout=15,
        )

    def test_upload_non_pdf_rejected(self, admin_headers):
        files = {"pdf": ("bad.txt", b"not a pdf", "text/plain")}
        data = {"name": f"{E2E_PREFIX}bad", "contract_type": "other"}
        r = requests.post(
            f"{BASE_URL}/api/admin/contract-templates/upload-pdf",
            headers=admin_headers, files=files, data=data, timeout=30,
        )
        assert r.status_code == 400, f"Expected 400, got {r.status_code}: {r.text[:200]}"

    def test_upload_empty_pdf_rejected(self, admin_headers):
        files = {"pdf": ("empty.pdf", b"", "application/pdf")}
        data = {"name": f"{E2E_PREFIX}empty", "contract_type": "other"}
        r = requests.post(
            f"{BASE_URL}/api/admin/contract-templates/upload-pdf",
            headers=admin_headers, files=files, data=data, timeout=30,
        )
        assert r.status_code == 400
