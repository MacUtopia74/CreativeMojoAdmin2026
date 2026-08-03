"""Phase 3 — Auto-bootstrap R2 folder structure for franchisees.

Every franchisee gets a single, immutable canonical R2 prefix
``franchisees/<number>-<org-slug>-<name-slug>/`` with three standard
sub-folders (see ``STANDARD_FOLDERS``). The canonical prefix is
persisted on the franchisee document as ``r2_root_prefix`` the first
time we bootstrap folders, and from that point on it MUST NOT change —
renaming the organisation, updating the franchise number, changing the
first/last name, etc. all leave the R2 root untouched. This keeps every
file bound to a single stable root regardless of how the franchisee's
public-facing details evolve.

Historical (pre-canonicalisation) rows in ``files_index`` may still
live under legacy slug prefixes. The lazy back-fill logic in
``resolve_and_persist_canonical_prefix`` picks the populated slug when
multiple exist, so we never silently strand a franchisee's files
behind an empty second root.

The folders themselves are represented in R2 by a single zero-byte
``.keep`` placeholder per sub-folder (same convention as elsewhere in
the app — see files_routes.create_folder). They're indexed in
``files_index`` with ``hidden=True`` so they don't show up as files in
the admin browser but still cause the parent folder to appear in
``tree``.
"""
from __future__ import annotations

import logging
import re
from datetime import datetime, timezone
from typing import Optional

from file_storage import (
    R2_BUCKET, get_client, franchisee_folder_key,
    SCOPE_FRANCHISEE, r2_configured,
)

logger = logging.getLogger("creative-mojo-admin.franchisee_folders")

STANDARD_FOLDERS = ["Artwork", "Franchise Documents", "Other Files"]


def compute_fresh_franchisee_prefix(f: dict) -> Optional[str]:
    """Compute a fresh R2 prefix from the franchisee's current fields.
    Kept pure so callers that just want to inspect what the slug WOULD
    look like (e.g. the diagnostic) can call this without side-effects.
    Prefer :func:`canonical_franchisee_prefix` for anything that reads
    or writes files."""
    slug = franchisee_folder_key(
        f.get("franchise_number"),
        f.get("organisation"),
        f.get("first_name"),
        f.get("last_name"),
    )
    return f"franchisees/{slug}" if slug else None


def canonical_franchisee_prefix(f: dict) -> Optional[str]:
    """Return the persisted canonical R2 prefix for a franchisee, or
    (as a soft fallback for franchisees that haven't been bootstrapped
    yet) the freshly-computed prefix.

    IMPORTANT: once ``r2_root_prefix`` is stored on the franchisee doc,
    it wins over any fresh computation forever. This is what makes a
    rename (organisation/name/number change) safe — files stay under
    the original prefix and the panel keeps pointing at it.
    """
    persisted = (f or {}).get("r2_root_prefix")
    if persisted:
        return persisted
    return compute_fresh_franchisee_prefix(f)


# Legacy import name — retained so existing callers don't need editing.
derive_franchisee_prefix = canonical_franchisee_prefix


async def _count_files_under_prefix(db, franchisee_id: str, prefix: str) -> int:
    """Non-hidden files bound to ``franchisee_id`` living under ``prefix``.
    Used to pick the populated root when a franchisee has ended up with
    more than one legacy slug."""
    return await db.files_index.count_documents({
        "franchisee_id": franchisee_id,
        "key": {"$regex": f"^{re.escape(prefix)}"},
        "$or": [{"hidden": {"$exists": False}}, {"hidden": False}],
    })


