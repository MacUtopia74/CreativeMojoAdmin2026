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
# Migration Decisions (captured by user during Airtable Inspector walkthrough)
# ----------------------------------------------------------------------------
DECISION_VALUES = {"undecided", "keep", "rename", "drop", "merge"}


class FieldDecisionRequest(BaseModel):
    table_id: str
    field_id: str
    field_name: str
    decision: str = "undecided"
    rename_to: Optional[str] = None
    merge_with: Optional[str] = None
    notes: Optional[str] = None


class TableDecisionRequest(BaseModel):
    table_id: str
    table_name: str
    migrate: Optional[bool] = None
    notes: Optional[str] = None


@api.get("/migration/decisions")
async def get_decisions(_: dict = Depends(require_role("admin"))):
    tables = await db.migration_table_decisions.find({}, {"_id": 0}).to_list(1000)
    fields = await db.migration_field_decisions.find({}, {"_id": 0}).to_list(10000)
    return {"tables": tables, "fields": fields}


@api.post("/migration/decisions/table")
async def set_table_decision(body: TableDecisionRequest, user: dict = Depends(require_role("admin"))):
    update = {
        "table_id": body.table_id,
        "table_name": body.table_name,
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "updated_by": user["email"],
    }
    if body.migrate is not None:
        update["migrate"] = body.migrate
    if body.notes is not None:
        update["notes"] = body.notes
    await db.migration_table_decisions.update_one(
        {"table_id": body.table_id}, {"$set": update}, upsert=True
    )
    return {"ok": True}


@api.post("/migration/decisions/field")
async def set_field_decision(body: FieldDecisionRequest, user: dict = Depends(require_role("admin"))):
    if body.decision not in DECISION_VALUES:
        raise HTTPException(status_code=400, detail=f"decision must be one of {sorted(DECISION_VALUES)}")
    doc = {
        "table_id": body.table_id,
        "field_id": body.field_id,
        "field_name": body.field_name,
        "decision": body.decision,
        "rename_to": body.rename_to,
        "merge_with": body.merge_with,
        "notes": body.notes,
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "updated_by": user["email"],
    }
    await db.migration_field_decisions.update_one(
        {"table_id": body.table_id, "field_id": body.field_id}, {"$set": doc}, upsert=True
    )
    return {"ok": True}


@api.get("/migration/plan")
async def migration_plan(_: dict = Depends(require_role("admin"))):
    """Aggregate summary of all decisions for the Migration Plan page + export."""
    schema = await list_airtable_tables(_)
    table_decisions = {td["table_id"]: td for td in await db.migration_table_decisions.find({}, {"_id": 0}).to_list(1000)}
    field_decisions: dict = {}
    for fd in await db.migration_field_decisions.find({}, {"_id": 0}).to_list(10000):
        field_decisions.setdefault(fd["table_id"], {})[fd["field_id"]] = fd

    plan = []
    totals = {"keep": 0, "rename": 0, "drop": 0, "merge": 0, "undecided": 0}
    for t in schema["tables"]:
        td = table_decisions.get(t["id"], {})
        per_field = []
        counts = {k: 0 for k in totals}
        for f in t["fields"]:
            fd = field_decisions.get(t["id"], {}).get(f["id"], {})
            decision = fd.get("decision", "undecided")
            counts[decision] = counts.get(decision, 0) + 1
            totals[decision] = totals.get(decision, 0) + 1
            per_field.append({
                "field_id": f["id"],
                "field_name": f["name"],
                "field_type": f["type"],
                "decision": decision,
                "rename_to": fd.get("rename_to"),
                "merge_with": fd.get("merge_with"),
                "notes": fd.get("notes"),
            })
        plan.append({
            "table_id": t["id"],
            "table_name": t["name"],
            "field_count": t["field_count"],
            "migrate": td.get("migrate"),
            "notes": td.get("notes"),
            "counts": counts,
            "fields": per_field,
        })
    return {"totals": totals, "tables": plan}


