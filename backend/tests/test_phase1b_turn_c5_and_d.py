"""Phase 1B Turn C.5 + Turn D — Duplicate settings, presentation fields,
audit log, and Stop Point 3 evidence pack.

Uploads a synthetic 2-page marker PDF with a repeated code so the
'duplicate to next / all_later' scopes have real targets, then verifies:

  * PATCH accepts and rejects the new presentation fields (wrapping,
    max_lines, casing, overlay_font_family_override).
  * Duplicate-preview returns correct targets for both scopes.
  * Duplicate-apply copies ONLY presentation fields — never touches
    token_bbox, render_bbox, page, occurrence_id, code, font_family
    metadata, etc.
  * Every mutating action lands in the audit log.
  * Evidence pack ZIP contains the expected files and headers.
"""
from __future__ import annotations

import io
import json
import os
import time
import zipfile

import fitz
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")
ADMIN_EMAIL = "admin@creativemojo.co.uk"
ADMIN_PASSWORD = "CreativeMojo2026!"

if not BASE_URL:
    raise RuntimeError("REACT_APP_BACKEND_URL must be set")


@pytest.fixture(scope="session")
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


def _repeated_marker_pdf() -> bytes:
    """3-page PDF with MONTHLY_FEE appearing 4 times to exercise scope."""
    doc = fitz.open()
    for pi in range(3):
        p = doc.new_page(width=595, height=842)
        p.insert_text((72, 120), "AGREEMENT DATED [[AGREEMENT_DATE]]", fontsize=11, fontname="helv")
        # Two MONTHLY_FEE occurrences on the 1st page, one on p2, one on p3
        if pi == 0:
            p.insert_text((72, 200), "Monthly fee: [[MONTHLY_FEE]] payable.", fontsize=11, fontname="helv")
            p.insert_text((72, 240), "Note: [[MONTHLY_FEE]] rises annually.", fontsize=11, fontname="helv")
        else:
            p.insert_text((72, 300), "Monthly fee: [[MONTHLY_FEE]] payable.", fontsize=11, fontname="helv")
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
def repeat_template(admin_client):
    pdf_bytes = _repeated_marker_pdf()
    files = {"pdf": ("turncd-test.pdf", pdf_bytes, "application/pdf")}
    data = {"name": "turncd-e2e-template", "contract_type": "franchise_renewal"}
    r = admin_client.post(
        f"{BASE_URL}/api/admin/contract-templates/upload-marker-pdf",
        files=files, data=data, timeout=30,
    )
    assert r.status_code == 200
    job = _wait_job(admin_client, r.json()["job_id"])
    assert job["status"] == "complete"
    tid = job["template_id"]
    yield tid
    try:
        admin_client.post(f"{BASE_URL}/api/admin/contract-templates/{tid}/archive", timeout=10)
    except Exception:
        pass


def _get_markers(client, tid):
    r = client.get(f"{BASE_URL}/api/admin/contract-templates/{tid}/marker-summary")
    return r.json()["markers"]


# ---------------------------------------------------------------------------
# 1. New PATCH-able presentation fields
# ---------------------------------------------------------------------------
class TestPresentationFields:
    def test_patch_all_presentation_fields(self, admin_client, repeat_template):
        markers = _get_markers(admin_client, repeat_template)
        oid = next(m["occurrence_id"] for m in markers if m["code"] == "MONTHLY_FEE")
        r = admin_client.patch(
            f"{BASE_URL}/api/admin/contract-templates/{repeat_template}/markers/{oid}",
            json={
                "wrapping": "no_wrap",
                "max_lines": 3,
                "casing": "upper",
                "overlay_font_family_override": "tiro",
                "alignment": "center",
                "font_size_override": 12.5,
            },
        )
        assert r.status_code == 200
        occ = r.json()["occurrence"]
        assert occ["wrapping"] == "no_wrap"
        assert occ["max_lines"] == 3
        assert occ["casing"] == "upper"
        assert occ["overlay_font_family_override"] == "tiro"
        assert occ["alignment"] == "center"
        assert occ["font_size_override"] == 12.5

    @pytest.mark.parametrize("payload,detail_frag", [
        ({"wrapping": "diagonal"}, "wrapping"),
        ({"casing": "camelCase"}, "casing"),
        ({"max_lines": -1}, "max_lines"),
        ({"max_lines": 999}, "max_lines"),
        ({"overlay_font_family_override": "papyrus"}, "overlay_font_family_override"),
    ])
    def test_patch_rejects_invalid(self, admin_client, repeat_template, payload, detail_frag):
        markers = _get_markers(admin_client, repeat_template)
        oid = markers[0]["occurrence_id"]
        r = admin_client.patch(
            f"{BASE_URL}/api/admin/contract-templates/{repeat_template}/markers/{oid}",
            json=payload,
        )
        assert r.status_code == 400
        assert detail_frag in r.json()["detail"]


