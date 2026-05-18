"""Phase 5 — Google Calendar integration (admin-only).

Connects the Creative Mojo admin to a single shared Google Calendar via
OAuth. One-off authorisation is performed by any admin who has access to
the calendar; the resulting refresh token is stored on disk in the
shared ``google_oauth`` settings doc so future server restarts pick it up.

Endpoints
---------
GET  /api/calendar/status        → "connected"/"disconnected" + which Google
                                   account authorised
GET  /api/calendar/auth-url      → returns the URL the admin should open to
                                   grant access (handles ?return_to=)
GET  /api/oauth/calendar/callback→ Google's redirect target. Exchanges code,
                                   stores tokens, redirects back to the
                                   admin's /calendar page.
POST /api/calendar/disconnect    → wipes the stored credentials
GET  /api/calendar/events        → upcoming events on the configured calendar
POST /api/calendar/events        → create event (with optional meeting URL)
PATCH /api/calendar/events/{id}  → update event
DELETE /api/calendar/events/{id} → delete event

Required environment (all in /app/backend/.env)
-----------------------------------------------
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
GOOGLE_CALENDAR_ID         (e.g. "creative-mojo@group.calendar.google.com")
GOOGLE_OAUTH_REDIRECT_URI  (defaults to {REACT_APP_BACKEND_URL}/api/oauth/calendar/callback)

Auth scope
----------
https://www.googleapis.com/auth/calendar  (read+write)
"""
from __future__ import annotations

import logging
import os
from datetime import datetime, timezone
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field

from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request as GoogleRequest
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

logger = logging.getLogger("creative-mojo-admin.calendar")

SETTINGS_ID = "google_calendar"
SCOPES = ["https://www.googleapis.com/auth/calendar"]


def _redirect_uri() -> str:
    explicit = os.environ.get("GOOGLE_OAUTH_REDIRECT_URI")
    if explicit:
        return explicit
    base = (os.environ.get("REACT_APP_BACKEND_URL") or "").rstrip("/")
    return f"{base}/api/oauth/calendar/callback"


def _public_app_url() -> str:
    return (os.environ.get("FRONTEND_URL") or os.environ.get("REACT_APP_BACKEND_URL") or "").rstrip("/")


def _env_or_raise() -> tuple[str, str, str]:
    client_id = os.environ.get("GOOGLE_CLIENT_ID")
    client_secret = os.environ.get("GOOGLE_CLIENT_SECRET")
    calendar_id = os.environ.get("GOOGLE_CALENDAR_ID")
    if not client_id or not client_secret:
        raise HTTPException(500, detail="Google Calendar not configured: set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in backend .env")
    if not calendar_id:
        raise HTTPException(500, detail="Google Calendar not configured: set GOOGLE_CALENDAR_ID in backend .env")
    return client_id, client_secret, calendar_id


class EventIn(BaseModel):
    title: str = Field(..., min_length=1, max_length=300)
    description: Optional[str] = Field(None, max_length=4000)
    location: Optional[str] = Field(None, max_length=500)
    start: str  # ISO 8601
    end: str    # ISO 8601
    all_day: bool = False
    meeting_url: Optional[str] = None  # e.g. MS Teams join URL


def _shape_event(e: dict) -> dict:
    """Trim Google's event payload to what the frontend renders."""
    start = e.get("start") or {}
    end = e.get("end") or {}
    return {
        "id": e.get("id"),
        "title": e.get("summary") or "(no title)",
        "description": e.get("description"),
        "location": e.get("location"),
        "start": start.get("dateTime") or start.get("date"),
        "end": end.get("dateTime") or end.get("date"),
        "all_day": "date" in start and "dateTime" not in start,
        "meeting_url": (e.get("extendedProperties") or {}).get("shared", {}).get("meeting_url"),
        "html_link": e.get("htmlLink"),
        "creator_email": (e.get("creator") or {}).get("email"),
        "status": e.get("status"),
    }


