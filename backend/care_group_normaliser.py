"""Provider-name normalisation used to link homes into Care Groups.

Two CIW rows owned by the same operator can drift in casing or legal
suffix — ``Hallmark Care Homes Ltd`` vs ``Hallmark Care Homes Limited``.
Without normalisation each spelling fragments the Care Groups breakdown
on My Territory+.

Kept intentionally tiny + side-effect free so any importer (CIW,
Scotland, RQIA, future CQC re-ingest) can call into the same logic.
"""
from __future__ import annotations

import re

_SUFFIXES = (
    "limited", "ltd", "llp", "plc", "cic", "c.i.c", "uk",
    "co", "company", "group", "the",
)
_PUNCT_RE = re.compile(r"[^a-z0-9]+")


def normalise_provider_name(raw: str) -> str:
    """Return a stable key for a provider/operator name.

    Strips legal suffixes, punctuation, case and whitespace so trivial
    variants collapse to the same key. Empty input → empty string.

    Examples:
        normalise_provider_name("Hallmark Care Homes Limited")
            == normalise_provider_name("Hallmark Care Homes Ltd.")
            == "hallmarkcarehomes"
    """
    if not raw:
        return ""
    s = str(raw).lower()
    # Collapse punctuation to a single space so suffix detection works.
    s = _PUNCT_RE.sub(" ", s).strip()
    tokens = s.split()
    # Drop trailing legal suffixes — and keep stripping while the new
    # tail is itself a suffix (handles "Foo Care Group Limited").
    while tokens and tokens[-1] in _SUFFIXES:
        tokens.pop()
    return "".join(tokens)
