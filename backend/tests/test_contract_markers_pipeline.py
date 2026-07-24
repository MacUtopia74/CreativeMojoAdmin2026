"""Pytest suite for the deterministic marker detection engine.

Covers every scenario the user called out in amendment #8 + amendment
#13 completion tests: happy path, cross-line detection, inline-in-
sentence markers, repeat markers, unrecognised markers, source-PDF
preservation, SHA-256 verification.
"""
from __future__ import annotations

import hashlib
import io

import fitz  # PyMuPDF
import pytest

import contract_markers_pipeline as p
from contract_markers_library import SEED_MARKERS


# ---------------------------------------------------------------------------
# Test-PDF builders
# ---------------------------------------------------------------------------
def _make_pdf(pages_text: list) -> bytes:
    """Each item in pages_text is a list of (x, y, text, fontsize) tuples."""
    doc = fitz.open()
    for page_lines in pages_text:
        page = doc.new_page()
        for x, y, text, size in page_lines:
            page.insert_text((x, y), text, fontsize=size, fontname="helv")
    b = doc.tobytes()
    doc.close()
    return b


def _lib_docs_from_seed():
    """Build a mock library from the approved seed (buckets A+B+C)."""
    return [
        {**m, "hidden": False, "id": f"seed-{i}"}
        for i, m in enumerate(SEED_MARKERS)
    ]


# ---------------------------------------------------------------------------
# 1. Happy path
# ---------------------------------------------------------------------------
class TestHappyPath:
    def test_detects_all_seeded_markers(self):
        pdf = _make_pdf([
            [
                (72, 100, "Between [[FRANCHISEE_LEGAL_NAME]]", 11),
                (72, 120, "Address: [[FRANCHISEE_ADDRESS_BLOCK]]", 11),
                (72, 160, "Franchise no. [[FRANCHISE_NUMBER]]", 11),
                (72, 180, "Contract term: [[CONTRACT_TERM_YEARS]] years", 11),
                (72, 200, "Monthly fee: [[MONTHLY_FEE]]", 11),
            ],
        ])
        det = p.detect_markers(pdf)
        codes = [m.code for m in det.markers]
        assert "FRANCHISEE_LEGAL_NAME" in codes
        assert "FRANCHISEE_ADDRESS_BLOCK" in codes
        assert "FRANCHISE_NUMBER" in codes
        assert "CONTRACT_TERM_YEARS" in codes
        assert "MONTHLY_FEE" in codes
        assert det.cross_line_errors == []
        assert det.pdf_page_count == 1
        # bbox sanity — width > 0, height > 0
        for m in det.markers:
            x0, y0, x1, y1 = m.bbox
            assert x1 > x0 and y1 > y0

    def test_font_metadata_captured(self):
        pdf = _make_pdf([[(72, 100, "[[FRANCHISEE_EMAIL]]", 12)]])
        det = p.detect_markers(pdf)
        assert len(det.markers) == 1
        m = det.markers[0]
        assert m.font_size == 12.0
        assert m.font_family in ("Helvetica", "helv")
        assert m.substitution_family == "Helvetica"


# ---------------------------------------------------------------------------
# 2. Inline-in-sentence markers (amendment #8 requirement)
# ---------------------------------------------------------------------------
class TestInlineInSentence:
    def test_marker_inside_sentence(self):
        pdf = _make_pdf([
            [(72, 100, "This Agreement is made on [[AGREEMENT_DATE]].", 11)],
        ])
        det = p.detect_markers(pdf)
        codes = [m.code for m in det.markers]
        assert codes == ["AGREEMENT_DATE"]
        assert det.cross_line_errors == []

    def test_two_markers_in_one_sentence(self):
        pdf = _make_pdf([
            [(72, 100, "Between [[FRANCHISEE_FIRST_NAME]] and Creative Mojo dated [[AGREEMENT_DATE]].", 11)],
        ])
        det = p.detect_markers(pdf)
        codes = sorted(m.code for m in det.markers)
        assert codes == ["AGREEMENT_DATE", "FRANCHISEE_FIRST_NAME"]

    def test_marker_at_end_of_line(self):
        pdf = _make_pdf([[(72, 100, "Contract Reference: [[CONTRACT_REFERENCE]]", 11)]])
        det = p.detect_markers(pdf)
        assert [m.code for m in det.markers] == ["CONTRACT_REFERENCE"]

    def test_marker_at_start_of_line(self):
        pdf = _make_pdf([[(72, 100, "[[FRANCHISEE_LEGAL_NAME]] agrees to the following terms.", 11)]])
        det = p.detect_markers(pdf)
        assert [m.code for m in det.markers] == ["FRANCHISEE_LEGAL_NAME"]


