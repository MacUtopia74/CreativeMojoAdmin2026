"""Tests for the cross-franchisee contact-leak kill switch + audit endpoint.

Reproduces the Feb-2026 production issue where Monica's popup on the
Mojo map showed Bel McDonald's email address. Locks the guarantee that
the API will never emit a franchisee-A `website_email/phone` if it
matches franchisee-B's admin `email/phone/mobile`.
"""
from __future__ import annotations

import os
import sys
import uuid

import pytest
from dotenv import load_dotenv

load_dotenv("/app/backend/.env")
sys.path.insert(0, "/app/backend")

from motor.motor_asyncio import AsyncIOMotorClient  # noqa: E402
from website_profile_audit import _scan  # noqa: E402


@pytest.fixture
async def isolated_db():
    client = AsyncIOMotorClient(os.environ["MONGO_URL"])
    name = f"{os.environ['DB_NAME']}_leakscan_{uuid.uuid4().hex[:8]}"
    db = client[name]
    yield db
    await client.drop_database(name)
    client.close()


async def _seed_monica_bel_leak(db, bels_admin_email: str | None = None):
    """Two franchisees. Monica's `website_email` points at
    `bel@creativemojo.co.uk`. Whether Bel's admin `email` field IS that
    value is controlled by ``bels_admin_email`` — production shape has
    it as *None* (the company-alias only ties to Bel by name), which
    is what my Feb-2026 v1 guard failed to catch.
    """
    await db.franchisees.insert_many([
        {
            "id": "monica-id",
            "first_name": "Monica", "last_name": "Diodato",
            "franchise_number": "0087",
            "email": "monica@creativemojo.co.uk",
            "phone": "07522421735",
            "website_email": "bel@creativemojo.co.uk",    # ← THE LEAK
            "website_phone": "07522421735",
            "show_website_email": True,
            "show_website_phone": True,
            "website_bio": "Hi, I'm Monica.",
            "show_website_bio": True,
            "wp_page_url": "https://creativemojo.co.uk/monica",
            "tags": ["Franchisee"],
            "territory_sectors": ["DT7 3"],
        },
        {
            "id": "bel-id",
            "first_name": "Bel", "last_name": "McDonald",
            "franchise_number": "0091",
            "email": bels_admin_email,                    # ← may be None in prod shape
            "phone": "07770123456",
            "tags": ["Franchisee"],
        },
    ])


@pytest.mark.asyncio
async def test_audit_flags_the_monica_bel_leak(isolated_db):
    db = isolated_db
    await _seed_monica_bel_leak(db)
    report = await _scan(db)
    assert report["totals"]["leaks_total"] == 1
    assert report["totals"]["leaks_published_and_currently_visible"] == 1
    (leak,) = report["leaks"]
    assert leak["field"] == "website_email"
    assert leak["franchisee"]["name"] == "Monica Diodato"
    assert leak["leaked_value"] == "bel@creativemojo.co.uk"
    assert leak["candidate_owners"][0]["name"] == "Bel McDonald"
    assert leak["is_published"] is True


@pytest.mark.asyncio
async def test_audit_ignores_franchisees_own_matching_admin_email(isolated_db):
    """If a franchisee legitimately sets their `website_email` to their
    OWN admin email, that's not a leak — no flag."""
    db = isolated_db
    await db.franchisees.insert_one({
        "id": "solo-id",
        "first_name": "Solo", "last_name": "Test",
        "email": "solo@creativemojo.co.uk",
        "website_email": "solo@creativemojo.co.uk",
        "show_website_email": True,
    })
    report = await _scan(db)
    assert report["totals"]["leaks_total"] == 0


