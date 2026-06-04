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
import uuid
import logging
from datetime import datetime, timezone
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile, File, Form, Request

from file_storage import (
    R2_BUCKET, r2_configured, presigned_get_url, presigned_put_url,
    delete_object, head_object,
    SCOPE_FRANCHISEE, SCOPE_SHARED, SCOPE_ADMIN, get_client,
)
from franchisee_folders import derive_franchisee_prefix
from thumbnail_service import (
    get_cached_thumbnail, build_thumbnail, SIZES as THUMB_SIZES,
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


def _is_image_or_pdf(content_type: str | None, name: str | None) -> str | None:
    """Return 'image', 'pdf', or None for thumbnail-eligible files."""
    ct = (content_type or "").lower()
    ext = ((name or "").rsplit(".", 1)[-1] or "").lower()
    if ct.startswith("image/") or ext in {"jpg", "jpeg", "png", "gif", "webp", "svg", "heic"}:
        return "image"
    if ct == "application/pdf" or ext == "pdf":
        return "pdf"
    return None


def _attach_preview_url(item: dict) -> None:
    """Mutates `item` to include a `preview_url` (1h signed, inline) when
    the file is renderable as an image/pdf thumbnail. PDFs additionally
    get a `pdf_proxy_url` pointing at our same-origin backend proxy —
    PDF.js needs to fetch the bytes via XHR and R2's bucket-level CORS
    is not configurable from our token, so the proxy is required."""
    kind = _is_image_or_pdf(item.get("content_type"), item.get("name"))
    if not kind:
        return
    name = item.get("name") or "file"
    disp = f'inline; filename="{name.replace(chr(34), "")}"'
    try:
        item["preview_url"] = presigned_get_url(
            item["key"], expires_in=3600, content_disposition=disp,
        )
        item["preview_kind"] = kind
        if kind == "pdf":
            # Same-origin proxy so PDF.js can fetch the bytes without
            # being blocked by CORS. URL-quote the key so '/' / '%' /
            # spaces survive the round-trip.
            item["pdf_proxy_url"] = f"/api/files/proxy?key={urllib.parse.quote(item['key'], safe='')}"
    except Exception:  # noqa: BLE001
        # R2 not configured / signing failed — degrade silently to icon
        pass


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
            {"$match": {
                "hidden": {"$ne": True},
                "key": {"$not": re.compile(r"^\.trash/")},
            }},
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
            {"$match": {
                "scope": SCOPE_FRANCHISEE,
                "franchisee_id": {"$ne": None},
                "key": {"$not": re.compile(r"^\.trash/")},
            }},
            {"$group": {"_id": "$franchisee_id", "files": {"$sum": 1}, "bytes": {"$sum": "$size"}}},
            {"$sort": {"bytes": -1}},
        ]
        f_rows = await db.files_index.aggregate(f_pipeline).to_list(500)
        f_ids = [r["_id"] for r in f_rows]
        f_lookup = {f["id"]: f for f in await db.franchisees.find(
            {"id": {"$in": f_ids}},
            {"_id": 0, "id": 1, "franchise_number": 1, "organisation": 1,
             "first_name": 1, "last_name": 1, "photos": 1},
        ).to_list(1000)}

        franchisees_view = []
        for r in f_rows:
            f = f_lookup.get(r["_id"])
            if not f:
                continue
            base_prefix = derive_franchisee_prefix(f)
            franchisees_view.append({
                "franchisee_id": r["_id"],
                "franchise_number": f.get("franchise_number"),
                "organisation": f.get("organisation"),
                "name": f"{f.get('first_name','')} {f.get('last_name','')}".strip(),
                "photo": (f.get("photos") or [{}])[0].get("url"),
                "prefix": base_prefix,
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
    # Helper: enforce per-franchisee scope on file queries. Returns a
    # MongoDB filter clause (or None for admin = no restriction).
    async def _franchisee_scope_filter(user: dict) -> Optional[dict]:
        if user.get("role") != "franchisee":
            return None
        fid = user.get("franchisee_id")
        if not fid:
            raise HTTPException(403, detail="Portal account missing franchisee link")
        # They can see their own files (matched by franchisee_id) and
        # the global shared/ tree — EXCEPT folders that are HQ-internal
        # (e.g. shared/meeting-audio-files/ which are private to admins).
        franchisee_shared_clause = {
            "$and": [
                {"$or": [{"scope": SCOPE_SHARED},
                          {"key": {"$regex": r"^shared/"}}]},
                {"key": {"$not": re.compile(r"^shared/meeting-audio-files/")}},
            ],
        }
        return {
            "$or": [
                {"franchisee_id": fid},
                franchisee_shared_clause,
            ],
        }

    def _franchisee_allowed_key(user: dict, key: str, fr_keys: set[str]) -> bool:
        """Returns True if a franchisee user is allowed to access a key.
        Admins always pass."""
        if user.get("role") != "franchisee":
            return True
        if key.startswith("shared/meeting-audio-files/"):
            return False
        if key.startswith("shared/"):
            return True
        return key in fr_keys

    async def _franchisee_key_set(franchisee_id: str) -> set[str]:
        cur = db.files_index.find(
            {"franchisee_id": franchisee_id}, {"_id": 0, "key": 1},
        )
        items = await cur.to_list(50000)
        return {it["key"] for it in items}

    # -----------------------------------------------------------------
    @router.get("/files/tree")
    async def files_tree(
        prefix: str = Query("", description="R2 key prefix (e.g. 'franchisees/0046-…/'); empty for root"),
        franchisee_id: Optional[str] = Query(None, description="Filter to a single franchisee"),
        user: dict = Depends(require_role("admin", "franchisee")),
    ):
        """List the next level inside a prefix. Aggregates immediate
        sub-folders + direct files.

        Franchisee users are auto-scoped to their own files + the shared
        tree; the `franchisee_id` query param is ignored for them."""
        q: dict = {}
        scope_clause = await _franchisee_scope_filter(user)
        if scope_clause:
            q.update(scope_clause)
        elif franchisee_id:
            q["franchisee_id"] = franchisee_id
        if prefix:
            q["key"] = {"$regex": f"^{re.escape(prefix)}"}
        else:
            # Root listing — hide the .trash/ container so soft-deleted
            # folders don't appear as a normal folder in the admin browser.
            q["key"] = {"$not": re.compile(r"^\.trash/")}
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
                entry = {
                    "key": it["key"],
                    "name": it["name"],
                    "size": it["size"],
                    "content_type": it.get("content_type"),
                    "last_modified": it.get("last_modified"),
                    "imported_at": it.get("imported_at"),
                    "scope": it.get("scope"),
                    "orphan": it.get("orphan"),
                }
                _attach_preview_url(entry)
                files.append(entry)
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
        user: dict = Depends(require_role("admin", "franchisee")),
    ):
        terms = q.strip().split()
        query: dict = {"$and": [{"name": {"$regex": re.escape(t), "$options": "i"}} for t in terms]}
        if scope:
            query["scope"] = scope
        # Hide soft-deleted items and .keep placeholders
        query["hidden"] = {"$ne": True}
        query["key"] = {"$not": re.compile(r"^\.trash/")}
        # Apply franchisee scope clause if needed
        scope_clause = await _franchisee_scope_filter(user)
        if scope_clause:
            query["$and"] = (query.get("$and") or []) + [scope_clause]
        cur = db.files_index.find(query, {"_id": 0}).sort("name", 1).limit(limit)
        items = await cur.to_list(limit)
        # Folder search: distinct folder paths whose final segment matches.
        # Walks all index keys (~1.7k in production) and emits one entry per
        # unique folder name that matches the search terms. Cheap enough
        # to run on every keystroke since the admin search debounces.
        folders: list[dict] = []
        try:
            seen: set[str] = set()
            async for row in db.files_index.find(
                {"hidden": {"$ne": True}, "key": {"$not": re.compile(r"^\.trash/")}},
                {"_id": 0, "key": 1},
            ):
                parts = (row.get("key") or "").split("/")
                # last element is the filename; everything before is a folder path
                for end in range(1, len(parts)):
                    name = parts[end - 1]
                    if not name:
                        continue
                    haystack = name.lower()
                    if not all(re.search(re.escape(t.lower()), haystack) for t in terms):
                        continue
                    prefix = "/".join(parts[:end]) + "/"
                    if prefix in seen:
                        continue
                    seen.add(prefix)
                    folders.append({"prefix": prefix, "name": name, "depth": end})
                    if len(folders) >= limit:
                        break
                if len(folders) >= limit:
                    break
            folders.sort(key=lambda f: (f["depth"], f["name"]))
        except Exception:  # noqa: BLE001
            folders = []
        return {"items": items, "files": items, "folders": folders, "count": len(items)}

    # -----------------------------------------------------------------
    # Same-origin proxy for R2 objects. Used by PDF.js (and any other
    # JS-driven byte reader) to bypass R2's missing CORS policy. Admin
    # only — same auth model as the rest of /api/files.
    @router.get("/files/proxy")
    async def files_proxy(
        key: str = Query(...),
        user: dict = Depends(require_role("admin", "franchisee")),
    ):
        from fastapi.responses import StreamingResponse
        existing = await db.files_index.find_one({"key": key}, {"_id": 0, "name": 1, "content_type": 1, "size": 1, "franchisee_id": 1, "scope": 1})
        if not existing:
            raise HTTPException(404, detail="File not found in index")
        # Enforce franchisee scope: must be shared/ or owned by the user
        if user.get("role") == "franchisee":
            fid = user.get("franchisee_id")
            if key.startswith("shared/meeting-audio-files/"):
                raise HTTPException(403, detail="Forbidden")
            if not (key.startswith("shared/") or existing.get("franchisee_id") == fid
                    or existing.get("scope") == SCOPE_SHARED):
                raise HTTPException(403, detail="Forbidden")
        try:
            obj = get_client().get_object(Bucket=R2_BUCKET, Key=key)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(502, detail=f"R2 fetch failed: {exc}") from exc
        body = obj["Body"]
        # Use the original filename so the browser shows it correctly when
        # opened in a new tab (otherwise it falls back to "proxy" — the URL
        # path — and triggers a save dialog instead of inline preview).
        original_name = (existing.get("name") or "file").replace('"', "")
        headers = {
            "Content-Type": existing.get("content_type") or obj.get("ContentType") or "application/octet-stream",
            "Content-Length": str(obj.get("ContentLength") or existing.get("size") or 0),
            "Content-Disposition": f'inline; filename="{original_name}"',
            # Cache aggressively — these objects are immutable once
            # uploaded (any change creates a new key).
            "Cache-Control": "private, max-age=3600",
        }
        # FastAPI's StreamingResponse will iterate the boto3 StreamingBody.
        def iterator():
            try:
                for chunk in body.iter_chunks(chunk_size=64 * 1024):
                    yield chunk
            finally:
                body.close()
        return StreamingResponse(iterator(), headers=headers)

    # -----------------------------------------------------------------
    # Thumbnail cache. Server-renders a 256-ish JPEG once per file, stores
    # it in R2 under `_thumbs/`, returns it with aggressive caching so
    # the browser keeps it for the session. Massively speeds up folder
    # rendering vs. client-side PDF.js (which had to download the full
    # multi-MB PDF for every tile).
    @router.get("/files/thumbnail")
    async def files_thumbnail(
        key: str = Query(...),
        size: str = Query("md"),
        user: dict = Depends(require_role("admin", "franchisee")),
    ):
        from fastapi.responses import Response
        if size not in THUMB_SIZES:
            size = "md"
        existing = await db.files_index.find_one(
            {"key": key},
            {"_id": 0, "name": 1, "content_type": 1, "franchisee_id": 1, "scope": 1},
        )
        if not existing:
            raise HTTPException(404, detail="File not found in index")
        # Apply franchisee scope (matches /files/proxy)
        if user.get("role") == "franchisee":
            fid = user.get("franchisee_id")
            if key.startswith("shared/meeting-audio-files/"):
                raise HTTPException(403, detail="Forbidden")
            if not (key.startswith("shared/") or existing.get("franchisee_id") == fid
                    or existing.get("scope") == SCOPE_SHARED):
                raise HTTPException(403, detail="Forbidden")
        ct_src = (existing.get("content_type") or "").lower()
        ext = (existing.get("name") or "").rsplit(".", 1)[-1].lower()
        # Only PDFs + raster images can be thumbed. Anything else → 415.
        if not (ct_src.startswith("image/") or ct_src == "application/pdf"
                or ext in {"jpg", "jpeg", "png", "gif", "webp", "heic", "pdf"}):
            raise HTTPException(415, detail="Thumbnail not supported for this type")

        cached = get_cached_thumbnail(key, size)
        if cached:
            return Response(content=cached, media_type="image/jpeg",
                            headers={"Cache-Control": "public, max-age=86400, immutable"})

        import anyio
        data = await anyio.to_thread.run_sync(
            build_thumbnail, key, size, existing.get("content_type"),
        )
        if not data:
            raise HTTPException(422, detail="Could not render thumbnail")
        return Response(content=data, media_type="image/jpeg",
                        headers={"Cache-Control": "public, max-age=86400, immutable"})

    # -----------------------------------------------------------------
    @router.get("/files/download")
    async def files_download(
        key: str = Query(...),
        attachment: bool = Query(True, description="If true, force download (Content-Disposition: attachment)"),
        user: dict = Depends(require_role("admin", "franchisee")),
    ):
        existing = await db.files_index.find_one({"key": key}, {"_id": 0})
        if not existing:
            raise HTTPException(404, detail="File not found in index")
        if user.get("role") == "franchisee":
            fid = user.get("franchisee_id")
            if key.startswith("shared/meeting-audio-files/"):
                raise HTTPException(403, detail="Not allowed")
            if not (key.startswith("shared/")
                    or existing.get("franchisee_id") == fid
                    or existing.get("scope") == SCOPE_SHARED):
                raise HTTPException(403, detail="Not allowed")
        safe = existing["name"].replace('"', "")
        # Force a useful disposition either way — `inline` ensures PDFs render
        # in the browser instead of being downloaded by some viewers.
        if attachment:
            disp = f'attachment; filename="{safe}"'
        else:
            disp = f'inline; filename="{safe}"'
        url = presigned_get_url(key, expires_in=3600, content_disposition=disp)
        # ---- audit log (admin-visible). We only record actual download
        # clicks (attachment=True). Inline previews aren't logged because
        # browser PDF/image previews can fire multiple times per view.
        if attachment:
            try:
                fr_name = None
                if user.get("role") == "franchisee" and user.get("franchisee_id"):
                    fr = await db.franchisees.find_one(
                        {"id": user["franchisee_id"]},
                        {"_id": 0, "first_name": 1, "last_name": 1, "organisation": 1},
                    )
                    if fr:
                        fr_name = (
                            f"{fr.get('first_name') or ''} {fr.get('last_name') or ''}".strip()
                            or fr.get("organisation")
                        )
                await db.file_downloads.insert_one({
                    "id": str(uuid.uuid4()),
                    "user_id": user.get("id"),
                    "user_email": user.get("email"),
                    "user_role": user.get("role"),
                    "franchisee_id": user.get("franchisee_id"),
                    "franchisee_name": fr_name,
                    "file_key": key,
                    "file_name": existing.get("name"),
                    "downloaded_at": datetime.now(timezone.utc).isoformat(),
                })
            except Exception as exc:  # noqa: BLE001
                logger.warning("file download audit log failed: %s", exc)
        return {"url": url, "expires_in": 3600}

    # -----------------------------------------------------------------
    # Admin-only File Vault audit log. Returns the most recent N
    # download events; tiny payload (no need to paginate yet — drops
    # ~50 bytes per row and we cap at 500).
    @router.get("/admin/files/download-log")
    async def admin_file_download_log(
        limit: int = Query(500, ge=1, le=2000),
        _: dict = Depends(require_role("admin")),
    ):
        items: list[dict] = []
        async for d in db.file_downloads.find({}, {"_id": 0}) \
                .sort("downloaded_at", -1).limit(limit):
            items.append(d)
        total = await db.file_downloads.count_documents({})
        return {"items": items, "returned": len(items), "total": total}

    # -----------------------------------------------------------------
    # Share links — these use a stable app-side token that redirects to a
    # freshly-signed R2 URL. This means a single share link can live up to
    # 30 days (and is revocable) even though the underlying R2 sigv4 cap is
    # 7 days. ``days=0`` / ``"lifetime"`` → no expiry, mirroring the folder
    # share endpoint below so admins can announce files via the Updates
    # system without the link going stale.
    @router.post("/files/share-link")
    async def files_share_create(
        body: dict,
        request: Request,
        user: dict = Depends(require_role("admin")),
    ):
        import secrets
        key = body.get("key")
        raw_days = body.get("days")
        lifetime = raw_days in (0, "0", "lifetime", None) and raw_days is not None and (
            raw_days == 0 or raw_days == "0" or str(raw_days).lower() == "lifetime"
        )
        if not key:
            raise HTTPException(400, detail="key required")
        existing = await db.files_index.find_one({"key": key}, {"_id": 0, "name": 1})
        if not existing:
            raise HTTPException(404, detail="File not found in index")
        token = secrets.token_urlsafe(18)
        if lifetime:
            days = 0
            expires_iso = None
        else:
            days = max(1, min(int(raw_days if raw_days is not None else 30), 3650))
            now_ts = datetime.now(timezone.utc).timestamp()
            expires_iso = datetime.fromtimestamp(now_ts + days * 86400, tz=timezone.utc).isoformat()
        doc = {
            "token": token,
            "key": key,
            "filename": existing.get("name"),
            "expires_at": expires_iso,
            "lifetime": lifetime,
            "created_at": _now(),
            "created_by": user.get("email"),
            "revoked": False,
            "hits": 0,
        }
        await db.files_share_links.insert_one(doc)
        # Prefer body-supplied frontend_origin (browser knows its own
        # window.location.origin), then Origin/Referer headers, then the
        # static FRONTEND_URL env var. Skip ingress-internal hosts.
        body_origin = (body.get("frontend_origin") or "").rstrip("/")
        origin = (request.headers.get("origin") or "").rstrip("/")
        if origin and "emergentcf.cloud" in origin:
            origin = ""
        if not origin:
            ref = request.headers.get("referer") or ""
            if ref:
                from urllib.parse import urlparse
                parsed = urlparse(ref)
                if parsed.scheme and parsed.netloc and "emergentcf.cloud" not in parsed.netloc:
                    origin = f"{parsed.scheme}://{parsed.netloc}"
        base = body_origin or origin or (os.environ.get("FRONTEND_URL") or "").rstrip("/")
        url = f"{base}/api/files/share/{token}"
        return {"url": url, "token": token, "expires_at": expires_iso, "days": days, "lifetime": lifetime}

    # Back-compat GET shape used by the older UI — accepts ?key=&days= and
    # creates a share token.
    @router.get("/files/share-link")
    async def files_share_create_get(
        request: Request,
        key: str = Query(...),
        days: int = Query(30, ge=1, le=30),
        user: dict = Depends(require_role("admin")),
    ):
        return await files_share_create({"key": key, "days": days}, request=request, user=user)

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

    # Public (unauthenticated) thumbnail for use in Resend announcement emails.
    # Email clients fetch `<img src>` without our Bearer token, so we re-use
    # the lifetime share-token created at announcement time. Returns a
    # cached thumbnail (PNG) of the underlying file or a small placeholder
    # if the file isn't an image/PDF.
    @router.get("/files/share/{token}/thumb")
    async def files_share_thumb(token: str, size: str = "md"):
        from fastapi.responses import Response
        if size not in THUMB_SIZES:
            size = "md"
        rec = await db.files_share_links.find_one({"token": token}, {"_id": 0})
        if not rec or rec.get("revoked"):
            raise HTTPException(404, detail="Share link not found or revoked")
        try:
            exp = datetime.fromisoformat(rec["expires_at"])
        except Exception:  # noqa: BLE001
            exp = None
        if exp and datetime.now(timezone.utc) > exp:
            raise HTTPException(410, detail="Share link expired")
        key = rec.get("key")
        existing = await db.files_index.find_one(
            {"key": key}, {"_id": 0, "content_type": 1, "name": 1},
        )
        if not existing:
            raise HTTPException(404, detail="File not found")
        ct_src = (existing.get("content_type") or "").lower()
        ext = (existing.get("name") or "").rsplit(".", 1)[-1].lower()
        if not (ct_src.startswith("image/") or ct_src == "application/pdf"
                or ext in {"jpg", "jpeg", "png", "gif", "webp", "heic", "pdf"}):
            raise HTTPException(415, detail="Thumbnail not supported for this type")
        cached = get_cached_thumbnail(key, size)
        if cached is None:
            import anyio
            cached = await anyio.to_thread.run_sync(
                build_thumbnail, key, size, existing.get("content_type"),
            )
        if cached is None:
            raise HTTPException(404, detail="Thumbnail could not be built")
        return Response(content=cached, media_type="image/jpeg",
                        headers={"Cache-Control": "public, max-age=86400"})


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

    # -----------------------------------------------------------------
    # Replace an existing file with a new version, keeping the same R2 key
    # so share links and embeds stay valid. The new file's local filename
    # is ignored — only its bytes matter. Size, content-type and timestamps
    # on the index row are updated in place.
    @router.post("/files/replace")
    async def files_replace_version(
        file: UploadFile = File(...),
        key: str = Form(..., description="Existing R2 key to overwrite"),
        user: dict = Depends(require_role("admin")),
    ):
        if not r2_configured():
            raise HTTPException(503, detail="R2 not configured")
        if not key or key.endswith("/"):
            raise HTTPException(400, detail="key must point to a file")
        existing = await db.files_index.find_one({"key": key}, {"_id": 0})
        if not existing:
            raise HTTPException(404, detail="File not found")
        data = await file.read()
        if not data:
            raise HTTPException(400, detail="Replacement upload is empty")
        # Prefer the existing content-type when the browser sends generic
        # octet-stream — keeps inline previews working. If the user
        # uploaded a clearly different type (e.g. PDF over a JPG), accept
        # the new value.
        ct = file.content_type or existing.get("content_type") or "application/octet-stream"
        if ct == "application/octet-stream" and existing.get("content_type"):
            ct = existing["content_type"]
        try:
            get_client().put_object(Bucket=R2_BUCKET, Key=key, Body=data, ContentType=ct)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(502, detail=f"R2 put_object failed: {exc}") from exc
        patch = {
            "size": len(data),
            "content_type": ct,
            "replaced_at": _now(),
            "replaced_by": user.get("email"),
            "last_modified": _now(),
        }
        await db.files_index.update_one({"key": key}, {"$set": patch})
        merged = {**existing, **patch}
        return {"replaced": True, "file": merged}


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

    # -----------------------------------------------------------------
    # Recent uploads — only franchisee+shared scopes (admin-only files
    # are intentionally excluded so this view is safe for the future
    # franchisee portal). Default: last 30 days.
    @router.get("/files/recent")
    async def files_recent(
        days: int = Query(30, ge=1, le=365),
        limit: int = Query(200, le=500),
        franchisee_id: Optional[str] = Query(None, description="Restrict to this franchisee's own files (+ shared)"),
        user: dict = Depends(require_role("admin", "franchisee")),
    ):
        from datetime import timedelta
        cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
        # "Recent" means a *real user* uploaded the file. We deliberately
        # exclude `imported_at` and `last_modified` because both fields are
        # set to the migration date by the FileCamp → R2 importer, which
        # would otherwise flood every franchisee's portal with the entire
        # legacy archive as "recent". Once a franchisee uploads a new file
        # via the portal it'll have `uploaded_at` and show up here.
        q: dict = {
            "scope": {"$in": [SCOPE_FRANCHISEE, SCOPE_SHARED]},
            "hidden": {"$ne": True},
            "key": {"$not": re.compile(r"^\.trash/")},
            "uploaded_at": {"$gte": cutoff},
        }
        # Scope: franchisees auto-restrict to their own files + shared.
        # Admins can pass `franchisee_id` to narrow to one franchisee's
        # detail page recents.
        if user.get("role") == "franchisee":
            fid = user.get("franchisee_id")
            q["$and"] = [{
                "$or": [
                    {"franchisee_id": fid},
                    {"scope": SCOPE_SHARED},
                ],
            }]
            # Hide the meeting-audio shared subfolder from franchisees
            q["key"] = {"$not": re.compile(r"^(\.trash/|shared/meeting-audio-files/)")}
        elif franchisee_id:
            q["$and"] = [{
                "$or": [
                    {"franchisee_id": franchisee_id},
                    {"scope": SCOPE_SHARED},
                ],
            }]
        cur = (db.files_index
               .find(q, {"_id": 0})
               .sort([("uploaded_at", -1), ("imported_at", -1), ("last_modified", -1)])
               .limit(limit))
        items = await cur.to_list(limit)
        # Enrich with franchisee names for nicer display
        f_ids = list({it.get("franchisee_id") for it in items if it.get("franchisee_id")})
        f_lookup = {}
        if f_ids:
            f_docs = await db.franchisees.find(
                {"id": {"$in": f_ids}},
                {"_id": 0, "id": 1, "franchise_number": 1, "organisation": 1, "first_name": 1, "last_name": 1},
            ).to_list(1000)
            f_lookup = {f["id"]: f for f in f_docs}
        for it in items:
            f = f_lookup.get(it.get("franchisee_id"))
            if f:
                it["franchisee_label"] = f"{f.get('franchise_number') or ''} · {f.get('organisation') or f.get('first_name') or ''}".strip(" ·")
            # Inline a 1-hour preview URL for image + PDF types so the
            # frontend can render real thumbnails without round-tripping.
            _attach_preview_url(it)

        # Aggregate the distinct folders that received those recent files.
        # A "recently active folder" = the parent_prefix of any file in
        # `items`. This means both newly-created folders (their .keep
        # placeholder + first file uploads) and existing folders that
        # received fresh uploads will show up. Top-level prefixes
        # (admin/, shared/, franchisees/) are excluded — too coarse.
        folders_map: dict = {}
        for it in items:
            pp = it.get("parent_prefix") or ""
            if not pp or pp.count("/") <= 1:
                # e.g. "" or "shared/" — not a useful folder card
                continue
            entry = folders_map.get(pp)
            when = it.get("uploaded_at") or it.get("imported_at") or it.get("last_modified")
            if not entry:
                leaf = pp.rstrip("/").rsplit("/", 1)[-1]
                folders_map[pp] = {
                    "key": pp,
                    "name": leaf,
                    "file_count": 1,
                    "bytes": it.get("size", 0),
                    "latest_at": when,
                    "scope": it.get("scope"),
                    "franchisee_id": it.get("franchisee_id"),
                    "franchisee_label": it.get("franchisee_label"),
                }
            else:
                entry["file_count"] += 1
                entry["bytes"] += it.get("size", 0)
                if when and (not entry["latest_at"] or when > entry["latest_at"]):
                    entry["latest_at"] = when
        folders_out = sorted(folders_map.values(),
                              key=lambda f: f["latest_at"] or "",
                              reverse=True)
        return {
            "items": items,
            "count": len(items),
            "folders": folders_out,
            "folder_count": len(folders_out),
            "days": days,
        }

    # -----------------------------------------------------------------
    # Folder operations: rename, move, soft-delete.
    # In S3/R2 these are all multi-step (copy-then-delete) loops over
    # every object under the prefix. Acceptable for our scale (folders
    # are typically <500 files, <100MB). We also update files_index in
    # bulk so the UI reflects the new layout immediately.
    def _safe_name(raw: str) -> str:
        s = re.sub(r"[^\w\s.\-]", "", raw or "").strip()
        return s

    async def _move_prefix(src_prefix: str, dst_prefix: str, *, reason: str, user_email: str) -> dict:
        if not src_prefix.endswith("/"):
            src_prefix += "/"
        if not dst_prefix.endswith("/"):
            dst_prefix += "/"
        if src_prefix == dst_prefix:
            raise HTTPException(400, detail="Source and destination are the same")
        if dst_prefix.startswith(src_prefix):
            raise HTTPException(400, detail="Cannot move a folder into itself")
        s3 = get_client()
        # Iterate all index entries under src_prefix (including .keep)
        cur = db.files_index.find({"key": {"$regex": f"^{re.escape(src_prefix)}"}}, {"_id": 0})
        entries = await cur.to_list(50000)
        if not entries:
            raise HTTPException(404, detail="Folder is empty or does not exist")
        moved = 0
        errors = []
        new_scope = _classify_uploaded_key(dst_prefix)["scope"]
        for ent in entries:
            old_key = ent["key"]
            new_key = dst_prefix + old_key[len(src_prefix):]
            try:
                s3.copy_object(Bucket=R2_BUCKET, Key=new_key,
                               CopySource={"Bucket": R2_BUCKET, "Key": old_key})
                s3.delete_object(Bucket=R2_BUCKET, Key=old_key)
            except Exception as exc:  # noqa: BLE001
                errors.append({"key": old_key, "error": str(exc)})
                continue
            patch = {
                "key": new_key,
                "parent_prefix": new_key.rsplit("/", 1)[0] + "/" if "/" in new_key else "",
                "scope": new_scope,
                "moved_at": _now(),
                "moved_by": user_email,
                "moved_reason": reason,
            }
            await db.files_index.update_one({"key": old_key}, {"$set": patch})
            moved += 1
        return {"moved": moved, "errors": errors,
                "from": src_prefix, "to": dst_prefix}

    @router.post("/files/folder/rename")
    async def files_folder_rename(body: dict, user: dict = Depends(require_role("admin"))):
        prefix = (body.get("prefix") or "").strip()
        new_name = _safe_name(body.get("new_name") or "")
        if not prefix or not new_name:
            raise HTTPException(400, detail="prefix and new_name required")
        if not prefix.endswith("/"):
            prefix += "/"
        # Parent of the renamed folder = the prefix without the last segment
        parts = prefix.rstrip("/").split("/")
        parent = "/".join(parts[:-1])
        if parent:
            parent += "/"
        new_prefix = f"{parent}{new_name}/"
        result = await _move_prefix(prefix, new_prefix, reason="rename", user_email=user.get("email"))
        return {"renamed": True, **result}

    @router.post("/files/folder/move")
    async def files_folder_move(body: dict, user: dict = Depends(require_role("admin"))):
        src = (body.get("prefix") or "").strip()
        dst_parent = (body.get("new_parent") or "").strip()
        if not src:
            raise HTTPException(400, detail="prefix required")
        if not src.endswith("/"):
            src += "/"
        if dst_parent and not dst_parent.endswith("/"):
            dst_parent += "/"
        # New prefix = dst_parent + last segment of src
        leaf = src.rstrip("/").rsplit("/", 1)[-1]
        new_prefix = f"{dst_parent}{leaf}/"
        result = await _move_prefix(src, new_prefix, reason="move", user_email=user.get("email"))
        # Keep `moved` as the int count (from _move_prefix). Wrap with `ok`.
        return {"ok": True, **result}

    @router.delete("/files/folder")
    async def files_folder_soft_delete(
        prefix: str = Query(...),
        user: dict = Depends(require_role("admin")),
    ):
        """Soft delete: moves the folder under `.trash/<ISO-ts>/` so
        nothing is actually destroyed. A future cron job can purge
        anything older than 30 days."""
        if not prefix.endswith("/"):
            prefix += "/"
        if prefix.startswith(".trash/"):
            raise HTTPException(400, detail="Folder is already in trash")
        ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        trash_prefix = f".trash/{ts}/{prefix}"
        result = await _move_prefix(prefix, trash_prefix,
                                     reason="soft_delete", user_email=user.get("email"))
        await db.files_trash_log.insert_one({
            "original_prefix": prefix,
            "trash_prefix": trash_prefix,
            "deleted_at": _now(),
            "deleted_by": user.get("email"),
            "files_count": result.get("moved", 0),
            "errors": result.get("errors", []),
        })
        return {"trashed": True, "trash_prefix": trash_prefix, **result}

    # -----------------------------------------------------------------
    # Trash bin: list, restore, purge. All admin-only. Soft-deleted items
    # live under `.trash/<ts>/<original>/...`. We use files_trash_log as
    # the source of truth for "what was deleted, when, by whom".
    @router.get("/files/trash")
    async def files_trash_list(_user: dict = Depends(require_role("admin"))):
        cur = db.files_trash_log.find({}, {"_id": 0}).sort("deleted_at", -1).limit(500)
        entries = await cur.to_list(500)
        # For each entry, double-check how many files currently exist in
        # R2 (some may already have been restored / individually purged).
        out = []
        total_bytes = 0
        for e in entries:
            tp = e.get("trash_prefix")
            if not tp:
                continue
            agg = await db.files_index.aggregate([
                {"$match": {"key": {"$regex": f"^{re.escape(tp)}"}}},
                {"$group": {"_id": None, "files": {"$sum": 1}, "bytes": {"$sum": "$size"}}},
            ]).to_list(1)
            files_now = (agg[0]["files"] if agg else 0)
            bytes_now = (agg[0]["bytes"] if agg else 0)
            total_bytes += bytes_now
            out.append({
                "trash_prefix": tp,
                "original_prefix": e.get("original_prefix"),
                "deleted_at": e.get("deleted_at"),
                "deleted_by": e.get("deleted_by"),
                "files_at_delete": e.get("files_count", 0),
                "files_now": files_now,
                "bytes_now": bytes_now,
                "restored": files_now == 0,
            })
        return {"items": out, "total_bytes": total_bytes,
                "active_count": sum(1 for x in out if not x["restored"])}

    @router.post("/files/trash/restore")
    async def files_trash_restore(body: dict, user: dict = Depends(require_role("admin"))):
        """Restore a trashed folder to its original path."""
        tp = (body.get("trash_prefix") or "").strip()
        if not tp:
            raise HTTPException(400, detail="trash_prefix required")
        if not tp.startswith(".trash/"):
            raise HTTPException(400, detail="Not a trash prefix")
        if not tp.endswith("/"):
            tp += "/"
        # Original prefix from the trash log (canonical) or derived from path
        log_rec = await db.files_trash_log.find_one({"trash_prefix": tp}, {"_id": 0})
        if log_rec and log_rec.get("original_prefix"):
            original = log_rec["original_prefix"]
        else:
            # .trash/<ts>/<original>/... → strip the .trash/<ts>/ prefix
            after = tp[len(".trash/"):]
            ts_part, _, rest = after.partition("/")
            original = rest
        if not original or not original.endswith("/"):
            raise HTTPException(400, detail="Could not derive original path")
        # Refuse if anything already exists at the destination
        clash = await db.files_index.count_documents({
            "key": {"$regex": f"^{re.escape(original)}"},
            "hidden": {"$ne": True},
        })
        if clash:
            raise HTTPException(409, detail=f"A folder already exists at {original}. Rename it first.")
        result = await _move_prefix(tp, original, reason="restore",
                                     user_email=user.get("email"))
        await db.files_trash_log.update_one(
            {"trash_prefix": tp},
            {"$set": {"restored_at": _now(), "restored_by": user.get("email")}},
        )
        return {"restored": True, "to": original, **result}

    @router.delete("/files/trash/item")
    async def files_trash_purge_one(
        trash_prefix: str = Query(...),
        user: dict = Depends(require_role("admin")),
    ):
        """Permanently delete one trash entry (folder)."""
        tp = trash_prefix
        if not tp.startswith(".trash/"):
            raise HTTPException(400, detail="Not a trash prefix")
        if not tp.endswith("/"):
            tp += "/"
        s3 = get_client()
        cur = db.files_index.find({"key": {"$regex": f"^{re.escape(tp)}"}}, {"_id": 0, "key": 1})
        items = await cur.to_list(50000)
        deleted = 0
        for it in items:
            try:
                s3.delete_object(Bucket=R2_BUCKET, Key=it["key"])
                deleted += 1
            except Exception as exc:  # noqa: BLE001
                logger.warning("R2 delete failed for %s: %s", it["key"], exc)
        await db.files_index.delete_many({"key": {"$regex": f"^{re.escape(tp)}"}})
        await db.files_trash_log.update_one(
            {"trash_prefix": tp},
            {"$set": {"purged_at": _now(), "purged_by": user.get("email"),
                      "purged_count": deleted}},
        )
        return {"purged": deleted, "trash_prefix": tp}

    @router.delete("/files/trash/empty")
    async def files_trash_empty(
        confirm: str = Query("", description="Must equal 'EMPTY' to proceed"),
        user: dict = Depends(require_role("admin")),
    ):
        """Permanently purge everything in `.trash/`. Irreversible."""
        if confirm != "EMPTY":
            raise HTTPException(400, detail="Confirmation required (?confirm=EMPTY)")
        s3 = get_client()
        cur = db.files_index.find({"key": {"$regex": r"^\.trash/"}}, {"_id": 0, "key": 1})
        items = await cur.to_list(100000)
        deleted = 0
        for it in items:
            try:
                s3.delete_object(Bucket=R2_BUCKET, Key=it["key"])
                deleted += 1
            except Exception as exc:  # noqa: BLE001
                logger.warning("R2 delete failed for %s: %s", it["key"], exc)
        await db.files_index.delete_many({"key": {"$regex": r"^\.trash/"}})
        await db.files_trash_log.update_many(
            {"purged_at": {"$exists": False}},
            {"$set": {"purged_at": _now(), "purged_by": user.get("email"),
                      "purged_count": -1}},
        )
        return {"purged": deleted, "emptied": True}

    # -----------------------------------------------------------------
    # Folder share tokens. Admin generates a public link → recipient
    # gets a page listing all files in the folder with per-file download
    # buttons AND a "Download All as ZIP" button.
    @router.post("/files/folder-share")
    async def files_folder_share_create(body: dict, request: Request, user: dict = Depends(require_role("admin"))):
        import secrets
        prefix = (body.get("prefix") or "").strip()
        raw_days = body.get("days")
        # `days=0` (or "lifetime") → no expiry. Otherwise clamp to 1..3650.
        lifetime = raw_days in (0, "0", None, "lifetime")
        if lifetime:
            days = 0
        else:
            days = max(1, min(int(raw_days), 3650))
        if not prefix:
            raise HTTPException(400, detail="prefix required")
        if not prefix.endswith("/"):
            prefix += "/"
        # Make sure the folder has files we can share
        cnt = await db.files_index.count_documents({
            "key": {"$regex": f"^{re.escape(prefix)}"},
            "hidden": {"$ne": True},
        })
        if cnt == 0:
            raise HTTPException(404, detail="Folder is empty — nothing to share")
        token = secrets.token_urlsafe(18)
        now_ts = datetime.now(timezone.utc).timestamp()
        if lifetime:
            expires_iso = None
        else:
            expires_iso = datetime.fromtimestamp(
                now_ts + days * 86400, tz=timezone.utc).isoformat()
        leaf = prefix.rstrip("/").rsplit("/", 1)[-1] or prefix.rstrip("/")
        doc = {
            "token": token,
            "kind": "folder",
            "prefix": prefix,
            "label": leaf.replace("-", " "),
            "file_count": cnt,
            "expires_at": expires_iso,
            "created_at": _now(),
            "created_by": user.get("email"),
            "revoked": False,
            "hits": 0,
        }
        await db.files_share_links.insert_one(doc)
        # Prefer the inbound request's Origin so the link goes back to
        # whichever host the admin is composing from.
        origin = (request.headers.get("origin") or "").rstrip("/")
        # The Kubernetes ingress in the preview cluster rewrites the
        # Origin header to the internal service host (cluster-5.preview...
        # emergentcf.cloud). Detect that and fall back so links don't
        # point at an internal URL.
        if origin and "emergentcf.cloud" in origin:
            origin = ""
        if not origin:
            ref = request.headers.get("referer") or ""
            if ref:
                from urllib.parse import urlparse
                parsed = urlparse(ref)
                if parsed.scheme and parsed.netloc and "emergentcf.cloud" not in parsed.netloc:
                    origin = f"{parsed.scheme}://{parsed.netloc}"
        # Body-supplied frontend_origin is the final, most reliable
        # signal because the browser knows its own ``window.location.origin``.
        body_origin = (body.get("frontend_origin") or "").rstrip("/")
        base = body_origin or origin or (os.environ.get("FRONTEND_URL") or "").rstrip("/")
        # Public viewer URL — handled by the React app
        url = f"{base}/share/folder/{token}"
        return {"url": url, "token": token, "expires_at": expires_iso,
                "days": days, "lifetime": lifetime,
                "label": doc["label"], "file_count": cnt}

    async def _resolve_folder_token(token: str) -> dict:
        rec = await db.files_share_links.find_one(
            {"token": token, "kind": "folder"}, {"_id": 0},
        )
        if not rec or rec.get("revoked"):
            raise HTTPException(404, detail="Share link not found or revoked")
        exp_raw = rec.get("expires_at")
        if exp_raw:  # None / "" → lifetime
            try:
                expires_at = datetime.fromisoformat(exp_raw)
            except Exception:  # noqa: BLE001
                expires_at = None
            if expires_at and datetime.now(timezone.utc) > expires_at:
                raise HTTPException(410, detail="Share link expired")
        return rec

    @router.get("/files/folder-share/{token}")
    async def files_folder_share_view(token: str):
        """PUBLIC listing of a shared folder. No auth — anyone with the
        link can see file names + per-file presigned download URLs."""
        rec = await _resolve_folder_token(token)
        prefix = rec["prefix"]
        cur = db.files_index.find({
            "key": {"$regex": f"^{re.escape(prefix)}"},
            "hidden": {"$ne": True},
        }, {"_id": 0}).sort("key", 1).limit(2000)
        items = await cur.to_list(2000)
        files_out = []
        for it in items:
            rel = it["key"][len(prefix):]
            disp = f'attachment; filename="{(it.get("name") or "file").replace(chr(34), "")}"'
            signed = presigned_get_url(it["key"], expires_in=3600,
                                        content_disposition=disp)
            files_out.append({
                "name": it.get("name"),
                "rel_path": rel,
                "size": it.get("size", 0),
                "content_type": it.get("content_type"),
                "download_url": signed,
            })
        await db.files_share_links.update_one(
            {"token": token},
            {"$inc": {"hits": 1}, "$set": {"last_hit_at": _now()}},
        )
        return {
            "label": rec.get("label"),
            "file_count": rec.get("file_count"),
            "expires_at": rec.get("expires_at"),
            "files": files_out,
            "zip_url": f"/api/files/folder-share/{token}/zip",
        }

    # -----------------------------------------------------------------
    # Streaming ZIP download — both for public folder shares and for
    # admin "Download as ZIP" on any folder.
    def _stream_zip(keys_with_names: list[tuple[str, str]], zip_name: str):
        """Build an in-memory ZIP of (key, rel_name) tuples. Acceptable
        because user-stated upper bound is ~100 MB; if folders grow much
        larger, swap for zipstream-ng + StreamingResponse."""
        import io
        import zipfile
        buf = io.BytesIO()
        s3 = get_client()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED, compresslevel=4) as zf:
            for key, rel in keys_with_names:
                try:
                    body = s3.get_object(Bucket=R2_BUCKET, Key=key)["Body"].read()
                    zf.writestr(rel, body)
                except Exception as exc:  # noqa: BLE001
                    logger.warning("Skipping %s in ZIP build: %s", key, exc)
        buf.seek(0)
        return buf

    async def _collect_folder_keys(prefix: str) -> list[tuple[str, str]]:
        cur = db.files_index.find({
            "key": {"$regex": f"^{re.escape(prefix)}"},
            "hidden": {"$ne": True},
        }, {"_id": 0, "key": 1, "name": 1}).sort("key", 1).limit(2000)
        items = await cur.to_list(2000)
        out = []
        for it in items:
            rel = it["key"][len(prefix):]
            if not rel:
                continue
            out.append((it["key"], rel))
        return out

    @router.get("/files/folder-share/{token}/zip")
    async def files_folder_share_zip(token: str):
        from fastapi.responses import StreamingResponse
        rec = await _resolve_folder_token(token)
        keys = await _collect_folder_keys(rec["prefix"])
        if not keys:
            raise HTTPException(404, detail="Folder is empty")
        buf = _stream_zip(keys, rec.get("label") or "folder")
        safe = (rec.get("label") or "folder").replace('"', "")
        await db.files_share_links.update_one(
            {"token": token},
            {"$inc": {"hits": 1}, "$set": {"last_hit_at": _now()}},
        )
        return StreamingResponse(
            buf,
            media_type="application/zip",
            headers={"Content-Disposition": f'attachment; filename="{safe}.zip"'},
        )

    @router.get("/files/folder-zip")
    async def files_folder_zip_admin(
        prefix: str = Query(..., description="Folder prefix to ZIP"),
        user: dict = Depends(require_role("admin", "franchisee")),
    ):
        from fastapi.responses import StreamingResponse
        if not prefix.endswith("/"):
            prefix += "/"
        if user.get("role") == "franchisee":
            fid = user.get("franchisee_id")
            # Franchisees may only ZIP their own folder tree or anything
            # under shared/. Look up at least one file's franchisee_id
            # under this prefix to verify ownership.
            if not prefix.startswith("shared/"):
                sample = await db.files_index.find_one(
                    {"key": {"$regex": f"^{re.escape(prefix)}"}, "franchisee_id": fid},
                    {"_id": 0, "key": 1},
                )
                if not sample:
                    raise HTTPException(403, detail="Not allowed")
        keys = await _collect_folder_keys(prefix)
        if not keys:
            raise HTTPException(404, detail="Folder is empty")
        buf = _stream_zip(keys, prefix.rstrip("/").rsplit("/", 1)[-1])
        leaf = prefix.rstrip("/").rsplit("/", 1)[-1] or "folder"
        safe = leaf.replace('"', "")
        return StreamingResponse(
            buf,
            media_type="application/zip",
            headers={"Content-Disposition": f'attachment; filename="{safe}.zip"'},
        )

    return router
