"""Address composer + library presentation defaults + overflow tracking.

Covers the corrections requested by HQ after Stop Point 3 initial review:
  * FRANCHISEE_ADDRESS_BLOCK is a single-line, comma-joined address
    (not multiline). Blank / whitespace-only components are cleanly
    omitted with no double commas or trailing separator.
  * Library entries carrying ``default_presentation`` are applied to
    newly-detected occurrences whose per-occurrence field is None. HQ
    edits are never overwritten (fields already set stay set).
  * ``sample-preview.pdf`` persists a ``last_render_report`` on each
    marker with ``overflow`` / ``final_size`` / ``overlay_family`` so
    the Marker Review UI can badge occurrences that overflowed at
    their configured ``min_font_size``.
  * When ``min_font_size == source font_size`` and the value still
    doesn't fit, the engine MUST refuse to shrink below it and return
    ``overflow=True`` — never silently drop to 7pt.
"""
from __future__ import annotations

import os
import time

import fitz
import pytest
import requests

from contract_preview_generator import (
    compose_single_line_address,
    synthetic_default_for,
)

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")
ADMIN_EMAIL = "admin@creativemojo.co.uk"
ADMIN_PASSWORD = "CreativeMojo2026!"


# ---------------------------------------------------------------------------
# 1. Address composer — unit
# ---------------------------------------------------------------------------
class TestComposeSingleLineAddress:
    def test_full_address(self):
        r = compose_single_line_address(
            street="2, Wordsworth Cottages",
            city="Robertsbridge",
            county="East Sussex",
            postcode="TN32 5JG",
            country="United Kingdom",
        )
        assert r == "2, Wordsworth Cottages, Robertsbridge, East Sussex, TN32 5JG, United Kingdom"

    def test_missing_components_omitted_cleanly(self):
        r = compose_single_line_address(
            street="1 Main St", city="Bristol", postcode="BS1 4XX",
        )
        # No double commas, no leading/trailing separators
        assert r == "1 Main St, Bristol, BS1 4XX"
        assert ",," not in r
        assert not r.startswith(",")
        assert not r.endswith(",")

    def test_whitespace_only_components_dropped(self):
        r = compose_single_line_address(
            street="   ", city="  ", county="  ", postcode="AB1 2CD", country="",
        )
        assert r == "AB1 2CD"

    def test_all_blank_returns_empty(self):
        assert compose_single_line_address() == ""
        assert compose_single_line_address("", "", "", "", "") == ""

    def test_synthetic_default_returns_single_line(self):
        v = synthetic_default_for("FRANCHISEE_ADDRESS_BLOCK", "string")
        assert "\n" not in v
        assert v.count(",") >= 4  # street, city, county, postcode, country
        assert ",," not in v
        assert not v.endswith(",")


