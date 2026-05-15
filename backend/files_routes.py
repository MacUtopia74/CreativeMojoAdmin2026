"""Phase 3 — Admin file browser API.

Reads from the `files_index` MongoDB collection (populated by the FileCamp
migration), but cross-references each entry against R2 for accurate "exists"
status. Provides:
  - GET    /api/files/tree?prefix=...   — directory listing
  - GET    /api/files/search?q=...      — name search across the whole index
  - GET    /api/files/download          — 1-hour presigned URL
  - GET    /api/files/share-link        — long-lived signed URL for e-shots
  - POST   /api/files/upload-url        — presigned PUT for direct-from-browser uploads
  - POST   /api/files/upload-complete   — index a freshly-uploaded object
  - POST   /api/files/folder            — create an empty folder placeholder
  - DELETE /api/files                   — remove from R2 + index
  - GET    /api/files/scope-tree        — top-level summary for the sidebar
"""
from __future__ import annotations

import os
import re
import urllib.parse
import logging
from datetime import datetime, timezone
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile, File, Form

from file_storage import (
    R2_BUCKET, r2_configured, presigned_get_url, presigned_put_url,
    delete_object, head_object,
    SCOPE_FRANCHISEE, SCOPE_SHARED, SCOPE_ADMIN, get_client,
)

logger = logging.getLogger("creative-mojo-admin.files")


