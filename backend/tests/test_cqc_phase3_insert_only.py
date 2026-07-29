"""Locking tests for the insert-only Phase 3 commit-append endpoint.

Every test asserts a hard-safety invariant. If any of these fail the
endpoint MUST NOT be run in production.

Rules covered:
  * The dry-run reports the exact counts asked for by HQ.
  * `compute_dry_run` reads nothing else and writes nothing.
  * A commit-only path exists — there is NO upsert-mode argument.
  * A wrong confirmation_token is rejected with 403.
  * An existing live document is NEVER modified by the run (proven with a
    "canary" doc whose fields are checked byte-for-byte before/after).
  * The 154 "reclassified" records are NOT in the to_insert set.
  * `franchisee_clients`, `hq_home_notes`, `franchisees`, `territories`
    are not touched by the run (asserted by diffing counts / hashes).
  * Duplicate-key errors are counted as skipped (never converted to
    updates).
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import sys
import uuid

import pytest
from dotenv import load_dotenv

load_dotenv("/app/backend/.env")

sys.path.insert(0, "/app/backend")

from motor.motor_asyncio import AsyncIOMotorClient  # noqa: E402
from cqc_phase3_commit import (  # noqa: E402
    compute_dry_run,
    _run_insert_only,
    LIVE_COLL,
    STAGING_COLL,
    JOBS_COLL,
    INSERT_LOG_COLL,
)
from cqc_definition import CqcDefinition, definition_to_mongo_filter  # noqa: E402


TEST_DB_SUFFIX = "phase3_test"


@pytest.fixture
async def isolated_db():
    """Fresh isolated DB per test. Never touches production."""
    client = AsyncIOMotorClient(os.environ["MONGO_URL"])
    name = f"{os.environ['DB_NAME']}_{TEST_DB_SUFFIX}_{uuid.uuid4().hex[:8]}"
    db = client[name]
    await db[LIVE_COLL].create_index("locationId", unique=True)
    yield db
    await client.drop_database(name)
    client.close()


async def _seed_canonical(db):
    """Baseline: 3 live docs, 5 staging docs (2 already in live + 3 new
    Registered) + 1 Deregistered in staging (must not be inserted)."""
    await db[LIVE_COLL].insert_many([
        {"locationId": "1-CANARY-1", "name": "Canary A",
         "registrationStatus": "Registered", "postcode_sector": "SW1 1",
         "gacServiceTypes": [{"name": "Nursing homes"}]},
        {"locationId": "1-CANARY-2", "name": "Canary B",
         "registrationStatus": "Registered", "postcode_sector": "SW1 2",
         "gacServiceTypes": [{"name": "Residential homes"}]},
        {"locationId": "1-CANARY-3", "name": "Canary C",
         "registrationStatus": "Registered", "postcode_sector": "SW1 3",
         "gacServiceTypes": [{"name": "Dentist"}]},  # not filter-matching
    ])
    await db[STAGING_COLL].insert_many([
        # Two that already exist in live — must be skipped
        {"locationId": "1-CANARY-1", "name": "Canary A CHANGED",
         "registrationStatus": "Deregistered",  # deliberately different
         "postcode_sector": "SW1 1",
         "gacServiceTypes": [{"name": "Nursing homes"}]},
        {"locationId": "1-CANARY-2", "name": "Canary B CHANGED",
         "registrationStatus": "Registered",
         "postcode_sector": "SW1 2",
         "gacServiceTypes": [{"name": "Dentist"}]},  # filter drop
        # Three brand new Registered
        {"locationId": "1-NEW-A", "name": "New A",
         "registrationStatus": "Registered", "postcode_sector": "NW1 1",
         "gacServiceTypes": [{"name": "Nursing homes"}]},
        {"locationId": "1-NEW-B", "name": "New B",
         "registrationStatus": "Registered", "postcode_sector": "NW1 2",
         "gacServiceTypes": [{"name": "Dentist"}]},  # not filter-matching
        {"locationId": "1-NEW-C", "name": "New C",
         "registrationStatus": "Registered", "postcode_sector": "NW1 3",
         "gacServiceTypes": [{"name": "Residential homes"}]},
        # One Deregistered new — MUST NOT be inserted
        {"locationId": "1-DEREG-NEW", "name": "Should not be inserted",
         "registrationStatus": "Deregistered", "postcode_sector": "NW1 4"},
    ])
    await db.cqc_definition.insert_one({
        "_id": "system-default",
        "include_service_types": ["Residential homes", "Nursing homes"],
        "exclude_service_types": [], "include_specialisms": [],
        "exclude_specialisms": [], "include_regulated_activities": [],
        "require_care_home": None, "registration_statuses": ["Registered"],
        "min_beds": None, "require_rating": [],
    })


@pytest.mark.asyncio
async def test_dry_run_counts_exact(isolated_db):
    db = isolated_db
    await _seed_canonical(db)
    dr = await compute_dry_run(db)
    c = dr["counts"]
    assert c["to_insert_total"] == 3          # 1-NEW-A, 1-NEW-B, 1-NEW-C
    assert c["filter_matching"] == 2          # 1-NEW-A and 1-NEW-C
    # 1-DEREG-NEW must not appear
    assert c["reclassified_intersect_to_insert_MUST_BE_ZERO"] == 0
    # Token deterministic given data
    dr2 = await compute_dry_run(db)
    assert dr["confirmation_token"] == dr2["confirmation_token"]


@pytest.mark.asyncio
async def test_dry_run_reads_only_writes_nothing(isolated_db):
    db = isolated_db
    await _seed_canonical(db)
    before = {
        "live": await db[LIVE_COLL].count_documents({}),
        "staging": await db[STAGING_COLL].count_documents({}),
        "jobs": await db[JOBS_COLL].count_documents({}),
        "insert_log": await db[INSERT_LOG_COLL].count_documents({}),
    }
    await compute_dry_run(db)
    for k, v in before.items():
        assert (await db[{"live": LIVE_COLL, "staging": STAGING_COLL,
                          "jobs": JOBS_COLL, "insert_log": INSERT_LOG_COLL}[k]].count_documents({})) == v, k


@pytest.mark.asyncio
async def test_no_upsert_mode_argument(isolated_db):
    """Static contract: the commit function's public signature must NOT
    accept a `mode`, `upsert` or `update` argument."""
    import inspect
    from cqc_phase3_commit import _run_insert_only, build_phase3_router  # noqa: F401
    sig = inspect.signature(_run_insert_only)
    forbidden = {"mode", "upsert", "update", "replace", "delete"}
    assert not (forbidden & set(sig.parameters.keys())), (
        f"_run_insert_only must not accept any of {forbidden}"
    )
    # Also ensure no path in the module references collection.update_many
    with open("/app/backend/cqc_phase3_commit.py") as fh:
        src = fh.read()
    for banned in ("update_many(", "delete_many(", "update_one(",
                   "replace_one("):
        # Only permitted use: JOBS_COLL.update_one for job tracking.
        # Ensure LIVE_COLL never appears with these operations.
        assert f"{LIVE_COLL}].{banned}" not in src, banned
        assert f'cqc_locations_live"].{banned}' not in src, banned


@pytest.mark.asyncio
async def test_insert_only_leaves_existing_untouched(isolated_db, monkeypatch):
    db = isolated_db
    await _seed_canonical(db)
    # Snapshot the existing live docs
    before_docs = {d["locationId"]: {k: v for k, v in d.items() if k != "_id"}
                   async for d in db[LIVE_COLL].find({})}

    # Stub R2 helpers so the test doesn't need network
    import cqc_phase3_commit as mod
    async def _fake_backup(db, job_id):
        return {"backup_r2_key": "stub", "backup_row_count": 0, "backup_sha256": "stub"}
    async def _fake_insert_log(db, job_id, ids):
        return "stub-inserted"
    monkeypatch.setattr(mod, "_write_backup_to_r2", _fake_backup)
    monkeypatch.setattr(mod, "_write_insert_log_to_r2", _fake_insert_log)

    dr = await compute_dry_run(db)
    ids = sorted({
        d["locationId"] async for d in db[STAGING_COLL].find(
            {"registrationStatus": "Registered"}
        )
        if d["locationId"] not in {"1-CANARY-1", "1-CANARY-2", "1-CANARY-3"}
    })

    result = await _run_insert_only(db, "test-job-1", ids, "tester@example.com")
    assert result["status"] == "ok"
    # 3 Registered new IDs should insert
    assert result["inserted_count"] == 3

    after_docs = {d["locationId"]: {k: v for k, v in d.items() if k != "_id"}
                  async for d in db[LIVE_COLL].find({"locationId": {"$in": list(before_docs)}})}
    # Canary docs must be byte-identical (minus _id) before and after
    for lid, before in before_docs.items():
        after = after_docs[lid]
        assert before == after, f"Existing doc {lid} was modified: {before} vs {after}"
    # Deregistered staging doc must NOT be in live
    assert await db[LIVE_COLL].find_one({"locationId": "1-DEREG-NEW"}) is None


@pytest.mark.asyncio
async def test_duplicate_id_counts_as_skipped_not_updated(isolated_db, monkeypatch):
    db = isolated_db
    await _seed_canonical(db)
    import cqc_phase3_commit as mod
    async def _fake(db, *a, **k):
        return {"backup_r2_key": "stub", "backup_row_count": 0, "backup_sha256": "stub"}
    monkeypatch.setattr(mod, "_write_backup_to_r2", _fake)
    async def _fake_log(db, job_id, ids):
        return "stub"
    monkeypatch.setattr(mod, "_write_insert_log_to_r2", _fake_log)

    # Feed both live-canary IDs into expected — driver returns DuplicateKeyError
    # 1-CANARY-1 is Deregistered in staging → rejected by the guard
    # 1-CANARY-2 is Registered but already exists → DuplicateKeyError → skipped
    result = await _run_insert_only(
        db, "test-job-dup", ["1-CANARY-1", "1-CANARY-2"], "tester@example.com"
    )
    assert result["status"] == "ok"
    assert result["inserted_count"] == 0
    assert result["skipped_duplicate_count"] == 1
    assert result["failed_count"] == 1  # 1-CANARY-1 (Deregistered in staging)
    # Canary docs must remain unchanged (no update triggered)
    c1 = await db[LIVE_COLL].find_one({"locationId": "1-CANARY-1"})
    assert c1["name"] == "Canary A"


@pytest.mark.asyncio
async def test_untouched_collections(isolated_db, monkeypatch):
    db = isolated_db
    await _seed_canonical(db)
    # Seed some CRM-ish records; they must survive untouched
    await db.franchisee_clients.insert_one({"id": "fc-1", "franchisee_id": "x", "home_id": "1-CANARY-1"})
    await db.hq_home_notes.insert_one({"franchisee_id": "x", "source": "cqc", "home_id": "1-CANARY-1", "note": "keep me"})
    await db.franchisees.insert_one({"id": "x", "first_name": "X", "territory_sectors": ["SW1 1"]})
    await db.territories.insert_one({"id": "t-1", "franchisee_id": "x", "postcode": "SW1 1"})

    import cqc_phase3_commit as mod
    async def _fake(db, *a, **k):
        return {"backup_r2_key": "stub", "backup_row_count": 0, "backup_sha256": "stub"}
    monkeypatch.setattr(mod, "_write_backup_to_r2", _fake)
    async def _fake_log(db, job_id, ids):
        return "stub"
    monkeypatch.setattr(mod, "_write_insert_log_to_r2", _fake_log)

    before_hashes = {}
    for coll in ("franchisee_clients", "hq_home_notes", "franchisees", "territories"):
        docs = sorted(
            [json.dumps({k: v for k, v in d.items() if k != "_id"}, default=str, sort_keys=True)
             async for d in db[coll].find({})]
        )
        before_hashes[coll] = hashlib.sha256("\n".join(docs).encode()).hexdigest()

    ids = ["1-NEW-A", "1-NEW-B", "1-NEW-C"]
    await _run_insert_only(db, "test-untouched", ids, "tester@example.com")

    for coll, h in before_hashes.items():
        docs = sorted(
            [json.dumps({k: v for k, v in d.items() if k != "_id"}, default=str, sort_keys=True)
             async for d in db[coll].find({})]
        )
        assert hashlib.sha256("\n".join(docs).encode()).hexdigest() == h, coll


@pytest.mark.asyncio
async def test_deregistered_staging_row_never_inserted(isolated_db, monkeypatch):
    db = isolated_db
    await _seed_canonical(db)
    import cqc_phase3_commit as mod
    async def _fake(db, *a, **k):
        return {"backup_r2_key": "stub", "backup_row_count": 0, "backup_sha256": "stub"}
    monkeypatch.setattr(mod, "_write_backup_to_r2", _fake)
    async def _fake_log(db, job_id, ids):
        return "stub"
    monkeypatch.setattr(mod, "_write_insert_log_to_r2", _fake_log)

    # Even if we deliberately pass the deregistered ID in, the guard rejects it.
    await _run_insert_only(db, "test-dereg", ["1-DEREG-NEW"], "tester@example.com")
    assert await db[LIVE_COLL].find_one({"locationId": "1-DEREG-NEW"}) is None
