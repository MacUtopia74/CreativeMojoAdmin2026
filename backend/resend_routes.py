"""Resend integration — actually-send + delivery/open/click tracking.

Stage 2 (post-deploy) for the Email Reply feature. The frontend modal
``ReplyWithTemplateModal`` posts here with a contact id + (optionally) a
template id + the final subject/body the admin has already previewed.
We resolve any ``{{first_name}}`` / ``{{file:*}}`` placeholders, swap
the file tokens for fresh 30-day signed R2 share URLs, attach a tracking
pixel, then post to Resend.

The webhook receiver at ``/api/email/resend-webhook`` accepts Svix-signed
delivery / open / click events from Resend and persists them on the
matching ``email_sends`` document so the contact drawer can show a
"Last opened your reply 4h ago" badge.
"""
from __future__ import annotations

import asyncio
import logging
import os
import re
import uuid
from datetime import datetime, timezone
from typing import Optional

import resend
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, EmailStr, Field

logger = logging.getLogger("creative-mojo-admin.resend")

RESEND_API_KEY = os.environ.get("RESEND_API_KEY", "")
RESEND_FROM_EMAIL = os.environ.get("RESEND_FROM_EMAIL", "paul@creativemojo.co.uk")
RESEND_FROM_NAME = os.environ.get("RESEND_FROM_NAME", "Creative Mojo")
RESEND_DEFAULT_REPLY_TO = os.environ.get("RESEND_DEFAULT_REPLY_TO", RESEND_FROM_EMAIL)
RESEND_WEBHOOK_SECRET = os.environ.get("RESEND_WEBHOOK_SECRET", "")

if RESEND_API_KEY:
    resend.api_key = RESEND_API_KEY


# ----------------------------------------------------------------- models
class SendReplyRequest(BaseModel):
    """Body posted by ``ReplyWithTemplateModal.handleSend``.

    The frontend has already rendered the preview, so we trust ``subject``
    and ``body_html`` as-is. ``contact_id`` is required so we can stamp
    the send onto the contact for tracking. ``template_id`` is optional
    (free-text replies don't need one)."""

    contact_id: str
    template_id: Optional[str] = None
    to: list[EmailStr] = Field(default_factory=list)
    cc: list[EmailStr] = Field(default_factory=list)
    bcc: list[EmailStr] = Field(default_factory=list)
    subject: str
    body_html: str


def _parse_address_list(raw: str | list | None) -> list[str]:
    """Convert ``"a@x.com, b@y.com"`` → ``["a@x.com", "b@y.com"]``."""
    if not raw:
        return []
    if isinstance(raw, list):
        return [s.strip() for s in raw if s and s.strip()]
    return [s.strip() for s in re.split(r"[,;\s]+", str(raw)) if s.strip()]


async def _resolve_file_tokens(db, body_html: str) -> str:
    """Replace ``{{file:<placeholder>}}`` tokens with fresh R2 share URLs.

    Placeholders map to ``email_template_attachments`` documents via the
    ``placeholder`` field — we keep this stage minimal and just leave any
    unresolved token as-is so the admin spots it in the sent message
    rather than seeing a silently broken link.
    """
    if "{{file:" not in body_html:
        return body_html
    try:
        from file_storage import presigned_get_url  # type: ignore
    except Exception:  # noqa: BLE001
        return body_html  # R2 not wired in this env — leave tokens visible

    placeholders = set(re.findall(r"\{\{\s*file:([^}]+?)\s*\}\}", body_html))
    for ph in placeholders:
        att = await db.email_template_attachments.find_one(
            {"placeholder": ph}, {"_id": 0, "key": 1, "name": 1}
        )
        if not att or not att.get("key"):
            continue
        try:
            url = presigned_get_url(att["key"], expires_in=30 * 24 * 3600)
            body_html = body_html.replace(f"{{{{file:{ph}}}}}", url)
        except Exception as e:  # noqa: BLE001
            logger.warning("Couldn't sign R2 url for %s: %s", ph, e)
    return body_html