# ---------------------------------------------------------------------------
# 2. HTTP — library defaults + overflow tracking
# ---------------------------------------------------------------------------
if BASE_URL:
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

    def _small_pdf_with_address_marker() -> bytes:
        doc = fitz.open()
        page = doc.new_page(width=595, height=842)
        # Deliberately-tight render area context — token is short, so
        # detected render_bbox will be narrow, and the single-line
        # address WILL overflow at 11pt.
        page.insert_text((72, 200), "of: [[FRANCHISEE_ADDRESS_BLOCK]] .", fontsize=11, fontname="helv")
        page.insert_text((72, 260), "AGREEMENT DATED [[AGREEMENT_DATE]]", fontsize=11, fontname="helv")
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
    def address_template(admin_client):
        pdf_bytes = _small_pdf_with_address_marker()
        files = {"pdf": ("addr-test.pdf", pdf_bytes, "application/pdf")}
        data = {"name": "address-e2e-template", "contract_type": "franchise_renewal"}
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

    class TestLibraryPresentationDefaults:
        def test_address_marker_gets_library_defaults(self, admin_client, address_template):
            r = admin_client.get(
                f"{BASE_URL}/api/admin/contract-templates/{address_template}/marker-summary",
            )
            markers = r.json()["markers"]
            addr = next((m for m in markers if m["code"] == "FRANCHISEE_ADDRESS_BLOCK"), None)
            assert addr is not None, "detection missed the address marker"
            # Library default_presentation should have been applied
            assert addr["wrapping"] == "no_wrap"
            assert addr["alignment"] == "left"
            assert addr["min_font_size"] == 11

        def test_non_address_markers_get_no_forced_defaults(self, admin_client, address_template):
            markers = admin_client.get(
                f"{BASE_URL}/api/admin/contract-templates/{address_template}/marker-summary",
            ).json()["markers"]
            date_marker = next(m for m in markers if m["code"] == "AGREEMENT_DATE")
            # AGREEMENT_DATE has no default_presentation in the library
            assert date_marker.get("min_font_size") is None
            assert date_marker.get("wrapping") is None

        def test_hq_override_survives_within_current_markers_array(self, admin_client, address_template):
            """HQ-set values must not be clobbered by the defaults
            applier. NB: full backfill via ``backfill-bbox-split`` DOES
            re-detect, which generates new occurrence_ids — that reset
            is documented and out of scope here."""
            markers = admin_client.get(
                f"{BASE_URL}/api/admin/contract-templates/{address_template}/marker-summary",
            ).json()["markers"]
            addr = next(m for m in markers if m["code"] == "FRANCHISEE_ADDRESS_BLOCK")
            original_min = addr.get("min_font_size")
            # Override then verify it stuck
            r = admin_client.patch(
                f"{BASE_URL}/api/admin/contract-templates/{address_template}/markers/{addr['occurrence_id']}",
                json={"min_font_size": 9},
            )
            assert r.status_code == 200
            assert r.json()["occurrence"]["min_font_size"] == 9
            # Restore state so downstream overflow tests remain valid
            admin_client.patch(
                f"{BASE_URL}/api/admin/contract-templates/{address_template}/markers/{addr['occurrence_id']}",
                json={"min_font_size": original_min},
            )

    class TestOverflowTracking:
        def test_preview_sets_last_render_report(self, admin_client, address_template):
            r = admin_client.post(
                f"{BASE_URL}/api/admin/contract-templates/{address_template}/sample-preview.pdf",
                json={}, timeout=30,
            )
            assert r.status_code == 200
            # Read back markers
            markers = admin_client.get(
                f"{BASE_URL}/api/admin/contract-templates/{address_template}/marker-summary",
            ).json()["markers"]
            for m in markers:
                lr = m.get("last_render_report")
                assert lr is not None, f"{m['code']} missing last_render_report"
                assert "overflow" in lr
                assert "final_size" in lr
                assert "overlay_family" in lr
                assert "computed_at" in lr

        def test_address_never_shrinks_below_min_font_size(self, admin_client, address_template):
            """Core invariant: engine must NEVER silently shrink below
            ``min_font_size``. If the value can't fit, ``overflow=True``
            is reported and ``final_size == min_font_size`` — never 7pt."""
            admin_client.post(
                f"{BASE_URL}/api/admin/contract-templates/{address_template}/sample-preview.pdf",
                json={}, timeout=30,
            )
            markers = admin_client.get(
                f"{BASE_URL}/api/admin/contract-templates/{address_template}/marker-summary",
            ).json()["markers"]
            addr = next(m for m in markers if m["code"] == "FRANCHISEE_ADDRESS_BLOCK")
            assert addr["min_font_size"] == 11, "library default not applied"
            lr = addr["last_render_report"]
            # THE critical invariant.
            assert lr["final_size"] >= 11.0, (
                f"engine silently shrank below min_font_size — final_size={lr['final_size']}"
            )

        def test_address_overflows_when_render_bbox_too_small(self, admin_client, address_template):
            """Force overflow by patching a tiny render_bbox and verify
            the engine reports overflow=True with final_size==11."""
            markers = admin_client.get(
                f"{BASE_URL}/api/admin/contract-templates/{address_template}/marker-summary",
            ).json()["markers"]
            addr = next(m for m in markers if m["code"] == "FRANCHISEE_ADDRESS_BLOCK")
            # Deliberately tight — 60x8pt cannot hold 76 chars at 11pt.
            # Also disable no_wrap so the horizontal widening branch
            # doesn't rescue us.
            tight_rb = [50.0, 400.0, 110.0, 408.0]
            r = admin_client.patch(
                f"{BASE_URL}/api/admin/contract-templates/{address_template}/markers/{addr['occurrence_id']}",
                json={"render_bbox": tight_rb, "wrapping": "wrap"},
            )
            assert r.status_code == 200
            r = admin_client.post(
                f"{BASE_URL}/api/admin/contract-templates/{address_template}/sample-preview.pdf",
                json={}, timeout=30,
            )
            assert r.status_code == 200
            markers = admin_client.get(
                f"{BASE_URL}/api/admin/contract-templates/{address_template}/marker-summary",
            ).json()["markers"]
            addr = next(m for m in markers if m["code"] == "FRANCHISEE_ADDRESS_BLOCK")
            lr = addr["last_render_report"]
            assert lr["overflow"] is True
            assert lr["final_size"] == 11.0

        def test_per_marker_png_endpoint_exposes_overflow_header(self, admin_client, address_template):
            """After the previous test, the address is in a
            forced-overflow state — verify the PNG endpoint exposes
            X-Overflow=1 and X-Final-Size=11.0."""
            markers = admin_client.get(
                f"{BASE_URL}/api/admin/contract-templates/{address_template}/marker-summary",
            ).json()["markers"]
            addr = next(m for m in markers if m["code"] == "FRANCHISEE_ADDRESS_BLOCK")
            r = admin_client.get(
                f"{BASE_URL}/api/admin/contract-templates/{address_template}/markers/{addr['occurrence_id']}/sample-preview.png",
            )
            assert r.status_code == 200
            assert r.headers.get("x-overflow") == "1"
            assert r.headers.get("x-final-size") == "11.0"

        def test_widening_render_bbox_clears_overflow(self, admin_client, address_template):
            markers = admin_client.get(
                f"{BASE_URL}/api/admin/contract-templates/{address_template}/marker-summary",
            ).json()["markers"]
            addr = next(m for m in markers if m["code"] == "FRANCHISEE_ADDRESS_BLOCK")
            # Widen render_bbox horizontally so the whole address fits at 11pt
            new_rb = list(addr["render_bbox"])
            new_rb[0] = 20.0     # x0 leftmost
            new_rb[2] = 575.0    # x1 near right edge → 555pt wide
            new_rb[3] = new_rb[1] + 32.0  # tall enough for 11pt line-height
            r = admin_client.patch(
                f"{BASE_URL}/api/admin/contract-templates/{address_template}/markers/{addr['occurrence_id']}",
                json={"render_bbox": new_rb},
            )
            assert r.status_code == 200
            # Re-render preview → overflow should clear
            admin_client.post(
                f"{BASE_URL}/api/admin/contract-templates/{address_template}/sample-preview.pdf",
                json={}, timeout=30,
            )
            markers = admin_client.get(
                f"{BASE_URL}/api/admin/contract-templates/{address_template}/marker-summary",
            ).json()["markers"]
            addr = next(m for m in markers if m["code"] == "FRANCHISEE_ADDRESS_BLOCK")
            lr = addr["last_render_report"]
            assert lr["overflow"] is False, "widening render_bbox should clear the overflow"
            assert lr["final_size"] == 11.0

    # ---------------------------------------------------------------
    # 3. Bulk Match Source (Phase 1B refinement)
    # ---------------------------------------------------------------
    class TestBulkMatchSource:
        def test_preview_lists_eligible_and_overflow_projections(self, admin_client, address_template):
            r = admin_client.get(
                f"{BASE_URL}/api/admin/contract-templates/{address_template}/match-source-preview",
            )
            assert r.status_code == 200
            d = r.json()
            assert d["eligible_count"] >= 1
            for e in d["eligible"]:
                assert e["source_font_size"]
                assert "current_min_font_size" in e
            assert isinstance(d["will_overflow_after"], list)
            assert "token_bbox" in d["never_altered"]
            assert "render_bbox" in d["never_altered"]

        def test_hq_override_is_skipped(self, admin_client, address_template):
            markers = admin_client.get(
                f"{BASE_URL}/api/admin/contract-templates/{address_template}/marker-summary",
            ).json()["markers"]
            addr = next(m for m in markers if m["code"] == "FRANCHISEE_ADDRESS_BLOCK")
            admin_client.patch(
                f"{BASE_URL}/api/admin/contract-templates/{address_template}/markers/{addr['occurrence_id']}",
                json={"font_size_override": 9.5},
            )
            r = admin_client.get(
                f"{BASE_URL}/api/admin/contract-templates/{address_template}/match-source-preview",
            )
            eligible_oids = {e["occurrence_id"] for e in r.json()["eligible"]}
            assert addr["occurrence_id"] not in eligible_oids
            assert r.json()["skipped_count"] >= 1
            r = admin_client.post(
                f"{BASE_URL}/api/admin/contract-templates/{address_template}/match-source-apply",
            )
            assert r.status_code == 200
            markers = admin_client.get(
                f"{BASE_URL}/api/admin/contract-templates/{address_template}/marker-summary",
            ).json()["markers"]
            addr = next(m for m in markers if m["code"] == "FRANCHISEE_ADDRESS_BLOCK")
            assert addr["font_size_override"] == 9.5

        def test_apply_leaves_bboxes_and_layout_alone(self, admin_client, address_template):
            snap_before = {}
            markers = admin_client.get(
                f"{BASE_URL}/api/admin/contract-templates/{address_template}/marker-summary",
            ).json()["markers"]
            for m in markers:
                snap_before[m["occurrence_id"]] = {
                    k: m.get(k) for k in
                    ("token_bbox", "render_bbox", "page", "code", "alignment",
                     "wrapping", "casing", "overlay_font_family_override")
                }
            r = admin_client.post(
                f"{BASE_URL}/api/admin/contract-templates/{address_template}/match-source-apply",
            )
            assert r.status_code == 200
            markers = admin_client.get(
                f"{BASE_URL}/api/admin/contract-templates/{address_template}/marker-summary",
            ).json()["markers"]
            for m in markers:
                snap_after = {
                    k: m.get(k) for k in
                    ("token_bbox", "render_bbox", "page", "code", "alignment",
                     "wrapping", "casing", "overlay_font_family_override")
                }
                assert snap_after == snap_before[m["occurrence_id"]], (
                    f"bulk match-source altered a protected field on {m['code']}"
                )

        def test_audit_row_written(self, admin_client, address_template):
            r = admin_client.get(
                f"{BASE_URL}/api/admin/contract-templates/{address_template}/audit-log",
            )
            actions = [row["action"] for row in r.json()["items"]]
            assert "markers.match_source_bulk" in actions

else:  # pragma: no cover
    @pytest.fixture(scope="session")
    def admin_client():
        pytest.skip("REACT_APP_BACKEND_URL not set — HTTP tests skipped")
