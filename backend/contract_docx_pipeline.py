"""DOCX → semantic HTML pipeline for Creative Mojo contract templates.

Uses python-mammoth so we get clean semantic HTML directly out of the
Word document (headings, paragraphs, tables, lists, images, hyperlinks,
bold/italic/underline) without needing an LLM cleanup pass. Word's
document.xml drives everything, so this is fully deterministic.

The mammoth conversion is complemented by a small pre-processing step
that reads the raw OOXML to detect:
  * explicit <w:br w:type="page"/> page breaks
  * <w:p w:pPr><w:jc w:val="center|right|both"/></w:p> alignment

These two signals are re-injected into the paragraphs via mammoth's
transform API so the downstream style map can convert them into our
own semantic classes (page-break div, .text-center / .text-right /
.text-justify paragraph classes).

Public surface:
    convert_docx(pdf_bytes: bytes, *, upload_image) -> DocxExtraction

`upload_image` is a callable taking (image_bytes, content_type,
suggested_ext) → public URL. The pipeline invokes it once per embedded
image so callers can push each image to R2 (or wherever) and get an
`<img src="…">` back instead of a data URI.
"""
from __future__ import annotations

import io
import logging
import re
import uuid
from dataclasses import dataclass, field
from typing import Callable, List, Optional
from zipfile import ZipFile

import mammoth  # type: ignore
from lxml import etree

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Creative Mojo Word style map — maps Word paragraph styles into semantic
# HTML.  Anything not covered here falls through to mammoth's defaults.
# ---------------------------------------------------------------------------
CM_STYLE_MAP = """
p[style-name='Title'] => h1.doc-title:fresh
p[style-name='Subtitle'] => p.doc-subtitle:fresh

p[style-name='CoverSheetMainTitle'] => h1.cover-title:fresh
p[style-name='CoverSheetTitle'] => h2.cover-subtitle:fresh
p[style-name='CoverSheetParties'] => p.cover-parties:fresh
p[style-name='CoverSheet'] => p.cover-line:fresh

p[style-name='Recitals'] => p.recital:fresh
p[style-name='Recital'] => p.recital:fresh

p[style-name='TOC1'] => p.toc-1:fresh
p[style-name='TOC2'] => p.toc-2:fresh
p[style-name='TOC3'] => p.toc-3:fresh
p[style-name='toc 1'] => p.toc-1:fresh
p[style-name='toc 2'] => p.toc-2:fresh
p[style-name='toc 3'] => p.toc-3:fresh

p[style-name='Header'] => p.docx-header:fresh
p[style-name='Footer'] => p.docx-footer:fresh

p[style-name='CenterAligned'] => p.text-center:fresh
p[style-name='RightAligned'] => p.text-right:fresh
p[style-name='JustifyAligned'] => p.text-justify:fresh
p[style-name='PageBreakMarker'] => div.page-break:fresh

r[style-name='Emphasis'] => em
r[style-name='Strong'] => strong

u => u
""".strip()


# ---------------------------------------------------------------------------
# Dataclass returned to the caller.
# ---------------------------------------------------------------------------
@dataclass
class DocxExtraction:
    html: str
    plain_text: str
    warnings: List[str]
    image_count: int
    table_count: int
    page_break_count: int
    heading_count: int
    docx_metadata: dict = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Pre-scan OOXML for page breaks + paragraph alignments and rewrite the
# in-memory docx so our style map can pick them up.
# ---------------------------------------------------------------------------
W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
W = "{%s}" % W_NS
NSMAP = {"w": W_NS}


def _preprocess_docx(docx_bytes: bytes) -> bytes:
    """Rewrite the docx so alignments/page-breaks flow through the mammoth
    style map. We inject synthetic style names on qualifying paragraphs:
      * paragraphs with <w:jc w:val="center"> → style CenterAligned
      * ... "right" → RightAligned
      * ... "both"  → JustifyAligned
      * any paragraph containing <w:br w:type="page"/> → emits a companion
        paragraph with style PageBreakMarker just before it.
    Also ensures the synthetic style IDs are defined in styles.xml so
    mammoth actually applies them.
    Never removes anything; purely additive.
    """
    src = io.BytesIO(docx_bytes)
    dst_buf = io.BytesIO()

    with ZipFile(src, "r") as z_in, ZipFile(dst_buf, "w") as z_out:
        for item in z_in.infolist():
            data = z_in.read(item.filename)
            if item.filename == "word/document.xml":
                data = _rewrite_document_xml(data)
            elif item.filename == "word/styles.xml":
                data = _inject_synthetic_styles(data)
            z_out.writestr(item, data)

    return dst_buf.getvalue()


