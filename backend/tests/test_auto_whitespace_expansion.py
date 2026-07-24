"""Regression: auto render_bbox expansion into available white space.

HQ's expectation is that ordinary single-line markers (dates, names,
fees, references) should NOT require manual resizing after upload —
the detector should automatically extend ``render_bbox`` rightward
through empty space up to the next text / column / margin, and
vertically enough to satisfy PyMuPDF's ``insert_textbox`` fit-check
at the source font size.

``token_bbox`` MUST remain character-tight (used only for redaction).
"""
from __future__ import annotations

import fitz
import pytest

import contract_markers_pipeline as pipeline
import contract_preview_generator as previewgen


def _pdf_marker_with_whitespace_right() -> bytes:
    """Page with 'AGREEMENT DATED [[AGREEMENT_DATE]]' followed by lots
    of white space until the right margin. Second line has arbitrary
    other text to give the vertical detector a prev_line + next_line."""
    doc = fitz.open()
    p = doc.new_page(width=595, height=842)
    p.insert_text((72, 100), "PROLOGUE LINE — no marker.", fontsize=11, fontname="helv")
    p.insert_text((72, 150), "AGREEMENT DATED [[AGREEMENT_DATE]]", fontsize=11, fontname="helv")
    p.insert_text((72, 200), "NEXT LINE — no marker.", fontsize=11, fontname="helv")
    data = doc.tobytes()
    doc.close()
    return data


class TestAutoWhitespaceExpansion:
    def test_render_bbox_extends_past_token_when_no_blocker(self):
        pdf = _pdf_marker_with_whitespace_right()
        det = pipeline.detect_markers(pdf)
        assert len(det.markers) == 1
        m = det.markers[0]
        token_w = m.token_bbox[2] - m.token_bbox[0]
        render_w = m.render_bbox[2] - m.render_bbox[0]
        # Render must be significantly wider than the token (>3× is the
        # visible expansion HQ needs).
        assert render_w > token_w * 3, (
            f"render_bbox didn't expand: token_w={token_w}, render_w={render_w}"
        )
        # Right edge should be near the page's right margin (~559 for A4)
        assert m.render_bbox[2] >= 500

    def test_token_bbox_remains_unchanged_after_expansion(self):
        pdf = _pdf_marker_with_whitespace_right()
        det = pipeline.detect_markers(pdf)
        m = det.markers[0]
        # token_bbox must still be tight around the [[AGREEMENT_DATE]] glyphs.
        token_w = m.token_bbox[2] - m.token_bbox[0]
        # 18 chars incl brackets × ~6pt at 11pt Helvetica ≈ 100pt max
        assert token_w < 130, f"token_bbox appears expanded: width={token_w}"
        # Character-tight width for 18 chars is roughly > 50pt
        assert token_w > 40

    def test_render_bbox_height_supports_insert_textbox(self):
        """The auto-expansion must give PyMuPDF enough vertical room to
        pass its fit-check for the source font size — otherwise HQ has
        to resize every marker before the preview will render."""
        pdf = _pdf_marker_with_whitespace_right()
        det = pipeline.detect_markers(pdf)
        m = det.markers[0]
        markers = pipeline.occurrences_for_storage(det.markers)
        for mm in markers:
            mm["data_type"] = "date"
            mm["min_font_size"] = 11
            mm["font_size_override"] = 11
        out_bytes, report = previewgen.generate_sample_preview(
            pdf, markers, values=None, template_name="whitespace-test",
        )
        assert report["redaction_verified"] is True
        # The one occurrence should NOT be overflowing at 11pt.
        occ_reports = report["occurrences"]
        assert len(occ_reports) == 1
        assert occ_reports[0]["overflow"] is False, (
            "auto-expansion still leaves value overflowing at source font size — "
            "HQ would be forced to manually resize"
        )
        assert occ_reports[0]["final_size"] == 11.0

    def test_blocker_to_the_right_limits_expansion(self):
        """If there's text to the right of the token, render_bbox must
        stop before that text — never overlap."""
        doc = fitz.open()
        p = doc.new_page(width=595, height=842)
        # Marker with text to the right on the same line
        p.insert_text((72, 150), "before [[AGREEMENT_DATE]] middle-text after-that", fontsize=11, fontname="helv")
        data = doc.tobytes()
        doc.close()
        det = pipeline.detect_markers(data)
        m = det.markers[0]
        # The right edge should NOT reach page margin — there's blocking text
        assert m.render_bbox[2] < 500, (
            f"render_bbox extended past blocking text: x1={m.render_bbox[2]}"
        )
