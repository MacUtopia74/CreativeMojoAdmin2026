from dotenv import load_dotenv
from pathlib import Path

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

import os
import logging
import uuid
import bcrypt
import jwt
import httpx
from datetime import datetime, timezone, timedelta
from typing import Optional, List, Literal
from fastapi import FastAPI, APIRouter, HTTPException, Request, Response, Depends, Query
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
AIRTABLE_PAT = os.environ.get("AIRTABLE_PAT", "")
AIRTABLE_BASE_ID = os.environ.get("AIRTABLE_BASE_ID", "")

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
    return {
        "id": doc["id"],
        "email": doc["email"],
        "name": doc.get("name", ""),
        "role": doc.get("role", "admin"),
        "created_at": doc["created_at"],
    }


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


@api.get("/auth/me")
async def me(user: dict = Depends(get_current_user)):
    return user_to_public(user)


@api.post("/auth/users")
async def create_user(body: CreateUserRequest, _: dict = Depends(require_role("admin"))):
    email = body.email.lower().strip()
    existing = await db.users.find_one({"email": email})
    if existing:
        raise HTTPException(status_code=409, detail="User with this email already exists")
    user = {
        "id": str(uuid.uuid4()),
        "email": email,
        "name": body.name,
        "role": body.role,
        "password_hash": hash_password(body.password),
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    await db.users.insert_one(user)
    return {"id": user["id"], "email": user["email"], "name": user["name"], "role": user["role"]}


# ----------------------------------------------------------------------------
# Airtable Inspector (read-only proxy)
# ----------------------------------------------------------------------------
_airtable_schema_cache: dict = {"data": None, "fetched_at": None}


async def airtable_get(path: str, params: Optional[dict] = None) -> dict:
    if not AIRTABLE_PAT or not AIRTABLE_BASE_ID:
        raise HTTPException(status_code=503, detail="Airtable credentials not configured")
    headers = {"Authorization": f"Bearer {AIRTABLE_PAT}"}
    url = f"https://api.airtable.com/v0{path}"
    async with httpx.AsyncClient(timeout=30) as client_http:
        r = await client_http.get(url, headers=headers, params=params or {})
    if r.status_code >= 400:
        raise HTTPException(status_code=r.status_code, detail=f"Airtable error: {r.text}")
    return r.json()


@api.get("/airtable/tables")
async def list_airtable_tables(_: dict = Depends(require_role("admin"))):
    """Return the full schema for the configured Airtable base."""
    # 5 minute cache
    now = datetime.now(timezone.utc)
    cached = _airtable_schema_cache
    if cached["data"] and cached["fetched_at"] and (now - cached["fetched_at"]).total_seconds() < 300:
        return cached["data"]
    data = await airtable_get(f"/meta/bases/{AIRTABLE_BASE_ID}/tables")
    tables = []
    for t in data.get("tables", []):
        tables.append({
            "id": t["id"],
            "name": t["name"],
            "primary_field_id": t.get("primaryFieldId"),
            "field_count": len(t.get("fields", [])),
            "view_count": len(t.get("views", [])),
            "fields": [
                {"id": f["id"], "name": f["name"], "type": f.get("type", "unknown"), "description": f.get("description")}
                for f in t.get("fields", [])
            ],
            "views": [{"id": v["id"], "name": v["name"], "type": v.get("type")} for v in t.get("views", [])],
        })
    result = {"base_id": AIRTABLE_BASE_ID, "tables": tables}
    _airtable_schema_cache.update({"data": result, "fetched_at": now})
    return result


@api.get("/airtable/tables/{table_id}/records")
async def get_table_records(
    table_id: str,
    limit: int = Query(20, ge=1, le=100),
    offset: Optional[str] = None,
    _: dict = Depends(require_role("admin")),
):
    params = {"pageSize": limit}
    if offset:
        params["offset"] = offset
    data = await airtable_get(f"/{AIRTABLE_BASE_ID}/{table_id}", params=params)
    return {
        "records": data.get("records", []),
        "offset": data.get("offset"),
    }


@api.get("/airtable/tables/{table_id}/count")
async def count_table_records(table_id: str, _: dict = Depends(require_role("admin"))):
    """Paginate through entire table to count. Cached briefly."""
    total = 0
    offset = None
    async with httpx.AsyncClient(timeout=60) as client_http:
        while True:
            params = {"pageSize": 100}
            if offset:
                params["offset"] = offset
            r = await client_http.get(
                f"https://api.airtable.com/v0/{AIRTABLE_BASE_ID}/{table_id}",
                headers={"Authorization": f"Bearer {AIRTABLE_PAT}"},
                params=params,
            )
            if r.status_code >= 400:
                raise HTTPException(status_code=r.status_code, detail=r.text)
            j = r.json()
            total += len(j.get("records", []))
            offset = j.get("offset")
            if not offset:
                break
    return {"table_id": table_id, "count": total}


# ----------------------------------------------------------------------------
# Dashboard
# ----------------------------------------------------------------------------
@api.get("/dashboard/stats")
async def dashboard_stats(_: dict = Depends(require_role("admin"))):
    # Phase 1 placeholder - returns user count + airtable summary
    user_count = await db.users.count_documents({})
    # Try to fetch airtable summary
    airtable_summary = None
    try:
        data = await list_airtable_tables(_)  # reuse handler
        airtable_summary = {
            "tables": len(data["tables"]),
            "total_fields": sum(t["field_count"] for t in data["tables"]),
        }
    except Exception as e:
        logger.warning(f"Could not fetch airtable summary: {e}")
    return {
        "users": user_count,
        "franchisees_migrated": 0,
        "contracts_migrated": 0,
        "contacts_migrated": 0,
        "airtable": airtable_summary,
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


@app.on_event("shutdown")
async def on_shutdown():
    client.close()


# ----------------------------------------------------------------------------
# Wire up
# ----------------------------------------------------------------------------
app.include_router(api)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[FRONTEND_URL],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