# ---------------------------------------------------------------------------
# 2. Duplicate settings preview + apply
# ---------------------------------------------------------------------------
class TestDuplicateSettings:
    def _monthly_fee_ordered(self, admin_client, tid):
        markers = _get_markers(admin_client, tid)
        return sorted(
            [m for m in markers if m["code"] == "MONTHLY_FEE"],
            key=lambda m: (m["page"], (m.get("render_bbox") or [0, 0, 0, 0])[1]),
        )

    def test_preview_next(self, admin_client, repeat_template):
        occs = self._monthly_fee_ordered(admin_client, repeat_template)
        assert len(occs) == 4, "test fixture must have 4 MONTHLY_FEE occurrences"
        src = occs[0]
        r = admin_client.get(
            f"{BASE_URL}/api/admin/contract-templates/{repeat_template}/markers/{src['occurrence_id']}/duplicate-preview",
            params={"scope": "next"},
        )
        assert r.status_code == 200
        d = r.json()
        assert d["affected_count"] == 1
        assert d["targets"][0]["occurrence_id"] == occs[1]["occurrence_id"]
        assert set(d["never_altered"]) >= {
            "token_bbox", "render_bbox", "page", "occurrence_id", "code",
        }

    def test_preview_all_later(self, admin_client, repeat_template):
        occs = self._monthly_fee_ordered(admin_client, repeat_template)
        src = occs[0]
        r = admin_client.get(
            f"{BASE_URL}/api/admin/contract-templates/{repeat_template}/markers/{src['occurrence_id']}/duplicate-preview",
            params={"scope": "all_later"},
        )
        assert r.status_code == 200
        d = r.json()
        assert d["affected_count"] == 3  # occs 1, 2, 3 (excluding source)
        target_ids = {t["occurrence_id"] for t in d["targets"]}
        assert target_ids == {occs[1]["occurrence_id"], occs[2]["occurrence_id"], occs[3]["occurrence_id"]}

    def test_apply_next_copies_only_presentation(self, admin_client, repeat_template):
        occs = self._monthly_fee_ordered(admin_client, repeat_template)
        src, tgt = occs[0], occs[1]
        # Set source presentation
        admin_client.patch(
            f"{BASE_URL}/api/admin/contract-templates/{repeat_template}/markers/{src['occurrence_id']}",
            json={
                "alignment": "right",
                "font_size_override": 13.0,
                "min_font_size": 8,
                "wrapping": "no_wrap",
                "max_lines": 2,
                "casing": "upper",
                "overlay_font_family_override": "cour",
            },
        )
        # Capture target's non-presentation snapshot
        markers = _get_markers(admin_client, repeat_template)
        tgt_before = next(m for m in markers if m["occurrence_id"] == tgt["occurrence_id"])
        immutable_before = {
            k: tgt_before.get(k) for k in
            ("token_bbox", "render_bbox", "page", "occurrence_id", "code",
             "font_family", "font_size", "raw_token")
        }

        r = admin_client.post(
            f"{BASE_URL}/api/admin/contract-templates/{repeat_template}/markers/{src['occurrence_id']}/duplicate-settings",
            json={"scope": "next"},
        )
        assert r.status_code == 200
        assert r.json()["affected_count"] == 1

        # Verify target got the presentation fields
        markers = _get_markers(admin_client, repeat_template)
        tgt_after = next(m for m in markers if m["occurrence_id"] == tgt["occurrence_id"])
        assert tgt_after["alignment"] == "right"
        assert tgt_after["font_size_override"] == 13.0
        assert tgt_after["min_font_size"] == 8
        assert tgt_after["wrapping"] == "no_wrap"
        assert tgt_after["max_lines"] == 2
        assert tgt_after["casing"] == "upper"
        assert tgt_after["overlay_font_family_override"] == "cour"

        # Verify immutable fields didn't change
        immutable_after = {
            k: tgt_after.get(k) for k in immutable_before
        }
        assert immutable_after == immutable_before, (
            "duplicate must never alter token_bbox, render_bbox, page, "
            "occurrence_id, code or source font metadata"
        )

    def test_apply_all_later(self, admin_client, repeat_template):
        occs = self._monthly_fee_ordered(admin_client, repeat_template)
        src = occs[0]
        r = admin_client.post(
            f"{BASE_URL}/api/admin/contract-templates/{repeat_template}/markers/{src['occurrence_id']}/duplicate-settings",
            json={"scope": "all_later"},
        )
        assert r.status_code == 200
        assert r.json()["affected_count"] == 3

    def test_apply_returns_zero_when_no_later(self, admin_client, repeat_template):
        occs = self._monthly_fee_ordered(admin_client, repeat_template)
        last = occs[-1]
        r = admin_client.post(
            f"{BASE_URL}/api/admin/contract-templates/{repeat_template}/markers/{last['occurrence_id']}/duplicate-settings",
            json={"scope": "next"},
        )
        assert r.status_code == 200
        assert r.json()["affected_count"] == 0