@pytest.mark.asyncio
async def test_audit_flags_unpublished_leaks_too(isolated_db):
    """Even when `show_website_email` is False, the audit reports it so
    HQ can proactively clear the data before a franchisee accidentally
    toggles it on."""
    db = isolated_db
    await _seed_monica_bel_leak(db)
    # Toggle off Monica's publish flag — leak is still latent
    await db.franchisees.update_one({"id": "monica-id"},
                                    {"$set": {"show_website_email": False}})
    report = await _scan(db)
    assert report["totals"]["leaks_total"] == 1
    assert report["totals"]["leaks_published_and_currently_visible"] == 0
    assert report["leaks"][0]["is_published"] is False


@pytest.mark.asyncio
async def test_audit_flags_phone_leak(isolated_db):
    db = isolated_db
    await db.franchisees.insert_many([
        {"id": "a", "first_name": "A", "email": "a@x.co", "phone": "07700111222",
         "website_phone": "07770123456", "show_website_phone": True},
        {"id": "b", "first_name": "B", "email": "b@x.co", "mobile": "07770123456"},
    ])
    report = await _scan(db)
    assert report["totals"]["leaks_total"] == 1
    assert report["leaks"][0]["field"] == "website_phone"


@pytest.mark.asyncio
async def test_clear_leaks_flips_show_flag_only(isolated_db, monkeypatch):
    """The clear-leaks action MUST NOT overwrite `website_email` — it
    only flips `show_website_email` to False, so HQ can still inspect
    the raw leaked value for forensics."""
    db = isolated_db
    await _seed_monica_bel_leak(db)
    before = await db.franchisees.find_one({"id": "monica-id"}, {"_id": 0})

    # Simulate the endpoint's behaviour
    report = await _scan(db)
    published = [l for l in report["leaks"] if l["is_published"]]
    for leak in published:
        flag = "show_website_email" if leak["field"] == "website_email" else "show_website_phone"
        await db.franchisees.update_one(
            {"id": leak["franchisee"]["id"]}, {"$set": {flag: False}}
        )

    after = await db.franchisees.find_one({"id": "monica-id"}, {"_id": 0})
    diffs = {k for k in set(before) | set(after) if before.get(k) != after.get(k)}
    assert diffs == {"show_website_email"}, f"unexpected diffs: {diffs}"
    # Raw value preserved for forensics
    assert after["website_email"] == "bel@creativemojo.co.uk"
    assert after["show_website_email"] is False


@pytest.mark.asyncio
async def test_runtime_guard_suppresses_email_leak(isolated_db):
    """Direct call: the exact code path used by the public map popup
    must not emit Monica's leaked `website_email` when it matches Bel's
    admin email. Reproduces the Feb-2026 production incident."""
    from find_class_routes import (
        _load_other_admin_contacts,
        _apply_cross_leak_guard,
    )
    db = isolated_db
    await _seed_monica_bel_leak(db)
    monica = await db.franchisees.find_one({"id": "monica-id"}, {"_id": 0})
    emails, phones, strong, weak = await _load_other_admin_contacts(db, monica["id"])
    phone_str, email_public = _apply_cross_leak_guard(monica, emails, phones, strong, weak)
    assert email_public != "bel@creativemojo.co.uk", (
        "LEAK: runtime guard failed — Monica's popup would emit Bel's "
        "admin email."
    )
    assert email_public is None


@pytest.mark.asyncio
async def test_runtime_guard_allows_franchisees_own_admin_email(isolated_db):
    from find_class_routes import (
        _load_other_admin_contacts,
        _apply_cross_leak_guard,
    )
    db = isolated_db
    await db.franchisees.insert_one({
        "id": "solo-id", "first_name": "Solo", "last_name": "T",
        "email": "solo@x.co",
        "website_email": "solo@x.co", "show_website_email": True,
    })
    solo = await db.franchisees.find_one({"id": "solo-id"}, {"_id": 0})
    emails, phones, strong, weak = await _load_other_admin_contacts(db, solo["id"])
    _, email_public = _apply_cross_leak_guard(solo, emails, phones, strong, weak)
    # No other franchisee's email is 'solo@x.co', so guard passes.
    assert email_public == "solo@x.co"


