"""Phase 4B — Live CQC sync + admin-defined "which homes count" rules.

CQC Syndication API base: https://api.service.cqc.org.uk/public/v1
Auth: `Ocp-Apim-Subscription-Key` header from env var `CQC_API_KEY`.

Workflow:
  1. Initial full sync (one-off, ~1 hour at 2k req/min): hits the
     /locations listing for all 121k locations, then fetches details
     for each in concurrent batches and upserts into `cqc_locations_live`.
  2. Subsequent nightly sync uses /changes/location?startTimestamp=...
     to pull just the deltas (~minutes).
  3. Admin maintains ONE rule document in `cqc_definition` selecting
     which gacServiceTypes / specialisms / careHome flag / etc. count
     as "your kind of home". All home counts in the system re-derive
     from this rule live, so changing the rule instantly updates every
     franchisee's territory count without re-syncing.
"""
from __future__ import annotations

import asyncio
import logging
import os
import re
from datetime import datetime, timezone
from typing import Any, Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

logger = logging.getLogger("creative-mojo-admin.cqc")

CQC_BASE = "https://api.service.cqc.org.uk/public/v1"
DEFAULT_DEFINITION_ID = "system-default"
_POSTCODE_RE = re.compile(r"^\s*([A-Z]{1,2}\d[A-Z\d]?)\s*(\d)([A-Z]{2})\s*$", re.I)


def _sector(postcode: Optional[str]) -> tuple[Optional[str], Optional[str]]:
    if not postcode:
        return None, None
    m = _POSTCODE_RE.match(postcode.upper())
    if not m:
        return None, None
    return f"{m.group(1)} {m.group(2)}", m.group(1)


# --------------------------------------------------------------- definitions
class CqcDefinition(BaseModel):
    """The single rule that drives every home count in the system."""
    include_service_types: list[str] = Field(default_factory=list)
    exclude_service_types: list[str] = Field(default_factory=list)
    include_specialisms: list[str] = Field(default_factory=list)
    exclude_specialisms: list[str] = Field(default_factory=list)
    include_regulated_activities: list[str] = Field(default_factory=list)
    require_care_home: Optional[str] = None    # "Y" / "N" / None (either)
    registration_statuses: list[str] = Field(default_factory=lambda: ["Registered"])
    min_beds: Optional[int] = None
    require_rating: list[str] = Field(default_factory=list)  # ["Good","Outstanding"]


def definition_to_mongo_filter(d: CqcDefinition) -> dict:
    """Translates the rule into a MongoDB filter on `cqc_locations_live`."""
    f: dict = {}
    if d.registration_statuses:
        f["registrationStatus"] = {"$in": d.registration_statuses}
    if d.require_care_home in ("Y", "N"):
        f["careHome"] = d.require_care_home
    if d.include_service_types:
        f["gacServiceTypes.name"] = {"$in": d.include_service_types}
    if d.exclude_service_types:
        f.setdefault("gacServiceTypes.name", {})
        f["gacServiceTypes.name"]["$nin"] = d.exclude_service_types
    if d.include_specialisms:
        f["specialisms.name"] = {"$in": d.include_specialisms}
    if d.exclude_specialisms:
        f.setdefault("specialisms.name", {})
        f["specialisms.name"]["$nin"] = d.exclude_specialisms
    if d.include_regulated_activities:
        f["regulatedActivities.name"] = {"$in": d.include_regulated_activities}
    if d.min_beds:
        f["numberOfBeds"] = {"$gte": d.min_beds}
    if d.require_rating:
        f["currentRatings.overall.rating"] = {"$in": d.require_rating}
    return f


