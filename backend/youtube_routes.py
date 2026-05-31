"""YouTube playlists module — admin sync + portal read paths.

Architecture:
  • Two authentication modes:
      - API key mode  (env: YOUTUBE_API_KEY + YOUTUBE_CHANNEL_ID) — only sees
        PUBLIC playlists on the channel.
      - OAuth mode    (env: YOUTUBE_OAUTH_CLIENT_ID + _SECRET, plus a stored
        refresh token in db.settings) — sees ALL playlists on the authorised
        channel including Unlisted and Private. Preferred when connected.
  • All YouTube traffic is server-side. The portal NEVER hits YouTube
    directly — only our cache.
  • Daily 03:00 UTC scheduler hits ``_sync_all_playlists`` to refresh.
  • Admin can also trigger sync manually + see a sync log.
  • Admin assigns each playlist to a ``category`` ("training" |
    "meetings") and toggles ``enabled``. Only enabled+categorised
    playlists show up in the portal.
  • Fallback: a failed sync NEVER wipes the existing cache. Portal
    keeps serving the last-known-good data.
"""
from __future__ import annotations

import asyncio
import logging
import os
import uuid
from datetime import datetime, timezone, timedelta
from typing import Any, Optional
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import RedirectResponse

logger = logging.getLogger("creative-mojo-admin.youtube")

YOUTUBE_API_BASE = "https://www.googleapis.com/youtube/v3"
OAUTH_SETTINGS_ID = "youtube_oauth"
OAUTH_SCOPES = ["https://www.googleapis.com/auth/youtube.readonly"]

CATEGORY_VALUES = {"training", "meetings", None}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _api_key() -> str:
    k = os.environ.get("YOUTUBE_API_KEY") or ""
    if not k:
        raise HTTPException(503, detail="YOUTUBE_API_KEY not configured")
    return k


def _channel_id() -> str:
    c = os.environ.get("YOUTUBE_CHANNEL_ID") or ""
    if not c:
        raise HTTPException(503, detail="YOUTUBE_CHANNEL_ID not configured")
    return c


def _oauth_redirect_uri() -> str:
    explicit = os.environ.get("YOUTUBE_OAUTH_REDIRECT_URI")
    if explicit:
        return explicit
    base = (os.environ.get("REACT_APP_BACKEND_URL") or os.environ.get("FRONTEND_URL") or "").rstrip("/")
    return f"{base}/api/admin/youtube/oauth/callback"


def _public_app_url() -> str:
    return (os.environ.get("FRONTEND_URL") or os.environ.get("REACT_APP_BACKEND_URL") or "").rstrip("/")


def _oauth_creds_or_raise() -> tuple[str, str]:
    cid = os.environ.get("YOUTUBE_OAUTH_CLIENT_ID")
    sec = os.environ.get("YOUTUBE_OAUTH_CLIENT_SECRET")
    if not cid or not sec:
        raise HTTPException(
            500,
            detail="YouTube OAuth not configured: set YOUTUBE_OAUTH_CLIENT_ID + YOUTUBE_OAUTH_CLIENT_SECRET in backend .env",
        )
    return cid, sec


# ---------------------------------------------------------------------
# OAuth token store (single shared connection on db.settings)
# ---------------------------------------------------------------------
async def _load_oauth_doc(db) -> Optional[dict]:
    doc = await db.settings.find_one({"_id": OAUTH_SETTINGS_ID}, {"_id": 0})
    if not doc or not doc.get("refresh_token"):
        return None
    return doc


async def _refresh_access_token(db, doc: dict) -> Optional[str]:
    """Use the stored refresh_token to mint a fresh access_token. Persist it."""
    cid, sec = _oauth_creds_or_raise()
    async with httpx.AsyncClient(timeout=15.0) as http:
        r = await http.post("https://oauth2.googleapis.com/token", data={
            "client_id": cid,
            "client_secret": sec,
            "refresh_token": doc["refresh_token"],
            "grant_type": "refresh_token",
        })
    if r.status_code != 200:
        logger.warning("[youtube-oauth] refresh failed: %s %s", r.status_code, r.text[:200])
        return None
    tok = r.json()
    access_token = tok.get("access_token")
    if not access_token:
        return None
    expires_in = int(tok.get("expires_in") or 3500)
    expiry = datetime.now(timezone.utc) + timedelta(seconds=expires_in - 60)
    await db.settings.update_one({"_id": OAUTH_SETTINGS_ID}, {"$set": {
        "access_token": access_token,
        "token_expiry": expiry.isoformat(),
        "refreshed_at": _now_iso(),
    }})
    return access_token