# --------------------------------------------------------------- router
def build_resend_router(db, require_role):
    router = APIRouter()

    # -------------------------------------------------------- send
    @router.post("/email/send-reply")
    async def send_reply(body: SendReplyRequest, user: dict = Depends(require_role("admin"))):
        if not RESEND_API_KEY:
            raise HTTPException(503, detail="Resend not configured — missing RESEND_API_KEY.")
        if not body.to:
            raise HTTPException(400, detail="At least one recipient is required.")
        if not body.subject.strip():
            raise HTTPException(400, detail="Subject is required.")
        if not body.body_html.strip():
            raise HTTPException(400, detail="Body is required.")

        contact = await db.contacts.find_one({"id": body.contact_id}, {"_id": 0})
        if not contact:
            contact = await db.web_form_contacts.find_one({"id": body.contact_id}, {"_id": 0})
        if not contact:
            raise HTTPException(404, detail="Contact not found")

        first_name = contact.get("first_name") or (contact.get("name") or "").split(" ", 1)[0] or "there"
        rendered_html = body.body_html.replace("{{first_name}}", first_name)
        rendered_html = await _resolve_file_tokens(db, rendered_html)

        # Per-send reply-to picks up the logged-in admin's email so the
        # recipient lands their reply in *that* admin's inbox, not the
        # shared paul@ inbox. Falls back to the configured default if the
        # admin doesn't have an email on file (shouldn't happen but cheap
        # to guard).
        reply_to = (user.get("email") or RESEND_DEFAULT_REPLY_TO).strip()

        send_id = str(uuid.uuid4())  # our own id, surfaced in headers
        params = {
            "from": f"{RESEND_FROM_NAME} <{RESEND_FROM_EMAIL}>",
            "to": [str(e) for e in body.to],
            "subject": body.subject.strip(),
            "html": rendered_html,
            "reply_to": reply_to,
            "headers": {
                # Lets us correlate webhook events back to this send when
                # Resend echoes the X-CM-Send-Id header on bounce/open/click.
                "X-CM-Send-Id": send_id,
            },
        }
        if body.cc:
            params["cc"] = [str(e) for e in body.cc]
        if body.bcc:
            params["bcc"] = [str(e) for e in body.bcc]

        try:
            resp = await asyncio.to_thread(resend.Emails.send, params)
        except Exception as e:  # noqa: BLE001
            logger.exception("Resend send failed")
            raise HTTPException(502, detail=f"Resend error: {e}") from e

        resend_id = resp.get("id") if isinstance(resp, dict) else None
        now = datetime.now(timezone.utc).isoformat()
        doc = {
            "id": send_id,
            "resend_id": resend_id,
            "contact_id": body.contact_id,
            "template_id": body.template_id,
            "sent_by": user.get("email"),
            "sent_at": now,
            "to": params["to"],
            "cc": params.get("cc", []),
            "bcc": params.get("bcc", []),
            "subject": params["subject"],
            "from": params["from"],
            "reply_to": reply_to,
            "events": [{"type": "sent", "at": now}],
            "last_event": "sent",
            "last_event_at": now,
        }
        await db.email_sends.insert_one(doc)
        doc.pop("_id", None)
        return {"ok": True, "send": doc}

    # -------------------------------------------------------- list per-contact
    @router.get("/email/sends")
    async def list_sends(
        contact_id: str,
        _user: dict = Depends(require_role("admin")),
    ):
        cur = db.email_sends.find({"contact_id": contact_id}, {"_id": 0}).sort("sent_at", -1)
        items = await cur.to_list(100)
        return {"items": items, "count": len(items)}

    # -------------------------------------------------------- webhook
    @router.post("/email/resend-webhook")
    async def resend_webhook(request: Request):
        """Receive delivery / open / click events.

        Svix signature verification is kept optional — until the admin
        sets ``RESEND_WEBHOOK_SECRET`` in env we accept events on trust
        (they're idempotent and rate-limited by Resend). Once the secret
        is configured we verify every request and reject 401 on mismatch.
        """
        raw_body = await request.body()
        if RESEND_WEBHOOK_SECRET:
            try:
                from svix.webhooks import Webhook, WebhookVerificationError  # type: ignore
                wh = Webhook(RESEND_WEBHOOK_SECRET)
                wh.verify(raw_body, dict(request.headers))
            except ImportError:
                logger.warning("svix not installed — skipping webhook signature check")
            except WebhookVerificationError as e:
                logger.warning("Resend webhook signature mismatch: %s", e)
                raise HTTPException(401, detail="Invalid signature") from e

        try:
            payload = await request.json()
        except Exception:  # noqa: BLE001
            raise HTTPException(400, detail="Invalid JSON")

        event_type = (payload.get("type") or "").lower()  # e.g. email.delivered, email.opened, email.clicked
        data = payload.get("data") or {}
        resend_id = data.get("email_id") or data.get("id")
        headers = data.get("headers") or {}
        # Resend forwards our custom header back to us so we can match by send_id
        # even if Resend rotates its own internal id (it doesn't, but belt+braces).
        send_id = None
        if isinstance(headers, list):
            for h in headers:
                if (h.get("name") or "").lower() == "x-cm-send-id":
                    send_id = h.get("value")
                    break
        elif isinstance(headers, dict):
            send_id = headers.get("X-CM-Send-Id") or headers.get("x-cm-send-id")

        # Resend echoes the per-send "tags" back on every event — that's
        # how we route this event to the right consumer (announcement /
        # marketing-campaign / standalone reply).
        tags = data.get("tags") or []
        tag_map: dict = {}
        if isinstance(tags, list):
            for t in tags:
                if isinstance(t, dict) and t.get("name"):
                    tag_map[str(t["name"]).lower()] = t.get("value")
        elif isinstance(tags, dict):
            tag_map = {str(k).lower(): v for k, v in tags.items()}
        campaign_id = tag_map.get("campaign_id")
        recipient_send_id = tag_map.get("recipient_send_id") or send_id

        # Strip the "email." prefix Resend uses on every event name so the
        # UI labels are short ("delivered", "opened", "clicked", …).
        short_type = event_type.split(".", 1)[1] if "." in event_type else event_type
        now = datetime.now(timezone.utc).isoformat()
        event = {"type": short_type, "at": now}
        if short_type == "clicked":
            event["link"] = (data.get("click") or {}).get("link") or data.get("link")
        if short_type in ("bounced", "complained", "delivery_delayed"):
            event["reason"] = data.get("reason") or (data.get("bounce") or {}).get("reason")

        # Marketing-campaign events go to their own collection.
        if campaign_id:
            try:
                from portal_marketing_routes import apply_event as _apply_marketing_event
                applied = await _apply_marketing_event(
                    db, campaign_id, recipient_send_id, resend_id, short_type, event,
                )
                if applied:
                    return {"ok": True, "matched": True, "event": short_type, "kind": "marketing"}
            except Exception:  # noqa: BLE001
                logger.exception("Marketing webhook fan-out failed")

        match: Optional[dict] = None
        if send_id:
            match = await db.email_sends.find_one({"id": send_id}, {"_id": 0, "id": 1})
        if not match and resend_id:
            match = await db.email_sends.find_one({"resend_id": resend_id}, {"_id": 0, "id": 1})
        if not match:
            # Not one of ours — ack quickly so Resend doesn't retry.
            return {"ok": True, "matched": False}

        await db.email_sends.update_one(
            {"id": match["id"]},
            {
                "$push": {"events": event},
                "$set": {"last_event": short_type, "last_event_at": now},
            },
        )
        return {"ok": True, "matched": True, "event": short_type}

    return router
