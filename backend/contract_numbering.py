"""Authoritative multi-level legal numbering.

Backend is the source of truth for numbering on every render that leaves
the editor (final PDF preview, issuance in Phase 2, signed copies in
Phase 3). The frontend has a matching utility for instant in-editor
preview, but the browser is never trusted.

Rules (Section 9 of the spec):

- Numbering only runs when the template is ``conversion_approved``.
- Multi-level headings: sequential ``<h1>`` sections start at 1, 2, 3;
  each ``<h2>`` inside a section gets 1.1, 1.2…; each ``<h3>`` gets
  1.1.1, 1.1.2…; and so on down to ``<h6>``.
- ``<ol>`` list items nested under a numbered heading count as clauses.
  We label them ``(a) (b) (c)`` at first depth, ``(i) (ii) (iii)`` at
  second, ``(A) (B)`` at third. Deeper is left as HTML default.
- Any heading or list carrying ``data-num-skip="true"`` is left alone
  (used for schedules / appendices / signature blocks).
- Numbers are inserted as ``<span class="cm-generated-num">1.2</span>``
  at the start of the heading text so the CSS can space them nicely and
  the strip-back step for future renders is a single regex.
"""
from __future__ import annotations

import re
from typing import List

from lxml import html as lxml_html
from lxml.etree import _Element


HEADING_LEVELS = ("h1", "h2", "h3", "h4", "h5", "h6")
_GEN_NUM_RE = re.compile(
    r'<span[^>]*class="[^"]*cm-generated-num[^"]*"[^>]*>.*?</span>\s*',
    re.IGNORECASE | re.DOTALL,
)


def strip_generated_numbers(html: str) -> str:
    """Remove any previously-inserted ``cm-generated-num`` spans so the
    utility is idempotent — safe to call repeatedly on the same HTML."""
    return _GEN_NUM_RE.sub("", html or "")


def _letter_label(idx: int) -> str:
    """1 -> a, 2 -> b, 26 -> z, 27 -> aa. Zero-indexed ``idx`` starts at 0."""
    out = ""
    n = idx
    while True:
        n, r = divmod(n, 26)
        out = chr(ord("a") + r) + out
        if n == 0:
            break
        n -= 1
    return out


def _roman(n: int) -> str:
    numerals = [
        (1000, "m"), (900, "cm"), (500, "d"), (400, "cd"),
        (100, "c"),  (90, "xc"),  (50, "l"),  (40, "xl"),
        (10, "x"),   (9, "ix"),   (5, "v"),   (4, "iv"),
        (1, "i"),
    ]
    out = ""
    for value, sym in numerals:
        while n >= value:
            out += sym
            n -= value
    return out


def _clause_label(depth: int, idx: int) -> str:
    """OL clause labels: depth 0 = (a), depth 1 = (i), depth 2 = (A), else numeric."""
    idx0 = idx  # 0-based
    if depth == 0:
        return f"({_letter_label(idx0)})"
    if depth == 1:
        return f"({_roman(idx0 + 1)})"
    if depth == 2:
        return f"({_letter_label(idx0).upper()})"
    return f"({idx0 + 1})"


def _skip(el: _Element) -> bool:
    return (el.get("data-num-skip") or "").strip().lower() in {"true", "1", "yes"}


def _prepend_generated_span(el: _Element, text: str) -> None:
    """Insert ``<span class="cm-generated-num">TEXT</span>`` at the very
    start of ``el``'s content, preserving whatever was there."""
    span = lxml_html.fragment_fromstring(
        f'<span class="cm-generated-num">{text}</span>', create_parent=False,
    )
    span.tail = (el.text or "")
    el.text = None
    el.insert(0, span)


def apply_legal_numbering(html: str) -> str:
    """Return the input HTML with authoritative numbers injected into
    every ``<h1>``..``<h6>`` and ``<ol>``/``<li>``.

    Idempotent: strips any previous numbers first.
    """
    if not html or not html.strip():
        return html or ""

    # Idempotent — clear old numbers before writing new ones.
    html = strip_generated_numbers(html)

    # Wrap the fragment in a root so lxml gives us a single tree to
    # walk. We keep it plain HTML (not XHTML) — legal docs are pasted
    # from Word / Google Docs and often lack tight XML.
    doc = lxml_html.fragment_fromstring(html, create_parent="div")

    # Sequential counters, one per heading level. Index 0 = h1.
    counters = [0, 0, 0, 0, 0, 0]

    # Walk headings in document order and label them.
    for el in doc.iter():
        tag = el.tag.lower() if isinstance(el.tag, str) else ""
        if tag not in HEADING_LEVELS:
            continue
        level = int(tag[1]) - 1  # h1 -> 0
        if _skip(el):
            continue
        counters[level] += 1
        # Reset deeper counters.
        for i in range(level + 1, len(counters)):
            counters[i] = 0
        # Compose e.g. "1.2.1" from levels 0..level.
        label = ".".join(str(counters[i]) for i in range(level + 1) if counters[i] > 0)
        if label:
            _prepend_generated_span(el, label + ".")

    # Now walk any ``<ol>`` lists and label their direct ``<li>`` children.
    # Depth = number of ancestor ``<ol>`` nodes.
    def ol_depth(node: _Element) -> int:
        d = 0
        p = node.getparent()
        while p is not None:
            if isinstance(p.tag, str) and p.tag.lower() == "ol":
                d += 1
            p = p.getparent()
        return d

    for ol in doc.iter("ol"):
        if _skip(ol):
            continue
        depth = ol_depth(ol)
        for i, li in enumerate(x for x in ol if isinstance(x.tag, str) and x.tag.lower() == "li"):
            if _skip(li):
                continue
            _prepend_generated_span(li, _clause_label(depth, i))

    # Serialise back. lxml wraps in the ``div`` we added — unwrap it.
    out = lxml_html.tostring(doc, encoding="unicode", method="html")
    inner = re.sub(r"^\s*<div>|</div>\s*$", "", out, count=2)
    return inner


def strip_imported_numbers(html: str) -> str:
    """Remove every ``<span class="cm-original-num">…</span>`` element
    (including its text) from the stored HTML.

    Called from ``approve-conversion`` once HQ has verified the imported
    numbers match the source PDF. After the strip runs, the authoritative
    numbering utility owns the numbers on every render.
    """
    if not html or not html.strip():
        return html or ""
    doc = lxml_html.fragment_fromstring(html, create_parent="div")
    for span in doc.xpath('.//span[contains(@class, "cm-original-num")]'):
        parent = span.getparent()
        if parent is None:
            continue
        # If the span has tail text (whitespace / punctuation), preserve
        # it by attaching to the previous sibling / parent so we don't
        # accidentally chop off an actual document character.
        tail = (span.tail or "")
        idx = list(parent).index(span)
        parent.remove(span)
        if tail:
            if idx > 0:
                prev = list(parent)[idx - 1]
                prev.tail = (prev.tail or "") + tail
            else:
                parent.text = (parent.text or "") + tail
    # Trim leading whitespace / period-space left after span removal
    # inside headings and li text.
    for el in doc.iter():
        if not isinstance(el.tag, str):
            continue
        if el.tag.lower() in {"h1", "h2", "h3", "h4", "h5", "h6", "li"} and el.text:
            el.text = re.sub(r"^\s*[\.\)]?\s*", "", el.text)
    out = lxml_html.tostring(doc, encoding="unicode", method="html")
    return re.sub(r"^\s*<div>|</div>\s*$", "", out, count=2)


__all__ = [
    "apply_legal_numbering",
    "strip_generated_numbers",
    "strip_imported_numbers",
]
