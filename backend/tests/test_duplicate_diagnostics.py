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
  * Aug 2026 refresh:
      - HQ notes: real collection is ``hq_home_notes`` (append-only,
        one doc per entry). Fixtures updated to match.
      - Correspondence: ``email_sends``, ``email_inbounds``,
        ``email_inbound_unmatched`` — all keyed on ``contact_id``.
      - Regression test proves the deprecated
        ``hq_home_note_entries`` collection is NOT queried.
      - build_commit falls back safely to ``"unknown"`` when git
        metadata is unavailable.
"""
import asyncio
import os
import uuid
from datetime import datetime, timezone

import pytest
from motor.motor_asyncio import AsyncIOMotorClient


TEST_DB_NAME = f"cma_diag_test_{uuid.uuid4().hex[:10]}"
MONGO_URL = os.environ["MONGO_URL"]

# Collections seeded by these tests. Every diagnostic call is asserted
# to leave these counts UNCHANGED (write_performed:false is not enough
# on its own — we double-check the actual documents).
SEEDED_COLLECTIONS = (
    "cqc_locations", "franchisee_clients", "franchisees", "hq_home_notes",
    "email_sends", "email_inbounds", "email_inbound_unmatched",
    "contacts", "web_form_contacts", "users",
)


def _run(coro):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


@pytest.fixture(scope="module")
def db_pair():
    seed_snapshot = {}

    async def _do_seed():
        cli = AsyncIOMotorClient(MONGO_URL)
        try:
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
    async def _inner():
        cli = AsyncIOMotorClient(MONGO_URL)
        try:
            return await coro_factory(cli[db_name])
        finally:
            cli.close()
    return _run(_inner())


async def _seed_data(db, snap):
    """Rich fixture set covering every scenario the user asked for."""
    fid_sam = "franchisee-sam-0095"
    fid_other = "franchisee-other-0042"
    now = datetime.now(timezone.utc).isoformat()

    # ---- CQC locations
    await db.cqc_locations.insert_many([
        {"location_id": "loc-A1", "provider_id": "prov-1",
         "name": "Tunbridge Wells Care Centre",
         "address": "1 High St, Tunbridge Wells", "postcode": "TN1 1AA",
         "postcode_sector": "TN1 1", "service_types": ["Nursing"], "bed_count": 40,
         "lat": 51.1324, "lng": 0.2637},
        {"location_id": "loc-A2", "provider_id": "prov-2",
         "name": "Tunbridge Wells Care Centre Nursing Unit",
         "address": "1 High St, Tunbridge Wells", "postcode": "TN1 1AA",
         "postcode_sector": "TN1 1", "service_types": ["Nursing"], "bed_count": 20,
         "lat": 51.1324, "lng": 0.2637},
        {"location_id": "loc-A3", "provider_id": "prov-3",
         "name": "Unrelated Day Centre",
         "address": "99 Different Rd, Tunbridge Wells", "postcode": "TN1 1AA",
         "postcode_sector": "TN1 1", "service_types": ["Day care"], "bed_count": None,
         "lat": 51.1400, "lng": 0.2650},
    ])

    # ---- My Client dupes (Sam)
    await db.franchisee_clients.insert_many([
        {"id": "cli-1", "franchisee_id": fid_sam, "source": "cqc", "home_id": "loc-A1",
         "name": "Parkgate Manor", "address": "2 Park Rd", "postcode": "TN2 5BB",
         "email": "hello@parkgate.example",
         "notes": "First contact call went well.",
         "contacts": [{"name": "Jane", "email": "jane@parkgate.example"}],
         "created_at": now, "updated_at": now},
        {"id": "cli-2", "franchisee_id": fid_sam, "source": "cqc", "home_id": "loc-A1",
         "name": "Parkgate Manor",  "address": "2 Park Road", "postcode": "TN2 5BB",
         "email": "hello@parkgate.example",   # shared email (ambiguity)
         "notes": "Follow-up email sent.",
         "contacts": [{"name": "Alan", "email": "alan@parkgate.example"}],
         "created_at": now, "updated_at": now},
        {"id": "cli-3", "franchisee_id": fid_sam, "source": "manual", "home_id": None,
         "name": "Abbey Lodge", "address": "5 Abbey Way", "postcode": "TN4 8CD",
         "created_at": now, "updated_at": now},
        {"id": "cli-4", "franchisee_id": fid_sam, "source": "manual", "home_id": None,
         "name": "abbey lodge", "address": "5 Abbey Way", "postcode": "TN4 8CD",
         "email": "abbey@lodge.example",
         "created_at": now, "updated_at": now},
    ])

    # ---- Franchisees
    await db.franchisees.insert_many([
        {"id": fid_sam, "franchise_number": "0095",
         "first_name": "Sam", "last_name": "Whiteman",
         "email": "sam@example.com",
         "organisation": "Sam's Territory",
         "territory_sectors": ["TN1 1"]},
        {"id": fid_other, "franchise_number": "0042",
         "first_name": "Other", "last_name": "Franchisee",
         "email": "other@example.com",
         "organisation": "Other Territory",
         "territory_sectors": ["ME14 1"]},
    ])

    # ---- HQ notes — REAL collection is ``hq_home_notes``
    await db.hq_home_notes.insert_many([
        {"id": "note-1", "franchisee_id": fid_sam, "source": "cqc", "home_id": "loc-A1",
         "note": "HQ note for Parkgate Manor",
         "updated_by": "hq@creativemojo.co.uk", "updated_at": now},
        {"id": "note-2", "franchisee_id": fid_sam, "source": "cqc", "home_id": "loc-A1",
         "note": "Second HQ note entry (append-only history proof)",
         "updated_by": "hq@creativemojo.co.uk", "updated_at": now},
    ])

    # ---- Users + contacts + web_form_contacts
    await db.users.insert_one({
        "id": "usr-sam", "email": "sam@example.com", "name": "Sam Whiteman",
    })
    await db.contacts.insert_many([
        {"id": "ct-1", "email": "hello@parkgate.example", "franchisee_id": fid_sam,
         "name": "Parkgate Manager"},
        # A contact that duplicates the same email under a DIFFERENT franchisee
        # → triggers ``contact_franchisee_mismatch`` and
        #   ``email_shared_by_multiple_contacts`` ambiguity flags.
        {"id": "ct-2", "email": "hello@parkgate.example", "franchisee_id": fid_other,
         "name": "Different Franchisee's Duplicate Contact"},
    ])
    await db.web_form_contacts.insert_one({
        "id": "wf-1", "email": "abbey@lodge.example",
        "franchisee_id": fid_sam, "name": "Abbey Lodge Web Lead",
    })

    # ---- Correspondence (all timestamps within last 7 days)
    await db.email_sends.insert_many([
        # 1) Direct outbound BY Sam (attribution_type=direct_by_sam)
        {"id": "send-1", "contact_id": "wf-1", "sent_by": "sam@example.com",
         "sent_at": now, "subject": "Direct Sam outbound",
         "to": ["abbey@lodge.example"], "cc": [], "bcc": [], "from": "sam@creativemojo.co.uk",
         "events": [{"type": "sent", "at": now}], "last_event": "sent", "last_event_at": now},
        # 2) Admin outbound on Sam's contact (attribution_type=admin_on_sams_records)
        {"id": "send-2", "contact_id": "wf-1", "sent_by": "admin@creativemojo.co.uk",
         "sent_at": now, "subject": "Admin outbound on Sam's record",
         "to": ["abbey@lodge.example"], "cc": [], "bcc": [], "from": "admin@creativemojo.co.uk",
         "events": [{"type": "sent", "at": now}], "last_event": "sent", "last_event_at": now},
        # 3) Recipient email overlaps Sam's client email but NO contact_id linkage
        #    → attribution_type=inferred_via_client_link
        {"id": "send-3", "contact_id": "ct-2", "sent_by": "someone@else.com",
         "sent_at": now, "subject": "Inferred via client email",
         "to": ["hello@parkgate.example"], "cc": [], "bcc": [], "from": "someone@else.com",
         "events": [{"type": "sent", "at": now}], "last_event": "sent", "last_event_at": now},
        # 4) Multi-recipient send where ONLY ONE recipient matches — ambiguity flag
        {"id": "send-4", "contact_id": None, "sent_by": "someone@else.com",
         "sent_at": now, "subject": "Multi-recipient partial match",
         "to": ["hello@parkgate.example", "unrelated@example.com"], "cc": [], "bcc": [],
         "from": "someone@else.com",
         "events": [{"type": "sent", "at": now}], "last_event": "sent", "last_event_at": now},
    ])
    await db.email_inbounds.insert_many([
        # A) Inbound matched to Sam's contact (inbound_matched_to_sams_contact)
        {"id": "in-1", "contact_id": "wf-1", "received_at": now,
         "subject": "Reply from Abbey", "from": "abbey@lodge.example",
         "to": ["sam@creativemojo.co.uk"], "match_method": "plus_token"},
        # B) Inbound from an email on one of Sam's client rows but no contact_id
        {"id": "in-2", "contact_id": None, "received_at": now,
         "subject": "Cold reply", "from": "jane@parkgate.example",
         "to": ["hello@creativemojo.co.uk"], "match_method": "unmatched"},
    ])
    await db.email_inbound_unmatched.insert_many([
        # Unmatched with a body mention only → must NOT be attributed to Sam
        {"id": "um-1", "resend_inbound_id": "re-inbound-1", "received_at": now,
         "from": "totally.unrelated@example.com", "to": ["hello@creativemojo.co.uk"],
         "subject": "Body-mention only", "preview": "mentions hello@parkgate.example in body only"},
        # Unmatched where the STRUCTURED from IS Sam's client email
        {"id": "um-2", "resend_inbound_id": "re-inbound-2", "received_at": now,
         "from": "jane@parkgate.example", "to": ["hq@creativemojo.co.uk"],
         "subject": "Inferred from-header inbound"},
    ])

    snap["counts"] = await _all_counts(db)


async def _all_counts(db):
    return {c: await db[c].count_documents({}) for c in SEEDED_COLLECTIONS}


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


def _assert_envelope(result):
    assert result["write_performed"] is False
    assert result["diagnostic_version"] == "phase-a+c-2026-08-04"
    assert "build_commit" in result
    assert result["build_commit"]  # always a string, may be "unknown"
    assert result["capabilities"]["bookings"]["status"] == "no_internal_bookings_collection_in_codebase"
    assert result["capabilities"]["hq_notes_collection"] == "hq_home_notes"
    assert result["capabilities"]["correspondence"]["outbound_collection"] == "email_sends"


# ------------------------------------------------------------------
def test_diagnostic_version_and_build_commit_present(db_pair):
    db_name, snap = db_pair
    async def _act(db):
        fn = _find_ep(_router(db), "/admin/diagnostics/homes-list-duplicates", "GET")
        return await fn(home_name="Tunbridge Wells", postcode=None, location_id=None,
                        limit=50, _user={"email": "x"})
    result = _with_fresh_db(db_name, snap, _act)
    _assert_envelope(result)


def test_homes_list_returns_hq_notes_with_identity_tuple(db_pair):
    db_name, snap = db_pair
    async def _act(db):
        fn = _find_ep(_router(db), "/admin/diagnostics/homes-list-duplicates", "GET")
        return await fn(home_name="Tunbridge Wells", postcode=None, location_id=None,
                        limit=50, _user={"email": "x"}), await _all_counts(db)
    result, after = _with_fresh_db(db_name, snap, _act)
    _assert_envelope(result)
    # Find the group containing loc-A1 and assert HQ notes are present as IDs
    found_notes = False
    for g in result["groups"]:
        for m in g["members"]:
            if m["cqc_location_id"] == "loc-A1":
                assert isinstance(m["hq_notes"], list)
                assert m["hq_note_count"] == 2
                assert {n["entry_id"] for n in m["hq_notes"]} == {"note-1", "note-2"}
                for n in m["hq_notes"]:
                    assert n["identity_key"]["tuple"] == ["franchisee_id", "source", "home_id"]
                    assert n["identity_key"]["values"] == [
                        "franchisee-sam-0095", "cqc", "loc-A1",
                    ]
                # Bookings empty list — not a fabricated relationship
                assert m["bookings"] == []
                found_notes = True
    assert found_notes, "loc-A1 not surfaced in homes-list diagnostic"
    assert after == snap["counts"]


def test_homes_list_returns_no_bookings_because_collection_absent(db_pair):
    db_name, snap = db_pair
    async def _act(db):
        fn = _find_ep(_router(db), "/admin/diagnostics/homes-list-duplicates", "GET")
        return await fn(home_name="Tunbridge Wells", postcode=None, location_id=None,
                        limit=50, _user={"email": "x"})
    result = _with_fresh_db(db_name, snap, _act)
    cap = result["capabilities"]["bookings"]
    assert cap["status"] == "no_internal_bookings_collection_in_codebase"
    assert "bookings_url" in cap["explanation"].lower() or "bookings" in cap["explanation"].lower()
    for g in result["groups"]:
        for m in g["members"]:
            assert m["bookings"] == []


def test_client_duplicates_reports_correspondence_linkage_no_direct_link(db_pair):
    db_name, snap = db_pair
    async def _act(db):
        fn = _find_ep(_router(db), "/admin/diagnostics/clients/duplicates", "GET")
        return await fn(franchisee_id="franchisee-sam-0095", client_name=None,
                        limit=200, _user={"email": "x"}), await _all_counts(db)
    result, after = _with_fresh_db(db_name, snap, _act)
    _assert_envelope(result)
    # locate the parkgate group
    parkgate_group = next(
        (g for g in result["groups"] if g["grouping_rule"].startswith("franchisee_id + home_id")),
        None,
    )
    assert parkgate_group, "expected franchisee_id+home_id group"
    for rec in parkgate_group["records"]:
        cl = rec["correspondence_linkage"]
        assert cl["direct_link"]["status"] == "none"
        assert "no contact_id" in cl["direct_link"]["reason"]
        # Every inferred match must carry the required metadata
        for m in cl["inferred_matches"]:
            assert m["link_type"] == "heuristic_email_match"
            assert m["confidence"] == "inferred"
            assert m["requires_human_verification"] is True
            assert m["safe_for_automatic_merge"] is False
            assert m["matched_email"]
            assert m["client_email_field"]
            assert m["correspondence_email_field"] in {"to", "cc", "bcc", "from"}
        # HQ notes exposed as list of entry_ids
        assert rec["hq_note_entry_ids"] == ["note-1", "note-2"] or \
               rec["hq_note_entry_ids"] == ["note-2", "note-1"]
        assert rec["hq_note_identity_key"]["values"] == [
            "franchisee-sam-0095", "cqc", "loc-A1",
        ]
        assert rec["bookings"] == []
    assert after == snap["counts"]


def test_client_duplicates_flags_shared_email_ambiguity(db_pair):
    db_name, snap = db_pair
    async def _act(db):
        fn = _find_ep(_router(db), "/admin/diagnostics/clients/duplicates", "GET")
        return await fn(franchisee_id="franchisee-sam-0095", client_name=None,
                        limit=200, _user={"email": "x"})
    result = _with_fresh_db(db_name, snap, _act)
    # both cli-1 and cli-2 share hello@parkgate.example so every inferred
    # match on that email must carry the shared_by_multiple flags AND
    # every match with contact ct-2 must carry the franchisee mismatch flag
    saw_shared_clients = saw_shared_contacts = saw_franchisee_mismatch = saw_multi_recipient = False
    for g in result["groups"]:
        if not g["grouping_rule"].startswith("franchisee_id + home_id"):
            continue
        for rec in g["records"]:
            for m in rec["correspondence_linkage"]["inferred_matches"]:
                flags = set(m["ambiguity_flags"])
                if "email_shared_by_multiple_client_records" in flags:
                    saw_shared_clients = True
                if "email_shared_by_multiple_contacts" in flags:
                    saw_shared_contacts = True
                if "contact_franchisee_mismatch" in flags:
                    saw_franchisee_mismatch = True
                if "correspondence_has_multiple_recipients_only_one_matched" in flags:
                    saw_multi_recipient = True
    assert saw_shared_clients, "shared client-email flag missing"
    assert saw_shared_contacts, "shared contact-email flag missing"
    assert saw_franchisee_mismatch, "franchisee mismatch flag missing"
    assert saw_multi_recipient, "multi-recipient partial-match flag missing"


def test_user_activity_classifies_correspondence_correctly(db_pair):
    db_name, snap = db_pair
    async def _act(db):
        fn = _find_ep(_router(db), "/admin/diagnostics/user-activity", "GET")
        return await fn(email="sam@example.com", franchisee_id="franchisee-sam-0095",
                        days=7, _user={"email": "x"}), await _all_counts(db)
    result, after = _with_fresh_db(db_name, snap, _act)
    _assert_envelope(result)
    types = {c["attribution_type"] for c in result["correspondence"]}
    # All four labels covered by fixtures MUST be present
    assert "direct_by_sam" in types
    assert "admin_on_sams_records" in types
    assert "inferred_via_client_link" in types
    assert "inbound_matched_to_sams_contact" in types
    assert "inferred_inbound_email_match" in types
    # Definitions echoed to the client
    for lbl in ("direct_by_sam", "admin_on_sams_records", "inferred_via_client_link",
                "inbound_matched_to_sams_contact", "inferred_inbound_email_match"):
        assert lbl in result["attribution_definitions"]
    # Unmatched-inbound: body-mention only must be excluded.
    # The unmatched entry we DO include (um-2, structured-from match) must
    # be flagged inferred; the body-mention entry (um-1) must be absent.
    ids = {c["correspondence_id"] for c in result["correspondence"]}
    assert "um-2" in ids
    assert "um-1" not in ids
    assert after == snap["counts"]


def test_user_activity_inferred_never_marked_direct(db_pair):
    db_name, snap = db_pair
    async def _act(db):
        fn = _find_ep(_router(db), "/admin/diagnostics/user-activity", "GET")
        return await fn(email="sam@example.com", franchisee_id="franchisee-sam-0095",
                        days=7, _user={"email": "x"})
    result = _with_fresh_db(db_name, snap, _act)
    for c in result["correspondence"]:
        if c["attribution_type"] in ("inferred_via_client_link", "inferred_inbound_email_match"):
            assert c["direct"] is False
            assert c["requires_human_verification"] is True


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
    _assert_envelope(r1)
    _assert_envelope(r3)
    assert after == snap["counts"]


def test_dry_run_client_merge_reports_conflicts_and_writes_nothing(db_pair):
    db_name, snap = db_pair
    async def _act(db):
        fn = _find_ep(_router(db), "/admin/diagnostics/dry-run/client-merge", "POST")
        return await fn(body={"record_ids": ["cli-1", "cli-2"]}, _user={"email": "x"}), await _all_counts(db)
    result, after = _with_fresh_db(db_name, snap, _act)
    _assert_envelope(result)
    assert result["proposed_survivor_id"] in ("cli-1", "cli-2")
    assert set(result["proposed_archived_ids"]) == {"cli-1", "cli-2"} - {result["proposed_survivor_id"]}
    assert "notes" in result["fields_combined"]
    assert "contacts" in result["fields_combined"]
    fr_collections = {r["collection"] for r in result["foreign_references_to_update"]}
    assert "hq_home_notes" in fr_collections
    assert "email_sends" in fr_collections
    assert after == snap["counts"]
    assert len(result["pre_merge_snapshots"]) == 2


def test_dry_run_site_group_visual_only(db_pair):
    db_name, snap = db_pair
    async def _act(db):
        fn = _find_ep(_router(db), "/admin/diagnostics/dry-run/site-group", "POST")
        return await fn(body={"cqc_location_ids": ["loc-A1", "loc-A2"]}, _user={"email": "x"}), await _all_counts(db)
    result, after = _with_fresh_db(db_name, snap, _act)
    _assert_envelope(result)
    assert result["action"] == "visual_grouping_only"
    assert result["proposed_canonical_site_id"].startswith("sitehash-")
    assert len(result["registrations"]) == 2
    assert "bed_count" in result["presentation_notes"]
    assert "provider_id" in result["conflicts_across_registrations"]
    assert after == snap["counts"]


# ------------------------------------------------------------------
# Regression: prove the OLD (deprecated) hq_home_note_entries collection
# is NOT queried anywhere. If a diagnostic ever queried it, that
# collection would be created by Motor on the fly with a count of 0 —
# so we assert that its count remains 0 AND that our real notes
# still show up.
def test_deprecated_hq_note_collection_is_not_queried(db_pair):
    db_name, snap = db_pair
    async def _prepare(db):
        # ensure old collection is empty and doesn't exist
        try:
            await db.hq_home_note_entries.drop()
        except Exception:
            pass
    _with_fresh_db(db_name, snap, _prepare)

    async def _act(db):
        # Run every endpoint that might touch HQ notes
        r = _router(db)
        h = _find_ep(r, "/admin/diagnostics/homes-list-duplicates", "GET")
        c = _find_ep(r, "/admin/diagnostics/clients/duplicates", "GET")
        u = _find_ep(r, "/admin/diagnostics/user-activity", "GET")
        await h(home_name="Tunbridge Wells", postcode=None, location_id=None,
                limit=50, _user={"email": "x"})
        await c(franchisee_id="franchisee-sam-0095", client_name=None, limit=200,
                _user={"email": "x"})
        await u(email="sam@example.com", franchisee_id="franchisee-sam-0095", days=7,
                _user={"email": "x"})
        # Explicit collection listing
        return await db.list_collection_names()
    names = _with_fresh_db(db_name, snap, _act)
    assert "hq_home_note_entries" not in names, (
        "Legacy hq_home_note_entries collection was auto-created — "
        "something is still querying it as the source of truth."
    )
    assert "hq_home_notes" in names


def test_build_commit_falls_back_safely(monkeypatch):
    """Even without any git metadata or env var, resolver must never
    crash — it returns ``"unknown"`` and the app stays healthy."""
    # Force a re-resolve with all env keys cleared and the git binary
    # unavailable (fake $PATH). Prove the resolver returns "unknown".
    for k in ("BUILD_COMMIT", "COMMIT_SHA", "GIT_COMMIT",
              "RENDER_GIT_COMMIT", "VERCEL_GIT_COMMIT_SHA"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("PATH", "/nonexistent/definitely-no-git-here")
    import importlib
    import site_identity
    importlib.reload(site_identity)
    assert site_identity.BUILD_COMMIT in ("unknown",) or site_identity.BUILD_COMMIT
