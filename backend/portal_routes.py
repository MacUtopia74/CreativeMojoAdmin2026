"""Phase 3 — Franchisee portal authentication.

Admin meets franchisees in person and shares the portal URL. There is
no email step: a franchisee visits the URL, types their email, and
gets either a "Set your password" form (first time) or a "Enter your
password" form. Forgot-password is admin-driven (one-click reset
from FranchiseeDetailPage).

Implementation notes:
- We keep a single `users` collection for both admin and franchisee
  logins (role-based). A franchisee `users` doc is created lazily
  on first portal interaction, linked back to the `franchisees` doc
  via `franchisee_id`.
- Brute-force protection is shared with admin login via the existing
  `login_attempts` collection so attacks can't fan out across the two
  login surfaces.
- The franchisee must have `portal_enabled: True` on their `franchisees`
  doc before any portal endpoint will accept them. Admin toggles this.
"""
from __future__ import annotations

from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException, Request, Response

from pydantic import BaseModel, EmailStr, Field


class _EmailBody(BaseModel):
    email: EmailStr


class _PortalLoginBody(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)


def build_portal_router(
    db,
    hash_password,
    verify_password,
    create_access_token,
    create_refresh_token,
    set_auth_cookies,
    check_lockout,
    record_failure,
    clear_failures,
    user_to_public,
):
    router = APIRouter()

    async def _resolve_franchisee(email: str) -> dict | None:
        """Find a franchisee whose primary email matches. Each franchisee
        has a Creative Mojo email (`mojo_email`). We also accept the
        legacy/contact fields as fallback for portability."""
        email = email.lower().strip()
        f = await db.franchisees.find_one(
            {"$or": [
                {"mojo_email": email},
                {"email": email},
                {"primary_email": email},
                {"contact_email": email},
            ]},
            {"_id": 0},
        )
        return f

    @router.post("/portal/login-check")
    async def portal_login_check(body: _EmailBody, request: Request):
        """Public. Tell the UI which form to render next."""
        ip = request.client.host if request.client else "unknown"
        identifier = f"{ip}:{body.email.lower().strip()}"
        await check_lockout(identifier)

        franchisee = await _resolve_franchisee(body.email)
        if not franchisee or not franchisee.get("portal_enabled"):
            # Don't leak whether the email exists — same response for
            # unknown or not-enabled. Helps mitigate enumeration.
            return {"exists": False, "needs_password_setup": False}

        # Find linked user doc (if any)
        user = await db.users.find_one(
            {"franchisee_id": franchisee["id"], "role": "franchisee"},
            {"_id": 0, "password_hash": 1},
        )
        needs_setup = not user or not user.get("password_hash")
        return {"exists": True, "needs_password_setup": needs_setup}

    @router.post("/portal/set-password")
    async def portal_set_password(
        body: _PortalLoginBody, request: Request, response: Response,
    ):
        """Public — first-time password creation. Refuses if the
        franchisee already has a password (use admin reset instead)."""
        ip = request.client.host if request.client else "unknown"
        identifier = f"{ip}:{body.email.lower().strip()}"
        await check_lockout(identifier)

        franchisee = await _resolve_franchisee(body.email)
        if not franchisee or not franchisee.get("portal_enabled"):
            await record_failure(identifier)
            raise HTTPException(403, detail="Portal access not enabled for this email. Please contact your administrator.")

        existing = await db.users.find_one(
            {"franchisee_id": franchisee["id"], "role": "franchisee"},
            {"_id": 0},
        )
        if existing and existing.get("password_hash"):
            await record_failure(identifier)
            raise HTTPException(
                409,
                detail="A password is already set for this account. Sign in instead, or ask the administrator to reset it.",
            )

        import uuid
        now = datetime.now(timezone.utc).isoformat()
        password_hash = hash_password(body.password)
        if existing:
            await db.users.update_one(
                {"id": existing["id"]},
                {"$set": {"password_hash": password_hash, "activated_at": now}},
            )
            user_id = existing["id"]
            user_email = existing["email"]
        else:
            user_id = str(uuid.uuid4())
            user_email = body.email.lower().strip()
            await db.users.insert_one({
                "id": user_id,
                "email": user_email,
                "role": "franchisee",
                "franchisee_id": franchisee["id"],
                "full_name": franchisee.get("full_name") or f"{franchisee.get('first_name') or ''} {franchisee.get('last_name') or ''}".strip(),
                "password_hash": password_hash,
                "created_at": now,
                "activated_at": now,
            })

        await clear_failures(identifier)
        access = create_access_token(user_id, user_email, "franchisee")
        refresh = create_refresh_token(user_id)
        set_auth_cookies(response, access, refresh)
        user = await db.users.find_one({"id": user_id}, {"_id": 0})
        return user_to_public(user)

    @router.post("/portal/login")
    async def portal_login(
        body: _PortalLoginBody, request: Request, response: Response,
    ):
        ip = request.client.host if request.client else "unknown"
        identifier = f"{ip}:{body.email.lower().strip()}"
        await check_lockout(identifier)

        franchisee = await _resolve_franchisee(body.email)
        if not franchisee or not franchisee.get("portal_enabled"):
            await record_failure(identifier)
            raise HTTPException(401, detail="Invalid email or password")

        user = await db.users.find_one(
            {"franchisee_id": franchisee["id"], "role": "franchisee"},
            {"_id": 0},
        )
        if not user or not user.get("password_hash"):
            await record_failure(identifier)
            raise HTTPException(401, detail="Invalid email or password")
        if not verify_password(body.password, user["password_hash"]):
            await record_failure(identifier)
            raise HTTPException(401, detail="Invalid email or password")

        await clear_failures(identifier)
        access = create_access_token(user["id"], user["email"], "franchisee")
        refresh = create_refresh_token(user["id"])
        set_auth_cookies(response, access, refresh)
        return user_to_public(user)

    return router