# ----------------------------------------------------------------------------
# Form Intake (Gravity Forms via WordPress plugin)
# ----------------------------------------------------------------------------
FORM_ID_TO_SOURCE = {
    1: "general_enquiry",       # general contact form
    17: "franchise_enquiry",    # franchise enquiry form
    32: "licence_enquiry",      # licence enquiry form
}

# Form IDs that should go into the active sales pipeline by default
FORM_IDS_IN_PIPELINE = {17, 32}


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
    last_migration = await db.migration_runs.find_one({}, sort=[("run_at", -1)])

    # Mandate breakdown across active franchisees only
    mandate_pipeline = [
        {"$match": {"tags": "Franchisee"}},
        {"$group": {"_id": "$mandate", "count": {"$sum": 1}}},
        {"$sort": {"count": -1}},
    ]
    mandate_breakdown = await db.franchisees.aggregate(mandate_pipeline).to_list(20)
    mandate_breakdown = [
        {"value": (m["_id"] if isinstance(m["_id"], str) else (m["_id"][0] if isinstance(m["_id"], list) and m["_id"] else None)) or "Not set", "count": m["count"]}
        for m in mandate_breakdown
    ]

    # Pipeline funnel (web form contacts only — active sales pipeline)
    funnel_pipeline = [
        {"$group": {"_id": "$pipeline_status", "count": {"$sum": 1}}},
    ]
    funnel_raw = await db.web_form_contacts.aggregate(funnel_pipeline).to_list(20)
    funnel = {f["_id"] or "new": f["count"] for f in funnel_raw}

    # Recent enquiries (last 5 by date)
    recent_enquiries = await db.web_form_contacts.find(
        {}, {"_id": 0, "id": 1, "first_name": 1, "last_name": 1, "establishment_name": 1,
             "postcode": 1, "date": 1, "pipeline_status": 1, "potential": 1},
    ).sort("date", -1).limit(5).to_list(5)

    airtable_summary = None
    try:
        data = await list_airtable_tables(_)
        airtable_summary = {
            "tables": len(data["tables"]),
            "total_fields": sum(t["field_count"] for t in data["tables"]),
        }
    except Exception as e:
        logger.warning(f"Could not fetch airtable summary: {e}")
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
        "recent_enquiries": recent_enquiries,
        "airtable": airtable_summary,
        "last_migration": last_migration.get("run_at") if last_migration else None,
    }


# ----------------------------------------------------------------------------
# Migration runner endpoint
# ----------------------------------------------------------------------------
from migration import run_migration  # noqa: E402


@api.post("/migration/run")
async def migration_run(user: dict = Depends(require_role("admin"))):
    if not AIRTABLE_PAT or not AIRTABLE_BASE_ID:
        raise HTTPException(status_code=503, detail="Airtable credentials not configured")
    try:
        counts = await run_migration(db, AIRTABLE_PAT, AIRTABLE_BASE_ID, user["email"])
        return {"ok": True, "counts": counts}
    except Exception as e:
        logger.exception("Migration failed")
        raise HTTPException(status_code=500, detail=f"Migration failed: {e}")


@api.post("/franchisees/refresh-photos")
async def refresh_franchisee_photos(user: dict = Depends(require_role("admin"))):
    """Re-fetch the original Airtable URLs for any franchisees whose photos failed to download
    and download them now. Useful when migration ran when Airtable URLs had already expired."""
    if not AIRTABLE_PAT or not AIRTABLE_BASE_ID:
        raise HTTPException(status_code=503, detail="Airtable credentials not configured")
    from migration import _fetch_all_records, _extract_attachment_urls, _download_franchisee_photos
    # Find the franchisees table id from saved decisions
    td = await db.migration_table_decisions.find_one({"table_name": "Franchisees/Licencees"}, {"_id": 0})
    if not td or not td.get("table_id"):
        raise HTTPException(status_code=404, detail="Franchisees table id not found in migration decisions")
    # Pull fresh attachment URLs from Airtable
    records = await _fetch_all_records(AIRTABLE_BASE_ID, td["table_id"], AIRTABLE_PAT)
    at_id_to_photos = {}
    for rec in records:
        photos = _extract_attachment_urls(rec.get("fields", {}).get("Upload"))
        if photos:
            at_id_to_photos[rec["id"]] = photos
    # Build a list of franchisees with refreshed remote URLs
    franchisees = await db.franchisees.find({}, {"_id": 0}).to_list(10000)
    updated = []
    for f in franchisees:
        photos = at_id_to_photos.get(f.get("airtable_id"))
        if photos:
            f["photos"] = photos
            updated.append(f)
    stats = await _download_franchisee_photos(updated)
    for f in updated:
        if f.get("photos"):
            await db.franchisees.update_one({"id": f["id"]}, {"$set": {"photos": f["photos"]}})
    return {"ok": True, "stats": stats, "refreshed": len(updated)}


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


