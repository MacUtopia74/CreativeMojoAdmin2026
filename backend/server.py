from dotenv import load_dotenv
from pathlib import Path

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

import os
import logging
import asyncio
import re
import uuid
import bcrypt
import jwt
import httpx
from datetime import datetime, timezone, timedelta
import secrets
from typing import Optional, List, Literal, Dict, Any
from fastapi import FastAPI, APIRouter, Body, HTTPException, Request, Response, Depends, Query, UploadFile, File
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
from pydantic import BaseModel, EmailStr, Field, ConfigDict

# ----------------------------------------------------------------------------
# Config & Database
# ----------------------------------------------------------------------------
MONGO_URL = os.environ["MONGO_URL"]
# Portal URL used in branded emails (handover, password reset). Override
# via env in non-prod environments so localhost devs don't email links
# pointing at live production.
PORTAL_URL = os.environ.get("PORTAL_URL", "https://hub.creativemojo.co.uk")
DB_NAME = os.environ["DB_NAME"]
# JWT signing key. The env-provided value is used as a *seed*: on first
# boot we cache it in MongoDB and from then on the DB-backed value wins.
# This stops cookies issued by one pod from being rejected by another
# pod (or by the same pod after a restart) if the env value ever
# differs across instances/deploys — a subtle bug that surfaced in
# production as "Not authenticated" 401s immediately after a 200 login.
_JWT_SECRET_SEED = os.environ["JWT_SECRET"]
JWT_SECRET = _JWT_SECRET_SEED  # may be overwritten by _ensure_jwt_secret() below
JWT_ALGORITHM = "HS256"
ACCESS_TOKEN_MINUTES = 60 * 8  # 8 hours for an admin tool
REFRESH_TOKEN_DAYS = 7
FRONTEND_URL = os.environ.get("FRONTEND_URL", "http://localhost:3000")
INTAKE_TOKEN = os.environ.get("INTAKE_TOKEN", "")

client = AsyncIOMotorClient(MONGO_URL)
db = client[DB_NAME]

app = FastAPI(title="Creative Mojo Admin API")
api = APIRouter(prefix="/api")


# ----------------------------------------------------------------------------
# Logging
# ----------------------------------------------------------------------------
logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s")
logger = logging.getLogger("creative-mojo-admin")


# ----------------------------------------------------------------------------
# Models
# ----------------------------------------------------------------------------
Role = Literal["admin", "franchisee", "licensee"]

# Whitelist of nav-permission keys that can be granted to a restricted
# admin user. Keys match the testid suffix on each sidebar leaf
# (Layout.js) and the perm checkboxes on the Admin Users page. Adding a
# new admin page? Append its key here AND register it in the frontend
# ``ADMIN_NAV_KEYS`` constant so the two stay in lock-step.
ADMIN_NAV_KEYS = {
    "dashboard", "orders",
    "franchisees", "renewals", "territory-builder", "files",
    "contacts", "calendar",
    "find-class", "cqc-definitions", "scotland-definitions", "ni-definitions", "help-centre", "subscription-requests",
    "invoices", "banking",
    "admin-users", "admin-email-templates", "admin-youtube",
    "admin-announcements", "admin-logs", "admin-xero", "admin-shape-orders", "form-intake",
}


def normalise_nav_permissions(raw):
    """Coerce a user-provided nav_permissions value into a sorted list of
    valid keys, or ``None`` for "no restriction"."""
    if raw is None:
        return None
    if isinstance(raw, str):
        # Tolerate single-string accidental passes.
        raw = [raw]
    if not isinstance(raw, list):
        raise HTTPException(status_code=400, detail="nav_permissions must be a list of strings or null")
    cleaned = []
    for item in raw:
        s = str(item or "").strip()
        if not s:
            continue
        if s not in ADMIN_NAV_KEYS:
            raise HTTPException(status_code=400, detail=f"Unknown nav_permission key: {s}")
        if s not in cleaned:
            cleaned.append(s)
    cleaned.sort()
    # Empty list explicitly means "no pages" — keep as []. Callers who
    # want "full access" should pass null/None instead.
    return cleaned


