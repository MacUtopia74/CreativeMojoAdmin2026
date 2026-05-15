"""Phase 3 — Admin file browser API.

Reads from the `files_index` MongoDB collection (populated by the FileCamp
migration), but cross-references each entry against R2 for accurate "exists"
status. Provides:
  - GET  /api/files/tree?prefix=...   — directory listing (folders + files)
  - GET  /api/files/search?q=...      — name search across the whole index
  - GET  /api/files/{key}/download    — issues a 1-hour presigned URL
  - DELETE /api/files/{key}           — removes from R2 + index (admin only)
  - GET  /api/files/scope-tree        — top-level scope summary for the UI sidebar
"""
from __future__ import annotations

import os
import re
import urllib.parse
import logging
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Query

from file_storage import (
    R2_BUCKET, r2_configured, presigned_get_url, delete_object,
    SCOPE_FRANCHISEE, SCOPE_SHARED, SCOPE_ADMIN, get_client,
)

logger = logging.getLogger("creative-mojo-admin.files")


def build_router(db, require_role) -> APIRouter:
    router = APIRouter()

    # -----------------------------------------------------------------
    @router.get("/files/scope-tree")
    async def scope_tree(_user: dict = Depends(require_role("admin"))):
        """Aggregated top-level overview for the sidebar:
        - franchisees (count, total size)
        - shared (folders + counts)
        - admin (folders + counts)"""
        pipeline = [
            {"$group": {
                "_id": {"scope": "$scope",
                         "top_folder": {"$arrayElemAt": [{"$split": ["$parent_prefix", "/"]}, 1]}},
                "files": {"$sum": 1},
                "bytes": {"$sum": "$size"},
            }},
            {"$sort": {"_id.scope": 1, "_id.top_folder": 1}},
        ]
        rows = await db.files_index.aggregate(pipeline).to_list(1000)
        # Per-franchisee summary
        f_pipeline = [
            {"$match": {"scope": SCOPE_FRANCHISEE, "franchisee_id": {"$ne": None}}},
            {"$group": {"_id": "$franchisee_id", "files": {"$sum": 1}, "bytes": {"$sum": "$size"}}},
            {"$sort": {"bytes": -1}},
        ]
        f_rows = await db.files_index.aggregate(f_pipeline).to_list(500)
        f_ids = [r["_id"] for r in f_rows]
        f_lookup = {f["id"]: f for f in await db.franchisees.find(
            {"id": {"$in": f_ids}},
            {"_id": 0, "id": 1, "franchise_number": 1, "organisation": 1, "first_name": 1, "last_name": 1, "photos": 1},
        ).to_list(1000)}

        franchisees_view = []
        for r in f_rows:
            f = f_lookup.get(r["_id"])
            if not f:
                continue
            franchisees_view.append({
                "franchisee_id": r["_id"],
                "franchise_number": f.get("franchise_number"),
                "organisation": f.get("organisation"),
                "name": f"{f.get('first_name','')} {f.get('last_name','')}".strip(),
                "photo": (f.get("photos") or [{}])[0].get("url"),
                "files": r["files"],
                "bytes": r["bytes"],
            })

        # Shared + admin top folders
        shared, admin = [], []
        for r in rows:
            scope = r["_id"]["scope"]
            top = r["_id"].get("top_folder") or ""
            if scope == SCOPE_SHARED:
                shared.append({"folder": top, "files": r["files"], "bytes": r["bytes"]})
            elif scope == SCOPE_ADMIN:
                admin.append({"folder": top, "files": r["files"], "bytes": r["bytes"]})
        return {
            "configured": r2_configured(),
            "totals": {
                "files": sum(r["files"] for r in rows),
                "bytes": sum(r["bytes"] for r in rows),
            },
            "franchisees": franchisees_view,
            "shared_folders": shared,
            "admin_folders": admin,
        }

    # -----------------------------------------------------------------
    @router.get("/files/tree")
    async def files_tree(
        prefix: str = Query("", description="R2 key prefix (e.g. 'franchisees/0046-…/'); empty for root"),
        franchisee_id: Optional[str] = Query(None, description="Filter to a single franchisee"),
        _user: dict = Depends(require_role("admin")),
    ):
        """List the next level inside a prefix. Aggregates immediate
        sub-folders + direct files."""
        q: dict = {}
        if franchisee_id:
            q["franchisee_id"] = franchisee_id
        if prefix:
            q["key"] = {"$regex": f"^{re.escape(prefix)}"}
        # Pull a slice of files at this depth (immediate children)
        cur = db.files_index.find(q, {"_id": 0}).sort("key", 1).limit(20000)
        items = await cur.to_list(20000)
        # Compute immediate children
        prefix_len = len(prefix)
        sub_dirs: dict[str, dict] = {}
        files: list[dict] = []
        for it in items:
            rel = it["key"][prefix_len:]
            if "/" in rel:
                top = rel.split("/", 1)[0]
                if top not in sub_dirs:
                    sub_dirs[top] = {"name": top, "key": prefix + top + "/",
                                      "files": 0, "bytes": 0}
                sub_dirs[top]["files"] += 1
                sub_dirs[top]["bytes"] += it["size"]
            else:
                files.append({
                    "key": it["key"],
                    "name": it["name"],
                    "size": it["size"],
                    "content_type": it.get("content_type"),
                    "last_modified": it.get("last_modified"),
                    "imported_at": it.get("imported_at"),
                    "scope": it.get("scope"),
                    "orphan": it.get("orphan"),
                })
        return {
            "prefix": prefix,
            "folders": sorted(sub_dirs.values(), key=lambda x: x["name"].lower()),
            "files": files,
            "total_in_tree": len(items),
        }

    # -----------------------------------------------------------------
    @router.get("/files/search")
    async def files_search(
        q: str = Query(..., min_length=2),
        limit: int = Query(50, le=200),
        scope: Optional[str] = Query(None),
        _user: dict = Depends(require_role("admin")),
    ):
        terms = q.strip().split()
        query: dict = {"$and": [{"name": {"$regex": re.escape(t), "$options": "i"}} for t in terms]}
        if scope:
            query["scope"] = scope
        cur = db.files_index.find(query, {"_id": 0}).sort("name", 1).limit(limit)
        items = await cur.to_list(limit)
        return {"items": items, "count": len(items)}

    # -----------------------------------------------------------------
    @router.get("/files/download")
    async def files_download(
        key: str = Query(...),
        attachment: bool = Query(True, description="If true, force download (Content-Disposition: attachment)"),
        _user: dict = Depends(require_role("admin")),
    ):
        existing = await db.files_index.find_one({"key": key}, {"_id": 0})
        if not existing:
            raise HTTPException(404, detail="File not found in index")
        disp = None
        if attachment:
            safe = existing["name"].replace('"', "")
            disp = f'attachment; filename="{safe}"'
        url = presigned_get_url(key, expires_in=3600, content_disposition=disp)
        return {"url": url, "expires_in": 3600}

    # -----------------------------------------------------------------
    @router.delete("/files")
    async def files_delete(
        key: str = Query(...),
        _user: dict = Depends(require_role("admin")),
    ):
        try:
            delete_object(key)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(502, detail=f"R2 delete failed: {exc}") from exc
        await db.files_index.delete_one({"key": key})
        return {"deleted": key}

    return router