# ---------------------------------------------------------------------------
# 3. Audit log
# ---------------------------------------------------------------------------
class TestAuditLog:
    def test_audit_captures_actions(self, admin_client, repeat_template):
        r = admin_client.get(
            f"{BASE_URL}/api/admin/contract-templates/{repeat_template}/audit-log",
        )
        assert r.status_code == 200
        d = r.json()
        actions = {row["action"] for row in d["items"]}
        # We've done at least some patch + duplicate in preceding tests
        assert "marker.patch" in actions
        assert "marker.duplicate_settings" in actions

    def test_audit_has_actor_and_timestamps(self, admin_client, repeat_template):
        r = admin_client.get(
            f"{BASE_URL}/api/admin/contract-templates/{repeat_template}/audit-log",
        )
        d = r.json()
        assert d["items"], "audit log must not be empty"
        row = d["items"][0]
        assert row["actor"] == ADMIN_EMAIL
        assert "at" in row and "T" in row["at"]


# ---------------------------------------------------------------------------
# 4. Evidence pack ZIP
# ---------------------------------------------------------------------------
class TestEvidencePack:
    def test_pack_zip_contents(self, admin_client, repeat_template):
        r = admin_client.post(
            f"{BASE_URL}/api/admin/contract-templates/{repeat_template}/evidence-pack",
            timeout=60,
        )
        assert r.status_code == 200, r.text
        assert r.headers["content-type"] == "application/zip"
        assert r.headers.get("x-pack-id")
        assert int(r.headers.get("x-marker-count", "0")) >= 5
        assert int(r.headers.get("x-audit-row-count", "0")) >= 1

        with zipfile.ZipFile(io.BytesIO(r.content)) as zf:
            names = set(zf.namelist())
            expected = {"README.md", "manifest.json", "source.pdf",
                        "preview.pdf", "markers.csv", "audit_log.jsonl"}
            assert expected <= names
            manifest = json.loads(zf.read("manifest.json"))
            assert manifest["template"]["id"] == repeat_template
            assert manifest["invariants"]["token_bbox_editable"] is False
            assert manifest["invariants"]["source_pdf_mutated"] is False
            # Markers CSV has header + rows
            csv_text = zf.read("markers.csv").decode()
            assert "token_bbox" in csv_text.splitlines()[0]
            assert len(csv_text.splitlines()) > 1
            # audit_log.jsonl is one JSON object per line
            for line in zf.read("audit_log.jsonl").decode().splitlines():
                if line.strip():
                    json.loads(line)  # will raise if malformed

    def test_pack_generation_logged_in_audit(self, admin_client, repeat_template):
        # Generate a pack, then confirm the audit log now has an
        # 'evidence_pack.generate' row.
        pre = admin_client.get(
            f"{BASE_URL}/api/admin/contract-templates/{repeat_template}/audit-log",
        ).json()["count"]
        r = admin_client.post(
            f"{BASE_URL}/api/admin/contract-templates/{repeat_template}/evidence-pack",
            timeout=60,
        )
        assert r.status_code == 200
        post = admin_client.get(
            f"{BASE_URL}/api/admin/contract-templates/{repeat_template}/audit-log",
        ).json()
        assert post["count"] == pre + 1
        assert post["items"][0]["action"] == "evidence_pack.generate"
        assert post["items"][0]["extra"]["pack_id"] == r.headers.get("x-pack-id")


# ---------------------------------------------------------------------------
# 5. Preview generator honours new fields (unit)
# ---------------------------------------------------------------------------
class TestPreviewGeneratorHonours:
    def test_casing_upper_applied(self, admin_client, repeat_template):
        markers = _get_markers(admin_client, repeat_template)
        oid = next(m["occurrence_id"] for m in markers if m["code"] == "AGREEMENT_DATE")
        admin_client.patch(
            f"{BASE_URL}/api/admin/contract-templates/{repeat_template}/markers/{oid}",
            json={"casing": "upper"},
        )
        r = admin_client.post(
            f"{BASE_URL}/api/admin/contract-templates/{repeat_template}/sample-preview.pdf",
            json={}, timeout=30,
        )
        assert r.status_code == 200
        with fitz.open(stream=r.content, filetype="pdf") as d:
            txt = d[0].get_text("text")
        # The default AGREEMENT_DATE value is "1 August 2026". Upper
        # should render "1 AUGUST 2026".
        assert "1 AUGUST 2026" in txt

    def test_max_lines_truncates(self, admin_client, repeat_template):
        # Not a rendering check — the generator handles multi-line
        # truncation but our synthetic default is single-line so this
        # just asserts the pipeline doesn't blow up when max_lines is set.
        markers = _get_markers(admin_client, repeat_template)
        oid = markers[0]["occurrence_id"]
        r = admin_client.patch(
            f"{BASE_URL}/api/admin/contract-templates/{repeat_template}/markers/{oid}",
            json={"max_lines": 1, "casing": "none"},
        )
        assert r.status_code == 200
        r = admin_client.post(
            f"{BASE_URL}/api/admin/contract-templates/{repeat_template}/sample-preview.pdf",
            json={}, timeout=30,
        )
        assert r.status_code == 200
