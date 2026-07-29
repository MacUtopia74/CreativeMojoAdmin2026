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


async def _seed_monica_bel_leak(db):
    """Two franchisees. Monica's `website_email` accidentally points at
    Bel's admin `email` — this is the pattern we saw on production."""
    await db.franchisees.insert_many([
        {
            "id": "monica-id",
            "first_name": "Monica", "last_name": "Diodato",
            "franchise_number": "0087",
            "email": "monica@creativemojo.co.uk",         # her admin email
            "phone": "07522421735",
            "website_email": "bel@creativemojo.co.uk",    # ← THE LEAK
            "website_phone": "07522421735",
            "show_website_email": True,
            "show_website_phone": True,
            "website_bio": "Hi, I'm Monica.",
            "show_website_bio": True,
            "wp_page_url": "https://creativemojo.co.uk/monica",
        },
        {
            "id": "bel-id",
            "first_name": "Bel", "last_name": "McDonald",
            "franchise_number": "0091",
            "email": "bel@creativemojo.co.uk",            # Bel's admin email
            "phone": "07770123456",
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
    assert leak["belongs_to"]["name"] == "Bel McDonald"
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
    emails, phones = await _load_other_admin_contacts(db, monica["id"])
    phone_str, email_public = _apply_cross_leak_guard(monica, emails, phones)
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
    emails, phones = await _load_other_admin_contacts(db, solo["id"])
    _, email_public = _apply_cross_leak_guard(solo, emails, phones)
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
    emails, phones = await _load_other_admin_contacts(db, "a")
    phone_str, _ = _apply_cross_leak_guard(a, emails, phones)
    assert phone_str is None
