"""Admin-only routes for reconciling duplicate franchise numbers and
performing safe, controlled repairs on individual mis-bound files.

Every endpoint here is read-only OR requires an explicit target
franchisee_id — none of them mutate data based on a franchise_number
lookup alone. This is the deliberate defence against the historical
bug where two records sharing ``franchise_number == "0001"`` caused
Mongo to silently pick one of them.
"""
from __future__ import annotations

import logging
import re
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from franchisee_duplicate_guard import (
    find_franchisees_by_number,
    find_duplicate_groups,
    summarise_franchisee_for_conflict,
)

logger = logging.getLogger("creative-mojo-admin.franchisee_admin")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


async def _hydrate_franchisee_report(db, f: dict) -> dict:
    """Return a rich dict describing everything a reconciler needs to
    decide which record should keep a franchise number: linked portal
    users, indexed file counts, R2 top-level prefixes seen, canonical
    root, contact-conversion origin."""
    from franchisee_folders import (
        canonical_franchisee_prefix,
        compute_fresh_franchisee_prefix,
    )
    fid = f.get("id")
    base = summarise_franchisee_for_conflict(f)
    base.update({
        "updated_at": f.get("updated_at"),
        "record_type": f.get("record_type"),
        "converted_at": f.get("converted_at"),
        "converted_by": f.get("converted_by"),
        "canonical_r2_prefix": canonical_franchisee_prefix(f),
        "fresh_r2_prefix_from_current_fields": compute_fresh_franchisee_prefix(f),
        "r2_root_prefix_persisted": bool(f.get("r2_root_prefix")),
        "r2_root_prefix_set_at": f.get("r2_root_prefix_set_at"),
    })

    # Portal users linked to this exact franchisee_id (or an email match).
    emails = [
        (e or "").lower()
        for e in [f.get("email"), f.get("mojo_email"), f.get("secondary_email")]
        if e
    ]
    u_query = {"$or": [{"franchisee_id": fid}, {"linked_franchisee_id": fid}]}
    if emails:
        u_query["$or"].append({"email": {"$in": emails}})
    users = await db.users.find(
        u_query,
        {"_id": 0, "id": 1, "email": 1, "role": 1, "franchisee_id": 1,
         "linked_franchisee_id": 1, "created_at": 1},
    ).to_list(50)
    base["linked_portal_users"] = users

    # files_index counts and distinct R2 top-level prefixes seen for
    # rows tagged with this franchisee_id.
    total_files = await db.files_index.count_documents({"franchisee_id": fid})
    visible_files = await db.files_index.count_documents({
        "franchisee_id": fid,
        "hidden": {"$ne": True},
        "key": {"$not": re.compile(r"^\.trash/")},
    })
    pipeline = [
        {"$match": {
            "franchisee_id": fid,
            "hidden": {"$ne": True},
            "key": {"$not": re.compile(r"^\.trash/")},
        }},
        {"$project": {
            "top": {"$regexFind": {"input": "$key", "regex": r"^(franchisees/[^/]+/)"}}
        }},
        {"$match": {"top": {"$ne": None}}},
        {"$group": {
            "_id": {"$arrayElemAt": ["$top.captures", 0]},
            "files": {"$sum": 1},
        }},
        {"$sort": {"files": -1}},
    ]
    try:
        roots = await db.files_index.aggregate(pipeline).to_list(20)
    except Exception:  # noqa: BLE001
        roots = []
    base["files_index"] = {
        "total": total_files,
        "visible": visible_files,
        "top_level_r2_prefixes": [
            {"prefix": r["_id"], "files": r["files"]} for r in roots
        ],
    }
    return base


def build_router(db, require_role) -> APIRouter:
    router = APIRouter()

    # -----------------------------------------------------------------
    # Every group of ≥2 franchisees that share a franchise_number.
    # Returns hydrated details (linked users, files, r2 prefix) so the
    # reconciler can decide which record should retain the number
    # without further clicks.
    @router.get("/admin/franchisees/duplicates")
    async def duplicates(_user: dict = Depends(require_role("admin"))):
        groups = await find_duplicate_groups(db)
        out: list[dict] = []
        for g in groups:
            records = [await _hydrate_franchisee_report(db, r) for r in g["records"]]
            out.append({
                "franchise_number": g["franchise_number"],
                "record_count": len(records),
                "records": records,
            })
        # Alphabetical order for a stable UI.
        out.sort(key=lambda x: x["franchise_number"])
        return {"groups": out, "count": len(out)}

    # -----------------------------------------------------------------
    # Deterministic "list all franchisees using this number" lookup.
    # Unlike ``find_one`` this never silently picks one; when the number
    # is unused it returns ``[]`` (200), and the caller can react.
    @router.get("/admin/franchisees/by-number/{fn}")
    async def by_number(fn: str, _user: dict = Depends(require_role("admin"))):
        rows = await find_franchisees_by_number(db, fn)
        return {
            "franchise_number_query": fn,
            "count": len(rows),
            "records": [await _hydrate_franchisee_report(db, r) for r in rows],
        }

    # -----------------------------------------------------------------
    # Controlled repair — rebind a single files_index row (by exact R2
    # key) to a specific franchisee_id. Used ONLY after a human has
    # reviewed the duplicates report and decided which record the file
    # actually belongs to. Never derives a franchisee from the number.
    @router.post("/admin/files/rebind-single")
    async def rebind_single(
        body: dict,
        user: dict = Depends(require_role("admin")),
    ):
        key = (body or {}).get("key")
        target_fid = (body or {}).get("franchisee_id")
        if not key or not target_fid:
            raise HTTPException(400, detail="key and franchisee_id are required")

        target = await db.franchisees.find_one(
            {"id": target_fid}, {"_id": 0, "id": 1, "franchise_number": 1, "organisation": 1},
        )
        if not target:
            raise HTTPException(404, detail=f"Franchisee {target_fid} not found")

        row = await db.files_index.find_one({"key": key}, {"_id": 0})
        if not row:
            raise HTTPException(404, detail=f"No files_index row for key {key!r}")

        previous_fid = row.get("franchisee_id")
        if previous_fid == target_fid:
            return {"ok": True, "changed": False, "reason": "already bound", "row": row}

        now = _now_iso()
        # Persist an audit trail on the row itself so we can trace the
        # rebind later without a separate collection.
        rebind_history = list(row.get("rebind_history") or [])
        rebind_history.append({
            "at": now,
            "by": user.get("email"),
            "from": previous_fid,
            "to": target_fid,
            "reason": (body or {}).get("reason") or "manual admin repair",
        })
        await db.files_index.update_one(
            {"key": key},
            {"$set": {
                "franchisee_id": target_fid,
                "rebind_history": rebind_history,
                "updated_at": now,
                "updated_by": user.get("email"),
            }},
        )
        # Structured log so we have an off-DB trail.
        logger.info(
            "admin.files.rebind-single key=%s from=%s to=%s by=%s",
            key, previous_fid, target_fid, user.get("email"),
        )
        return {
            "ok": True,
            "changed": True,
            "key": key,
            "previous_franchisee_id": previous_fid,
            "new_franchisee_id": target_fid,
            "franchise_number": target.get("franchise_number"),
            "organisation": target.get("organisation"),
            "rebind_history": rebind_history,
        }

    return router
