"""Safe, single-purpose franchisee home-count refresh.

`POST /api/franchisees/{id}/refresh-home-count` recomputes ONLY the
``territory_home_count`` field on the franchisee doc, using the current
CQC + Scotland definitions. It is:

* read-only against ``cqc_locations_live`` and ``scotland_care_services``;
* write-only against ``franchisees.<id>.territory_home_count``;
* explicitly refuses to touch any other field on the franchisee doc,
  any other franchisee, any franchisee_clients / hq_home_notes / CRM
  data, or any sector list;
* returns the previous count, new count, and per-sector breakdown so
  the caller can see exactly what accumulated.

Admin-only, admin auth. Emits an audit trail entry via the
``territory_home_count_refresh_log`` collection.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException

from cqc_definition import (
    CqcDefinition,
    definition_to_mongo_filter,
    DEFAULT_DEFINITION_ID,
)
from scotland_definition import (
    ScotlandDefinition,
    DEFAULT_DEFINITION_ID as SCOTLAND_DEFAULT_DEFINITION_ID,
    definition_to_mongo_filter as scotland_definition_to_mongo_filter,
)
from geo_postcode import is_scottish_postcode

REFRESH_LOG_COLL = "territory_home_count_refresh_log"


def _now() -> datetime:
    return datetime.now(timezone.utc)


async def _compute_home_count(db, sectors: list[str]) -> dict:
    """Return {'total', 'england_count', 'scotland_count',
    'per_sector'} using the current filters. Reads only."""
    defn_doc = await db.cqc_definition.find_one({"_id": DEFAULT_DEFINITION_ID}, {"_id": 0})
    cq = CqcDefinition(**defn_doc) if defn_doc else CqcDefinition()
    filt = definition_to_mongo_filter(cq)
    scot_doc = await db.scotland_definition.find_one(
        {"_id": SCOTLAND_DEFAULT_DEFINITION_ID}, {"_id": 0}
    )
    scot_def = ScotlandDefinition(**scot_doc) if scot_doc else ScotlandDefinition()
    scot_filter = scotland_definition_to_mongo_filter(scot_def)

    eng_sectors = [s for s in sectors if not is_scottish_postcode(s)]
    scot_sectors = [s for s in sectors if is_scottish_postcode(s)]

    per_sector: dict[str, int] = {s: 0 for s in sectors}
    eng_count = 0
    if eng_sectors:
        eng_count = await db.cqc_locations_live.count_documents(
            {**filt, "postcode_sector": {"$in": eng_sectors}}
        )
        # per-sector detail
        pipeline = [
            {"$match": {**filt, "postcode_sector": {"$in": eng_sectors}}},
            {"$group": {"_id": "$postcode_sector", "n": {"$sum": 1}}},
        ]
        async for row in db.cqc_locations_live.aggregate(pipeline):
            per_sector[row["_id"]] = row["n"]

    scot_count = 0
    if scot_sectors:
        scot_count = await db.scotland_care_services.count_documents(
            {**scot_filter, "postcode_sector": {"$in": scot_sectors}}
        )
        pipeline = [
            {"$match": {**scot_filter, "postcode_sector": {"$in": scot_sectors}}},
            {"$group": {"_id": "$postcode_sector", "n": {"$sum": 1}}},
        ]
        async for row in db.scotland_care_services.aggregate(pipeline):
            per_sector[row["_id"]] = row["n"]

    return {
        "total": eng_count + scot_count,
        "england_count": eng_count,
        "scotland_count": scot_count,
        "per_sector": per_sector,
    }


def build_home_count_refresh_router(db, require_role):
    router = APIRouter()

    @router.post("/franchisees/{franchisee_id}/refresh-home-count")
    async def refresh(franchisee_id: str,
                      user: dict = Depends(require_role("admin"))):
        fr = await db.franchisees.find_one(
            {"id": franchisee_id},
            {"_id": 0, "id": 1, "first_name": 1, "last_name": 1,
             "franchise_number": 1, "territory_sectors": 1,
             "territory_home_count": 1},
        )
        if not fr:
            raise HTTPException(404, detail="franchisee_not_found")
        sectors = fr.get("territory_sectors") or []
        if not sectors:
            return {"status": "no_op", "reason": "no_sectors_assigned",
                    "franchisee_id": franchisee_id}
        prev_count = fr.get("territory_home_count")
        result = await _compute_home_count(db, sectors)
        new_count = result["total"]
        # Single-field update. No $set on anything else.
        await db.franchisees.update_one(
            {"id": franchisee_id},
            {"$set": {"territory_home_count": new_count}},
        )
        # Durable audit
        await db[REFRESH_LOG_COLL].insert_one({
            "id": str(uuid.uuid4()),
            "franchisee_id": franchisee_id,
            "franchise_number": fr.get("franchise_number"),
            "previous_count": prev_count,
            "new_count": new_count,
            "sector_count": len(sectors),
            "at": _now().isoformat(),
            "actor": user.get("email"),
        })
        return {
            "status": "ok",
            "franchisee_id": franchisee_id,
            "franchise_number": fr.get("franchise_number"),
            "previous_count": prev_count,
            "new_count": new_count,
            "delta": (new_count - prev_count) if prev_count is not None else None,
            "sector_count": len(sectors),
            "england_count": result["england_count"],
            "scotland_count": result["scotland_count"],
            "per_sector": dict(sorted(result["per_sector"].items())),
            "guarantees": {
                "reads_only": ["cqc_locations_live",
                               "scotland_care_services",
                               "cqc_definition",
                               "scotland_definition"],
                "writes_only": [
                    "franchisees.territory_home_count (single field)",
                    f"{REFRESH_LOG_COLL} (audit row)",
                ],
                "no_writes_to": [
                    "franchisee_clients", "hq_home_notes",
                    "territories", "franchisees.territory_sectors",
                    "franchisees.<any other field>",
                    "contracts", "contacts", "email_sends",
                ],
            },
        }

    return router
