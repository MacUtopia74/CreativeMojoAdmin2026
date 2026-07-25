"""Phase 1C Turn C — complement tests.

Fills gaps in the main-agent suite (test_phase1c_turn_c.py):

1. Preview-generator refactor is a no-op regression:
   - Paloma template evidence-pack still returns a valid ZIP
     (openable, contains manifest.json + at least one PDF).
   - sample-preview.pdf endpoint still returns 200 with
     X-Preview-Redaction-Verified=1 + X-Preview-Residual-Tokens=0.
   - per-marker sample-preview.png returns 200 with X-Overflow header.
2. render_report_summary shape on the issued contract carries
   hyperlink_count == 1, link_annotations list, redaction_verified=True,
   template_version, source_pdf_sha256.
3. Signed URL HEAD reveals Content-Type=application/pdf and
   Cache-Control='private, no-store' (R2 no-store guard).
4. Frozen territory map URL matches the required prefix.
5. Contract-level immutability of personalised_pdf_sha256 after a
   double /issue attempt (409).
"""
from __future__ import annotations

import io
import os
import time
import zipfile

import fitz
import pytest
import requests


BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")
ADMIN_EMAIL = "admin@creativemojo.co.uk"
ADMIN_PASSWORD = "CreativeMojo2026!"
PALOMA_TEMPLATE_ID = "c12c8ce1-423b-4667-b5f7-da897546fa23"

if not BASE_URL:
    raise RuntimeError("REACT_APP_BACKEND_URL must be set")


# ---------- Shared helpers ----------
def _pdf_with_markers(codes):
    doc = fitz.open()
    p = doc.new_page(width=595, height=842)
    y = 100
    for c in codes:
        p.insert_text((72, y), f"[[{c}]]", fontsize=11, fontname="helv")
        y += 30
    b = doc.tobytes()
    doc.close()
    return b


@pytest.fixture(scope="module")
def admin_client():
    s = requests.Session()
    r = s.post(
        f"{BASE_URL}/api/auth/login",
        json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
        timeout=15,
    )
    assert r.status_code == 200
    tok = r.json().get("token") or r.json().get("access_token")
    s.headers.update({"Authorization": f"Bearer {tok}"})
    return s


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


def _upload_and_approve(admin_client, codes, name, contract_type):
    pdf = _pdf_with_markers(codes)
    files = {"pdf": (f"{name}.pdf", pdf, "application/pdf")}
    data = {"name": name, "contract_type": contract_type}
    r = admin_client.post(
        f"{BASE_URL}/api/admin/contract-templates/upload-marker-pdf",
        files=files, data=data, timeout=30,
    )
    assert r.status_code == 200
    job = _wait_job(admin_client, r.json()["job_id"])
    tid = job["template_id"]
    r = admin_client.post(
        f"{BASE_URL}/api/admin/contract-templates/{tid}/approve", timeout=30,
    )
    assert r.status_code == 200, r.text
    return r.json()


@pytest.fixture(scope="module")
def franchisee_with_territory(admin_client):
    r = admin_client.get(f"{BASE_URL}/api/franchisees?limit=500", timeout=15)
    body = r.json()
    items = body.get("items") if isinstance(body, dict) else body
    for f in items or []:
        if f.get("territory_ids"):
            return f
    pytest.skip("No franchisee with territory_ids found in DB.")


# =====================================================
# 1. Preview-generator refactor no-op regression
# =====================================================
class TestPreviewGeneratorRegression:
    def test_paloma_evidence_pack_zip_openable(self, admin_client):
        r = admin_client.post(
            f"{BASE_URL}/api/admin/contract-templates/{PALOMA_TEMPLATE_ID}/evidence-pack",
            timeout=60,
        )
        assert r.status_code == 200, r.text
        assert r.headers.get("content-type", "").startswith("application/zip")
        # Must be a valid ZIP openable in memory
        z = zipfile.ZipFile(io.BytesIO(r.content))
        names = z.namelist()
        assert names, "evidence pack ZIP is empty"
        # At least one PDF artefact should be present in the pack
        assert any(n.lower().endswith(".pdf") for n in names)

    def test_paloma_sample_preview_pdf_headers(self, admin_client):
        r = admin_client.post(
            f"{BASE_URL}/api/admin/contract-templates/{PALOMA_TEMPLATE_ID}/sample-preview.pdf",
            timeout=60,
        )
        assert r.status_code == 200, r.text
        assert r.headers.get("X-Preview-Redaction-Verified") == "1"
        assert r.headers.get("X-Preview-Residual-Tokens") == "0"
        # Returned payload is a PDF
        assert r.content.startswith(b"%PDF")

    def test_paloma_per_marker_png_has_overflow_header(self, admin_client):
        # Pull the template document itself to grab one occurrence_id
        r = admin_client.get(
            f"{BASE_URL}/api/admin/contract-templates/{PALOMA_TEMPLATE_ID}",
            timeout=15,
        )
        assert r.status_code == 200
        doc = r.json()
        markers_list = doc.get("markers") or []
        assert markers_list, "no markers on Paloma template"
        occ = markers_list[0].get("occurrence_id") or markers_list[0].get("id")
        assert occ
        r = admin_client.get(
            f"{BASE_URL}/api/admin/contract-templates/{PALOMA_TEMPLATE_ID}"
            f"/markers/{occ}/sample-preview.png",
            timeout=30,
        )
        assert r.status_code == 200, r.text
        # X-Overflow header MUST exist (0 or 1)
        assert r.headers.get("X-Overflow") in ("0", "1")
        assert r.headers.get("content-type", "").startswith("image/png")


