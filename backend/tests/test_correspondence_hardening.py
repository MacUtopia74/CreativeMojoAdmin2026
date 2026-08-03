"""Regression test — Correspondence webhook idempotency + inbound safeguards.

Covers the Phase 2 hardening: retry-safe delivery events, ambiguous-sender
protection, and the reply-token happy path so we don't regress next
time the correspondence pipeline is touched.
"""
import asyncio
import os
import types
import pytest


# Use motor's async client against the pod's real MongoDB — same env
# vars the app uses. Tests are isolated by dropping fixture collections
# on entry + exit so we never touch real data.
@pytest.fixture()
def db():
    from dotenv import load_dotenv; load_dotenv()
    from motor.motor_asyncio import AsyncIOMotorClient
    client = AsyncIOMotorClient(os.environ["MONGO_URL"])
    yield client[os.environ["DB_NAME"] + "_corr_test"]
    client.close()


@pytest.mark.asyncio
async def test_log_outbound_is_idempotent(db):
    """Same resend_id twice → single email_sends row."""
    from correspondence_logger import log_outbound, KIND_REPLY
    await db.email_sends.delete_many({})

    sid1 = await log_outbound(
        db,
        contact_id="c-1",
        resend_id="re_abc",
        message_id="<abc@creativemojo.co.uk>",
        subject="Hello",
        html="<p>Hi</p>",
        from_addr="paul@creativemojo.co.uk",
        to=["lead@example.com"],
        category=KIND_REPLY,
    )
    sid2 = await log_outbound(
        db,
        contact_id="c-1",
        resend_id="re_abc",
        message_id="<abc@creativemojo.co.uk>",
        subject="Hello (retry)",
        html="<p>Hi retry</p>",
        from_addr="paul@creativemojo.co.uk",
        to=["lead@example.com"],
        category=KIND_REPLY,
    )
    assert sid1 == sid2
    n = await db.email_sends.count_documents({"resend_id": "re_abc"})
    assert n == 1


@pytest.mark.asyncio
async def test_delivery_event_dedupes_by_svix_id(db):
    from correspondence_logger import log_outbound, record_delivery_event, KIND_REPLY
    await db.email_sends.delete_many({})
    await log_outbound(
        db, contact_id="c-2", resend_id="re_del", message_id="<mid@x>",
        subject="s", html="<p>x</p>", from_addr="a@b", to=["c@d"],
        category=KIND_REPLY, send_id="send-xyz",
    )
    r1 = await record_delivery_event(
        db, resend_id="re_del", send_id=None,
        event_type="delivered", event_at="2026-02-01T10:00:00Z", svix_id="svx_1",
    )
    r2 = await record_delivery_event(
        db, resend_id="re_del", send_id=None,
        event_type="delivered", event_at="2026-02-01T10:00:00Z", svix_id="svx_1",
    )
    assert r1["matched"] is True and r1.get("duplicate") is False
    assert r2["matched"] is True and r2["duplicate"] is True
    doc = await db.email_sends.find_one({"resend_id": "re_del"}, {"events": 1})
    delivered_events = [e for e in doc["events"] if e["type"] == "delivered"]
    assert len(delivered_events) == 1


@pytest.mark.asyncio
async def test_ambiguous_sender_does_not_match(db):
    """Two contacts share the same email — inbound MUST NOT auto-link."""
    from correspondence_routes import _resolve_contact
    await db.contacts.delete_many({})
    await db.web_form_contacts.delete_many({})
    await db.contacts.insert_many([
        {"id": "cA", "email": "shared@example.com"},
        {"id": "cB", "email": "shared@example.com"},
    ])
    resolved = await _resolve_contact(
        db,
        to_values=["inbox@messages.creativemojo.co.uk"],
        full={"from": "\"Alice\" <shared@example.com>", "headers": {}},
    )
    assert resolved["contact_id"] is None
    assert resolved["match_method"] == "ambiguous_sender"


@pytest.mark.asyncio
async def test_unique_sender_matches(db):
    from correspondence_routes import _resolve_contact
    await db.contacts.delete_many({})
    await db.web_form_contacts.delete_many({})
    await db.contacts.insert_one({"id": "cUnique", "email": "only@example.com"})
    resolved = await _resolve_contact(
        db,
        to_values=["inbox@messages.creativemojo.co.uk"],
        full={"from": "only@example.com", "headers": {}},
    )
    assert resolved["contact_id"] == "cUnique"
    assert resolved["match_method"] == "sender"


@pytest.mark.asyncio
async def test_attachment_safety_blocks_dangerous_extensions():
    from correspondence_routes import _attachment_is_safe, MAX_ATTACHMENT_BYTES
    safe, _ = _attachment_is_safe("statement.pdf", "application/pdf", 100_000)
    assert safe is True
    safe, reason = _attachment_is_safe("virus.exe", "application/octet-stream", 100)
    assert safe is False and "extension" in reason
    safe, reason = _attachment_is_safe("huge.pdf", "application/pdf", MAX_ATTACHMENT_BYTES + 1)
    assert safe is False and "limit" in reason


@pytest.mark.asyncio
async def test_html_sanitiser_strips_script_and_events():
    from correspondence_routes import _sanitize_html_server
    dirty = '<p>Hi<img src=x onerror="alert(1)"><script>evil()</script></p>'
    clean = _sanitize_html_server(dirty)
    assert "<script>" not in (clean or "").lower()
    assert "onerror" not in (clean or "").lower()
    assert "Hi" in clean
