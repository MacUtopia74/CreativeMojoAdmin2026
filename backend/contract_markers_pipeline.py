"""Deterministic marker detection engine for contract PDF templates.

No LLM, no reflow, no HTML conversion. Pure PyMuPDF text-layer analysis.

Public surface
--------------
    detect_markers(pdf_bytes) -> MarkerDetection

Returned dataclass:
    MarkerDetection
        pdf_page_count: int
        pdf_sha256: str                # of the exact input bytes
        markers: List[MarkerOccurrence]
        cross_line_errors: List[Dict]
        span_reconstruction_used: bool
        detection_ms: int

Design decisions
----------------
1. Every text token that matches `\\[\\[([A-Z][A-Z0-9_]{1,50})\\]\\]` is
   recorded with page number, bbox, font family, font size, weight,
   colour, embed status.
2. Words exports frequently break `[[MARKER]]` across two adjacent
   `Span` objects on the same baseline (typically at the second `[`).
   A pre-pass merges every consecutive span-pair on the same baseline
   that together yield a matchable token; failures are flagged
   `cross_line`, which never silently ignores them.
3. Inline-in-sentence markers (e.g. "This Agreement is made on
   [[AGREEMENT_DATE]].") are handled correctly — the marker still sits
   inside a single line so the reconstruction pass returns a clean bbox.
4. Font embed classification uses `page.get_fonts()` — a font present
   in the PDF font dictionary with an embedded stream is `is_embedded=True`.
   `is_reusable` is False whenever the PDF's font is a subset embed
   (very common with Word exports) — those cannot be reused for overlay
   text drawing, so a fallback is needed. This is captured now so the
   Phase 1B UI can surface it.
"""
from __future__ import annotations

import hashlib
import io
import logging
import re
import time
from dataclasses import dataclass, field, asdict
from typing import Any, Dict, List, Optional, Tuple

import fitz  # PyMuPDF

logger = logging.getLogger(__name__)

# Only allow uppercase alphanumerics and underscores; first character
# must be a letter. Length capped at 50 to match library validation.
MARKER_RE = re.compile(r"\[\[([A-Z][A-Z0-9_]{1,49})\]\]")

# When merging adjacent spans to reconstruct a split marker, we allow at
# most this many characters between the two spans. Word usually keeps
# them adjacent (no gap), but very rarely inserts a hair-thin spacer.
MAX_SPAN_GAP_CHARS = 4
MAX_SPAN_GAP_POINTS = 4.0  # roughly a hair space in a 10pt font


@dataclass
class MarkerOccurrence:
    code: str
    page: int                # 1-based
    # ``token_bbox`` — character-tight union around the ``[[MARKER_CODE]]``
    # glyphs only. Used *exclusively* for ``page.apply_redactions()`` so
    # surrounding text (e.g. "AGREEMENT DATED " preceding the token) is
    # never redacted alongside the token.
    token_bbox: Tuple[float, float, float, float] = (0.0, 0.0, 0.0, 0.0)
    # ``render_bbox`` — span-level union. Used for placing the overlay
    # value text. Initially matches ``token_bbox``; the Phase 1B UI will
    # let HQ resize/reposition this independently.
    render_bbox: Tuple[float, float, float, float] = (0.0, 0.0, 0.0, 0.0)
    # ``bbox`` — legacy field kept for backwards-compat with the marker
    # summary route + existing UI. Mirrors ``render_bbox``.
    bbox: Tuple[float, float, float, float] = (0.0, 0.0, 0.0, 0.0)
    font_family: Optional[str] = None
    font_size: Optional[float] = None
    font_weight: Optional[str] = None         # 'normal' | 'bold'
    font_style: Optional[str] = None          # 'normal' | 'italic'
    font_color: Optional[int] = None          # sRGB int
    is_embedded: Optional[bool] = None
    is_reusable: Optional[bool] = None        # False for subset embeds
    substitution_family: Optional[str] = None # nearest safe default
    reconstructed_from_split: bool = False
    raw_token: str = ""