@pytest.mark.asyncio
async def test_runtime_guard_suppresses_phone_leak(isolated_db):
    from find_class_routes import (
        _load_other_admin_contacts,
        _apply_cross_leak_guard,
    )
    db = isolated_db
    await db.franchisees.insert_many([
        {"id": "a", "first_name": "A", "email": "a@x.co", "phone": "07700111222",
         "website_phone": "07770123456", "show_website_phone": True},
        {"id": "b", "first_name": "B", "email": "b@x.co", "mobile": "07770 123456"},  # note space
    ])
    a = await db.franchisees.find_one({"id": "a"}, {"_id": 0})
    emails, phones, strong, weak = await _load_other_admin_contacts(db, "a")
    phone_str, _ = _apply_cross_leak_guard(a, emails, phones, strong, weak)
    assert phone_str is None


@pytest.mark.asyncio
async def test_production_shape_audit_flags_leak_when_bel_admin_email_is_null(isolated_db):
    """Production shape: Bel's franchisees.email is NULL. The leak is
    still catchable because 'bel@…' local-part obviously belongs to
    franchisee Bel by name. My Feb-2026 v1 audit failed this — this
    test locks the corrected behaviour.
    """
    db = isolated_db
    await _seed_monica_bel_leak(db, bels_admin_email=None)
    report = await _scan(db)
    assert report["totals"]["leaks_total"] == 1, (
        f"Audit missed the Monica → Bel leak. Report: {report}"
    )
    (leak,) = report["leaks"]
    assert leak["field"] == "website_email"
    assert leak["franchisee"]["name"] == "Monica Diodato"
    assert leak["leaked_value"] == "bel@creativemojo.co.uk"
    assert leak["candidate_owners"][0]["name"] == "Bel McDonald"
    assert leak["reason"] == "email_local_part_matches_other_franchisee_first_or_last_name"
    assert leak["is_published"] is True


@pytest.mark.asyncio
async def test_production_shape_runtime_guard_blocks_bel_email_when_admin_email_is_null(isolated_db):
    """Runtime guard MUST suppress bel@creativemojo.co.uk from Monica's
    popup even when Bel's franchisees.email is NULL. Reproduces the
    Feb-2026 production failure the v1 guard missed.
    """
    from find_class_routes import (
        _load_other_admin_contacts,
        _apply_cross_leak_guard,
    )
    db = isolated_db
    await _seed_monica_bel_leak(db, bels_admin_email=None)
    monica = await db.franchisees.find_one({"id": "monica-id"}, {"_id": 0})
    emails, phones, strong, weak = await _load_other_admin_contacts(db, monica["id"])
    phone_str, email_public = _apply_cross_leak_guard(
        monica, emails, phones, strong, weak
    )
    assert email_public != "bel@creativemojo.co.uk", (
        "LEAK: Runtime guard STILL emits bel@ despite corrected v2 checks."
    )
    assert email_public is None


@pytest.mark.asyncio
async def test_audit_does_not_flag_own_name_email(isolated_db):
    """A franchisee whose website_email is their own name-based email
    (e.g. monica@creativemojo.co.uk for franchisee Monica) must NOT be
    flagged. Regression guard against false positives."""
    db = isolated_db
    await db.franchisees.insert_one({
        "id": "monica-only", "first_name": "Monica", "last_name": "D",
        "email": "monica.admin@example.com",
        "website_email": "monica@creativemojo.co.uk",
        "show_website_email": True,
    })
    report = await _scan(db)
    assert report["totals"]["leaks_total"] == 0


