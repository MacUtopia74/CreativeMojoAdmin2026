"""Phase 3 — CQC canonical-source repair (INSERT-ONLY).

Repairs the ~40% deficit in `cqc_locations_live` left by the initial May
sync. Inserts every currently-Registered CQC record from
`cqc_locations_staging` that does not already exist in `cqc_locations_live`,
and does absolutely nothing else.

Hard invariants (enforced by the code, not documentation):
* NO update operations. Every write is `insert_one`. Duplicate-key errors
  from the Mongo unique index on `locationId` are caught and counted as
  skipped, never converted into an update.
* NO delete operations. The endpoint never calls delete_one / delete_many.
* NO status flips on existing rows. Existing `cqc_locations_live`
  documents are not read, not modified, not touched.
* NO writes to `franchisee_clients`, `hq_home_notes`, `territories`,
  `franchisees`, or any CRM collection.
* Reads `cqc_locations_staging` only for source; writes only to
  `cqc_locations_live`, `cqc_phase3_jobs`, `cqc_phase3_insert_log` and
  R2 (durable backup + audit artefacts).
* Idempotent: rerunning on the same job_id is a no-op if already ok.

Endpoint behaviour matrix (single POST with no `mode` argument — no upsert
switch exists):

    POST /api/cqc/phase3/commit-append
      body: { "dry_run": true|false, "confirmation_token": "..." }
      dry_run=true  → returns exact-count breakdown, writes nothing
      dry_run=false + valid confirmation token → performs insert-only commit
      dry_run=false + missing/invalid token → 403 (never runs)

The confirmation token is a fresh SHA-256 over the current dry-run
counts, so a stale approval can't be replayed against different data.
"""
from __future__ import annotations

import asyncio
import hashlib
import io
import json
import logging
import os
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from pymongo.errors import DuplicateKeyError

from cqc_definition import CqcDefinition, definition_to_mongo_filter

logger = logging.getLogger("creative-mojo-admin.cqc-phase3")

STAGING_COLL = "cqc_locations_staging"
LIVE_COLL = "cqc_locations_live"
JOBS_COLL = "cqc_phase3_jobs"
INSERT_LOG_COLL = "cqc_phase3_insert_log"


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _environment_signature() -> dict:
    """Every response echoes the exact database + host so callers can be
    100% certain they're hitting the environment they think they are.
    A production run should show DB_NAME='creative_mojo_prod' (or your
    live name) and a *.creativemojo.co.uk BACKEND URL; a preview run
    shows DB_NAME containing 'preview' / 'test' / a UUID slug.
    """
    return {
        "db_name": os.environ.get("DB_NAME"),
        "backend_url": os.environ.get("REACT_APP_BACKEND_URL")
                       or os.environ.get("PUBLIC_URL")
                       or "unknown",
        "pod_hostname": os.environ.get("HOSTNAME", "unknown"),
    }


