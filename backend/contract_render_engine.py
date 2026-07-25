"""Contract render engine — Phase 1C Turn C.

Shared PyMuPDF render machinery used by BOTH the Phase 1B sample
preview generator (``mode='preview'``, lenient — synthetic defaults
allowed, PREVIEW watermark, tolerant of overflow) AND the Phase 1C
production issuer (``mode='issuance'``, strict — every value comes
from the frozen ``contract_variables`` snapshot, no watermark,
overflow is a hard failure, hyperlink markers become genuine
clickable link annotations).

Design invariants (all enforced here or in the caller):

* Source PDF bytes are treated as read-only. The engine opens them
  via a ``BytesIO`` stream — the caller's buffer is never mutated.
* Character-tight redaction via ``token_bbox``; overlay placement via
  ``render_bbox``. This is the Phase 1B contract — Turn C reuses it.
* No fall-through: unknown ``data_type`` in ``issuance`` mode raises.
* Hyperlink values MUST arrive as ``{url, display, snapshot_id?, ...}``
  dicts. In ``issuance`` mode the URL is verified non-empty before
  annotation.
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

WATERMARK_TEXT = "PREVIEW - NOT FOR ISSUE"


class RenderError(Exception):
    """Raised by the engine when a strict-mode invariant fails —
    overflow, missing value, residual token, or hyperlink without
    a URL. The caller should abort and NOT persist any output."""

    def __init__(self, message: str, *, offenders: Optional[List[str]] = None):
        super().__init__(message)
        self.offenders = offenders or []


# ---------------------------------------------------------------------------
# Watermark (preview mode only)
# ---------------------------------------------------------------------------
def _draw_watermark(page: fitz.Page) -> None:
    rect = page.rect
    banner = f"- {WATERMARK_TEXT} -"
    for y in (rect.y0 + 26, rect.y1 - 18):
        band = fitz.Rect(rect.x0, y - 12, rect.x1, y + 12)
        page.insert_textbox(
            band, banner,
            fontsize=14, fontname="hebo",
            color=(0.82, 0.15, 0.15),
            align=1,
        )


# ---------------------------------------------------------------------------
# Value shape helpers
# ---------------------------------------------------------------------------
def _is_hyperlink_value(marker: Dict[str, Any], value: Any) -> bool:
    """A value is a hyperlink when either (a) the library data_type
    is ``hyperlink`` OR (b) the value itself is a dict carrying at
    least ``url`` + ``display`` keys. This dual detection lets Turn C
    handle both frozen-variable objects (Turn B output) and the
    Turn D UI-time preview shape."""
    if (marker.get("data_type") or "").lower() == "hyperlink":
        return True
    if isinstance(value, dict) and "url" in value and "display" in value:
        return True
    return False


# ---------------------------------------------------------------------------
# Overlay writers
# ---------------------------------------------------------------------------
def _write_string_value(
    page: fitz.Page,
    marker: Dict[str, Any],
    value: str,
    *,
    strict_overflow: bool,
) -> Dict[str, Any]:
    """Redact then draw a formatted string value. Returns a report row.

    When ``strict_overflow`` is true, an unfittable value raises
    ``RenderError`` instead of red-inking at the minimum font size.
    """
    legacy_bbox = marker.get("bbox") or []
    token_bbox = marker.get("token_bbox") or legacy_bbox
    render_bbox = marker.get("render_bbox") or legacy_bbox
    if len(token_bbox) != 4 or len(render_bbox) != 4:
        raise RenderError(
            f"Marker {marker.get('code')} has bad bbox metadata.",
            offenders=[str(marker.get('occurrence_id') or marker.get('code'))],
        )
    redact_rect = fitz.Rect(*token_bbox)
    overlay_rect = fitz.Rect(*render_bbox)

    # Overlay font — HQ override wins, otherwise resolver heuristic.
    weight = (marker.get("font_weight") or "normal") == "bold"
    italic = (marker.get("font_style") or "normal") == "italic"
    override_family = marker.get("overlay_font_family_override")
    if override_family:
        class _ForcedFR:
            overlay_family = override_family
            overlay_display = override_family
            substitution_required = True
        fr = _ForcedFR()
    else:
        fr = font_resolver.resolve_font(
            marker.get("font_family"),
            is_embedded=marker.get("is_embedded"),
            is_reusable=marker.get("is_reusable"),
            is_bold=weight,
            is_italic=italic,
        )

    # Apply redaction (character-tight so surrounding words survive).
    page.add_redact_annot(redact_rect, fill=(1, 1, 1))
    page.apply_redactions()

    # Casing transform on the value (Turn C.5 semantics).
    casing = (marker.get("casing") or "none").lower()
    if casing == "upper":
        value = value.upper()
    elif casing == "lower":
        value = value.lower()
    elif casing == "title":
        value = value.title()
    elif casing == "sentence" and value:
        value = value[0].upper() + value[1:].lower()

    # No-wrap widens the render rect ONLY for left/justify alignment
    # so right/center inline slots don't get pushed to the page edge.
    wrapping = (marker.get("wrapping") or "wrap").lower()
    alignment_name = (marker.get("alignment") or "left").lower()
    if wrapping == "no_wrap" and alignment_name in ("left", "justify"):
        overlay_rect = fitz.Rect(
            overlay_rect.x0, overlay_rect.y0,
            page.rect.x1 - 6, overlay_rect.y1,
        )

    # Max-line clamp.
    max_lines = marker.get("max_lines")
    if isinstance(max_lines, int) and max_lines > 0:
        parts = value.split("\n")
        if len(parts) > max_lines:
            value = "\n".join(parts[:max_lines])

    override = marker.get("font_size_override")
    size = float(override) if override is not None else float(marker.get("font_size") or 11)
    align_map = {"left": 0, "center": 1, "right": 2, "justify": 3}
    alignment = align_map.get(alignment_name, 0)
    min_size = float(marker.get("min_font_size") or 7)

    overflow = False
    current = size
    working_value = value
    if wrapping == "clip":
        while working_value:
            rc = page.insert_textbox(
                overlay_rect, working_value,
                fontname=fr.overlay_family,
                fontsize=current,
                align=alignment,
                color=(0, 0, 0),
            )
            if rc >= 0:
                break
            trimmed = working_value[:-2].rstrip() + "\u2026" if len(working_value) > 2 else "\u2026"
            if trimmed == working_value:
                overflow = True
                break
            working_value = trimmed
        else:
            overflow = True
    else:
        while current >= min_size:
            rc = page.insert_textbox(
                overlay_rect, value,
                fontname=fr.overlay_family,
                fontsize=current,
                align=alignment,
                color=(0, 0, 0),
            )
            if rc >= 0:
                break
            current -= 0.5
        else:
            overflow = True
            # In lenient/preview mode we still print at min_size in a
            # muted red so HQ notices. In strict mode the caller will
            # have already raised, but we keep the fallback for the
            # residual-token scan to see something.
            page.insert_textbox(
                overlay_rect, value,
                fontname=fr.overlay_family, fontsize=min_size,
                align=alignment, color=(0.6, 0, 0),
            )

    if overflow and strict_overflow:
        raise RenderError(
            f"Overflow on marker {marker.get('code')} p{marker.get('page')} — "
            "value did not fit at min_font_size. Fix render_bbox or "
            "shorten the value.",
            offenders=[str(marker.get('occurrence_id') or marker.get('code'))],
        )

    return {
        "code": marker.get("code"),
        "page": marker.get("page"),
        "occurrence_id": marker.get("occurrence_id"),
        "value_preview": (value or "")[:60],
        "overlay_family": fr.overlay_family,
        "overlay_display": fr.overlay_display,
        "substitution_required": fr.substitution_required,
        "final_size": round(current if not overflow else min_size, 1),
        "overflow": overflow,
        "used_split_bboxes": bool(marker.get("token_bbox") and marker.get("render_bbox")),
        "data_type": (marker.get("data_type") or "string").lower(),
        "ok": True,
    }


def _write_hyperlink_value(
    page: fitz.Page,
    marker: Dict[str, Any],
    value: Dict[str, Any],
    *,
    strict_overflow: bool,
) -> Dict[str, Any]:
    """Redact then draw the display text with a black underline AND
    attach a genuine clickable ``LINK_URI`` annotation covering the
    text rectangle. Preserves render_bbox as an inline slot — the
    display text is left-aligned by default so it hugs the surrounding
    paragraph, and its measured width defines the hyperlink hitbox.

    In strict mode a missing or empty URL raises ``RenderError``.
    """
    url = (value.get("url") or "").strip()
    display = (value.get("display") or "View link").strip() or "View link"
    if strict_overflow and not url:
        raise RenderError(
            f"Hyperlink marker {marker.get('code')} has an empty URL.",
            offenders=[str(marker.get('occurrence_id') or marker.get('code'))],
        )

    legacy_bbox = marker.get("bbox") or []
    token_bbox = marker.get("token_bbox") or legacy_bbox
    render_bbox = marker.get("render_bbox") or legacy_bbox
    if len(token_bbox) != 4 or len(render_bbox) != 4:
        raise RenderError(
            f"Hyperlink marker {marker.get('code')} has bad bbox metadata.",
        )
    redact_rect = fitz.Rect(*token_bbox)
    overlay_rect = fitz.Rect(*render_bbox)

    # Apply redaction.
    page.add_redact_annot(redact_rect, fill=(1, 1, 1))
    page.apply_redactions()

    # Font — hyperlinks stay in the same family as the surrounding text
    # to honour the "reads inline" invariant. HQ can override via
    # ``overlay_font_family_override`` per occurrence.
    override_family = marker.get("overlay_font_family_override")
    if override_family:
        font_name = override_family
    else:
        fr = font_resolver.resolve_font(
            marker.get("font_family"),
            is_embedded=marker.get("is_embedded"),
            is_reusable=marker.get("is_reusable"),
            is_bold=(marker.get("font_weight") or "normal") == "bold",
            is_italic=(marker.get("font_style") or "normal") == "italic",
        )
        font_name = fr.overlay_family

    override_size = marker.get("font_size_override")
    size = float(override_size) if override_size is not None else float(marker.get("font_size") or 11)
    min_size = float(marker.get("min_font_size") or size)
    alignment_name = (marker.get("alignment") or "left").lower()
    align_map = {"left": 0, "center": 1, "right": 2, "justify": 3}
    alignment = align_map.get(alignment_name, 0)

    # Measure display text at size — if it doesn't fit in the render
    # bbox width, shrink (in ``preview`` mode) or hard fail (strict).
    width_available = overlay_rect.width
    current = size
    while current >= min_size:
        text_w = fitz.get_text_length(display, fontname=font_name, fontsize=current)
        if text_w <= width_available + 0.1:
            break
        current -= 0.5
    else:
        if strict_overflow:
            raise RenderError(
                f"Hyperlink '{display}' overflows render_bbox for "
                f"{marker.get('code')} p{marker.get('page')}.",
                offenders=[str(marker.get('occurrence_id') or marker.get('code'))],
            )
        current = min_size

    text_w = fitz.get_text_length(display, fontname=font_name, fontsize=current)
    # Line-height factor used by PyMuPDF's insert_textbox is 1.2 —
    # the box we hand to insert_link must sit BELOW the baseline
    # to cover the descender room, so we anchor at the baseline and
    # inflate the hitbox to the render_bbox's height.
    y_baseline = overlay_rect.y0 + current * 1.0  # baseline near top of box
    # Clamp baseline to stay inside the render_bbox
    if y_baseline > overlay_rect.y1 - 1:
        y_baseline = overlay_rect.y1 - 1

    if alignment_name == "right":
        x0 = overlay_rect.x1 - text_w
    elif alignment_name == "center":
        x0 = overlay_rect.x0 + (width_available - text_w) / 2
    else:
        x0 = overlay_rect.x0
    x1 = x0 + text_w
    # Hyperlink hitbox spans the full render_bbox height so descenders
    # + a comfortable click target are covered.
    y0 = overlay_rect.y0
    y1 = overlay_rect.y1

    # Draw the display text at the baseline point. ``insert_text`` is
    # more reliable than ``insert_textbox`` for a single tight run.
    page.insert_text(
        fitz.Point(x0, y_baseline),
        display,
        fontname=font_name,
        fontsize=current,
        color=(0, 0, 0),
    )
    # Underline immediately below the baseline — thin, black.
    underline_y = y_baseline + max(1.0, current * 0.12)
    page.draw_line(
        fitz.Point(x0, underline_y),
        fitz.Point(x1, underline_y),
        color=(0, 0, 0),
        width=max(0.5, current * 0.07),
    )
    # Attach the URI annotation covering the display-text rect.
    if url:
        page.insert_link({
            "kind": fitz.LINK_URI,
            "from": fitz.Rect(x0, y0, x1, y1),
            "uri": url,
        })

    return {
        "code": marker.get("code"),
        "page": marker.get("page"),
        "occurrence_id": marker.get("occurrence_id"),
        "value_preview": display[:60],
        "overlay_family": font_name,
        "final_size": round(current, 1),
        "overflow": False,
        "used_split_bboxes": bool(marker.get("token_bbox") and marker.get("render_bbox")),
        "data_type": "hyperlink",
        "hyperlink": {
            "url": url,
            "display": display,
            "text_rect": [x0, y0, x1, y1],
            "snapshot_id": value.get("snapshot_id"),
            "url_sha256": value.get("url_sha256"),
        },
        "ok": True,
    }


def write_value(
    page: fitz.Page,
    marker: Dict[str, Any],
    value: Any,
    *,
    strict_overflow: bool = False,
) -> Dict[str, Any]:
    """Public single-marker write — dispatches by value shape or the
    marker's ``data_type``. Used by per-marker preview endpoints
    (Turn C.5) and by ``render()`` internally.
    """
    if _is_hyperlink_value(marker, value):
        if not isinstance(value, dict):
            value = {"url": "", "display": str(value)}
        return _write_hyperlink_value(page, marker, value, strict_overflow=strict_overflow)
    return _write_string_value(page, marker, str(value), strict_overflow=strict_overflow)


# ---------------------------------------------------------------------------
def render(
    source_bytes: bytes,
    markers: List[Dict[str, Any]],
    values_map: Dict[str, Any],
    *,
    mode: str = "preview",
    template_name: str = "template",
    strict_overflow: Optional[bool] = None,
    strict_missing_values: Optional[bool] = None,
    strict_residual_tokens: Optional[bool] = None,
    watermark: Optional[bool] = None,
    subject: Optional[str] = None,
    creator: Optional[str] = None,
) -> Tuple[bytes, Dict[str, Any]]:
    """Render markers over ``source_bytes`` and return (pdf_bytes, report).

    ``values_map`` maps ``marker.code`` → value. Values are either
    plain strings (for scalar types) or dicts (for hyperlinks).

    In ``mode='issuance'`` the following invariants are enforced and
    a ``RenderError`` is raised on any failure:

    * Every marker MUST have a value in ``values_map``.
    * Every hyperlink marker MUST have a non-empty URL.
    * No occurrence may overflow at ``min_font_size``.
    * The output PDF MUST contain zero residual ``[[`` tokens.
    * No PREVIEW watermark is drawn.

    ``mode='preview'`` keeps Phase 1B's lenient behaviour.
    """
    if mode not in {"preview", "issuance"}:
        raise ValueError(f"Unknown render mode: {mode!r}")

    # Resolve mode-dependent defaults — callers can still override.
    if strict_overflow is None:
        strict_overflow = (mode == "issuance")
    if strict_missing_values is None:
        strict_missing_values = (mode == "issuance")
    if strict_residual_tokens is None:
        strict_residual_tokens = (mode == "issuance")
    if watermark is None:
        watermark = (mode == "preview")

    values_map = dict(values_map or {})

    by_page: Dict[int, List[Dict[str, Any]]] = {}
    for m in markers:
        by_page.setdefault(int(m.get("page") or 1), []).append(m)

    src_stream = io.BytesIO(source_bytes)
    doc = fitz.open(stream=src_stream, filetype="pdf")

    report: Dict[str, Any] = {
        "mode": mode,
        "template_name": template_name,
        "page_count": doc.page_count,
        "occurrences": [],
        "hyperlinks": [],
        "watermark_pages": 0,
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }

    try:
        for page_num in range(1, doc.page_count + 1):
            page = doc[page_num - 1]
            for m in by_page.get(page_num, []):
                code = m.get("code") or ""
                if code not in values_map or values_map[code] in (None, ""):
                    if strict_missing_values:
                        raise RenderError(
                            f"Marker {code} p{m.get('page')} has no resolved value "
                            f"in the values_map. Issuance is blocked.",
                            offenders=[str(m.get("occurrence_id") or code)],
                        )
                    # Preview: skip silently (caller uses synthetic default upstream).
                    continue
                value = values_map[code]
                if _is_hyperlink_value(m, value):
                    if not isinstance(value, dict):
                        # Preview mode may pass a plain string — wrap.
                        value = {"url": "", "display": str(value)}
                    row = _write_hyperlink_value(page, m, value, strict_overflow=strict_overflow)
                    report["hyperlinks"].append(row["hyperlink"])
                else:
                    row = _write_string_value(page, m, str(value), strict_overflow=strict_overflow)
                report["occurrences"].append(row)

        if watermark:
            for page in doc:
                _draw_watermark(page)
                report["watermark_pages"] += 1

        # Metadata — preview vs. issuance labels
        if mode == "issuance":
            title = f"Personalised Contract - {template_name}"
            sub = subject or "Issued contract - Creative Mojo Hub"
            creator_name = creator or "Creative Mojo Hub - Contract Issuer"
        else:
            title = f"PREVIEW - {template_name}"
            sub = subject or "PREVIEW - NOT FOR ISSUE - Creative Mojo Hub"
            creator_name = creator or "Creative Mojo Hub - Sample Preview Generator"
        doc.set_metadata({
            "title":    title,
            "author":   "Creative Mojo Hub",
            "subject":  sub,
            "keywords": ("contract,issued,creative-mojo" if mode == "issuance"
                         else "preview,not-for-issue,sample,creative-mojo"),
            "producer": creator_name,
            "creator":  creator_name,
            "creationDate": fitz.get_pdf_now(),
            "modDate":  fitz.get_pdf_now(),
        })

        out_buf = io.BytesIO()
        doc.save(out_buf, deflate=True, garbage=3, clean=True)
        pdf_bytes = out_buf.getvalue()
    finally:
        doc.close()

    # Residual-token verification — walk the output text layer.
    verify_doc = fitz.open(stream=io.BytesIO(pdf_bytes), filetype="pdf")
    try:
        residual = 0
        for pg in verify_doc:
            txt = pg.get_text("text") or ""
            residual += txt.count("[[")
        report["residual_token_count"] = residual
        report["redaction_verified"] = residual == 0
        # Link annotation summary for auditing
        report["link_annotations"] = []
        for pg_i, pg in enumerate(verify_doc, start=1):
            for link in pg.get_links() or []:
                if link.get("kind") == fitz.LINK_URI:
                    r = link.get("from")
                    report["link_annotations"].append({
                        "page": pg_i,
                        "uri": link.get("uri"),
                        "rect": [r.x0, r.y0, r.x1, r.y1] if r else None,
                    })
    finally:
        verify_doc.close()

    if strict_residual_tokens and report["residual_token_count"] > 0:
        raise RenderError(
            f"{report['residual_token_count']} residual `[[` tokens remain "
            "in the output — some markers were not redacted cleanly.",
        )

    report["byte_size"] = len(pdf_bytes)
    return pdf_bytes, report


def sanitise_filename_component(name: str) -> str:
    """Turn a template name into a safe filename fragment."""
    stripped = re.sub(r"\.{2,}", "", name or "")
    clean = re.sub(r"[^A-Za-z0-9._-]+", "_", stripped.strip())
    return clean.strip("_.") or "template"