async def _get_access_token(db) -> Optional[str]:
    """Return a valid access token, refreshing if needed. None when not connected."""
    doc = await _load_oauth_doc(db)
    if not doc:
        return None
    tok = doc.get("access_token")
    exp = doc.get("token_expiry")
    if tok and exp:
        try:
            if datetime.fromisoformat(exp) > datetime.now(timezone.utc):
                return tok
        except Exception:
            pass
    return await _refresh_access_token(db, doc)


# ---------------------------------------------------------------------
# YouTube API helpers — single helper, picks OAuth or API-key transparently
# ---------------------------------------------------------------------
async def _yt_get(
    client: httpx.AsyncClient,
    path: str,
    params: dict,
    *,
    access_token: Optional[str] = None,
) -> dict:
    headers: dict = {}
    if access_token:
        headers["Authorization"] = f"Bearer {access_token}"
    else:
        params = {**params, "key": _api_key()}
    r = await client.get(
        f"{YOUTUBE_API_BASE}/{path}", params=params, headers=headers, timeout=20.0,
    )
    if r.status_code >= 400:
        try:
            body = r.json()
        except Exception:  # noqa: BLE001
            body = {"raw": r.text[:200]}
        raise HTTPException(
            502,
            detail=f"YouTube API error ({r.status_code}): {body.get('error',{}).get('message') or body}",
        )
    return r.json()


async def _fetch_channel_playlists(
    client: httpx.AsyncClient, *, access_token: Optional[str] = None,
) -> list[dict]:
    """List every playlist on our channel (handles pagination).

    When ``access_token`` is provided we use ``mine=true`` which surfaces
    Public + Unlisted + Private playlists owned by the authenticated user.
    Otherwise we fall back to ``channelId=…`` which only sees Public ones.
    """
    out: list[dict] = []
    page_token: Optional[str] = None
    while True:
        params: dict = {"part": "snippet,contentDetails,status", "maxResults": 50}
        if access_token:
            params["mine"] = "true"
        else:
            params["channelId"] = _channel_id()
        if page_token:
            params["pageToken"] = page_token
        data = await _yt_get(client, "playlists", params, access_token=access_token)
        out.extend(data.get("items", []))
        page_token = data.get("nextPageToken")
        if not page_token:
            break
    return out


async def _fetch_playlist_videos(
    client: httpx.AsyncClient, playlist_id: str, *,
    access_token: Optional[str] = None,
) -> list[dict]:
    """List every video in a playlist + their durations (handles pagination)."""
    items: list[dict] = []
    page_token: Optional[str] = None
    while True:
        params: dict = {
            "part": "snippet,contentDetails",
            "playlistId": playlist_id,
            "maxResults": 50,
        }
        if page_token:
            params["pageToken"] = page_token
        data = await _yt_get(client, "playlistItems", params, access_token=access_token)
        items.extend(data.get("items", []))
        page_token = data.get("nextPageToken")
        if not page_token:
            break
    # Pull durations in batches of 50.
    video_ids = [it["contentDetails"]["videoId"] for it in items
                 if it.get("contentDetails", {}).get("videoId")]
    durations: dict[str, str] = {}
    for i in range(0, len(video_ids), 50):
        batch = video_ids[i:i + 50]
        data = await _yt_get(client, "videos", {
            "part": "contentDetails",
            "id": ",".join(batch),
        }, access_token=access_token)
        for v in data.get("items", []):
            durations[v["id"]] = v.get("contentDetails", {}).get("duration", "")
    # Normalise.
    out: list[dict] = []
    for it in items:
        sn = it.get("snippet", {})
        vid = it.get("contentDetails", {}).get("videoId")
        if not vid:
            continue
        thumbs = sn.get("thumbnails") or {}
        best_thumb = (
            (thumbs.get("maxres") or thumbs.get("standard") or thumbs.get("high")
             or thumbs.get("medium") or thumbs.get("default") or {}).get("url") or ""
        )
        out.append({
            "youtube_id": vid,
            "title": sn.get("title") or "",
            "description": sn.get("description") or "",
            "thumbnail_url": best_thumb,
            "duration_iso": durations.get(vid, ""),
            "position": sn.get("position", 0),
            "published_at": sn.get("publishedAt") or "",
        })
    return out