_SYNTHETIC_STYLES = [
    ("CenterAligned",   "CenterAligned",   "paragraph"),
    ("RightAligned",    "RightAligned",    "paragraph"),
    ("JustifyAligned",  "JustifyAligned",  "paragraph"),
    ("PageBreakMarker", "PageBreakMarker", "paragraph"),
]


def _inject_synthetic_styles(styles_xml: bytes) -> bytes:
    try:
        root = etree.fromstring(styles_xml)
    except Exception:  # pragma: no cover
        return styles_xml
    existing = {
        s.get(f"{W}styleId") for s in root.findall(f"{W}style")
    }
    for style_id, name, style_type in _SYNTHETIC_STYLES:
        if style_id in existing:
            continue
        style_el = etree.SubElement(root, f"{W}style")
        style_el.set(f"{W}type", style_type)
        style_el.set(f"{W}styleId", style_id)
        name_el = etree.SubElement(style_el, f"{W}name")
        name_el.set(f"{W}val", name)
    return etree.tostring(
        root, xml_declaration=True, encoding="UTF-8", standalone=True,
    )


def _rewrite_document_xml(xml_bytes: bytes) -> bytes:
    try:
        root = etree.fromstring(xml_bytes)
    except Exception:  # pragma: no cover — defensive
        logger.exception("Could not parse document.xml — leaving untouched")
        return xml_bytes

    body = root.find(f"{W}body")
    if body is None:
        return xml_bytes

    def _apply_style(p_elem, style_id: str) -> None:
        """Insert or replace <w:pStyle w:val=...> on this paragraph."""
        pPr = p_elem.find(f"{W}pPr")
        if pPr is None:
            pPr = etree.SubElement(p_elem, f"{W}pPr")
            p_elem.insert(0, pPr)
        # Remove existing pStyle so ours wins
        for old in pPr.findall(f"{W}pStyle"):
            pPr.remove(old)
        style_el = etree.SubElement(pPr, f"{W}pStyle")
        style_el.set(f"{W}val", style_id)
        # Move pStyle to be the first child of pPr per OOXML schema
        pPr.remove(style_el)
        pPr.insert(0, style_el)

    for p in list(body.findall(f"{W}p")):
        pPr = p.find(f"{W}pPr")
        # 1) Alignment → synthetic style (only if no existing named style
        #    already claims the paragraph, otherwise the doc's own style
        #    wins).
        has_named_style = False
        if pPr is not None:
            style_el = pPr.find(f"{W}pStyle")
            if style_el is not None and style_el.get(f"{W}val"):
                has_named_style = True

        if pPr is not None and not has_named_style:
            jc = pPr.find(f"{W}jc")
            if jc is not None:
                val = jc.get(f"{W}val")
                mapping = {
                    "center": "CenterAligned",
                    "right": "RightAligned",
                    "both": "JustifyAligned",
                }
                if val in mapping:
                    _apply_style(p, mapping[val])

        # 2) Detect <w:br w:type="page"/> anywhere inside this paragraph
        #    and inject a preceding marker paragraph.
        page_break_runs = p.findall(f".//{W}br[@{W}type='page']")
        if page_break_runs:
            marker = etree.Element(f"{W}p")
            m_pPr = etree.SubElement(marker, f"{W}pPr")
            m_style = etree.SubElement(m_pPr, f"{W}pStyle")
            m_style.set(f"{W}val", "PageBreakMarker")
            # Empty runs get dropped by mammoth, so include a zero-width
            # placeholder so the paragraph survives the render.
            m_r = etree.SubElement(marker, f"{W}r")
            m_t = etree.SubElement(m_r, f"{W}t")
            m_t.text = "\u200b"  # zero-width space
            # Insert marker BEFORE the paragraph that contained the break
            parent = p.getparent()
            parent.insert(list(parent).index(p), marker)

    return etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)


