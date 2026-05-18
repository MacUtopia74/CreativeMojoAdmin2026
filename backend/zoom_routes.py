"""Zoom Server-to-Server OAuth integration.

Lets the admin generate a Zoom meeting join URL from the Calendar event
modal in one click. The resulting URL is then stored on the calendar
event via the existing ``meeting_url`` field (same field Microsoft Teams
links use), so the rest of the app — the "Join meeting" buttons on
admin + portal calendar rows — keeps working unchanged.

Auth model
----------
* Server-to-Server OAuth app (account-level), credentials read from env:
    - ZOOM_ACCOUNT_ID
    - ZOOM_CLIENT_ID
    - ZOOM_CLIENT_SECRET
* Single shared host account: ``headoffice@creativemojo.co.uk``. All
  meetings are scheduled under that user (``POST /users/me/meetings``).
* Access tokens last 1h and have no refresh token. We cache the current
  token in-memory and re-mint when within 60s of expiry.

Endpoints (all admin-only)
--------------------------
GET  /api/zoom/status          → configured / not configured + masked client id
POST /api/zoom/meetings        → create scheduled meeting, returns join_url + passcode
"""
from __future__ import annotations

import asyncio
import base64
import logging
import os
import time
from datetime import datetime, timezone
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

logger = logging.getLogger("creative-mojo-admin.zoom")

ZOOM_TOKEN_URL = "https://zoom.us/oauth/token"
ZOOM_API_BASE = "https://api.zoom.us/v2"

# In-memory token cache. Single-process FastAPI + supervisor means this is
# safe; if we ever scale horizontally we'll move it to Mongo / Redis.
_token_state: dict = {"access_token": None, "expires_at": 0.0}
_token_lock = asyncio.Lock()


def _env() -> tuple[str, str, str]:
    account = os.environ.get("ZOOM_ACCOUNT_ID")
    client_id = os.environ.get("ZOOM_CLIENT_ID")
    client_secret = os.environ.get("ZOOM_CLIENT_SECRET")
    if not (account and client_id and client_secret):
        raise HTTPException(
            500,
            detail="Zoom not configured — set ZOOM_ACCOUNT_ID / ZOOM_CLIENT_ID / ZOOM_CLIENT_SECRET in backend .env",
        )
    return account, client_id, client_secret


async def _get_access_token() -> str:
    """Return a valid Zoom access token, fetching a new one if needed."""
    now = time.time()
    cached = _token_state.get("access_token")
    if cached and _token_state.get("expires_at", 0) - 60 > now:
        return cached  # type: ignore[return-value]

    async with _token_lock:
        # Re-check inside the lock — another coroutine may have refreshed.
        now = time.time()
        cached = _token_state.get("access_token")
        if cached and _token_state.get("expires_at", 0) - 60 > now:
            return cached  # type: ignore[return-value]

        account, client_id, client_secret = _env()
        basic = base64.b64encode(f"{client_id}:{client_secret}".encode()).decode()
        headers = {
            "Authorization": f"Basic {basic}",
            "Content-Type": "application/x-www-form-urlencoded",
        }
        data = {"grant_type": "account_credentials", "account_id": account}
        async with httpx.AsyncClient(timeout=20.0) as client:
            r = await client.post(ZOOM_TOKEN_URL, headers=headers, data=data)
        if r.status_code != 200:
            logger.warning("Zoom token mint failed: %s %s", r.status_code, r.text[:300])
            raise HTTPException(
                502,
                detail=f"Zoom OAuth failed ({r.status_code}). Check Account ID / Client ID / Client Secret and that the Marketplace app is Activated.",
            )
        payload = r.json()
        access = payload.get("access_token")
        expires_in = int(payload.get("expires_in") or 3600)
        if not access:
            raise HTTPException(502, detail="Zoom OAuth: no access_token in response")
        _token_state["access_token"] = access
        _token_state["expires_at"] = time.time() + expires_in
        return access


# ---------------------------------------------------------------- models
class CreateMeetingIn(BaseModel):
    topic: str = Field(..., min_length=1, max_length=200)
    start_time: str  # ISO 8601 UTC, e.g. "2026-02-20T13:00:00Z"
    duration: int = Field(60, ge=5, le=1440, description="Minutes")
    timezone: str = "Europe/London"
    require_passcode: bool = True
    enable_waiting_room: bool = False
    agenda: Optional[str] = Field(None, max_length=2000)


