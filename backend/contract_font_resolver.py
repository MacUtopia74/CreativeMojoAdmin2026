"""Deterministic source-font → overlay-font resolver.

Pure function. Given the font metadata captured at marker-detection time
(family, embed status, reusable flag), return the concrete overlay font
name that Phase 1B/1C will use to write the personalised value.

Targets are the PyMuPDF Base 14 fonts (always available, no font-file
distribution needed): helv, heit, hebo, hebi, tiro, tibo, tiit, tibi,
cour, cobo, coit, cobi, symb, zadb.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional
import re


@dataclass
class FontResolution:
    source_family: Optional[str]
    overlay_family: str        # PyMuPDF short name (e.g. "helv", "tiro")
    overlay_display: str       # Human-readable (e.g. "Helvetica")
    substitution_required: bool
    reason: str                # brief label surfaced to HQ


_FAMILY_PATTERNS = [
    # (compiled regex on lowercased source family, base-name, display)
    (re.compile(r"times|serif|roman|garamond|cambria|georgia|nimbus.?rom"),
     "tiro", "Times-Roman"),
    (re.compile(r"cour|mono|consolas|inconsolata"),
     "cour", "Courier"),
    (re.compile(r"symb"), "symb", "Symbol"),
    (re.compile(r"zapf|dingbat"), "zadb", "ZapfDingbats"),
    # Default sans-serif catch-all: Helvetica
]

_BOLD_ITALIC_SUFFIX = {
    ("tiro", False, False): ("tiro", "Times-Roman"),
    ("tiro", True,  False): ("tibo", "Times-Bold"),
    ("tiro", False, True):  ("tiit", "Times-Italic"),
    ("tiro", True,  True):  ("tibi", "Times-BoldItalic"),
    ("helv", False, False): ("helv", "Helvetica"),
    ("helv", True,  False): ("hebo", "Helvetica-Bold"),
    ("helv", False, True):  ("heit", "Helvetica-Oblique"),
    ("helv", True,  True):  ("hebi", "Helvetica-BoldOblique"),
    ("cour", False, False): ("cour", "Courier"),
    ("cour", True,  False): ("cobo", "Courier-Bold"),
    ("cour", False, True):  ("coit", "Courier-Oblique"),
    ("cour", True,  True):  ("cobi", "Courier-BoldOblique"),
    ("symb", False, False): ("symb", "Symbol"),
    ("zadb", False, False): ("zadb", "ZapfDingbats"),
}


def resolve_font(
    source_family: Optional[str],
    *,
    is_embedded: Optional[bool],
    is_reusable: Optional[bool],
    is_bold: bool = False,
    is_italic: bool = False,
) -> FontResolution:
    """Return the concrete overlay font the preview/production engine
    will use. Preview must render using this exact font."""
    lower = (source_family or "").lower()

    # Pick the base family
    base = "helv"   # sans-serif default catch-all
    base_display = "Helvetica"
    for pat, name, disp in _FAMILY_PATTERNS:
        if pat.search(lower):
            base = name
            base_display = disp
            break

    # Apply bold/italic variant
    variant = _BOLD_ITALIC_SUFFIX.get((base, is_bold, is_italic))
    if variant is None:
        variant = _BOLD_ITALIC_SUFFIX.get((base, False, False), (base, base_display))
    overlay_name, overlay_display = variant

    # HQ acknowledgement is only required when the source font IS
    # embedded but as a non-reusable subset — that is the visible
    # substitution HQ must sign off on. When the source isn't
    # embedded at all, the Base14 fallback is the natural / expected
    # rendering path and no acknowledgement is needed. This
    # definition matches the Marker Review UI's family-group
    # rollup (see ``_build_substitution_groups``) so the manifest
    # in the Stop Point 3 evidence pack agrees with the UI.
    substitution_required = bool(is_embedded) and not bool(is_reusable)
    if substitution_required:
        reason = "source font embedded as subset — not reusable"
    elif is_embedded is False:
        reason = "source font not embedded — Base14 fallback (no acknowledgement needed)"
    elif not source_family:
        reason = "no source font detected — using default"
    else:
        reason = "source font can be reused"

    return FontResolution(
        source_family=source_family,
        overlay_family=overlay_name,
        overlay_display=overlay_display,
        substitution_required=substitution_required,
        reason=reason,
    )


def substitution_group_signature(
    source_family: Optional[str],
    overlay_family: str,
    source_size: Optional[float],
    is_bold: bool,
) -> str:
    """Deterministic key HQ can bulk-acknowledge on."""
    sz = round(float(source_size) if source_size else 0, 1)
    return f"{(source_family or '').lower()}::{overlay_family}::{sz}::{'b' if is_bold else 'r'}"