@dataclass
class MarkerDetection:
    pdf_page_count: int
    pdf_sha256: str
    markers: List[MarkerOccurrence] = field(default_factory=list)
    cross_line_errors: List[Dict[str, Any]] = field(default_factory=list)
    span_reconstruction_used: bool = False
    detection_ms: int = 0

    def to_public_dict(self) -> Dict[str, Any]:
        return {
            "pdf_page_count": self.pdf_page_count,
            "pdf_sha256": self.pdf_sha256,
            "markers": [asdict(m) for m in self.markers],
            "cross_line_errors": self.cross_line_errors,
            "span_reconstruction_used": self.span_reconstruction_used,
            "detection_ms": self.detection_ms,
        }


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _sha256(data: bytes) -> str:
    h = hashlib.sha256()
    h.update(data)
    return h.hexdigest()


def _weight_and_style_from_flags(flags: int) -> Tuple[str, str]:
    """PyMuPDF span.flags bit map:
    16 = italic, 4 = superscript, 2 = serif, 20 = mono, 1 = superscript ..."""
    weight = "bold" if flags & 16 == 16 else "normal"
    # Actually the flag semantics per PyMuPDF docs:
    #   bit 0: superscript
    #   bit 1: italic
    #   bit 2: serif
    #   bit 3: mono
    #   bit 4: bold
    is_italic = bool(flags & 2)
    is_bold = bool(flags & 16)
    return ("bold" if is_bold else "normal"), ("italic" if is_italic else "normal")


def _substitution_family_for(font_name: Optional[str]) -> str:
    """Map an extracted (often subset-embedded) font name to a safe
    default the overlay engine can reliably reuse. Sans-serif default
    matches the spec (§Phase 1B default overlay font)."""
    if not font_name:
        return "Helvetica"
    lower = font_name.lower()
    if "times" in lower or "serif" in lower or "roman" in lower or "gara" in lower:
        return "Times-Roman"
    if "courier" in lower or "mono" in lower:
        return "Courier"
    return "Helvetica"


def _looks_embedded(page_fonts: List[Tuple], font_name: str) -> Tuple[bool, bool]:
    """Return (is_embedded, is_reusable). Reusable=False for subset embeds
    (name prefixed with `AAAAAA+` — a 6-char tag)."""
    if not font_name:
        return (False, False)
    for entry in page_fonts:
        # PyMuPDF returns (xref, ext, ftype, basefont, bname, encoding[, referencer])
        # depending on version + `full=True` flag. Be tolerant of both shapes.
        if len(entry) < 5:
            continue
        ext = entry[1]
        basefont = entry[3] or ""
        bname = entry[4] or ""
        candidates = {basefont, bname}
        if font_name in candidates or font_name.strip() in candidates:
            embedded = ext not in ("", None, "n/a")
            is_subset = bool(re.match(r"^[A-Z]{6}\+", basefont))
            return (embedded, embedded and not is_subset)
    return (False, False)