class UserPublic(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str
    email: EmailStr
    name: str
    role: Role
    created_at: datetime


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class CreateUserRequest(BaseModel):
    email: EmailStr
    password: str
    name: str
    role: Role = "admin"
    franchisee_id: Optional[str] = None  # only meaningful when role == "franchisee"
    # None  → unrestricted (default, full access)
    # []    → no admin pages accessible (rare)
    # [...] → only the listed page keys are reachable
    nav_permissions: Optional[List[str]] = None


class UpdateUserRequest(BaseModel):
    name: Optional[str] = None
    role: Optional[Role] = None
    franchisee_id: Optional[str] = None
    active: Optional[bool] = None
    # Tri-state field: passing ``null`` clears any restriction (full
    # access); passing a list pins the user to those pages. Omit the key
    # entirely to leave the existing value untouched.
    nav_permissions: Optional[List[str]] = None


# ----------------------------------------------------------------------------
# Password / JWT helpers
# ----------------------------------------------------------------------------
def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(plain: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("utf-8"))
    except Exception:
        return False


def create_access_token(user_id: str, email: str, role: str) -> str:
    payload = {
        "sub": user_id,
        "email": email,
        "role": role,
        "type": "access",
        "exp": datetime.now(timezone.utc) + timedelta(minutes=ACCESS_TOKEN_MINUTES),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def create_refresh_token(user_id: str) -> str:
    payload = {
        "sub": user_id,
        "type": "refresh",
        "exp": datetime.now(timezone.utc) + timedelta(days=REFRESH_TOKEN_DAYS),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def set_auth_cookies(response: Response, access: str, refresh: str) -> None:
    response.set_cookie(
        "access_token", access, httponly=True, secure=True, samesite="none",
        max_age=ACCESS_TOKEN_MINUTES * 60, path="/",
    )
    response.set_cookie(
        "refresh_token", refresh, httponly=True, secure=True, samesite="none",
        max_age=REFRESH_TOKEN_DAYS * 24 * 3600, path="/",
    )


def clear_auth_cookies(response: Response) -> None:
    response.delete_cookie("access_token", path="/")
    response.delete_cookie("refresh_token", path="/")


def user_to_public(doc: dict) -> dict:
    out = {
        "id": doc["id"],
        "email": doc["email"],
        "name": doc.get("name") or doc.get("full_name") or "",
        "role": doc.get("role", "admin"),
        "created_at": doc["created_at"],
    }
    if doc.get("role") == "franchisee" and doc.get("franchisee_id"):
        out["franchisee_id"] = doc["franchisee_id"]
    if doc.get("force_password_change"):
        out["force_password_change"] = True
    # nav_permissions is only meaningful for admin role. ``None`` (the
    # default) means full access; an explicit list pins the user to a
    # subset of the sidebar. We always include the key when set so the
    # frontend can choose what to render.
    if doc.get("role") == "admin" and "nav_permissions" in doc:
        out["nav_permissions"] = doc.get("nav_permissions")
    return out


async def get_current_user(request: Request) -> dict:
    token = request.cookies.get("access_token")
    if not token:
        auth_header = request.headers.get("Authorization", "")
        if auth_header.startswith("Bearer "):
            token = auth_header[7:]
    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        if payload.get("type") != "access":
            raise HTTPException(status_code=401, detail="Invalid token type")
        user = await db.users.find_one({"id": payload["sub"]}, {"_id": 0})
        if not user:
            raise HTTPException(status_code=401, detail="User not found")
        user.pop("password_hash", None)
        return user
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token")


def require_role(*allowed: str):
    async def _checker(user: dict = Depends(get_current_user)) -> dict:
        if user.get("role") not in allowed:
            raise HTTPException(status_code=403, detail="Insufficient permissions")
        return user
    return _checker


# ----------------------------------------------------------------------------
# Brute-force protection
# ----------------------------------------------------------------------------
MAX_FAILED_ATTEMPTS = 5
LOCKOUT_MINUTES = 15


async def check_lockout(identifier: str) -> None:
    rec = await db.login_attempts.find_one({"identifier": identifier})
    if not rec:
        return
    if rec.get("count", 0) >= MAX_FAILED_ATTEMPTS:
        locked_until = rec.get("locked_until")
        if locked_until and datetime.now(timezone.utc) < datetime.fromisoformat(locked_until):
            raise HTTPException(status_code=429, detail="Too many failed attempts. Try again later.")


async def record_failure(identifier: str) -> None:
    rec = await db.login_attempts.find_one({"identifier": identifier}) or {"identifier": identifier, "count": 0}
    rec["count"] = rec.get("count", 0) + 1
    if rec["count"] >= MAX_FAILED_ATTEMPTS:
        rec["locked_until"] = (datetime.now(timezone.utc) + timedelta(minutes=LOCKOUT_MINUTES)).isoformat()
    await db.login_attempts.update_one({"identifier": identifier}, {"$set": rec}, upsert=True)


async def clear_failures(identifier: str) -> None:
    await db.login_attempts.delete_one({"identifier": identifier})


# ----------------------------------------------------------------------------
# Auth Endpoints
# ----------------------------------------------------------------------------
@api.post("/auth/login")
async def login(body: LoginRequest, request: Request, response: Response):
    email = body.email.lower().strip()
    ip = request.client.host if request.client else "unknown"
    identifier = f"{ip}:{email}"
    await check_lockout(identifier)

    user = await db.users.find_one({"email": email}, {"_id": 0})
    if not user or not verify_password(body.password, user.get("password_hash", "")):
        await record_failure(identifier)
        raise HTTPException(status_code=401, detail="Invalid email or password")

    await clear_failures(identifier)
    access = create_access_token(user["id"], user["email"], user["role"])
    refresh = create_refresh_token(user["id"])
    set_auth_cookies(response, access, refresh)
    # Also return tokens in the body so the frontend can fall back to
    # ``Authorization: Bearer`` when the browser blocks cross-site
    # cookies (e.g. when the deployed frontend lives on
    # ``hub.creativemojo.co.uk`` and the backend on ``*.emergent.host`` —
    # which Chrome treats as a third-party context, especially in
    # incognito mode).
    public = user_to_public(user)
    public["access_token"] = access
    public["refresh_token"] = refresh
    return public


@api.post("/auth/logout")
async def logout(response: Response, _: dict = Depends(get_current_user)):
    clear_auth_cookies(response)
    return {"ok": True}


@api.post("/auth/refresh")
async def refresh_token(request: Request, body: dict | None = None, response: Response = None):
    """Issue a fresh access_token from the refresh_token cookie OR from a
    body-supplied ``refresh_token``. Body support lets the frontend keep
    sessions alive even when the browser blocks the cookie (cross-site
    incognito etc.)."""
    rtoken = request.cookies.get("refresh_token")
    if not rtoken and body and isinstance(body, dict):
        rtoken = body.get("refresh_token")
    if not rtoken:
        raise HTTPException(401, "No refresh token")
    try:
        payload = jwt.decode(rtoken, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        if payload.get("type") != "refresh":
            raise HTTPException(401, "Invalid token type")
        user = await db.users.find_one({"id": payload["sub"]}, {"_id": 0})
        if not user:
            raise HTTPException(401, "User not found")
    except jwt.ExpiredSignatureError:
        # Refresh expired too — nothing we can do, force re-login.
        clear_auth_cookies(response)
        raise HTTPException(401, "Refresh token expired") from None
    except jwt.InvalidTokenError:
        clear_auth_cookies(response)
        raise HTTPException(401, "Invalid refresh token") from None
    new_access = create_access_token(user["id"], user["email"], user["role"])
    # Roll the refresh token too so a long-lived session keeps extending
    # rather than dying at the 7-day mark.
    new_refresh = create_refresh_token(user["id"])
    set_auth_cookies(response, new_access, new_refresh)
    public = user_to_public(user)
    public["access_token"] = new_access
    public["refresh_token"] = new_refresh
    return public


@api.get("/auth/me")
async def me(user: dict = Depends(get_current_user)):
    return user_to_public(user)


@api.post("/auth/users")
async def create_user(body: CreateUserRequest, _: dict = Depends(require_role("admin"))):
    email = body.email.lower().strip()
    existing = await db.users.find_one({"email": email})
    if existing:
        raise HTTPException(status_code=409, detail="User with this email already exists")
    if len(body.password) < 8:
        raise HTTPException(status_code=400, detail="Password must be at least 8 characters")
    user = {
        "id": str(uuid.uuid4()),
        "email": email,
        "name": body.name,
        "role": body.role,
        "password_hash": hash_password(body.password),
        "created_at": datetime.now(timezone.utc).isoformat(),
        "active": True,
    }
    if body.role == "franchisee" and body.franchisee_id:
        user["franchisee_id"] = body.franchisee_id
    if body.role == "admin" and body.nav_permissions is not None:
        # Validate + de-dupe + sort; store as a list (or empty list).
        user["nav_permissions"] = normalise_nav_permissions(body.nav_permissions)
    await db.users.insert_one(user)
    return {
        "id": user["id"], "email": user["email"], "name": user["name"],
        "role": user["role"], "franchisee_id": user.get("franchisee_id"),
        "created_at": user["created_at"], "active": True,
        "nav_permissions": user.get("nav_permissions"),
    }


@api.get("/auth/users")
async def list_users(_: dict = Depends(require_role("admin"))):
    """Admin-only roster of every login account on the system. Surfaced
    on the Admin Users page; we strip the bcrypt hash before returning."""
    rows = await db.users.find({}, {"_id": 0, "password_hash": 0}).sort("created_at", -1).to_list(1000)
    # Hydrate franchisee names for the linked-franchisee column.
    fids = {r["franchisee_id"] for r in rows if r.get("franchisee_id")}
    fmap: dict = {}
    if fids:
        fr = await db.franchisees.find(
            {"id": {"$in": list(fids)}},
            {"_id": 0, "id": 1, "organisation": 1, "name": 1, "franchise_number": 1},
        ).to_list(500)
        fmap = {f["id"]: f for f in fr}
    for r in rows:
        if r.get("franchisee_id") and r["franchisee_id"] in fmap:
            f = fmap[r["franchisee_id"]]
            r["franchisee_label"] = (
                f"{f.get('franchise_number') or '—'} · "
                f"{f.get('organisation') or f.get('name') or '(unnamed)'}"
            )
    return {"users": rows}


@api.patch("/auth/users/{user_id}")
async def update_user(
    user_id: str, body: UpdateUserRequest,
    admin: dict = Depends(require_role("admin")),
):
    user = await db.users.find_one({"id": user_id})
    if not user:
        raise HTTPException(404, "User not found")
    update: dict = {}
    if body.name is not None:
        update["name"] = body.name
    if body.role is not None:
        update["role"] = body.role
    if body.franchisee_id is not None:
        # Empty string clears the linkage.
        update["franchisee_id"] = body.franchisee_id or None
    if body.active is not None:
        # Self-disable lockout guard — admins can't accidentally lock
        # themselves out of the console.
        if not body.active and user_id == admin["id"]:
            raise HTTPException(400, "You can't deactivate your own account")
        update["active"] = body.active
    # nav_permissions is tri-state: omitted → no change, null → clear
    # restriction (full access), list → pin to those keys. Use
    # ``model_fields_set`` so we can tell "null" apart from "absent".
    if "nav_permissions" in body.model_fields_set:
        target_role = update.get("role") or user.get("role")
        if target_role != "admin" and body.nav_permissions is not None:
            raise HTTPException(400, "nav_permissions only applies to admin role")
        update["nav_permissions"] = normalise_nav_permissions(body.nav_permissions) if body.nav_permissions is not None else None
        # Self-lockout guard — an admin must keep at least one allowed
        # page on their own account so they can still reach the Admin
        # Users page to unlock themselves.
        if user_id == admin["id"] and isinstance(update["nav_permissions"], list):
            if "admin-users" not in update["nav_permissions"]:
                raise HTTPException(400, "You can't remove your own access to the Admin Users page")
    if not update:
        raise HTTPException(400, "No changes provided")
    await db.users.update_one({"id": user_id}, {"$set": update})
    return {"ok": True}


@api.delete("/auth/users/{user_id}")
async def delete_user(
    user_id: str, admin: dict = Depends(require_role("admin"))
):
    if user_id == admin["id"]:
        raise HTTPException(400, "You can't delete your own account")
    user = await db.users.find_one({"id": user_id})
    if not user:
        raise HTTPException(404, "User not found")
    await db.users.delete_one({"id": user_id})
    return {"ok": True}


# ----------------------------------------------------------------------------
# Password Reset — admin-mediated (no email integration)
# ----------------------------------------------------------------------------
# Flow:
#  1. End user clicks "Forgot password?" → POSTs email to /auth/password-reset/request
#  2. We always return 200 with a generic message (prevents email enumeration)
#  3. If a real account exists for that email we file a `password_reset_requests`
#     row. Otherwise we silently no-op so timing doesn't leak account presence.
#  4. Admin sees pending requests in /admin/password-resets, clicks Fulfil, and
#     we generate a random temp password, swap the user's bcrypt hash, mark the
#     user `force_password_change=True`, then return the plaintext temp pwd
#     ONCE so the admin can share it out-of-band (phone/SMS/Signal).
#  5. The user logs in with the temp pwd — login response carries
#     `force_password_change=True`. The frontend redirects to /change-password
#     which forces them to set a new one before they can use the app.

class PasswordResetRequestBody(BaseModel):
    email: str


class ChangePasswordBody(BaseModel):
    current_password: str
    new_password: str


def _generate_temp_password() -> str:
    """Memorable-but-strong temp password: 3-4-3 hyphen-separated lowercase
    word-like chunks made from a safe alphabet. ~10^14 entropy. Format
    chosen so it can be read out over the phone without confusion."""
    import secrets
    # Excludes look-alikes (0/o, 1/l/i).
    alpha = "abcdefghjkmnpqrstuvwxyz23456789"
    chunks = [
        "".join(secrets.choice(alpha) for _ in range(3)),
        "".join(secrets.choice(alpha) for _ in range(4)),
        "".join(secrets.choice(alpha) for _ in range(3)),
    ]
    return "-".join(chunks)


@api.post("/auth/password-reset/request")
async def password_reset_request(
    body: PasswordResetRequestBody, request: Request
):
    email = (body.email or "").lower().strip()
    if not email:
        raise HTTPException(400, "Email required")
    ip = request.client.host if request.client else "unknown"
    # Cheap rate-limit reuse of login_attempts collection: 8 reset asks per
    # IP per 60 minutes. Prevents the "spam admin's queue" attack.
    rl_id = f"reset:{ip}"
    now = datetime.now(timezone.utc)
    rl = await db.login_attempts.find_one({"identifier": rl_id})
    if rl:
        first = rl.get("first_attempt_at")
        if isinstance(first, str):
            first = datetime.fromisoformat(first)
        if first and (now - first).total_seconds() < 3600 and rl.get("count", 0) >= 8:
            raise HTTPException(
                429, "Too many reset requests from this network. Try again later."
            )
    user = await db.users.find_one({"email": email}, {"_id": 0})
    if user:
        # Always file a new request even if one is pending — admin can pick
        # whichever to action. The collection's natural growth is bounded
        # by rate-limit + admin housekeeping.
        await db.password_reset_requests.insert_one({
            "id": str(uuid.uuid4()),
            "email": email,
            "user_id": user["id"],
            "user_name": user.get("name", ""),
            "role": user.get("role", ""),
            "requested_at": now.isoformat(),
            "ip": ip,
            "user_agent": request.headers.get("User-Agent", "")[:300],
            "status": "pending",
        })
        # Self-serve: when Resend is configured, send the user a branded
        # email with a one-time reset link straight away. The admin queue
        # entry above stays as an audit trail. If Resend isn't
        # configured, we silently fall back to the legacy admin-fulfilled
        # flow — no behaviour change.
        try:
            from resend_routes import (
                RESEND_API_KEY, RESEND_FROM_EMAIL, RESEND_FROM_NAME,
            )
            if RESEND_API_KEY:
                import resend as _resend
                _resend.api_key = RESEND_API_KEY
                token = secrets.token_urlsafe(32)
                exp = (now + timedelta(hours=2)).isoformat()
                await db.password_reset_tokens.insert_one({
                    "token": token,
                    "user_id": user["id"],
                    "email": email,
                    "created_at": now.isoformat(),
                    "expires_at": exp,
                    "used_at": None,
                    "ip": ip,
                })
                reset_url = f"{PORTAL_URL}/reset-password?token={token}"
                html = _build_reset_email_html(
                    user.get("name") or email.split("@")[0],
                    reset_url,
                )
                try:
                    _resend.Emails.send({
                        "from": f"{RESEND_FROM_NAME} <{RESEND_FROM_EMAIL}>",
                        "to": [email],
                        "subject": "Reset your Creative Mojo Franchise Hub password",
                        "html": html,
                        "tags": [{"name": "kind", "value": "password-reset"}],
                    })
                except Exception:  # noqa: BLE001
                    # Don't leak Resend failures back to the requester —
                    # they'll re-try, admin still sees the queued ticket.
                    logger.exception("Resend password-reset email failed for %s", email)
        except Exception:  # noqa: BLE001
            logger.exception("Self-serve reset short-circuit failed for %s", email)
    # Bump rate-limit even on miss so we don't leak account existence via
    # timing or response shape.
    await db.login_attempts.update_one(
        {"identifier": rl_id},
        {
            "$inc": {"count": 1},
            "$setOnInsert": {
                "identifier": rl_id,
                "first_attempt_at": now.isoformat(),
            },
            "$set": {"last_attempt_at": now.isoformat()},
        },
        upsert=True,
    )
    return {
        "ok": True,
        "message": (
            "If an account exists for that email, an administrator has been "
            "notified and will be in touch with a temporary password."
        ),
    }


@api.get("/auth/password-reset/requests")
async def password_reset_requests_list(
    _: dict = Depends(require_role("admin")),
    status: Optional[str] = "pending",
):
    q: dict = {}
    if status and status != "all":
        q["status"] = status
    rows = (
        await db.password_reset_requests.find(q, {"_id": 0})
        .sort("requested_at", -1)
        .to_list(500)
    )
    pending = await db.password_reset_requests.count_documents({"status": "pending"})
    return {"requests": rows, "pending_count": pending}


# ----------------------------------------------------------------------------
# Self-serve password reset (token-based, fully email-driven via Resend).
# Companion to the existing /auth/password-reset/request endpoint, which
# now also mints a token + sends the email when Resend is configured.
# ----------------------------------------------------------------------------
def _build_reset_email_html(name: str, reset_url: str) -> str:
    safe_name = (name.split(" ")[0] if name else "there")
    return f"""<!doctype html>
<html><body style="margin:0;padding:0;background:#f5f5f4;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;">
  <div style="max-width:560px;margin:32px auto;padding:0;background:#ffffff;border:1px solid #e7e5e4;border-radius:16px;overflow:hidden;">
    <div style="background:#0c0a09;color:#dddd16;padding:20px 28px;font-size:13px;letter-spacing:0.2em;text-transform:uppercase;font-weight:700;">
      Creative Mojo · Password reset
    </div>
    <div style="padding:28px;color:#1c1917;line-height:1.55;font-size:15px;">
      <p style="margin:0 0 14px 0;">Hi {safe_name},</p>
      <p style="margin:0 0 14px 0;">You (or someone using your email) asked to reset the password on your Creative Mojo Franchise Hub account.</p>
      <p style="margin:0 0 22px 0;">Click the button below to choose a new password. The link expires in 2 hours.</p>
      <div style="text-align:center;margin:22px 0;">
        <a href="{reset_url}" style="display:inline-block;padding:14px 26px;background:#0c0a09;color:#dddd16;text-decoration:none;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;font-size:13px;border-radius:999px;">Reset my password</a>
      </div>
      <p style="margin:0 0 14px 0;font-size:13px;color:#78716c;">If the button doesn't work, paste this link into your browser:<br><span style="font-family:ui-monospace,Menlo,monospace;font-size:12px;word-break:break-all;color:#1c1917;">{reset_url}</span></p>
      <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:14px 18px;margin:18px 0;color:#78350f;font-size:14px;">
        Didn't request this? Ignore this email — your existing password remains active.
      </div>
      <p style="margin:18px 0 0 0;">— Creative Mojo</p>
    </div>
  </div>
</body></html>"""


class PasswordResetConfirmBody(BaseModel):
    token: str
    new_password: str


@api.post("/auth/password-reset/confirm")
async def password_reset_confirm(body: PasswordResetConfirmBody):
    """Consume a one-time token from the Resend reset email and set the
    new password. Token is single-use, valid for 2 hours."""
    if len(body.new_password or "") < 8:
        raise HTTPException(400, "New password must be at least 8 characters")
    tok = await db.password_reset_tokens.find_one({"token": body.token})
    if not tok or tok.get("used_at"):
        raise HTTPException(400, "This reset link is invalid or already used.")
    try:
        exp = datetime.fromisoformat(tok["expires_at"])
    except Exception:  # noqa: BLE001
        raise HTTPException(400, "This reset link is malformed.")  # noqa: B904
    if exp < datetime.now(timezone.utc):
        raise HTTPException(400, "This reset link has expired. Request a new one.")
    user = await db.users.find_one({"id": tok["user_id"]})
    if not user:
        raise HTTPException(400, "User no longer exists.")
    now_iso = datetime.now(timezone.utc).isoformat()
    await db.users.update_one(
        {"id": user["id"]},
        {"$set": {
            "password_hash": hash_password(body.new_password),
            "password_changed_at": now_iso,
            "active": True,
        },
         "$unset": {"force_password_change": "", "must_change_password": "",
                    "handover_pending": ""}},
    )
    await db.password_reset_tokens.update_one(
        {"token": body.token},
        {"$set": {"used_at": now_iso}},
    )
    # Mark any pending admin queue rows for this email as auto-fulfilled
    await db.password_reset_requests.update_many(
        {"email": user["email"], "status": "pending"},
        {"$set": {"status": "auto_fulfilled", "fulfilled_at": now_iso}},
    )
    return {"ok": True, "email": user["email"]}


@api.post("/auth/password-reset/requests/{request_id}/fulfill")
async def password_reset_fulfill(
    request_id: str, admin: dict = Depends(require_role("admin"))
):
    req = await db.password_reset_requests.find_one(
        {"id": request_id}, {"_id": 0}
    )
    if not req:
        raise HTTPException(404, "Reset request not found")
    if req.get("status") != "pending":
        raise HTTPException(400, f"Already {req.get('status')}")
    user = await db.users.find_one({"id": req["user_id"]}, {"_id": 0})
    if not user:
        # The account vanished after the request was filed — nothing to do.
        await db.password_reset_requests.update_one(
            {"id": request_id},
            {"$set": {"status": "rejected",
                      "fulfilled_at": datetime.now(timezone.utc).isoformat(),
                      "fulfilled_by": admin["id"],
                      "note": "User no longer exists"}},
        )
        raise HTTPException(410, "User no longer exists")
    temp_pwd = _generate_temp_password()
    now = datetime.now(timezone.utc).isoformat()
    await db.users.update_one(
        {"id": user["id"]},
        {
            "$set": {
                "password_hash": hash_password(temp_pwd),
                "force_password_change": True,
                "password_changed_at": now,
            }
        },
    )
    # Clear any active lockouts for this user so they can sign straight in.
    await db.login_attempts.delete_many(
        {"identifier": {"$regex": f":{user['email']}$"}}
    )
    await db.password_reset_requests.update_one(
        {"id": request_id},
        {"$set": {"status": "fulfilled", "fulfilled_at": now,
                  "fulfilled_by": admin["id"],
                  "fulfilled_by_name": admin.get("name", "")}},
    )
    # Return the temp password ONCE. The frontend reveals it in a one-time
    # modal — refreshing the requests list won't bring it back.
    return {
        "ok": True,
        "temp_password": temp_pwd,
        "email": user["email"],
        "user_name": user.get("name", ""),
    }


@api.post("/auth/password-reset/requests/{request_id}/reject")
async def password_reset_reject(
    request_id: str, admin: dict = Depends(require_role("admin"))
):
    req = await db.password_reset_requests.find_one(
        {"id": request_id}, {"_id": 0}
    )
    if not req:
        raise HTTPException(404, "Reset request not found")
    if req.get("status") != "pending":
        raise HTTPException(400, f"Already {req.get('status')}")
    await db.password_reset_requests.update_one(
        {"id": request_id},
        {"$set": {"status": "rejected",
                  "fulfilled_at": datetime.now(timezone.utc).isoformat(),
                  "fulfilled_by": admin["id"]}},
    )
    return {"ok": True}


@api.post("/auth/change-password")
async def change_password(
    body: ChangePasswordBody,
    user: dict = Depends(get_current_user),
):
    """Authenticated user changes their own password. Used both for the
    forced post-reset change AND voluntary password changes from a profile
    page later on."""
    full = await db.users.find_one({"id": user["id"]})
    if not full or not verify_password(
        body.current_password, full.get("password_hash", "")
    ):
        raise HTTPException(401, "Current password is incorrect")
    if len(body.new_password or "") < 8:
        raise HTTPException(400, "New password must be at least 8 characters")
    if body.new_password == body.current_password:
        raise HTTPException(400, "New password must differ from current")
    await db.users.update_one(
        {"id": user["id"]},
        {
            "$set": {
                "password_hash": hash_password(body.new_password),
                "password_changed_at": datetime.now(timezone.utc).isoformat(),
            },
            "$unset": {"force_password_change": "", "must_change_password": "",
                       "handover_pending": ""},
        },
    )
    return {"ok": True}


# ----------------------------------------------------------------------------
# Handover access — admin presses "Handover" on a franchisee user row →
# we generate a NEW temporary password, send a branded Resend email with
# the portal URL + temp password + first-login instructions, and clear
# the ``handover_pending`` flag on the user. Idempotent in the sense that
# re-pressing the button generates a fresh password each time (use case:
# franchisee lost the email).
# ----------------------------------------------------------------------------


def _build_handover_email_html(name: str, email: str, temp_password: str, portal_url: str) -> str:
    safe_name = (name.split(" ")[0] if name else "there")
    return f"""<!doctype html>
<html><body style="margin:0;padding:0;background:#f5f5f4;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;">
  <div style="max-width:560px;margin:32px auto;padding:0;background:#ffffff;border:1px solid #e7e5e4;border-radius:16px;overflow:hidden;">
    <div style="background:#0c0a09;color:#dddd16;padding:20px 28px;font-size:13px;letter-spacing:0.2em;text-transform:uppercase;font-weight:700;">
      Creative Mojo · Franchise Hub
    </div>
    <div style="padding:28px;color:#1c1917;line-height:1.55;font-size:15px;">
      <p style="margin:0 0 14px 0;">Hi {safe_name},</p>
      <p style="margin:0 0 14px 0;">Your Creative Mojo Franchise Hub access is now live. Below are your login details.</p>
      <table style="width:100%;border-collapse:collapse;margin:18px 0;background:#fafaf9;border:1px solid #e7e5e4;border-radius:10px;">
        <tr>
          <td style="padding:14px 18px;font-size:11px;text-transform:uppercase;letter-spacing:0.15em;color:#78716c;font-weight:700;width:120px;">Portal</td>
          <td style="padding:14px 18px;"><a href="{portal_url}/login" style="color:#1c1917;font-weight:600;text-decoration:underline;">{portal_url}/login</a></td>
        </tr>
        <tr>
          <td style="padding:14px 18px;font-size:11px;text-transform:uppercase;letter-spacing:0.15em;color:#78716c;font-weight:700;border-top:1px solid #e7e5e4;">Email</td>
          <td style="padding:14px 18px;border-top:1px solid #e7e5e4;font-family:ui-monospace,Menlo,monospace;font-size:14px;">{email}</td>
        </tr>
        <tr>
          <td style="padding:14px 18px;font-size:11px;text-transform:uppercase;letter-spacing:0.15em;color:#78716c;font-weight:700;border-top:1px solid #e7e5e4;">Temporary password</td>
          <td style="padding:14px 18px;border-top:1px solid #e7e5e4;font-family:ui-monospace,Menlo,monospace;font-size:14px;font-weight:600;">{temp_password}</td>
        </tr>
      </table>
      <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:14px 18px;margin:18px 0;color:#78350f;font-size:14px;">
        <strong>First time logging in?</strong><br>
        On first login, click your name in the top-right corner → <strong>Change password</strong> to set your own.
      </div>
      <p style="margin:18px 0 0 0;">Welcome aboard,<br><strong>The Creative Mojo team</strong></p>
    </div>
    <div style="padding:16px 28px;border-top:1px solid #e7e5e4;background:#fafaf9;font-size:11px;color:#78716c;">
      This message contains temporary credentials. Please don't share or forward it.
    </div>
  </div>
</body></html>"""


@api.post("/auth/users/{user_id}/handover")
async def handover_portal_access(
    user_id: str,
    admin: dict = Depends(require_role("admin")),
):
    """Send the franchisee a branded email with portal URL, their email
    and a freshly-generated temporary password. Used by the "Handover
    franchise access" button on the Admin Users page.

    Always resets the password — re-pressing the button is the supported
    way to re-issue credentials when the franchisee loses the email.
    """
    target = await db.users.find_one({"id": user_id})
    if not target:
        raise HTTPException(404, "User not found")
    if target.get("role") not in ("franchisee", "licensee"):
        raise HTTPException(400, "Handover is only supported for franchisee/licensee users")

    try:
        from resend_routes import (
            RESEND_API_KEY, RESEND_FROM_EMAIL, RESEND_FROM_NAME,
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(503, "Resend module not available") from exc
    if not RESEND_API_KEY:
        raise HTTPException(503, "Resend not configured — set RESEND_API_KEY")

    # Fresh strong temporary password.
    import string
    alphabet = string.ascii_letters + string.digits
    temp_password = "".join(secrets.choice(alphabet) for _ in range(14))
    now_iso = datetime.now(timezone.utc).isoformat()
    await db.users.update_one(
        {"id": user_id},
        {"$set": {
            "password_hash": hash_password(temp_password),
            "must_change_password": True,
            "active": True,
            "handover_sent_at": now_iso,
            "handover_sent_by": admin.get("email"),
        },
         "$unset": {"handover_pending": ""}},
    )

    name = target.get("name") or (target.get("email") or "").split("@")[0]
    html = _build_handover_email_html(name, target["email"], temp_password, PORTAL_URL)
    import resend as _resend
    _resend.api_key = RESEND_API_KEY
    try:
        result = _resend.Emails.send({
            "from": f"{RESEND_FROM_NAME} <{RESEND_FROM_EMAIL}>",
            "to": [target["email"]],
            "subject": "Welcome to the Creative Mojo Franchise Hub",
            "html": html,
            "tags": [{"name": "kind", "value": "portal-handover"}],
        })
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, detail=f"Resend send failed: {exc}") from exc

    return {
        "ok": True,
        "email_sent_to": target["email"],
        "user_id": user_id,
        "resend_id": (result or {}).get("id") if isinstance(result, dict) else None,
        "sent_at": now_iso,
    }


# ----------------------------------------------------------------------------
# Airtable / Migration endpoints — REMOVED 2026-05-19 after the live cutover.
# The console is now the source of truth; Airtable has been decommissioned.
# (Sidebar items + dashboard 'Re-run migration' button were also removed.)
# ----------------------------------------------------------------------------




# ----------------------------------------------------------------------------
# Form Intake (Gravity Forms via WordPress plugin)
# ----------------------------------------------------------------------------
# Form intake config lives in form_intake_config.py so the gf_backfill module
# can share the same source of truth without a circular import.
from form_intake_config import (  # noqa: E402
    FORM_ID_TO_SOURCE,
    FORM_IDS_IN_PIPELINE,
    FORM1_REASON_TO_SOURCE,
    PIPELINE_SOURCES,
)


def _pick(fields_by_label: dict, *candidates: str) -> Optional[str]:
    """Find a field value by trying multiple label variants (case-insensitive, partial match)."""
    if not fields_by_label:
        return None
    lower_map = {k.lower(): v for k, v in fields_by_label.items() if v not in (None, "")}
    for c in candidates:
        c_lower = c.lower()
        if c_lower in lower_map:
            return lower_map[c_lower]
        # Partial match
        for k, v in lower_map.items():
            if c_lower in k or k in c_lower:
                return v
    return None


# Known "Where did you hear about Creative Mojo?" answer values. Gravity Forms can either
# send the answer in a single labelled field, OR (for radio/checkbox groups) it can spread
# each option into its own top-level key whose value equals the selected label.
REFERRAL_CANONICAL = {
    "instagram": "Instagram",
    "facebook":  "Facebook",
    "twitter":   "X",
    "x":         "X",
    "tiktok":    "TikTok",
    "google":    "Google",
    "friend":    "Friend",
    "word of mouth": "Word of Mouth",
    "other":     "Other",
}


def _detect_referral_source(fields_by_label: dict) -> Optional[str]:
    """Try a single labelled field first, then fall back to scanning the spread keys."""
    if not fields_by_label:
        return None
    # 1) Single labelled question (preferred)
    labelled = _pick(
        fields_by_label,
        "Where did you hear about Creative Mojo",
        "Where did you hear about us",
        "How did you hear about us",
        "Referral Source",
        "How did you find us",
    )
    if labelled and isinstance(labelled, str):
        key = labelled.strip().lower()
        return REFERRAL_CANONICAL.get(key, labelled.strip())
    # 2) Spread-key form (Gravity Forms radio: key == value == selected option label)
    for k, v in fields_by_label.items():
        if not k or v in (None, "", False):
            continue
        # Skip duplicate "<label> Name" companion keys GF emits
        if k.endswith(" Name"):
            continue
        canonical = REFERRAL_CANONICAL.get(k.strip().lower())
        if canonical and isinstance(v, str) and v.strip().lower() == k.strip().lower():
            return canonical
    return None


class GravityFormsIntake(BaseModel):
    form_id: int
    form_title: Optional[str] = None
    entry_id: Optional[str] = None
    date: Optional[str] = None
    fields: dict  # label → value
    raw: Optional[dict] = None


@api.post("/intake/gravity-forms")
async def gravity_forms_intake(payload: GravityFormsIntake, request: Request):
    # Authenticate via X-Intake-Token header
    token = request.headers.get("X-Intake-Token") or request.headers.get("x-intake-token")
    if not INTAKE_TOKEN or token != INTAKE_TOKEN:
        raise HTTPException(status_code=401, detail="Invalid or missing intake token")

    source = FORM_ID_TO_SOURCE.get(payload.form_id, f"form_{payload.form_id}")
    f = payload.fields or {}

    # Tombstone guard — admin deleted this entry; don't recreate it.
    if payload.entry_id:
        tomb = await db.gf_deleted_entries.find_one(
            {"gravity_entry_id": str(payload.entry_id)}, {"_id": 0, "gravity_entry_id": 1}
        )
        if tomb:
            logger.info("Intake: skipping tombstoned entry %s (form %s)",
                        payload.entry_id, payload.form_id)
            return {"ok": True, "skipped": "tombstoned", "entry_id": payload.entry_id}

    # Form 1 (general contact) — refine source based on "Reason for contacting"
    # so care-home/art-kit/other land in their dedicated tabs rather than the
    # generic bucket.
    why = _pick(f, "Reason for Contacting", "Why you are contacting us", "Subject", "Reason")
    if payload.form_id == 1 and why:
        source = FORM1_REASON_TO_SOURCE.get(why.strip().lower(), "general_enquiry")

    in_pipeline = source in PIPELINE_SOURCES

    doc = {
        "id": str(uuid.uuid4()),
        "airtable_id": None,
        "source": source,
        "form_id": payload.form_id,
        "form_title": payload.form_title,
        "gravity_entry_id": payload.entry_id,
        "date": payload.date or datetime.now(timezone.utc).isoformat(),
        "first_name": _pick(f, "First Name", "first_name", "fname", "First", "FirstName", "Name", "Full Name", "Your Name"),
        "last_name": _pick(f, "Last Name", "last_name", "lname", "Last", "Surname"),
        "email": _pick(f, "Email", "Email Address", "email", "email_address"),
        "telephone": _pick(f, "Telephone", "Phone", "Telephone Number", "Mobile", "Phone Number"),
        "mobile_phone": _pick(f, "Mobile", "Mobile Phone", "Mobile Number"),
        "establishment_name": _pick(f, "Name of establishment", "Establishment", "Company", "Organisation"),
        "address_street": _pick(f, "1st Line of Address", "Address", "Street"),
        "city": _pick(f, "City/Town", "City", "Town"),
        "county": _pick(f, "County", "Region"),
        "postcode": _pick(f, "Postcode", "Postal Code", "Zip"),
        "why_contacting": why,
        "message": _pick(f, "Your Message", "Message", "Comments", "Notes"),
        "country_tag": _pick(f, "Country"),
        "referral_source": _detect_referral_source(f),
        "reason_for_contacting": why if payload.form_id == 1 else None,
        "raw_fields": f,
        "in_pipeline": in_pipeline,
        "pipeline_status": "new" if in_pipeline else None,
        "received_at": datetime.now(timezone.utc).isoformat(),
        "created_at": datetime.now(timezone.utc).isoformat(),
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    # Some forms (e.g. Form 33 popup) send a single "Name" field with the
    # full name. If we ended up with everything in first_name and nothing
    # in last_name, split on the first whitespace so the kanban shows a
    # tidy "First Last" card instead of a giant first_name string.
    if doc["first_name"] and not doc["last_name"] and " " in doc["first_name"].strip():
        first_raw = doc["first_name"].strip()
        parts = first_raw.split(None, 1)
        doc["first_name"] = parts[0]
        doc["last_name"] = parts[1] if len(parts) > 1 else None
    await db.web_form_contacts.insert_one(doc)
    logger.info(f"Intake: form_id={payload.form_id} source={source} entry={payload.entry_id} from {request.client.host if request.client else '?'}")
    return {"ok": True, "id": doc["id"], "source": source}


@api.get("/intake/config")
async def intake_config(_: dict = Depends(require_role("admin"))):
    """Returns the intake endpoint URL + token for the WordPress plugin setup."""
    backend_url = FRONTEND_URL  # same host
    return {
        "endpoint_url": f"{backend_url}/api/intake/gravity-forms",
        "intake_token": INTAKE_TOKEN,
        "form_mapping": [
            {"form_id": 1, "name": "Contact Form (General)", "source_tag": "general_enquiry"},
            {"form_id": 17, "name": "Franchise Enquiry Contact Form", "source_tag": "franchise_enquiry"},
            {"form_id": 32, "name": "Licence Enquiry Contact Form", "source_tag": "licence_enquiry"},
            {"form_id": 33, "name": "Franchise Enquiry Short Form (popup)", "source_tag": "franchise_enquiry"},
        ],
    }


@api.get("/intake/recent")
async def intake_recent(limit: int = Query(20, le=100), _: dict = Depends(require_role("admin"))):
    """Returns the most recent web-form submissions for the setup/health page."""
    items = await db.web_form_contacts.find(
        {"form_id": {"$exists": True}}, {"_id": 0},
    ).sort("received_at", -1).limit(limit).to_list(limit)
    return {"items": items, "count": len(items)}


@api.get("/intake/download-plugin")
async def download_plugin(_: dict = Depends(require_role("admin"))):
    """Build the WordPress plugin zip on-the-fly and return it."""
    import io
    import zipfile
    from fastapi.responses import StreamingResponse

    plugin_dir = "creative-mojo-intake"
    php_path = "/app/wordpress-plugin/creative-mojo-intake/creative-mojo-intake.php"
    readme_path = "/app/wordpress-plugin/creative-mojo-intake/readme.txt"

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for src, name in [(php_path, f"{plugin_dir}/creative-mojo-intake.php"), (readme_path, f"{plugin_dir}/readme.txt")]:
            try:
                with open(src) as fh:
                    zf.writestr(name, fh.read())
            except FileNotFoundError:
                raise HTTPException(status_code=500, detail=f"Plugin file missing: {src}")
    buf.seek(0)
    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={"Content-Disposition": "attachment; filename=creative-mojo-intake.zip"},
    )


# ----------------------------------------------------------------------------
# Dashboard
# ----------------------------------------------------------------------------
@api.get("/dashboard/stats")
async def dashboard_stats(_: dict = Depends(require_role("admin"))):
    user_count = await db.users.count_documents({})
    franchisees = await db.franchisees.count_documents({})
    active_franchisees = await db.franchisees.count_documents({"tags": "Franchisee"})
    ex_franchisees = await db.franchisees.count_documents({"tags": "EX-Franchisee"})
    contracts = await db.contracts.count_documents({})
    active_contracts = await db.contracts.count_documents({"cancelled_early": {"$ne": True}})
    contacts = await db.contacts.count_documents({})
    web_form_contacts = await db.web_form_contacts.count_documents({})
    territories = await db.territories.count_documents({})
    last_migration = await db.migration_runs.find_one({}, sort=[("run_at", -1)])  # legacy stamp — kept for "Migrated from Airtable · …" UI

    # Mandate breakdown across active franchisees only — reads live
    # `gocardless_mandate_status` (kept in sync via the GoCardless API).
    mandate_pipeline = [
        {"$match": {"tags": "Franchisee"}},
        {"$group": {"_id": "$gocardless_mandate_status", "count": {"$sum": 1}}},
        {"$sort": {"count": -1}},
    ]
    mandate_breakdown_raw = await db.franchisees.aggregate(mandate_pipeline).to_list(20)
    _MANDATE_LABEL = {
        "active": "Live",
        "pending_submission": "Pending submission",
        "pending_customer_approval": "Awaiting approval",
        "submitted": "Submitted",
        "cancelled": "Cancelled",
        "expired": "Expired",
        "failed": "Failed",
    }
    mandate_breakdown = [
        {"value": _MANDATE_LABEL.get(m["_id"], m["_id"]) if m["_id"] else "Not set",
         "count": m["count"]}
        for m in mandate_breakdown_raw
    ]

    # Pipeline funnel (active sales pipeline only — records with in_pipeline=true)
    funnel_pipeline = [
        {"$match": {"in_pipeline": True}},
        {"$group": {
            "_id": {"status": "$pipeline_status", "source": "$source"},
            "count": {"$sum": 1},
        }},
    ]
    funnel_raw = await db.web_form_contacts.aggregate(funnel_pipeline).to_list(50)
    # Aggregate into { status: total, by_source: { franchise: n, licence: n } }
    funnel: Dict[str, Any] = {}
    funnel_by_source: Dict[str, Dict[str, int]] = {"franchise": {}, "licence": {}, "other": {}}
    for f in funnel_raw:
        status = f["_id"].get("status") or "new"
        src = f["_id"].get("source") or ""
        funnel[status] = funnel.get(status, 0) + f["count"]
        bucket = "franchise" if src == "franchise_enquiry" else "licence" if src == "licence_enquiry" else "other"
        funnel_by_source[bucket][status] = funnel_by_source[bucket].get(status, 0) + f["count"]

    # Recent enquiries (last 5 by date — active pipeline only)
    recent_enquiries = await db.web_form_contacts.find(
        {"in_pipeline": True},
        {"_id": 0, "id": 1, "first_name": 1, "last_name": 1, "establishment_name": 1,
         "postcode": 1, "date": 1, "pipeline_status": 1, "potential": 1, "source": 1},
    ).sort("date", -1).limit(5).to_list(5)

    airtable_summary = None  # Airtable decommissioned 2026-05-19
    return {
        "users": user_count,
        "franchisees_migrated": franchisees,
        "active_franchisees": active_franchisees,
        "ex_franchisees": ex_franchisees,
        "contracts_migrated": contracts,
        "active_contracts": active_contracts,
        "contacts_migrated": contacts + web_form_contacts,
        "web_form_contacts": web_form_contacts,
        "territories_migrated": territories,
        "mandate_breakdown": mandate_breakdown,
        "pipeline_funnel": funnel,
        "pipeline_funnel_by_source": funnel_by_source,
        "recent_enquiries": recent_enquiries,
        "airtable": airtable_summary,
        "last_migration": last_migration.get("run_at") if last_migration else None,
    }


# ----------------------------------------------------------------------------
# Migration runner endpoint — REMOVED 2026-05-19 (Airtable decommissioned).
# The console is now the source of truth. The historical Mongo collections
# `migration_runs`, `migration_table_decisions`, `migration_field_decisions`
# are kept untouched for audit, but no code reads them anymore.
# ----------------------------------------------------------------------------


@api.post("/franchisees/{franchisee_id}/photo")
async def upload_franchisee_photo(
    franchisee_id: str,
    file: UploadFile = File(...),
    user: dict = Depends(require_role("admin")),
):
    """Admin-only: upload (or replace) a franchisee's profile photo.

    Stored on disk under `UPLOADS_DIR/franchisees/<id>_<ts>.<ext>` and served
    via `/api/uploads/...`. The franchisee's `photos[0].url` is rewritten so
    the rest of the app (detail page, listings, portal greeting) picks it up
    immediately. Existing photos are preserved as `photos[1..n]` so we can
    revert if needed."""
    from migration import FRANCHISEE_PHOTOS_DIR
    FRANCHISEE_PHOTOS_DIR.mkdir(parents=True, exist_ok=True)
    f = await db.franchisees.find_one({"id": franchisee_id}, {"_id": 0})
    if not f:
        raise HTTPException(404, detail="Franchisee not found")
    ct = (file.content_type or "").lower()
    if not ct.startswith("image/"):
        raise HTTPException(415, detail="Only image uploads are accepted")
    # Pick an extension we trust — never echo the user-supplied filename.
    ext = {"image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png",
           "image/webp": "webp", "image/gif": "gif"}.get(ct, "jpg")
    ts = int(datetime.now(timezone.utc).timestamp())
    fname = f"{franchisee_id}_{ts}.{ext}"
    dest = FRANCHISEE_PHOTOS_DIR / fname
    payload = await file.read()
    if len(payload) > 8 * 1024 * 1024:
        raise HTTPException(413, detail="Photo too large (max 8 MB)")
    dest.write_bytes(payload)
    new_url = f"/api/uploads/franchisees/{fname}"
    new_entry = {"url": new_url, "uploaded": True,
                 "uploaded_by": user.get("email"),
                 "uploaded_at": datetime.now(timezone.utc).isoformat()}
    existing = f.get("photos") or []
    # Keep existing as fallback at the tail so we can audit / revert later.
    photos = [new_entry] + [p for p in existing if p.get("url") != new_url]
    await db.franchisees.update_one({"id": franchisee_id}, {"$set": {
        "photos": photos,
        "photo_url": new_url,
        "updated_at": datetime.now(timezone.utc),
        "updated_by": user.get("email"),
    }})
    return {"photo_url": new_url, "photos": photos}


# ----------------------------------------------------------------------------
# CRM — Franchisees
# ----------------------------------------------------------------------------
@api.get("/franchisees")
async def list_franchisees(
    search: Optional[str] = None,
    sort_by: str = "franchise_number",
    sort_dir: int = 1,
    limit: int = Query(200, le=500),
    _: dict = Depends(require_role("admin")),
):
    q = {}
    if search:
        rx = {"$regex": search, "$options": "i"}
        q = {"$or": [{"organisation": rx}, {"first_name": rx}, {"last_name": rx},
                     {"mojo_email": rx}, {"franchise_number": rx}, {"city": rx}, {"postcode": rx}]}
    items = await db.franchisees.find(q, {"_id": 0}).sort(sort_by, sort_dir).limit(limit).to_list(limit)
    return {"items": items, "total": await db.franchisees.count_documents(q)}


@api.get("/franchisees/alerts/missing-mandate")
async def list_franchisees_missing_mandate(
    days: int = 14,
    _: dict = Depends(require_role("admin")),
):
    """Active franchisees who went live ≥ ``days`` ago but still have no
    GoCardless mandate linked. Surfaces as a red badge on the sidebar so the
    admin notices the gap quickly. "Went live" = earliest contract's
    ``commencement_date`` (fallbacks to ``date_added``/``created_at``).
    """
    cutoff = datetime.now(timezone.utc) - timedelta(days=max(1, int(days)))
    cutoff_iso = cutoff.date().isoformat()

    # Pull active franchisees with no mandate. "Active" is encoded a few
    # different ways in legacy data (status, tags) — match generously.
    base_query = {
        "$and": [
            {"$or": [
                {"status": {"$regex": "^active", "$options": "i"}},
                {"tags": "Franchisee"},
            ]},
            {"$or": [
                {"gocardless_mandate_id": None},
                {"gocardless_mandate_id": ""},
                {"gocardless_mandate_id": {"$exists": False}},
            ]},
        ]
    }
    candidates = await db.franchisees.find(
        base_query,
        {"_id": 0, "id": 1, "first_name": 1, "last_name": 1, "organisation": 1,
         "franchise_number": 1, "email": 1, "mojo_email": 1, "postcode": 1,
         "date_added": 1, "created_at": 1, "status": 1},
    ).to_list(500)
    if not candidates:
        return {"count": 0, "items": [], "threshold_days": days}

    # Bulk-fetch the earliest commencement date per franchisee in one go.
    ids = [c["id"] for c in candidates]
    commences = await db.contracts.aggregate([
        {"$match": {"franchisee_id": {"$in": ids}, "commencement_date": {"$ne": None}}},
        {"$group": {"_id": "$franchisee_id", "first_commencement": {"$min": "$commencement_date"}}},
    ]).to_list(len(ids))
    start_by_id = {r["_id"]: r["first_commencement"] for r in commences}

    items: list[dict] = []
    for f in candidates:
        start = start_by_id.get(f["id"]) or f.get("date_added") or f.get("created_at")
        if not start:
            continue
        start_str = str(start)[:10]
        if start_str > cutoff_iso:
            continue  # too recent — give them grace period
        try:
            went_live = datetime.fromisoformat(start_str)
        except ValueError:
            continue
        days_live = (datetime.now(timezone.utc).date() - went_live.date()).days
        items.append({
            "id": f["id"],
            "name": " ".join(filter(None, [f.get("first_name"), f.get("last_name")])).strip() or "(no name)",
            "organisation": f.get("organisation"),
            "franchise_number": f.get("franchise_number"),
            "email": f.get("mojo_email") or f.get("email"),
            "postcode": f.get("postcode"),
            "went_live_at": start_str,
            "days_live": days_live,
        })
    # Most overdue first
    items.sort(key=lambda x: -x["days_live"])
    return {"count": len(items), "items": items, "threshold_days": days}


@api.post("/franchisees/{franchisee_id}/link-gocardless-by-email")
async def link_franchisee_gocardless_by_email(
    franchisee_id: str,
    body: dict,
    user: dict = Depends(require_role("admin")),
):
    """Append an additional email to a franchisee's ``secondary_email`` and
    immediately re-run the single-franchisee GoCardless refresh. Used to
    repair cases where the GC customer has a different email to the one we
    have on file (typical legacy data drift)."""
    email = (body.get("email") or "").strip().lower()
    if not email or "@" not in email:
        raise HTTPException(400, "Provide a valid email address.")
    f = await db.franchisees.find_one({"id": franchisee_id}, {"_id": 0})
    if not f:
        raise HTTPException(404, "Franchisee not found")
    existing = (f.get("secondary_email") or "").strip()
    addrs = [e.strip() for e in existing.split(",") if e.strip()]
    if email not in [a.lower() for a in addrs]:
        addrs.append(email)
    new_val = ",".join(addrs)
    now = datetime.now(timezone.utc).isoformat()
    await db.franchisees.update_one(
        {"id": franchisee_id},
        {"$set": {"secondary_email": new_val, "updated_at": now}},
    )
    # Re-import lazily to avoid circular imports at module load.
    from gocardless_integration import refresh_single_franchisee  # type: ignore[attr-defined]
    try:
        refreshed = await refresh_single_franchisee(db, franchisee_id)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(500, f"Email saved, but GC refresh failed: {exc}")
    fresh = await db.franchisees.find_one({"id": franchisee_id}, {"_id": 0})
    return {
        "ok": True,
        "linked": bool(fresh and fresh.get("gocardless_customer_id")),
        "mandate_status": fresh.get("gocardless_mandate_status") if fresh else None,
        "secondary_email": new_val,
        "refresh": refreshed,
    }


@api.get("/franchisees/{franchisee_id}")
async def get_franchisee(franchisee_id: str, _: dict = Depends(require_role("admin"))):
    f = await db.franchisees.find_one({"id": franchisee_id}, {"_id": 0})
    if not f:
        raise HTTPException(status_code=404, detail="Franchisee not found")
    contracts = await db.contracts.find({"franchisee_id": franchisee_id}, {"_id": 0}).to_list(100)
    territories = await db.territories.find({"franchisee_id": franchisee_id}, {"_id": 0}).to_list(2000)
    enquiries = await db.web_form_contacts.find({"franchisee_id": franchisee_id}, {"_id": 0}).to_list(100)
    return {"franchisee": f, "contracts": contracts, "territories": territories, "enquiries": enquiries}


@api.get("/franchisees/{franchisee_id}/xero-contact-link")
async def franchisee_xero_contact_link(
    franchisee_id: str, _: dict = Depends(require_role("admin")),
):
    """Resolve the franchisee's Xero contact record by email and return
    a deep-link to their Xero contact page. Auto-caches the match on the
    franchisee record so subsequent loads are instant.

    Matching priority (first hit wins):
      1. Existing cached ``xero_contact_id`` on the franchisee
      2. mojo_email → xero_contacts_cache.email_lc
      3. secondary_email → email_lc
      4. organisation name → name_lc (loose fallback)
    """
    f = await db.franchisees.find_one(
        {"id": franchisee_id},
        {"_id": 0, "id": 1, "xero_contact_id": 1, "xero_contact_name": 1,
         "mojo_email": 1, "secondary_email": 1, "email": 1, "organisation": 1,
         "first_name": 1, "last_name": 1},
    )
    if not f:
        raise HTTPException(404, detail="Franchisee not found")

    def _url(cid: str) -> str:
        # Xero contact deep-link format used across the rest of the app.
        return f"https://go.xero.com/Contacts/View/{cid}"

    # 1. Already cached?
    if f.get("xero_contact_id"):
        return {
            "status": "linked",
            "contact_id": f["xero_contact_id"],
            "contact_name": f.get("xero_contact_name"),
            "url": _url(f["xero_contact_id"]),
            "match_via": "cached",
        }

    # 2–4. Look up by email / organisation / person-name in the local cache.
    candidates = []
    for key in ("mojo_email", "secondary_email", "email"):
        v = (f.get(key) or "").strip().lower()
        if v:
            candidates.append(("email_lc", v, key))
    org = (f.get("organisation") or "").strip().lower()
    if org:
        candidates.append(("name_lc", org, "organisation"))
    # Personal name fallback — useful when the Xero contact is the
    # individual rather than the trading name (very common for older
    # franchisees who Sandra invoiced personally).
    person = " ".join([
        (f.get("first_name") or "").strip(),
        (f.get("last_name") or "").strip(),
    ]).strip().lower()
    if person:
        candidates.append(("name_lc", person, "person_name"))

    for field, val, source in candidates:
        hit = await db.xero_contacts_cache.find_one(
            {field: val}, {"_id": 0, "contact_id": 1, "name": 1},
        )
        if hit and hit.get("contact_id"):
            # Cache the match back to the franchisee so we don't repeat
            # this lookup on every page load.
            await db.franchisees.update_one(
                {"id": franchisee_id},
                {"$set": {
                    "xero_contact_id": hit["contact_id"],
                    "xero_contact_name": hit.get("name"),
                    "xero_contact_match_source": source,
                }},
            )
            return {
                "status": "linked",
                "contact_id": hit["contact_id"],
                "contact_name": hit.get("name"),
                "url": _url(hit["contact_id"]),
                "match_via": source,
            }

    # Nothing matched — surface a generic "open Xero" link so the admin
    # can still jump there in one click and search manually.
    return {
        "status": "unlinked",
        "url": "https://go.xero.com/Contacts/Search/",
        "match_via": None,
    }


# Editable franchisee fields (admin only). Any unspecified field is left untouched.
FRANCHISEE_EDITABLE_FIELDS = {
    "first_name", "last_name", "organisation", "email", "mojo_email", "secondary_email",
    "telephone", "mobile_phone", "address", "address_street", "address_line_2",
    "city", "county", "postcode", "country",
    "potential", "fee_paid", "anniversary_reminder", "notes",
    "status", "staying_leaving",
    "website", "facebook", "bio_url",
    # Franchise number (e.g. 0029) — admin assigns on launch. Editable
    # from the Contact Details panel on FranchiseeDetailPage.
    "franchise_number",
}


@api.patch("/franchisees/{franchisee_id}")
async def update_franchisee(franchisee_id: str, body: dict, user: dict = Depends(require_role("admin"))):
    f = await db.franchisees.find_one({"id": franchisee_id}, {"_id": 0})
    if not f:
        raise HTTPException(status_code=404, detail="Franchisee not found")
    updates: Dict[str, Any] = {}
    for k, v in (body or {}).items():
        if k not in FRANCHISEE_EDITABLE_FIELDS:
            continue
        if isinstance(v, str):
            v = v.strip()
            if k == "email":
                v = v.lower()
            if k == "postcode":
                v = v.upper()
        updates[k] = v if v != "" else None
    if not updates:
        raise HTTPException(status_code=400, detail="No editable fields provided")
    updates["updated_at"] = datetime.now(timezone.utc).isoformat()
    updates["updated_by"] = user.get("email")
    await db.franchisees.update_one({"id": franchisee_id}, {"$set": updates})
    fresh = await db.franchisees.find_one({"id": franchisee_id}, {"_id": 0})
    return {"ok": True, "franchisee": fresh}


@api.post("/franchisees/{franchisee_id}/portal-toggle")
async def franchisee_portal_toggle(
    franchisee_id: str, body: dict,
    user: dict = Depends(require_role("admin")),
):
    """Turn portal access on/off for a franchisee. When turned off, any
    existing session is left alone (will fail on next /me call once
    enforced)."""
    enabled = bool((body or {}).get("enabled"))
    f = await db.franchisees.find_one({"id": franchisee_id}, {"_id": 0, "id": 1})
    if not f:
        raise HTTPException(404, detail="Franchisee not found")
    await db.franchisees.update_one(
        {"id": franchisee_id},
        {"$set": {
            "portal_enabled": enabled,
            "portal_toggled_at": datetime.now(timezone.utc).isoformat(),
            "portal_toggled_by": user.get("email"),
        }},
    )
    return {"ok": True, "portal_enabled": enabled}


@api.patch("/franchisees/{franchisee_id}/portal-modules")
async def franchisee_portal_modules(
    franchisee_id: str,
    body: dict,
    user: dict = Depends(require_role("admin")),
):
    """Admin-only toggle for the per-franchisee portal feature flags.

    Body shape (any subset of these keys; missing keys keep current value):
        { "map": bool, "calendar": bool, "files": bool, "invoicing": bool }

    Defaults if a franchisee has never had modules touched: map / calendar
    / files all ON, invoicing OFF. The /portal/me endpoint backfills these
    defaults on read, so this endpoint only needs to persist *changes*.
    """
    # Project enough to confirm the doc actually exists — we can't use
    # ``if not f`` after projecting only ``portal_modules`` because a
    # franchisee without modules yet returns ``{}`` (truthy in Mongo,
    # falsy in Python). Project ``id`` too as a presence sentinel.
    f = await db.franchisees.find_one(
        {"id": franchisee_id}, {"_id": 0, "id": 1, "portal_modules": 1},
    )
    if f is None:
        raise HTTPException(404, detail="Franchisee not found")
    current = f.get("portal_modules") or {}
    allowed = {"map", "calendar", "files", "territory_plus", "marketing", "invoicing", "bookings", "shape_orders"}
    next_modules = {
        "map":            bool(current.get("map",            True)),
        "calendar":       bool(current.get("calendar",       True)),
        "files":          bool(current.get("files",          True)),
        "territory_plus": bool(current.get("territory_plus", False)),
        "marketing":      bool(current.get("marketing",      False)),
        "invoicing":      bool(current.get("invoicing",      False)),
        "bookings":       bool(current.get("bookings",       False)),
        "shape_orders":   bool(current.get("shape_orders",   False)),
    }
    for key, val in (body or {}).items():
        if key in allowed:
            next_modules[key] = bool(val)
    await db.franchisees.update_one(
        {"id": franchisee_id},
        {"$set": {
            "portal_modules": next_modules,
            "portal_modules_updated_at": datetime.now(timezone.utc).isoformat(),
            "portal_modules_updated_by": user.get("email"),
        }},
    )
    return {"ok": True, "portal_modules": next_modules}


@api.post("/admin/seed-demo-franchisee")
async def admin_seed_demo_franchisee(
    body: dict | None = None,
    user: dict = Depends(require_role("admin")),
):
    """Create or reset a generic "Creative Mojo Demo" franchisee account
    that can be shared with prospective franchisees during a portal demo.

    Idempotent — safe to call repeatedly. If the demo franchisee/user
    already exist, the user's password is reset to the supplied (or
    default) demo password and the franchisee's `portal_modules` are
    re-applied. Returns `{ email, password, franchisee_id }`.

    Body (all optional):
      • email      — defaults to `demo@creativemojo.co.uk`
      • password   — defaults to `CreativeMojoDemo2026!`
      • modules    — dict of portal_modules toggles (defaults: all 6 ON
                     so demo viewers see every module incl. Plus add-ons).
    """
    body = body or {}
    email = (body.get("email") or "demo@creativemojo.co.uk").strip().lower()
    password = body.get("password") or "CreativeMojoDemo2026!"
    modules_override = body.get("modules") or {}
    # Default: all modules ON (standard + every Plus add-on) so the demo
    # account shows the full feature set off the bat.
    default_modules = {
        "map":            True,
        "calendar":       True,
        "files":          True,
        "territory_plus": True,
        "marketing":      True,
        "invoicing":      True,
        "bookings":       True,
        "shape_orders":   True,
    }
    modules = {**default_modules, **{
        k: bool(v) for k, v in modules_override.items()
        if k in default_modules
    }}

    now = datetime.now(timezone.utc).isoformat()
    # Copy Sandra's profile photo onto the demo franchisee so the portal
    # demo page shows a real headshot (rather than an empty avatar).
    # Sandra is the canonical "happy franchisee" for demo purposes.
    # Demo carries Sandra's facebook + bio URL so the public-facing
    # cards render in the portal walk-through (otherwise the panels
    # disappear and the demo looks half-empty).
    sandra = await db.franchisees.find_one(
        {"mojo_email": "sandra@creativemojo.co.uk"},
        {"_id": 0, "photo_url": 1, "photos": 1, "facebook": 1, "bio_url": 1},
    ) or {}
    demo_franchisee = {
        "first_name": "Creative Mojo",
        "last_name": "Demo",
        "organisation": "Creative Mojo Demo",
        "franchise_number": "DEMO",
        "mojo_email": email,
        "phone": "01884 303606",
        "mobile_phone": "07886 374959",
        "website": "https://www.creativemojo.com",
        "facebook": sandra.get("facebook") or "https://www.facebook.com/creativemojoltd",
        "bio_url": sandra.get("bio_url") or "https://www.creativemojo.com/blog/franchise/crowthorne-wokingham-bracknell-reading/",
        "address_street": "Channings, Brithem Bottom",
        "city": "Cullompton",
        "county": "Devon",
        "postcode": "EX15 1NB",
        "country": "United Kingdom",
        "start_date": "2024-01-01",
        "portal_enabled": True,
        "portal_modules": modules,
        "portal_modules_updated_at": now,
        "portal_modules_updated_by": user.get("email"),
        "tags": ["Demo"],
        "updated_at": now,
    }
    # Only carry over photo fields when Sandra actually has one set — we
    # never want to wipe an admin-uploaded demo photo on re-seed.
    if sandra.get("photo_url"):
        demo_franchisee["photo_url"] = sandra["photo_url"]
    if sandra.get("photos"):
        demo_franchisee["photos"] = sandra["photos"]

    # Upsert franchisee — match by mojo_email so re-running rewrites the same row.
    existing = await db.franchisees.find_one(
        {"mojo_email": email}, {"_id": 0, "id": 1},
    )
    if existing:
        franchisee_id = existing["id"]
        await db.franchisees.update_one(
            {"id": franchisee_id}, {"$set": demo_franchisee},
        )
    else:
        franchisee_id = str(uuid.uuid4())
        demo_franchisee["id"] = franchisee_id
        demo_franchisee["created_at"] = now
        demo_franchisee["created_by"] = user.get("email")
        await db.franchisees.insert_one(demo_franchisee)

    # Upsert the user account.
    existing_user = await db.users.find_one(
        {"email": email}, {"_id": 0, "id": 1},
    )
    user_doc = {
        "email": email,
        "name": "Creative Mojo Demo",
        "role": "franchisee",
        "franchisee_id": franchisee_id,
        "password_hash": hash_password(password),
        "active": True,
        "must_change_password": False,  # Demo password is shared — don't force a reset.
        "is_demo": True,
        "updated_at": now,
        "updated_by": user.get("email"),
    }
    if existing_user:
        await db.users.update_one({"id": existing_user["id"]}, {"$set": user_doc})
        user_id = existing_user["id"]
        action = "reset"
    else:
        user_id = str(uuid.uuid4())
        user_doc["id"] = user_id
        user_doc["created_at"] = now
        user_doc["created_by"] = user.get("email")
        await db.users.insert_one(user_doc)
        action = "created"
    # Bootstrap the standard folder set + drop a sample PDF into each
    # so the portal "My franchise documents" section isn't empty.
    franchisee_doc_for_folders = {**demo_franchisee, "id": franchisee_id}
    try:
        folder_result = await _seed_demo_folders_and_files(
            db, franchisee_doc_for_folders, user.get("email") or "demo-seed",
        )
    except Exception as exc:  # noqa: BLE001
        folder_result = {"error": str(exc)}
    return {
        "ok": True,
        "action": action,
        "email": email,
        "password": password,
        "franchisee_id": franchisee_id,
        "user_id": user_id,
        "portal_modules": modules,
        "folders": folder_result,
    }


async def _seed_demo_folders_and_files(db, franchisee_doc: dict, user_email: str) -> dict:
    """Bootstrap the standard 3 folders for the demo franchisee AND drop
    a tiny generated PDF into each so the portal "My franchise documents"
    section isn't empty during a demo.
    """
    from franchisee_folders import ensure_franchisee_folders, derive_franchisee_prefix, STANDARD_FOLDERS
    from file_storage import r2_configured, get_client, R2_BUCKET, SCOPE_FRANCHISEE
    if not r2_configured():
        return {"created": [], "skipped": [], "error": "R2 not configured"}

    folder_result = await ensure_franchisee_folders(db, franchisee_doc, user_email=user_email)
    prefix = folder_result.get("prefix") or derive_franchisee_prefix(franchisee_doc)
    if not prefix:
        return folder_result

    # Generate a small PDF per folder (only if no file already exists
    # other than the .keep marker — keeps the seed idempotent).
    try:
        from reportlab.pdfgen import canvas
        from reportlab.lib.pagesizes import A4
    except ImportError:
        # ReportLab is already a dependency, but guard anyway.
        folder_result["sample_files"] = "reportlab not installed"
        return folder_result

    import io
    client = get_client()
    now = datetime.now(timezone.utc).isoformat()
    sample_files = []
    for folder in STANDARD_FOLDERS:
        folder_prefix = f"{prefix}{folder}/"
        sample_name = f"Demo - {folder}.pdf"
        sample_key = f"{folder_prefix}{sample_name}"
        already = await db.files_index.find_one({"key": sample_key}, {"_id": 0, "key": 1})
        if already:
            sample_files.append({"folder": folder, "status": "exists"})
            continue
        # Build a 1-page PDF in-memory
        buf = io.BytesIO()
        c = canvas.Canvas(buf, pagesize=A4)
        c.setFont("Helvetica-Bold", 22)
        c.drawString(72, 750, f"Creative Mojo — {folder}")
        c.setFont("Helvetica", 12)
        c.drawString(72, 720, "Demo file for franchisee portal preview.")
        c.drawString(72, 700, "This PDF is auto-generated by the demo seed.")
        c.showPage()
        c.save()
        body_bytes = buf.getvalue()
        client.put_object(
            Bucket=R2_BUCKET, Key=sample_key, Body=body_bytes,
            ContentType="application/pdf",
        )
        await db.files_index.insert_one({
            "key": sample_key,
            "name": sample_name,
            "size": len(body_bytes),
            "content_type": "application/pdf",
            "scope": SCOPE_FRANCHISEE,
            "franchisee_id": franchisee_doc.get("id"),
            "uploaded_at": now,
            "uploaded_by": user_email,
        })
        sample_files.append({"folder": folder, "status": "created", "key": sample_key})
    folder_result["sample_files"] = sample_files
    return folder_result


@api.post("/franchisees/{franchisee_id}/portal-reset")
async def franchisee_portal_reset(
    franchisee_id: str,
    user: dict = Depends(require_role("admin")),
):
    """Wipe the portal password for this franchisee so they're forced
    to set a new one on next login. Use when they've forgotten it or
    when handing the account to someone new."""
    result = await db.users.update_one(
        {"franchisee_id": franchisee_id, "role": "franchisee"},
        {"$unset": {"password_hash": ""},
         "$set": {"password_reset_at": datetime.now(timezone.utc).isoformat(),
                  "password_reset_by": user.get("email")}},
    )
    return {"ok": True, "reset": result.matched_count > 0}


@api.post("/franchisees/{franchisee_id}/bootstrap-folders")
async def franchisee_bootstrap_folders(
    franchisee_id: str,
    user: dict = Depends(require_role("admin")),
):
    """Idempotently create the standard R2 folder structure (Artwork /
    Franchise Agreement / Territory) for a single franchisee. Safe to
    rerun — folders that already exist are skipped."""
    from franchisee_folders import ensure_franchisee_folders
    f = await db.franchisees.find_one({"id": franchisee_id}, {"_id": 0})
    if not f:
        raise HTTPException(404, detail="Franchisee not found")
    result = await ensure_franchisee_folders(db, f, user_email=user.get("email"))
    return {"ok": True, **result}


@api.post("/franchisees/bootstrap-folders/all")
async def franchisees_bootstrap_folders_all(
    user: dict = Depends(require_role("admin")),
):
    """Bulk-bootstrap standard folders for every ACTIVE franchisee that
    doesn't already have them. Ex-franchisees (tagged 'EX-Franchisee'
    or lifecycle_status='ex_franchisee') are excluded so their folders
    don't pollute the admin browser. Safe to rerun — skips existing."""
    from franchisee_folders import ensure_franchisee_folders
    cur = db.franchisees.find(
        {
            "tags": {"$nin": ["EX-Franchisee"]},
            "lifecycle_status": {"$ne": "ex_franchisee"},
        },
        {"_id": 0},
    )
    items = await cur.to_list(5000)
    summary = {"processed": 0, "created_total": 0, "skipped_total": 0,
               "without_prefix": 0, "results": []}
    for f in items:
        result = await ensure_franchisee_folders(db, f, user_email=user.get("email"))
        summary["processed"] += 1
        if not result.get("prefix"):
            summary["without_prefix"] += 1
            continue
        summary["created_total"] += len(result.get("created", []))
        summary["skipped_total"] += len(result.get("skipped", []))
        if result.get("created"):
            summary["results"].append({
                "franchisee_id": f.get("id"),
                "franchise_number": f.get("franchise_number"),
                "organisation": f.get("organisation"),
                "created": result["created"],
            })
    return summary


async def _ensure_portal_user_for_franchisee(
    franchisee_id: str,
    *,
    actor_email: Optional[str] = None,
    prefer_mojo_email: bool = True,
    generate_password: bool = True,
) -> dict:
    """Single source of truth for creating-or-linking a portal user for
    a franchisee. Used by:
      * POST /franchisees/{id}/create-portal-login (admin-triggered)
      * convert_contact_to_franchisee (auto-runs on conversion)
      * handover endpoint (force-resets the password + emails it)

    Returns:
        {
          "ok": bool,
          "already_existed": bool,
          "email": str | None,
          "user_id": str | None,
          "name": str | None,
          "temporary_password": str | None,
          "skipped_reason": str | None,
        }

    Never raises — callers (esp. the convert flow) treat a failed
    sub-step as non-fatal and surface the reason instead.
    """
    from franchisee_folders import ensure_franchisee_folders
    f = await db.franchisees.find_one({"id": franchisee_id}, {"_id": 0})
    if not f:
        return {"ok": False, "skipped_reason": "franchisee_not_found"}

    # Pick the email. ``prefer_mojo_email`` flips the lookup to put the
    # branded address first — admin asked for mojo_email priority during
    # auto-onboarding so the franchisee logs in with their CM identity.
    candidates = (
        ["mojo_email", "email", "primary_email", "contact_email"]
        if prefer_mojo_email
        else ["email", "primary_email", "contact_email", "mojo_email"]
    )
    email = ""
    for key in candidates:
        v = (f.get(key) or "").strip().lower()
        if v:
            email = v
            break
    if not email:
        return {"ok": False, "skipped_reason": "no_email_on_file"}

    name = (f.get("full_name") or f"{f.get('first_name', '')} {f.get('last_name', '')}".strip()
            or f.get("organisation") or email)

    # Ensure R2 folders exist before anything else (idempotent).
    try:
        await ensure_franchisee_folders(db, f, user_email=actor_email)
    except Exception:
        logger.exception("ensure_franchisee_folders failed for %s — continuing", franchisee_id)

    existing = await db.users.find_one({"email": email})
    now_iso = datetime.now(timezone.utc).isoformat()
    if existing:
        await db.users.update_one(
            {"id": existing["id"]},
            {"$set": {
                "role": "franchisee",
                "franchisee_id": franchisee_id,
                "active": True,
                "updated_at": now_iso,
                "updated_by": actor_email,
            }},
        )
        return {
            "ok": True,
            "already_existed": True,
            "email": email,
            "user_id": existing["id"],
            "name": existing.get("name") or name,
            "temporary_password": None,
            "skipped_reason": None,
        }

    # Strong, human-readable temp password — 14 chars, mixed case + digits.
    import secrets
    import string
    alphabet = string.ascii_letters + string.digits
    temp_password = "".join(secrets.choice(alphabet) for _ in range(14)) if generate_password else None
    new_id = str(uuid.uuid4())
    await db.users.insert_one({
        "id": new_id,
        "email": email,
        "name": name,
        "role": "franchisee",
        "franchisee_id": franchisee_id,
        "password_hash": hash_password(temp_password) if temp_password else "",
        "created_at": now_iso,
        "created_by": actor_email,
        "active": True,
        "must_change_password": True,
        "handover_pending": True,
    })
    return {
        "ok": True,
        "already_existed": False,
        "email": email,
        "user_id": new_id,
        "name": name,
        "temporary_password": temp_password,
        "skipped_reason": None,
    }


@api.post("/franchisees/{franchisee_id}/create-portal-login")
async def create_portal_login(
    franchisee_id: str,
    user: dict = Depends(require_role("admin")),
):
    """One-click create-or-link a portal login for this franchisee.

    Behaviour:
    * If a user with the franchisee's email already exists, we attach
      ``role=franchisee`` + ``franchisee_id`` to it (no password change)
      and return ``already_existed=True``.
    * Otherwise we mint a fresh user with a strong random temporary
      password and return it so the admin can pass it to the franchisee
      on a one-off basis. To email the password automatically use the
      Handover endpoint instead.
    * Standard folders are also ensured (idempotent — safe to re-run).
    """
    out = await _ensure_portal_user_for_franchisee(
        franchisee_id, actor_email=user.get("email"), prefer_mojo_email=False,
    )
    if not out.get("ok"):
        if out.get("skipped_reason") == "franchisee_not_found":
            raise HTTPException(404, detail="Franchisee not found")
        if out.get("skipped_reason") == "no_email_on_file":
            raise HTTPException(400, detail="This franchisee has no email on file — add one before creating a portal login.")
        raise HTTPException(400, detail=f"Could not create portal login: {out.get('skipped_reason')}")
    msg = ("Existing user updated and linked to this franchisee." if out["already_existed"]
           else "Portal login created. Share the temporary password securely — the franchisee will be asked to change it on first login.")
    return {**out, "message": msg}



@api.get("/portal/me")
async def portal_me(user: dict = Depends(require_role("franchisee"))):
    """Returns the logged-in franchisee's own profile + key data their
    dashboard needs (contact info, tenure, mandate snapshot). Files are
    fetched via the existing /api/files/* endpoints (scoped server-side)."""
    fid = user.get("franchisee_id")
    if not fid:
        raise HTTPException(400, detail="Franchisee link missing")
    f = await db.franchisees.find_one({"id": fid}, {"_id": 0})
    if not f:
        raise HTTPException(404, detail="Franchisee record not found")
    # Build a slim, read-only view (drop admin-only audit fields)
    keep = {
        "id", "franchise_number", "organisation", "first_name", "last_name",
        "full_name", "email", "primary_email", "contact_email", "mojo_email",
        "phone", "mobile",
        # Address — Airtable used both `address` (legacy) and `address_street`.
        # We expose both so the dashboard can fall back cleanly.
        "address", "address_street", "address_line2",
        "city", "town", "county", "postcode", "country",
        "website", "facebook_url", "facebook", "bio_url",
        "date_added",  # legacy "started with us" date — fallback for tenure
        "start_date", "end_date", "lifecycle_status",
        "gocardless_mandate_status", "gocardless_last_payment_at",
        "photo_url", "photos", "territory_postcodes", "territory_geojson",
        "territory_sectors", "territory_home_count",
        "portal_modules",  # Phase 5 — admin-controlled feature toggles
        "tags",  # Used client-side to detect demo accounts (extra demo-only nav entries)
    }
    profile = {k: f.get(k) for k in keep if k in f}
    # Backfill default portal_modules so the frontend never has to guess.
    # Defaults: map / calendar / files ON, invoicing OFF.
    existing_mods = (profile.get("portal_modules") or {}) if isinstance(profile.get("portal_modules"), dict) else {}
    # Standard modules (always available) plus the "Plus" subscription
    # add-ons (territory_plus / marketing / invoicing). Defaults: standard
    # ON, plus OFF.
    profile["portal_modules"] = {
        "map":            bool(existing_mods.get("map",            True)),
        "calendar":       bool(existing_mods.get("calendar",       True)),
        "files":          bool(existing_mods.get("files",          True)),
        # Plus add-ons (subscription-gated)
        "territory_plus": bool(existing_mods.get("territory_plus", False)),
        "marketing":      bool(existing_mods.get("marketing",      False)),
        "invoicing":      bool(existing_mods.get("invoicing",      False)),
        "bookings":       bool(existing_mods.get("bookings",       False)),
        "shape_orders":   bool(existing_mods.get("shape_orders",   False)),
    }
    # Fallback: if Airtable didn't carry over a start_date, derive it
    # from the earliest known contract, then `date_added`.
    if not profile.get("start_date"):
        earliest = await db.contracts.find_one(
            {"franchisee_id": fid, "commencement_date": {"$ne": None}},
            {"_id": 0, "commencement_date": 1},
            sort=[("commencement_date", 1)],
        )
        if earliest and earliest.get("commencement_date"):
            profile["start_date"] = earliest["commencement_date"]
        elif profile.get("date_added"):
            profile["start_date"] = profile["date_added"]
    # Current contract — the active (non-cancelled) contract with the latest
    # renewal date. We surface its commencement_date, renewal_date and term
    # length so the portal can show "Current contract: X yrs, started Y,
    # renews Z" without exposing the full contracts list.
    current_contract = await db.contracts.find_one(
        {"franchisee_id": fid, "cancelled_early": {"$ne": True}},
        {"_id": 0, "ref": 1, "commencement_date": 1, "renewal_date": 1,
         "contract_term_years": 1, "start_date": 1, "end_date": 1},
        sort=[("renewal_date", -1)],
    )
    if current_contract:
        # Legacy contracts may use start_date/end_date instead of the
        # commencement/renewal fields — fall back so older data still shows.
        profile["current_contract"] = {
            "ref": current_contract.get("ref"),
            "commencement_date": current_contract.get("commencement_date") or current_contract.get("start_date"),
            "renewal_date": current_contract.get("renewal_date") or current_contract.get("end_date"),
            "contract_term_years": current_contract.get("contract_term_years"),
        }
    return {"profile": profile, "user": user_to_public(user)}


@api.post("/portal/subscriptions/request")
async def portal_subscription_request(
    body: dict,
    user: dict = Depends(require_role("franchisee")),
):
    """Audit log for franchisee-initiated subscription requests.

    The frontend ALSO opens a mailto: to HQ — this endpoint just ensures
    every click is recorded server-side so we never lose a lead even if
    the franchisee's mail client misfires. No-op safe: returns ok=true
    even on a partial body so the UX is never blocked by validation.
    """
    addon = (body or {}).get("addon") or ""
    action = (body or {}).get("action") or ""
    allowed_addons = {"territory_plus", "marketing", "invoicing", "bookings", "shape_orders"}
    allowed_actions = {"enable", "cancel"}
    if addon not in allowed_addons or action not in allowed_actions:
        raise HTTPException(400, detail="Invalid addon or action")
    doc = {
        "id": str(uuid.uuid4()),
        "franchisee_id": user.get("franchisee_id"),
        "user_id": user.get("id"),
        "email": user.get("email"),
        "addon": addon,
        "action": action,
        "status": "pending",
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    await db.subscription_requests.insert_one(doc)

    # Notify HQ via Resend so a new request is visible immediately (the
    # admin queue is the source of truth, but a nudge prevents requests
    # sitting unactioned for days). All failures are swallowed — a Resend
    # outage must NOT block a franchisee submitting their request.
    try:
        from resend_routes import RESEND_API_KEY, RESEND_FROM_EMAIL, RESEND_FROM_NAME
        if RESEND_API_KEY:
            import resend as _resend
            _resend.api_key = RESEND_API_KEY
            addon_label = {
                "territory_plus": "Territory+", "marketing": "Marketing+",
                "invoicing": "Invoicing+", "bookings": "Bookings+",
            }.get(addon, addon)
            fname = ((await db.franchisees.find_one(
                {"id": doc["franchisee_id"]},
                {"_id": 0, "organisation": 1, "first_name": 1, "last_name": 1, "mojo_email": 1},
            )) or {})
            who = fname.get("organisation") or f"{fname.get('first_name','')} {fname.get('last_name','')}".strip() or fname.get("mojo_email") or "A franchisee"
            _resend.Emails.send({
                "from": f"{RESEND_FROM_NAME} <{RESEND_FROM_EMAIL}>",
                "to": ["paul@creativemojo.co.uk"],
                "subject": f"New bolt-on request: {addon_label} — {who}",
                "html": (
                    f"<p>{who} has requested <strong>{addon_label}</strong> via their portal.</p>"
                    f"<p>Action this in the admin queue:<br>"
                    f"<a href=\"https://hub.creativemojo.co.uk/admin/subscription-requests\">"
                    f"hub.creativemojo.co.uk/admin/subscription-requests</a></p>"
                ),
                "tags": [{"name": "kind", "value": "bolt-on-request"}],
            })
    except Exception:  # noqa: BLE001
        logger.info("Resend HQ notification skipped (non-fatal).")

    return {"ok": True, "id": doc["id"]}


@api.get("/portal/subscriptions/requests")
async def portal_my_subscription_requests(user: dict = Depends(require_role("franchisee"))):
    """The franchisee's own subscription requests, newest first. Used
    by the Subscriptions page to render the "Pending activation" state
    on cards where a request is already in flight, so they don't double
    submit."""
    cur = db.subscription_requests.find(
        {"franchisee_id": user.get("franchisee_id")},
        {"_id": 0},
    ).sort("created_at", -1).limit(50)
    return {"requests": await cur.to_list(50)}


@api.get("/admin/subscription-requests")
async def admin_list_subscription_requests(
    status: str = "pending",
    _: dict = Depends(require_role("admin")),
):
    """Admin view of every franchisee-submitted bolt-on request.
    Enriched with the franchisee's display name + organisation so the
    admin can action the queue without a second lookup."""
    q: dict = {}
    if status and status != "all":
        q["status"] = status
    rows = await db.subscription_requests.find(q, {"_id": 0}).sort("created_at", -1).limit(500).to_list(500)
    fids = list({r.get("franchisee_id") for r in rows if r.get("franchisee_id")})
    franchisees: dict[str, dict] = {}
    if fids:
        async for f in db.franchisees.find(
            {"id": {"$in": fids}},
            {"_id": 0, "id": 1, "first_name": 1, "last_name": 1, "organisation": 1, "mojo_email": 1},
        ):
            franchisees[f["id"]] = f
    for r in rows:
        f = franchisees.get(r.get("franchisee_id")) or {}
        r["franchisee_name"] = (f.get("organisation")
                                or " ".join([f.get("first_name") or "", f.get("last_name") or ""]).strip()
                                or "—")
        r["franchisee_email"] = f.get("mojo_email")
    return {"requests": rows}


@api.post("/admin/subscription-requests/{rid}/approve")
async def admin_approve_subscription_request(
    rid: str,
    user: dict = Depends(require_role("admin")),
):
    """Approving a request flips the corresponding ``portal_modules.*``
    flag on the franchisee record (enabling the module immediately) and
    stamps the request approved. The franchisee sees the change on
    their next portal load without needing to log in/out."""
    req = await db.subscription_requests.find_one({"id": rid}, {"_id": 0})
    if not req:
        raise HTTPException(404, detail="Request not found")
    if req.get("status") not in (None, "pending"):
        raise HTTPException(409, detail=f"Already {req.get('status')}")
    addon = req.get("addon")
    action = req.get("action") or "enable"
    new_value = action == "enable"
    await db.franchisees.update_one(
        {"id": req.get("franchisee_id")},
        {"$set": {f"portal_modules.{addon}": new_value,
                  "portal_modules_updated_at": datetime.now(timezone.utc).isoformat()}},
    )
    await db.subscription_requests.update_one(
        {"id": rid},
        {"$set": {
            "status": "approved",
            "decided_at": datetime.now(timezone.utc).isoformat(),
            "decided_by": user.get("email"),
        }},
    )

    # Queue a Xero invoice-line addition so the next monthly invoice
    # carries the bolt-on charge automatically — no manual HQ work.
    # The Xero scheduled run reads from ``pending_invoice_additions``.
    addon_label = {
        "territory_plus": "Territory+", "marketing": "Marketing+",
        "invoicing": "Invoicing+", "bookings": "Bookings+",
    }.get(addon, addon)
    if new_value:
        await db.pending_invoice_additions.insert_one({
            "franchisee_id": req.get("franchisee_id"),
            "addon": addon,
            "addon_label": addon_label,
            "amount": 10.0,
            "description": f"{addon_label} bolt-on — monthly subscription",
            "request_id": rid,
            "queued_at": datetime.now(timezone.utc).isoformat(),
            "queued_by": user.get("email"),
            "consumed": False,
        })

    # Confirmation email to the franchisee.
    try:
        from resend_routes import RESEND_API_KEY, RESEND_FROM_EMAIL, RESEND_FROM_NAME
        f = await db.franchisees.find_one(
            {"id": req.get("franchisee_id")},
            {"_id": 0, "first_name": 1, "mojo_email": 1, "email": 1},
        )
        to = (f or {}).get("mojo_email") or (f or {}).get("email")
        if RESEND_API_KEY and to:
            import resend as _resend
            _resend.api_key = RESEND_API_KEY
            _resend.Emails.send({
                "from": f"{RESEND_FROM_NAME} <{RESEND_FROM_EMAIL}>",
                "to": [to],
                "subject": f"{addon_label} is now active on your Creative Mojo portal",
                "html": (
                    f"<p>Hi {(f or {}).get('first_name') or 'there'},</p>"
                    f"<p>Good news — <strong>{addon_label}</strong> is now live on your portal. "
                    f"Refresh the page and you'll see the new section in your sidebar.</p>"
                    f"<p>The £10/mo charge will be added as a line item to your next Creative Mojo invoice, "
                    f"settled via your existing GoCardless Direct Debit mandate. No further action needed.</p>"
                    f"<p>Thanks,<br>Creative Mojo HQ</p>"
                ),
                "tags": [{"name": "kind", "value": "bolt-on-approved"}],
            })
    except Exception:  # noqa: BLE001
        logger.info("Resend approval email skipped (non-fatal).")

    return {"ok": True}


@api.post("/admin/subscription-requests/{rid}/reject")
async def admin_reject_subscription_request(
    rid: str,
    body: dict | None = Body(None),
    user: dict = Depends(require_role("admin")),
):
    """Declines a bolt-on request. Optional ``body.reason`` is recorded
    on the request for the audit trail."""
    req = await db.subscription_requests.find_one({"id": rid})
    if not req:
        raise HTTPException(404, detail="Request not found")
    if req.get("status") not in (None, "pending"):
        raise HTTPException(409, detail=f"Already {req.get('status')}")
    await db.subscription_requests.update_one(
        {"id": rid},
        {"$set": {
            "status": "rejected",
            "decided_at": datetime.now(timezone.utc).isoformat(),
            "decided_by": user.get("email"),
            "reject_reason": ((body or {}).get("reason") or "").strip()[:500] or None,
        }},
    )
    return {"ok": True}





@api.patch("/franchisees/{franchisee_id}/lifecycle")
async def update_franchisee_lifecycle(
    franchisee_id: str,
    body: dict,
    user: dict = Depends(require_role("admin")),
):
    """Toggle a franchisee between active and ex-franchisee status. This is a
    deliberate action distinct from generic field updates because it has
    knock-on effects (tag swap, audit timestamp, reminder banner)."""
    f = await db.franchisees.find_one({"id": franchisee_id}, {"_id": 0})
    if not f:
        raise HTTPException(status_code=404, detail="Franchisee not found")
    target = (body or {}).get("status")
    if target not in {"active", "ex_franchisee"}:
        raise HTTPException(status_code=400, detail="status must be 'active' or 'ex_franchisee'")
    reason = ((body or {}).get("reason") or "").strip()[:500]

    tags = list(f.get("tags") or [])
    # Strip both possible tags first, then add the right one back
    tags = [t for t in tags if t not in ("Franchisee", "EX-Franchisee")]
    tags.append("Franchisee" if target == "active" else "EX-Franchisee")

    now = datetime.now(timezone.utc).isoformat()
    update = {
        "lifecycle_status": target,
        "lifecycle_changed_at": now,
        "lifecycle_changed_by": user.get("email"),
        "tags": tags,
        "updated_at": now,
        "updated_by": user.get("email"),
    }
    if reason:
        update["lifecycle_change_reason"] = reason

    # When deactivating: capture the previous mandate snapshot so it's clear
    # what state they left in.
    if target == "ex_franchisee":
        update["deactivated_at"] = now
        if f.get("gocardless_mandate_status"):
            update["last_mandate_status_at_deactivation"] = f["gocardless_mandate_status"]
    # When reactivating: clear the deactivation markers and flag for mandate
    # re-setup. The UI uses `needs_mandate_setup` to show a reminder banner
    # until the next successful GoCardless sync clears it.
    if target == "active":
        update["reactivated_at"] = now
        update["deactivated_at"] = None
        # Only flag mandate-setup if their current GoCardless mandate is NOT active
        if f.get("gocardless_mandate_status") != "active":
            update["needs_mandate_setup"] = True
            update["needs_mandate_setup_since"] = now

    await db.franchisees.update_one({"id": franchisee_id}, {"$set": update})
    # Cascade lifecycle change onto the franchisee's contracts so renewals,
    # anniversaries and other reminders silence themselves automatically when
    # a franchisee is parked. Reactivation reverses it.
    if target == "ex_franchisee":
        await db.contracts.update_many(
            {"franchisee_id": franchisee_id, "cancelled_early": {"$ne": True}},
            {"$set": {
                "cancelled_early": True,
                "cancelled_at": now,
                "cancelled_reason": "Franchisee marked as ex-franchisee",
                "cancelled_by": user.get("email"),
            }},
        )
    else:  # back to active — undo the auto-cancellation we did before
        await db.contracts.update_many(
            {
                "franchisee_id": franchisee_id,
                "cancelled_early": True,
                "cancelled_reason": "Franchisee marked as ex-franchisee",
            },
            {"$set": {
                "cancelled_early": False,
                "cancelled_reactivated_at": now,
            },
             "$unset": {"cancelled_at": "", "cancelled_reason": "", "cancelled_by": ""}},
        )
    # Audit log row
    await db.franchisee_lifecycle_log.insert_one({
        "franchisee_id": franchisee_id,
        "previous_status": f.get("lifecycle_status") or ("active" if "Franchisee" in (f.get("tags") or []) else "ex_franchisee"),
        "new_status": target,
        "reason": reason or None,
        "changed_by": user.get("email"),
        "changed_at": now,
    })
    fresh = await db.franchisees.find_one({"id": franchisee_id}, {"_id": 0})
    return {"ok": True, "franchisee": fresh}


@api.patch("/franchisees/{franchisee_id}/launch-checklist")
async def update_franchisee_launch_checklist(
    franchisee_id: str,
    body: dict,
    user: dict = Depends(require_role("admin")),
):
    """In-House Franchisee Launch Prep Checklist. Stored as a free-form
    dict on the franchisee document; coerced to primitives (and one level
    of nested dict for the print-row two-state items)."""
    incoming = body.get("launch_checklist") if isinstance(body, dict) else None
    if not isinstance(incoming, dict):
        raise HTTPException(status_code=400, detail="launch_checklist must be an object")

    def _coerce(v):
        if isinstance(v, bool) or v is None:
            return v
        if isinstance(v, (int, float)):
            return v
        if isinstance(v, str):
            return v.strip()
        if isinstance(v, dict):
            return {str(k): _coerce(val) for k, val in v.items() if isinstance(k, str)}
        return None

    cleaned = {str(k): _coerce(v) for k, v in incoming.items() if isinstance(k, str)}
    now = datetime.now(timezone.utc).isoformat()
    update = {
        "launch_checklist": cleaned,
        "launch_checklist_updated_at": now,
        "launch_checklist_updated_by": user.get("email"),
        "updated_at": now,
    }
    r = await db.franchisees.update_one({"id": franchisee_id}, {"$set": update})
    if r.matched_count == 0:
        raise HTTPException(status_code=404, detail="Franchisee not found")
    return {"ok": True, "launch_checklist": cleaned, "launch_checklist_updated_at": now}


@api.post("/franchisees/{franchisee_id}/clear-mandate-reminder")
async def clear_mandate_reminder(
    franchisee_id: str,
    _user: dict = Depends(require_role("admin")),
):
    """Manually dismiss the 'needs mandate setup' reminder (in case the
    operator has set it up outside GoCardless)."""
    r = await db.franchisees.update_one(
        {"id": franchisee_id},
        {"$set": {"needs_mandate_setup": False,
                   "mandate_reminder_cleared_at": datetime.now(timezone.utc).isoformat()}},
    )
    if not r.matched_count:
        raise HTTPException(status_code=404, detail="Franchisee not found")
    return {"ok": True}


# ----------------------------------------------------------------------------
# Shared helper: find the latest territory_plan for a contact, with email
# fallback so we don't miss a plan tied to a sibling contact record.
# Used by both POST /contacts/{id}/convert-to-franchisee and the one-shot
# POST /admin/backfill/convert-territories endpoint.
# ----------------------------------------------------------------------------
async def _find_latest_territory_plan_for_contact(
    contact: dict, contact_id: str,
) -> tuple[Optional[dict], str]:
    """Return (plan, match_basis) where match_basis ∈
    {"contact_id", "email", ""} for logging / debugging.

    1. Try contact_id directly.
    2. If miss + the contact has an email, build the set of *all* contact
       IDs (across both web_form_contacts and contacts collections) that
       share that email, and pick the latest plan tied to any of them.
       This catches the multi-record-per-person case.
    """
    plan = await db.territory_plans.find_one(
        {"contact_id": contact_id},
        {"_id": 0},
        sort=[("created_at", -1)],
    )
    if plan and plan.get("sectors"):
        return plan, "contact_id"

    email = (contact.get("email") or "").strip().lower()
    if not email:
        return plan, ("contact_id" if plan else "")

    # Sibling contact IDs sharing the email (case-insensitive).
    email_q = {"email": {"$regex": f"^{re.escape(email)}$", "$options": "i"}}
    sibling_ids: set[str] = set()
    async for row in db.web_form_contacts.find(email_q, {"_id": 0, "id": 1}):
        if row.get("id"):
            sibling_ids.add(row["id"])
    async for row in db.contacts.find(email_q, {"_id": 0, "id": 1}):
        if row.get("id"):
            sibling_ids.add(row["id"])
    sibling_ids.discard(contact_id)
    if not sibling_ids:
        return plan, ("contact_id" if plan else "")

    sibling_plan = await db.territory_plans.find_one(
        {"contact_id": {"$in": list(sibling_ids)}, "sectors": {"$ne": []}},
        {"_id": 0},
        sort=[("created_at", -1)],
    )
    if sibling_plan and sibling_plan.get("sectors"):
        return sibling_plan, "email"
    return plan, ("contact_id" if plan else "")


def _extract_sales_handoff(contact: dict, captured_by: Optional[str]) -> Optional[dict]:
    """Snapshot the Sales Pipeline drawer checklist from a contact doc so
    it survives conversion onto the franchisee record. Returns ``None``
    when the contact has no checklist data at all (avoids polluting the
    franchisee doc with an empty handoff object for legacy migrated
    contacts that never went through the pipeline UI).
    """
    if not contact:
        return None
    keys = (
        "territory_defined",
        "contract_sent",
        "shadow_day_booked",
        "shadow_day_date",
        "shadowing_with",
        "training_days_booked",
        "training_day_dates",
    )
    snapshot = {k: contact.get(k) for k in keys if contact.get(k) not in (None, "", [])}
    if not snapshot:
        return None
    snapshot["captured_at"] = datetime.now(timezone.utc).isoformat()
    if captured_by:
        snapshot["captured_by"] = captured_by
    src_updated = contact.get("checklist_updated_at")
    if src_updated:
        snapshot["source_checklist_updated_at"] = src_updated
    src_by = contact.get("checklist_updated_by")
    if src_by:
        snapshot["source_checklist_updated_by"] = src_by
    return snapshot


@api.post("/contacts/{contact_id}/convert-to-franchisee")
async def convert_contact_to_franchisee(contact_id: str, user: dict = Depends(require_role("admin"))):
    """Create a franchisee/licencee record from an existing contact and mark the contact 'converted'.
    The record-type (franchisee vs licencee) is derived from the contact's source field."""
    contact = await db.web_form_contacts.find_one({"id": contact_id}, {"_id": 0})
    src_coll = "web_form_contacts"
    if not contact:
        contact = await db.contacts.find_one({"id": contact_id}, {"_id": 0})
        src_coll = "contacts"
    if not contact:
        raise HTTPException(status_code=404, detail="Contact not found")
    if contact.get("converted_to_franchisee_id"):
        raise HTTPException(status_code=409, detail="Contact already converted")
    record_type = "licencee" if contact.get("source") == "licence_enquiry" else "franchisee"
    now = datetime.now(timezone.utc).isoformat()
    f_id = str(uuid.uuid4())
    notes_lines = []
    if contact.get("message"):
        notes_lines.append(f"Original enquiry message:\n{contact['message']}")
    if contact.get("referral_source"):
        notes_lines.append(f"Heard about us via: {contact['referral_source']}")
    if contact.get("why_contacting"):
        notes_lines.append(f"Why contacting: {contact['why_contacting']}")
    if contact.get("date"):
        # Format ISO date to DD/MM/YYYY for human-readable notes
        raw_date = str(contact["date"])
        m = re.match(r"^(\d{4})-(\d{2})-(\d{2})", raw_date)
        display_date = f"{m.group(3)}/{m.group(2)}/{m.group(1)}" if m else raw_date
        notes_lines.append(f"Original enquiry date: {display_date}")
    # ------------------------------------------------------------------
    # Auto-link any territory plan that was built for this contact in the
    # Territory Builder. We look across both contact collections and ALSO
    # fall back to email-matching, because a single prospect (e.g. one
    # who first filled the legacy form then resubmitted the new Gravity
    # form) can have multiple contact rows; the plan might be attached
    # to a sibling, not the row the admin clicked Convert on. Latest
    # plan (highest ``created_at``) wins to avoid stale drafts.
    # ------------------------------------------------------------------
    plan, linked_via = await _find_latest_territory_plan_for_contact(contact, contact_id)
    territory_sectors: list[str] = []
    territory_home_count: int | None = None
    linked_plan_id: str | None = None
    if plan and plan.get("sectors"):
        # Normalise (uppercase, single-space, dedupe) — same rules as the
        # PUT /franchisees/{id}/territory endpoint applies on manual save.
        seen: list[str] = []
        for s in plan["sectors"]:
            v = " ".join(str(s).upper().split())
            if v and v not in seen:
                seen.append(v)
        territory_sectors = seen
        territory_home_count = plan.get("home_count")
        linked_plan_id = plan.get("id")
        logger.info(
            "convert-to-franchisee: linked plan %s (%d sectors) via %s for contact %s",
            linked_plan_id, len(seen), linked_via, contact_id,
        )

    franchisee_doc = {
        "id": f_id,
        "record_type": record_type,
        "first_name": contact.get("first_name"),
        "last_name": contact.get("last_name"),
        "organisation": contact.get("establishment_name"),
        "email": (contact.get("email") or "").lower() or None,
        # Mojo branded email — present on contacts when the admin set it
        # during sales triage. Carries onto the franchisee so the auto
        # portal-user step picks it up as the login.
        "mojo_email": (contact.get("mojo_email") or "").lower() or None,
        "telephone": contact.get("telephone"),
        "mobile_phone": contact.get("mobile_phone"),
        # ---- Address — copy every line the Franchisee detail page renders.
        # Contacts use ``address_line_1`` (canonical, May 2026) with legacy
        # mirror ``address_street``; franchisees only read the latter, so
        # we coalesce here.
        "address_street": (
            contact.get("address_line_1")
            or contact.get("address_street")
            or contact.get("address")
            or None
        ),
        "address_line_2": contact.get("address_line_2") or None,
        "postcode": (contact.get("postcode") or "").upper() or None,
        "city": contact.get("city") or contact.get("town") or None,
        "county": contact.get("county") or contact.get("region") or None,
        # Either ``country`` (manual-add form) or ``country_tag`` (legacy
        # webform classification). Fall back through both.
        "country": contact.get("country") or contact.get("country_tag") or None,
        "potential": contact.get("potential"),
        # NOTE: the Franchisees list "Active" / "Worldwide Licencees" tabs
        # filter strictly on tag presence (FranchiseesPage.js#SEGMENTS).
        # Without the matching tag, newly-converted records only show up
        # under "All" — which is what regression #SamanthaWhiteman was.
        "tags": [
            "Worldwide Licencee" if record_type == "licencee" else "Franchisee",
            "Converted from enquiry",
        ],
        "status": "Active",
        "converted_from_contact_id": contact_id,
        "converted_at": now,
        "converted_by": user.get("email"),
        "notes": "\n\n".join(notes_lines) if notes_lines else None,
        "created_at": now,
        "updated_at": now,
        "contract_ids": [],
        "territory_ids": [],
    }
    if territory_sectors:
        franchisee_doc["territory_sectors"] = territory_sectors
        franchisee_doc["territory_home_count"] = territory_home_count
        franchisee_doc["territory_updated_at"] = datetime.now(timezone.utc)
        franchisee_doc["territory_updated_by"] = user.get("email")
        franchisee_doc["territory_source_plan_id"] = linked_plan_id

    # ------------------------------------------------------------------
    # Sales handoff: preserve the Sales Pipeline drawer checklist on the
    # franchisee record so the onboarding history isn't lost. Stored
    # under two roofs:
    #   1. ``sales_handoff`` — verbatim copy of the contact's checklist
    #      (Territory confirmed / Contract sent / Shadow day + date +
    #      shadowing-with / Training days + dates). Surfaced as a
    #      read-only panel on FranchiseeDetailPage.
    #   2. ``launch_checklist`` — pre-ticks the matching In-House Launch
    #      Prep row (``territory_defined_confirmed``) so the launch
    #      checklist modal opens with the territory tick already on,
    #      saving the admin a click.
    # ------------------------------------------------------------------
    handoff = _extract_sales_handoff(contact, user.get("email"))
    if handoff:
        franchisee_doc["sales_handoff"] = handoff
        if handoff.get("territory_defined"):
            franchisee_doc["launch_checklist"] = {"territory_defined_confirmed": True}
            franchisee_doc["launch_checklist_updated_at"] = datetime.now(timezone.utc).isoformat()
            franchisee_doc["launch_checklist_updated_by"] = user.get("email")
    await db.franchisees.insert_one(franchisee_doc)

    # Back-link the plan to the new franchisee + audit-log the auto-copy
    # so the Territory History panel shows where the boundary came from.
    if linked_plan_id:
        await db.territory_plans.update_one(
            {"id": linked_plan_id},
            {"$set": {
                "franchisee_id": f_id,
                "updated_at": datetime.now(timezone.utc),
            }},
        )
        await db.territory_history.insert_one({
            "id": str(uuid.uuid4()),
            "franchisee_id": f_id,
            "organisation": franchisee_doc.get("organisation"),
            "previous_sectors": [],
            "previous_home_count": None,
            "previous_updated_at": None,
            "previous_updated_by": None,
            "new_sectors": territory_sectors,
            "new_home_count": territory_home_count,
            "changed_at": datetime.now(timezone.utc),
            "changed_by": user.get("email"),
            "added_count": len(territory_sectors),
            "removed_count": 0,
            "source": "convert_to_franchisee",
            "source_plan_id": linked_plan_id,
        })
    # Bootstrap their standard R2 folders (Artwork / Franchise Agreement
    # / Territory) so the portal Files panel isn't empty on first login.
    try:
        from franchisee_folders import ensure_franchisee_folders
        await ensure_franchisee_folders(db, franchisee_doc, user_email=user.get("email"))
    except Exception:  # noqa: BLE001
        logger.exception("Failed to bootstrap R2 folders for franchisee %s", f_id)
    # Mark contact as converted — remove from the pipeline (the conversion is
    # tracked by `converted_to_franchisee_id`, NOT by a pipeline stage, so they
    # don't pollute the renamed "Territory Map" column).
    update = {
        "in_pipeline": False,
        "pipeline_status": None,
        "converted_to_franchisee_id": f_id,
        "converted_to_record_type": record_type,
        "converted_at": now,
        "updated_at": now,
    }
    if src_coll == "web_form_contacts":
        await db.web_form_contacts.update_one({"id": contact_id}, {"$set": update})
    else:
        await db.contacts.update_one({"id": contact_id}, {"$set": update})
    franchisee_doc.pop("_id", None)
    # Ensure the response is JSON-friendly — datetimes go to ISO strings.
    if isinstance(franchisee_doc.get("territory_updated_at"), datetime):
        franchisee_doc["territory_updated_at"] = franchisee_doc["territory_updated_at"].isoformat()

    # Auto-create a portal user for this franchisee — using mojo_email
    # preferred. The user is created with ``handover_pending=True`` and a
    # random password that's NOT returned/sent. Admin must press the
    # "Handover" button when ready to send credentials.
    portal_user = await _ensure_portal_user_for_franchisee(
        f_id, actor_email=user.get("email"), prefer_mojo_email=True,
        generate_password=False,  # we don't surface the password here
    )
    return {
        "ok": True,
        "record_type": record_type,
        "franchisee": franchisee_doc,
        "territory_linked": bool(territory_sectors),
        "territory_sectors": territory_sectors,
        "territory_home_count": territory_home_count,
        "linked_plan_id": linked_plan_id,
        "portal_user": {
            "created": portal_user.get("ok") and not portal_user.get("already_existed"),
            "linked": portal_user.get("ok") and portal_user.get("already_existed"),
            "email": portal_user.get("email"),
            "user_id": portal_user.get("user_id"),
            "skipped_reason": portal_user.get("skipped_reason"),
        },
    }


# ----------------------------------------------------------------------------
# One-shot backfill: for every franchisee that was created via
# convert-to-franchisee BEFORE the auto-link fix shipped (18 Jun 2026),
# find the latest territory_plan that was drawn for the source contact
# and copy its sectors onto the franchisee. Idempotent + dry-run friendly.
# ----------------------------------------------------------------------------
@api.post("/admin/backfill/convert-territories")
async def backfill_convert_territories(
    dry_run: bool = False,
    user: dict = Depends(require_role("admin")),
):
    """Recover already-converted franchisees from BEFORE the auto-link
    fix shipped (18 Jun 2026). Two repairs in one pass:

    1. Territory: copy sectors+home_count from the latest territory_plan
       for the source contact (uses email-fallback to catch the
       multi-record-per-person case).
    2. Tags: ensure the franchisee carries the "Franchisee" / "Worldwide
       Licencee" tag so they appear under the Active tab on the
       Franchisees page — without this they only showed under "All".

    Idempotent. Supports ``?dry_run=true`` for a read-only preview.
    """
    now = datetime.now(timezone.utc)

    # Candidates: anything created via conversion that still needs ONE OR
    # BOTH repairs. Use a fat $or so a row missing only the tag (not the
    # territory) still gets retagged in a single pass.
    candidates = await db.franchisees.find(
        {
            "converted_from_contact_id": {"$exists": True, "$ne": None},
            "$or": [
                {"territory_sectors": {"$exists": False}},
                {"territory_sectors": []},
                {"territory_sectors": None},
                # Missing one of the segment tags
                {"tags": {"$nin": ["Franchisee", "Worldwide Licencee"]}},
                # Missing sales handoff snapshot
                {"sales_handoff": {"$exists": False}},
                # Missing address line / county (legacy convert mapping
                # only wrote postcode + city + country_tag)
                {"address_street": {"$in": [None, ""]}},
                {"county": {"$in": [None, ""]}},
            ],
        },
        {"_id": 0, "id": 1, "first_name": 1, "last_name": 1, "organisation": 1,
         "email": 1, "tags": 1, "territory_sectors": 1, "record_type": 1,
         "sales_handoff": 1, "launch_checklist": 1,
         "address_street": 1, "address_line_2": 1, "city": 1, "county": 1,
         "postcode": 1, "country": 1,
         "converted_from_contact_id": 1, "converted_at": 1},
    ).to_list(2000)

    linked = 0
    retagged = 0
    handoff_copied = 0
    address_filled = 0
    skipped_no_plan = 0
    linked_rows: list[dict] = []
    retagged_rows: list[dict] = []
    handoff_rows: list[dict] = []
    address_rows: list[dict] = []
    skipped_rows: list[dict] = []

    for fr in candidates:
        cid = fr.get("converted_from_contact_id")
        name = " ".join(filter(None, [fr.get("first_name"), fr.get("last_name")])) or fr.get("organisation") or fr["id"]

        # ---------- (a) tag repair ----------
        needed_tag = "Worldwide Licencee" if fr.get("record_type") == "licencee" else "Franchisee"
        existing_tags = fr.get("tags") or []
        if not isinstance(existing_tags, list):
            existing_tags = [existing_tags] if existing_tags else []
        tag_changed = needed_tag not in existing_tags
        if tag_changed:
            new_tags = [needed_tag] + [t for t in existing_tags if t != needed_tag]
            retagged_rows.append({"franchisee_id": fr["id"], "name": name, "added_tag": needed_tag})
            retagged += 1
            if not dry_run:
                await db.franchisees.update_one(
                    {"id": fr["id"]}, {"$set": {"tags": new_tags, "updated_at": now}},
                )

        # ---------- (b) territory repair ----------
        # Skip the territory copy if the row already has sectors — only the
        # tag may have been the issue.
        if fr.get("territory_sectors"):
            # Still attempt sales-handoff repair below.
            pass

        # Re-fetch the contact document so the email-fallback can fire even
        # when the row only exposes converted_from_contact_id.
        contact_doc = await db.web_form_contacts.find_one({"id": cid}, {"_id": 0})
        if not contact_doc:
            contact_doc = await db.contacts.find_one({"id": cid}, {"_id": 0})

        # ---------- (c) sales handoff repair ----------
        # Capture the Sales Pipeline drawer checklist on the franchisee.
        if not fr.get("sales_handoff") and contact_doc:
            handoff = _extract_sales_handoff(contact_doc, user.get("email"))
            if handoff:
                handoff_rows.append({"franchisee_id": fr["id"], "name": name,
                                     "fields": [k for k in handoff if k not in ("captured_at", "captured_by")]})
                handoff_copied += 1
                if not dry_run:
                    set_ops = {"sales_handoff": handoff, "updated_at": now}
                    # Pre-tick the launch_checklist territory row if not
                    # already touched on this franchisee.
                    if handoff.get("territory_defined") and not fr.get("launch_checklist"):
                        set_ops["launch_checklist"] = {"territory_defined_confirmed": True}
                        set_ops["launch_checklist_updated_at"] = now.isoformat()
                        set_ops["launch_checklist_updated_by"] = user.get("email")
                    await db.franchisees.update_one({"id": fr["id"]}, {"$set": set_ops})

        # ---------- (d) address repair ----------
        # Older convert runs missed address_line / county / address_line_2,
        # and used the legacy ``country_tag`` field that prospect contacts
        # rarely populate. Fill in whatever's still blank — never overwrite.
        if contact_doc:
            addr_updates: dict = {}
            if not fr.get("address_street"):
                v = (contact_doc.get("address_line_1")
                     or contact_doc.get("address_street")
                     or contact_doc.get("address"))
                if v:
                    addr_updates["address_street"] = v
            if not fr.get("address_line_2") and contact_doc.get("address_line_2"):
                addr_updates["address_line_2"] = contact_doc["address_line_2"]
            if not fr.get("city"):
                v = contact_doc.get("city") or contact_doc.get("town")
                if v:
                    addr_updates["city"] = v
            if not fr.get("county"):
                v = contact_doc.get("county") or contact_doc.get("region")
                if v:
                    addr_updates["county"] = v
            if not fr.get("country"):
                v = contact_doc.get("country") or contact_doc.get("country_tag")
                if v:
                    addr_updates["country"] = v
            if addr_updates:
                address_rows.append({"franchisee_id": fr["id"], "name": name,
                                     "fields": sorted(addr_updates.keys())})
                address_filled += 1
                if not dry_run:
                    addr_updates["updated_at"] = now
                    await db.franchisees.update_one({"id": fr["id"]}, {"$set": addr_updates})

        # Now run the territory link only when the row genuinely needs it.
        if fr.get("territory_sectors"):
            continue

        # Fallback: if the original contact was deleted/merged, use the
        # franchisee's own email so the helper can still find a sibling
        # plan tied to that email.
        if not contact_doc:
            contact_doc = {"id": cid, "email": fr.get("email")}

        plan, match_basis = await _find_latest_territory_plan_for_contact(contact_doc, cid)
        if not plan or not plan.get("sectors"):
            skipped_no_plan += 1
            skipped_rows.append({"franchisee_id": fr["id"], "name": name, "reason": "no plan for contact or email-sibling"})
            continue

        # Normalise sectors the same way save_franchisee_territory does.
        seen: list[str] = []
        for s in plan["sectors"]:
            v = " ".join(str(s).upper().split())
            if v and v not in seen:
                seen.append(v)
        if not seen:
            skipped_no_plan += 1
            skipped_rows.append({"franchisee_id": fr["id"], "name": name, "reason": "plan had no usable sectors"})
            continue

        row = {
            "franchisee_id": fr["id"],
            "name": name,
            "plan_id": plan.get("id"),
            "sectors": len(seen),
            "home_count": plan.get("home_count"),
            "matched_via": match_basis,
        }
        linked_rows.append(row)
        linked += 1
        if dry_run:
            continue

        # --- WRITES ---
        await db.franchisees.update_one(
            {"id": fr["id"]},
            {"$set": {
                "territory_sectors": seen,
                "territory_home_count": plan.get("home_count"),
                "territory_updated_at": now,
                "territory_updated_by": user.get("email"),
                "territory_source_plan_id": plan.get("id"),
            }},
        )
        await db.territory_plans.update_one(
            {"id": plan["id"]},
            {"$set": {"franchisee_id": fr["id"], "updated_at": now}},
        )
        await db.territory_history.insert_one({
            "id": str(uuid.uuid4()),
            "franchisee_id": fr["id"],
            "organisation": fr.get("organisation"),
            "previous_sectors": [],
            "previous_home_count": None,
            "previous_updated_at": None,
            "previous_updated_by": None,
            "new_sectors": seen,
            "new_home_count": plan.get("home_count"),
            "changed_at": now,
            "changed_by": user.get("email"),
            "added_count": len(seen),
            "removed_count": 0,
            "source": "backfill_convert_to_franchisee",
            "source_plan_id": plan.get("id"),
            "matched_via": match_basis,
        })

    return {
        "ok": True,
        "dry_run": dry_run,
        "candidates": len(candidates),
        "linked": linked,
        "retagged": retagged,
        "handoff_copied": handoff_copied,
        "address_filled": address_filled,
        "skipped_no_plan": skipped_no_plan,
        "linked_rows": linked_rows,
        "retagged_rows": retagged_rows,
        "handoff_rows": handoff_rows,
        "address_rows": address_rows,
        "skipped_rows": skipped_rows,
    }


# ----------------------------------------------------------------------------
# Link an enquiry contact to an EXISTING franchisee record (no new record
# created). Useful for cleaning up the pipeline when a lead is already in the
# franchisees collection from the migration. Mirrors the data-shape side-
# effects of `convert_contact_to_franchisee` so the drawer & list views
# behave identically afterwards.
# ----------------------------------------------------------------------------
class LinkExistingFranchiseePayload(BaseModel):
    franchisee_id: str
    append_to_notes: bool = True


def _score_franchisee_match(contact: dict, fr: dict) -> tuple[int, list[str]]:
    """Heuristic match score between a contact and a franchisee. Returns
    ``(score, reasons)`` — higher = better. Empty reasons means no signal."""
    score = 0
    reasons: list[str] = []
    c_email = (contact.get("email") or "").strip().lower()
    f_email = (fr.get("email") or "").strip().lower()
    if c_email and f_email and c_email == f_email:
        score += 100
        reasons.append("Email matches exactly")
    c_pc = re.sub(r"\s+", "", (contact.get("postcode") or "").upper())
    f_pc = re.sub(r"\s+", "", (fr.get("postcode") or "").upper())
    if c_pc and f_pc and c_pc == f_pc:
        score += 35
        reasons.append("Postcode matches")
    elif c_pc and f_pc and len(c_pc) >= 3 and c_pc[:3] == f_pc[:3]:
        score += 12
        reasons.append("Same postcode area")
    c_first = (contact.get("first_name") or "").strip().lower()
    c_last  = (contact.get("last_name") or "").strip().lower()
    f_first = (fr.get("first_name") or "").strip().lower()
    f_last  = (fr.get("last_name") or "").strip().lower()
    if c_first and c_last and f_first == c_first and f_last == c_last:
        score += 60
        reasons.append("Name matches exactly")
    elif c_last and f_last and c_last == f_last:
        score += 15
        reasons.append("Surname matches")
    # Telephone last-7-digit comparison (handles +44 / 0 prefix differences)
    def _norm_phone(p: str) -> str:
        return re.sub(r"\D", "", str(p or ""))[-7:]
    c_phone = _norm_phone(contact.get("telephone") or contact.get("mobile_phone"))
    f_phone = _norm_phone(fr.get("telephone") or fr.get("mobile_phone"))
    if c_phone and f_phone and c_phone == f_phone:
        score += 20
        reasons.append("Phone matches")
    return score, reasons


@api.get("/contacts/{contact_id}/franchisee-matches")
async def list_franchisee_matches_for_contact(
    contact_id: str,
    _user: dict = Depends(require_role("admin")),
):
    """Return every active franchisee, with the top-3 most likely matches for
    this contact flagged via ``suggested=True`` and a list of human-readable
    ``match_reasons``. Used by the Link-to-Existing-Franchisee modal."""
    contact = await db.web_form_contacts.find_one({"id": contact_id}, {"_id": 0})
    if not contact:
        contact = await db.contacts.find_one({"id": contact_id}, {"_id": 0})
    if not contact:
        raise HTTPException(404, "Contact not found")
    fr_cursor = db.franchisees.find(
        {"status": {"$ne": "Archived"}},
        {"_id": 0, "id": 1, "first_name": 1, "last_name": 1, "organisation": 1,
         "email": 1, "telephone": 1, "mobile_phone": 1, "postcode": 1, "city": 1,
         "franchise_number": 1, "status": 1, "record_type": 1, "photos": 1},
    )
    franchisees = await fr_cursor.to_list(500)
    scored: list[dict] = []
    for fr in franchisees:
        score, reasons = _score_franchisee_match(contact, fr)
        scored.append({**fr, "_score": score, "match_reasons": reasons})
    # Sort by score desc, then by surname asc for stability
    scored.sort(key=lambda x: (-x["_score"], (x.get("last_name") or "").lower()))
    # Flag the top-3 (with score > 0) as suggested
    suggested_cutoff = sum(1 for x in scored[:3] if x["_score"] > 0)
    for i, x in enumerate(scored):
        x["suggested"] = i < suggested_cutoff
        x.pop("_score", None)
    return {"contact_id": contact_id, "items": scored, "suggested_count": suggested_cutoff}


@api.post("/contacts/{contact_id}/link-to-franchisee")
async def link_contact_to_existing_franchisee(
    contact_id: str,
    payload: LinkExistingFranchiseePayload,
    user: dict = Depends(require_role("admin")),
):
    """Link an enquiry contact to an EXISTING franchisee record. Mirrors the
    drawer/list side-effects of the regular convert flow (in_pipeline=False,
    converted_to_franchisee_id set, pipeline_status cleared) WITHOUT creating
    a new franchisees row. Optionally appends the original enquiry to the
    franchisee's ``notes`` field for audit."""
    contact = await db.web_form_contacts.find_one({"id": contact_id}, {"_id": 0})
    src_coll = "web_form_contacts"
    if not contact:
        contact = await db.contacts.find_one({"id": contact_id}, {"_id": 0})
        src_coll = "contacts"
    if not contact:
        raise HTTPException(404, "Contact not found")
    if contact.get("converted_to_franchisee_id"):
        raise HTTPException(409, "Contact already linked / converted")
    fr = await db.franchisees.find_one({"id": payload.franchisee_id}, {"_id": 0})
    if not fr:
        raise HTTPException(404, "Franchisee not found")

    now = datetime.now(timezone.utc).isoformat()
    record_type = fr.get("record_type") or ("licencee" if contact.get("source") == "licence_enquiry" else "franchisee")

    # Optionally append the original enquiry to the franchisee's notes.
    if payload.append_to_notes:
        append_lines: list[str] = []
        raw_date = str(contact.get("date") or "")
        m = re.match(r"^(\d{4})-(\d{2})-(\d{2})", raw_date)
        display_date = f"{m.group(3)}/{m.group(2)}/{m.group(1)}" if m else (raw_date[:10] or "(unknown date)")
        append_lines.append(f"— Linked enquiry from {display_date} (by {user.get('email')}) —")
        if contact.get("source"):
            append_lines.append(f"Source: {contact['source'].replace('_', ' ').title()}")
        if contact.get("referral_source"):
            append_lines.append(f"Heard about us via: {contact['referral_source']}")
        if contact.get("why_contacting"):
            append_lines.append(f"Why contacting: {contact['why_contacting']}")
        if contact.get("message"):
            append_lines.append(f"Original message:\n{contact['message']}")
        if contact.get("comments"):
            append_lines.append(f"Comments:\n{contact['comments']}")
        appended = "\n".join(append_lines).strip()
        if appended:
            existing_notes = (fr.get("notes") or "").rstrip()
            new_notes = f"{existing_notes}\n\n{appended}".strip() if existing_notes else appended
            await db.franchisees.update_one(
                {"id": payload.franchisee_id},
                {"$set": {"notes": new_notes, "updated_at": now}},
            )

    # Side-effects on the contact — same shape as the convert flow so the
    # drawer flips to "VIEW RECORD", the kanban removes it from the column,
    # and the list view shows it under the In-Pipeline pill.
    contact_update = {
        "in_pipeline": False,
        "pipeline_status": None,
        "converted_to_franchisee_id": payload.franchisee_id,
        "converted_to_record_type": record_type,
        "converted_at": now,
        "linked_to_existing": True,
        "linked_by": user.get("email"),
        "linked_at": now,
        "updated_at": now,
    }
    coll = db.web_form_contacts if src_coll == "web_form_contacts" else db.contacts
    await coll.update_one({"id": contact_id}, {"$set": contact_update})
    return {
        "ok": True,
        "franchisee_id": payload.franchisee_id,
        "record_type": record_type,
        "appended_to_notes": payload.append_to_notes,
    }


# ----------------------------------------------------------------------------
# CRM — Contracts
# ----------------------------------------------------------------------------
@api.get("/contracts")
async def list_contracts(
    search: Optional[str] = None,
    franchisee_id: Optional[str] = None,
    limit: int = Query(500, le=1000),
    _: dict = Depends(require_role("admin")),
):
    q = {}
    if franchisee_id:
        q["franchisee_id"] = franchisee_id
    if search:
        rx = {"$regex": search, "$options": "i"}
        q["$or"] = [{"first_name_rollup": rx}, {"last_name_rollup": rx}, {"email_rollup": rx}]
    items = await db.contracts.find(q, {"_id": 0}).sort("ref", -1).limit(limit).to_list(limit)
    # attach franchisee organisation for display
    fids = list({c.get("franchisee_id") for c in items if c.get("franchisee_id")})
    franchisees = {f["id"]: f for f in await db.franchisees.find({"id": {"$in": fids}}, {"_id": 0, "id": 1, "organisation": 1, "first_name": 1, "last_name": 1}).to_list(1000)}
    for c in items:
        f = franchisees.get(c.get("franchisee_id"))
        c["franchisee"] = f if f else None
    return {"items": items, "total": await db.contracts.count_documents(q)}


@api.get("/contracts/renewals")
async def list_contract_renewals(
    within_days: int = Query(180, ge=1, le=3650, description="Only show contracts expiring within this many days from today; overdue always included."),
    include_overdue: bool = Query(True),
    _: dict = Depends(require_role("admin")),
):
    """Phase 1.8 — return all contracts that are either already expired (overdue)
    or expiring within `within_days`, joined with franchisee details and
    bucketed for the UI."""
    today = datetime.now(timezone.utc).date()

    cur = db.contracts.find({
        "renewal_date": {"$exists": True, "$nin": [None, ""]},
        "franchisee_id": {"$exists": True, "$nin": [None, ""]},  # skip orphan/unlinked contracts
    }, {"_id": 0})
    rows: list[dict] = []
    async for c in cur:
        try:
            rd = c["renewal_date"]
            renewal = datetime.strptime(rd[:10], "%Y-%m-%d").date()
        except Exception:  # noqa: BLE001
            continue
        days = (renewal - today).days
        if days < 0 and not include_overdue:
            continue
        if days > within_days:
            continue
        # bucket the row for easy UI grouping
        if days < 0:
            bucket = "overdue"
        elif days <= 30:
            bucket = "lt_30"
        elif days <= 90:
            bucket = "lt_90"  # the "reminder zone"
        elif days <= 180:
            bucket = "lt_180"
        else:
            bucket = "later"
        rows.append({**c, "days_remaining": days, "bucket": bucket})

    # Attach franchisee photo / mobile / mandate status / lifecycle
    fids = list({r.get("franchisee_id") for r in rows if r.get("franchisee_id")})
    franchisees_lookup = {
        f["id"]: f for f in await db.franchisees.find(
            {"id": {"$in": fids}},
            {"_id": 0, "id": 1, "first_name": 1, "last_name": 1, "organisation": 1,
             "mojo_email": 1, "email": 1, "mobile_phone": 1, "photos": 1, "postcode": 1,
             "gocardless_mandate_status": 1, "gocardless_mandate_reference": 1,
             "tags": 1, "lifecycle_status": 1},
        ).to_list(1000)
    }
    # Drop ex-franchisees entirely — their contracts are historic and should
    # not surface as upcoming renewals. A franchisee is considered ex if their
    # lifecycle_status is "ex_franchisee" OR they don't carry the "Franchisee"
    # tag (legacy data without lifecycle_status set).
    def _is_active(fdoc: dict | None) -> bool:
        if not fdoc:
            return False
        if fdoc.get("lifecycle_status") == "ex_franchisee":
            return False
        tags = fdoc.get("tags") or []
        # Legacy rows may store `tags` as a single string rather than a list —
        # normalise so substring checks like "Franchisee" in "EX-Franchisee"
        # don't false-positive.
        if isinstance(tags, str):
            tags = [tags]
        if "EX-Franchisee" in tags:
            return False
        return "Franchisee" in tags

    rows = [r for r in rows if _is_active(franchisees_lookup.get(r.get("franchisee_id")))]
    for r in rows:
        r["franchisee"] = franchisees_lookup.get(r.get("franchisee_id"))

    rows.sort(key=lambda r: r["days_remaining"])
    counts = {"overdue": 0, "lt_30": 0, "lt_90": 0, "lt_180": 0, "later": 0}
    for r in rows:
        counts[r["bucket"]] = counts.get(r["bucket"], 0) + 1
    counts["reminder_zone"] = counts["lt_30"] + counts["lt_90"]  # ≤90 days from today
    return {"items": rows, "counts": counts, "window_days": within_days, "today": today.isoformat()}


@api.get("/contracts/{contract_id}")
async def get_contract(contract_id: str, _: dict = Depends(require_role("admin"))):
    c = await db.contracts.find_one({"id": contract_id}, {"_id": 0})
    if not c:
        raise HTTPException(status_code=404, detail="Contract not found")
    f = await db.franchisees.find_one({"id": c.get("franchisee_id")}, {"_id": 0}) if c.get("franchisee_id") else None
    return {"contract": c, "franchisee": f}


class ContractIn(BaseModel):
    franchisee_id: str
    contract_term_years: int = Field(..., ge=1, le=10)
    commencement_date: str  # YYYY-MM-DD
    initial_starting_fee: Optional[float] = None
    monthly_fee: Optional[float] = None
    notes: Optional[str] = None


def _next_contract_ref(existing_max: Optional[int]) -> int:
    return (existing_max or 0) + 1


@api.post("/contracts")
async def create_contract(body: ContractIn, user: dict = Depends(require_role("admin"))):
    """Admin-only — create a new contract for a franchisee. The renewal
    date is auto-computed from `commencement_date + contract_term_years`.
    Used both for a brand-new franchisee's first contract and for
    renewals once the previous one expires."""
    # Validate franchisee exists
    f = await db.franchisees.find_one({"id": body.franchisee_id}, {"_id": 0, "id": 1, "first_name": 1, "last_name": 1, "email": 1, "organisation": 1})
    if not f:
        raise HTTPException(404, detail="Franchisee not found")
    try:
        start = datetime.strptime(body.commencement_date[:10], "%Y-%m-%d").date()
    except ValueError as exc:
        raise HTTPException(400, detail="commencement_date must be YYYY-MM-DD") from exc
    # Renewal date = start + N years (calendar maths, leap-year safe)
    try:
        renewal = start.replace(year=start.year + body.contract_term_years)
    except ValueError:
        # 29 Feb → 28 Feb in non-leap target year
        renewal = start.replace(month=2, day=28, year=start.year + body.contract_term_years)

    # Generate next ref number
    last = await db.contracts.find_one({}, {"_id": 0, "ref": 1}, sort=[("ref", -1)])
    next_ref = _next_contract_ref(last.get("ref") if last else 0)

    contract_id = str(uuid.uuid4())
    doc = {
        "id": contract_id,
        "ref": next_ref,
        "franchisee_id": body.franchisee_id,
        "contract_term_years": body.contract_term_years,
        "commencement_date": start.isoformat(),
        "renewal_date": renewal.isoformat(),
        "initial_starting_fee": body.initial_starting_fee,
        "monthly_fee": body.monthly_fee,
        "notes": body.notes,
        "cancelled_early": False,
        "first_name_rollup": f.get("first_name") or "",
        "last_name_rollup": f.get("last_name") or "",
        "email_rollup": (f.get("email") or "").lower(),
        "organisation_rollup": f.get("organisation") or "",
        "created_at": datetime.now(timezone.utc),
        "created_by": user.get("email"),
    }
    await db.contracts.insert_one(doc)
    doc.pop("_id", None)
    return {"contract": doc}


@api.patch("/contracts/{contract_id}")
async def update_contract(contract_id: str, body: dict, user: dict = Depends(require_role("admin"))):
    """Update an editable subset of a contract's fields. Re-derives the
    renewal date if commencement_date or contract_term_years change."""
    allowed = {"contract_term_years", "commencement_date", "initial_starting_fee",
               "monthly_fee", "notes", "cancelled_early"}
    update = {k: v for k, v in (body or {}).items() if k in allowed and v is not None}
    if not update:
        raise HTTPException(400, detail="Nothing to update")
    existing = await db.contracts.find_one({"id": contract_id}, {"_id": 0})
    if not existing:
        raise HTTPException(404, detail="Contract not found")
    if "commencement_date" in update or "contract_term_years" in update:
        start_str = update.get("commencement_date", existing.get("commencement_date"))
        years = int(update.get("contract_term_years", existing.get("contract_term_years") or 1))
        try:
            start = datetime.strptime(str(start_str)[:10], "%Y-%m-%d").date()
            try:
                renewal = start.replace(year=start.year + years)
            except ValueError:
                renewal = start.replace(month=2, day=28, year=start.year + years)
            update["renewal_date"] = renewal.isoformat()
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(400, detail=f"Invalid date/term: {exc}") from exc
    update["updated_at"] = datetime.now(timezone.utc)
    update["updated_by"] = user.get("email")
    # If the renewal date moves forward (contract was actually renewed),
    # clear any stale "contacted" flag — the cycle restarts.
    unset: dict = {}
    if "renewal_date" in update and update["renewal_date"] != existing.get("renewal_date"):
        unset.update({
            "last_reminded_at": "",
            "last_reminded_by": "",
            "last_reminded_by_name": "",
            "last_reminded_method": "",
        })
    mongo_op: dict = {"$set": update}
    if unset:
        mongo_op["$unset"] = unset
    await db.contracts.update_one({"id": contract_id}, mongo_op)
    fresh = await db.contracts.find_one({"id": contract_id}, {"_id": 0})
    return {"contract": fresh}


# ---------------------------------------------------------------------------
# Renewal-reminder bookkeeping
# ---------------------------------------------------------------------------
# When the admin clicks the "Email Reminder" lozenge on the Renewals page we
# mark the contract as "contacted" so it stops nagging at them. The state is
# advisory only — it doesn't change the actual renewal date or bucket; the row
# just renders with a green "Contacted" pill instead of the red CTA.

@api.post("/contracts/{contract_id}/mark-contacted")
async def mark_contract_contacted(
    contract_id: str,
    body: dict | None = None,
    user: dict = Depends(require_role("admin")),
):
    existing = await db.contracts.find_one({"id": contract_id}, {"_id": 0})
    if not existing:
        raise HTTPException(404, "Contract not found")
    now = datetime.now(timezone.utc).isoformat()
    method = (body or {}).get("method") or "email"  # email | phone | other
    await db.contracts.update_one(
        {"id": contract_id},
        {
            "$set": {
                "last_reminded_at": now,
                "last_reminded_by": user.get("email"),
                "last_reminded_by_name": user.get("name"),
                "last_reminded_method": method,
                "updated_at": datetime.now(timezone.utc),
            }
        },
    )
    return {
        "ok": True,
        "last_reminded_at": now,
        "last_reminded_by_name": user.get("name"),
        "last_reminded_method": method,
    }


@api.delete("/contracts/{contract_id}/mark-contacted")
async def unmark_contract_contacted(
    contract_id: str, _: dict = Depends(require_role("admin"))
):
    existing = await db.contracts.find_one({"id": contract_id}, {"_id": 0})
    if not existing:
        raise HTTPException(404, "Contract not found")
    await db.contracts.update_one(
        {"id": contract_id},
        {"$unset": {
            "last_reminded_at": "",
            "last_reminded_by": "",
            "last_reminded_by_name": "",
            "last_reminded_method": "",
        }},
    )
    return {"ok": True}


# ----------------------------------------------------------------------------
# CRM — Contacts (unified, with pipeline)
# ----------------------------------------------------------------------------
def _date_to_epoch(value) -> float:
    """Parse a date-ish value (datetime, ISO string, slash-string, etc.)
    into a comparable epoch-seconds float. Missing / unparseable → 0.

    The legacy Airtable export stored ``date`` as strings like
    ``"2026/05/19 a"`` (note the trailing ``" a"``). Mongo's natural
    string ordering puts these AFTER ISO ``"2026-05-29 …"`` because
    ``/`` (47) > ``-`` (45) in ASCII — which means the older record
    sorts ABOVE the newer one. Normalising to epoch fixes this.
    """
    if value is None:
        return 0.0
    if isinstance(value, datetime):
        return value.timestamp() if value.tzinfo else value.replace(tzinfo=timezone.utc).timestamp()
    if not isinstance(value, str):
        return 0.0
    s = value.strip()
    if not s:
        return 0.0
    # Strip Airtable's trailing " a" / " p" am/pm hint if present.
    if len(s) >= 2 and s[-2] == " " and s[-1] in ("a", "p"):
        s = s[:-2].strip()
    # Coerce slashes → dashes for date portion. We only touch the first
    # 10 chars to avoid mangling any time component.
    if len(s) >= 10 and s[4] == "/" and s[7] == "/":
        s = s[:4] + "-" + s[5:7] + "-" + s[8:10] + s[10:]
    # ``fromisoformat`` accepts "YYYY-MM-DD" and "YYYY-MM-DD HH:MM:SS".
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.timestamp()
    except (ValueError, TypeError):
        return 0.0


def _pipeline_recency(item: dict) -> float:
    """Recency key for kanban sort — picks the freshest pipeline signal."""
    for k in ("pipeline_status_updated_at", "updated_at", "date_added", "date"):
        v = item.get(k)
        if v:
            ep = _date_to_epoch(v)
            if ep:
                return ep
    return 0.0


@api.get("/contacts")
async def list_contacts(
    source: Optional[str] = None,
    pipeline_status: Optional[str] = None,
    in_pipeline: Optional[bool] = None,
    tab: Optional[str] = None,  # 'pipeline' | 'franchise' | 'licence' | 'care_home' | 'art_kit' | 'general'
    search: Optional[str] = None,
    limit: int = Query(500, le=10000),
    _: dict = Depends(require_role("admin")),
):
    """Combines legacy contacts + web form contacts under one query.

    Search behaviour: when ``search`` is non-empty the tab filter is
    intentionally bypassed and the query runs across BOTH collections
    (regardless of source / pipeline membership). This stops people
    disappearing from the default Pipeline view just because they happen
    to live in General/Care Home/etc — admins can now find anyone in the
    system from any tab. Each result still carries its ``source`` so the
    UI's SourcePill makes the proper tab obvious.
    """
    is_search = bool(search and search.strip())
    q_legacy = {}
    q_web = {}
    # Tab shorthand — only applied when NOT searching.
    if is_search:
        # Global search: hit both collections, no source / pipeline gate.
        pass
    elif tab == "pipeline":
        q_legacy = None
        q_web["in_pipeline"] = True
    elif tab == "franchise":
        # ALL franchise enquiries from BOTH collections. Pipeline membership
        # is now just a tag, not an exclusion — pipeline contacts also appear
        # here so we never lose track of someone being actively chased.
        q_legacy = {"source": "franchise_enquiry"}
        q_web["source"] = "franchise_enquiry"
    elif tab == "licence":
        q_legacy = {"source": "licence_enquiry"}
        q_web["source"] = "licence_enquiry"
    elif tab == "care_home":
        # Care-home class enquiries from BOTH collections — reference only.
        q_legacy = {"source": "care_home_enquiry"}
        q_web["source"] = "care_home_enquiry"
    elif tab == "art_kit":
        # Deliverable Art Kit enquiries from BOTH collections — reference only.
        q_legacy = {"source": "art_kit_enquiry"}
        q_web["source"] = "art_kit_enquiry"
    elif tab == "general":
        # General = the un-categorised long tail. Legacy rows that were
        # re-sourced into a specific category (franchise/care_home/art_kit/
        # licence) are excluded so they only appear in their proper tab.
        q_legacy = {"source": {"$in": ["legacy_general_enquiry", "general_enquiry", None]}}
        q_web["source"] = "general_enquiry"
    else:
        if source:
            if source == "legacy_general_enquiry":
                q_web = None
            elif source in ("franchise_enquiry", "licence_enquiry", "general_enquiry"):
                q_legacy = None
                q_web["source"] = source
        if in_pipeline is True:
            q_legacy = None
            if q_web is not None:
                q_web["in_pipeline"] = True
        elif in_pipeline is False:
            if q_web is not None:
                q_web["$or"] = [{"in_pipeline": {"$ne": True}}, {"in_pipeline": {"$exists": False}}]
    if pipeline_status:
        if q_legacy is not None:
            q_legacy["pipeline_status"] = pipeline_status
        if q_web is not None:
            q_web["pipeline_status"] = pipeline_status
    if search:
        # Multi-token search across all relevant fields.
        # Each token must match at least one field (AND across tokens, OR across fields)
        # so "Penny Davies" finds the person whose first_name="Penny" AND last_name="Davies".
        # A single token search still uses a fast single-regex path so partial matches are
        # broad (e.g. "Davies" finds anyone named Davies anywhere).
        import re
        tokens = [t for t in re.split(r"\s+", search.strip()) if t]
        legacy_fields = ["first_name", "last_name", "email", "postcode", "city"]
        web_fields = ["first_name", "last_name", "email", "telephone", "postcode", "city", "establishment_name"]
        if len(tokens) == 1:
            rx = {"$regex": re.escape(tokens[0]), "$options": "i"}
            if q_legacy is not None:
                q_legacy.setdefault("$and", []).append({"$or": [{f: rx} for f in legacy_fields]})
            if q_web is not None:
                q_web.setdefault("$and", []).append({"$or": [{f: rx} for f in web_fields]})
        else:
            for tok in tokens:
                rx = {"$regex": re.escape(tok), "$options": "i"}
                if q_legacy is not None:
                    q_legacy.setdefault("$and", []).append({"$or": [{f: rx} for f in legacy_fields]})
                if q_web is not None:
                    q_web.setdefault("$and", []).append({"$or": [{f: rx} for f in web_fields]})

    items = []
    if q_legacy is not None:
        # Exclude contacts that have been merged into another record — they
        # stay in the DB for audit but shouldn't appear in any list view.
        q_legacy.setdefault("merged_into", None)
        legacy = await db.contacts.find(q_legacy, {"_id": 0}).limit(limit).to_list(limit)
        items.extend(legacy)
    if q_web is not None:
        q_web.setdefault("merged_into", None)
        web = await db.web_form_contacts.find(q_web, {"_id": 0}).limit(limit).to_list(limit)
        items.extend(web)

    if search:
        # Score each result so the most relevant matches surface first.
        # Score weights: exact full-name match >> name-field token match >> other field match.
        q_lower = search.strip().lower()
        q_tokens = [t for t in q_lower.split() if t]

        def _score(item: dict) -> int:
            first = (item.get("first_name") or "").lower()
            last = (item.get("last_name") or "").lower()
            full = f"{first} {last}".strip()
            email = (item.get("email") or "").lower()
            est = (item.get("establishment_name") or "").lower()
            city = (item.get("city") or "").lower()
            postcode = (item.get("postcode") or "").lower()
            phone = (item.get("telephone") or "").lower()

            s = 0
            # Exact full-name match (or reverse "Davies Penny")
            if full == q_lower or f"{last} {first}".strip() == q_lower:
                s += 1000
            elif q_lower in full or full.startswith(q_lower):
                s += 600
            # All query tokens present in the name fields
            if q_tokens and all((t in first) or (t in last) for t in q_tokens):
                s += 400
            # All query tokens present in name+email
            if q_tokens and all((t in first) or (t in last) or (t in email) for t in q_tokens):
                s += 200
            # Token-level bonuses
            for t in q_tokens:
                if first == t or last == t:
                    s += 100
                if first.startswith(t) or last.startswith(t):
                    s += 50
                if t in first or t in last:
                    s += 30
                if t in email:
                    s += 15
                if t in est or t in city or t in postcode or t in phone:
                    s += 10
            return s

        items.sort(key=lambda x: (-_score(x), -(x.get("date") or x.get("date_added") or "").__hash__()))
    elif tab == "pipeline":
        # Pipeline kanban — sort by *when the card was last actioned in
        # the pipeline*, not by the original enquiry date. This makes
        # freshly-moved cards (e.g. someone you just marked "Contacted"
        # today) jump to the top of their column, regardless of how old
        # the enquiry itself is. Fallback chain:
        #   pipeline_status_updated_at  →  updated_at  →  date_added  →  date
        # All values are normalised to a comparable epoch float so the
        # legacy "2026/05/19 a" string-format Airtable dates can't beat
        # newer ISO timestamps via lexicographic sort.
        items.sort(key=lambda x: _pipeline_recency(x), reverse=True)
    else:
        items.sort(key=lambda x: _date_to_epoch(x.get("date") or x.get("date_added")), reverse=True)

    return {"items": items[:limit], "total": len(items)}


@api.get("/contacts/counts")
async def contact_counts(_: dict = Depends(require_role("admin"))):
    """Total record counts per Contacts tab. Used for the tab-header badges
    so admins can see at a glance where the long-tail of records lives.

    Only counts live (non-merged) rows. Each non-general tab unions matching
    rows across both ``web_form_contacts`` and the legacy ``contacts``
    collection (post-May-2026 re-categorisation). General lumps web
    ``general_enquiry`` + legacy rows whose source is still the un-tagged
    ``legacy_general_enquiry`` (or the explicit ``general_enquiry``).
    """
    not_merged = {"merged_into": {"$in": [None, ""]}}

    async def _wfc(filt: dict) -> int:
        return await db.web_form_contacts.count_documents({**filt, **not_merged})

    async def _legacy(filt: dict) -> int:
        return await db.contacts.count_documents({**filt, **not_merged})

    pipeline = await _wfc({"in_pipeline": True})
    franchise = await _wfc({"source": "franchise_enquiry"}) + await _legacy({"source": "franchise_enquiry"})
    licence = await _wfc({"source": "licence_enquiry"}) + await _legacy({"source": "licence_enquiry"})
    care_home = await _wfc({"source": "care_home_enquiry"}) + await _legacy({"source": "care_home_enquiry"})
    art_kit = await _wfc({"source": "art_kit_enquiry"}) + await _legacy({"source": "art_kit_enquiry"})
    general = (
        await _wfc({"source": "general_enquiry"})
        + await _legacy({"source": {"$in": ["legacy_general_enquiry", "general_enquiry", None]}})
    )
    return {
        "pipeline": pipeline,
        "franchise": franchise,
        "licence": licence,
        "care_home": care_home,
        "art_kit": art_kit,
        "general": general,
    }



@api.get("/contacts/duplicates")
async def list_duplicate_contacts(_: dict = Depends(require_role("admin"))):
    """Surface groups of contacts that share the same (case-insensitive,
    trimmed) email address so an admin can route them out via the existing
    merge flow.

    Only returns groups with 2+ live members (already-merged loser rows are
    excluded). Pulls from both ``web_form_contacts`` and the legacy
    ``contacts`` collection so nothing slips the net.
    """
    projection = {
        "_id": 0,
        "id": 1,
        "first_name": 1,
        "last_name": 1,
        "email": 1,
        "telephone": 1,
        "phone": 1,
        "mobile": 1,
        "postcode": 1,
        "source": 1,
        "form_id": 1,
        "in_pipeline": 1,
        "pipeline_status": 1,
        "date": 1,
        "created_at": 1,
        "gravity_entry_id": 1,
        "admin_notes": 1,
    }
    base_filter = {
        "email": {"$nin": [None, ""]},
        "merged_into": {"$in": [None, ""]},
    }
    rows: list[dict] = []
    for coll_name in ("web_form_contacts", "contacts"):
        coll = db[coll_name]
        async for doc in coll.find(base_filter, projection):
            email_norm = (doc.get("email") or "").strip().lower()
            if not email_norm:
                continue
            doc["_email_norm"] = email_norm
            doc["_collection"] = coll_name
            rows.append(doc)

    by_email: dict[str, list[dict]] = {}
    for r in rows:
        by_email.setdefault(r["_email_norm"], []).append(r)

    groups = []
    for email, members in by_email.items():
        if len(members) < 2:
            continue
        members.sort(
            key=lambda m: str(m.get("date") or m.get("created_at") or ""),
            reverse=True,
        )
        groups.append({
            "match_key": "email",
            "match_value": email,
            "count": len(members),
            "contacts": members,
        })
    groups.sort(key=lambda g: g["count"], reverse=True)
    return {
        "groups": groups,
        "total_groups": len(groups),
        "total_contacts": sum(g["count"] for g in groups),
    }


@api.get("/contacts/{contact_id}")
async def get_contact(contact_id: str, _: dict = Depends(require_role("admin"))):
    c = await db.contacts.find_one({"id": contact_id}, {"_id": 0})
    src = "contacts"
    if not c:
        c = await db.web_form_contacts.find_one({"id": contact_id}, {"_id": 0})
        src = "web_form_contacts"
    if not c:
        raise HTTPException(status_code=404, detail="Contact not found")
    return {"contact": c, "_source_collection": src}


class ContactCreateRequest(BaseModel):
    target: str  # "pipeline" | "franchise" | "licence" | "general"
    pipeline_status: Optional[str] = None
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    email: Optional[str] = None
    telephone: Optional[str] = None
    # Full address — added May 22 2026 to match the breadth of fields
    # that legacy / Airtable / Gravity-form imports carry. ``city`` (was
    # the only address field on the manual-add form) maps onto town/city
    # for back-compat. ``country`` defaults to "United Kingdom" client-side
    # but is free-text so non-UK addresses work.
    address_line_1: Optional[str] = None
    address_line_2: Optional[str] = None
    city: Optional[str] = None
    county: Optional[str] = None
    postcode: Optional[str] = None
    country: Optional[str] = None
    establishment_name: Optional[str] = None
    referral_source: Optional[str] = None
    notes: Optional[str] = None
    message: Optional[str] = None


@api.post("/contacts")
async def create_contact(body: ContactCreateRequest, user: dict = Depends(require_role("admin"))):
    """Admin can manually add a contact directly into any tab."""
    if body.target not in MOVE_TARGETS:
        raise HTTPException(status_code=400, detail=f"target must be one of {MOVE_TARGETS}")
    if body.target == "pipeline" and body.pipeline_status and body.pipeline_status not in PIPELINE_STAGES:
        raise HTTPException(status_code=400, detail=f"pipeline_status must be one of {PIPELINE_STAGES}")
    if not (body.first_name or body.last_name or body.email or body.establishment_name):
        raise HTTPException(status_code=400, detail="At least one of first_name, last_name, email, or establishment_name is required")

    now = datetime.now(timezone.utc).isoformat()
    source_by_target = {
        "pipeline":  "franchise_enquiry",   # default; admin can change source later
        "franchise": "franchise_enquiry",
        "licence":   "licence_enquiry",
        "general":   "general_enquiry",
    }
    source = source_by_target[body.target]
    in_pipeline = (body.target == "pipeline")
    pipeline_status = (body.pipeline_status or "new") if in_pipeline else None
    # Auto-route: a freshly-added franchise/licence contact whose date is within the last 30
    # days belongs in the Sales Pipeline regardless of which tab the user picked, so the team
    # can triage it before it goes cold. Source is preserved so the pill colour stays right.
    if body.target in ("franchise", "licence"):
        in_pipeline = True
        pipeline_status = "new"

    doc = {
        "id": str(uuid.uuid4()),
        "first_name": (body.first_name or "").strip() or None,
        "last_name": (body.last_name or "").strip() or None,
        "email": (body.email or "").strip().lower() or None,
        "telephone": (body.telephone or "").strip() or None,
        # Full address. ``address_line_1`` is also mirrored into the legacy
        # ``address_street`` field so older list views / exports that
        # already reference that key keep working.
        "address_line_1": (body.address_line_1 or "").strip() or None,
        "address_line_2": (body.address_line_2 or "").strip() or None,
        "address_street": (body.address_line_1 or "").strip() or None,
        "city": (body.city or "").strip() or None,
        "town_city": (body.city or "").strip() or None,
        "county": (body.county or "").strip() or None,
        "postcode": (body.postcode or "").strip().upper() or None,
        "country": (body.country or "").strip() or None,
        "establishment_name": (body.establishment_name or "").strip() or None,
        "referral_source": body.referral_source or None,
        "message": (body.message or body.notes or "").strip() or None,
        "source": source,
        "in_pipeline": in_pipeline,
        "pipeline_status": pipeline_status,
        "form_id": None,
        "date": now,
        "date_added": now,
        "received_at": now,
        "created_at": now,
        "updated_at": now,
        "manually_added_by": user.get("email"),
    }
    await db.web_form_contacts.insert_one(doc)
    doc.pop("_id", None)
    return {"ok": True, "contact": doc}


class PipelineUpdateRequest(BaseModel):
    pipeline_status: str


PIPELINE_STAGES = ["new", "contacted", "qualified", "demo_booked", "converted", "dormant", "lost", "archive"]


class ContactImportRow(BaseModel):
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    email: Optional[str] = None
    telephone: Optional[str] = None
    postcode: Optional[str] = None
    city: Optional[str] = None
    country: Optional[str] = None
    establishment_name: Optional[str] = None
    referral_source: Optional[str] = None
    message: Optional[str] = None
    date: Optional[str] = None  # ISO date or YYYY-MM-DD


class ContactImportRequest(BaseModel):
    target: str  # "pipeline" | "franchise" | "licence" | "general"
    pipeline_status: Optional[str] = None
    rows: List[ContactImportRow]
    dedupe_by_email: bool = True


@api.post("/contacts/import")
async def import_contacts(body: ContactImportRequest, user: dict = Depends(require_role("admin"))):
    """Bulk-import contacts (e.g. CSV of historical Gravity Forms entries that never
    reached Airtable). Skips rows with no name/email/establishment and rows whose email
    already exists when dedupe_by_email=True."""
    if body.target not in MOVE_TARGETS:
        raise HTTPException(status_code=400, detail=f"target must be one of {MOVE_TARGETS}")
    if body.target == "pipeline" and body.pipeline_status and body.pipeline_status not in PIPELINE_STAGES:
        raise HTTPException(status_code=400, detail=f"pipeline_status must be one of {PIPELINE_STAGES}")
    if not body.rows:
        raise HTTPException(status_code=400, detail="No rows supplied")

    source_by_target = {
        "pipeline":  "franchise_enquiry",
        "franchise": "franchise_enquiry",
        "licence":   "licence_enquiry",
        "general":   "general_enquiry",
    }
    source = source_by_target[body.target]
    base_in_pipeline = (body.target == "pipeline")
    base_pipeline_status = (body.pipeline_status or "new") if base_in_pipeline else None
    # 30-day pipeline auto-route applies to franchise/licence targets (per-row by date)
    auto_pipeline = body.target in ("franchise", "licence")
    from datetime import timedelta as _td
    cutoff_30 = (datetime.now(timezone.utc) - _td(days=30)).strftime("%Y-%m-%d")

    now = datetime.now(timezone.utc).isoformat()
    inserted = 0
    skipped_empty = 0
    skipped_duplicate = 0
    existing_emails: set = set()
    if body.dedupe_by_email:
        cur = db.web_form_contacts.find({"email": {"$ne": None}}, {"_id": 0, "email": 1})
        async for r in cur:
            if r.get("email"):
                existing_emails.add(r["email"].strip().lower())

    docs_to_insert = []
    for row in body.rows:
        if not (row.first_name or row.last_name or row.email or row.establishment_name):
            skipped_empty += 1
            continue
        email = (row.email or "").strip().lower() or None
        if body.dedupe_by_email and email and email in existing_emails:
            skipped_duplicate += 1
            continue
        if email:
            existing_emails.add(email)
        date_val = (row.date or "").strip() or now
        # Normalise date if it's full ISO timestamp
        if "T" in date_val:
            try:
                date_val = date_val[:10]
            except Exception:
                pass
        # Per-row pipeline decision: franchise/licence rows within 30 days auto-go to pipeline
        if auto_pipeline:
            row_in_pipeline = date_val[:10] >= cutoff_30
            row_status = "new" if row_in_pipeline else None
        else:
            row_in_pipeline = base_in_pipeline
            row_status = base_pipeline_status
        doc = {
            "id": str(uuid.uuid4()),
            "first_name": (row.first_name or "").strip() or None,
            "last_name": (row.last_name or "").strip() or None,
            "email": email,
            "telephone": (row.telephone or "").strip() or None,
            "postcode": (row.postcode or "").strip().upper() or None,
            "city": (row.city or "").strip() or None,
            "country_tag": (row.country or "").strip() or None,
            "establishment_name": (row.establishment_name or "").strip() or None,
            "referral_source": (row.referral_source or "").strip() or None,
            "message": (row.message or "").strip() or None,
            "source": source,
            "in_pipeline": row_in_pipeline,
            "pipeline_status": row_status,
            "form_id": None,
            "date": date_val,
            "date_added": date_val,
            "received_at": now,
            "created_at": now,
            "updated_at": now,
            "manually_added_by": user.get("email"),
            "import_batch": now,
        }
        docs_to_insert.append(doc)

    if docs_to_insert:
        await db.web_form_contacts.insert_many(docs_to_insert)
        inserted = len(docs_to_insert)
    return {
        "ok": True,
        "inserted": inserted,
        "skipped_empty": skipped_empty,
        "skipped_duplicate": skipped_duplicate,
        "target": body.target,
    }


@api.patch("/contacts/{contact_id}/pipeline")
async def update_pipeline(contact_id: str, body: PipelineUpdateRequest, _: dict = Depends(require_role("admin"))):
    if body.pipeline_status not in PIPELINE_STAGES:
        raise HTTPException(status_code=400, detail=f"Status must be one of {PIPELINE_STAGES}")
    # Stamp `pipeline_status_updated_at` so the Kanban column can sort
    # freshly-actioned contacts to the top regardless of original
    # enquiry date.
    now_iso = datetime.now(timezone.utc).isoformat()
    patch = {
        "pipeline_status": body.pipeline_status,
        "updated_at": now_iso,
        "pipeline_status_updated_at": now_iso,
    }
    r = await db.web_form_contacts.update_one(
        {"id": contact_id},
        {"$set": {**patch, "in_pipeline": True}},
    )
    if r.matched_count == 0:
        r = await db.contacts.update_one(
            {"id": contact_id},
            {"$set": patch},
        )
    if r.matched_count == 0:
        raise HTTPException(status_code=404, detail="Contact not found")
    return {"ok": True, "pipeline_status": body.pipeline_status}


class AdminNotesUpdate(BaseModel):
    admin_notes: Optional[str] = None


@api.patch("/contacts/{contact_id}/checklist")
async def update_contact_checklist(
    contact_id: str,
    body: dict,
    user: dict = Depends(require_role("admin")),
):
    """Persist the three-item Interested-stage checklist on a contact.

    The UI (ContactsPage drawer) renders these boxes only while the
    contact is in the ``qualified`` ("Interested") pipeline stage but we
    keep the values forever — useful for reports later. Booleans only;
    anything else is coerced via ``bool()``.
    """
    fields = {k: bool(body.get(k)) for k in ("territory_defined", "contract_sent", "shadow_day_booked", "training_days_booked")}
    # Optional companion fields for the "Shadow Day Booked" row — a date
    # (ISO YYYY-MM-DD or empty) and a free-text "with whom" string. Stored
    # alongside the booleans so the drawer can re-render them on reload.
    raw_date = (body.get("shadow_day_date") or "").strip()
    fields["shadow_day_date"] = raw_date or None
    raw_with = (body.get("shadowing_with") or "").strip()
    fields["shadowing_with"] = raw_with or None
    # Training-day(s) booked supports multiple dates (training runs over 2–3
    # days). Stored as a list of ISO YYYY-MM-DD strings, de-duped and sorted.
    raw_training = body.get("training_day_dates") or []
    if isinstance(raw_training, str):
        raw_training = [raw_training]
    cleaned = []
    for d in raw_training:
        s = (str(d) or "").strip()
        if s and s not in cleaned:
            cleaned.append(s)
    cleaned.sort()
    fields["training_day_dates"] = cleaned
    now = datetime.now(timezone.utc).isoformat()
    update = {**fields, "checklist_updated_at": now, "checklist_updated_by": user.get("email"), "updated_at": now}
    r = await db.web_form_contacts.update_one({"id": contact_id}, {"$set": update})
    if r.matched_count == 0:
        r = await db.contacts.update_one({"id": contact_id}, {"$set": update})
    if r.matched_count == 0:
        raise HTTPException(status_code=404, detail="Contact not found")
    return {"ok": True, **fields, "checklist_updated_at": now}


@api.patch("/contacts/{contact_id}/details")
async def update_contact_details(
    contact_id: str,
    body: dict,
    user: dict = Depends(require_role("admin")),
):
    """Inline edit of a contact's identity + address fields.

    Sales staff regularly need to fix typos that come through Gravity
    Forms / Airtable imports (mis-typed postcodes, misspelt names, etc),
    so the drawer offers an inline edit. The whitelist below mirrors the
    create endpoint; ``address_line_1`` and ``city`` are written into
    BOTH the modern and the legacy aliases so older list views and
    exports stay in sync.
    """
    EDITABLE = {
        "first_name", "last_name", "email", "telephone", "mobile_phone",
        "address_line_1", "address_line_2", "city", "county", "postcode", "country",
    }
    update: dict = {}
    for key, raw in (body or {}).items():
        if key not in EDITABLE:
            continue
        if raw is None:
            update[key] = None
            continue
        if not isinstance(raw, str):
            raise HTTPException(status_code=400, detail=f"{key} must be a string or null")
        v = raw.strip()
        if key == "email":
            update[key] = v.lower() or None
        elif key == "postcode":
            update[key] = v.upper() or None
        else:
            update[key] = v or None
    if not update:
        raise HTTPException(status_code=400, detail="No editable fields provided")

    # Legacy field mirrors — keep them aligned with the modern keys so
    # the various list views, exports and dashboards stay consistent.
    if "address_line_1" in update:
        update["address_street"] = update["address_line_1"]
    if "city" in update:
        update["town_city"] = update["city"]

    now = datetime.now(timezone.utc).isoformat()
    update["updated_at"] = now
    update["details_updated_at"] = now
    update["details_updated_by"] = user.get("email")

    r = await db.web_form_contacts.update_one({"id": contact_id}, {"$set": update})
    if r.matched_count == 0:
        r = await db.contacts.update_one({"id": contact_id}, {"$set": update})
    if r.matched_count == 0:
        raise HTTPException(status_code=404, detail="Contact not found")
    return {"ok": True, **update}


@api.patch("/contacts/{contact_id}/launch-checklist")
async def update_contact_launch_checklist(
    contact_id: str,
    body: dict,
    user: dict = Depends(require_role("admin")),
):
    """Persist the larger "In-house Franchisee Launch Prep Checklist".

    The frontend serialises the whole form (ticks + free text fields) into
    a single dict and PATCHes the merged result on every change. We don't
    impose a schema server-side — the form layout is paper-style and
    static in v1, so the contract is dict-in/dict-out. Anything outside
    plain primitives is dropped to keep the document sane.
    """
    incoming = body.get("launch_checklist") if isinstance(body, dict) else None
    if not isinstance(incoming, dict):
        raise HTTPException(status_code=400, detail="launch_checklist must be an object")

    def _coerce(v):
        if isinstance(v, bool) or v is None:
            return v
        if isinstance(v, (int, float)):
            return v
        if isinstance(v, str):
            return v.strip()
        # Allow one level of nesting for sub-rows like "printed" -> {"aw": bool, "printed": bool}.
        if isinstance(v, dict):
            return {str(k): _coerce(val) for k, val in v.items() if isinstance(k, str)}
        return None

    cleaned = {str(k): _coerce(v) for k, v in incoming.items() if isinstance(k, str)}
    now = datetime.now(timezone.utc).isoformat()
    update = {
        "launch_checklist": cleaned,
        "launch_checklist_updated_at": now,
        "launch_checklist_updated_by": user.get("email"),
        "updated_at": now,
    }
    r = await db.web_form_contacts.update_one({"id": contact_id}, {"$set": update})
    if r.matched_count == 0:
        r = await db.contacts.update_one({"id": contact_id}, {"$set": update})
    if r.matched_count == 0:
        raise HTTPException(status_code=404, detail="Contact not found")
    return {"ok": True, "launch_checklist": cleaned, "launch_checklist_updated_at": now}


# Allowed values for the pipeline-level "lead temperature" tag. ``None``
# (or empty string in the body) clears the tag.
LEAD_TEMPERATURES = {"hot", "keen", "lukewarm"}


@api.patch("/contacts/{contact_id}/temperature")
async def update_contact_temperature(
    contact_id: str,
    body: dict,
    user: dict = Depends(require_role("admin")),
):
    """Persist the pipeline lead-temperature tag (hot / keen / lukewarm) on
    a contact. Pass ``temperature: null`` (or "") to clear. Stored on the
    contact regardless of pipeline membership — the UI hides the control
    outside the pipeline view but we keep the value if they bounce in and
    out of the pipeline."""
    raw = body.get("temperature")
    if raw in (None, ""):
        temperature = None
    else:
        t = str(raw).strip().lower()
        if t not in LEAD_TEMPERATURES:
            raise HTTPException(status_code=400, detail=f"temperature must be one of {sorted(LEAD_TEMPERATURES)} or null")
        temperature = t
    now = datetime.now(timezone.utc).isoformat()
    update = {"temperature": temperature, "temperature_updated_at": now, "temperature_updated_by": user.get("email"), "updated_at": now}
    r = await db.web_form_contacts.update_one({"id": contact_id}, {"$set": update})
    if r.matched_count == 0:
        r = await db.contacts.update_one({"id": contact_id}, {"$set": update})
    if r.matched_count == 0:
        raise HTTPException(status_code=404, detail="Contact not found")
    return {"ok": True, "temperature": temperature, "temperature_updated_at": now}



@api.patch("/contacts/{contact_id}/admin-notes")
async def update_contact_admin_notes(
    contact_id: str,
    body: AdminNotesUpdate,
    user: dict = Depends(require_role("admin")),
):
    """Free-form running notes the admin can keep on any contact (pipeline or
    not). Stored in the new ``admin_notes`` field — kept separate from the
    legacy ``notes`` field which carries copy-over data from the convert flow.
    Empty / whitespace-only strings are stored as ``None``."""
    txt = (body.admin_notes or "").strip() or None
    now = datetime.now(timezone.utc).isoformat()
    update = {
        "admin_notes": txt,
        "admin_notes_updated_at": now,
        "admin_notes_updated_by": user.get("email"),
        "updated_at": now,
    }
    r = await db.web_form_contacts.update_one({"id": contact_id}, {"$set": update})
    if r.matched_count == 0:
        r = await db.contacts.update_one({"id": contact_id}, {"$set": update})
    if r.matched_count == 0:
        raise HTTPException(status_code=404, detail="Contact not found")
    return {
        "ok": True,
        "admin_notes": txt,
        "admin_notes_updated_at": now,
        "admin_notes_updated_by": user.get("email"),
    }


@api.patch("/contacts/{contact_id}/promote")
async def promote_contact(contact_id: str, _: dict = Depends(require_role("admin"))):
    """Move a general contact into the active sales pipeline."""
    now = datetime.now(timezone.utc).isoformat()
    # Try web_form_contacts first (general enquiries from form 1)
    r = await db.web_form_contacts.update_one(
        {"id": contact_id},
        {"$set": {"in_pipeline": True, "pipeline_status": "new", "updated_at": now, "pipeline_status_updated_at": now}},
    )
    if r.matched_count == 0:
        # Legacy contact: copy into web_form_contacts so it shows up in the pipeline
        legacy = await db.contacts.find_one({"id": contact_id}, {"_id": 0})
        if not legacy:
            raise HTTPException(status_code=404, detail="Contact not found")
        legacy["in_pipeline"] = True
        legacy["pipeline_status"] = "new"
        legacy["pipeline_status_updated_at"] = now
        legacy["promoted_from_legacy"] = True
        legacy["updated_at"] = now
        await db.web_form_contacts.insert_one(legacy)
        await db.contacts.delete_one({"id": contact_id})
    return {"ok": True, "in_pipeline": True, "pipeline_status": "new"}


@api.patch("/contacts/{contact_id}/demote")
async def demote_contact(contact_id: str, _: dict = Depends(require_role("admin"))):
    """Remove a contact from the active sales pipeline."""
    now = datetime.now(timezone.utc).isoformat()
    r = await db.web_form_contacts.update_one(
        {"id": contact_id},
        {"$set": {"in_pipeline": False, "pipeline_status": None, "updated_at": now}},
    )
    if r.matched_count == 0:
        raise HTTPException(status_code=404, detail="Contact not found")
    return {"ok": True, "in_pipeline": False}


# ----------------------------------------------------------------------------
# Contact merge — combine two pipeline/CRM contacts (e.g. someone who
# submitted the form twice) into a single record.
#
# Survivor keeps its ``id`` (so any in-flight URL bookmarks still resolve).
# The "loser" is ARCHIVED (not deleted) — flagged with ``merged_into`` so we
# keep the audit trail. Field-merge strategy: prefer the survivor's value
# unless empty, otherwise fall back to the loser's. The frontend uses the
# preview endpoint to render a side-by-side confirmation modal before
# committing.
# ----------------------------------------------------------------------------
class ContactMergeRequest(BaseModel):
    survivor_id: str
    loser_id: str
    field_overrides: Optional[Dict[str, Optional[str]]] = None


# Fields that take part in the auto-pick merge. Anything outside this list
# stays as-is on the survivor (system/audit fields like id, created_at, etc).
MERGE_FIELDS = (
    "first_name", "last_name", "email", "telephone", "mobile", "phone",
    "address_line_1", "address_line_2", "town_city", "city", "county",
    "postcode", "country", "establishment_name", "organisation", "website",
    "potential", "heard_about_us", "referral_source", "comments", "message",
    "why_contacting", "facebook", "google", "instagram", "twitter",
)

# Stage ordering — when survivor and loser have different stages, we keep
# whichever is further along the funnel.
_STAGE_ORDER = {"new": 0, "contacted": 1, "qualified": 2, "demo_booked": 3, "converted": 4, "dormant": 1, "lost": 5}


async def _find_contact(contact_id: str) -> tuple[Optional[dict], Optional[str]]:
    """Return ``(doc, collection_name)`` or ``(None, None)``."""
    doc = await db.web_form_contacts.find_one({"id": contact_id}, {"_id": 0})
    if doc:
        return doc, "web_form_contacts"
    doc = await db.contacts.find_one({"id": contact_id}, {"_id": 0})
    if doc:
        return doc, "contacts"
    return None, None


def _auto_merge_values(survivor: dict, loser: dict) -> dict:
    """For each mergeable field, prefer the survivor's value unless empty
    (None / "" / blank string), then take the loser's value. Returns the
    merged-value dict for ALL mergeable fields (including unchanged ones).
    """
    merged: dict = {}
    for f in MERGE_FIELDS:
        s_val = survivor.get(f)
        l_val = loser.get(f)
        if s_val not in (None, "", []) and str(s_val).strip() != "":
            merged[f] = s_val
        else:
            merged[f] = l_val if l_val not in (None, "", []) and str(l_val).strip() != "" else s_val
    return merged


@api.post("/contacts/merge/preview")
async def preview_contact_merge(
    body: dict,
    _: dict = Depends(require_role("admin")),
):
    """Return both contacts plus the auto-merged values so the frontend can
    render a side-by-side confirmation modal. Does NOT mutate anything."""
    sid = (body.get("survivor_id") or "").strip()
    lid = (body.get("loser_id") or "").strip()
    if not sid or not lid or sid == lid:
        raise HTTPException(400, "Provide two different contact IDs.")
    survivor, _sc = await _find_contact(sid)
    loser, _lc = await _find_contact(lid)
    if not survivor:
        raise HTTPException(404, "Survivor contact not found.")
    if not loser:
        raise HTTPException(404, "Loser contact not found.")
    if survivor.get("merged_into") or loser.get("merged_into"):
        raise HTTPException(409, "One of the contacts has already been merged.")
    return {
        "survivor": survivor,
        "loser": loser,
        "merged": _auto_merge_values(survivor, loser),
        "fields": list(MERGE_FIELDS),
    }


@api.post("/contacts/merge")
async def merge_contacts(
    body: ContactMergeRequest,
    user: dict = Depends(require_role("admin")),
):
    """Commit a merge. The survivor record absorbs the auto-merged field
    values (or per-field overrides if the admin tweaked them in the modal),
    inherits the most-advanced pipeline stage, and gets a stamped admin-note
    entry summarising what was merged in. The loser is archived in-place
    with ``merged_into=<survivor_id>`` and ``in_pipeline=False`` so it
    disappears from kanban/list views but stays in the DB for audit."""
    if body.survivor_id == body.loser_id:
        raise HTTPException(400, "Cannot merge a contact with itself.")
    survivor, s_coll = await _find_contact(body.survivor_id)
    loser, l_coll = await _find_contact(body.loser_id)
    if not survivor or not loser:
        raise HTTPException(404, "One or both contacts not found.")
    if survivor.get("merged_into") or loser.get("merged_into"):
        raise HTTPException(409, "One of the contacts has already been merged.")

    # Resolve final values — auto-merge first, then layer admin overrides.
    final = _auto_merge_values(survivor, loser)
    if body.field_overrides:
        for k, v in body.field_overrides.items():
            if k in MERGE_FIELDS:
                final[k] = v if (v or "").strip() else None  # type: ignore[union-attr]

    # Most-advanced pipeline stage wins (in_pipeline stays True if either was
    # in pipeline and survivor isn't already converted).
    s_status = survivor.get("pipeline_status") or "new"
    l_status = loser.get("pipeline_status") or "new"
    chosen_status = s_status if _STAGE_ORDER.get(s_status, 0) >= _STAGE_ORDER.get(l_status, 0) else l_status
    in_pipeline = bool((survivor.get("in_pipeline") or loser.get("in_pipeline")) and not survivor.get("converted_to_franchisee_id"))

    now_iso = datetime.now(timezone.utc).isoformat()

    # Build the audit-trail note prepended to admin_notes.
    loser_name = " ".join(filter(None, [loser.get("first_name"), loser.get("last_name")])).strip() or loser.get("email") or "(no name)"
    loser_email = loser.get("email") or "—"
    loser_date = str(loser.get("date") or loser.get("created_at") or "")[:10]
    audit_lines = [
        f"— Merged from {loser_name} ({loser_email}) on {datetime.now(timezone.utc).strftime('%d/%m/%Y')} by {user.get('email')} —",
    ]
    if loser_date:
        audit_lines.append(f"Original enquiry date: {loser_date}")
    if loser.get("message"):
        audit_lines.append(f"Their message:\n{loser['message']}")
    if loser.get("comments"):
        audit_lines.append(f"Their comments:\n{loser['comments']}")
    if loser.get("why_contacting"):
        audit_lines.append(f"Their reason for contacting: {loser['why_contacting']}")
    if loser.get("admin_notes"):
        audit_lines.append(f"Their admin notes:\n{loser['admin_notes']}")
    audit_note = "\n".join(audit_lines).strip()
    existing_notes = (survivor.get("admin_notes") or "").strip()
    new_admin_notes = f"{audit_note}\n\n{existing_notes}".strip() if existing_notes else audit_note

    # Stamp the merged-from history list (so a survivor that's been merged
    # multiple times keeps a full trail).
    merged_history = list(survivor.get("merged_from_history") or [])
    merged_history.append({
        "loser_id": loser["id"],
        "loser_name": loser_name,
        "loser_email": loser.get("email"),
        "loser_source": loser.get("source"),
        "loser_gravity_entry_id": loser.get("gravity_entry_id"),
        "merged_at": now_iso,
        "merged_by": user.get("email"),
    })

    survivor_update = {
        **final,
        "pipeline_status": chosen_status if in_pipeline else None,
        "in_pipeline": in_pipeline,
        "admin_notes": new_admin_notes,
        "admin_notes_updated_at": now_iso,
        "admin_notes_updated_by": user.get("email"),
        "merged_from_history": merged_history,
        "updated_at": now_iso,
    }
    survivor_coll = db.web_form_contacts if s_coll == "web_form_contacts" else db.contacts
    await survivor_coll.update_one({"id": body.survivor_id}, {"$set": survivor_update})

    # Archive the loser (kept in DB for audit).
    loser_coll = db.web_form_contacts if l_coll == "web_form_contacts" else db.contacts
    await loser_coll.update_one(
        {"id": body.loser_id},
        {"$set": {
            "merged_into": body.survivor_id,
            "merged_at": now_iso,
            "merged_by": user.get("email"),
            "in_pipeline": False,
            "pipeline_status": None,
            "updated_at": now_iso,
        }},
    )

    fresh = await survivor_coll.find_one({"id": body.survivor_id}, {"_id": 0})
    return {
        "ok": True,
        "survivor_id": body.survivor_id,
        "loser_id": body.loser_id,
        "survivor": fresh,
    }


@api.delete("/contacts/{contact_id}")
async def delete_contact(contact_id: str, user: dict = Depends(require_role("admin"))):
    """Permanently delete a contact from either collection.

    If the contact originated from a Gravity Forms submission, also writes a
    tombstone row to ``gf_deleted_entries`` so the hourly backfill (and the
    live webhook) skip re-creating it on the next cycle.
    """
    # Capture the source entry id BEFORE deleting so we can tombstone it.
    existing = await db.web_form_contacts.find_one(
        {"id": contact_id},
        {"_id": 0, "gravity_entry_id": 1, "form_id": 1, "email": 1,
         "first_name": 1, "last_name": 1},
    )
    r = await db.web_form_contacts.delete_one({"id": contact_id})
    if r.deleted_count == 0:
        r = await db.contacts.delete_one({"id": contact_id})
    if r.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Contact not found")

    if existing and existing.get("gravity_entry_id"):
        try:
            await db.gf_deleted_entries.update_one(
                {"gravity_entry_id": str(existing["gravity_entry_id"])},
                {"$set": {
                    "gravity_entry_id": str(existing["gravity_entry_id"]),
                    "form_id": existing.get("form_id"),
                    "email": existing.get("email"),
                    "name": f"{existing.get('first_name') or ''} {existing.get('last_name') or ''}".strip() or None,
                    "deleted_at": datetime.now(timezone.utc).isoformat(),
                    "deleted_by": user.get("email"),
                }},
                upsert=True,
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("Failed to tombstone gravity_entry_id=%s: %s",
                           existing.get("gravity_entry_id"), exc)
    return {"ok": True}


# ----------------------------------------------------------------------------
# Contact Move (flexible between tabs + bulk move)
# ----------------------------------------------------------------------------
MOVE_TARGETS = ("pipeline", "franchise", "licence", "general", "remove_from_pipeline")


class ContactMoveRequest(BaseModel):
    target: str  # "pipeline" | "franchise" | "licence" | "general"
    pipeline_status: Optional[str] = None  # only used when target == "pipeline"


class ContactBulkMoveRequest(BaseModel):
    ids: List[str]
    target: str
    pipeline_status: Optional[str] = None


async def _move_one_contact(contact_id: str, target: str, pipeline_status: Optional[str]) -> Optional[str]:
    """Move a single contact to one of: pipeline / franchise / general.
    Legacy `contacts` records get migrated into `web_form_contacts` when moved to
    pipeline or franchise so they share the same data model.
    Returns the resulting collection name, or None if not found."""
    now = datetime.now(timezone.utc).isoformat()

    if target == "pipeline":
        stage = pipeline_status if pipeline_status in PIPELINE_STAGES else "new"
        # Stamp pipeline_status_updated_at so Kanban columns can sort
        # freshly-moved cards to the top.
        pipeline_patch = {
            "in_pipeline": True,
            "pipeline_status": stage,
            "updated_at": now,
            "pipeline_status_updated_at": now,
        }
        # web_form_contacts: just flip flags
        r = await db.web_form_contacts.update_one(
            {"id": contact_id},
            {"$set": pipeline_patch},
        )
        if r.matched_count:
            return "web_form_contacts"
        # legacy: migrate over
        legacy = await db.contacts.find_one({"id": contact_id}, {"_id": 0})
        if not legacy:
            return None
        legacy.update({
            "in_pipeline": True,
            "pipeline_status": stage,
            "pipeline_status_updated_at": now,
            "promoted_from_legacy": True,
            "source": legacy.get("source") or "legacy_general_enquiry",
            "updated_at": now,
        })
        await db.web_form_contacts.insert_one(legacy)
        await db.contacts.delete_one({"id": contact_id})
        return "web_form_contacts"

    if target in ("franchise", "licence"):
        target_source = "licence_enquiry" if target == "licence" else "franchise_enquiry"
        # Retag the contact's TYPE while preserving any active pipeline state
        # (in_pipeline + pipeline_status). Re-categorisation is now an
        # independent action from pipeline membership.
        existing = await db.web_form_contacts.find_one({"id": contact_id}, {"_id": 0})
        if existing:
            await db.web_form_contacts.update_one(
                {"id": contact_id},
                {"$set": {"source": target_source, "updated_at": now}},
            )
            return "web_form_contacts"
        legacy = await db.contacts.find_one({"id": contact_id}, {"_id": 0})
        if not legacy:
            return None
        legacy.update({
            "source": target_source,
            "promoted_from_legacy": True,
            "updated_at": now,
        })
        # Preserve any pipeline flags already on the legacy row
        legacy.setdefault("in_pipeline", False)
        await db.web_form_contacts.insert_one(legacy)
        await db.contacts.delete_one({"id": contact_id})
        return "web_form_contacts"

    if target == "general":
        # Retag to general_enquiry — also preserves pipeline state.
        r = await db.web_form_contacts.update_one(
            {"id": contact_id},
            {"$set": {"source": "general_enquiry", "updated_at": now}},
        )
        if r.matched_count:
            return "web_form_contacts"
        # legacy stays in contacts collection — just touch updated_at
        r = await db.contacts.update_one(
            {"id": contact_id},
            {"$set": {"updated_at": now}},
        )
        if r.matched_count:
            return "contacts"
        return None

    if target == "remove_from_pipeline":
        # Explicit pipeline-only action: drop the contact out of the pipeline
        # but keep their source/type unchanged.
        r = await db.web_form_contacts.update_one(
            {"id": contact_id},
            {"$set": {"in_pipeline": False, "pipeline_status": None, "updated_at": now}},
        )
        if r.matched_count:
            return "web_form_contacts"
        r = await db.contacts.update_one(
            {"id": contact_id},
            {"$set": {"in_pipeline": False, "pipeline_status": None, "updated_at": now}},
        )
        if r.matched_count:
            return "contacts"
        return None

    return None


@api.post("/contacts/{contact_id}/move")
async def move_contact(contact_id: str, body: ContactMoveRequest, _: dict = Depends(require_role("admin"))):
    if body.target not in MOVE_TARGETS:
        raise HTTPException(status_code=400, detail=f"target must be one of {MOVE_TARGETS}")
    if body.target == "pipeline" and body.pipeline_status and body.pipeline_status not in PIPELINE_STAGES:
        raise HTTPException(status_code=400, detail=f"pipeline_status must be one of {PIPELINE_STAGES}")
    coll = await _move_one_contact(contact_id, body.target, body.pipeline_status)
    if not coll:
        raise HTTPException(status_code=404, detail="Contact not found")
    return {"ok": True, "target": body.target, "collection": coll}


@api.post("/contacts/bulk-delete")
async def bulk_delete_contacts(
    body: dict, user: dict = Depends(require_role("admin")),
):
    """Permanently delete a batch of contacts and tombstone their
    Gravity Forms entries so the hourly backfill never re-imports them.

    Mirrors the single-delete behaviour but in one round-trip — used by
    the kanban's "Delete selected" action when an admin wants to clear
    out a column of unwanted duplicates in one go.
    """
    ids = body.get("ids") or []
    if not ids:
        return {"ok": True, "deleted": 0, "tombstoned": 0}
    # Pull gravity_entry_id metadata first — needed for tombstones.
    rows = await db.web_form_contacts.find(
        {"id": {"$in": ids}},
        {"_id": 0, "id": 1, "gravity_entry_id": 1, "form_id": 1,
         "email": 1, "first_name": 1, "last_name": 1},
    ).to_list(len(ids))
    tomb_docs = [{
        "gravity_entry_id": str(r["gravity_entry_id"]),
        "form_id": r.get("form_id"),
        "email": r.get("email"),
        "name": f"{r.get('first_name') or ''} {r.get('last_name') or ''}".strip() or None,
        "deleted_at": datetime.now(timezone.utc).isoformat(),
        "deleted_by": user.get("email"),
        "reason": "bulk_delete",
    } for r in rows if r.get("gravity_entry_id")]
    if tomb_docs:
        from pymongo import UpdateOne
        await db.gf_deleted_entries.bulk_write(
            [UpdateOne(
                {"gravity_entry_id": d["gravity_entry_id"]},
                {"$set": d}, upsert=True,
            ) for d in tomb_docs],
            ordered=False,
        )
    res1 = await db.web_form_contacts.delete_many({"id": {"$in": ids}})
    res2 = await db.contacts.delete_many({"id": {"$in": ids}})
    return {
        "ok": True,
        "deleted": res1.deleted_count + res2.deleted_count,
        "tombstoned": len(tomb_docs),
    }


@api.post("/contacts/bulk-move")
async def bulk_move_contacts(body: ContactBulkMoveRequest, _: dict = Depends(require_role("admin"))):
    if body.target not in MOVE_TARGETS:
        raise HTTPException(status_code=400, detail=f"target must be one of {MOVE_TARGETS}")
    if body.target == "pipeline" and body.pipeline_status and body.pipeline_status not in PIPELINE_STAGES:
        raise HTTPException(status_code=400, detail=f"pipeline_status must be one of {PIPELINE_STAGES}")
    if not body.ids:
        return {"ok": True, "moved": 0, "not_found": 0}

    # Fast path — for the common "move N rows already in web_form_contacts
    # to a new pipeline state / source" case we do ONE Mongo
    # ``update_many`` instead of looping per-id. The previous loop was
    # ~50ms per row → unworkable at thousand-id scale (ingress timeout
    # after 30s). With ``update_many`` even 10k IDs complete in <1s.
    now = datetime.now(timezone.utc).isoformat()
    moved = 0
    not_found = 0

    if body.target == "pipeline":
        stage = body.pipeline_status if body.pipeline_status in PIPELINE_STAGES else "new"
        patch = {
            "in_pipeline": True,
            "pipeline_status": stage,
            "updated_at": now,
            "pipeline_status_updated_at": now,
        }
        res = await db.web_form_contacts.update_many({"id": {"$in": body.ids}}, {"$set": patch})
        moved = res.matched_count
    elif body.target in ("franchise", "licence"):
        target_source = "licence_enquiry" if body.target == "licence" else "franchise_enquiry"
        res = await db.web_form_contacts.update_many(
            {"id": {"$in": body.ids}},
            {"$set": {"source": target_source, "updated_at": now}},
        )
        moved = res.matched_count
    elif body.target == "general":
        res = await db.web_form_contacts.update_many(
            {"id": {"$in": body.ids}},
            {"$set": {"source": "general_enquiry", "updated_at": now}},
        )
        moved = res.matched_count
    elif body.target == "remove_from_pipeline":
        res = await db.web_form_contacts.update_many(
            {"id": {"$in": body.ids}},
            {"$set": {"in_pipeline": False, "pipeline_status": None, "updated_at": now}},
        )
        moved = res.matched_count

    # Any leftover IDs are either (a) legacy ``contacts`` rows that need
    # the per-id migration path or (b) actual not-found. Loop those to
    # preserve the original semantics — there's never many of these so
    # the residual loop stays fast.
    remaining = body.ids if moved == 0 else None
    if moved < len(body.ids):
        already_moved = await db.web_form_contacts.find(
            {"id": {"$in": body.ids}}, {"_id": 0, "id": 1},
        ).to_list(len(body.ids))
        moved_ids = {r["id"] for r in already_moved}
        remaining = [cid for cid in body.ids if cid not in moved_ids]
    for cid in (remaining or []):
        coll = await _move_one_contact(cid, body.target, body.pipeline_status)
        if coll:
            moved += 1
        else:
            not_found += 1
    return {"ok": True, "moved": moved, "not_found": not_found}


@api.post("/contacts/dedupe-pipeline")
async def dedupe_pipeline_contacts(
    dry_run: bool = Query(False, description="If true, report duplicates without deleting"),
    _: dict = Depends(require_role("admin")),
):
    """Remove "re-ingested" duplicates from the active Sales Pipeline.

    Background: when a prospect submits the same Gravity Form again
    (e.g. ``Licence Enquiry``), the backfill creates a brand-new
    ``web_form_contacts`` row with ``pipeline_status="new"``. Any
    older record the team already triaged into "contacted" / "replied"
    / "closed" then competes with the fresh duplicate in the kanban —
    same person appears in two columns, the team loses track.

    Strategy (safe by default):
    1. Group all in-pipeline rows by ``(email, source)``.
    2. For groups containing more than one record AND at least one
       non-"new" status, delete the "new" duplicates (they're the
       newly-arrived submissions the team hasn't seen yet — the
       prospect's earlier engagement state is the source of truth).
    3. For groups where every record is "new" (no triage yet), keep
       the EARLIEST one and delete the rest — they're literally the
       same form submitted twice in close succession.

    ``dry_run`` reports what *would* happen without mutating anything.
    """
    pipeline_cur = db.web_form_contacts.aggregate([
        {"$match": {"in_pipeline": True}},
        {"$group": {
            "_id": {
                "email": {"$toLower": {"$ifNull": ["$email", ""]}},
                "source": "$source",
            },
            "rows": {"$push": {
                "id": "$id",
                "pipeline_status": "$pipeline_status",
                "created_at": "$created_at",
                "date": "$date",
                "full_name": {"$concat": [
                    {"$ifNull": ["$first_name", ""]}, " ",
                    {"$ifNull": ["$last_name", ""]},
                ]},
            }},
            "count": {"$sum": 1},
        }},
        {"$match": {"count": {"$gt": 1}}},
    ])
    to_delete: list[dict] = []
    async for grp in pipeline_cur:
        email = grp["_id"]["email"]
        if not email:
            # Don't dedupe rows with no email — that's not a reliable
            # identity signal and we risk wiping the wrong record.
            continue
        rows = grp["rows"]
        statuses = {r.get("pipeline_status") for r in rows}
        if statuses - {"new"}:
            # At least one record already triaged → kill the "new" dups.
            for r in rows:
                if r.get("pipeline_status") == "new":
                    to_delete.append({"id": r["id"], "email": email,
                                      "reason": "duplicate_of_triaged",
                                      "name": (r.get("full_name") or "").strip()})
        else:
            # All copies still "new" — keep the earliest by
            # ``created_at`` (fall back to ``date`` string).
            def _sort_key(r):
                ca = r.get("created_at")
                # Mongo stores some as datetime, others as ISO string —
                # normalise to a comparable string.
                if isinstance(ca, datetime):
                    return ca.isoformat()
                return ca or r.get("date") or ""
            ordered = sorted(rows, key=_sort_key)
            for r in ordered[1:]:
                to_delete.append({"id": r["id"], "email": email,
                                  "reason": "duplicate_new_submission",
                                  "name": (r.get("full_name") or "").strip()})

    if dry_run:
        return {
            "dry_run": True,
            "would_remove": len(to_delete),
            "samples": to_delete[:20],
        }

    removed = 0
    tombstones_added = 0
    if to_delete:
        ids = [d["id"] for d in to_delete]
        # Capture gravity_entry_ids BEFORE deletion so we can tombstone
        # them — otherwise the periodic Gravity Forms backfill would
        # silently re-insert the same duplicates on its next run (the
        # `gf_deleted_entries` collection is its source of truth for
        # "never bring this back").
        rows_to_kill = await db.web_form_contacts.find(
            {"id": {"$in": ids}, "gravity_entry_id": {"$ne": None}},
            {"_id": 0, "gravity_entry_id": 1, "email": 1},
        ).to_list(len(ids))
        now_iso = datetime.now(timezone.utc).isoformat()
        tombs = [{
            "gravity_entry_id": r["gravity_entry_id"],
            "email": r.get("email"),
            "deleted_at": now_iso,
            "reason": "dedupe_pipeline",
        } for r in rows_to_kill if r.get("gravity_entry_id")]
        if tombs:
            await db.gf_deleted_entries.insert_many(tombs, ordered=False)
            tombstones_added = len(tombs)
        res = await db.web_form_contacts.delete_many({"id": {"$in": ids}})
        removed = res.deleted_count
    return {
        "dry_run": False,
        "removed": removed,
        "tombstones_added": tombstones_added,
        "samples": to_delete[:20],
    }


# ----------------------------------------------------------------------------
# CRM — Territories
# ----------------------------------------------------------------------------
@api.get("/territories")
async def list_territories(franchisee_id: Optional[str] = None, _: dict = Depends(require_role("admin"))):
    q = {}
    if franchisee_id:
        q["franchisee_id"] = franchisee_id
    items = await db.territories.find(q, {"_id": 0}).to_list(5000)
    return {"items": items, "total": len(items)}


# ----------------------------------------------------------------------------
# Anniversary Reminders (Phase 1 scaffold)
# ----------------------------------------------------------------------------
@api.get("/anniversaries/today")
async def anniversaries_today(
    upcoming_days: int = Query(0, ge=0, le=60, description="Also include anniversaries falling in the next N days"),
    _: dict = Depends(require_role("admin")),
):
    """Returns contracts whose anniversary falls today, optionally extended
    with the next `upcoming_days` calendar days. The dashboard panel uses
    `upcoming_days=14` to fill its full-width strip with two weeks ahead.

    Deduplicates by franchisee — a franchisee with multiple contract rows
    (renewal, extension, etc.) sharing the same anniversary mm-dd would
    otherwise show up once per contract. We keep the row with the
    EARLIEST ``anniversary_reminder`` year so the "X years today" badge
    reflects the original franchise start, not a recent renewal."""
    now = datetime.now(timezone.utc)
    today = now.date()
    contracts = await db.contracts.find(
        {"anniversary_reminder": {"$exists": True, "$ne": None}, "cancelled_early": {"$ne": True}},
        {"_id": 0},
    ).to_list(2000)
    out = []
    for c in contracts:
        anniv = c.get("anniversary_reminder")
        if not anniv:
            continue
        try:
            anniv_str = str(anniv)
            year_part = anniv_str[0:4]
            mmdd = anniv_str[5:10]  # "MM-DD"
            month, day = int(mmdd[:2]), int(mmdd[3:5])
            anniv_year = int(year_part) if year_part.isdigit() else None
            # Find the next occurrence ≥ today (this year or next)
            try:
                this_year = today.replace(month=month, day=day)
            except ValueError:
                # 29 Feb in non-leap year
                this_year = today.replace(month=month, day=28)
            next_anniv = this_year if this_year >= today else this_year.replace(year=today.year + 1)
            days_until = (next_anniv - today).days
            if days_until > upcoming_days:
                continue
            f = await db.franchisees.find_one(
                {"id": c.get("franchisee_id")},
                {"_id": 0, "first_name": 1, "last_name": 1, "organisation": 1,
                 "mojo_email": 1, "id": 1, "lifecycle_status": 1, "tags": 1},
            )
            if not f:
                continue
            if f.get("lifecycle_status") == "ex_franchisee":
                continue
            if "Franchisee" not in (f.get("tags") or []):
                continue
            f.pop("lifecycle_status", None)
            f.pop("tags", None)
            # Number of years this anniversary represents (next_anniv year
            # minus the franchise start year). When the start year is
            # unknown we just omit it.
            years = (next_anniv.year - anniv_year) if anniv_year else None
            out.append({
                "contract": c,
                "franchisee": f,
                "anniversary_date": next_anniv.isoformat(),
                "anniversary_year": anniv_year,
                "years": years,
                "days_until": days_until,
            })
        except Exception:
            continue

    # Dedupe by franchisee_id — keep the entry with the earliest
    # ``anniversary_year`` (original franchise start). Falls back to the
    # latest start if the year is missing on every row.
    by_franchisee: dict[str, dict] = {}
    for entry in out:
        fid = (entry.get("franchisee") or {}).get("id")
        if not fid:
            continue
        prev = by_franchisee.get(fid)
        if (prev is None
            or ((entry.get("anniversary_year") or 9999) < (prev.get("anniversary_year") or 9999))):
            by_franchisee[fid] = entry
    out = list(by_franchisee.values())
    out.sort(key=lambda x: x["days_until"])

    # Hydrate ``email_sent`` for today's entries so the UI can show
    # "Sent ✓" instead of the Send button on a second visit. We key the
    # log row by (franchisee_id, anniversary_year_being_celebrated).
    sent_keys = set()
    today_iso = today.isoformat()
    if out:
        sent_rows = await db.anniversary_emails_sent.find(
            {"anniversary_date": today_iso},
            {"_id": 0, "franchisee_id": 1, "anniversary_date": 1},
        ).to_list(1000)
        sent_keys = {r.get("franchisee_id") for r in sent_rows if r.get("franchisee_id")}
    for entry in out:
        fid = (entry.get("franchisee") or {}).get("id")
        entry["email_sent"] = bool(entry["days_until"] == 0 and fid in sent_keys)

    today_count = sum(1 for x in out if x["days_until"] == 0)
    today_pending_email = sum(1 for x in out if x["days_until"] == 0 and not x["email_sent"])
    return {
        "today": today.strftime("%m-%d"),
        "count": today_count,
        "today_pending_email_count": today_pending_email,
        "upcoming_count": len(out),
        "anniversaries": out,
    }


@api.post("/anniversaries/{franchisee_id}/send-email")
async def send_anniversary_email(
    franchisee_id: str,
    actor: dict = Depends(require_role("admin")),
):
    """Send the "Happy Mojo anniversary" email to a specific franchisee
    today. Idempotent — re-sending the same day for the same franchisee
    is rejected so accidental double-clicks don't fire two messages.
    Records the send in ``anniversary_emails_sent`` so the dashboard
    Send button flips to "Sent ✓" and the nav-bar reminder badge
    decrements without a refresh dance."""
    today = datetime.now(timezone.utc).date()
    today_iso = today.isoformat()

    # Idempotency check.
    existing = await db.anniversary_emails_sent.find_one(
        {"franchisee_id": franchisee_id, "anniversary_date": today_iso},
        {"_id": 0},
    )
    if existing:
        raise HTTPException(409, detail="Anniversary email already sent today for this franchisee.")

    franchisee = await db.franchisees.find_one(
        {"id": franchisee_id},
        {"_id": 0, "first_name": 1, "last_name": 1, "organisation": 1, "mojo_email": 1, "id": 1},
    )
    if not franchisee:
        raise HTTPException(404, detail="Franchisee not found.")
    to_email = franchisee.get("mojo_email")
    if not to_email:
        raise HTTPException(400, detail="Franchisee has no email address on file.")

    # Compute years — pull the earliest anniversary_reminder row for this
    # franchisee, the same way the listing endpoint does.
    contracts = await db.contracts.find(
        {"franchisee_id": franchisee_id, "anniversary_reminder": {"$exists": True, "$ne": None},
         "cancelled_early": {"$ne": True}},
        {"_id": 0, "anniversary_reminder": 1},
    ).to_list(100)
    earliest_year = None
    for c in contracts:
        raw = str(c.get("anniversary_reminder") or "")
        if not raw[:4].isdigit():
            continue
        y = int(raw[:4])
        if earliest_year is None or y < earliest_year:
            earliest_year = y
    years = (today.year - earliest_year) if earliest_year else None

    fname = (franchisee.get("first_name") or "").strip() or (franchisee.get("organisation") or "").strip() or "there"
    years_phrase = f"{years} years today" if years else "today"

    body_html = (
        f"<p>Hi {fname},</p>"
        f"<p>Just thought we'd send out an email to say happy Mojo anniversary, {years_phrase}!</p>"
        f"<p>Thanks,<br>Sandra &amp; Paul</p>"
    )
    body_text = (
        f"Hi {fname},\n\n"
        f"Just thought we'd send out an email to say happy Mojo anniversary, {years_phrase}!\n\n"
        f"Thanks,\nSandra & Paul"
    )

    # Send via Resend.
    try:
        from resend_routes import RESEND_API_KEY, RESEND_FROM_EMAIL, RESEND_FROM_NAME
        if not RESEND_API_KEY:
            raise RuntimeError("Resend API key not configured.")
        import resend as _resend
        _resend.api_key = RESEND_API_KEY
        result = _resend.Emails.send({
            "from": f"{RESEND_FROM_NAME} <{RESEND_FROM_EMAIL}>",
            "to": [to_email],
            "bcc": ["sandra@creativemojo.co.uk", "paul@creativemojo.co.uk"],
            "subject": f"Happy Mojo anniversary{f' — {years} years!' if years else ''}",
            "html": body_html,
            "text": body_text,
            "tags": [{"name": "kind", "value": "anniversary"}],
        })
        message_id = (result or {}).get("id") if isinstance(result, dict) else None
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        logger.exception("Anniversary email send failed: %s", exc)
        raise HTTPException(502, detail=f"Email send failed: {exc}")

    # Record the send for idempotency + dashboard state.
    await db.anniversary_emails_sent.insert_one({
        "id": str(uuid.uuid4()),
        "franchisee_id": franchisee_id,
        "anniversary_date": today_iso,
        "years": years,
        "to_email": to_email,
        "sent_at": datetime.now(timezone.utc).isoformat(),
        "sent_by": actor.get("email"),
        "resend_id": message_id,
    })
    return {"ok": True, "years": years, "to_email": to_email}


@api.get("/health")
async def health():
    return {"ok": True}


# Build version stamp — set on module import. Every container restart
# produces a new value, so the frontend can poll this endpoint to
# detect when a fresh deploy is live and prompt the franchisee to
# refresh. We use the process start timestamp (ms) as the version;
# good enough since two deploys can't share the same millisecond.
import time as _time_for_version

BUILD_VERSION = str(int(_time_for_version.time() * 1000))


@api.get("/version")
async def get_version():
    """Returns the current backend build identifier. Public — every
    portal page polls this so we don't add an auth dependency."""
    return {"version": BUILD_VERSION, "started_at": BUILD_VERSION}


@api.get("/system/info")
async def get_system_info():
    """Lightweight env probe consumed by the EnvBanner footer pill on
    the frontend. Returns the backend boot timestamp so a fresh
    "last deploy" indicator can be derived without needing CI metadata.
    Public on purpose — every page mounts the banner."""
    return {
        "started_at": getattr(app.state, "started_at", None),
        "version": BUILD_VERSION,
    }


# ----------------------------------------------------------------------------
# Startup: seed admin + indexes
# ----------------------------------------------------------------------------
@app.on_event("startup")
async def on_startup():
    # Capture server boot time so /api/system/info can surface a
    # "last-deploy" timestamp on the frontend env banner.
    app.state.started_at = datetime.now(timezone.utc).isoformat()
    await db.users.create_index("email", unique=True)
    await db.users.create_index("id", unique=True)
    await db.login_attempts.create_index("identifier")
    await db.gf_form_configs.create_index("form_id", unique=True)

    # Seed the GF intake form configs from the static module on first
    # boot so the new DB-backed admin UI starts populated. Idempotent.
    try:
        from gf_form_config_db import seed_if_empty as _seed_gf_configs
        seeded = await _seed_gf_configs(db)
        if seeded:
            logger.info("Seeded %s gf_form_configs entries", seeded)
    except Exception as exc:  # noqa: BLE001
        logger.warning("gf_form_configs seed skipped: %s", exc)

    admin_email = os.environ.get("ADMIN_EMAIL", "admin@creativemojo.co.uk").lower()
    admin_password = os.environ.get("ADMIN_PASSWORD", "admin123")
    admin_name = os.environ.get("ADMIN_NAME", "Admin")
    existing = await db.users.find_one({"email": admin_email})
    if not existing:
        await db.users.insert_one({
            "id": str(uuid.uuid4()),
            "email": admin_email,
            "name": admin_name,
            "role": "admin",
            "password_hash": hash_password(admin_password),
            "created_at": datetime.now(timezone.utc).isoformat(),
        })
        logger.info(f"Seeded admin user: {admin_email}")
    elif not verify_password(admin_password, existing.get("password_hash", "")):
        await db.users.update_one(
            {"email": admin_email},
            {"$set": {"password_hash": hash_password(admin_password), "name": admin_name, "role": "admin"}},
        )
        logger.info(f"Updated admin password for {admin_email}")

    # Backfill in_pipeline flag on existing web_form_contacts
    # Franchise (17) + Licence (32) → in_pipeline = True (sales pipeline)
    # General (1) and others → in_pipeline = False (just contacts)
    try:
        # Franchise + licence enquiries → in pipeline
        await db.web_form_contacts.update_many(
            {"$or": [{"form_id": {"$in": [17, 32]}}, {"source": {"$in": ["franchise_enquiry", "licence_enquiry"]}}], "in_pipeline": {"$exists": False}},
            {"$set": {"in_pipeline": True}},
        )
        # General enquiries → not in pipeline
        await db.web_form_contacts.update_many(
            {"$or": [{"form_id": 1}, {"source": "general_enquiry"}], "in_pipeline": {"$exists": False}},
            {"$set": {"in_pipeline": False, "pipeline_status": None}},
        )
        # Pre-migration records (from Airtable web_form_contacts) — default to in_pipeline=True
        # because they came from the existing franchise enquiry form historically
        await db.web_form_contacts.update_many(
            {"in_pipeline": {"$exists": False}},
            {"$set": {"in_pipeline": True}},
        )
        logger.info("Backfilled in_pipeline flag on contacts")
    except Exception as e:
        logger.warning(f"in_pipeline backfill failed: {e}")
    # Airtable seed of migration_table_decisions removed 2026-05-19
    # (Airtable decommissioned — see comment block elsewhere in this file.)

    # Kick off the GF backfill loop in the background — 10-min safety
    # net so missed webhook submissions (and spam-quarantined entries we
    # now rescue) get reconciled automatically.
    try:
        asyncio.create_task(_gf_backfill_loop(db, every_seconds=600))
        logger.info("GF backfill scheduler started (every 10 minutes)")
    except Exception as e:
        logger.warning(f"Could not start GF backfill scheduler: {e}")

    # Phase 2 — Woo orders hourly re-sync safety net (only fires if creds set).
    try:
        from woocommerce_integration import schedule_periodic as _woo_loop
        asyncio.create_task(_woo_loop(db, every_seconds=3600))
        logger.info("Woo orders resync scheduler started (hourly)")
    except Exception as e:
        logger.warning(f"Could not start Woo resync scheduler: {e}")

    # Phase 2 — Monthly subscription drafts (08:00 Europe/London on the 1st).
    try:
        from subscriptions_routes import schedule_subscriptions_loop
        asyncio.create_task(schedule_subscriptions_loop(db, every_seconds=3600))
        logger.info("Monthly subscriptions scheduler started (hourly check)")
    except Exception as e:
        logger.warning(f"Could not start subscriptions scheduler: {e}")


@app.on_event("shutdown")
async def on_shutdown():
    client.close()


# ----------------------------------------------------------------------------
# Wire up
# ----------------------------------------------------------------------------
# Phase 1.5 — GoCardless live mandate integration
from gocardless_integration import build_router as build_gocardless_router  # noqa: E402
api.include_router(build_gocardless_router(db, require_role))

# Phase 2 — Stage C: Xero accounting integration (OAuth + draft invoices + payment webhook)
# Mount BEFORE woocommerce_integration so xero's more-specific /orders/* routes
# (reconciliation, auto-match-xero, link-xero-contact) win over the Woo
# catch-all /orders/{order_id}.
import xero_integration  # noqa: E402
xero_integration.attach(api, db, require_role)

# Phase 2 — Monthly subscription drafts (customer-level recurring order seeds)
# MOUNT BEFORE woocommerce_integration so the more-specific /orders/subscriptions*
# routes win over Woo's catch-all /orders/{order_id}.
import subscriptions_routes  # noqa: E402
subscriptions_routes.attach(api, db, require_role)

# Phase 6 — Announcements / "Updates" e-shot system
import announcements_routes  # noqa: E402
announcements_routes.attach(api, db, require_role)

import youtube_routes  # noqa: E402
youtube_routes.attach(api, db, require_role)
import territory_plus_routes  # noqa: E402
territory_plus_routes.attach(api, db, require_role)

import portal_marketing_routes  # noqa: E402
portal_marketing_routes.attach(api, db, require_role)

import shape_orders_routes  # noqa: E402
shape_orders_routes.attach(api, db, require_role)


@app.on_event("startup")
async def _heal_legacy_shape_statuses():
    # Idempotent boot-time repair for shape orders that were created
    # before the status fix went in — without this they only show up
    # under the FRANCHISEE tab, never under ACTIVE. Safe to run every
    # restart because it only writes when there's drift.
    try:
        await shape_orders_routes.heal_legacy_shape_statuses(db)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Shape order status heal failed (non-fatal): %s", exc)

# Phase 2 — WooCommerce live sync (Stage A: read-only orders + product mirror)
import woocommerce_integration  # noqa: E402
woocommerce_integration.attach(api, db, require_role)

# Phase 3 — FileCamp → R2 migration + admin file browser
from filecamp_migration import build_router as build_migration_router  # noqa: E402
from files_routes import build_router as build_files_router  # noqa: E402
from portal_routes import build_portal_router  # noqa: E402
from territory_routes import build_territory_router  # noqa: E402
from cqc_routes import build_cqc_router  # noqa: E402
from scotland_routes import build_scotland_router  # noqa: E402
from ni_routes import build_ni_router  # noqa: E402
from wales_routes import build_wales_router  # noqa: E402
from project_codes_routes import build_project_codes_router  # noqa: E402
from help_routes import build_help_router  # noqa: E402
from email_templates_routes import build_email_templates_router  # noqa: E402
from resend_routes import build_resend_router  # noqa: E402
api.include_router(build_migration_router(db, require_role))
api.include_router(build_files_router(db, require_role))
api.include_router(build_portal_router(
    db, hash_password, verify_password, create_access_token,
    create_refresh_token, set_auth_cookies,
    check_lockout, record_failure, clear_failures, user_to_public,
))
api.include_router(build_territory_router(db, require_role))
api.include_router(build_cqc_router(db, require_role))
api.include_router(build_scotland_router(db, require_role))
api.include_router(build_ni_router(db, require_role))
api.include_router(build_wales_router(db, require_role))
api.include_router(build_project_codes_router(db, require_role))
api.include_router(build_help_router(db, require_role))
api.include_router(build_email_templates_router(db, require_role))
api.include_router(build_resend_router(db, require_role))

# Invoices module — merged from the standalone Pay-Paperwork app
from invoices_routes import build_invoices_router  # noqa: E402
from franchisee_invoices_routes import build_franchisee_invoices_router  # noqa: E402
api.include_router(build_invoices_router(db, require_role))
api.include_router(build_franchisee_invoices_router(db, require_role))

# Banking module — TrueLayer Open Banking (read-only HSBC integration)
from banking_routes import build_banking_router, ensure_banking_indexes  # noqa: E402
api.include_router(build_banking_router(db, require_role))


@app.on_event("startup")
async def _resolve_jwt_secret():
    """Pin JWT_SECRET to a value cached in MongoDB so it stays stable
    across pod restarts and across multiple backend replicas. Behaviour:

    · First boot: env value wins, gets persisted to ``db.app_secrets``.
    · Subsequent boots: DB value wins (env can change without breaking
      existing user sessions).
    · Empty DB row + missing env: fall back to a freshly generated 64-byte
      secret persisted forever after — clearly logged so it's not silent.
    """
    global JWT_SECRET  # noqa: PLW0603
    try:
        existing = await db.app_secrets.find_one({"_id": "jwt_secret"})
        if existing and existing.get("value"):
            if existing["value"] != _JWT_SECRET_SEED and _JWT_SECRET_SEED:
                # Env says one thing, DB says another. DB wins — log so the
                # admin can investigate (most often a rotated env not yet
                # taking effect, or a stale Emergent secret panel value).
                logger.warning(
                    "JWT_SECRET in env differs from value cached in MongoDB; "
                    "keeping the DB value to preserve existing sessions."
                )
            JWT_SECRET = existing["value"]
            return
        # First boot — persist whatever we seeded with.
        seed = _JWT_SECRET_SEED or os.urandom(48).hex()
        await db.app_secrets.update_one(
            {"_id": "jwt_secret"},
            {"$setOnInsert": {"_id": "jwt_secret", "value": seed,
                              "created_at": datetime.now(timezone.utc).isoformat()}},
            upsert=True,
        )
        JWT_SECRET = seed
        logger.info("JWT_SECRET cached in MongoDB for cross-replica stability.")
    except Exception as exc:  # noqa: BLE001
        logger.warning("JWT_SECRET DB sync failed (non-fatal, sticking with env value): %s", exc)


@app.on_event("startup")
async def _start_youtube_scheduler():
    try:
        await youtube_routes.start_scheduler(db)
    except Exception as exc:  # noqa: BLE001
        logger.warning("YouTube scheduler failed to start (non-fatal): %s", exc)


@app.on_event("startup")
async def _banking_indexes():
    try:
        await ensure_banking_indexes(db)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Banking index init failed (non-fatal): %s", exc)

# Phase 5 — Google Calendar
from calendar_routes import attach as build_calendar_router  # noqa: E402
api.include_router(build_calendar_router(api, db, require_role, get_current_user))

# Calendar extras — yearly HQ events (CSV upload) + per-franchisee
# personal entries. Lives alongside the Google Calendar integration.
from calendar_extras_routes import attach as build_calendar_extras_router  # noqa: E402
api.include_router(build_calendar_extras_router(api, db, require_role, get_current_user))

# Zoom — Server-to-Server OAuth meeting creation
from zoom_routes import attach as build_zoom_router  # noqa: E402
api.include_router(build_zoom_router(api, db, require_role))

# Phase 4C — Public "Find a class" lookup for creativemojo.com
from find_class_routes import attach as build_find_class_router  # noqa: E402
api.include_router(build_find_class_router(api, db, require_role))

# Gravity Forms backfill — safety net for the live webhook.
from gf_backfill import attach as build_gf_backfill_router, schedule_periodic as _gf_backfill_loop  # noqa: E402
api.include_router(build_gf_backfill_router(api, db, require_role))

app.include_router(api)

# Serve cached franchisee photos (downloaded from Airtable at migration time so they
# don't expire). Mounted under /api/uploads so it's reachable through the ingress.
from fastapi.staticfiles import StaticFiles  # noqa: E402
from migration import UPLOADS_DIR  # noqa: E402
UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/api/uploads", StaticFiles(directory=str(UPLOADS_DIR)), name="uploads")

app.add_middleware(
    CORSMiddleware,
    # Allow our preview/prod admin frontend (with credentials) plus the
    # public creativemojo.com origin for the unauthenticated Find-a-Class
    # embed. The regex now matches *any* subdomain of creativemojo.com /
    # creativemojo.co.uk so the branded hub URL (`hub.creativemojo.co.uk`)
    # and future portals (`franchises.`, `licensees.`) all work out of
    # the box without further config changes. Credentialled cookie auth
    # is fine because the regex is locked to our own apex domains.
    allow_origins=[FRONTEND_URL],
    allow_origin_regex=r"https://([a-z0-9-]+\.)?creativemojo\.(com|co\.uk)",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
