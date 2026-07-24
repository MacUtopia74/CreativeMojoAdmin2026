"""Turn A unit tests — font resolver + preview generator."""
from __future__ import annotations

import hashlib
import io

import fitz
import pytest

import contract_font_resolver as fr
import contract_preview_generator as pg


def _make_pdf(lines):
    """lines = [(page_index → [(x,y,text,size)])]"""
    doc = fitz.open()
    for page_lines in lines:
        p = doc.new_page()
        for x, y, t, s in page_lines:
            p.insert_text((x, y), t, fontsize=s, fontname="helv")
    b = doc.tobytes()
    doc.close()
    return b


class TestFontResolver:
    def test_defaults_to_helvetica(self):
        r = fr.resolve_font(None, is_embedded=False, is_reusable=False)
        assert r.overlay_family == "helv"
        assert r.substitution_required is True

    def test_times_maps_to_tiro(self):
        r = fr.resolve_font("TimesNewRomanPSMT", is_embedded=True, is_reusable=False)
        assert r.overlay_family == "tiro"
        assert r.substitution_required is True  # subset embed not reusable

    def test_bold_variant(self):
        r = fr.resolve_font("Helvetica", is_embedded=False, is_reusable=False, is_bold=True)
        assert r.overlay_family == "hebo"
        assert r.overlay_display == "Helvetica-Bold"

    def test_italic_variant(self):
        r = fr.resolve_font("Times", is_embedded=False, is_reusable=False, is_italic=True)
        assert r.overlay_family == "tiit"

    def test_bold_italic_variant(self):
        r = fr.resolve_font("Times", is_embedded=False, is_reusable=False,
                            is_bold=True, is_italic=True)
        assert r.overlay_family == "tibi"

    def test_courier(self):
        r = fr.resolve_font("Courier New", is_embedded=False, is_reusable=False)
        assert r.overlay_family == "cour"

    def test_reusable_embedded_no_substitution(self):
        r = fr.resolve_font("Helvetica", is_embedded=True, is_reusable=True)
        assert r.substitution_required is False

    def test_subset_embed_flags_substitution(self):
        r = fr.resolve_font("AAAAAA+Arial", is_embedded=True, is_reusable=False)
        assert r.substitution_required is True
        assert "subset" in r.reason

    def test_signature_groups(self):
        s1 = fr.substitution_group_signature("Times", "tiro", 11, False)
        s2 = fr.substitution_group_signature("Times", "tiro", 11, False)
        s3 = fr.substitution_group_signature("Times", "tiro", 12, False)
        assert s1 == s2
        assert s1 != s3

    def test_unknown_family_falls_back_to_helv(self):
        r = fr.resolve_font("Weirdo123", is_embedded=False, is_reusable=False)
        assert r.overlay_family == "helv"


class TestPreviewGenerator:
    def _markers_for(self, pdf_bytes):
        """Detect markers exactly like the pipeline does — reuse it."""
        import contract_markers_pipeline as mp
        det = mp.detect_markers(pdf_bytes)
        return [
            {
                "code": o.code, "page": o.page, "bbox": list(o.bbox),
                "font_family": o.font_family, "font_size": o.font_size,
                "font_weight": o.font_weight, "font_style": o.font_style,
                "is_embedded": o.is_embedded, "is_reusable": o.is_reusable,
                "data_type": "string",
            }
            for o in det.markers
        ]

    def test_produces_valid_pdf(self):
        src = _make_pdf([[
            (72, 100, "Between: [[FRANCHISEE_LEGAL_NAME]]", 11),
            (72, 130, "Reference: [[CONTRACT_REFERENCE]]", 11),
        ]])
        markers = self._markers_for(src)
        out, report = pg.generate_sample_preview(src, markers, None, "Test Template")
        # PDF magic bytes present
        assert out[:5] == b"%PDF-"
        assert report["page_count"] == 1
        assert report["watermark_pages"] == 1

    def test_no_marker_tokens_survive(self):
        src = _make_pdf([[
            (72, 100, "Hello [[FRANCHISEE_LEGAL_NAME]] world", 11),
            (72, 130, "Ref [[CONTRACT_REFERENCE]]", 11),
        ]])
        markers = self._markers_for(src)
        out, report = pg.generate_sample_preview(src, markers, None, "t")
        # Zero `[[` in the preview's text layer
        assert report["residual_token_count"] == 0
        assert report["redaction_verified"] is True

    def test_watermark_on_every_page(self):
        src = _make_pdf([
            [(72, 100, "Page one [[FRANCHISEE_LEGAL_NAME]]", 11)],
            [(72, 100, "Page two [[CONTRACT_REFERENCE]]", 11)],
            [(72, 100, "Page three body", 11)],
        ])
        markers = self._markers_for(src)
        out, _ = pg.generate_sample_preview(src, markers, None, "t")
        # Reopen the output, confirm watermark text appears on every page
        d = fitz.open(stream=io.BytesIO(out), filetype="pdf")
        try:
            for i in range(d.page_count):
                txt = d[i].get_text("text") or ""
                assert "PREVIEW" in txt, f"page {i+1} missing watermark"
        finally:
            d.close()

    def test_source_bytes_not_mutated(self):
        src = _make_pdf([[(72, 100, "[[FRANCHISEE_LEGAL_NAME]]", 11)]])
        pre = hashlib.sha256(src).hexdigest()
        markers = self._markers_for(src)
        _ = pg.generate_sample_preview(src, markers, None, "t")
        post = hashlib.sha256(src).hexdigest()
        assert pre == post

    def test_pdf_metadata_labels_preview(self):
        src = _make_pdf([[(72, 100, "[[FRANCHISEE_LEGAL_NAME]]", 11)]])
        markers = self._markers_for(src)
        out, _ = pg.generate_sample_preview(src, markers, None, "Franchise Renewal")
        d = fitz.open(stream=io.BytesIO(out), filetype="pdf")
        try:
            md = d.metadata or {}
            assert "PREVIEW" in (md.get("title") or "")
            assert "PREVIEW" in (md.get("subject") or "")
            assert "preview" in (md.get("keywords") or "").lower()
        finally:
            d.close()

    def test_user_supplied_value_wins(self):
        src = _make_pdf([[(72, 100, "Between: [[FRANCHISEE_LEGAL_NAME]] hello", 11)]])
        markers = self._markers_for(src)
        out, report = pg.generate_sample_preview(
            src, markers, {"FRANCHISEE_LEGAL_NAME": "Acme Real Value Ltd"}, "t"
        )
        d = fitz.open(stream=io.BytesIO(out), filetype="pdf")
        try:
            txt = d[0].get_text("text") or ""
        finally:
            d.close()
        assert "Acme Real Value Ltd" in txt
        assert "[[FRANCHISEE_LEGAL_NAME]]" not in txt

    def test_synthetic_default_used_when_no_value(self):
        src = _make_pdf([[(72, 100, "[[FRANCHISEE_LEGAL_NAME]]", 11)]])
        markers = self._markers_for(src)
        out, _ = pg.generate_sample_preview(src, markers, None, "t")
        d = fitz.open(stream=io.BytesIO(out), filetype="pdf")
        try:
            txt = d[0].get_text("text") or ""
        finally:
            d.close()
        assert "Sample Franchisee Limited" in txt

    def test_sanitise_filename(self):
        assert pg.sanitise_filename_component("Franchise Renewal — 2026") == \
            "Franchise_Renewal_2026"
        assert pg.sanitise_filename_component("../etc/passwd") == "etc_passwd"
        assert pg.sanitise_filename_component("") == "template"
