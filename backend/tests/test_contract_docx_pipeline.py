"""Unit tests for contract_docx_pipeline.

Uses a tiny synthetic docx generated on the fly plus a real fixture
(Paloma renewal contract) mirrored locally so tests don't depend on
external network availability.
"""
from __future__ import annotations

import io
import os
import zipfile

import pytest

import contract_docx_pipeline as p


# ---------------------------------------------------------------------------
# Helper — build the minimal viable OOXML we need to exercise the code path.
# ---------------------------------------------------------------------------
_MINIMAL_STYLES_XML = """<?xml version='1.0' encoding='UTF-8' standalone='yes'?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="Heading 1"/></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="Heading 2"/></w:style>
</w:styles>"""

_MINIMAL_CT_XML = """<?xml version='1.0' encoding='UTF-8' standalone='yes'?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>"""

_MINIMAL_RELS = """<?xml version='1.0' encoding='UTF-8' standalone='yes'?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>"""

_MINIMAL_DOC_RELS = """<?xml version='1.0' encoding='UTF-8' standalone='yes'?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>"""


def _make_docx(body_xml: str) -> bytes:
    doc_xml = f"""<?xml version='1.0' encoding='UTF-8' standalone='yes'?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    {body_xml}
  </w:body>
</w:document>"""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("[Content_Types].xml", _MINIMAL_CT_XML)
        z.writestr("_rels/.rels", _MINIMAL_RELS)
        z.writestr("word/_rels/document.xml.rels", _MINIMAL_DOC_RELS)
        z.writestr("word/document.xml", doc_xml)
        z.writestr("word/styles.xml", _MINIMAL_STYLES_XML)
    return buf.getvalue()


def _no_op_upload(data: bytes, ct: str, ext: str) -> str:  # noqa: ARG001
    return f"https://cdn.test/img.{ext}"


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------
class TestBasics:
    def test_headings_and_paragraphs(self):
        docx = _make_docx("""
          <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Chapter One</w:t></w:r></w:p>
          <w:p><w:r><w:t>Normal body paragraph.</w:t></w:r></w:p>
          <w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Section 1</w:t></w:r></w:p>
        """)
        r = p.convert_docx(docx, upload_image=_no_op_upload)
        assert "<h1>Chapter One</h1>" in r.html
        assert "<h2>Section 1</h2>" in r.html
        assert "<p>Normal body paragraph." in r.html
        assert r.heading_count >= 2

    def test_center_alignment_becomes_class(self):
        docx = _make_docx("""
          <w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:t>Cover title</w:t></w:r></w:p>
          <w:p><w:pPr><w:jc w:val="right"/></w:pPr><w:r><w:t>Right stuff</w:t></w:r></w:p>
          <w:p><w:pPr><w:jc w:val="both"/></w:pPr><w:r><w:t>Justified</w:t></w:r></w:p>
        """)
        r = p.convert_docx(docx, upload_image=_no_op_upload)
        assert 'class="text-center"' in r.html
        assert 'class="text-right"' in r.html
        assert 'class="text-justify"' in r.html

    def test_alignment_ignored_when_named_style_present(self):
        # A paragraph that already has a proper named style should keep
        # that style — the synthetic alignment style must NOT override.
        docx = _make_docx("""
          <w:p><w:pPr><w:pStyle w:val="Heading1"/><w:jc w:val="center"/></w:pPr><w:r><w:t>Title</w:t></w:r></w:p>
        """)
        r = p.convert_docx(docx, upload_image=_no_op_upload)
        assert "<h1>Title</h1>" in r.html
        assert "text-center" not in r.html

    def test_page_break_inserts_marker(self):
        docx = _make_docx("""
          <w:p><w:r><w:t>Before</w:t></w:r></w:p>
          <w:p><w:r><w:br w:type="page"/><w:t>After the break</w:t></w:r></w:p>
        """)
        r = p.convert_docx(docx, upload_image=_no_op_upload)
        # Marker paragraph precedes the after-the-break paragraph
        assert 'class="page-break"' in r.html
        assert r.page_break_count == 1

    def test_wraps_leading_clause_numbers_in_headings(self):
        # If a heading literally starts with "1.1", we wrap the number in
        # a grey chip so approve-conversion can strip it.
        docx = _make_docx("""
          <w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>1.1  Definitions</w:t></w:r></w:p>
          <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Interpretation</w:t></w:r></w:p>
        """)
        r = p.convert_docx(docx, upload_image=_no_op_upload)
        assert '<span class="cm-original-num">1.1</span>' in r.html
        # Non-numbered heading is untouched
        assert '>Interpretation</h1>' in r.html

    def test_extraction_returns_plain_text(self):
        docx = _make_docx('<w:p><w:r><w:t>Hello world.</w:t></w:r></w:p>')
        r = p.convert_docx(docx, upload_image=_no_op_upload)
        assert "Hello world." in r.plain_text


class TestPaloma:
    """End-to-end against the real Paloma DOCX. Skips if the file is
    not present locally (mirrored to /tmp/paloma.docx during E2E work)."""

    @pytest.mark.skipif(not os.path.exists("/tmp/paloma.docx"),
                         reason="Paloma DOCX fixture not staged in /tmp")
    def test_paloma_conversion(self):
        with open("/tmp/paloma.docx", "rb") as f:
            r = p.convert_docx(f.read(), upload_image=_no_op_upload)
        assert r.heading_count >= 300           # 348 in practice
        assert r.image_count == 4               # Creative Mojo logos + artwork
        assert r.table_count == 5               # cover + contents + defs + schedules
        assert 'class="cover-title"' in r.html
        assert 'class="cover-subtitle"' in r.html
        assert 'class="cover-parties"' in r.html
        assert 'class="recital"' in r.html
        assert 'class="toc-1"' in r.html
        # Verbatim text captured too
        assert len(r.plain_text) > 50_000
