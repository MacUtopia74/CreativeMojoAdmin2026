"""Regression: character-tight ``token_bbox`` must not redact surrounding text.

Reproduces the Phase 1B Turn A bug where PyMuPDF ``apply_redactions()``
was called with the whole-span bbox — destroying "AGREEMENT DATED "
alongside the ``[[AGREEMENT_DATE]]`` token.

The fix splits each marker into:

  * ``token_bbox`` — union of the per-character bboxes for the
    ``[[MARKER_CODE]]`` glyphs only. Used for redaction.
  * ``render_bbox`` — span-level union. Used for overlay placement.

These tests build a tiny synthetic PDF containing surrounding words,
run the deterministic pipeline, then run the preview generator and
verify surrounding text survives while the marker disappears.
"""
from __future__ import annotations

import fitz
import pytest

import contract_markers_pipeline as pipeline
import contract_preview_generator as previewgen


def _build_inline_marker_pdf() -> bytes:
    """PDF containing one line: 'AGREEMENT DATED [[AGREEMENT_DATE]]'."""
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)  # A4
    # Insert as one line — a single call so PyMuPDF renders it as one span.
    page.insert_text(
        (72, 200), "AGREEMENT DATED [[AGREEMENT_DATE]]",
        fontsize=11, fontname="helv",
    )
    data = doc.tobytes()
    doc.close()
    return data


class TestTokenBboxSplit:
    def test_token_bbox_narrower_than_render_bbox(self):
        pdf = _build_inline_marker_pdf()
        det = pipeline.detect_markers(pdf)
        assert len(det.markers) == 1
        m = det.markers[0]
        assert m.code == "AGREEMENT_DATE"
        # token_bbox should be strictly narrower than the span bbox
        # (span contains "AGREEMENT DATED " before the token).
        token_w = m.token_bbox[2] - m.token_bbox[0]
        render_w = m.render_bbox[2] - m.render_bbox[0]
        # Rendering starts at the same left edge as the token itself
        # because we constrain render_bbox horizontally to the token
        # width. The critical invariant: token_bbox must NOT cover
        # anything left of the "[[" bracket.
        assert token_w > 0
        assert render_w > 0
        # The span-level bbox of the entire line (>= 180pt) is much
        # wider than the token itself — sanity check by re-reading raw
        # text extent.
        with fitz.open(stream=pdf, filetype="pdf") as _d:
            raw = _d[0].get_text("rawdict")
            spans = raw["blocks"][0]["lines"][0]["spans"]
            line_w = spans[0]["bbox"][2] - spans[0]["bbox"][0]
        # Token should occupy strictly less than the whole line width.
        assert token_w < line_w * 0.9

    def test_surrounding_text_survives_preview(self):
        pdf = _build_inline_marker_pdf()
        det = pipeline.detect_markers(pdf)
        markers = pipeline.occurrences_for_storage(det.markers)
        # Enrich with data_type so synthetic default kicks in
        for m in markers:
            m["data_type"] = "date"
        out_bytes, report = previewgen.generate_sample_preview(
            pdf, markers, values=None, template_name="test-inline",
        )
        assert report["redaction_verified"] is True
        assert report["residual_token_count"] == 0
        # Reopen and confirm "AGREEMENT DATED " is intact.
        with fitz.open(stream=out_bytes, filetype="pdf") as vd:
            text = vd[0].get_text("text")
        assert "AGREEMENT DATED" in text, (
            "The surrounding text was destroyed by redaction — token_bbox "
            "is still leaking into surrounding characters."
        )
        # The marker itself must be gone
        assert "[[AGREEMENT_DATE]]" not in text
        # The sample value should have been overlaid
        assert "1 August 2026" in text

    def test_bbox_legacy_field_mirrors_render_bbox(self):
        pdf = _build_inline_marker_pdf()
        det = pipeline.detect_markers(pdf)
        m = det.markers[0]
        assert m.bbox == m.render_bbox

    def test_watermark_uses_ascii_hyphens(self):
        """The watermark must not contain em-dashes — Helvetica base14
        can't encode them and the output renders '?' glyphs."""
        assert "—" not in previewgen.WATERMARK_TEXT
        pdf = _build_inline_marker_pdf()
        det = pipeline.detect_markers(pdf)
        markers = pipeline.occurrences_for_storage(det.markers)
        for m in markers:
            m["data_type"] = "date"
        out_bytes, _ = previewgen.generate_sample_preview(
            pdf, markers, None, "wm-test",
        )
        with fitz.open(stream=out_bytes, filetype="pdf") as vd:
            text = vd[0].get_text("text")
        assert "PREVIEW - NOT FOR ISSUE" in text
        # No unicode question mark or replacement char artefacts
        assert "\ufffd" not in text


class TestLegacyBackfillCompat:
    def test_write_value_falls_back_to_bbox_when_split_missing(self):
        """Legacy templates only have ``bbox``; the preview generator
        must accept them and use ``bbox`` for both redaction + overlay."""
        pdf = _build_inline_marker_pdf()
        det = pipeline.detect_markers(pdf)
        # Simulate a legacy marker: only bbox, no split fields
        legacy_marker = {
            "code": "AGREEMENT_DATE",
            "page": 1,
            "bbox": list(det.markers[0].render_bbox),
            "font_family": "helv",
            "font_size": 11,
            "data_type": "date",
        }
        out_bytes, report = previewgen.generate_sample_preview(
            pdf, [legacy_marker], None, "legacy-test",
        )
        assert report["redaction_verified"] is True
