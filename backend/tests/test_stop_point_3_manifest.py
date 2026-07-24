"""Regression tests for the Stop Point 3 evidence-pack corrections.

Covers:

* Font resolver's ``substitution_required`` semantic now matches the
  Marker Review UI's family-group rollup — only true when the source
  font is embedded but as a non-reusable subset. Unembedded source is
  the natural Base14 fallback case and needs no acknowledgement.
* Preview generator no longer widens ``render_bbox`` to the page's
  right edge for ``no_wrap`` markers when alignment is centre or right —
  widening those would detach the value from its intended inline slot.
"""
from __future__ import annotations

import io

import fitz
import pytest

import contract_font_resolver as fr
import contract_preview_generator as pg


class TestSubstitutionSemantics:
    def test_unembedded_source_needs_no_acknowledgement(self):
        r = fr.resolve_font("Arial", is_embedded=False, is_reusable=False)
        assert r.substitution_required is False
        assert "Base14 fallback" in r.reason

    def test_subset_embed_needs_acknowledgement(self):
        r = fr.resolve_font("AAAAAA+Arial", is_embedded=True, is_reusable=False)
        assert r.substitution_required is True
        assert "subset" in r.reason

    def test_reusable_embed_needs_no_acknowledgement(self):
        r = fr.resolve_font("Helvetica", is_embedded=True, is_reusable=True)
        assert r.substitution_required is False


def _make_inline_pdf() -> bytes:
    """Tiny PDF with a fixed-position marker inline in a sentence,
    followed immediately by trailing text on the same baseline. Emulates
    the Paloma template's ``[[MONTHLY_FEE]] per month ex VAT`` line."""
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    page.insert_text((120, 640), "Monthly Fee ", fontsize=11, fontname="helv")
    page.insert_text((257, 640), "[[MONTHLY_FEE]] per month ex VAT.",
                     fontsize=11, fontname="helv")
    b = doc.tobytes()
    doc.close()
    return b


class TestNoWrapRightAlignStaysInSlot:
    """When HQ picks right-alignment on an inline no_wrap marker, the
    overlay MUST stay inside the authored ``render_bbox`` — not get
    pushed to the page's right margin."""

    def test_right_aligned_no_wrap_hugs_trailing_text(self):
        src = _make_inline_pdf()
        # Emulate the pipeline's per-occurrence marker record for the
        # `[[MONTHLY_FEE]]` inline case. token_bbox is character-tight
        # around the marker glyphs; render_bbox matches for this test.
        marker = {
            "code": "MONTHLY_FEE",
            "page": 1,
            "token_bbox": [257.0, 630.0, 351.0, 646.0],
            "render_bbox": [257.0, 630.0, 351.0, 650.0],
            "bbox": [257.0, 630.0, 351.0, 650.0],
            "font_family": "Helvetica",
            "font_size": 11.0,
            "is_embedded": False,
            "is_reusable": False,
            "wrapping": "no_wrap",
            "alignment": "right",
            "min_font_size": 11.0,
            "font_size_override": 11.0,
            "data_type": "currency",
            "occurrence_id": "test-monthly-fee",
        }
        pdf_bytes, report = pg.generate_sample_preview(
            src, [marker], values={"MONTHLY_FEE": "£113.30"}, template_name="t",
        )
        assert report["occurrences"][0]["overflow"] is False
        # Re-open the preview and extract the overlaid value's bbox.
        out = fitz.open(stream=io.BytesIO(pdf_bytes), filetype="pdf")
        try:
            page = out[0]
            hits = page.search_for("£113.30")
        finally:
            out.close()
        assert hits, "value was not written into the preview"
        # The value must remain inside the authored render_bbox — its
        # right edge must not exceed the box's right edge (351) by more
        # than a hair (PyMuPDF may pad by a fraction of a point).
        for r in hits:
            assert r.x1 <= 353, f"value pushed past render_bbox: {r}"
            assert r.x0 >= 257 - 1, f"value pushed left of render_bbox: {r}"


class TestMonthlyFeeRightAlignSample:
    """End-to-end check that the specific Paloma-style layout produces
    a value that reads inline with the trailing 'per month ex VAT' text."""

    def test_value_ends_just_before_per_month(self):
        src = _make_inline_pdf()
        marker = {
            "code": "MONTHLY_FEE",
            "page": 1,
            "token_bbox": [257.0, 630.0, 351.0, 646.0],
            "render_bbox": [257.0, 630.0, 351.0, 650.0],
            "bbox": [257.0, 630.0, 351.0, 650.0],
            "font_family": "Helvetica",
            "font_size": 11.0,
            "is_embedded": False,
            "is_reusable": False,
            "wrapping": "no_wrap",
            "alignment": "right",
            "font_size_override": 11.0,
            "min_font_size": 11.0,
            "data_type": "currency",
            "occurrence_id": "oid",
        }
        pdf_bytes, _ = pg.generate_sample_preview(
            src, [marker], values={"MONTHLY_FEE": "£113.30"}, template_name="t",
        )
        out = fitz.open(stream=io.BytesIO(pdf_bytes), filetype="pdf")
        try:
            page = out[0]
            value_hits = page.search_for("£113.30")
            trailing = page.search_for("per month")
        finally:
            out.close()
        assert value_hits and trailing
        v = value_hits[0]
        t = trailing[0]
        # The value's right edge should be within a couple of points of
        # where 'per month' begins — reads inline, not detached to the
        # far right of the page.
        assert 0 <= t.x0 - v.x1 <= 8, f"value/trailing gap = {t.x0 - v.x1}pt"