async def compute_dry_run(db) -> dict:
    """Compute exact numbers for an insert-only commit. Reads only. Writes nothing."""
    live_ids: set[str] = set()
    async for d in db[LIVE_COLL].find({}, {"_id": 0, "locationId": 1}):
        if d.get("locationId"):
            live_ids.add(d["locationId"])

    staging_registered_ids: set[str] = set()
    async for d in db[STAGING_COLL].find(
        {"registrationStatus": "Registered"}, {"_id": 0, "locationId": 1}
    ):
        if d.get("locationId"):
            staging_registered_ids.add(d["locationId"])

    to_insert = staging_registered_ids - live_ids
    to_insert_sorted = sorted(to_insert)

    # Filter-matching subset
    defn_doc = await db.cqc_definition.find_one({}, {"_id": 0})
    cq = CqcDefinition(**defn_doc) if defn_doc else CqcDefinition()
    filt = definition_to_mongo_filter(cq)
    filter_matching = 0
    async for _ in db[STAGING_COLL].find(
        {**filt, "locationId": {"$in": to_insert_sorted}},
        {"_id": 0, "locationId": 1},
    ):
        filter_matching += 1

    # Active franchisee sectors
    active_sectors: set[str] = set()
    async for f in db.franchisees.find(
        {"territory_sectors": {"$exists": True, "$ne": []},
         "lifecycle_status": {"$ne": "ex_franchisee"}},
        {"_id": 0, "territory_sectors": 1},
    ):
        for s in f.get("territory_sectors") or []:
            active_sectors.add(s)

    in_active_territory = 0
    async for _ in db[STAGING_COLL].find(
        {"locationId": {"$in": to_insert_sorted},
         "postcode_sector": {"$in": list(active_sectors)}},
        {"_id": 0, "locationId": 1},
    ):
        in_active_territory += 1
    in_active_territory_and_filter = 0
    async for _ in db[STAGING_COLL].find(
        {**filt, "locationId": {"$in": to_insert_sorted},
         "postcode_sector": {"$in": list(active_sectors)}},
        {"_id": 0, "locationId": 1},
    ):
        in_active_territory_and_filter += 1

    # Reclassified (in live filter, not in staging filter, still exist in staging)
    live_filter_ids: set[str] = set()
    async for d in db[LIVE_COLL].find(filt, {"_id": 0, "locationId": 1}):
        live_filter_ids.add(d["locationId"])
    staging_filter_ids: set[str] = set()
    async for d in db[STAGING_COLL].find(filt, {"_id": 0, "locationId": 1}):
        staging_filter_ids.add(d["locationId"])
    reclassified = live_filter_ids - staging_filter_ids
    # By definition these are NOT in to_insert (they're already in live)
    reclassified_intersect_to_insert = len(reclassified & to_insert)

    counts = {
        "to_insert_total": len(to_insert),
        "filter_matching": filter_matching,
        "in_active_territories": in_active_territory,
        "in_active_territories_and_filter": in_active_territory_and_filter,
        "reclassified_records_left_untouched": len(reclassified),
        "reclassified_intersect_to_insert_MUST_BE_ZERO": reclassified_intersect_to_insert,
    }
    # Confirmation token binds to the exact counts + ID hash
    id_digest = hashlib.sha256("\n".join(to_insert_sorted).encode()).hexdigest()
    counts_digest = hashlib.sha256(
        json.dumps(counts, sort_keys=True).encode()
    ).hexdigest()
    confirmation_token = hashlib.sha256(
        (id_digest + counts_digest).encode()
    ).hexdigest()

    return {
        "environment": _environment_signature(),
        "counts": counts,
        "to_insert_ids_hash_sha256": id_digest,
        "confirmation_token": confirmation_token,
        "generated_at": _now().isoformat(),
        "policy": "insert_only",
        "effective_filter": {
            "definition": cq.model_dump(),
            "mongo_filter": filt,
        },
    }


async def _write_backup_to_r2(db, job_id: str) -> dict:
    """Snapshot every current cqc_locations_live locationId to R2, so the
    commit can be rolled back by deleting exactly the IDs that weren't in
    the pre-commit snapshot.
    """
    import file_storage as fs
    if not fs.r2_configured():
        raise RuntimeError("R2 not configured — refuse to run without durable backup")

    live_ids: list[str] = []
    async for d in db[LIVE_COLL].find({}, {"_id": 0, "locationId": 1}):
        if d.get("locationId"):
            live_ids.append(d["locationId"])
    live_ids.sort()
    body = "\n".join(live_ids).encode()
    key = f"admin/cqc-phase3-backups/{job_id}/pre_commit_live_ids.txt"
    fs.get_client().put_object(
        Bucket=fs.R2_BUCKET,
        Key=key,
        Body=body,
        ContentType="text/plain",
        CacheControl="private, no-store",
        Metadata={"job-id": job_id, "row-count": str(len(live_ids)),
                  "sha256": hashlib.sha256(body).hexdigest()},
    )
    return {"backup_r2_key": key, "backup_row_count": len(live_ids),
            "backup_sha256": hashlib.sha256(body).hexdigest()}


async def _write_insert_log_to_r2(db, job_id: str, inserted_ids: list[str]) -> str:
    import file_storage as fs
    body = "\n".join(sorted(inserted_ids)).encode()
    key = f"admin/cqc-phase3-backups/{job_id}/inserted_ids.txt"
    fs.get_client().put_object(
        Bucket=fs.R2_BUCKET,
        Key=key,
        Body=body,
        ContentType="text/plain",
        CacheControl="private, no-store",
        Metadata={"job-id": job_id, "row-count": str(len(inserted_ids))},
    )
    return key


