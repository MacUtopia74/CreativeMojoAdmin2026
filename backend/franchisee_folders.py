"""Phase 3 — Auto-bootstrap R2 folder structure for franchisees.

Every franchisee gets a deterministic R2 prefix
`franchisees/<number>-<org-slug>-<name-slug>/` with three standard
sub-folders:

    Artwork
    Franchise Agreement
    Territory

The folders themselves are represented in R2 by a single zero-byte
`.keep` placeholder per sub-folder (same convention as elsewhere in the
app — see files_routes.create_folder). They're indexed in
`files_index` with `hidden=True` so they don't show up as files in the
admin browser but still cause the parent folder to appear in `tree`.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Optional

from file_storage import (
    R2_BUCKET, get_client, franchisee_folder_key,
    SCOPE_FRANCHISEE, r2_configured,
)

logger = logging.getLogger("creative-mojo-admin.franchisee_folders")

STANDARD_FOLDERS = ["Artwork", "Franchise Documents", "Other Files"]


def derive_franchisee_prefix(f: dict) -> Optional[str]:
    """Return the canonical R2 prefix for a franchisee, or None if we
    don't have enough identifying info to build one."""
    slug = franchisee_folder_key(
        f.get("franchise_number"),
        f.get("organisation"),
        f.get("first_name"),
        f.get("last_name"),
    )
    return f"franchisees/{slug}" if slug else None


async def ensure_franchisee_folders(
    db, franchisee: dict, *, user_email: str | None = None,
) -> dict:
    """Idempotent. Creates the 3 standard sub-folders in R2 for the
    given franchisee if they don't already exist, and indexes them.
    Returns {created: [...], skipped: [...], prefix}."""
    if not r2_configured():
        return {"created": [], "skipped": [], "prefix": None,
                "error": "R2 not configured"}

    prefix = derive_franchisee_prefix(franchisee)
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
            {"key": {"$regex": f"^{folder_prefix}"}},
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
