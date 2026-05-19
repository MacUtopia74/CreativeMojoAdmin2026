from dotenv import load_dotenv
from pathlib import Path

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

import os
import logging
import re
import uuid
import bcrypt
import jwt
import httpx
from datetime import datetime, timezone, timedelta
from typing import Optional, List, Literal, Dict, Any
from fastapi import FastAPI, APIRouter, HTTPException, Request, Response, Depends, Query, UploadFile, File
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
from pydantic import BaseModel, EmailStr, Field, ConfigDict

# ----------------------------------------------------------------------------
# Config & Database
# ----------------------------------------------------------------------------
MONGO_URL = os.environ["MONGO_URL"]
DB_NAME = os.environ["DB_NAME"]
JWT_SECRET = os.environ["JWT_SECRET"]
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


class UpdateUserRequest(BaseModel):
    name: Optional[str] = None
    role: Optional[Role] = None
    franchisee_id: Optional[str] = None
    active: Optional[bool] = None


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
    return user_to_public(user)


@api.post("/auth/logout")
async def logout(response: Response, _: dict = Depends(get_current_user)):
    clear_auth_cookies(response)
    return {"ok": True}


@api.post("/auth/refresh")
async def refresh_token(request: Request, response: Response):
    """Issue a fresh access_token from the refresh_token cookie. The
    frontend's axios interceptor hits this transparently when an
    authenticated call returns 401, so admins don't get bounced to the
    login screen mid-session after 8 hours."""
    rtoken = request.cookies.get("refresh_token")
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
    return user_to_public(user)


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
    await db.users.insert_one(user)
    return {
        "id": user["id"], "email": user["email"], "name": user["name"],
        "role": user["role"], "franchisee_id": user.get("franchisee_id"),
        "created_at": user["created_at"], "active": True,
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
    if body.name is not None: update["name"] = body.name
    if body.role is not None: update["role"] = body.role
    if body.franchisee_id is not None:
        # Empty string clears the linkage.
        update["franchisee_id"] = body.franchisee_id or None
    if body.active is not None:
        # Self-disable lockout guard — admins can't accidentally lock
        # themselves out of the console.
        if not body.active and user_id == admin["id"]:
            raise HTTPException(400, "You can't deactivate your own account")
        update["active"] = body.active
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
            "$unset": {"force_password_change": ""},
        },
    )
    return {"ok": True}


# ----------------------------------------------------------------------------
# Airtable / Migration endpoints — REMOVED 2026-05-19 after the live cutover.
# The console is now the source of truth; Airtable has been decommissioned.
# (Sidebar items + dashboard 'Re-run migration' button were also removed.)
# ----------------------------------------------------------------------------




# ----------------------------------------------------------------------------
# Form Intake (Gravity Forms via WordPress plugin)
# ----------------------------------------------------------------------------
FORM_ID_TO_SOURCE = {
    1: "general_enquiry",       # general contact form
    17: "franchise_enquiry",    # franchise enquiry form
    32: "licence_enquiry",      # licence enquiry form
}

