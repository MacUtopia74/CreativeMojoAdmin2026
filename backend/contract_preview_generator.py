"""Whole-document sample-preview PDF generator (Phase 1B).

Preview-only. Not the Phase 1C production generator. All outputs carry
a diagonal PREVIEW watermark on every page, PREVIEW metadata, and a
PREVIEW_ filename. Source PDF bytes are read-only — never written back.

Public surface:
    generate_sample_preview(source_bytes, markers, values, template_name)
        -> (pdf_bytes, generation_report)
"""
from __future__ import annotations

import io
import logging
import re
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

import fitz  # PyMuPDF

import contract_font_resolver as font_resolver

logger = logging.getLogger(__name__)

WATERMARK_TEXT = "PREVIEW — NOT FOR ISSUE"


# ---------------------------------------------------------------------------
# Synthetic sample values used when HQ hasn't supplied one for a code.
# Kept deliberately obvious so nobody mistakes a preview for real data.
# ---------------------------------------------------------------------------
_SYNTHETIC_DEFAULTS: Dict[str, str] = {
    "string":         "Sample value",
    "multiline_text": "Sample line one\nSample line two\nSample line three",
    "date":           "31 December 2026",
    "currency":       "£1,234.56",
    "integer":        "5",
    "decimal":        "5.00",
}


def synthetic_default_for(code: str, data_type: str) -> str:
    """Preview-only synthetic default. Never used in production."""
    if code == "FRANCHISEE_LEGAL_NAME":
        return "Sample Franchisee Limited"
    if code == "FRANCHISEE_FIRST_NAME":
        return "Sample"
    if code == "FRANCHISEE_LAST_NAME":
        return "Franchisee"
    if code == "FRANCHISEE_FULL_NAME":
        return "Sample Franchisee"
    if code == "FRANCHISEE_ORGANISATION":
        return "Creative Mojo Sample Area"
    if code == "FRANCHISEE_EMAIL":
        return "sample@creativemojo.co.uk"
    if code == "FRANCHISEE_MOBILE":
        return "07000 000000"
    if code == "FRANCHISEE_ADDRESS_STREET":
        return "1 Sample Street"
    if code == "FRANCHISEE_CITY":
        return "Sampletown"
    if code == "FRANCHISEE_COUNTY":
        return "Sampleshire"
    if code == "FRANCHISEE_POSTCODE":
        return "SM1 1PL"
    if code == "FRANCHISEE_ADDRESS_BLOCK":
        return "1 Sample Street\nSampletown\nSampleshire\nSM1 1PL"
    if code == "FRANCHISE_NUMBER":
        return "0099"
    if code == "CONTRACT_REFERENCE":
        return "CM-2026-0099"
    if code == "AGREEMENT_DATE" or code == "COMMENCEMENT_DATE" or code == "TERM_START_DATE":
        return "1 August 2026"
    if code == "RENEWAL_DATE":
        return "31 July 2031"
    if code == "MONTHLY_FEE":
        return "£113.30"
    if code == "RENEWAL_FEE":
        return "£250.00"
    if code == "CONTRACT_TERM_YEARS":
        return "5"
    if code == "HQ_SIGNATORY_NAME":
        return "Sample HQ Director"
    if code == "HQ_SIGNATORY_TITLE":
        return "Director"
    return _SYNTHETIC_DEFAULTS.get(data_type, f"[SAMPLE {code}]")


# ---------------------------------------------------------------------------
# Watermark
# ---------------------------------------------------------------------------
def _draw_watermark(page: fitz.Page) -> None:
    """PREVIEW banner at top and bottom of each page. PyMuPDF only
    supports 90°-multiple text rotations, so we use two horizontal
    banners rather than a 45° diagonal — visible on every page without
    obscuring the content HQ needs to inspect."""
    rect = page.rect
    banner = f"— {WATERMARK_TEXT} —"
    for y in (rect.y0 + 26, rect.y1 - 18):
        # Centre horizontally by using a full-width textbox with center align.
        band = fitz.Rect(rect.x0, y - 12, rect.x1, y + 12)
        page.insert_textbox(
            band, banner,
            fontsize=14, fontname="hebo",
            color=(0.82, 0.15, 0.15),
            align=1,  # center
        )