# ---------------------------------------------------------------------------
# 3. Repeat markers (amendment #7)
# ---------------------------------------------------------------------------
class TestRepeatMarkers:
    def test_repeat_marker_recorded_independently(self):
        pdf = _make_pdf([
            [(72, 100, "Cover: [[FRANCHISEE_LEGAL_NAME]]", 11)],
            [(72, 100, "Signature page: [[FRANCHISEE_LEGAL_NAME]]", 11)],
        ])
        det = p.detect_markers(pdf)
        assert len(det.markers) == 2
        assert det.markers[0].page == 1
        assert det.markers[1].page == 2

    def test_repeat_allowed_marker_is_not_offender(self):
        pdf = _make_pdf([
            [(72, 100, "Ref [[CONTRACT_REFERENCE]]", 11)],
            [(72, 100, "Ref again [[CONTRACT_REFERENCE]]", 11)],
        ])
        det = p.detect_markers(pdf)
        summary = p.build_marker_summary(
            det.markers, det.cross_line_errors, _lib_docs_from_seed(),
            contract_type="franchise_renewal", template_required_codes=[]
        )
        assert summary["counts_by_code"]["CONTRACT_REFERENCE"] == 2
        assert summary["duplicate_offenders"] == []

    def test_repeat_not_allowed_marker_is_flagged(self):
        pdf = _make_pdf([
            [(72, 100, "Terms: [[SPECIAL_TERMS]]", 11)],
            [(72, 100, "More terms: [[SPECIAL_TERMS]]", 11)],
        ])
        det = p.detect_markers(pdf)
        summary = p.build_marker_summary(
            det.markers, det.cross_line_errors, _lib_docs_from_seed(),
            contract_type="franchise_renewal", template_required_codes=[]
        )
        # SPECIAL_TERMS in seed has repeat_allowed=False
        assert {"code": "SPECIAL_TERMS", "count": 2} in summary["duplicate_offenders"]


# ---------------------------------------------------------------------------
# 4. Unrecognised marker (amendment #2)
# ---------------------------------------------------------------------------
class TestUnrecognised:
    def test_unknown_marker_surfaced(self):
        pdf = _make_pdf([[(72, 100, "Weather: [[WEATHER_OUTSIDE]]", 11)]])
        det = p.detect_markers(pdf)
        summary = p.build_marker_summary(
            det.markers, det.cross_line_errors, _lib_docs_from_seed(),
            contract_type="franchise_renewal", template_required_codes=[]
        )
        assert "WEATHER_OUTSIDE" in summary["unrecognised"]
        assert summary["ready_for_approval"] is False


# ---------------------------------------------------------------------------
# 5. Cross-line / orphan-bracket detection (amendment #13)
# ---------------------------------------------------------------------------
class TestCrossLine:
    def test_unterminated_open_bracket_is_flagged(self):
        pdf = _make_pdf([
            [
                (72, 100, "This starts a marker [[FRANCHISEE_LEGAL", 11),
                (72, 120, "NAME]] but the closing lives on the next line.", 11),
            ],
        ])
        det = p.detect_markers(pdf)
        # No regex hit — but a cross-line error surfaces
        assert not any(m.code == "FRANCHISEE_LEGAL" for m in det.markers)
        assert any(err["kind"] == "unterminated_open_bracket" for err in det.cross_line_errors)
        assert any(err["kind"] == "orphan_close_bracket" for err in det.cross_line_errors)

    def test_orphan_close_bracket(self):
        pdf = _make_pdf([[(72, 100, "This closes ]] without opening.", 11)]])
        det = p.detect_markers(pdf)
        assert any(err["kind"] == "orphan_close_bracket" for err in det.cross_line_errors)

    def test_no_false_positives_in_normal_text(self):
        pdf = _make_pdf([[(72, 100, "This uses brackets [not] like this [x][y] but no markers.", 11)]])
        det = p.detect_markers(pdf)
        assert det.markers == []
        assert det.cross_line_errors == []