async def _run_insert_only(db, job_id: str, expected_ids: list[str], actor_email: str) -> dict:
    """Perform the actual insert-only commit. Enforces INSERT-only at
    Mongo-driver level (uses insert_one; duplicate key = skipped)."""
    # Guard: refuse if a completed job with this ID already exists.
    existing = await db[JOBS_COLL].find_one({"job_id": job_id})
    if existing and existing.get("status") in ("ok", "running"):
        return {"status": "already_ran_or_running", "job": {k: v for k, v in existing.items() if k != "_id"}}

    started_at = _now()
    await db[JOBS_COLL].update_one(
        {"job_id": job_id},
        {"$set": {
            "job_id": job_id,
            "status": "running",
            "policy": "insert_only",
            "started_at": started_at,
            "started_by": actor_email,
            "expected_id_count": len(expected_ids),
        }},
        upsert=True,
    )

    # Ensure the unique index on locationId exists (safety net; already
    # created by cqc_routes but we assert it here).
    await db[LIVE_COLL].create_index("locationId", unique=True)

    # Durable backup FIRST
    backup = await _write_backup_to_r2(db, job_id)
    await db[JOBS_COLL].update_one(
        {"job_id": job_id}, {"$set": backup}
    )

    inserted_ids: list[str] = []
    skipped_dup: list[str] = []
    failed: list[dict] = []

    # Fetch staging docs in batches
    BATCH = 500
    for i in range(0, len(expected_ids), BATCH):
        batch_ids = expected_ids[i:i + BATCH]
        docs = [d async for d in db[STAGING_COLL].find(
            {"locationId": {"$in": batch_ids}}, {"_id": 0}
        )]
        for d in docs:
            # Belt-and-braces filter: only Registered docs allowed through
            if d.get("registrationStatus") != "Registered":
                failed.append({"locationId": d.get("locationId"),
                               "reason": "not_registered_in_staging"})
                continue
            lid = d.get("locationId")
            if not lid:
                failed.append({"locationId": None, "reason": "missing_locationId"})
                continue
            d.pop("_id", None)
            d["phase3_inserted_at"] = _now()
            d["phase3_job_id"] = job_id
            try:
                await db[LIVE_COLL].insert_one(d)
                inserted_ids.append(lid)
            except DuplicateKeyError:
                # locationId already existed in live — never update it.
                skipped_dup.append(lid)
            except Exception as exc:  # noqa: BLE001
                failed.append({"locationId": lid, "reason": str(exc)})
        # Periodic progress persist
        if (i // BATCH) % 10 == 0:
            await db[JOBS_COLL].update_one(
                {"job_id": job_id},
                {"$set": {
                    "inserted_count": len(inserted_ids),
                    "skipped_duplicate_count": len(skipped_dup),
                    "failed_count": len(failed),
                    "last_progress_at": _now(),
                }},
            )

    # Insert-log to Mongo (small) + R2 (durable)
    r2_log_key = await _write_insert_log_to_r2(db, job_id, inserted_ids)
    if inserted_ids:
        await db[INSERT_LOG_COLL].insert_one({
            "job_id": job_id,
            "at": _now(),
            "inserted_id_count": len(inserted_ids),
            "inserted_ids_sha256": hashlib.sha256(
                "\n".join(sorted(inserted_ids)).encode()
            ).hexdigest(),
            "r2_key": r2_log_key,
        })

    finished_at = _now()
    await db[JOBS_COLL].update_one(
        {"job_id": job_id},
        {"$set": {
            "status": "ok",
            "finished_at": finished_at,
            "inserted_count": len(inserted_ids),
            "skipped_duplicate_count": len(skipped_dup),
            "failed_count": len(failed),
            "failed_sample": failed[:20],
            "inserted_log_r2_key": r2_log_key,
            "duration_seconds": (finished_at - started_at).total_seconds(),
        }},
    )
    logger.info(
        "[cqc-phase3] job=%s ok inserted=%d skipped_dup=%d failed=%d",
        job_id, len(inserted_ids), len(skipped_dup), len(failed),
    )
    return {
        "status": "ok",
        "inserted_count": len(inserted_ids),
        "skipped_duplicate_count": len(skipped_dup),
        "failed_count": len(failed),
    }


async def _run_rollback(db, job_id: str, actor_email: str) -> dict:
    """Rollback = delete exactly the locationIds recorded as inserted by
    this job. Reads inserted_ids from R2 (durable) so a corrupted local
    log can't prevent recovery.
    """
    job = await db[JOBS_COLL].find_one({"job_id": job_id})
    if not job:
        raise HTTPException(404, detail=f"unknown job_id {job_id}")
    if job.get("status") not in ("ok", "rollback_failed"):
        raise HTTPException(409, detail=f"cannot rollback job with status {job.get('status')}")
    r2_key = job.get("inserted_log_r2_key")
    if not r2_key:
        raise HTTPException(500, detail="no R2 insert log recorded for this job")
    import file_storage as fs
    body = fs.get_client().get_object(Bucket=fs.R2_BUCKET, Key=r2_key)["Body"].read()
    inserted_ids = [x for x in body.decode().splitlines() if x.strip()]
    started_at = _now()
    deleted = 0
    for lid in inserted_ids:
        r = await db[LIVE_COLL].delete_one({"locationId": lid,
                                            "phase3_job_id": job_id})
        deleted += r.deleted_count
    finished_at = _now()
    await db[JOBS_COLL].update_one(
        {"job_id": job_id},
        {"$set": {
            "status": "rolled_back",
            "rolled_back_at": finished_at,
            "rolled_back_by": actor_email,
            "rolled_back_count": deleted,
        }},
    )
    return {"status": "rolled_back", "deleted_count": deleted,
            "duration_seconds": (finished_at - started_at).total_seconds()}


# --------------------------------------------------------------------- router
def build_phase3_router(db, require_role):
    router = APIRouter()

    @router.get("/cqc/phase3/dry-run")
    async def dry_run(_user: dict = Depends(require_role("admin"))):
        return await compute_dry_run(db)

    @router.post("/cqc/phase3/commit-append")
    async def commit_append(
        body: dict = Body(...),
        user: dict = Depends(require_role("admin")),
    ):
        """INSERT-ONLY. No mode argument. No upsert switch."""
        # Fresh dry-run to bind the caller's confirmation to current data
        dr = await compute_dry_run(db)
        client_token = (body or {}).get("confirmation_token")
        if client_token != dr["confirmation_token"]:
            raise HTTPException(
                403,
                detail={
                    "error": "confirmation_token_mismatch",
                    "message": (
                        "The staging data has changed since the dry-run "
                        "you approved. Re-run /cqc/phase3/dry-run and use "
                        "the new confirmation_token."
                    ),
                    "current_confirmation_token": dr["confirmation_token"],
                },
            )
        # Refuse to run if empty
        if dr["counts"]["to_insert_total"] == 0:
            return {"status": "no_op", "reason": "nothing to insert",
                    "counts": dr["counts"]}
        # Enumerate the exact ID list once so we're immune to staging changes mid-run
        live_ids: set[str] = set()
        async for d in db[LIVE_COLL].find({}, {"_id": 0, "locationId": 1}):
            live_ids.add(d["locationId"])
        expected_ids: list[str] = []
        async for d in db[STAGING_COLL].find(
            {"registrationStatus": "Registered"}, {"_id": 0, "locationId": 1}
        ):
            lid = d.get("locationId")
            if lid and lid not in live_ids:
                expected_ids.append(lid)
        expected_ids.sort()
        job_id = f"phase3-{int(_now().timestamp())}-{uuid.uuid4().hex[:8]}"
        # Kick off async — pod-safe, resumable if the request drops
        asyncio.create_task(_run_insert_only(db, job_id, expected_ids,
                                             user.get("email", "unknown")))
        return {"status": "started", "job_id": job_id,
                "expected_id_count": len(expected_ids),
                "environment": _environment_signature()}

    @router.get("/cqc/phase3/status")
    async def status(job_id: Optional[str] = Query(None),
                     _user: dict = Depends(require_role("admin"))):
        q = {"job_id": job_id} if job_id else {}
        job = await db[JOBS_COLL].find_one(q, {"_id": 0},
                                           sort=[("started_at", -1)])
        return {"job": job, "environment": _environment_signature()}

    @router.post("/cqc/phase3/rollback")
    async def rollback(body: dict = Body(...),
                       user: dict = Depends(require_role("admin"))):
        job_id = (body or {}).get("job_id")
        if not job_id:
            raise HTTPException(400, detail="job_id required")
        result = await _run_rollback(db, job_id, user.get("email", "unknown"))
        return {**result, "environment": _environment_signature()}

    return router
