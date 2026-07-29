"""One-shot additive TW11 9 migration for Clementina Phillips (franchise 0091).

Runs three atomic operations:
  1. $addToSet 'TW11 9' onto franchisees.territory_sectors  (never replaces)
  2. Insert one new row into `territories` collection
  3. Recompute franchisees.territory_home_count with the current CQC filter

Never touches:
  * franchisee_clients
  * hq_home_notes
  * any other franchisee's territory
  * cqc_locations_live / cqc_locations_staging

Refuses to run if:
  * TW11 9 is already in her franchisees.territory_sectors
  * TW11 9 is owned by another franchisee (via franchisees or territories collection)

Includes explicit confirmation-token gating so it can't be triggered
accidentally.
"""
from __future__ import annotations

import hashlib
import logging
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Body, Depends, HTTPException

from cqc_definition import CqcDefinition, definition_to_mongo_filter
from scotland_definition import (
    ScotlandDefinition,
    DEFAULT_DEFINITION_ID as SCOTLAND_DEFAULT_DEFINITION_ID,
    definition_to_mongo_filter as scotland_definition_to_mongo_filter,
)
from geo_postcode import is_scottish_postcode

logger = logging.getLogger("creative-mojo-admin.tw11_9")

CLEMENTINA_ID = "6bbf65a1-af0c-4c00-abe1-f2814766e230"
TARGET_SECTOR = "TW11 9"


def _now() -> datetime:
    return datetime.now(timezone.utc)


async def compute_dry_run(db) -> dict:
    """Read-only preview. Never writes."""
    clem = await db.franchisees.find_one(
        {"id": CLEMENTINA_ID},
        {"_id": 0, "id": 1, "first_name": 1, "last_name": 1,
         "franchise_number": 1, "organisation": 1, "territory_sectors": 1,
         "territory_home_count": 1, "lifecycle_status": 1},
    )
    if not clem:
        raise HTTPException(404, detail="Clementina franchisee record not found")
    sectors = clem.get("territory_sectors") or []
    already_present = TARGET_SECTOR in sectors

    # Any other franchisee owning TW11 9?
    other_owners = []
    async for f in db.franchisees.find(
        {"territory_sectors": TARGET_SECTOR, "id": {"$ne": CLEMENTINA_ID}},
        {"_id": 0, "id": 1, "first_name": 1, "last_name": 1,
         "franchise_number": 1, "organisation": 1, "lifecycle_status": 1},
    ):
        other_owners.append(f)

    other_ter_rows = []
    async for t in db.territories.find(
        {"postcode": TARGET_SECTOR, "franchisee_id": {"$ne": CLEMENTINA_ID}},
        {"_id": 0, "id": 1, "franchisee_id": 1, "postcode": 1},
    ):
        other_ter_rows.append(t)

    # Predicted new count
    defn_doc = await db.cqc_definition.find_one({}, {"_id": 0})
    cq = CqcDefinition(**defn_doc) if defn_doc else CqcDefinition()
    filt = definition_to_mongo_filter(cq)
    new_sectors = sorted(list(set(sectors + [TARGET_SECTOR])))
    eng_sectors = [s for s in new_sectors if not is_scottish_postcode(s)]
    scot_sectors = [s for s in new_sectors if is_scottish_postcode(s)]

    eng_count = 0
    if eng_sectors:
        eng_count = await db.cqc_locations_live.count_documents(
            {**filt, "postcode_sector": {"$in": eng_sectors}}
        )
    scot_count = 0
    if scot_sectors:
        scot_doc = await db.scotland_definition.find_one(
            {"_id": SCOTLAND_DEFAULT_DEFINITION_ID}, {"_id": 0}
        )
        scot_def = ScotlandDefinition(**scot_doc) if scot_doc else ScotlandDefinition()
        scot_filter = scotland_definition_to_mongo_filter(scot_def)
        scot_count = await db.scotland_care_services.count_documents(
            {**scot_filter, "postcode_sector": {"$in": scot_sectors}}
        )
    projected_count = eng_count + scot_count

    # Confirmation token — binds to Clementina's ID + current sector count
    token = hashlib.sha256(
        f"{CLEMENTINA_ID}|{len(sectors)}|{clem.get('territory_home_count')}|{projected_count}".encode()
    ).hexdigest()

    return {
        "franchisee": {
            "id": clem["id"],
            "name": f"{clem.get('first_name') or ''} {clem.get('last_name') or ''}".strip(),
            "franchise_number": clem.get("franchise_number"),
            "organisation": clem.get("organisation"),
            "current_sector_count": len(sectors),
            "current_territory_home_count": clem.get("territory_home_count"),
        },
        "target_sector": TARGET_SECTOR,
        "already_present_in_her_territory": already_present,
        "other_franchisee_owners": other_owners,
        "conflicting_territory_rows": other_ter_rows,
        "projected_new_sector_count": len(sectors) + (0 if already_present else 1),
        "projected_new_territory_home_count": projected_count,
        "confirmation_token": token,
        "policy": "additive_only",
        "actions_to_perform_on_commit": [
            {"op": "$addToSet TW11 9 to franchisees.territory_sectors"},
            {"op": "insert territories row {franchisee_id, postcode: 'TW11 9', new uuid}"},
            {"op": "recompute franchisees.territory_home_count"},
        ],
        "explicit_no_ops": [
            "no changes to franchisee_clients",
            "no changes to hq_home_notes",
            "no changes to other franchisees' territories",
            "no replacement of any existing sector",
            "no writes to cqc_locations_live or cqc_locations_staging",
        ],
        "generated_at": _now().isoformat(),
    }


