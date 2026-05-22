"""Shared postcode helpers used by BOTH the CQC + Scotland routers.

Splitting this out lets ``cqc_routes`` and ``scotland_routes`` each
import the helper from a third module instead of importing each other —
removing the circular-import shape the static analyser flagged.

Kept deliberately tiny: just the postcode classifier + the standard
Scottish prefix set. Anything definition-specific stays in its own
router module.
"""
from __future__ import annotations

import re
from typing import Optional

# Scottish UK postcode prefixes (district letter portion). The full list
# is duplicated here so both routers + territory_routes can call into
# ``is_scottish_postcode`` without any cross-module chatter.
SCOTTISH_PREFIXES: tuple[str, ...] = (
    "AB", "DD", "DG", "EH", "FK", "G", "HS", "IV", "KA", "KW",
    "KY", "ML", "PA", "PH", "TD", "ZE",
)


def is_scottish_postcode(postcode: Optional[str]) -> bool:
    """True when a postcode (or sector / district) belongs to Scotland.

    Defensive against "GA" / "GU" / "GL" — only ``G`` followed by a
    digit is Glasgow. Same defence applies for every 1-letter prefix
    in the list (only "G" qualifies today, kept generic for safety)."""
    if not postcode:
        return False
    s = re.sub(r"\s+", "", str(postcode).upper())
    for p in SCOTTISH_PREFIXES:
        if not s.startswith(p):
            continue
        nxt = s[len(p) : len(p) + 1]
        if nxt.isdigit():
            return True
    return False