# Cloudflare R2 enforces a hard 7-day cap on AWS Sig v4 presigned URLs.
# Anything longer must be served via the franchisee portal login (Phase 3 next),
# which is the right model for permanent franchisee file access.
R2_SIGV4_HARD_CAP_SECONDS = 7 * 24 * 3600
# User-facing max for "share links" (ad-hoc external e-shots). We accept up to
# 30 days at the API surface; if the actual TTL exceeds R2's hard cap we
# regenerate on the fly when the link is clicked (TODO future enhancement).
MAX_SHARE_TTL_SECONDS = 30 * 24 * 3600


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _classify_uploaded_key(key: str) -> dict:
    """Infer scope (+ franchisee_id when possible) from a freshly-uploaded key."""
    parts = key.split("/")
    if parts[0] == "franchisees":
        return {"scope": SCOPE_FRANCHISEE}
    if parts[0] == "shared":
        return {"scope": SCOPE_SHARED}
    return {"scope": SCOPE_ADMIN}


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
            {"$match": {"hidden": {"$ne": True}}},
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
        # Note: do NOT filter out hidden=.keep placeholders here — we need
        # them so that empty folders still surface in `folders`. We exclude
        # the .keep entries from the user-facing `files` list further down.
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
                # Don't count hidden placeholders against file counts/sizes
                if not it.get("hidden"):
                    sub_dirs[top]["files"] += 1
                    sub_dirs[top]["bytes"] += it["size"]
            else:
                if it.get("hidden"):
                    continue
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
        safe = existing["name"].replace('"', "")
        # Force a useful disposition either way — `inline` ensures PDFs render
        # in the browser instead of being downloaded by some viewers.
        if attachment:
            disp = f'attachment; filename="{safe}"'
        else:
            disp = f'inline; filename="{safe}"'
        url = presigned_get_url(key, expires_in=3600, content_disposition=disp)
        return {"url": url, "expires_in": 3600}

    # -----------------------------------------------------------------
    # Share links — these use a stable app-side token that redirects to a
    # freshly-signed R2 URL. This means a single share link can live up to
    # 30 days (and is revocable) even though the underlying R2 sigv4 cap is
    # 7 days.
    @router.post("/files/share-link")
    async def files_share_create(
        body: dict,
        user: dict = Depends(require_role("admin")),
    ):
        import secrets
        key = body.get("key")
        raw_days = body.get("days")
        days = int(raw_days if raw_days is not None else 30)
        days = max(1, min(days, 30))
        if not key:
            raise HTTPException(400, detail="key required")
        existing = await db.files_index.find_one({"key": key}, {"_id": 0, "name": 1})
        if not existing:
            raise HTTPException(404, detail="File not found in index")
        token = secrets.token_urlsafe(18)
        now_ts = datetime.now(timezone.utc).timestamp()
        expires_at_ts = now_ts + days * 86400
        doc = {
            "token": token,
            "key": key,
            "filename": existing.get("name"),
            "expires_at": datetime.fromtimestamp(expires_at_ts, tz=timezone.utc).isoformat(),
            "created_at": _now(),
            "created_by": user.get("email"),
            "revoked": False,
            "hits": 0,
        }
        await db.files_share_links.insert_one(doc)
        base = (os.environ.get("FRONTEND_URL") or "").rstrip("/")
        # Public URL points at our backend, which redirects to a fresh signed URL
        url = f"{base}/api/files/share/{token}"
        return {"url": url, "token": token, "expires_at": doc["expires_at"], "days": days}

    # Back-compat GET shape used by the older UI — accepts ?key=&days= and
    # creates a share token.
    @router.get("/files/share-link")
    async def files_share_create_get(
        key: str = Query(...),
        days: int = Query(30, ge=1, le=30),
        user: dict = Depends(require_role("admin")),
    ):
        return await files_share_create({"key": key, "days": days}, user=user)

    @router.get("/files/share/{token}")
    async def files_share_redirect(token: str):
        """Public redirect endpoint. Looks up the share token, validates
        expiry, regenerates a fresh signed R2 URL and 302s to it. No auth."""
        from fastapi.responses import RedirectResponse
        rec = await db.files_share_links.find_one({"token": token}, {"_id": 0})
        if not rec or rec.get("revoked"):
            raise HTTPException(404, detail="Share link not found or revoked")
        try:
            expires_at = datetime.fromisoformat(rec["expires_at"])
        except Exception:  # noqa: BLE001
            expires_at = None
        if expires_at and datetime.now(timezone.utc) > expires_at:
            raise HTTPException(410, detail="Share link expired")
        # Always serve as inline so PDFs/images preview directly
        safe = (rec.get("filename") or "file").replace('"', "")
        disp = f'inline; filename="{safe}"'
        signed = presigned_get_url(rec["key"], expires_in=3600, content_disposition=disp)
        await db.files_share_links.update_one(
            {"token": token},
            {"$inc": {"hits": 1}, "$set": {"last_hit_at": _now()}},
        )
        return RedirectResponse(signed, status_code=302)

    # -----------------------------------------------------------------
    @router.post("/files/upload-url")
    async def files_upload_url(
        body: dict,
        user: dict = Depends(require_role("admin")),
    ):
        """Return a presigned PUT URL the browser can use to upload directly
        to R2. Body: { prefix, filename, content_type, franchisee_id? }
        Returns the key + URL the browser should PUT to.
        Once the upload completes, the browser should call /files/upload-complete."""
        prefix = (body.get("prefix") or "").strip()
        filename = (body.get("filename") or "").strip()
        ct = body.get("content_type") or "application/octet-stream"
        if not filename:
            raise HTTPException(400, detail="filename required")
        # Sanitise filename — keep only safe chars
        safe = re.sub(r"[^\w\s.\-]", "_", filename).strip()
        safe = re.sub(r"\s+", " ", safe)
        # Make sure prefix ends with /
        if prefix and not prefix.endswith("/"):
            prefix = prefix + "/"
        # Default to /admin/uploads/ if no prefix supplied (safe fallback)
        if not prefix:
            prefix = "admin/uploads/"
        key = f"{prefix}{safe}"
        # If the exact key exists, suffix _v2, _v3 etc.
        suffix = 1
        while await db.files_index.find_one({"key": key}, {"_id": 1}):
            suffix += 1
            stem, _, ext = safe.rpartition(".")
            if stem:
                key = f"{prefix}{stem}_v{suffix}.{ext}"
            else:
                key = f"{prefix}{safe}_v{suffix}"
        info = presigned_put_url(key, content_type=ct, expires_in=600)
        return {**info, "prefix": prefix, "filename": safe}

    @router.post("/files/upload-complete")
    async def files_upload_complete(
        body: dict,
        user: dict = Depends(require_role("admin")),
    ):
        """Called by the browser after a successful PUT. Verifies the object
        landed in R2, then indexes it."""
        key = body.get("key")
        if not key:
            raise HTTPException(400, detail="key required")
        info = head_object(key)
        if not info:
            raise HTTPException(404, detail="Object not found in R2 (upload may have failed)")
        scope_info = _classify_uploaded_key(key)
        franchisee_id = body.get("franchisee_id")
        # If the key starts with franchisees/{slug}/, try to deduce franchisee_id
        if scope_info["scope"] == SCOPE_FRANCHISEE and not franchisee_id:
            slug_match = re.match(r"^franchisees/([^/]+)/", key)
            if slug_match:
                # Try to find by the leading 4-digit prefix
                num_match = re.match(r"^(\d{1,5})", slug_match.group(1))
                if num_match:
                    num = num_match.group(1).zfill(4)
                    f = await db.franchisees.find_one(
                        {"franchise_number": {"$in": [num, int(num)]}},
                        {"_id": 0, "id": 1},
                    )
                    if f:
                        franchisee_id = f["id"]
        name = key.rsplit("/", 1)[-1]
        parent_prefix = key[: -len(name)] if name else key
        doc = {
            "key": key,
            "name": name,
            "parent_prefix": parent_prefix,
            "size": info.get("ContentLength", 0),
            "content_type": info.get("ContentType"),
            "scope": scope_info["scope"],
            "franchisee_id": franchisee_id,
            "source": "upload",
            "uploaded_at": _now(),
            "uploaded_by": user.get("email"),
        }
        await db.files_index.update_one({"key": key}, {"$set": doc}, upsert=True)
        return {"indexed": True, "file": doc}

    # -----------------------------------------------------------------
    # Server-proxied multipart upload. Used by the admin browser today
    # because the R2 token does not have admin permissions to set bucket
    # CORS for direct browser PUTs. Works for files up to ~200 MB before
    # we should consider switching back to direct presigned PUTs.
    @router.post("/files/upload")
    async def files_upload_multipart(
        file: UploadFile = File(...),
        prefix: str = Form(""),
        franchisee_id: Optional[str] = Form(None),
        user: dict = Depends(require_role("admin")),
    ):
        if not r2_configured():
            raise HTTPException(503, detail="R2 not configured")
        clean_prefix = (prefix or "").strip()
        if clean_prefix and not clean_prefix.endswith("/"):
            clean_prefix = clean_prefix + "/"
        if not clean_prefix:
            clean_prefix = "admin/uploads/"
        raw_name = (file.filename or "upload.bin").rsplit("/", 1)[-1]
        safe = re.sub(r"[^\w\s.\-]", "_", raw_name).strip()
        safe = re.sub(r"\s+", " ", safe) or "upload.bin"
        key = f"{clean_prefix}{safe}"
        # De-dupe via _v2, _v3 ...
        suffix = 1
        while await db.files_index.find_one({"key": key}, {"_id": 1}):
            suffix += 1
            stem, _, ext = safe.rpartition(".")
            key = f"{clean_prefix}{stem}_v{suffix}.{ext}" if stem else f"{clean_prefix}{safe}_v{suffix}"
        # Read into memory then push to R2. For phase 3 file sizes
        # (PDFs/photos/audio, typically <50 MB) this is fine.
        data = await file.read()
        ct = file.content_type or "application/octet-stream"
        try:
            get_client().put_object(Bucket=R2_BUCKET, Key=key, Body=data, ContentType=ct)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(502, detail=f"R2 put_object failed: {exc}") from exc
        scope_info = _classify_uploaded_key(key)
        # Auto-deduce franchisee_id from key if scoped that way
        if scope_info["scope"] == SCOPE_FRANCHISEE and not franchisee_id:
            slug_match = re.match(r"^franchisees/([^/]+)/", key)
            if slug_match:
                num_match = re.match(r"^(\d{1,5})", slug_match.group(1))
                if num_match:
                    num = num_match.group(1).zfill(4)
                    f = await db.franchisees.find_one(
                        {"franchise_number": {"$in": [num, int(num)]}},
                        {"_id": 0, "id": 1},
                    )
                    if f:
                        franchisee_id = f["id"]
        name = key.rsplit("/", 1)[-1]
        parent_prefix = key[: -len(name)] if name else key
        doc = {
            "key": key,
            "name": name,
            "parent_prefix": parent_prefix,
            "size": len(data),
            "content_type": ct,
            "scope": scope_info["scope"],
            "franchisee_id": franchisee_id,
            "source": "upload",
            "uploaded_at": _now(),
            "uploaded_by": user.get("email"),
        }
        await db.files_index.update_one({"key": key}, {"$set": doc}, upsert=True)
        return {"indexed": True, "file": doc}

    @router.post("/files/folder")
    async def files_create_folder(
        body: dict,
        user: dict = Depends(require_role("admin")),
    ):
        """Create an empty folder placeholder. S3 has no real folders — we
        upload a zero-byte ".keep" object with the folder prefix so it shows
        up in the tree."""
        prefix = (body.get("prefix") or "").strip()
        name = (body.get("name") or "").strip()
        if not name:
            raise HTTPException(400, detail="name required")
        # Sanitise to slug-style; preserve case for display
        safe = re.sub(r"[^\w\s.\-]", "", name).strip()
        if not safe:
            raise HTTPException(400, detail="invalid folder name")
        if prefix and not prefix.endswith("/"):
            prefix = prefix + "/"
        key = f"{prefix}{safe}/.keep"
        s3 = get_client()
        s3.put_object(Bucket=R2_BUCKET, Key=key, Body=b"", ContentType="application/x-empty")
        # Index the .keep so the tree shows the folder
        doc = {
            "key": key,
            "name": ".keep",
            "parent_prefix": f"{prefix}{safe}/",
            "size": 0,
            "content_type": "application/x-empty",
            "scope": _classify_uploaded_key(key)["scope"],
            "franchisee_id": None,
            "source": "folder_placeholder",
            "uploaded_at": _now(),
            "uploaded_by": user.get("email"),
            "hidden": True,
        }
        await db.files_index.update_one({"key": key}, {"$set": doc}, upsert=True)
        return {"created": True, "folder_prefix": f"{prefix}{safe}/"}

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