# ---------------------------------------------------------------------------
# Core detection
# ---------------------------------------------------------------------------
def _spans_on_baseline(spans: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Sort spans left-to-right on their baseline (same line)."""
    return sorted(spans, key=lambda s: s["bbox"][0])


def _reconstruct_and_scan_line(
    line_spans: List[Dict[str, Any]],
    page_num: int,
    page_fonts: List[Tuple],
) -> Tuple[List[MarkerOccurrence], bool]:
    """Reconstruct a single visual line into (concatenated_text, span_map)
    then regex the concatenation. For each hit, project back into the
    contributing spans and per-character bboxes to build BOTH:

      - ``token_bbox`` — union of just the per-character bboxes covering
        the ``[[MARKER_CODE]]`` glyphs. Used for redaction only.
      - ``render_bbox`` — union of the contributing spans' bboxes. Used
        for overlay text placement (gives Word's natural line-height /
        vertical padding so the personalised value renders like real text).

    Returns (occurrences, used_reconstruction).

    Note: ``line_spans`` are ``rawdict`` spans (each with ``chars``: a
    list of ``{'c': str, 'bbox': [x0,y0,x1,y1], ...}``). Falls back to
    the span bbox if per-character bboxes are unavailable.
    """
    line_spans = _spans_on_baseline(line_spans)
    if not line_spans:
        return [], False

    # Build a flat character stream with per-char bbox provenance.
    # Each element: (char, char_bbox_or_None, span_index)
    stream: List[Tuple[str, Optional[Tuple[float, float, float, float]], int]] = []
    for si, sp in enumerate(line_spans):
        chars = sp.get("chars") or []
        if chars:
            for ch in chars:
                c = ch.get("c") or ""
                bb = ch.get("bbox")
                if bb and len(bb) == 4:
                    stream.append((c, (float(bb[0]), float(bb[1]), float(bb[2]), float(bb[3])), si))
                else:
                    stream.append((c, None, si))
        else:
            # Fallback: no per-char data (shouldn't happen with rawdict
            # but be defensive). Attribute every char to the span bbox.
            t = sp.get("text") or ""
            sb = sp.get("bbox") or [0, 0, 0, 0]
            sb_tuple = (float(sb[0]), float(sb[1]), float(sb[2]), float(sb[3]))
            for ch in t:
                stream.append((ch, sb_tuple, si))

    if not stream:
        return [], False
    concat = "".join(c for c, _, _ in stream)
    if "[[" not in concat:
        return [], False

    occurrences: List[MarkerOccurrence] = []
    reconstructed_used = False
    for m in MARKER_RE.finditer(concat):
        start, end = m.span()
        code = m.group(1)
        span_indices = sorted({stream[i][2] for i in range(start, end)})
        spans_involved = [line_spans[i] for i in span_indices]
        if len(spans_involved) > 1:
            reconstructed_used = True

        # ---- token_bbox: character-tight union across the token glyphs
        char_bboxes = [stream[i][1] for i in range(start, end) if stream[i][1] is not None]
        if char_bboxes:
            tx0 = min(bb[0] for bb in char_bboxes)
            ty0 = min(bb[1] for bb in char_bboxes)
            tx1 = max(bb[2] for bb in char_bboxes)
            ty1 = max(bb[3] for bb in char_bboxes)
        else:
            # Fallback — span union (legacy behaviour). This is the
            # ONLY branch that could redact surrounding text; we only
            # hit it if per-char geometry is missing.
            tx0 = min(s["bbox"][0] for s in spans_involved)
            ty0 = min(s["bbox"][1] for s in spans_involved)
            tx1 = max(s["bbox"][2] for s in spans_involved)
            ty1 = max(s["bbox"][3] for s in spans_involved)
        # Tiny inflate to guarantee glyph coverage against subpixel drift
        tx0 -= 0.4; ty0 -= 0.4; tx1 += 0.4; ty1 += 0.4

        # ---- render_bbox: span-level union (matches original behaviour)
        rx0 = min(s["bbox"][0] for s in spans_involved)
        ry0 = min(s["bbox"][1] for s in spans_involved)
        rx1 = max(s["bbox"][2] for s in spans_involved)
        ry1 = max(s["bbox"][3] for s in spans_involved)
        # Constrain render_bbox horizontally to the token area — Word
        # frequently glues neighbouring words into the same span so the
        # span bbox extends well beyond the token. Vertically we KEEP
        # the span extent (so line-height/ascender is preserved).
        rx0 = max(rx0, tx0 - 0.4)
        rx1 = min(rx1, tx1 + 0.4)

        # Font metadata comes from the first contributing span (all
        # contributing spans should share the same font for a legitimate
        # marker; if they differ we still pick the dominant one).
        primary = max(spans_involved, key=lambda s: sum(len((ch.get("c") or "")) for ch in (s.get("chars") or [])) or len(s.get("text") or ""))
        font_name = primary.get("font") or None
        font_size = primary.get("size")
        flags = primary.get("flags", 0)
        color = primary.get("color", 0)
        weight, style = _weight_and_style_from_flags(flags)
        is_embedded, is_reusable = _looks_embedded(page_fonts, font_name or "")
        subst = _substitution_family_for(font_name)

        token_bbox = (round(tx0, 3), round(ty0, 3), round(tx1, 3), round(ty1, 3))
        render_bbox = (round(rx0, 3), round(ry0, 3), round(rx1, 3), round(ry1, 3))

        occurrences.append(MarkerOccurrence(
            code=code,
            page=page_num,
            token_bbox=token_bbox,
            render_bbox=render_bbox,
            bbox=render_bbox,  # legacy mirror
            font_family=font_name,
            font_size=round(float(font_size), 2) if font_size is not None else None,
            font_weight=weight,
            font_style=style,
            font_color=int(color) if color is not None else None,
            is_embedded=is_embedded,
            is_reusable=is_reusable,
            substitution_family=subst,
            reconstructed_from_split=(len(spans_involved) > 1),
            raw_token=m.group(0),
        ))

    return occurrences, reconstructed_used


def _scan_for_cross_line_errors(page_text_lines: List[str], page_num: int) -> List[Dict[str, Any]]:
    """Detect any `[[...` that opens but doesn't close on the same line,
    or any `...]]` that closes without an opener on the same line. These
    are guaranteed to fail regex above and must be surfaced.
    """
    errors: List[Dict[str, Any]] = []
    open_bracket = "[["
    close_bracket = "]]"
    for line_no, line in enumerate(page_text_lines, start=1):
        # Openers without close
        i = 0
        while True:
            oi = line.find(open_bracket, i)
            if oi == -1:
                break
            ci = line.find(close_bracket, oi + 2)
            if ci == -1:
                errors.append({
                    "page": page_num,
                    "line_no": line_no,
                    "kind": "unterminated_open_bracket",
                    "snippet": line[oi:oi + 40],
                })
                break
            i = ci + 2
        # Orphan closers
        i = 0
        while True:
            ci = line.find(close_bracket, i)
            if ci == -1:
                break
            oi = line.rfind(open_bracket, 0, ci)
            if oi == -1:
                errors.append({
                    "page": page_num,
                    "line_no": line_no,
                    "kind": "orphan_close_bracket",
                    "snippet": line[max(0, ci - 30):ci + 2],
                })
            i = ci + 2
    return errors


def detect_markers(pdf_bytes: bytes) -> MarkerDetection:
    """Public entry point — deterministic marker detection.

    Never mutates ``pdf_bytes``; every mutation happens on a PyMuPDF
    in-memory copy that is discarded after read-only span extraction.
    """
    t0 = time.perf_counter()
    result = MarkerDetection(
        pdf_page_count=0,
        pdf_sha256=_sha256(pdf_bytes),
    )

    try:
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    except Exception as exc:  # noqa: BLE001
        logger.exception("Failed to open PDF for marker detection")
        raise ValueError(f"Not a valid PDF file: {exc}") from exc

    try:
        result.pdf_page_count = doc.page_count
        for page_index in range(doc.page_count):
            page_num = page_index + 1
            page = doc[page_index]
            page_fonts = page.get_fonts(full=True) or []

            # Extract structured text WITH per-character bboxes.
            # ``rawdict`` gives us ``chars`` inside each span — critical
            # for computing character-tight ``token_bbox`` values so the
            # subsequent redaction pass never touches surrounding text.
            page_dict = page.get_text("rawdict")
            page_lines_text: List[str] = []
            for block in page_dict.get("blocks", []):
                if block.get("type") != 0:  # not text
                    continue
                for line in block.get("lines", []):
                    spans = line.get("spans", [])
                    # Build the visual line text (rawdict spans don't
                    # expose ``text`` — reconstruct from chars).
                    line_text = "".join(
                        (ch.get("c") or "")
                        for sp in spans for ch in (sp.get("chars") or [])
                    )
                    page_lines_text.append(line_text)
                    # Marker scan for this visual line
                    occs, used = _reconstruct_and_scan_line(spans, page_num, page_fonts)
                    if used:
                        result.span_reconstruction_used = True
                    result.markers.extend(occs)

            # Cross-line / orphan-bracket detection
            errs = _scan_for_cross_line_errors(page_lines_text, page_num)
            result.cross_line_errors.extend(errs)
    finally:
        doc.close()

    result.detection_ms = int((time.perf_counter() - t0) * 1000)
    return result


# ---------------------------------------------------------------------------
# Reconciliation with the Marker Library
# ---------------------------------------------------------------------------
def build_marker_summary(
    occurrences: List[MarkerOccurrence],
    cross_line_errors: List[Dict[str, Any]],
    library_docs: List[Dict[str, Any]],
    contract_type: str,
    template_required_codes: Optional[List[str]] = None,
) -> Dict[str, Any]:
    """Reconcile detected markers with the library. Returns a dict
    suitable for storage on the template document.

    Amendment #2 — Independent flags:
        library.available            → present + not hidden
        library.eligible[]           → contract_type in eligible_contract_types
        template_required[]          → explicit template-level flag
        contract_field.required[]    → resolved at issue time (Phase 2)
    """
    # Index library by code, ignoring hidden entries
    lib_index: Dict[str, Dict[str, Any]] = {}
    for m in library_docs:
        if m.get("hidden"):
            continue
        lib_index[m["code"]] = m

    template_required = set(template_required_codes or [])

    # Aggregate detected codes
    counts: Dict[str, int] = {}
    for occ in occurrences:
        counts[occ.code] = counts.get(occ.code, 0) + 1

    recognised: List[str] = []
    unrecognised: List[str] = []
    not_eligible_for_type: List[str] = []
    duplicate_offenders: List[Dict[str, Any]] = []
    template_required_missing: List[str] = []

    for code, n in counts.items():
        entry = lib_index.get(code)
        if not entry:
            unrecognised.append(code)
            continue
        eligible = contract_type in (entry.get("eligible_contract_types") or [])
        if not eligible:
            not_eligible_for_type.append(code)
            continue
        recognised.append(code)
        # Duplicate check — only if repeat_allowed is explicitly False
        if not entry.get("repeat_allowed", False) and n > 1:
            duplicate_offenders.append({"code": code, "count": n})

    # Template-required-missing check — code required for this template
    # BUT no occurrence was detected in the PDF.
    for code in template_required:
        if code not in counts:
            template_required_missing.append(code)

    ready_for_approval = (
        len(unrecognised) == 0
        and len(cross_line_errors) == 0
        and len(duplicate_offenders) == 0
        and len(template_required_missing) == 0
    )

    return {
        "total_occurrences": sum(counts.values()),
        "unique_codes": len(counts),
        "detected_codes": sorted(counts.keys()),
        "counts_by_code": counts,
        "recognised": sorted(recognised),
        "unrecognised": sorted(unrecognised),
        "not_eligible_for_type": sorted(not_eligible_for_type),
        "duplicate_offenders": duplicate_offenders,
        "template_required_missing": sorted(template_required_missing),
        "cross_line_errors_count": len(cross_line_errors),
        "ready_for_approval": ready_for_approval,
    }


def occurrences_for_storage(occs: List[MarkerOccurrence]) -> List[Dict[str, Any]]:
    """Convert to a JSON-safe list ready for MongoDB persistence.

    Also snapshots the library definition alongside each detection so
    historic template versions continue to resolve the *definition used
    at the time* (amendment #2 + immutability guarantee)."""
    out: List[Dict[str, Any]] = []
    for o in occs:
        d = asdict(o)
        d["token_bbox"] = list(d.get("token_bbox") or [])
        d["render_bbox"] = list(d.get("render_bbox") or [])
        d["bbox"] = list(d.get("bbox") or [])
        out.append(d)
    return out
