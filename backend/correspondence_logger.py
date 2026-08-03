"""Correspondence logging layer — Feb 2026.

Single source of truth for persisting outbound emails against a contact
so the Correspondence modal, delivery-event webhook, and future
reporting tools all read from the same shape. Any code path that sends
mail to a Sales & Contacts CRM record MUST call ``log_outbound()``
after the Resend send succeeds — this replaces ad-hoc ``email_sends``
inserts scattered across ``resend_routes``, ``contracts_routes`` etc.

Also owns the delivery-event applicator so webhook receivers stay
tiny and idempotent — dedupe is keyed on the Svix message id so a
retry from Resend cannot append a duplicate event row.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Iterable, Optional

logger = logging.getLogger("creative-mojo-admin.correspondence_logger")

# Whitelisted top-level categories so the timeline can filter by kind
# without stringly-typed sprawl. Extend deliberately.
KIND_REPLY   = "reply"        # Reply-with-Template + free-text replies
KIND_CONTRACT = "contract"    # Contract issuance / signing links
KIND_RENEWAL = "renewal"      # Renewal reminders
KIND_ESHOT   = "eshot"        # Marketing e-shot to a CRM contact
KIND_SYSTEM  = "system"       # Portal invites, password resets, etc.


async def log_outbound(
    db,
    *,
    contact_id: str,
    resend_id: Optional[str],
    message_id: str,
    subject: str,
    html: Optional[str],
    text: Optional[str] = None,
    from_addr: str,
    to: Iterable[str],
    cc: Iterable[str] = (),
    bcc: Iterable[str] = (),
    reply_to: Optional[str] = None,
    attachments: Optional[list[dict]] = None,
    category: str = KIND_REPLY,
    template_id: Optional[str] = None,
    sent_by: Optional[str] = None,
    send_id: Optional[str] = None,
    extra: Optional[dict[str, Any]] = None,
) -> str:
    """Insert a canonical outbound-email record.

    Returns the ``send_id`` we generated / used so the caller can
    round-trip it into their own domain object (e.g. contract issuance
    stores it on the contract for cross-linking).

    Idempotency: if a record already exists with this ``send_id`` OR
    with the same ``resend_id`` we short-circuit — no duplicates."""
    import secrets

    sid = send_id or secrets.token_hex(16)
    now = datetime.now(timezone.utc).isoformat()

    # Idempotency guard — Retry-safe by design.
    if resend_id:
        existing = await db.email_sends.find_one({"resend_id": resend_id}, {"_id": 0, "id": 1})
        if existing:
            return existing["id"]
    existing = await db.email_sends.find_one({"id": sid}, {"_id": 0, "id": 1})
    if existing:
        return existing["id"]

    doc: dict[str, Any] = {
        "id": sid,
        "resend_id": resend_id,
        "message_id": message_id,
        "contact_id": contact_id,
        "template_id": template_id,
        "category": category,
        "sent_by": sent_by,
        "sent_at": now,
        "to": [str(x) for x in (to or [])],
        "cc": [str(x) for x in (cc or [])],
        "bcc": [str(x) for x in (bcc or [])],
        "subject": subject,
        "from": from_addr,
        "reply_to": reply_to,
        "html": html,
        "text": text,
        "attachments": attachments or [],
        "events": [{"type": "sent", "at": now}],
        "last_event": "sent",
        "last_event_at": now,
    }
    if extra:
        # Callers can bolt on domain metadata (contract_id, campaign_id, etc.)
        # without us hard-coding it into the base schema.
        for k, v in extra.items():
            if k not in doc:
                doc[k] = v
    await db.email_sends.insert_one(doc)
    doc.pop("_id", None)
    return sid


async def record_delivery_event(
    db,
    *,
    resend_id: Optional[str],
    send_id: Optional[str],
    event_type: str,
    event_at: Optional[str] = None,
    meta: Optional[dict] = None,
    svix_id: Optional[str] = None,
) -> dict:
    """Idempotently append a delivery event to the matching ``email_sends`` row.

    Matching order: ``send_id`` (fastest, our own uuid) → ``resend_id``.
    Idempotency: we key on ``svix_id`` when present — one Svix delivery
    id can only ever produce one event row. Without it we fall back to a
    ``(send_id, event_type, event_at)`` triple which still deduplicates
    identical retries at the cost of not deduplicating true replays."""
    at = event_at or datetime.now(timezone.utc).isoformat()

    match = None
    if send_id:
        match = await db.email_sends.find_one({"id": send_id}, {"_id": 0, "id": 1, "events": 1})
    if not match and resend_id:
        match = await db.email_sends.find_one({"resend_id": resend_id}, {"_id": 0, "id": 1, "events": 1})
    if not match:
        return {"matched": False}

    # Idempotency: skip if we've already recorded this exact svix id or
    # (type, at) tuple. Fast path — events[] is a bounded array so a
    # linear scan is fine.
    events = match.get("events") or []
    for ev in events:
        if svix_id and ev.get("svix_id") == svix_id:
            return {"matched": True, "duplicate": True}
        if not svix_id and ev.get("type") == event_type and ev.get("at") == at:
            return {"matched": True, "duplicate": True}

    event: dict[str, Any] = {"type": event_type, "at": at}
    if svix_id:
        event["svix_id"] = svix_id
    if meta:
        event.update(meta)

    await db.email_sends.update_one(
        {"id": match["id"]},
        {
            "$push": {"events": event},
            "$set": {"last_event": event_type, "last_event_at": at},
        },
    )
    return {"matched": True, "duplicate": False, "id": match["id"]}


__all__ = [
    "log_outbound",
    "record_delivery_event",
    "KIND_REPLY",
    "KIND_CONTRACT",
    "KIND_RENEWAL",
    "KIND_ESHOT",
    "KIND_SYSTEM",
]