# ------------------------------------------------------------- sync internals
class _SyncState:
    running: bool = False
    started_at: Optional[str] = None
    finished_at: Optional[str] = None
    total: int = 0
    done: int = 0
    inserted: int = 0
    updated: int = 0
    errors: int = 0
    current_page: int = 0
    error_log: list[str] = []

    @classmethod
    def snapshot(cls) -> dict:
        return {
            "running": cls.running,
            "started_at": cls.started_at,
            "finished_at": cls.finished_at,
            "total": cls.total,
            "done": cls.done,
            "inserted": cls.inserted,
            "updated": cls.updated,
            "errors": cls.errors,
            "current_page": cls.current_page,
            "error_log": cls.error_log[-10:],
        }


async def _fetch_with_retry(http: httpx.AsyncClient, url: str, headers: dict, attempts: int = 4) -> Optional[dict]:
    for i in range(attempts):
        try:
            r = await http.get(url, headers=headers, timeout=30.0)
            if r.status_code == 200:
                return r.json()
            if r.status_code == 429:
                await asyncio.sleep(2 + i * 2)
                continue
            if r.status_code >= 500:
                await asyncio.sleep(1 + i)
                continue
            return None
        except (httpx.HTTPError, asyncio.TimeoutError):
            await asyncio.sleep(1 + i)
    return None


def _shape_location(raw: dict) -> dict:
    """Reduce a CQC payload to the fields we actually store."""
    sec, dist = _sector(raw.get("postalCode"))
    return {
        "locationId": raw.get("locationId"),
        "name": raw.get("name"),
        "providerId": raw.get("providerId"),
        "type": raw.get("type"),
        "organisationType": raw.get("organisationType"),
        "careHome": raw.get("careHome"),
        "registrationStatus": raw.get("registrationStatus"),
        "registrationDate": raw.get("registrationDate"),
        "postalCode": raw.get("postalCode"),
        "postcode_sector": sec,
        "postcode_district": dist,
        "postalAddressLine1": raw.get("postalAddressLine1"),
        "postalAddressTownCity": raw.get("postalAddressTownCity"),
        "localAuthority": raw.get("localAuthority"),
        "region": raw.get("region"),
        "constituency": raw.get("constituency"),
        "latitude": raw.get("onspdLatitude"),
        "longitude": raw.get("onspdLongitude"),
        "numberOfBeds": raw.get("numberOfBeds") or 0,
        "gacServiceTypes": raw.get("gacServiceTypes") or [],
        "specialisms": raw.get("specialisms") or [],
        "regulatedActivities": [
            {"name": a.get("name"), "code": a.get("code")}
            for a in (raw.get("regulatedActivities") or [])
        ],
        "currentRatings": raw.get("currentRatings"),
        "lastInspection": raw.get("lastInspection"),
        "website": raw.get("website"),
        "synced_at": datetime.now(timezone.utc),
    }