@api.get("/contracts/{contract_id}")
async def get_contract(contract_id: str, _: dict = Depends(require_role("admin"))):
    c = await db.contracts.find_one({"id": contract_id}, {"_id": 0})
    if not c:
        raise HTTPException(status_code=404, detail="Contract not found")
    f = await db.franchisees.find_one({"id": c.get("franchisee_id")}, {"_id": 0}) if c.get("franchisee_id") else None
    return {"contract": c, "franchisee": f}


# ----------------------------------------------------------------------------
# CRM — Contacts (unified, with pipeline)
# ----------------------------------------------------------------------------
@api.get("/contacts")
async def list_contacts(
    source: Optional[str] = None,
    pipeline_status: Optional[str] = None,
    in_pipeline: Optional[bool] = None,
    tab: Optional[str] = None,  # 'pipeline' | 'franchise' | 'general'
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
        # Franchise/Licence enquiries that are NOT in the sales pipeline
        q_legacy = None
        q_web["$and"] = [
            {"source": {"$in": ["franchise_enquiry", "licence_enquiry"]}},
            {"$or": [{"in_pipeline": {"$ne": True}}, {"in_pipeline": {"$exists": False}}]},
        ]
    elif tab == "general":
        # General + legacy contacts that are NOT in the sales pipeline
        q_legacy = {}  # all legacy
        q_web["$and"] = [
            {"source": "general_enquiry"},
            {"$or": [{"in_pipeline": {"$ne": True}}, {"in_pipeline": {"$exists": False}}]},
        ]
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
        rx = {"$regex": search, "$options": "i"}
        if q_legacy is not None:
            q_legacy.setdefault("$and", []).append({"$or": [{"first_name": rx}, {"last_name": rx}, {"email": rx}, {"postcode": rx}, {"city": rx}]})
        if q_web is not None:
            q_web.setdefault("$and", []).append({"$or": [{"first_name": rx}, {"last_name": rx}, {"postcode": rx}, {"city": rx}, {"establishment_name": rx}, {"telephone": rx}, {"email": rx}]})

    items = []
    if q_legacy is not None:
        legacy = await db.contacts.find(q_legacy, {"_id": 0}).limit(limit).to_list(limit)
        items.extend(legacy)
    if q_web is not None:
        web = await db.web_form_contacts.find(q_web, {"_id": 0}).limit(limit).to_list(limit)
        items.extend(web)
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


class PipelineUpdateRequest(BaseModel):
    pipeline_status: str


PIPELINE_STAGES = ["new", "contacted", "qualified", "demo_booked", "converted", "lost", "archive"]


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
MOVE_TARGETS = ("pipeline", "franchise", "general")


class ContactMoveRequest(BaseModel):
    target: str  # "pipeline" | "franchise" | "general"
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

    if target == "franchise":
        # In web_form_contacts: source must be franchise_enquiry or licence_enquiry
        existing = await db.web_form_contacts.find_one({"id": contact_id}, {"_id": 0, "source": 1})
        if existing:
            new_source = existing.get("source")
            if new_source not in ("franchise_enquiry", "licence_enquiry"):
                new_source = "franchise_enquiry"
            await db.web_form_contacts.update_one(
                {"id": contact_id},
                {"$set": {"in_pipeline": False, "pipeline_status": None,
                          "source": new_source, "updated_at": now}},
            )
            return "web_form_contacts"
        legacy = await db.contacts.find_one({"id": contact_id}, {"_id": 0})
        if not legacy:
            return None
        legacy.update({
            "in_pipeline": False,
            "pipeline_status": None,
            "source": "franchise_enquiry",
            "promoted_from_legacy": True,
            "updated_at": now,
        })
        await db.web_form_contacts.insert_one(legacy)
        await db.contacts.delete_one({"id": contact_id})
        return "web_form_contacts"

    if target == "general":
        # In web_form_contacts: source becomes general_enquiry, leaves pipeline
        r = await db.web_form_contacts.update_one(
            {"id": contact_id},
            {"$set": {"in_pipeline": False, "pipeline_status": None,
                      "source": "general_enquiry", "updated_at": now}},
        )
        if r.matched_count:
            return "web_form_contacts"
        # legacy stays in contacts collection — just touch updated_at
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
async def anniversaries_today(_: dict = Depends(require_role("admin"))):
    """Returns contracts whose anniversary falls in the next 7 days."""
    now = datetime.now(timezone.utc)
    today_mmdd = now.strftime("%m-%d")
    contracts = await db.contracts.find(
        {"anniversary_reminder": {"$exists": True, "$ne": None}, "cancelled_early": {"$ne": True}},
        {"_id": 0},
    ).to_list(2000)
    upcoming = []
    for c in contracts:
        anniv = c.get("anniversary_reminder")
        if not anniv:
            continue
        try:
            # Anniversary is stored as a date string like "2026-05-13"
            mmdd = str(anniv)[5:10]
            if mmdd == today_mmdd:
                f = await db.franchisees.find_one({"id": c.get("franchisee_id")}, {"_id": 0, "first_name": 1, "last_name": 1, "organisation": 1, "mojo_email": 1, "id": 1})
                upcoming.append({"contract": c, "franchisee": f})
        except Exception:
            continue
    return {"today": today_mmdd, "count": len(upcoming), "anniversaries": upcoming}


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
    presets = {
        # migrate
        "Franchisees/Licencees": (True, "Core franchise records — migrate all relevant fields."),
        "Contracts": (True, "Contract records linked to franchisees."),
        "Contacts": (True, "Legacy general enquiry archive — migrate and dedupe vs Web Form - Contact."),
        "Web Form - Contact": (True, "Active franchise enquiry archive — migrate and dedupe vs Contacts."),
        "DaD Postcode Lookup": (True, "Temporary bridge for find-a-class map until Phase 4 auto-generates lookups."),
        # skip (agreed)
        "Snowflakes": (False, "Skip — agreed during scoping."),
        "Avery All Homes": (False, "Skip — agreed during scoping."),
        "Avery August 2025 Products": (False, "Skip — agreed during scoping."),
        "Renewals 2025": (False, "Skip — agreed during scoping."),
        "Franchise Review Survey 2020": (False, "Skip — historical one-off survey."),
        "Finance Questionnaire Nov 2022": (False, "Skip — historical one-off survey."),
        "DaD Shop Orders": (False, "Defer — review during Phase 2 (Orders)."),
        "Shapes, DBS & Other Orders": (False, "Defer — review during Phase 2 (Orders)."),
        "FSH Home List Lookup": (False, "Defer — review during Phase 4 (Territory map)."),
    }
    # Fetch table IDs from cache or by calling airtable
    if AIRTABLE_PAT and AIRTABLE_BASE_ID:
        try:
            data = await airtable_get(f"/meta/bases/{AIRTABLE_BASE_ID}/tables")
            for t in data.get("tables", []):
                preset = presets.get(t["name"])
                if not preset:
                    continue
                migrate, note = preset
                existing = await db.migration_table_decisions.find_one({"table_id": t["id"]})
                if existing:
                    continue  # don't overwrite user changes
                await db.migration_table_decisions.insert_one({
                    "table_id": t["id"],
                    "table_name": t["name"],
                    "migrate": migrate,
                    "notes": note,
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                    "updated_by": "system:seed",
                })
            logger.info("Seeded preset migration decisions")
        except Exception as e:
            logger.warning(f"Could not seed migration presets: {e}")


@app.on_event("shutdown")
async def on_shutdown():
    client.close()


# ----------------------------------------------------------------------------
# Wire up
# ----------------------------------------------------------------------------
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