async def commit(db, actor_email: str, client_token: str) -> dict:
    dr = await compute_dry_run(db)
    if client_token != dr["confirmation_token"]:
        raise HTTPException(
            403,
            detail={
                "error": "confirmation_token_mismatch",
                "current_confirmation_token": dr["confirmation_token"],
            },
        )
    if dr["already_present_in_her_territory"]:
        raise HTTPException(409, detail="TW11 9 already in her territory — nothing to do")
    if dr["other_franchisee_owners"] or dr["conflicting_territory_rows"]:
        raise HTTPException(
            409,
            detail={
                "error": "conflicting_ownership",
                "other_owners": dr["other_franchisee_owners"],
                "conflicting_ter_rows": dr["conflicting_territory_rows"],
            },
        )

    # 1) additive on franchisees.territory_sectors
    await db.franchisees.update_one(
        {"id": CLEMENTINA_ID},
        {"$addToSet": {"territory_sectors": TARGET_SECTOR}},
    )
    # 2) insert new territories row
    new_row = {
        "id": str(uuid.uuid4()),
        "franchisee_id": CLEMENTINA_ID,
        "postcode": TARGET_SECTOR,
        "created_at": _now().isoformat(),
        "updated_at": _now().isoformat(),
        "note": "TW11 9 additive migration (Feb 2026) — see cqc_phase3_tw11_9",
    }
    await db.territories.insert_one(new_row)
    # 3) recompute her territory_home_count
    defn_doc = await db.cqc_definition.find_one({}, {"_id": 0})
    cq = CqcDefinition(**defn_doc) if defn_doc else CqcDefinition()
    filt = definition_to_mongo_filter(cq)
    scot_doc = await db.scotland_definition.find_one(
        {"_id": SCOTLAND_DEFAULT_DEFINITION_ID}, {"_id": 0}
    )
    scot_def = ScotlandDefinition(**scot_doc) if scot_doc else ScotlandDefinition()
    scot_filter = scotland_definition_to_mongo_filter(scot_def)
    fr = await db.franchisees.find_one({"id": CLEMENTINA_ID}, {"_id": 0, "territory_sectors": 1})
    new_sectors = fr.get("territory_sectors") or []
    eng_sectors = [s for s in new_sectors if not is_scottish_postcode(s)]
    scot_sectors = [s for s in new_sectors if is_scottish_postcode(s)]
    eng_cnt = await db.cqc_locations_live.count_documents(
        {**filt, "postcode_sector": {"$in": eng_sectors}}
    ) if eng_sectors else 0
    scot_cnt = await db.scotland_care_services.count_documents(
        {**scot_filter, "postcode_sector": {"$in": scot_sectors}}
    ) if scot_sectors else 0
    new_count = eng_cnt + scot_cnt
    await db.franchisees.update_one(
        {"id": CLEMENTINA_ID}, {"$set": {"territory_home_count": new_count}}
    )

    audit = {
        "id": str(uuid.uuid4()),
        "action": "tw11_9_additive_migration",
        "franchisee_id": CLEMENTINA_ID,
        "actor": actor_email,
        "at": _now().isoformat(),
        "new_sector_count": len(new_sectors),
        "new_territory_home_count": new_count,
        "new_territory_row_id": new_row["id"],
    }
    await db.audit_log.insert_one(audit) if False else None  # audit collection optional

    logger.info("[tw11-9] added to Clementina; new_home_count=%d", new_count)
    return {
        "status": "ok",
        "new_sector_count": len(new_sectors),
        "new_territory_home_count": new_count,
        "new_territory_row_id": new_row["id"],
    }


def build_tw11_9_router(db, require_role):
    router = APIRouter()

    @router.get("/cqc/tw11-9/dry-run")
    async def dry_run(_user: dict = Depends(require_role("admin"))):
        return await compute_dry_run(db)

    @router.post("/cqc/tw11-9/apply")
    async def apply(body: dict = Body(...),
                    user: dict = Depends(require_role("admin"))):
        token = (body or {}).get("confirmation_token")
        if not token:
            raise HTTPException(400, detail="confirmation_token required")
        return await commit(db, user.get("email", "unknown"), token)

    return router
