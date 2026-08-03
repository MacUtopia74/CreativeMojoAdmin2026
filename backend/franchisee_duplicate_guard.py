"""Shared helpers for detecting duplicate franchise_numbers.

Franchise numbers must be unique across active franchisees. Until the
production database is reconciled and a unique index can be safely
added (see ``scripts/add_unique_franchise_number_index.py``), the app
must:

  * never PATCH a franchisee onto an already-used franchise_number;
  * never silently pick "one" record when a franchise-number lookup
    resolves to more than one franchisee;
  * never complete a file upload whose franchisee deduction is
    ambiguous — the row would end up mis-bound and invisible in the
    portal.

The functions in this module are the single source of truth for those
checks so route handlers stay small and consistent.
"""
from __future__ import annotations

import re
from typing import Any, Iterable, Optional


def _normalise_franchise_number(value: Any) -> Optional[str]:
    """Return the canonical 4-digit string form of a franchise number
    ("46" → "0046", 46 → "0046") or ``None`` if the value can't be
    interpreted as a positive integer. Non-numeric labels (e.g. "DEMO")
    are returned as-is, upper-cased and stripped, because they exist in
    the seed franchisees collection."""
    if value is None:
        return None
    if isinstance(value, int):
        return str(value).zfill(4)
    s = str(value).strip()
    if not s:
        return None
    if re.fullmatch(r"\d{1,6}", s):
        return s.zfill(4)
    return s.upper()


def _query_variants_for_franchise_number(value: Any) -> list[Any]:
    """Return every stored variant Mongo might have for this number.
    A franchise number like ``46`` may historically live as ``"46"``,
    ``"0046"`` or the integer ``46`` — historical imports were mixed.
    """
    norm = _normalise_franchise_number(value)
    if norm is None:
        return []
    out: list[Any] = [norm]
    # Un-padded string form (e.g. "46")
    stripped = norm.lstrip("0") or "0"
    if stripped != norm:
        out.append(stripped)
    # Integer form (only for purely-numeric labels).
    if re.fullmatch(r"\d+", norm):
        try:
            out.append(int(norm))
        except ValueError:
            pass
    # Remove dupes preserving order.
    seen: set[Any] = set()
    unique: list[Any] = []
    for v in out:
        if v in seen:
            continue
        seen.add(v)
        unique.append(v)
    return unique


async def find_franchisees_by_number(db, value: Any) -> list[dict]:
    """Return **all** franchisees whose franchise_number matches
    ``value`` (across every stored form). Sorted by created_at ASC so
    the oldest record is listed first — makes it obvious which one
    "should" have kept the number if the caller has to reconcile.
    """
    variants = _query_variants_for_franchise_number(value)
    if not variants:
        return []
    cur = db.franchisees.find({"franchise_number": {"$in": variants}}, {"_id": 0})
    rows = await cur.to_list(50)
    rows.sort(key=lambda r: (str(r.get("created_at") or ""), str(r.get("id") or "")))
    return rows


async def has_duplicate_franchise_number(
    db, value: Any, *, exclude_franchisee_id: Optional[str] = None,
) -> Optional[dict]:
    """Return the FIRST *other* franchisee that already uses ``value``,
    or ``None`` if the number is free (ignoring ``exclude_franchisee_id``
    for the case where a franchisee is PATCHing themselves).
    """
    rows = await find_franchisees_by_number(db, value)
    for r in rows:
        if exclude_franchisee_id and r.get("id") == exclude_franchisee_id:
            continue
        return r
    return None


async def find_duplicate_groups(db) -> list[dict]:
    """Return every group of ≥2 franchisees that share a
    franchise_number, grouped by the normalised form so
    ``"46" / "0046" / 46`` collapse together.
    """
    cur = db.franchisees.find(
        {"franchise_number": {"$nin": [None, ""]}},
        {"_id": 0},
    )
    all_rows = await cur.to_list(5000)
    groups: dict[str, list[dict]] = {}
    for f in all_rows:
        norm = _normalise_franchise_number(f.get("franchise_number"))
        if not norm:
            continue
        groups.setdefault(norm, []).append(f)
    return [
        {"franchise_number": k, "records": v}
        for k, v in groups.items() if len(v) > 1
    ]


def summarise_franchisee_for_conflict(f: dict) -> dict:
    """Slim, safe subset of a franchisee document for surfacing in a
    409 response or a duplicates report. No secrets, no big lists.
    """
    return {
        "id": f.get("id"),
        "franchise_number": f.get("franchise_number"),
        "organisation": f.get("organisation"),
        "first_name": f.get("first_name"),
        "last_name": f.get("last_name"),
        "email": f.get("email"),
        "mojo_email": f.get("mojo_email"),
        "status": f.get("status"),
        "created_at": f.get("created_at"),
        "converted_from_contact_id": f.get("converted_from_contact_id"),
        "r2_root_prefix": f.get("r2_root_prefix"),
    }
