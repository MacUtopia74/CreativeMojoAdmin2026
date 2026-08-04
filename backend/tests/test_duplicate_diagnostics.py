"""Regression — Phase A + Phase C duplicate diagnostics.

Isolation contract (agreed with user):
  * Uses a **separate, ephemeral database** — never the shared
    ``creative_mojo_admin`` preview DB — so test rows can never
    pollute anything a human might be inspecting.
  * The ephemeral DB is dropped in a pytest fixture teardown that
    runs on both success AND failure paths (finally block), so a
    mid-suite failure cannot leave test data behind.
  * The diagnostic functions themselves are pure and unit-tested
    directly against this ephemeral DB — no HTTP round-trip needed
    for the assertions.
  * Every response is asserted to carry ``write_performed: false``
    and every collection is asserted UNCHANGED before/after the call.
"""
import asyncio
import os
import uuid
from datetime import datetime, timezone

import pytest
from motor.motor_asyncio import AsyncIOMotorClient


TEST_DB_NAME = f"cma_diag_test_{uuid.uuid4().hex[:10]}"
MONGO_URL = os.environ["MONGO_URL"]


def _run(coro):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


@pytest.fixture(scope="module")
def db_pair():
    """Yield (TEST_DB_NAME, seed_snapshot). ALWAYS drops the ephemeral
    DB on teardown, even if the test suite errored out mid-way.

    Each individual test creates its OWN AsyncIOMotorClient inside a
    fresh event loop — motor clients are pinned to the loop they were
    created on, so we can't share one across tests.
    """
    seed_snapshot = {}

    async def _do_seed():
        cli = AsyncIOMotorClient(MONGO_URL)
        try:
            # Belt-and-braces: drop any stale ephemeral DBs from prior
            # runs whose teardown didn't complete. Only matches our own
            # prefix so we can never touch the shared preview DB.
            for name in await cli.list_database_names():
                if name.startswith("cma_diag_test_"):
                    await cli.drop_database(name)
            await _seed_data(cli[TEST_DB_NAME], seed_snapshot)
        finally:
            cli.close()

    async def _do_drop():
        cli = AsyncIOMotorClient(MONGO_URL)
        try:
            await cli.drop_database(TEST_DB_NAME)
        finally:
            cli.close()

    try:
        _run(_do_seed())
        yield TEST_DB_NAME, seed_snapshot
    finally:
        _run(_do_drop())


def _with_fresh_db(db_name, snap, coro_factory):
    """Run ``coro_factory(db)`` inside a fresh event loop with a
    per-call motor client, so pytest tests never trip the
    'Event loop is closed' guard."""
    async def _inner():
        cli = AsyncIOMotorClient(MONGO_URL)
        try:
            return await coro_factory(cli[db_name])
        finally:
            cli.close()
    return _run(_inner())