# ---------------------------------------------------------------------------
# Overlay writer
# ---------------------------------------------------------------------------
def _write_value(page: fitz.Page, marker: Dict[str, Any], value: str) -> Dict[str, Any]:
    """Redact the marker area then draw the personalised value. Returns
    a per-occurrence report row."""
    bbox = marker.get("bbox") or []
    if len(bbox) != 4:
        return {"code": marker.get("code"), "ok": False, "reason": "bad bbox"}
    rect = fitz.Rect(*bbox)

    # Resolve overlay font
    weight = (marker.get("font_weight") or "normal") == "bold"
    italic = (marker.get("font_style") or "normal") == "italic"
    fr = font_resolver.resolve_font(
        marker.get("font_family"),
        is_embedded=marker.get("is_embedded"),
        is_reusable=marker.get("is_reusable"),
        is_bold=weight,
        is_italic=italic,
    )

    # Apply redaction — removes glyphs from text layer and paints the
    # background so [[...]] is gone from the output.
    page.add_redact_annot(rect, fill=(1, 1, 1))
    page.apply_redactions()

    # Draw the personalised value.
    size = float(marker.get("font_size") or 11)
    align_map = {"left": 0, "center": 1, "right": 2, "justify": 3}
    alignment = align_map.get((marker.get("alignment") or "left").lower(), 0)

    # Try to fit; if it overflows, shrink in 0.5pt steps down to a floor.
    min_size = float(marker.get("min_font_size") or 7)
    overflow = False
    current = size
    while current >= min_size:
        rc = page.insert_textbox(
            rect, value,
            fontname=fr.overlay_family,
            fontsize=current,
            align=alignment,
            color=(0, 0, 0),
        )
        if rc >= 0:  # fit succeeded
            break
        current -= 0.5
    else:
        overflow = True
        # Last resort — draw at min_size clipped
        page.insert_textbox(
            rect, value,
            fontname=fr.overlay_family, fontsize=min_size,
            align=alignment, color=(0.6, 0, 0),
        )

    return {
        "code": marker.get("code"),
        "page": marker.get("page"),
        "value_preview": value[:60],
        "overlay_family": fr.overlay_family,
        "overlay_display": fr.overlay_display,
        "substitution_required": fr.substitution_required,
        "final_size": round(current if not overflow else min_size, 1),
        "overflow": overflow,
        "ok": True,
    }


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------
def _resolve_value(marker: Dict[str, Any], user_values: Dict[str, str]) -> str:
    code = marker.get("code") or ""
    if code in user_values and user_values[code] is not None:
        return str(user_values[code])
    dt = (marker.get("data_type") or "string").lower()
    return synthetic_default_for(code, dt)


def generate_sample_preview(
    source_bytes: bytes,
    markers: List[Dict[str, Any]],
    values: Optional[Dict[str, str]],
    template_name: str,
) -> Tuple[bytes, Dict[str, Any]]:
    """Return (preview_pdf_bytes, generation_report).

    ``source_bytes`` is read-only; it is opened via a BytesIO stream and
    never written back. The mutations happen on the in-memory PyMuPDF
    document and are saved to a fresh output buffer.
    """
    values = dict(values or {})

    # Group markers by page for efficient iteration
    by_page: Dict[int, List[Dict[str, Any]]] = {}
    for m in markers:
        by_page.setdefault(int(m.get("page") or 1), []).append(m)

    src_stream = io.BytesIO(source_bytes)
    doc = fitz.open(stream=src_stream, filetype="pdf")

    report: Dict[str, Any] = {
        "template_name": template_name,
        "page_count": doc.page_count,
        "occurrences": [],
        "watermark_pages": 0,
    }

    try:
        # 1) Redact + overlay every marker
        for page_num in range(1, doc.page_count + 1):
            page = doc[page_num - 1]
            for m in by_page.get(page_num, []):
                value = _resolve_value(m, values)
                row = _write_value(page, m, value)
                report["occurrences"].append(row)

        # 2) Watermark every page
        for page in doc:
            _draw_watermark(page)
            report["watermark_pages"] += 1

        # 3) PDF metadata — clearly labels this a preview
        doc.set_metadata({
            "title":    f"PREVIEW — {template_name}",
            "author":   "Creative Mojo Hub",
            "subject":  "PREVIEW — NOT FOR ISSUE — Creative Mojo Hub",
            "keywords": "preview,not-for-issue,sample,creative-mojo",
            "producer": "Creative Mojo Hub · Sample Preview Generator",
            "creator":  "Creative Mojo Hub · Sample Preview Generator",
            "creationDate": fitz.get_pdf_now(),
            "modDate":  fitz.get_pdf_now(),
        })

        out_buf = io.BytesIO()
        doc.save(out_buf, deflate=True, garbage=3, clean=True)
        pdf_bytes = out_buf.getvalue()
    finally:
        doc.close()

    # 4) Redaction verification — no `[[` should survive in the output
    #    text layer. We reopen the output for a text scan only.
    verify_doc = fitz.open(stream=io.BytesIO(pdf_bytes), filetype="pdf")
    try:
        residual = 0
        for pg in verify_doc:
            txt = pg.get_text("text") or ""
            residual += txt.count("[[")
        report["residual_token_count"] = residual
        report["redaction_verified"] = residual == 0
    finally:
        verify_doc.close()

    report["generated_at"] = datetime.now(timezone.utc).isoformat()
    report["preview_byte_size"] = len(pdf_bytes)
    return pdf_bytes, report


def sanitise_filename_component(name: str) -> str:
    """Turn a template name into a safe filename fragment."""
    stripped = re.sub(r"\.{2,}", "", name or "")
    clean = re.sub(r"[^A-Za-z0-9._-]+", "_", stripped.strip())
    return clean.strip("_.") or "template"