# ---------------------------------------------------------------------------
# 6. Source-PDF preservation + SHA-256
# ---------------------------------------------------------------------------
class TestSourcePreservation:
    def test_detection_does_not_mutate_input(self):
        pdf = _make_pdf([[(72, 100, "[[FRANCHISEE_LEGAL_NAME]]", 11)]])
        expected = hashlib.sha256(pdf).hexdigest()
        _ = p.detect_markers(pdf)
        # `pdf` variable is the same bytes object — its hash is unchanged
        assert hashlib.sha256(pdf).hexdigest() == expected

    def test_sha256_in_result_matches_input(self):
        pdf = _make_pdf([[(72, 100, "hello", 11)]])
        det = p.detect_markers(pdf)
        assert det.pdf_sha256 == hashlib.sha256(pdf).hexdigest()


# ---------------------------------------------------------------------------
# 7. Storage-shape helpers
# ---------------------------------------------------------------------------
class TestStorageShape:
    def test_occurrences_for_storage_is_json_safe(self):
        pdf = _make_pdf([[(72, 100, "[[FRANCHISEE_LEGAL_NAME]]", 11)]])
        det = p.detect_markers(pdf)
        rows = p.occurrences_for_storage(det.markers)
        import json
        s = json.dumps(rows)  # must not raise
        parsed = json.loads(s)
        assert parsed[0]["code"] == "FRANCHISEE_LEGAL_NAME"
        assert len(parsed[0]["bbox"]) == 4


# ---------------------------------------------------------------------------
# 8. Not-eligible-for-type filter (amendment #2)
# ---------------------------------------------------------------------------
class TestEligibility:
    def test_marker_excluded_from_type_is_not_recognised(self):
        pdf = _make_pdf([[(72, 100, "[[FRANCHISEE_LEGAL_NAME]]", 11)]])
        det = p.detect_markers(pdf)
        # Build a library where FRANCHISEE_LEGAL_NAME is only eligible for
        # 'new_franchise', but we're validating a 'territory_amendment'.
        lib = [{
            "code": "FRANCHISEE_LEGAL_NAME",
            "hidden": False,
            "eligible_contract_types": ["new_franchise"],
            "repeat_allowed": True,
        }]
        summary = p.build_marker_summary(
            det.markers, det.cross_line_errors, lib,
            contract_type="territory_amendment", template_required_codes=[]
        )
        assert "FRANCHISEE_LEGAL_NAME" in summary["not_eligible_for_type"]
        assert "FRANCHISEE_LEGAL_NAME" not in summary["recognised"]


# ---------------------------------------------------------------------------
# 9. Template-required-missing (amendment #2)
# ---------------------------------------------------------------------------
class TestTemplateRequiredMissing:
    def test_required_marker_absent_from_pdf_is_flagged(self):
        pdf = _make_pdf([[(72, 100, "This template has no markers.", 11)]])
        det = p.detect_markers(pdf)
        lib = [{
            "code": "FRANCHISEE_LEGAL_NAME",
            "hidden": False,
            "eligible_contract_types": ["franchise_renewal"],
            "repeat_allowed": True,
        }]
        summary = p.build_marker_summary(
            det.markers, det.cross_line_errors, lib,
            contract_type="franchise_renewal",
            template_required_codes=["FRANCHISEE_LEGAL_NAME"],
        )
        assert "FRANCHISEE_LEGAL_NAME" in summary["template_required_missing"]
        assert summary["ready_for_approval"] is False


# ---------------------------------------------------------------------------
# 10. Ready-for-approval flag is TRUE only when everything is clean
# ---------------------------------------------------------------------------
class TestReadyForApproval:
    def test_ready_true_when_all_clean(self):
        pdf = _make_pdf([[(72, 100, "[[FRANCHISEE_LEGAL_NAME]]", 11)]])
        det = p.detect_markers(pdf)
        lib = [{
            "code": "FRANCHISEE_LEGAL_NAME",
            "hidden": False,
            "eligible_contract_types": ["franchise_renewal"],
            "repeat_allowed": True,
        }]
        summary = p.build_marker_summary(
            det.markers, det.cross_line_errors, lib,
            contract_type="franchise_renewal",
            template_required_codes=["FRANCHISEE_LEGAL_NAME"],
        )
        assert summary["ready_for_approval"] is True