async def _seed_data(db, snap):
    """Populate the ephemeral DB with the four scenarios agreed:
      (a) two CQC registrations at one physical site
      (b) duplicated CQC import (same location_id)
      (c) two My-Client rows with the same (franchisee_id, home_id)
      (d) two My-Client rows with no home_id but same name+postcode
    """
    # (a) + (b) — Tunbridge Wells-style dupe pair
    await db.cqc_locations.insert_many([
        {"location_id": "loc-A1", "provider_id": "prov-1", "name": "Tunbridge Wells Care Centre",
         "address": "1 High St, Tunbridge Wells", "postcode": "TN1 1AA", "postcode_sector": "TN1 1",
         "service_types": ["Nursing"], "bed_count": 40,
         "lat": 51.1324, "lng": 0.2637},
        {"location_id": "loc-A2", "provider_id": "prov-2", "name": "Tunbridge Wells Care Centre Nursing Unit",
         "address": "1 High St, Tunbridge Wells", "postcode": "TN1 1AA", "postcode_sector": "TN1 1",
         "service_types": ["Nursing"], "bed_count": 20,
         "lat": 51.1324, "lng": 0.2637},
        # Distinct-services control row on same postcode
        {"location_id": "loc-A3", "provider_id": "prov-3", "name": "Unrelated Day Centre",
         "address": "99 Different Rd, Tunbridge Wells", "postcode": "TN1 1AA", "postcode_sector": "TN1 1",
         "service_types": ["Day care"], "bed_count": None,
         "lat": 51.1400, "lng": 0.2650},
    ])
    # (c) My-Client dupes sharing (franchisee_id, home_id)
    fid = "franchisee-test-01"
    now = datetime.now(timezone.utc).isoformat()
    await db.franchisee_clients.insert_many([
        {"id": "cli-1", "franchisee_id": fid, "source": "cqc", "home_id": "loc-A1",
         "name": "Parkgate Manor", "address": "2 Park Rd", "postcode": "TN2 5BB",
         "notes": "First contact call went well.", "contacts": [{"name": "Jane"}],
         "created_at": now, "updated_at": now},
        {"id": "cli-2", "franchisee_id": fid, "source": "cqc", "home_id": "loc-A1",
         "name": "Parkgate Manor",  "address": "2 Park Road", "postcode": "TN2 5BB",
         "notes": "Follow-up email sent.", "contacts": [{"name": "Alan"}],
         "created_at": now, "updated_at": now},
    ])
    # (d) manually-added dupes without home_id
    await db.franchisee_clients.insert_many([
        {"id": "cli-3", "franchisee_id": fid, "source": "manual", "home_id": None,
         "name": "Abbey Lodge", "address": "5 Abbey Way", "postcode": "TN4 8CD",
         "created_at": now, "updated_at": now},
        {"id": "cli-4", "franchisee_id": fid, "source": "manual", "home_id": None,
         "name": "abbey lodge", "address": "5 Abbey Way", "postcode": "TN4 8CD",
         "created_at": now, "updated_at": now},
    ])
    await db.franchisees.insert_one({"id": fid, "franchise_number": "0099", "organisation": "Test Franchise",
                                     "territory_sectors": ["TN1 1"]})
    await db.hq_home_note_entries.insert_one({
        "id": "note-1", "franchisee_id": fid, "source": "cqc", "home_id": "loc-A1",
        "note": "HQ note for Parkgate Manor", "created_at": now, "updated_at": now,
    })
    snap["counts"] = await _all_counts(db)


async def _all_counts(db):
    return {
        c: await db[c].count_documents({}) for c in
        ("cqc_locations", "franchisee_clients", "franchisees", "hq_home_note_entries")
    }


# ------------------------------------------------------------------
def _fake_require_role(_role):
    async def _dep(): return {"email": "test@admin"}
    return _dep


def _router(db):
    from duplicate_diagnostics_routes import build_router
    return build_router(db, _fake_require_role)


def _find_ep(router, path, method):
    for r in router.routes:
        if r.path == path and method.upper() in r.methods:
            return r.endpoint
    raise AssertionError(f"endpoint not found: {method} {path}")


# ------------------------------------------------------------------
def test_homes_list_diagnostic_never_writes_and_groups_correctly(db_pair):
    db_name, snap = db_pair
    async def _act(db):
        fn = _find_ep(_router(db), "/admin/diagnostics/homes-list-duplicates", "GET")
        result = await fn(home_name="Tunbridge Wells", postcode=None, location_id=None,
                          limit=50, _user={"email": "x"})
        after = await _all_counts(db)
        return result, after
    result, after = _with_fresh_db(db_name, snap, _act)
    assert result["write_performed"] is False
    assert result["diagnostic_version"]
    # Both loc-A1 and loc-A2 must be SURFACED by the diagnostic (they
    # sit on the same postcode). Because their names differ, the
    # site-hash grouping deliberately keeps them in separate proposed
    # groups so a human decides whether to visually group them — this
    # is the "Ambiguous sites must remain ungrouped and be flagged
    # for review" rule.
    surfaced = {m["cqc_location_id"] for g in result["groups"] for m in g["members"]}
    assert {"loc-A1", "loc-A2"}.issubset(surfaced)
    # And every group that isn't a high-confidence exact match must be
    # flagged for human review, never silently collapsed.
    for g in result["groups"]:
        if g["member_count"] > 1 and g["group_confidence"] != "high":
            assert g["requires_human_review"] is True
    # Each surfaced record carries evidence + hydration
    for g in result["groups"]:
        for m in g["members"]:
            assert "evidence_vs_anchor" in m
            assert isinstance(m["franchisees_with_territory"], list)
            assert isinstance(m["my_client_records"], list)
            assert isinstance(m["hq_note_count"], int)
    assert after == snap["counts"]