class CreateMeetingOut(BaseModel):
    id: int
    topic: str
    start_time: str
    duration: int
    timezone: str
    join_url: str
    password: Optional[str] = None
    start_url: Optional[str] = None


# ------------------------------------------------------------- router
def attach(api, db, require_role):
    router = APIRouter()

    @router.get("/zoom/status")
    async def status(_: dict = Depends(require_role("admin"))):
        client_id = os.environ.get("ZOOM_CLIENT_ID")
        account = os.environ.get("ZOOM_ACCOUNT_ID")
        configured = bool(client_id and account and os.environ.get("ZOOM_CLIENT_SECRET"))
        masked = (client_id[:4] + "…" + client_id[-3:]) if client_id else None
        return {
            "configured": configured,
            "client_id_masked": masked,
            "account_id_masked": (account[:4] + "…" + account[-3:]) if account else None,
            "host_email": "headoffice@creativemojo.co.uk",
        }

    @router.post("/zoom/meetings", response_model=CreateMeetingOut)
    async def create_meeting(body: CreateMeetingIn, user: dict = Depends(require_role("admin"))):
        _env()  # raises 500 if mis-configured
        access = await _get_access_token()
        # Zoom expects start_time WITHOUT a trailing Z if `timezone` is set,
        # otherwise it ignores the timezone field. Strip the Z if present.
        start = body.start_time
        if body.timezone and start.endswith("Z"):
            # convert UTC ISO to local-naive ISO in the requested timezone.
            try:
                from zoneinfo import ZoneInfo
                dt = datetime.fromisoformat(start.replace("Z", "+00:00"))
                local = dt.astimezone(ZoneInfo(body.timezone))
                start = local.strftime("%Y-%m-%dT%H:%M:%S")
            except Exception:  # noqa: BLE001
                # If zoneinfo is unhappy with the tz name, just send the
                # UTC time and let Zoom interpret it.
                start = body.start_time.rstrip("Z")

        request_body: dict = {
            "topic": body.topic[:200],
            "type": 2,  # scheduled meeting
            "start_time": start,
            "duration": body.duration,
            "timezone": body.timezone,
            "agenda": (body.agenda or "")[:2000],
            "settings": {
                "host_video": False,
                "participant_video": False,
                "join_before_host": True,
                "mute_upon_entry": True,
                "waiting_room": bool(body.enable_waiting_room),
                "approval_type": 2,  # no registration required
            },
        }
        # If a passcode is required we let Zoom auto-generate one (so it
        # complies with the account's passcode policy). If the caller
        # explicitly says no passcode AND waiting room is off, Zoom will
        # apply whatever the account policy mandates.
        if not body.require_passcode:
            # Explicitly disable meeting password if account policy allows
            request_body["password"] = ""

        headers = {
            "Authorization": f"Bearer {access}",
            "Content-Type": "application/json",
        }
        url = f"{ZOOM_API_BASE}/users/me/meetings"
        async with httpx.AsyncClient(timeout=20.0) as client:
            r = await client.post(url, headers=headers, json=request_body)
        if r.status_code == 429:
            raise HTTPException(
                429,
                detail="Zoom daily meeting limit (100/day per host) reached. Reset at 00:00 UTC.",
            )
        if r.status_code >= 400:
            logger.warning("Zoom create meeting failed: %s %s", r.status_code, r.text[:500])
            try:
                msg = r.json().get("message") or r.text
            except Exception:  # noqa: BLE001
                msg = r.text
            raise HTTPException(r.status_code, detail=f"Zoom: {msg}")
        data = r.json()

        # Audit trail — useful for debugging and the 100/day cap.
        try:
            await db.zoom_audit.insert_one({
                "zoom_meeting_id": data.get("id"),
                "topic": data.get("topic"),
                "start_time": data.get("start_time"),
                "duration": data.get("duration"),
                "timezone": data.get("timezone"),
                "join_url": data.get("join_url"),
                "created_by": user.get("email"),
                "created_at": datetime.now(timezone.utc),
            })
        except Exception as exc:  # noqa: BLE001
            logger.warning("Zoom audit log insert failed (non-fatal): %s", exc)

        return CreateMeetingOut(
            id=int(data.get("id")),
            topic=data.get("topic") or body.topic,
            start_time=data.get("start_time") or body.start_time,
            duration=int(data.get("duration") or body.duration),
            timezone=data.get("timezone") or body.timezone,
            join_url=data.get("join_url"),
            password=data.get("password"),
            start_url=data.get("start_url"),
        )

    return router
