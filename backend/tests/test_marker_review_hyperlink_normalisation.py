"""Regression: Marker Review must not crash on hyperlink-shaped sample values.

The synthetic default for ``TERRITORY_MAP_URL`` is an object literal
``{url, display}`` (see ``contract_preview_generator.synthetic_default_for``).
The frontend Marker Review component previously interpolated
``marker.sample_value`` straight into JSX children, which throws
"Objects are not valid as a React child" whenever a template contains a
TERRITORY_MAP_URL occurrence and the user navigates to its page (Paloma's
5-page-per-turn renewal template puts the marker on page 29 → this
crashed the modal as HQ paged through to page 30).

This test locks the contract in two places:

  1. **Backend contract** — the ``marker-summary`` API returns
     ``sample_value`` as the ``{url, display}`` object shape for
     hyperlink markers. The frontend MUST tolerate this.
  2. **Frontend fix** — ``MarkerReviewModal.jsx`` exports
     ``normaliseMarkerDisplayValue`` and uses it for every marker-value
     render site, so the object never lands in JSX children.
"""
from __future__ import annotations

import os
import re
import time
from pathlib import Path

import fitz
import pytest
import requests


BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")
ADMIN_EMAIL = "admin@creativemojo.co.uk"
ADMIN_PASSWORD = "CreativeMojo2026!"


def _login():
    s = requests.Session()
    r = s.post(f"{BASE_URL}/api/auth/login",
               json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
               timeout=15)
    r.raise_for_status()
    tok = r.json().get("token") or r.json().get("access_token")
    s.headers.update({"Authorization": f"Bearer {tok}"})
    return s


@pytest.fixture(scope="module")
def admin():
    return _login()


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
def template_with_territory_url(admin):
    """Build a fresh 30-page PDF where the TERRITORY_MAP_URL marker
    lives on page 30 — mirrors the Paloma renewal template that
    triggered the crash. Returns the template id."""
    doc = fitz.open()
    for i in range(30):
        p = doc.new_page(width=595, height=842)
        if i == 0:
            p.insert_text((72, 100), "[[AGREEMENT_DATE]]", fontsize=11, fontname="helv")
        if i == 29:
            # signing / territory page — matches the Paloma layout
            p.insert_text((72, 100), "Signing page.", fontsize=11, fontname="helv")
            p.insert_text((72, 500), "Agreed territory:", fontsize=11, fontname="helv")
            p.insert_text((72, 520), "[[TERRITORY_MAP_URL]]", fontsize=11, fontname="helv")
    pdf_bytes = doc.tobytes()
    doc.close()

    files = {"pdf": (f"mr-regression-{int(time.time())}.pdf", pdf_bytes, "application/pdf")}
    data = {"name": f"mr-regression-territory-{int(time.time())}", "contract_type": "other"}
    r = admin.post(
        f"{BASE_URL}/api/admin/contract-templates/upload-marker-pdf",
        files=files, data=data, timeout=30,
    )
    r.raise_for_status()
    job = _wait_job(admin, r.json()["job_id"])
    assert job["status"] == "complete", job
    return job["template_id"]


class TestMarkerSummaryContract:
    """Backend contract — marker-summary returns the object shape for
    hyperlink markers. The frontend MUST handle this without crashing."""

    def test_marker_summary_returns_hyperlink_object_shape(
        self, admin, template_with_territory_url,
    ):
        tid = template_with_territory_url
        r = admin.get(
            f"{BASE_URL}/api/admin/contract-templates/{tid}/marker-summary",
            timeout=15,
        )
        assert r.status_code == 200, r.text
        summary = r.json()
        # Find the TERRITORY_MAP_URL occurrence on page 30
        markers = summary.get("markers") or summary.get("occurrences") or []
        territory_occs = [m for m in markers if m.get("code") == "TERRITORY_MAP_URL"]
        assert territory_occs, "TERRITORY_MAP_URL should be detected on page 30"
        occ = territory_occs[0]
        assert occ["page"] == 30
        sv = occ.get("sample_value")
        # This is the shape the frontend must tolerate.
        assert isinstance(sv, dict), (
            f"sample_value should be an object for hyperlink markers, "
            f"got {type(sv).__name__}: {sv!r}"
        )
        assert isinstance(sv.get("display"), str) and sv["display"]
        assert isinstance(sv.get("url"), str) and sv["url"]

    def test_string_markers_still_return_strings(
        self, admin, template_with_territory_url,
    ):
        tid = template_with_territory_url
        r = admin.get(
            f"{BASE_URL}/api/admin/contract-templates/{tid}/marker-summary",
            timeout=15,
        )
        markers = r.json().get("markers") or r.json().get("occurrences") or []
        agreement = [m for m in markers if m.get("code") == "AGREEMENT_DATE"]
        assert agreement, "AGREEMENT_DATE should be detected"
        sv = agreement[0].get("sample_value")
        assert isinstance(sv, str), (
            f"AGREEMENT_DATE sample_value should be a plain string, got {sv!r}"
        )


class TestFrontendNormaliserWired:
    """Frontend fix — MarkerReviewModal.jsx exports the normaliser and
    uses it at the marker-value render site. Guards against a future
    refactor that reintroduces the crash."""

    @pytest.fixture(scope="class")
    def source(self):
        return Path("/app/frontend/src/pages/MarkerReviewModal.jsx").read_text()

    def test_normaliser_is_exported(self, source):
        assert "export function normaliseMarkerDisplayValue" in source, (
            "MarkerReviewModal.jsx must export normaliseMarkerDisplayValue"
        )

    def test_normaliser_handles_hyperlink_object_shape(self, source):
        # Guard the exact branch that returns display for {url, display}
        assert re.search(
            r"typeof\s+v\.display\s*===\s*[\"']string[\"']", source,
        ), "Normaliser must check v.display for hyperlink markers"
        assert re.search(
            r"typeof\s+v\.url\s*===\s*[\"']string[\"']", source,
        ), "Normaliser must check v.url as fallback"

    def test_normaliser_handles_null_and_undefined(self, source):
        # Both null and undefined must be handled without crashing.
        assert re.search(
            r"v\s*===\s*null\s*\|\|\s*v\s*===\s*undefined", source,
        ), "Normaliser must handle null/undefined explicitly"

    def test_marker_box_uses_normaliser(self, source):
        # The critical fix — MarkerBox's value line must go through the
        # normaliser before hitting JSX children.
        pattern = re.compile(
            r"normaliseMarkerDisplayValue\(\s*marker\.sample_value\s*\)",
        )
        assert pattern.search(source), (
            "MarkerBox must call normaliseMarkerDisplayValue(marker.sample_value) "
            "before rendering"
        )

    def test_apply_casing_defends_against_non_strings(self, source):
        # Belt-and-braces — applyCasingClientSide should coerce
        # non-strings via the normaliser rather than blowing up on
        # .toUpperCase().
        block = re.search(
            r"function applyCasingClientSide.*?\n\}", source, re.DOTALL,
        )
        assert block, "applyCasingClientSide must exist"
        assert "typeof value !== \"string\"" in block.group(0), (
            "applyCasingClientSide should defend against non-string values"
        )