async def _run_full_sync(db) -> None:
    """Long-running coroutine — pulls every location detail into MongoDB."""
    api_key = os.environ.get("CQC_API_KEY")
    if not api_key:
        _SyncState.errors += 1
        _SyncState.error_log.append("Missing CQC_API_KEY env var")
        _SyncState.running = False
        return
    headers = {"Ocp-Apim-Subscription-Key": api_key}
    _SyncState.running = True
    _SyncState.started_at = datetime.now(timezone.utc).isoformat()
    _SyncState.finished_at = None
    _SyncState.done = _SyncState.inserted = _SyncState.updated = _SyncState.errors = 0
    _SyncState.current_page = 0
    _SyncState.error_log = []

    coll = db.cqc_locations_live
    await coll.create_index("locationId", unique=True)
    await coll.create_index("postcode_sector")
    await coll.create_index("postcode_district")
    await coll.create_index("registrationStatus")
    await coll.create_index("careHome")
    await coll.create_index("gacServiceTypes.name")
    await coll.create_index("specialisms.name")
    await coll.create_index("region")

    async with httpx.AsyncClient(http2=False) as http:
        # Step 1 — page through the listing endpoint to gather all IDs
        first = await _fetch_with_retry(http, f"{CQC_BASE}/locations?perPage=1000&page=1", headers)
        if not first:
            _SyncState.errors += 1
            _SyncState.error_log.append("listing call failed")
            _SyncState.running = False
            _SyncState.finished_at = datetime.now(timezone.utc).isoformat()
            return
        total_pages = first.get("totalPages") or 1
        _SyncState.total = first.get("total") or 0
        all_ids: list[str] = [loc["locationId"] for loc in first.get("locations", [])]
        _SyncState.current_page = 1
        for page in range(2, total_pages + 1):
            data = await _fetch_with_retry(http, f"{CQC_BASE}/locations?perPage=1000&page={page}", headers)
            if not data:
                _SyncState.errors += 1
                _SyncState.error_log.append(f"listing page {page} failed")
                continue
            all_ids.extend(loc["locationId"] for loc in data.get("locations", []))
            _SyncState.current_page = page
        _SyncState.total = len(all_ids)

        # Step 2 — fetch full detail for each ID with bounded concurrency
        sem = asyncio.Semaphore(8)

        async def fetch_one(loc_id: str) -> None:
            async with sem:
                doc = await _fetch_with_retry(http, f"{CQC_BASE}/locations/{loc_id}", headers)
                if not doc:
                    _SyncState.errors += 1
                    return
                shaped = _shape_location(doc)
                try:
                    res = await coll.update_one(
                        {"locationId": shaped["locationId"]},
                        {"$set": shaped},
                        upsert=True,
                    )
                    if res.upserted_id:
                        _SyncState.inserted += 1
                    elif res.modified_count:
                        _SyncState.updated += 1
                except Exception as exc:  # noqa: BLE001
                    _SyncState.errors += 1
                    _SyncState.error_log.append(f"upsert {loc_id}: {exc}")
                _SyncState.done += 1

        tasks = [asyncio.create_task(fetch_one(lid)) for lid in all_ids]
        # Run in waves of 500 so we don't keep 121k pending tasks alive at once
        WAVE = 500
        for i in range(0, len(tasks), WAVE):
            await asyncio.gather(*tasks[i: i + WAVE], return_exceptions=True)

    # Record sync completion + indexes
    await db.cqc_sync_state.update_one(
        {"_id": "last_full_sync"},
        {"$set": {
            "_id": "last_full_sync",
            "finished_at": datetime.now(timezone.utc),
            "total": _SyncState.total,
            "inserted": _SyncState.inserted,
            "updated": _SyncState.updated,
            "errors": _SyncState.errors,
        }},
        upsert=True,
    )
    _SyncState.running = False
    _SyncState.finished_at = datetime.now(timezone.utc).isoformat()