# Form IDs whose submissions land directly in the active Sales Pipeline as "New".
# Form 17 = Franchise Enquiry · Form 32 = Licence Enquiry. These represent fresh leads
# that should be triaged by the sales team immediately, not parked in the contacts tabs.
FORM_IDS_IN_PIPELINE: set = {17, 32}


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

    in_pipeline = payload.form_id in FORM_IDS_IN_PIPELINE

    doc = {
        "id": str(uuid.uuid4()),
        "airtable_id": None,
        "source": source,
        "form_id": payload.form_id,
        "form_title": payload.form_title,
        "gravity_entry_id": payload.entry_id,
        "date": payload.date or datetime.now(timezone.utc).isoformat(),
        "first_name": _pick(f, "First Name", "first_name", "fname", "First"),
        "last_name": _pick(f, "Last Name", "last_name", "lname", "Last", "Surname"),
        "email": _pick(f, "Email", "Email Address", "email", "email_address"),
        "telephone": _pick(f, "Telephone", "Phone", "Telephone Number", "Mobile", "Phone Number"),
        "mobile_phone": _pick(f, "Mobile", "Mobile Phone", "Mobile Number"),
        "establishment_name": _pick(f, "Name of establishment", "Establishment", "Company", "Organisation"),
        "address_street": _pick(f, "1st Line of Address", "Address", "Street"),
        "city": _pick(f, "City/Town", "City", "Town"),
        "county": _pick(f, "County", "Region"),
        "postcode": _pick(f, "Postcode", "Postal Code", "Zip"),
        "why_contacting": _pick(f, "Why you are contacting us", "Subject", "Reason"),
        "message": _pick(f, "Your Message", "Message", "Comments", "Notes"),
        "country_tag": _pick(f, "Country"),
        "referral_source": _detect_referral_source(f),
        "raw_fields": f,
        "in_pipeline": in_pipeline,
        "pipeline_status": "new" if in_pipeline else None,
        "received_at": datetime.now(timezone.utc).isoformat(),
        "created_at": datetime.now(timezone.utc).isoformat(),
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
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
    import io, zipfile
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


@api.get("/franchisees/{franchisee_id}")
async def get_franchisee(franchisee_id: str, _: dict = Depends(require_role("admin"))):
    f = await db.franchisees.find_one({"id": franchisee_id}, {"_id": 0})
    if not f:
        raise HTTPException(status_code=404, detail="Franchisee not found")
    contracts = await db.contracts.find({"franchisee_id": franchisee_id}, {"_id": 0}).to_list(100)
    territories = await db.territories.find({"franchisee_id": franchisee_id}, {"_id": 0}).to_list(2000)
    enquiries = await db.web_form_contacts.find({"franchisee_id": franchisee_id}, {"_id": 0}).to_list(100)
    return {"franchisee": f, "contracts": contracts, "territories": territories, "enquiries": enquiries}


# Editable franchisee fields (admin only). Any unspecified field is left untouched.
FRANCHISEE_EDITABLE_FIELDS = {
    "first_name", "last_name", "organisation", "email", "mojo_email", "secondary_email",
    "telephone", "mobile_phone", "address", "city", "county", "postcode", "country",
    "potential", "fee_paid", "anniversary_reminder", "notes",
    "status", "staying_leaving",
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
        "website", "facebook_url",
        "date_added",  # legacy "started with us" date — fallback for tenure
        "start_date", "end_date", "lifecycle_status",
        "gocardless_mandate_status", "gocardless_last_payment_at",
        "photo_url", "photos", "territory_postcodes", "territory_geojson",
        "territory_sectors", "territory_home_count",
    }
    profile = {k: f.get(k) for k in keep if k in f}
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
    franchisee_doc = {
        "id": f_id,
        "record_type": record_type,
        "first_name": contact.get("first_name"),
        "last_name": contact.get("last_name"),
        "organisation": contact.get("establishment_name"),
        "email": (contact.get("email") or "").lower() or None,
        "telephone": contact.get("telephone"),
        "mobile_phone": contact.get("mobile_phone"),
        "postcode": (contact.get("postcode") or "").upper() or None,
        "city": contact.get("city"),
        "country": contact.get("country_tag"),
        "potential": contact.get("potential"),
        "tags": ["Converted from enquiry"],
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
    await db.franchisees.insert_one(franchisee_doc)
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
    return {"ok": True, "record_type": record_type, "franchisee": franchisee_doc}


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
@api.get("/contacts")
async def list_contacts(
    source: Optional[str] = None,
    pipeline_status: Optional[str] = None,
    in_pipeline: Optional[bool] = None,
    tab: Optional[str] = None,  # 'pipeline' | 'franchise' | 'licence' | 'general'
    search: Optional[str] = None,
    limit: int = Query(500, le=2000),
    _: dict = Depends(require_role("admin")),
):
    """Combines legacy contacts + web form contacts under one query."""
    q_legacy = {}
    q_web = {}
    # Tab shorthand
    if tab == "pipeline":
        q_legacy = None
        q_web["in_pipeline"] = True
    elif tab == "franchise":
        # ALL franchise enquiries — pipeline membership is now just a tag, not
        # an exclusion. Pipeline contacts also appear here, so we never lose
        # track of someone just because they're being actively chased.
        q_legacy = None
        q_web["source"] = "franchise_enquiry"
    elif tab == "licence":
        # ALL licence enquiries (including those currently in the pipeline).
        q_legacy = None
        q_web["source"] = "licence_enquiry"
    elif tab == "general":
        # General + legacy contacts (legacy gets the long-tail of pre-2024
        # enquiries; web=general_enquiry covers anything new).
        q_legacy = {}
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
        if q_legacy is not None: q_legacy["pipeline_status"] = pipeline_status
        if q_web is not None: q_web["pipeline_status"] = pipeline_status
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
        legacy = await db.contacts.find(q_legacy, {"_id": 0}).limit(limit).to_list(limit)
        items.extend(legacy)
    if q_web is not None:
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
    else:
        items.sort(key=lambda x: x.get("date") or x.get("date_added") or "", reverse=True)

    return {"items": items[:limit], "total": len(items)}


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
    postcode: Optional[str] = None
    city: Optional[str] = None
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
        "postcode": (body.postcode or "").strip().upper() or None,
        "city": (body.city or "").strip() or None,
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


PIPELINE_STAGES = ["new", "contacted", "qualified", "demo_booked", "converted", "lost", "archive"]


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
    r = await db.web_form_contacts.update_one(
        {"id": contact_id},
        {"$set": {"pipeline_status": body.pipeline_status, "in_pipeline": True, "updated_at": datetime.now(timezone.utc).isoformat()}},
    )
    if r.matched_count == 0:
        r = await db.contacts.update_one(
            {"id": contact_id},
            {"$set": {"pipeline_status": body.pipeline_status, "updated_at": datetime.now(timezone.utc).isoformat()}},
        )
    if r.matched_count == 0:
        raise HTTPException(status_code=404, detail="Contact not found")
    return {"ok": True, "pipeline_status": body.pipeline_status}


@api.patch("/contacts/{contact_id}/promote")
async def promote_contact(contact_id: str, _: dict = Depends(require_role("admin"))):
    """Move a general contact into the active sales pipeline."""
    now = datetime.now(timezone.utc).isoformat()
    # Try web_form_contacts first (general enquiries from form 1)
    r = await db.web_form_contacts.update_one(
        {"id": contact_id},
        {"$set": {"in_pipeline": True, "pipeline_status": "new", "updated_at": now}},
    )
    if r.matched_count == 0:
        # Legacy contact: copy into web_form_contacts so it shows up in the pipeline
        legacy = await db.contacts.find_one({"id": contact_id}, {"_id": 0})
        if not legacy:
            raise HTTPException(status_code=404, detail="Contact not found")
        legacy["in_pipeline"] = True
        legacy["pipeline_status"] = "new"
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


@api.delete("/contacts/{contact_id}")
async def delete_contact(contact_id: str, _: dict = Depends(require_role("admin"))):
    """Permanently delete a contact from either collection."""
    r = await db.web_form_contacts.delete_one({"id": contact_id})
    if r.deleted_count == 0:
        r = await db.contacts.delete_one({"id": contact_id})
    if r.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Contact not found")
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
        # web_form_contacts: just flip flags
        r = await db.web_form_contacts.update_one(
            {"id": contact_id},
            {"$set": {"in_pipeline": True, "pipeline_status": stage, "updated_at": now}},
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


@api.post("/contacts/bulk-move")
async def bulk_move_contacts(body: ContactBulkMoveRequest, _: dict = Depends(require_role("admin"))):
    if body.target not in MOVE_TARGETS:
        raise HTTPException(status_code=400, detail=f"target must be one of {MOVE_TARGETS}")
    if body.target == "pipeline" and body.pipeline_status and body.pipeline_status not in PIPELINE_STAGES:
        raise HTTPException(status_code=400, detail=f"pipeline_status must be one of {PIPELINE_STAGES}")
    if not body.ids:
        return {"ok": True, "moved": 0, "not_found": 0}
    moved = 0
    not_found = 0
    for cid in body.ids:
        coll = await _move_one_contact(cid, body.target, body.pipeline_status)
        if coll:
            moved += 1
        else:
            not_found += 1
    return {"ok": True, "moved": moved, "not_found": not_found}


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
    `upcoming_days=14` to fill its full-width strip with two weeks ahead."""
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
            mmdd = str(anniv)[5:10]  # "MM-DD"
            month, day = int(mmdd[:2]), int(mmdd[3:5])
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
            # Skip ex-franchisees — their contract anniversaries are historic
            # and shouldn't clutter the active dashboard.
            if not f:
                continue
            if f.get("lifecycle_status") == "ex_franchisee":
                continue
            if "Franchisee" not in (f.get("tags") or []):
                continue
            # Strip the internal flags from the response — UI doesn't need them.
            f.pop("lifecycle_status", None)
            f.pop("tags", None)
            out.append({
                "contract": c,
                "franchisee": f,
                "anniversary_date": next_anniv.isoformat(),
                "days_until": days_until,
            })
        except Exception:
            continue
    out.sort(key=lambda x: x["days_until"])
    today_count = sum(1 for x in out if x["days_until"] == 0)
    return {
        "today": today.strftime("%m-%d"),
        "count": today_count,           # backwards-compat: today-only count
        "upcoming_count": len(out),
        "anniversaries": out,
    }


@api.get("/health")
async def health():
    return {"ok": True}


# ----------------------------------------------------------------------------
# Startup: seed admin + indexes
# ----------------------------------------------------------------------------
@app.on_event("startup")
async def on_startup():
    await db.users.create_index("email", unique=True)
    await db.users.create_index("id", unique=True)
    await db.login_attempts.create_index("identifier")

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


@app.on_event("shutdown")
async def on_shutdown():
    client.close()


# ----------------------------------------------------------------------------
# Wire up
# ----------------------------------------------------------------------------
# Phase 1.5 — GoCardless live mandate integration
from gocardless_integration import build_router as build_gocardless_router  # noqa: E402
api.include_router(build_gocardless_router(db, require_role))

# Phase 3 — FileCamp → R2 migration + admin file browser
from filecamp_migration import build_router as build_migration_router  # noqa: E402
from files_routes import build_router as build_files_router  # noqa: E402
from portal_routes import build_portal_router  # noqa: E402
from territory_routes import build_territory_router  # noqa: E402
from cqc_routes import build_cqc_router  # noqa: E402
api.include_router(build_migration_router(db, require_role))
api.include_router(build_files_router(db, require_role))
api.include_router(build_portal_router(
    db, hash_password, verify_password, create_access_token,
    create_refresh_token, set_auth_cookies,
    check_lockout, record_failure, clear_failures, user_to_public,
))
api.include_router(build_territory_router(db, require_role))
api.include_router(build_cqc_router(db, require_role))

# Invoices module — merged from the standalone Pay-Paperwork app
from invoices_routes import build_invoices_router  # noqa: E402
api.include_router(build_invoices_router(db, require_role))

# Banking module — TrueLayer Open Banking (read-only HSBC integration)
from banking_routes import build_banking_router, ensure_banking_indexes  # noqa: E402
api.include_router(build_banking_router(db, require_role))


@app.on_event("startup")
async def _banking_indexes():
    try:
        await ensure_banking_indexes(db)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Banking index init failed (non-fatal): %s", exc)

# Phase 5 — Google Calendar
from calendar_routes import attach as build_calendar_router  # noqa: E402
api.include_router(build_calendar_router(api, db, require_role, get_current_user))

# Zoom — Server-to-Server OAuth meeting creation
from zoom_routes import attach as build_zoom_router  # noqa: E402
api.include_router(build_zoom_router(api, db, require_role))

app.include_router(api)

# Serve cached franchisee photos (downloaded from Airtable at migration time so they
# don't expire). Mounted under /api/uploads so it's reachable through the ingress.
from fastapi.staticfiles import StaticFiles  # noqa: E402
from migration import UPLOADS_DIR  # noqa: E402
UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/api/uploads", StaticFiles(directory=str(UPLOADS_DIR)), name="uploads")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[FRONTEND_URL],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