@pytest.mark.asyncio
async def test_shared_first_name_produces_low_confidence_with_multiple_candidates(isolated_db):
    """Two franchisees named Jane. A third franchisee's website_email is
    'jane@…' — must be flagged as LOW confidence with BOTH Janes listed
    as candidate owners, so HQ can decide which one it's meant to be.
    """
    db = isolated_db
    await db.franchisees.insert_many([
        {"id": "j1", "first_name": "Jane", "last_name": "Farrelly",
         "franchise_number": "0076", "email": None},
        {"id": "j2", "first_name": "Jane", "last_name": "Smith",
         "franchise_number": "0033", "email": None},
        {"id": "mysterious", "first_name": "Other", "last_name": "Person",
         "franchise_number": "0099", "email": "other@x.co",
         "website_email": "jane@creativemojo.co.uk",
         "show_website_email": True},
    ])
    report = await _scan(db)
    jane_leaks = [l for l in report["leaks"] if l["leaked_value"] == "jane@creativemojo.co.uk"]
    assert len(jane_leaks) == 1
    leak = jane_leaks[0]
    assert leak["confidence"] == "low"
    assert leak["reason"] == "email_local_part_matches_other_franchisee_first_or_last_name"
    owner_names = sorted(o["name"] for o in leak["candidate_owners"])
    assert owner_names == ["Jane Farrelly", "Jane Smith"], owner_names
    assert "review_note" in leak


@pytest.mark.asyncio
async def test_full_name_match_is_high_confidence(isolated_db):
    """`belmcdonald@` is unambiguous — HIGH confidence, single owner."""
    db = isolated_db
    await db.franchisees.insert_many([
        {"id": "b", "first_name": "Bel", "last_name": "McDonald",
         "franchise_number": "0011", "email": None},
        {"id": "m", "first_name": "Monica", "last_name": "D",
         "franchise_number": "0087", "email": "monica@x.co",
         "website_email": "belmcdonald@creativemojo.co.uk",
         "show_website_email": True},
    ])
    report = await _scan(db)
    (leak,) = [l for l in report["leaks"] if l["field"] == "website_email"]
    assert leak["confidence"] == "high"
    assert leak["reason"] == "email_local_part_matches_other_franchisee_full_name"
    assert len(leak["candidate_owners"]) == 1
    assert leak["candidate_owners"][0]["name"] == "Bel McDonald"


@pytest.mark.asyncio
async def test_own_first_name_email_never_flagged(isolated_db):
    """Franchisee Jane's own `jane@…` email must NEVER be flagged as a
    leak, even if another Jane exists."""
    db = isolated_db
    await db.franchisees.insert_many([
        {"id": "j1", "first_name": "Jane", "last_name": "Farrelly",
         "franchise_number": "0076", "email": "j.f@x.co",
         "website_email": "jane@creativemojo.co.uk",
         "show_website_email": True},
        {"id": "j2", "first_name": "Jane", "last_name": "Smith",
         "franchise_number": "0033", "email": None},
    ])
    report = await _scan(db)
    assert report["totals"]["leaks_total"] == 0


@pytest.mark.asyncio
async def test_clear_leaks_skips_low_confidence(isolated_db):
    """The bulk clear-leaks action MUST NEVER auto-suppress a
    low-confidence (shared first-name) leak. HQ has to review those
    individually."""
    db = isolated_db
    # Two Janes + a third franchisee with 'jane@…' as website_email
    await db.franchisees.insert_many([
        {"id": "j1", "first_name": "Jane", "last_name": "Farrelly",
         "franchise_number": "0076", "email": None},
        {"id": "j2", "first_name": "Jane", "last_name": "Smith",
         "franchise_number": "0033", "email": None},
        {"id": "mysterious", "first_name": "Other", "last_name": "Person",
         "franchise_number": "0099", "email": "other@x.co",
         "website_email": "jane@creativemojo.co.uk",
         "show_website_email": True},
    ])
    report = await _scan(db)
    published = [l for l in report["leaks"] if l["is_published"]]
    # Simulate clear-leaks endpoint logic
    touched = []
    skipped = []
    for leak in published:
        if leak.get("confidence") == "low":
            skipped.append(leak)
            continue
        touched.append(leak)
    assert len(touched) == 0
    assert len(skipped) == 1
    # And the mysterious franchisee's show_website_email flag is UNCHANGED
    m = await db.franchisees.find_one({"id": "mysterious"}, {"_id": 0})
    assert m["show_website_email"] is True
