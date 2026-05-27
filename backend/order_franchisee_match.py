"""Franchisee-order detection.

Tags each ``woo_orders`` row with the franchisee it likely belongs to so the
admin Orders page can visually separate franchisee orders from end-customer
orders.

Detection rules (per user spec):
    1. Email match — order ``customer_email`` matches the franchisee's
       ``mojo_email`` or ``secondary_email`` (case-insensitive, trimmed).
    2. Org-name fallback — order ``customer_label`` exactly matches (case-
       insensitive, whitespace-collapsed) the franchisee's ``organisation``.

A tiny TTL cache avoids re-querying the franchisees collection on every
request — refreshed every 60s, which is faster than admin appetite for new
franchisees + cheap regardless.
"""
from __future__ import annotations

import re
import time
from typing import Any

_CACHE_TTL_SEC = 60
_cache: dict[str, Any] = {"ts": 0.0, "by_email": {}, "by_org": {}}


def _norm(s: str | None) -> str:
    if not s:
        return ""
    return re.sub(r"\s+", " ", str(s).strip().lower())


async def _refresh_index(db) -> None:
    """Build the email→franchisee + org→franchisee lookup tables. Includes
    ex-franchisees so historic orders still group correctly."""
    by_email: dict[str, dict] = {}
    by_org: dict[str, dict] = {}
    async for f in db.franchisees.find(
        {},
        {"_id": 0, "id": 1, "organisation": 1, "first_name": 1, "last_name": 1,
         "mojo_email": 1, "secondary_email": 1, "tags": 1},
    ):
        ref = {
            "id": f.get("id"),
            "organisation": f.get("organisation") or (
                f"{f.get('first_name') or ''} {f.get('last_name') or ''}".strip()
                or "Franchisee"
            ),
            "is_ex": any(
                "ex" in str(t).lower() and "franchisee" in str(t).lower()
                for t in (f.get("tags") or [])
            ),
        }
        for k in ("mojo_email", "secondary_email"):
            v = _norm(f.get(k))
            if v:
                by_email.setdefault(v, ref)
        org = _norm(f.get("organisation"))
        if org:
            by_org.setdefault(org, ref)
    _cache["by_email"] = by_email
    _cache["by_org"] = by_org
    _cache["ts"] = time.time()


async def _ensure_index(db) -> None:
    if time.time() - _cache["ts"] > _CACHE_TTL_SEC:
        await _refresh_index(db)


def _match(order: dict) -> dict | None:
    email = _norm(order.get("customer_email"))
    if email and email in _cache["by_email"]:
        ref = _cache["by_email"][email]
        return {**ref, "matched_by": "email"}
    label = _norm(order.get("customer_label"))
    if label and label in _cache["by_org"]:
        ref = _cache["by_org"][label]
        return {**ref, "matched_by": "organisation"}
    return None


async def decorate_orders(db, items: list[dict]) -> list[dict]:
    """Add a ``franchisee_match`` field to every order in ``items``.

    Returns the same list (mutated in place + returned for ergonomics). The
    field is either ``None`` (end-customer order) or
    ``{id, organisation, is_ex, matched_by}``.
    """
    await _ensure_index(db)
    for o in items:
        o["franchisee_match"] = _match(o)
    return items


async def decorate_one(db, order: dict) -> dict:
    await _ensure_index(db)
    order["franchisee_match"] = _match(order)
    return order


def invalidate_cache() -> None:
    """Force a refresh on the next call. Useful in tests or after creating
    a new franchisee."""
    _cache["ts"] = 0.0