# ---------------------------------------------------------------------------
# Post-processing on the mammoth HTML output:
#   * Wrap imported clause numbers (e.g. "1.", "1.1", "3.2.4") at the
#     start of an <h1>/<h2>/<h3>/<h4> so "Approve conversion" can strip
#     them and apply authoritative backend numbering, matching the PDF
#     pipeline behaviour.
# ---------------------------------------------------------------------------
_NUM_PREFIX = re.compile(
    r"^\s*(?P<num>\d+(?:\.\d+){0,3}\.?)\s+",
)


def _wrap_imported_numbers(html: str) -> str:
    """For each <h1>…<h4> tag, if the visible text starts with a legal-
    numbering-like token ("1.", "3.2", "4.1.2"), wrap that token in a
    span.cm-original-num."""

    def _sub(match: re.Match) -> str:
        opening = match.group(1)
        inner = match.group(2)
        m = _NUM_PREFIX.match(inner)
        if not m:
            return match.group(0)
        num = m.group("num")
        rest = inner[m.end():]
        return f'{opening}<span class="cm-original-num">{num}</span> {rest}'

    return re.sub(r"(<h[1-4][^>]*>)(.+?)(?=</h[1-4]>)", _sub, html, flags=re.DOTALL | re.IGNORECASE)


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------
def convert_docx(
    docx_bytes: bytes,
    *,
    upload_image: Callable[[bytes, str, str], str],
) -> DocxExtraction:
    """Convert a raw DOCX byte string to Tiptap-compatible semantic HTML.

    Arguments:
      docx_bytes: the raw .docx bytes
      upload_image: callable invoked for each embedded image. Receives
        (raw_bytes, content_type, suggested_extension) and MUST return a
        publicly-accessible URL string.
    """
    warnings: List[str] = []
    image_count = [0]  # boxed so the closure below can mutate

    processed = _preprocess_docx(docx_bytes)

    def _image_handler(image):  # mammoth passes an Image with .content_type + .open()
        image_count[0] += 1
        with image.open() as stream:
            data = stream.read()
        ct = (image.content_type or "image/png").lower()
        ext = "png"
        if "jpeg" in ct or "jpg" in ct: ext = "jpg"
        elif "gif" in ct: ext = "gif"
        elif "webp" in ct: ext = "webp"
        elif "svg" in ct: ext = "svg"
        elif "png" in ct: ext = "png"
        try:
            url = upload_image(data, ct, ext)
        except Exception:
            logger.exception("Image upload failed — falling back to data URI")
            import base64
            b64 = base64.b64encode(data).decode("ascii")
            url = f"data:{ct};base64,{b64}"
        return {"src": url}

    style_map = CM_STYLE_MAP
    try:
        result = mammoth.convert_to_html(
            io.BytesIO(processed),
            style_map=style_map,
            convert_image=mammoth.images.img_element(_image_handler),
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("mammoth conversion failed")
        raise RuntimeError(f"DOCX conversion failed: {exc}") from exc

    html = result.value or ""
    for m in result.messages:
        warnings.append(str(m))

    # Post-process: wrap legacy clause numbers with grey chips
    html = _wrap_imported_numbers(html)

    # Also plain text (for verbatim diff downstream)
    try:
        raw_text = mammoth.extract_raw_text(io.BytesIO(docx_bytes)).value or ""
    except Exception:
        raw_text = re.sub(r"<[^>]+>", "", html)

    # Metrics
    table_count = html.lower().count("<table")
    page_break_count = html.lower().count('class="page-break"')
    heading_count = sum(html.lower().count(f"<h{i}") for i in range(1, 5))

    return DocxExtraction(
        html=html,
        plain_text=raw_text,
        warnings=warnings,
        image_count=image_count[0],
        table_count=table_count,
        page_break_count=page_break_count,
        heading_count=heading_count,
    )