async def resolve_and_persist_canonical_prefix(db, franchisee: dict) -> Optional[str]:
    """Return the canonical R2 prefix for the franchisee, back-filling
    ``r2_root_prefix`` on the document if it isn't set yet.

    Selection order:
      1. If already persisted, use it (no change).
      2. Otherwise, inspect ``files_index`` for rows bound to this
         franchisee_id. If they all live under a single ``franchisees/<slug>/``,
         adopt it. If multiple slugs exist, pick the one with the most
         non-hidden files (byte size as a tiebreaker) so we never adopt
         an empty legacy prefix and strand the populated one.
      3. As a last resort (brand-new franchisee, no files yet), fall
         back to :func:`compute_fresh_franchisee_prefix`.

    ``r2_root_prefix`` is stored back on the document and the in-memory
    ``franchisee`` dict is mutated in place so callers can rely on
    ``franchisee['r2_root_prefix']`` after this returns.
    """
    persisted = franchisee.get("r2_root_prefix")
    if persisted:
        return persisted

    fid = franchisee.get("id")
    chosen: Optional[str] = None

    # 2) Discover from files_index (only for franchisees that already have data).
    if fid:
        pipeline = [
            {"$match": {
                "franchisee_id": fid,
                "key": {"$regex": r"^franchisees/"},
            }},
            {"$project": {
                "top": {"$regexFind": {"input": "$key", "regex": r"^(franchisees/[^/]+/)"}},
                "hidden": {"$ifNull": ["$hidden", False]},
                "size": {"$ifNull": ["$size", 0]},
            }},
            {"$match": {"top": {"$ne": None}}},
            {"$group": {
                "_id": {"$arrayElemAt": ["$top.captures", 0]},
                "visible_files": {"$sum": {"$cond": ["$hidden", 0, 1]}},
                "total_bytes": {"$sum": {"$cond": ["$hidden", 0, "$size"]}},
                "row_count": {"$sum": 1},
            }},
        ]
        try:
            rows = await db.files_index.aggregate(pipeline).to_list(50)
        except Exception:  # noqa: BLE001
            logger.exception("resolve_and_persist_canonical_prefix aggregate failed")
            rows = []
        if rows:
            # Prefer most visible files, then largest byte volume, then
            # alphabetically stable ordering.
            rows.sort(key=lambda r: (
                -(r.get("visible_files") or 0),
                -(r.get("total_bytes") or 0),
                r["_id"] or "",
            ))
            chosen = rows[0]["_id"]

    # 3) Fresh computation for franchisees with no files yet.
    if not chosen:
        chosen = compute_fresh_franchisee_prefix(franchisee)

    if not chosen or not fid:
        return chosen

    now_iso = datetime.now(timezone.utc).isoformat()
    try:
        await db.franchisees.update_one(
            {"id": fid, "r2_root_prefix": {"$in": [None, ""]}},
            {"$set": {
                "r2_root_prefix": chosen,
                "r2_root_prefix_set_at": now_iso,
            }},
        )
        franchisee["r2_root_prefix"] = chosen
    except Exception:  # noqa: BLE001
        logger.exception("failed to persist r2_root_prefix for %s", fid)
    return chosen


async def ensure_franchisee_folders(
    db, franchisee: dict, *, user_email: str | None = None,
) -> dict:
    """Idempotent. Creates the 3 standard sub-folders in R2 for the
    given franchisee if they don't already exist, and indexes them.

    Uses the franchisee's canonical (persisted) R2 prefix so a later
    rename does NOT spawn a second root. Callers that need to bootstrap
    a brand-new franchisee simply pass the freshly-created document —
    on first call the canonical prefix is derived and persisted; every
    subsequent call reads that persisted value back.

    Returns ``{created, skipped, prefix, canonical_prefix_source}``.
    """
    if not r2_configured():
        return {"created": [], "skipped": [], "prefix": None,
                "error": "R2 not configured"}

    prefix = await resolve_and_persist_canonical_prefix(db, franchisee)
    if not prefix:
        return {"created": [], "skipped": [], "prefix": None,
                "error": "Franchisee has no name/number to derive prefix"}

    s3 = get_client()
    now = datetime.now(timezone.utc).isoformat()
    created: list[str] = []
    skipped: list[str] = []

    for folder in STANDARD_FOLDERS:
        folder_prefix = f"{prefix}{folder}/"
        keep_key = f"{folder_prefix}.keep"
        # Already there?
        existing_keep = await db.files_index.find_one(
            {"key": keep_key}, {"_id": 0, "key": 1},
        )
        existing_any = await db.files_index.find_one(
            {"key": {"$regex": f"^{re.escape(folder_prefix)}"}},
            {"_id": 0, "key": 1},
        )
        if existing_keep or existing_any:
            skipped.append(folder)
            continue

        try:
            s3.put_object(
                Bucket=R2_BUCKET, Key=keep_key, Body=b"",
                ContentType="application/octet-stream",
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("R2 put_object failed for %s: %s", keep_key, exc)
            continue

        await db.files_index.update_one(
            {"key": keep_key},
            {"$set": {
                "key": keep_key,
                "name": ".keep",
                "parent_prefix": folder_prefix,
                "size": 0,
                "content_type": "application/octet-stream",
                "scope": SCOPE_FRANCHISEE,
                "franchisee_id": franchisee.get("id"),
                "hidden": True,
                "source": "auto_bootstrap",
                "created_at": now,
                "created_by": user_email,
            }},
            upsert=True,
        )
        created.append(folder)

    return {"prefix": prefix, "created": created, "skipped": skipped}
