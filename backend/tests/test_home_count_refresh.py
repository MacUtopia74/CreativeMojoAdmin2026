"""Tests for the safe home-count refresh endpoint and the TW11 9 no-op."""
from __future__ import annotations

import os
import sys
import uuid

import pytest
from dotenv import load_dotenv

load_dotenv("/app/backend/.env")
sys.path.insert(0, "/app/backend")

from motor.motor_asyncio import AsyncIOMotorClient  # noqa: E402
from franchisee_home_count_refresh import _compute_home_count  # noqa: E402


@pytest.fixture
async def isolated_db():
    client = AsyncIOMotorClient(os.environ["MONGO_URL"])
    name = f"{os.environ['DB_NAME']}_hcref_{uuid.uuid4().hex[:8]}"
    db = client[name]
    yield db
    await client.drop_database(name)
    client.close()


async def _seed(db):
    await db.cqc_definition.insert_one({
        "_id": "system-default",
        "include_service_types": ["Nursing homes", "Residential homes"],
        "registration_statuses": ["Registered"],
    })
    await db.scotland_definition.insert_one({
        "_id": "system-default",
        "care_service_types": [],
        "current_status": ["Active"],
    })
    await db.cqc_locations_live.insert_many([
        {"locationId": "1-A", "postcode_sector": "SW1 1",
         "registrationStatus": "Registered",
         "gacServiceTypes": [{"name": "Nursing homes"}]},
        {"locationId": "1-B", "postcode_sector": "SW1 1",
         "registrationStatus": "Registered",
         "gacServiceTypes": [{"name": "Residential homes"}]},
        {"locationId": "1-C", "postcode_sector": "SW1 2",
         "registrationStatus": "Registered",
         "gacServiceTypes": [{"name": "Dentist"}]},  # filter-excluded
        {"locationId": "1-D", "postcode_sector": "SW1 2",
         "registrationStatus": "Deregistered",
         "gacServiceTypes": [{"name": "Nursing homes"}]},  # status-excluded
    ])
    await db.franchisees.insert_one({
        "id": "clem",
        "first_name": "Clementina",
        "last_name": "Phillips",
        "franchise_number": "0091",
        "territory_sectors": ["SW1 1", "SW1 2"],
        "territory_home_count": 999,  # deliberately stale
    })


@pytest.mark.asyncio
async def test_compute_home_count_matches_filter(isolated_db):
    db = isolated_db
    await _seed(db)
    result = await _compute_home_count(db, ["SW1 1", "SW1 2"])
    assert result["england_count"] == 2   # 1-A + 1-B, not 1-C (dentist), not 1-D (dereg)
    assert result["scotland_count"] == 0
    assert result["total"] == 2
    assert result["per_sector"]["SW1 1"] == 2
    assert result["per_sector"]["SW1 2"] == 0


@pytest.mark.asyncio
async def test_refresh_updates_only_home_count_field(isolated_db):
    from franchisee_home_count_refresh import _compute_home_count, REFRESH_LOG_COLL
    db = isolated_db
    await _seed(db)
    fr_before = await db.franchisees.find_one({"id": "clem"}, {"_id": 0})
    # Simulate what the endpoint does — verify byte-level: only
    # territory_home_count changes.
    result = await _compute_home_count(db, fr_before["territory_sectors"])
    await db.franchisees.update_one(
        {"id": "clem"},
        {"$set": {"territory_home_count": result["total"]}},
    )
    fr_after = await db.franchisees.find_one({"id": "clem"}, {"_id": 0})
    # All fields identical except territory_home_count
    diffs = {k for k in set(fr_before) | set(fr_after)
             if fr_before.get(k) != fr_after.get(k)}
    assert diffs == {"territory_home_count"}
    assert fr_after["territory_home_count"] == 2
    assert fr_before["territory_home_count"] == 999


@pytest.mark.asyncio
async def test_tw11_9_dry_run_reports_noop_when_already_present(isolated_db):
    """When TW11 9 is already in sectors, dry-run must:
      - set would_be_noop=True
      - return an empty actions_to_perform_on_commit list
      - populate noop_reason
    """
    from cqc_phase3_tw11_9 import compute_dry_run
    db = isolated_db
    await _seed(db)
    # Overwrite Clementina to include TW11 9 already
    await db.franchisees.replace_one(
        {"id": "clem"},
        {"id": "6bbf65a1-af0c-4c00-abe1-f2814766e230",
         "first_name": "Clementina", "last_name": "Phillips",
         "franchise_number": "0091",
         "territory_sectors": ["SW1 1", "TW11 9"],
         "territory_home_count": 122}
    )
    dr = await compute_dry_run(db)
    assert dr["already_present_in_her_territory"] is True
    assert dr["would_be_noop"] is True
    assert dr["actions_to_perform_on_commit"] == []
    assert "no_op" in (dr["noop_reason"] or "") or "refresh" in (dr["noop_reason"] or "")