# ----------------------------------------------------------------- router
def build_cqc_router(db, require_role):  # noqa: D401
    router = APIRouter()

    async def _get_def() -> CqcDefinition:
        doc = await db.cqc_definition.find_one({"_id": DEFAULT_DEFINITION_ID}, {"_id": 0})
        if not doc:
            return CqcDefinition()
        return CqcDefinition(**doc)

    @router.get("/cqc/definition")
    async def get_definition(_user: dict = Depends(require_role("admin"))):
        d = await _get_def()
        return d.model_dump()

    @router.put("/cqc/definition")
    async def put_definition(body: CqcDefinition, user: dict = Depends(require_role("admin"))):
        doc = body.model_dump()
        doc.update({
            "_id": DEFAULT_DEFINITION_ID,
            "updated_at": datetime.now(timezone.utc),
            "updated_by": user.get("email"),
        })
        await db.cqc_definition.update_one(
            {"_id": DEFAULT_DEFINITION_ID}, {"$set": doc}, upsert=True,
        )
        # Refresh every franchisee's territory_home_count
        cur = db.franchisees.find({"territory_sectors": {"$exists": True, "$ne": []}}, {"_id": 0, "id": 1, "territory_sectors": 1})
        async for f in cur:
            cnt = await db.cqc_locations_live.count_documents({
                **definition_to_mongo_filter(body),
                "postcode_sector": {"$in": f["territory_sectors"]},
            })
            await db.franchisees.update_one({"id": f["id"]}, {"$set": {"territory_home_count": cnt}})
        return body.model_dump()

    @router.get("/cqc/definition/preview")
    async def preview_definition(
        include_service_types: Optional[str] = Query(None),
        exclude_service_types: Optional[str] = Query(None),
        include_specialisms: Optional[str] = Query(None),
        exclude_specialisms: Optional[str] = Query(None),
        include_regulated_activities: Optional[str] = Query(None),
        require_care_home: Optional[str] = Query(None),
        registration_statuses: Optional[str] = Query(None),
        min_beds: Optional[str] = Query(None),  # accept "" gracefully; parsed below
        require_rating: Optional[str] = Query(None),
        _user: dict = Depends(require_role("admin")),
    ):
        """Live preview of a definition without saving."""
        def split(v):
            return [x.strip() for x in (v or "").split(",") if x.strip()]
        try:
            min_beds_int = int(min_beds) if (min_beds and min_beds.strip()) else None
        except (TypeError, ValueError):
            min_beds_int = None
        d = CqcDefinition(
            include_service_types=split(include_service_types),
            exclude_service_types=split(exclude_service_types),
            include_specialisms=split(include_specialisms),
            exclude_specialisms=split(exclude_specialisms),
            include_regulated_activities=split(include_regulated_activities),
            require_care_home=require_care_home if require_care_home in ("Y", "N") else None,
            registration_statuses=split(registration_statuses) or ["Registered"],
            min_beds=min_beds_int,
            require_rating=split(require_rating),
        )
        f = definition_to_mongo_filter(d)
        count = await db.cqc_locations_live.count_documents(f)
        by_region = await db.cqc_locations_live.aggregate([
            {"$match": f},
            {"$group": {"_id": "$region", "n": {"$sum": 1}}},
            {"$sort": {"n": -1}},
            {"$limit": 12},
        ]).to_list(12)
        # Sample homes
        sample = await db.cqc_locations_live.find(f, {
            "_id": 0, "locationId": 1, "name": 1, "postalCode": 1,
            "gacServiceTypes": 1, "specialisms": 1, "careHome": 1,
            "currentRatings.overall.rating": 1,
        }).limit(8).to_list(8)
        return {"count": count, "by_region": by_region, "sample": sample}

    @router.get("/cqc/distinct")
    async def distinct_values(
        field: str = Query(..., description="gacServiceTypes.name | specialisms.name | regulatedActivities.name | region"),
        _user: dict = Depends(require_role("admin")),
    ):
        allowed = {"gacServiceTypes.name", "specialisms.name", "regulatedActivities.name", "region"}
        if field not in allowed:
            raise HTTPException(400, detail="Invalid field")
        # Aggregate so we also return frequencies
        pipeline = [{"$unwind": f"${field.split('.')[0]}"}, {"$group": {"_id": f"${field}", "n": {"$sum": 1}}}, {"$sort": {"n": -1}}, {"$limit": 200}]
        if field == "region":
            pipeline = [{"$group": {"_id": "$region", "n": {"$sum": 1}}}, {"$sort": {"n": -1}}]
        rows = await db.cqc_locations_live.aggregate(pipeline).to_list(500)
        return {"values": [{"value": r["_id"], "count": r["n"]} for r in rows if r["_id"]]}

    @router.post("/cqc/sync/start")
    async def start_sync(_user: dict = Depends(require_role("admin"))):
        if _SyncState.running:
            return {"already_running": True}
        asyncio.create_task(_run_full_sync(db))
        return {"started": True}

    @router.get("/cqc/sync/status")
    async def sync_status(_user: dict = Depends(require_role("admin"))):
        last = await db.cqc_sync_state.find_one({"_id": "last_full_sync"}, {"_id": 0})
        live_count = await db.cqc_locations_live.count_documents({})
        return {**_SyncState.snapshot(), "live_count": live_count, "last_full_sync": last}

    return router
