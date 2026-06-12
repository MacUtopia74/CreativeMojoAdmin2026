"""Territory+ routes — franchisee-private "My Clients" overlay.

Gated by ``portal_modules.territory_plus`` on the franchisee record.
Demo franchisees (those with a "Demo" tag) always have access regardless
so we can showcase the feature on the portal demo.

Data model:
  • Collection ``franchisee_clients`` — one document per "my client".
    Two flavours, distinguished by ``source``:
      - ``source: "custom"`` — added manually by the franchisee (a
        contact who isn't in the CQC/Scotland regulated-home database).
      - ``source: "cqc"`` / ``source: "scotland"`` — a regulated home
        the franchisee has flagged as their existing client. Carries
        ``home_id`` so the map widget can overlay the "my client"
        badge on the matching CQC/Scotland marker.
    All docs scoped by ``franchisee_id`` — never readable across
    franchisees.

Endpoints:
  GET    /portal/territory-plus/clients
  POST   /portal/territory-plus/clients
  PATCH  /portal/territory-plus/clients/{id}
  DELETE /portal/territory-plus/clients/{id}
  POST   /portal/territory-plus/clients/mark-home    body: {source, home_id, ...meta}
  DELETE /portal/territory-plus/clients/mark-home    body: {source, home_id}
  GET    /portal/territory-plus/access  (lightweight gate check)
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Optional, List

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

logger = logging.getLogger("creative-mojo-admin.territory_plus")


CLIENT_SOURCES = {"custom", "cqc", "scotland"}
PERMITTED_FIELDS = {
    "name", "address", "phone", "website", "provider", "manager", "email",
    "latest_inspection", "cqc_rating", "notes", "postcode", "lat", "lng",
    "contacts", "manager_include_for_marketing",
}


class Contact(BaseModel):
    """Optional secondary contact attached to a client."""
    name: Optional[str] = Field(None, max_length=200)
    role: Optional[str] = Field(None, max_length=120)
    phone: Optional[str] = Field(None, max_length=80)
    email: Optional[str] = Field(None, max_length=200)
    notes: Optional[str] = Field(None, max_length=1000)
    # When True the contact's email is eligible to receive Marketing+
    # e-shots. Default True so existing rows (pre-dating this field)
    # keep their current "in recipients" behaviour. Toggle false to
    # exclude a specific contact without removing them from the record.
    include_for_marketing: Optional[bool] = True
    marketing_unsubscribed: Optional[bool] = False


class ClientIn(BaseModel):
    """Payload for creating / replacing a custom client."""
    name: str = Field(..., min_length=1, max_length=300)
    address: Optional[str] = Field(None, max_length=500)
    phone: Optional[str] = Field(None, max_length=80)
    website: Optional[str] = Field(None, max_length=300)
    provider: Optional[str] = Field(None, max_length=200)
    manager: Optional[str] = Field(None, max_length=200)
    email: Optional[str] = Field(None, max_length=200)
    latest_inspection: Optional[str] = Field(None, max_length=100)
    cqc_rating: Optional[str] = Field(None, max_length=80)
    notes: Optional[str] = Field(None, max_length=4000)
    postcode: Optional[str] = Field(None, max_length=20)
    lat: Optional[float] = None
    lng: Optional[float] = None
    # Up to ~20 additional contacts (deputy managers, sales contacts, etc.).
    contacts: Optional[List[Contact]] = None
    # Manager / primary email marketing-eligibility flag. Mirrors
    # ``include_for_marketing`` on a Contact but applies to the client
    # row's own primary email. Defaults True for back-compat.
    manager_include_for_marketing: Optional[bool] = True


class MarkHomeIn(BaseModel):
    """Toggle a regulated CQC / Scotland home as 'My Client'."""
    source: str  # cqc | scotland
    home_id: str
    name: Optional[str] = None
    address: Optional[str] = None
    phone: Optional[str] = None
    website: Optional[str] = None
    provider: Optional[str] = None
    manager: Optional[str] = None
    postcode: Optional[str] = None
    lat: Optional[float] = None
    lng: Optional[float] = None
    notes: Optional[str] = None


LEAD_STATUSES = {"not_contacted", "contacted", "follow_up"}


class LeadIn(BaseModel):
    """Sales-flow status for a regulated home that ISN'T (yet) a My Client.

    Purely a personal CRM bookmark for the franchisee — never auto-promotes
    a home to a "My Client". One row per (franchisee_id, source, home_id).
    """
    source: str  # cqc | scotland
    home_id: str
    status: str  # not_contacted | contacted | follow_up
    follow_up_at: Optional[str] = Field(None, max_length=64)  # ISO 8601
    notes: Optional[str] = Field(None, max_length=1000)


class LeadDeleteIn(BaseModel):
    source: str
    home_id: str


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


async def _has_access(db, user: dict) -> tuple[bool, dict]:
    """Returns (allowed, franchisee_doc).

    Allowed iff the franchisee has territory_plus enabled OR carries
    the Demo tag (so we can show off the feature on the demo account).
    """
    fid = (user or {}).get("franchisee_id")
    if not fid:
        return False, {}
    fr = await db.franchisees.find_one(
        {"id": fid},
        {"_id": 0, "id": 1, "tags": 1, "portal_modules": 1},
    ) or {}
    modules = (fr.get("portal_modules") or {})
    tags = fr.get("tags") or []
    is_demo = any(str(t).strip().lower() == "demo" for t in tags)
    enabled = bool(modules.get("territory_plus")) or is_demo
    return enabled, fr


def _gate(user: dict, allowed: bool) -> None:
    if not allowed:
        raise HTTPException(
            status_code=403,
            detail="My Territory+ isn't enabled on your account. Visit the Subscriptions page to add it.",
        )


def _shape(doc: dict) -> dict:
    """Strip Mongo internals before returning to the client."""
    return {k: v for k, v in doc.items() if k != "_id"}


async def _geocode_postcode(postcode: str) -> tuple[Optional[float], Optional[float]]:
    """Free postcodes.io lookup so we can drop a marker for custom
    clients that only have a postcode (no lat/lng). Best-effort — we
    silently fall back to "no marker on map" if the call fails."""
    if not postcode:
        return None, None
    clean = postcode.strip().replace(" ", "")
    if not clean:
        return None, None
    url = f"https://api.postcodes.io/postcodes/{clean}"
    try:
        async with httpx.AsyncClient(timeout=4.0) as http:
            r = await http.get(url)
        if r.status_code != 200:
            return None, None
        result = (r.json() or {}).get("result") or {}
        return result.get("latitude"), result.get("longitude")
    except Exception:  # noqa: BLE001
        return None, None


def attach(api: APIRouter, db, require_role):
    @api.get("/portal/territory-plus/access")
    async def check_access(user: dict = Depends(require_role("franchisee"))):
        allowed, fr = await _has_access(db, user)
        return {
            "allowed": allowed,
            "is_demo": any(str(t).strip().lower() == "demo" for t in (fr.get("tags") or [])),
            "franchisee_id": fr.get("id"),
        }

    @api.get("/portal/territory-plus/clients")
    async def list_clients(user: dict = Depends(require_role("franchisee"))):
        allowed, fr = await _has_access(db, user)
        _gate(user, allowed)
        out: list = []
        async for doc in db.franchisee_clients.find(
            {"franchisee_id": fr["id"]}, {"_id": 0},
        ).sort([("name", 1)]):
            out.append(doc)
        return {"items": out, "count": len(out)}

    @api.post("/portal/territory-plus/clients")
    async def create_client(
        body: ClientIn,
        user: dict = Depends(require_role("franchisee")),
    ):
        allowed, fr = await _has_access(db, user)
        _gate(user, allowed)
        now = _now()
        # Geocode the postcode if the user only supplied that (UX win:
        # they paste a postcode, the marker drops on the map).
        lat, lng = body.lat, body.lng
        if (lat is None or lng is None) and body.postcode:
            glat, glng = await _geocode_postcode(body.postcode)
            lat = lat if lat is not None else glat
            lng = lng if lng is not None else glng
        doc = {
            "id": str(uuid.uuid4()),
            "franchisee_id": fr["id"],
            "source": "custom",
            "home_id": None,
            "name": body.name.strip(),
            "address": body.address,
            "phone": body.phone,
            "website": body.website,
            "provider": body.provider,
            "manager": body.manager,
            "email": body.email,
            "latest_inspection": body.latest_inspection,
            "cqc_rating": body.cqc_rating,
            "notes": body.notes,
            "postcode": (body.postcode or "").upper().strip() or None,
            "lat": lat,
            "lng": lng,
            "contacts": [c.model_dump() for c in (body.contacts or [])],
            "manager_include_for_marketing": body.manager_include_for_marketing if body.manager_include_for_marketing is not None else True,
            "created_at": now,
            "updated_at": now,
        }
        await db.franchisee_clients.insert_one(doc)
        return _shape(doc)

    # NOTE: mark-home routes MUST be declared BEFORE the parameterized
    # ``/clients/{client_id}`` routes — otherwise FastAPI matches DELETE
    # /clients/mark-home against the parameterised path and treats
    # "mark-home" as a client_id (404).
    @api.post("/portal/territory-plus/clients/mark-home")
    async def mark_home(
        body: MarkHomeIn,
        user: dict = Depends(require_role("franchisee")),
    ):
        """Flag a CQC / Scotland regulated home as 'My Client'.
        Idempotent — if the link already exists, returns it unchanged.
        """
        allowed, fr = await _has_access(db, user)
        _gate(user, allowed)
        if body.source not in {"cqc", "scotland"}:
            raise HTTPException(400, "source must be 'cqc' or 'scotland'")
        existing = await db.franchisee_clients.find_one(
            {"franchisee_id": fr["id"], "source": body.source, "home_id": body.home_id},
            {"_id": 0},
        )
        if existing:
            return _shape(existing)
        now = _now()
        doc = {
            "id": str(uuid.uuid4()),
            "franchisee_id": fr["id"],
            "source": body.source,
            "home_id": body.home_id,
            "name": (body.name or "").strip() or "—",
            "address": body.address,
            "phone": body.phone,
            "website": body.website,
            "provider": body.provider,
            "manager": body.manager,
            "email": None,
            "latest_inspection": None,
            "cqc_rating": None,
            "notes": body.notes,
            "postcode": (body.postcode or "").upper().strip() or None,
            "lat": body.lat,
            "lng": body.lng,
            "contacts": [],
            "created_at": now,
            "updated_at": now,
        }
        await db.franchisee_clients.insert_one(doc)
        return _shape(doc)

    @api.delete("/portal/territory-plus/clients/mark-home")
    async def unmark_home(
        body: MarkHomeIn,
        user: dict = Depends(require_role("franchisee")),
    ):
        allowed, fr = await _has_access(db, user)
        _gate(user, allowed)
        r = await db.franchisee_clients.delete_one({
            "franchisee_id": fr["id"],
            "source": body.source,
            "home_id": body.home_id,
        })
        return {"ok": True, "deleted": r.deleted_count}

    @api.patch("/portal/territory-plus/clients/{client_id}")
    async def update_client(
        client_id: str,
        body: dict,
        user: dict = Depends(require_role("franchisee")),
    ):
        allowed, fr = await _has_access(db, user)
        _gate(user, allowed)
        patch = {k: body[k] for k in PERMITTED_FIELDS if k in body}
        # If they updated the postcode and didn't pass new lat/lng,
        # re-geocode so the marker moves with it.
        if "postcode" in patch and ("lat" not in patch or "lng" not in patch):
            lat, lng = await _geocode_postcode(patch.get("postcode") or "")
            if lat is not None and lng is not None:
                patch.setdefault("lat", lat)
                patch.setdefault("lng", lng)
        if not patch:
            return {"ok": True, "noop": True}
        if "postcode" in patch and patch["postcode"]:
            patch["postcode"] = patch["postcode"].upper().strip()
        if "name" in patch:
            patch["name"] = (patch["name"] or "").strip() or "—"
        patch["updated_at"] = _now()
        r = await db.franchisee_clients.update_one(
            {"id": client_id, "franchisee_id": fr["id"]},
            {"$set": patch},
        )
        if r.matched_count == 0:
            raise HTTPException(404, "Client not found")
        out = await db.franchisee_clients.find_one(
            {"id": client_id}, {"_id": 0},
        )
        return _shape(out)

    @api.delete("/portal/territory-plus/clients/{client_id}")
    async def delete_client(
        client_id: str,
        user: dict = Depends(require_role("franchisee")),
    ):
        allowed, fr = await _has_access(db, user)
        _gate(user, allowed)
        r = await db.franchisee_clients.delete_one(
            {"id": client_id, "franchisee_id": fr["id"]},
        )
        if r.deleted_count == 0:
            raise HTTPException(404, "Client not found")
        return {"ok": True}

    # -------------------- Sales-flow leads --------------------
    # Lightweight per-franchisee CRM bookmark for regulated homes that
    # haven't been promoted to "My Client". Three states:
    #   • not_contacted (default; reset = delete row)
    #   • contacted
    #   • follow_up    (with optional ``follow_up_at`` datetime)
    # Never modifies franchisee_clients — purely additive metadata.

    @api.get("/portal/territory-plus/leads")
    async def list_leads(user: dict = Depends(require_role("franchisee"))):
        allowed, fr = await _has_access(db, user)
        _gate(user, allowed)
        out: list = []
        async for doc in db.franchisee_home_leads.find(
            {"franchisee_id": fr["id"]}, {"_id": 0},
        ):
            out.append(doc)
        return {"items": out, "count": len(out)}

    @api.put("/portal/territory-plus/leads")
    async def upsert_lead(
        body: LeadIn,
        user: dict = Depends(require_role("franchisee")),
    ):
        allowed, fr = await _has_access(db, user)
        _gate(user, allowed)
        if body.source not in {"cqc", "scotland"}:
            raise HTTPException(400, "source must be 'cqc' or 'scotland'")
        if body.status not in LEAD_STATUSES:
            raise HTTPException(
                400, f"status must be one of: {sorted(LEAD_STATUSES)}",
            )
        now = _now()
        key = {
            "franchisee_id": fr["id"],
            "source": body.source,
            "home_id": body.home_id,
        }
        existing = await db.franchisee_home_leads.find_one(key, {"_id": 0})
        doc = {
            **key,
            "id": (existing or {}).get("id") or str(uuid.uuid4()),
            "status": body.status,
            "follow_up_at": body.follow_up_at if body.status == "follow_up" else None,
            "notes": body.notes,
            "created_at": (existing or {}).get("created_at") or now,
            "updated_at": now,
        }
        await db.franchisee_home_leads.update_one(
            key, {"$set": doc}, upsert=True,
        )
        return doc

    @api.delete("/portal/territory-plus/leads")
    async def delete_lead(
        body: LeadDeleteIn,
        user: dict = Depends(require_role("franchisee")),
    ):
        allowed, fr = await _has_access(db, user)
        _gate(user, allowed)
        r = await db.franchisee_home_leads.delete_one({
            "franchisee_id": fr["id"],
            "source": body.source,
            "home_id": body.home_id,
        })
        return {"ok": True, "deleted": r.deleted_count}

    return api