def _best_thumb(thumbs: dict) -> str:
    for k in ("maxres", "standard", "high", "medium", "default"):
        v = (thumbs or {}).get(k) or {}
        if v.get("url"):
            return v["url"]
    return ""


async def _sync_all_playlists(db, triggered_by: str) -> dict:
    """Pull every playlist from the channel and upsert into our cache."""
    log_id = str(uuid.uuid4())
    started = _now_iso()
    access_token = await _get_access_token(db)
    auth_mode = "oauth" if access_token else "api_key"
    summary = {
        "id": log_id,
        "started_at": started,
        "status": "running",
        "playlists_scanned": 0,
        "playlists_added": 0,
        "playlists_updated": 0,
        "videos_synced": 0,
        "error": None,
        "triggered_by": triggered_by,
        "auth_mode": auth_mode,
    }
    await db.youtube_sync_log.insert_one(summary.copy())

    added = updated = videos_synced = 0
    errors: list[str] = []

    try:
        async with httpx.AsyncClient() as client:
            playlists = await _fetch_channel_playlists(client, access_token=access_token)
            summary["playlists_scanned"] = len(playlists)
            for pl in playlists:
                yt_id = pl.get("id")
                sn = pl.get("snippet", {})
                cd = pl.get("contentDetails", {})
                st = pl.get("status", {}) or {}
                if not yt_id:
                    continue
                try:
                    videos = await _fetch_playlist_videos(
                        client, yt_id, access_token=access_token,
                    )
                except HTTPException as exc:
                    errors.append(f"{yt_id}: {exc.detail}")
                    continue
                videos_synced += len(videos)
                existing = await db.youtube_playlists.find_one(
                    {"youtube_id": yt_id}, {"_id": 0, "id": 1, "category": 1,
                                             "enabled": 1, "sort_order": 1},
                )
                doc = {
                    "youtube_id": yt_id,
                    "title": sn.get("title") or "",
                    "description": sn.get("description") or "",
                    "thumbnail_url": _best_thumb(sn.get("thumbnails")),
                    "video_count": cd.get("itemCount", len(videos)),
                    "published_at": sn.get("publishedAt") or "",
                    "privacy_status": st.get("privacyStatus") or "",
                    "videos": videos,
                    "last_synced_at": _now_iso(),
                    "updated_at": _now_iso(),
                }
                if existing:
                    await db.youtube_playlists.update_one(
                        {"id": existing["id"]}, {"$set": doc},
                    )
                    updated += 1
                else:
                    doc["id"] = str(uuid.uuid4())
                    doc["created_at"] = _now_iso()
                    doc["category"] = None
                    doc["enabled"] = False
                    doc["sort_order"] = 0
                    await db.youtube_playlists.insert_one(doc)
                    added += 1
        status = "success" if not errors else "partial"
    except Exception as exc:  # noqa: BLE001
        logger.warning("[youtube-sync] failed: %s", exc, exc_info=True)
        status = "failed"
        errors.append(str(exc))

    summary["status"] = status
    summary["playlists_added"] = added
    summary["playlists_updated"] = updated
    summary["videos_synced"] = videos_synced
    summary["finished_at"] = _now_iso()
    summary["error"] = "; ".join(errors)[:500] or None
    await db.youtube_sync_log.update_one(
        {"id": log_id}, {"$set": summary},
    )
    return summary


