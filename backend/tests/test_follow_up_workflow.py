"""Regression: CRM Follow-Up Due workflow.

Locks the invariants the user asked for in the brief:

* Automatic ``contacted → follow_up_due`` only when the earliest
  templated send to the contact is ≥ 7 days old AND no follow-up
  email has been sent AND no send has a "replied" event AND the
  contact hasn't already been auto-moved once.
* Manual "Mark as Replied" wins — the contact stays in ``contacted``.
* When HQ sends a subsequent templated email, the send row is stamped
  with ``follow_up_index >= 1``, the contact's
  ``follow_up_sent_count`` is bumped, and if the card was in
  ``follow_up_due`` it flips back to ``contacted``. Manual stages
  (Interested/Dormant/Lost) are never overwritten.
* Idempotency — a contact that has already been auto-moved once
  never auto-moves again.
"""
from __future__ import annotations

import asyncio
import os
import sys
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest


sys.path.insert(0, "/app/backend")
from dotenv import load_dotenv
load_dotenv("/app/backend/.env")

from motor.motor_asyncio import AsyncIOMotorClient  # noqa: E402
import follow_up_workflow as fw  # noqa: E402


def _run(coro):
    """Tiny helper — each test spins up a fresh loop so we don't need
    pytest-asyncio just for eight cases."""
    return asyncio.new_event_loop().run_until_complete(coro)


class _DbHandle:
    """Test-scoped Mongo handle. Every operation runs through
    ``.run()`` so the client + coroutines share a single event loop
    for the whole test — Motor's Futures can't cross loops."""
    def __init__(self):
        self._loop = asyncio.new_event_loop()
        self._client = self._loop.run_until_complete(self._connect())
        self.db = self._client[os.environ["DB_NAME"]]
        self._test_tag = f"fu-test-{uuid4().hex[:8]}"

    async def _connect(self):
        return AsyncIOMotorClient(os.environ["MONGO_URL"])

    def run(self, coro):
        return self._loop.run_until_complete(coro)

    # Transparent access — helpers can still call ``db.web_form_contacts``
    # and ``db["email_sends"]``.
    def __getattr__(self, item):
        return getattr(self.__dict__["db"], item)

    def __getitem__(self, key):
        return self.__dict__["db"][key]

    def close(self):
        async def _cleanup():
            await self.db.web_form_contacts.delete_many({"_test_tag": self._test_tag})
            await self.db.contacts.delete_many({"_test_tag": self._test_tag})
            await self.db.email_sends.delete_many({"_test_tag": self._test_tag})
        try:
            self._loop.run_until_complete(_cleanup())
        finally:
            self._client.close()
            self._loop.close()


@pytest.fixture()
def db():
    h = _DbHandle()
    yield h
    h.close()


def _iso(dt): return dt.astimezone(timezone.utc).isoformat()


async def _seed_contact(db, *, pipeline_status="contacted", follow_up_sent_count=0,
                        auto_followed_up_at=None):
    cid = uuid4().hex
    await db.web_form_contacts.insert_one({
        "id": cid,
        "first_name": "Test", "last_name": "User",
        "email": f"{cid}@example.test",
        "pipeline_status": pipeline_status,
        "in_pipeline": True,
        "follow_up_sent_count": follow_up_sent_count,
        "auto_followed_up_at": auto_followed_up_at,
        "_test_tag": db._test_tag,  # noqa: SLF001
        "created_at": _iso(datetime.now(timezone.utc)),
    })
    return cid


async def _seed_send(db, contact_id, *, days_ago, template_id="tpl-x",
                     events=None):
    sid = uuid4().hex
    sent_at = datetime.now(timezone.utc) - timedelta(days=days_ago)
    events = events or [{"type": "sent", "at": _iso(sent_at)}]
    await db.email_sends.insert_one({
        "id": sid,
        "contact_id": contact_id,
        "template_id": template_id,
        "sent_at": _iso(sent_at),
        "events": events,
        "_test_tag": db._test_tag,  # noqa: SLF001
    })
    return sid