def attach(api, db, require_role, get_current_user=None):
    router = APIRouter()

    async def _load_creds() -> Optional[Credentials]:
        doc = await db.settings.find_one({"_id": SETTINGS_ID}, {"_id": 0})
        if not doc or not doc.get("refresh_token"):
            return None
        client_id, client_secret, _ = _env_or_raise()
        creds = Credentials(
            token=doc.get("access_token"),
            refresh_token=doc.get("refresh_token"),
            token_uri="https://oauth2.googleapis.com/token",
            client_id=client_id,
            client_secret=client_secret,
            scopes=SCOPES,
        )
        # Refresh if expired/missing
        if not creds.valid:
            try:
                creds.refresh(GoogleRequest())
                await db.settings.update_one({"_id": SETTINGS_ID}, {"$set": {
                    "access_token": creds.token,
                    "token_expiry": creds.expiry.isoformat() if creds.expiry else None,
                    "refreshed_at": datetime.now(timezone.utc).isoformat(),
                }})
            except Exception as exc:  # noqa: BLE001
                logger.warning("Google token refresh failed: %s", exc)
                return None
        return creds

    async def _service():
        creds = await _load_creds()
        if not creds:
            raise HTTPException(401, detail="Google Calendar not connected — open Calendar → Connect")
        return build("calendar", "v3", credentials=creds, cache_discovery=False)

    # --------------------------------------------------------------- status
    @router.get("/calendar/status")
    async def status(_: dict = Depends(require_role("admin"))):
        doc = await db.settings.find_one({"_id": SETTINGS_ID}, {"_id": 0})
        client_id = os.environ.get("GOOGLE_CLIENT_ID")
        calendar_id = os.environ.get("GOOGLE_CALENDAR_ID")
        return {
            "configured": bool(client_id and os.environ.get("GOOGLE_CLIENT_SECRET")),
            "calendar_id": calendar_id,
            "connected": bool(doc and doc.get("refresh_token")),
            "connected_email": (doc or {}).get("connected_email"),
            "connected_at": (doc or {}).get("connected_at"),
            "redirect_uri": _redirect_uri(),
        }

    # ------------------------------------------------------------ auth URL
    @router.get("/calendar/auth-url")
    async def auth_url(_: dict = Depends(require_role("admin"))):
        client_id, _client_secret, _cal = _env_or_raise()
        params = {
            "client_id": client_id,
            "redirect_uri": _redirect_uri(),
            "response_type": "code",
            "scope": " ".join(SCOPES),
            "access_type": "offline",
            "prompt": "consent",  # force refresh_token on every grant
            "include_granted_scopes": "true",
        }
        from urllib.parse import urlencode
        return {"url": f"https://accounts.google.com/o/oauth2/auth?{urlencode(params)}"}

    # ------------------------------------------------------------- callback
    @router.get("/oauth/calendar/callback")
    async def oauth_callback(code: str = Query(...), error: Optional[str] = Query(None)):
        # NOTE: no auth dep here — Google calls this directly.
        if error:
            return RedirectResponse(f"{_public_app_url()}/calendar?error={error}")
        client_id, client_secret, _ = _env_or_raise()
        async with httpx.AsyncClient(timeout=15.0) as http:
            r = await http.post("https://oauth2.googleapis.com/token", data={
                "code": code,
                "client_id": client_id,
                "client_secret": client_secret,
                "redirect_uri": _redirect_uri(),
                "grant_type": "authorization_code",
            })
            if r.status_code != 200:
                logger.warning("Google token exchange failed: %s %s", r.status_code, r.text)
                return RedirectResponse(f"{_public_app_url()}/calendar?error=token_exchange_failed")
            tok = r.json()
            # Pull the email of whoever just authorised — we record it for audit
            ui = await http.get(
                "https://www.googleapis.com/oauth2/v2/userinfo",
                headers={"Authorization": f"Bearer {tok.get('access_token')}"})
            email = (ui.json() if ui.status_code == 200 else {}).get("email")
        await db.settings.update_one({"_id": SETTINGS_ID}, {"$set": {
            "access_token": tok.get("access_token"),
            "refresh_token": tok.get("refresh_token"),  # may be None if user re-granted without prompt=consent
            "scope": tok.get("scope"),
            "connected_email": email,
            "connected_at": datetime.now(timezone.utc).isoformat(),
        }}, upsert=True)
        return RedirectResponse(f"{_public_app_url()}/calendar?connected=1")

    # ------------------------------------------------------------ disconnect
    @router.post("/calendar/disconnect")
    async def disconnect(_: dict = Depends(require_role("admin"))):
        await db.settings.delete_one({"_id": SETTINGS_ID})
        return {"ok": True}

    # ---------------------------------------------------------- list events
    @router.get("/calendar/events")
    async def list_events(
        days_ahead: int = Query(60, ge=1, le=365),
        days_back: int = Query(7, ge=0, le=3650),
        time_min: Optional[str] = Query(None, description="Override window start (RFC3339)"),
        time_max: Optional[str] = Query(None, description="Override window end (RFC3339)"),
        _: dict = Depends(require_role("admin")),
    ):
        _, _, calendar_id = _env_or_raise()
        service = await _service()
        from datetime import timedelta
        now = datetime.now(timezone.utc)
        # Explicit overrides win — used by the front-end month grid so admins
        # can browse historic and future months without missing events.
        effective_min = time_min or (now - timedelta(days=days_back)).isoformat()
        effective_max = time_max or (now + timedelta(days=days_ahead)).isoformat()
        try:
            res = service.events().list(
                calendarId=calendar_id,
                timeMin=effective_min,
                timeMax=effective_max,
                maxResults=2500,
                singleEvents=True,
                orderBy="startTime",
            ).execute()
        except HttpError as exc:
            raise HTTPException(502, detail=f"Google Calendar API error: {exc}") from exc
        events = [_shape_event(e) for e in res.get("items", [])]
        return {"events": events, "count": len(events)}

    # ------------------------------------------------ portal: list events
    # Any authenticated user (admin / franchisee / licensee) can see the
    # upcoming events feed read-only. The franchisee portal renders this
    # in a new "Events" panel so people can join Teams meetings without
    # the admin having to email them the link.
    if get_current_user is not None:
        @router.get("/calendar/portal-events")
        async def list_portal_events(
            days_ahead: int = Query(60, ge=1, le=365),
            days_back: int = Query(0, ge=0, le=30),
            _: dict = Depends(get_current_user),
        ):
            try:
                _env_or_raise()
            except HTTPException:
                # Calendar not configured — just return an empty feed so the
                # portal panel renders a friendly "no events" state instead
                # of a 500.
                return {"events": [], "count": 0, "connected": False}
            try:
                service = await _service()
            except HTTPException:
                return {"events": [], "count": 0, "connected": False}
            _, _, calendar_id = _env_or_raise()
            from datetime import timedelta
            now = datetime.now(timezone.utc)
            time_min = (now - timedelta(days=days_back)).isoformat()
            time_max = (now + timedelta(days=days_ahead)).isoformat()
            try:
                res = service.events().list(
                    calendarId=calendar_id,
                    timeMin=time_min,
                    timeMax=time_max,
                    maxResults=200,
                    singleEvents=True,
                    orderBy="startTime",
                ).execute()
            except HttpError as exc:
                raise HTTPException(502, detail=f"Google Calendar API error: {exc}") from exc
            events = [_shape_event(e) for e in res.get("items", [])]
            return {"events": events, "count": len(events), "connected": True}

    # ---------------------------------------------------------- create
    @router.post("/calendar/events")
    async def create_event(body: EventIn, user: dict = Depends(require_role("admin"))):
        _, _, calendar_id = _env_or_raise()
        service = await _service()
        ev: dict = {
            "summary": body.title,
            "description": body.description or "",
            "location": body.location or "",
        }
        if body.all_day:
            # Google wants `date` (YYYY-MM-DD) for all-day events.
            ev["start"] = {"date": body.start[:10]}
            ev["end"] = {"date": body.end[:10]}
        else:
            ev["start"] = {"dateTime": body.start, "timeZone": "Europe/London"}
            ev["end"] = {"dateTime": body.end, "timeZone": "Europe/London"}
        if body.meeting_url:
            # Store the join URL as a shared extended property so we can show
            # a "Join meeting" button on the calendar page. We don't try to
            # create a real Teams meeting via Graph API yet (deferred).
            ev["extendedProperties"] = {"shared": {"meeting_url": body.meeting_url}}
            # Also tack it onto the description so it survives even if the
            # admin opens the event in Google Calendar directly.
            ev["description"] = (ev["description"] + "\n\nJoin: " + body.meeting_url).strip()
        try:
            created = service.events().insert(calendarId=calendar_id, body=ev).execute()
        except HttpError as exc:
            raise HTTPException(502, detail=f"Google Calendar API error: {exc}") from exc
        await db.calendar_audit.insert_one({
            "action": "create",
            "event_id": created.get("id"),
            "by": user.get("email"),
            "at": datetime.now(timezone.utc),
        })
        return _shape_event(created)

    # ---------------------------------------------------------- update
    @router.patch("/calendar/events/{event_id}")
    async def update_event(event_id: str, body: dict, user: dict = Depends(require_role("admin"))):
        _, _, calendar_id = _env_or_raise()
        service = await _service()
        # Pull current event, mutate, write back (Google's patch is partial
        # but nested objects must be sent in full).
        try:
            current = service.events().get(calendarId=calendar_id, eventId=event_id).execute()
        except HttpError as exc:
            raise HTTPException(404, detail=f"Event not found: {exc}") from exc
        if "title" in body and body["title"] is not None:
            current["summary"] = body["title"]
        if "description" in body and body["description"] is not None:
            current["description"] = body["description"]
        if "location" in body and body["location"] is not None:
            current["location"] = body["location"]
        if body.get("all_day") and body.get("start") and body.get("end"):
            current["start"] = {"date": body["start"][:10]}
            current["end"] = {"date": body["end"][:10]}
        elif body.get("start") and body.get("end"):
            current["start"] = {"dateTime": body["start"], "timeZone": "Europe/London"}
            current["end"] = {"dateTime": body["end"], "timeZone": "Europe/London"}
        if body.get("meeting_url") is not None:
            current.setdefault("extendedProperties", {}).setdefault("shared", {})["meeting_url"] = body["meeting_url"]
        try:
            updated = service.events().update(calendarId=calendar_id, eventId=event_id, body=current).execute()
        except HttpError as exc:
            raise HTTPException(502, detail=f"Google Calendar API error: {exc}") from exc
        await db.calendar_audit.insert_one({
            "action": "update", "event_id": event_id, "by": user.get("email"), "at": datetime.now(timezone.utc),
        })
        return _shape_event(updated)

    # ---------------------------------------------------------- delete
    @router.delete("/calendar/events/{event_id}")
    async def delete_event(event_id: str, user: dict = Depends(require_role("admin"))):
        _, _, calendar_id = _env_or_raise()
        service = await _service()
        try:
            service.events().delete(calendarId=calendar_id, eventId=event_id).execute()
        except HttpError as exc:
            raise HTTPException(502, detail=f"Google Calendar API error: {exc}") from exc
        await db.calendar_audit.insert_one({
            "action": "delete", "event_id": event_id, "by": user.get("email"), "at": datetime.now(timezone.utc),
        })
        return {"ok": True}

    return router