def attach(api: APIRouter, db, require_role):
    # -----------------------------------------------------------------
    # OAuth — admin endpoints
    # -----------------------------------------------------------------
    @api.get("/admin/youtube/oauth/status")
    async def oauth_status(user: dict = Depends(require_role("admin"))):
        doc = await db.settings.find_one({"_id": OAUTH_SETTINGS_ID}, {"_id": 0})
        return {
            "configured": bool(
                os.environ.get("YOUTUBE_OAUTH_CLIENT_ID")
                and os.environ.get("YOUTUBE_OAUTH_CLIENT_SECRET")
            ),
            "connected": bool(doc and doc.get("refresh_token")),
            "connected_email": (doc or {}).get("connected_email"),
            "connected_channel": (doc or {}).get("connected_channel"),
            "connected_at": (doc or {}).get("connected_at"),
            "redirect_uri": _oauth_redirect_uri(),
        }

    @api.get("/admin/youtube/oauth/auth-url")
    async def oauth_auth_url(user: dict = Depends(require_role("admin"))):
        cid, _sec = _oauth_creds_or_raise()
        params = {
            "client_id": cid,
            "redirect_uri": _oauth_redirect_uri(),
            "response_type": "code",
            "scope": " ".join(OAUTH_SCOPES),
            "access_type": "offline",
            "prompt": "consent",  # force refresh_token even on re-grant
            "include_granted_scopes": "true",
        }
        return {"url": f"https://accounts.google.com/o/oauth2/auth?{urlencode(params)}"}

    @api.get("/admin/youtube/oauth/callback")
    async def oauth_callback(code: str = Query(...), error: Optional[str] = Query(None)):
        # No auth dep — Google calls this directly via browser redirect.
        if error:
            return RedirectResponse(f"{_public_app_url()}/admin/youtube?yt_error={error}")
        try:
            cid, sec = _oauth_creds_or_raise()
        except HTTPException as exc:
            return RedirectResponse(f"{_public_app_url()}/admin/youtube?yt_error={exc.detail}")
        async with httpx.AsyncClient(timeout=15.0) as http:
            r = await http.post("https://oauth2.googleapis.com/token", data={
                "code": code,
                "client_id": cid,
                "client_secret": sec,
                "redirect_uri": _oauth_redirect_uri(),
                "grant_type": "authorization_code",
            })
            if r.status_code != 200:
                logger.warning("[youtube-oauth] token exchange failed: %s %s", r.status_code, r.text[:300])
                return RedirectResponse(f"{_public_app_url()}/admin/youtube?yt_error=token_exchange_failed")
            tok = r.json()
            access_token = tok.get("access_token")
            refresh_token = tok.get("refresh_token")
            expires_in = int(tok.get("expires_in") or 3500)
            # Capture which Google account + channel just authorised — purely for audit display.
            email = None
            channel_title = None
            try:
                ui = await http.get(
                    "https://www.googleapis.com/oauth2/v2/userinfo",
                    headers={"Authorization": f"Bearer {access_token}"})
                if ui.status_code == 200:
                    email = ui.json().get("email")
                ch = await http.get(
                    f"{YOUTUBE_API_BASE}/channels",
                    params={"part": "snippet", "mine": "true"},
                    headers={"Authorization": f"Bearer {access_token}"})
                if ch.status_code == 200:
                    items = ch.json().get("items") or []
                    if items:
                        channel_title = (items[0].get("snippet") or {}).get("title")
            except Exception:  # noqa: BLE001
                pass

        if not refresh_token:
            # Google only emits refresh_token on first consent; force a re-prompt if missing.
            return RedirectResponse(f"{_public_app_url()}/admin/youtube?yt_error=no_refresh_token_remove_app_access_and_retry")

        expiry = datetime.now(timezone.utc) + timedelta(seconds=expires_in - 60)
        await db.settings.update_one({"_id": OAUTH_SETTINGS_ID}, {"$set": {
            "access_token": access_token,
            "refresh_token": refresh_token,
            "token_expiry": expiry.isoformat(),
            "scope": tok.get("scope"),
            "connected_email": email,
            "connected_channel": channel_title,
            "connected_at": _now_iso(),
        }}, upsert=True)
        return RedirectResponse(f"{_public_app_url()}/admin/youtube?yt_connected=1")

    @api.post("/admin/youtube/oauth/disconnect")
    async def oauth_disconnect(user: dict = Depends(require_role("admin"))):
        await db.settings.delete_one({"_id": OAUTH_SETTINGS_ID})
        return {"ok": True}

    # -----------------------------------------------------------------
    # ADMIN endpoints
    # -----------------------------------------------------------------
    @api.post("/admin/youtube/sync")
    async def admin_sync(user: dict = Depends(require_role("admin"))):
        return await _sync_all_playlists(db, triggered_by=f"manual:{user.get('email')}")

    @api.get("/admin/youtube/playlists")
    async def admin_list(user: dict = Depends(require_role("admin"))):
        items: list[dict] = []
        async for p in db.youtube_playlists.find({}, {"_id": 0, "videos": 0}).sort(
            [("sort_order", 1), ("title", 1)],
        ):
            items.append(p)
        return {"items": items, "total": len(items)}

    @api.patch("/admin/youtube/playlists/{playlist_id}")
    async def admin_patch(
        playlist_id: str, body: dict,
        user: dict = Depends(require_role("admin")),
    ):
        existing = await db.youtube_playlists.find_one(
            {"id": playlist_id}, {"_id": 0, "id": 1},
        )
        if not existing:
            raise HTTPException(404, "Playlist not found")
        patch: dict[str, Any] = {}
        if "category" in body:
            cat = body["category"] or None
            if cat not in CATEGORY_VALUES:
                raise HTTPException(400, f"category must be one of {sorted(c for c in CATEGORY_VALUES if c)}")
            patch["category"] = cat
        if "enabled" in body:
            patch["enabled"] = bool(body["enabled"])
        if "sort_order" in body:
            try:
                patch["sort_order"] = int(body["sort_order"])
            except (TypeError, ValueError):
                raise HTTPException(400, "sort_order must be an int")
        if not patch:
            return {"ok": True, "noop": True}
        patch["updated_at"] = _now_iso()
        patch["updated_by"] = user.get("email")
        await db.youtube_playlists.update_one({"id": playlist_id}, {"$set": patch})
        return {"ok": True, "updated": list(patch.keys())}

    @api.post("/admin/youtube/playlists/{playlist_id}/refresh")
    async def admin_refresh_one(
        playlist_id: str, user: dict = Depends(require_role("admin")),
    ):
        existing = await db.youtube_playlists.find_one(
            {"id": playlist_id}, {"_id": 0, "youtube_id": 1},
        )
        if not existing:
            raise HTTPException(404, "Playlist not found")
        access_token = await _get_access_token(db)
        async with httpx.AsyncClient() as client:
            videos = await _fetch_playlist_videos(
                client, existing["youtube_id"], access_token=access_token,
            )
        await db.youtube_playlists.update_one(
            {"id": playlist_id},
            {"$set": {"videos": videos, "video_count": len(videos),
                      "last_synced_at": _now_iso()}},
        )
        return {"ok": True, "video_count": len(videos)}

    @api.get("/admin/youtube/sync-log")
    async def admin_sync_log(
        limit: int = 20,
        user: dict = Depends(require_role("admin")),
    ):
        items: list[dict] = []
        async for log in db.youtube_sync_log.find({}, {"_id": 0}).sort(
            "started_at", -1,
        ).limit(max(1, min(100, limit))):
            items.append(log)
        return {"items": items}

    # -----------------------------------------------------------------
    # PORTAL endpoints (franchisee-only)
    # -----------------------------------------------------------------
    @api.get("/portal/training")
    async def portal_training(
        user: dict = Depends(require_role("franchisee")),
    ):
        """Returns enabled+categorised playlists grouped by category.
        Read-only cache hit — never touches YouTube."""
        groups = {"training": [], "meetings": []}
        async for p in db.youtube_playlists.find(
            {"enabled": True, "category": {"$in": list(groups.keys())}},
            {"_id": 0, "videos": 0},
        ).sort([("sort_order", 1), ("title", 1)]):
            cat = p.get("category")
            if cat in groups:
                groups[cat].append(p)
        return {"groups": groups}

    @api.get("/portal/training/{playlist_id}")
    async def portal_training_playlist(
        playlist_id: str, user: dict = Depends(require_role("franchisee")),
    ):
        p = await db.youtube_playlists.find_one(
            {"id": playlist_id, "enabled": True}, {"_id": 0},
        )
        if not p:
            raise HTTPException(404, "Playlist not found or not available")
        return p

    return api


# ---------------------------------------------------------------------
# Scheduler — invoked from server.py startup
# ---------------------------------------------------------------------
async def start_scheduler(db):
    """Run a daily sync at ~03:00 UTC."""
    async def _loop():
        while True:
            try:
                now = datetime.now(timezone.utc)
                target = now.replace(hour=3, minute=0, second=0, microsecond=0)
                if target <= now:
                    target = target + timedelta(days=1)
                await asyncio.sleep((target - now).total_seconds())
                logger.info("[youtube-sync] daily scheduler tick")
                await _sync_all_playlists(db, triggered_by="scheduler")
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                logger.warning("[youtube-sync] scheduler tick failed: %s", exc)
                await asyncio.sleep(3600)

    if not (os.environ.get("YOUTUBE_API_KEY") and os.environ.get("YOUTUBE_CHANNEL_ID")):
        logger.info("[youtube-sync] scheduler not started — env vars missing")
        return None
    task = asyncio.create_task(_loop())
    logger.info("[youtube-sync] daily scheduler started")
    return task