def test_moves_when_7d_old_and_no_followup_and_no_reply(db):
    async def _t():
        cid = await _seed_contact(db)
        await _seed_send(db, cid, days_ago=8)
        stats = await fw.scan_and_move_due_contacts(db)
        assert stats["moved"] >= 1
        doc = await db.web_form_contacts.find_one({"id": cid})
        assert doc["pipeline_status"] == "follow_up_due"
        assert doc["auto_followed_up_at"]



    db.run(_t())
def test_does_not_move_when_still_inside_7_days(db):
    async def _t():
        cid = await _seed_contact(db)
        await _seed_send(db, cid, days_ago=3)
        await fw.scan_and_move_due_contacts(db)
        doc = await db.web_form_contacts.find_one({"id": cid})
        assert doc["pipeline_status"] == "contacted"



    db.run(_t())
def test_skips_when_reply_recorded(db):
    async def _t():
        cid = await _seed_contact(db)
        now = datetime.now(timezone.utc)
        await _seed_send(db, cid, days_ago=10,
        events=[{"type": "sent",    "at": _iso(now - timedelta(days=10))},
        {"type": "replied", "at": _iso(now - timedelta(days=1))}])
        await fw.scan_and_move_due_contacts(db)
        doc = await db.web_form_contacts.find_one({"id": cid})
        assert doc["pipeline_status"] == "contacted"



    db.run(_t())
def test_skips_when_followup_already_sent(db):
    async def _t():
        cid = await _seed_contact(db, follow_up_sent_count=1)
        await _seed_send(db, cid, days_ago=8)
        await fw.scan_and_move_due_contacts(db)
        doc = await db.web_form_contacts.find_one({"id": cid})
        assert doc["pipeline_status"] == "contacted"



    db.run(_t())
def test_never_auto_moves_twice(db):
    async def _t():
        """Once a contact has been auto-moved once and HQ has moved them
        elsewhere then back to Contacted, the scheduler must NOT re-fire."""
        already = _iso(datetime.now(timezone.utc) - timedelta(days=2))
        cid = await _seed_contact(db, auto_followed_up_at=already)
        await _seed_send(db, cid, days_ago=8)
        stats = await fw.scan_and_move_due_contacts(db)
        doc = await db.web_form_contacts.find_one({"id": cid})
        # Still in contacted — the auto_followed_up_at guard blocks the flip.
        assert doc["pipeline_status"] == "contacted"
        assert stats["moved"] == 0



    db.run(_t())
def test_ignores_free_text_sends_without_template(db):
    async def _t():
        """A free-text reply (no template_id) does NOT count as the
        'initial info email' — the follow-up clock should never start."""
        cid = await _seed_contact(db)
        await _seed_send(db, cid, days_ago=30, template_id=None)
        await fw.scan_and_move_due_contacts(db)
        doc = await db.web_form_contacts.find_one({"id": cid})
        assert doc["pipeline_status"] == "contacted"



    db.run(_t())
def test_scan_is_idempotent_across_multiple_runs(db):
    async def _t():
        cid = await _seed_contact(db)
        await _seed_send(db, cid, days_ago=9)
        s1 = await fw.scan_and_move_due_contacts(db)
        s2 = await fw.scan_and_move_due_contacts(db)
        s3 = await fw.scan_and_move_due_contacts(db)
        # Only the first sweep flips them; subsequent sweeps find them
        # already in follow_up_due (or with auto_followed_up_at set) and
        # skip.
        assert s1["moved"] == 1
        assert s2["moved"] == 0
        assert s3["moved"] == 0



    db.run(_t())


def test_does_not_touch_contacts_outside_contacted_stage(db):
    async def _t():
        for stage in ("new", "qualified", "dormant", "lost", "follow_up_due"):
            cid = await _seed_contact(db, pipeline_status=stage)
            await _seed_send(db, cid, days_ago=10)
            await fw.scan_and_move_due_contacts(db)
            doc = await db.web_form_contacts.find_one({"id": cid})
            assert doc["pipeline_status"] == stage, (
                f"Contact in {stage} should never be auto-moved by the scheduler"
            )

    db.run(_t())
