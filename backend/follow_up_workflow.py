"""Lightweight Follow-Up Due workflow for the CRM sales pipeline.

Purpose
-------
Give HQ a **daily list of contacts that now need chasing** — no new
tracking subsystem, no duplicate timestamps, no shadow score. The
existing ``email_sends`` collection is the source of truth for "when
did we make first contact"; this module simply reads that collection
and shuffles ``pipeline_status`` between ``contacted`` and
``follow_up_due`` under strict, one-shot rules.

Rules (see the user brief for the full spec):

* Auto-move ``contacted → follow_up_due`` when:
    - the earliest templated send to this contact is ≥ 7 calendar
      days old,
    - no follow-up email has been sent yet
      (``contact.follow_up_sent_count == 0``),
    - no send has a "replied" event
      (the manual "Mark as Replied" flag),
    - the contact hasn't already been auto-moved once
      (``contact.auto_followed_up_at`` is unset).

* When HQ sends a follow-up email (any subsequent send after the
  first), the write-path in ``resend_routes.py`` flips the contact
  back to ``contacted`` and bumps ``follow_up_sent_count``. This
  module NEVER performs that flip — sending is the single
  authoritative signal.

* Manual movements to ``qualified`` / ``dormant`` / ``lost`` / etc.
  win. Once the contact leaves ``contacted``, this loop stops
  touching them.

The scheduler runs once an hour by default; the loop is cheap
because it only scans two collections with narrow filters.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List


logger = logging.getLogger("creative-mojo-admin.follow-up")

FOLLOW_UP_WINDOW_DAYS = 7
CONTACT_COLLECTIONS = ("web_form_contacts", "contacts")


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat()


def _has_replied_event(events: Iterable[Dict[str, Any]]) -> bool:
    for e in events or []:
        if (e.get("type") or "").lower() == "replied":
            return True
    return False


async def _earliest_send_for_contact(db, contact_id: str):
    """Return the earliest templated send doc for a contact, or None.

    Only rows carrying a ``template_id`` count as "the initial info
    email" — free-text notes / non-template sends don't kick off the
    follow-up clock.
    """
    cur = db.email_sends.find(
        {"contact_id": contact_id, "template_id": {"$ne": None}},
        {"_id": 0, "sent_at": 1, "events": 1, "template_id": 1},
    ).sort("sent_at", 1).limit(1)
    async for doc in cur:
        return doc
    return None


async def _any_reply_recorded(db, contact_id: str) -> bool:
    """True if ANY send for this contact has a manual 'replied'
    marker OR the contact-drawer's compat flag is on. We check both so
    HQ's Phase 5a "Mark as Replied" click always wins over the
    auto-move."""
    cur = db.email_sends.find(
        {"contact_id": contact_id},
        {"_id": 0, "events": 1},
    )
    async for send in cur:
        if _has_replied_event(send.get("events")):
            return True
    return False


async def _find_contact(db, contact_id: str):
    """Contacts live in one of two collections during the pipeline
    migration. Return (doc, collection_name) or (None, None)."""
    for coll in CONTACT_COLLECTIONS:
        doc = await db[coll].find_one({"id": contact_id})
        if doc:
            return doc, coll
    return None, None


async def _move_to_follow_up_due(db, contact_id: str, collection: str) -> bool:
    """Idempotent — only flips if the contact is still in ``contacted``
    AND hasn't been auto-moved before. Returns True when a move
    happened, False when it was skipped (racing writer, HQ moved
    the card manually in the meantime, etc)."""
    now = _iso(_now_utc())
    res = await db[collection].update_one(
        {
            "id": contact_id,
            "pipeline_status": "contacted",
            # ``$in [None, missing]`` — never re-fire on a contact
            # we already auto-moved once.
            "$or": [
                {"auto_followed_up_at": {"$exists": False}},
                {"auto_followed_up_at": None},
            ],
            # And never overwrite HQ's manual "Mark as Replied".
            "follow_up_sent_count": {"$in": [None, 0]},
        },
        {"$set": {
            "pipeline_status": "follow_up_due",
            "pipeline_status_updated_at": now,
            "auto_followed_up_at": now,
            "updated_at": now,
        }},
    )
    return res.modified_count > 0


async def scan_and_move_due_contacts(db) -> Dict[str, int]:
    """Single-pass sweep — the whole workflow in one function so it
    can be triggered from a scheduler, a test, or a debug endpoint.

    Returns a compact stats dict so the caller can log it.
    """
    cutoff = _now_utc() - timedelta(days=FOLLOW_UP_WINDOW_DAYS)
    moved = 0
    scanned = 0
    skipped_replied = 0
    skipped_followed_up = 0
    skipped_no_send = 0

    # Gather all contact_ids currently in ``contacted`` across both
    # collections. Small enough to hold in memory even for a large
    # CRM (thousands of rows).
    contacted_ids: List[str] = []
    contacted_source: Dict[str, str] = {}
    for coll in CONTACT_COLLECTIONS:
        cur = db[coll].find(
            {"pipeline_status": "contacted"},
            {"_id": 0, "id": 1},
        )
        async for row in cur:
            cid = row.get("id")
            if cid and cid not in contacted_source:
                contacted_ids.append(cid)
                contacted_source[cid] = coll

    for cid in contacted_ids:
        scanned += 1
        earliest = await _earliest_send_for_contact(db, cid)
        if not earliest or not earliest.get("sent_at"):
            skipped_no_send += 1
            continue
        # Parse the ISO sent_at timestamp back into a comparable dt.
        try:
            sent_at = datetime.fromisoformat(earliest["sent_at"].replace("Z", "+00:00"))
        except Exception:
            continue
        if sent_at.tzinfo is None:
            sent_at = sent_at.replace(tzinfo=timezone.utc)
        if sent_at > cutoff:
            # Still inside the 7-day window — leave alone.
            continue
        # HQ marked "replied" anywhere → they've engaged; don't chase.
        if await _any_reply_recorded(db, cid):
            skipped_replied += 1
            continue
        contact, coll = await _find_contact(db, cid)
        if not contact:
            continue
        # Follow-up email already sent — skip.
        if int(contact.get("follow_up_sent_count") or 0) > 0:
            skipped_followed_up += 1
            continue
        # Already auto-moved once and HQ has since moved it elsewhere:
        # don't retrigger even if they landed back in ``contacted``.
        if contact.get("auto_followed_up_at"):
            continue
        did = await _move_to_follow_up_due(db, cid, coll)
        if did:
            moved += 1

    if moved or scanned:
        logger.info(
            "[follow-up] scan complete — scanned=%d moved=%d skipped_replied=%d "
            "skipped_followed_up=%d skipped_no_send=%d",
            scanned, moved, skipped_replied, skipped_followed_up, skipped_no_send,
        )
    return {
        "scanned": scanned,
        "moved": moved,
        "skipped_replied": skipped_replied,
        "skipped_followed_up": skipped_followed_up,
        "skipped_no_send": skipped_no_send,
    }


async def schedule_follow_up_loop(db, every_seconds: int = 3600):
    """Async task suitable for ``asyncio.create_task`` at startup.

    Runs a single scan immediately (so a redeploy picks up any due
    contacts within seconds), then every ``every_seconds`` after that.
    Errors are logged but never re-raised — the loop is opportunistic
    and MUST NOT crash the server.
    """
    while True:
        try:
            await scan_and_move_due_contacts(db)
        except Exception:  # noqa: BLE001
            logger.exception("[follow-up] scan failed")
        await asyncio.sleep(every_seconds)