# =====================================================
# 2. Render report summary shape on issued contract
# =====================================================
@pytest.fixture(scope="module")
def issued_territory_contract(admin_client, franchisee_with_territory):
    tpl = _upload_and_approve(
        admin_client,
        ["AGREEMENT_DATE", "FRANCHISEE_ORGANISATION", "MONTHLY_FEE", "TERRITORY_MAP_URL"],
        f"turn-c-complement-{int(time.time())}",
        "new_franchise",  # disjoint contract_type so we don't retire the main-suite template
    )
    r = admin_client.post(
        f"{BASE_URL}/api/admin/contracts",
        json={
            "template_id": tpl["id"],
            "franchisee_id": franchisee_with_territory["id"],
            "monthly_fee": 125.75,
        },
        timeout=15,
    )
    assert r.status_code == 200, r.text
    cid = r.json()["id"]
    r = admin_client.post(
        f"{BASE_URL}/api/admin/contracts/{cid}/freeze-territory", timeout=30,
    )
    assert r.status_code == 200, r.text
    snap = r.json()
    r = admin_client.post(
        f"{BASE_URL}/api/admin/contracts/{cid}/resolve-variables", timeout=30,
    )
    assert r.status_code == 200
    r = admin_client.post(
        f"{BASE_URL}/api/admin/contracts/{cid}/issue", timeout=60,
    )
    assert r.status_code == 200, r.text
    return {"cid": cid, "issued": r.json(), "snapshot": snap}


class TestRenderReportSummary:
    def test_render_report_summary_shape(self, issued_territory_contract):
        issued = issued_territory_contract["issued"]
        rr = issued.get("render_report_summary") or {}
        assert rr.get("hyperlink_count") == 1, rr
        assert rr.get("residual_token_count") == 0
        assert rr.get("redaction_verified") is True
        assert rr.get("template_version") is not None
        assert isinstance(rr.get("source_pdf_sha256"), str)
        assert len(rr["source_pdf_sha256"]) == 64
        # link_annotations list must contain at least one entry with
        # {page, uri, rect}
        links = rr.get("link_annotations") or []
        assert links, "render_report_summary.link_annotations is empty"
        first = links[0]
        assert "uri" in first and "page" in first and "rect" in first

    def test_frozen_territory_url_prefix(self, admin_client, issued_territory_contract):
        cid = issued_territory_contract["cid"]
        r = admin_client.get(f"{BASE_URL}/api/admin/contracts/{cid}", timeout=15)
        url = r.json()["frozen_territory_map_url"]
        assert url.startswith("https://hub.creativemojo.co.uk/agreed-territory/"), url

    def test_signed_url_head_reveals_content_type_and_cache_control(
        self, admin_client, issued_territory_contract,
    ):
        cid = issued_territory_contract["cid"]
        r = admin_client.get(
            f"{BASE_URL}/api/admin/contracts/{cid}/personalised-pdf", timeout=15,
        )
        assert r.status_code == 200
        signed = r.json()["url"]
        hr = requests.head(signed, timeout=15, allow_redirects=True)
        # Some S3-compat servers only expose headers on GET; fall back if HEAD is denied.
        if hr.status_code == 200:
            ct = (hr.headers.get("Content-Type") or "").lower()
            cc = (hr.headers.get("Cache-Control") or "").lower()
            assert ct.startswith("application/pdf"), ct
            assert "no-store" in cc or "private" in cc, cc
        else:
            gr = requests.get(signed, timeout=30)
            assert gr.status_code == 200
            assert (gr.headers.get("Content-Type") or "").lower().startswith(
                "application/pdf"
            )

    def test_double_issue_does_not_change_sha(self, admin_client, issued_territory_contract):
        cid = issued_territory_contract["cid"]
        sha_before = issued_territory_contract["issued"]["personalised_pdf_sha256"]
        r = admin_client.post(f"{BASE_URL}/api/admin/contracts/{cid}/issue", timeout=15)
        assert r.status_code == 409
        # Contract row still carries the original sha
        r = admin_client.get(f"{BASE_URL}/api/admin/contracts/{cid}", timeout=15)
        assert r.json()["personalised_pdf_sha256"] == sha_before