def test_client_duplicates_groups_by_home_and_by_fuzzy(db_pair):
    db_name, snap = db_pair
    async def _act(db):
        fn = _find_ep(_router(db), "/admin/diagnostics/clients/duplicates", "GET")
        result = await fn(franchisee_id="franchisee-test-01", client_name=None,
                          limit=200, _user={"email": "x"})
        return result, await _all_counts(db)
    result, after = _with_fresh_db(db_name, snap, _act)
    assert result["write_performed"] is False
    rules = [g["grouping_rule"] for g in result["groups"]]
    assert any("home_id" in r for r in rules)
    assert any("normalised_name" in r for r in rules)
    assert after == snap["counts"]
    for g in result["groups"]:
        for r in g["records"]:
            assert "client_record_id" in r
            assert "source_home_id" in r
            assert "hq_note_reference" in r
            assert "normalised_name" in r


def test_resolve_identity_returns_matched_ambiguous_or_unmatched(db_pair):
    db_name, snap = db_pair
    async def _act(db):
        fn = _find_ep(_router(db), "/admin/diagnostics/clients/{client_id}/resolve-identity", "GET")
        r1 = await fn(client_id="cli-1", _user={"email": "x"})
        r3 = await fn(client_id="cli-3", _user={"email": "x"})
        return r1, r3, await _all_counts(db)
    r1, r3, after = _with_fresh_db(db_name, snap, _act)
    assert r1["status"] == "matched"
    assert r1["source_cqc_location"]["cqc_location_id"] == "loc-A1"
    assert r3["status"] in ("matched", "ambiguous", "unmatched")
    assert r3["write_performed"] is False
    assert after == snap["counts"]


def test_dry_run_client_merge_reports_conflicts_and_writes_nothing(db_pair):
    db_name, snap = db_pair
    async def _act(db):
        fn = _find_ep(_router(db), "/admin/diagnostics/dry-run/client-merge", "POST")
        return await fn(body={"record_ids": ["cli-1", "cli-2"]}, _user={"email": "x"}), await _all_counts(db)
    result, after = _with_fresh_db(db_name, snap, _act)
    assert result["write_performed"] is False
    assert result["proposed_survivor_id"] in ("cli-1", "cli-2")
    assert set(result["proposed_archived_ids"]) == {"cli-1", "cli-2"} - {result["proposed_survivor_id"]}
    assert "notes" in result["fields_combined"]
    assert "contacts" in result["fields_combined"]
    assert after == snap["counts"]
    assert len(result["pre_merge_snapshots"]) == 2


def test_dry_run_site_group_visual_only(db_pair):
    db_name, snap = db_pair
    async def _act(db):
        fn = _find_ep(_router(db), "/admin/diagnostics/dry-run/site-group", "POST")
        return await fn(body={"cqc_location_ids": ["loc-A1", "loc-A2"]}, _user={"email": "x"}), await _all_counts(db)
    result, after = _with_fresh_db(db_name, snap, _act)
    assert result["write_performed"] is False
    assert result["action"] == "visual_grouping_only"
    assert result["proposed_canonical_site_id"].startswith("sitehash-")
    assert len(result["registrations"]) == 2
    assert "bed_count" in result["presentation_notes"]
    assert "provider_id" in result["conflicts_across_registrations"]
    assert after == snap["counts"]


def test_user_activity_reports_no_field_level_audit(db_pair):
    db_name, snap = db_pair
    async def _act(db):
        fn = _find_ep(_router(db), "/admin/diagnostics/user-activity", "GET")
        return await fn(email=None, franchisee_id="franchisee-test-01", days=7,
                        _user={"email": "x"}), await _all_counts(db)
    result, after = _with_fresh_db(db_name, snap, _act)
    assert result["write_performed"] is False
    assert result["field_level_audit_available"] is False
    assert isinstance(result["clients_touched"], list)
    assert isinstance(result["hq_notes"], list)
    assert after == snap["counts"]
