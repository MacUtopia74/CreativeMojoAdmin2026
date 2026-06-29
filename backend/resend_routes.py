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
# Note: also re-exported in resend_config.py — both surfaces stay in
# sync because they read from the same env var. Kept here for backward
# compatibility with code that imported it from this module.
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
            logger.warning("Could not resolve R2 file token %s: %s", ph, e)
    return body_html


async def _resolve_landing_tokens(db, body_html: str, send_id: str, request_base: str | None = None) -> str:
    """Replace ``{{landing:<slug>}}`` tokens with the public landing-page
    URL. Appends ``?t=<send_id>`` so the visit-tracker can attribute the
    open back to the originating ``email_sends`` row.

    Origin resolution order — production-first, because recipients click
    these links from real emails forwarded outside the org:
      1. ``PUBLIC_BASE_URL`` env var (explicit override for staging/preview)
      2. ``https://hub.creativemojo.co.uk`` (canonical production)

    Note: we intentionally don't fall back to the request host — emails
    sent from preview must still point recipients at the live site,
    otherwise share-from-inbox flows break (cluster URLs are
    preview-only and don't authenticate). ``request_base`` is accepted
    but only used if PUBLIC_BASE_URL explicitly equals "__request_host__".

    Falls back to leaving the token visible if the slug doesn't match an
    active landing page — that way the admin notices in the sent email
    rather than the link silently going nowhere.
    """
    if "{{landing:" not in body_html:
        return body_html
    slugs = set(re.findall(r"\{\{\s*landing:([a-z0-9-]+?)\s*\}\}", body_html))
    if not slugs:
        return body_html
    import os
    explicit = os.environ.get("PUBLIC_BASE_URL")
    if explicit == "__request_host__" and request_base:
        base = request_base.rstrip("/")
    else:
        base = (explicit or "https://hub.creativemojo.co.uk").rstrip("/")
    for slug in slugs:
        page = await db.landing_pages.find_one(
            {"slug": slug, "active": True}, {"_id": 0, "slug": 1},
        )
        if not page:
            continue
        url = f"{base}/info/{slug}?t={send_id}"
        body_html = body_html.replace(f"{{{{landing:{slug}}}}}", url)
    return body_html


# Inline style snippets used by the WYSIWYG editor's "Yellow CTA" and
# "Outline" button options. Email clients (Gmail web, Outlook desktop)
# strip <style> blocks, so we must inject these as inline ``style=""``
# attributes at send time so the admin's WYSIWYG view matches what the
# recipient actually sees.
_CTA_STYLE = ("display:inline-block;background:#dddd16;color:#1a1a1a;"
              "font-weight:700;text-decoration:none;padding:11px 26px;"
              "border-radius:4px;font-size:13px;letter-spacing:0.5px;"
              "text-transform:uppercase;")
_OUTLINE_STYLE = ("display:inline-block;background:transparent;color:#1a1a1a;"
                  "font-weight:700;text-decoration:none;padding:11px 26px;"
                  "border:2px solid #1a1a1a;border-radius:4px;font-size:13px;"
                  "letter-spacing:0.5px;text-transform:uppercase;")


def _inline_button_styles(body_html: str) -> str:
    """Convert ``class="cm-btn-cta"`` / ``class="cm-btn-outline"`` anchors
    into inline-styled buttons. Email clients strip <style> tags so the
    WYSIWYG editor's CSS class hooks would otherwise render as bare links
    in Gmail/Outlook/etc. Run this just before despatch.
    """
    if not body_html:
        return body_html
    def _replace(match: re.Match) -> str:
        attrs = match.group(1)
        # Pick the style based on the class token present.
        if "cm-btn-outline" in attrs:
            style = _OUTLINE_STYLE
        else:
            style = _CTA_STYLE
        # Inject (or extend) a style attribute. Strip the class so the
        # final HTML is squeaky-clean.
        attrs = re.sub(r'\s*class="[^"]*"', "", attrs, count=1)
        if "style=" in attrs:
            attrs = re.sub(r'style="([^"]*)"', lambda m: f'style="{m.group(1).rstrip(";")};{style}"', attrs, count=1)
        else:
            attrs = f'{attrs} style="{style}"'
        return f"<a{attrs}>"
    return re.sub(r'<a([^>]*?class="[^"]*cm-btn-(?:cta|outline)[^"]*"[^>]*)>',
                  _replace, body_html, flags=re.IGNORECASE)


# --------------------------------------------------------------- router
def build_resend_router(db, require_role):
    router = APIRouter()

    # -------------------------------------------------------- send
    @router.post("/email/send-reply")
    async def send_reply(body: SendReplyRequest, request: Request, user: dict = Depends(require_role("admin"))):
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
        send_id = str(uuid.uuid4())  # our own id, surfaced in headers + landing links
        rendered_html = body.body_html.replace("{{first_name}}", first_name)
        rendered_html = await _resolve_file_tokens(db, rendered_html)
        rendered_html = await _resolve_landing_tokens(
            db, rendered_html, send_id,
            request_base=f"{request.url.scheme}://{request.url.netloc}" if request and request.url else None,
        )
        # Convert WYSIWYG button classes → inline styles so email clients
        # that strip <style> tags still render the yellow CTA / outline
        # buttons exactly as the admin saw them in the editor.
        rendered_html = _inline_button_styles(rendered_html)

        # Reply-to precedence:
        #   1. Template's `default_from` (where the owner of THIS template
        #      reads replies — e.g. paul@creativemojo.co.uk on the
        #      Franchise Reply template).
        #   2. Logged-in admin's email (only if the template has no
        #      default_from set).
        #   3. ``RESEND_DEFAULT_REPLY_TO`` env var as the final safety
        #      net.
        # We intentionally DON'T use the logged-in user first — generic
        # admin accounts like admin@creativemojo.co.uk aren't monitored,
        # so replies would land in a dead inbox.
        template_reply_to = ""
        if body.template_id:
            tpl = await db.email_templates.find_one(
                {"id": body.template_id}, {"_id": 0, "default_from": 1},
            )
            template_reply_to = (tpl or {}).get("default_from", "").strip()
        if template_reply_to:
            reply_to = template_reply_to
        else:
            reply_to = (user.get("email") or RESEND_DEFAULT_REPLY_TO).strip()

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
        # Always BCC franchises@creativemojo.co.uk so HQ has an off-system
        # audit trail of every enquiry reply. De-duplicated against any
        # explicit bcc the admin set.
        bcc_set = {str(e).strip().lower() for e in (body.bcc or [])}
        bcc_set.add("franchises@creativemojo.co.uk")
        params["bcc"] = sorted(bcc_set)

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

    # ----------------------------- Phase 5a — manual reply detection
    # Until Resend Inbound + Outlook forwarding lands (Phase 5b), admins
    # mark a send as "replied" themselves when they see the reply in
    # their inbox. The recorded event surfaces in the EmailTimeline rail
    # and feeds into the Lead Temperature engine via the +15 reply boost
    # (which we'll wire up in Phase 4.1).
    @router.post("/email/sends/{send_id}/mark-replied")
    async def mark_replied(
        send_id: str,
        user: dict = Depends(require_role("admin")),
    ):
        from datetime import datetime as _dt, timezone as _tz
        existing = await db.email_sends.find_one({"id": send_id}, {"_id": 0, "id": 1, "events": 1})
        if not existing:
            raise HTTPException(404, "Send not found")
        # Idempotent — return cleanly if already marked.
        already = any((e.get("type") == "replied") for e in (existing.get("events") or []))
        if already:
            return {"ok": True, "already_marked": True}
        event = {
            "type": "replied",
            "at": _dt.now(_tz.utc).isoformat(),
            "marked_by": user.get("email"),
        }
        await db.email_sends.update_one(
            {"id": send_id},
            {
                "$push": {"events": event},
                "$set": {"last_event": "replied", "last_event_at": event["at"]},
            },
        )
        return {"ok": True, "event": event}

    @router.delete("/email/sends/{send_id}/mark-replied")
    async def unmark_replied(
        send_id: str,
        _user: dict = Depends(require_role("admin")),
    ):
        """Undo a manual 'replied' marker if it was clicked by mistake.
        Removes the most recent reply event and recomputes last_event
        from whatever survived (falls back to ``sent`` if empty).
        """
        existing = await db.email_sends.find_one({"id": send_id}, {"_id": 0, "id": 1, "events": 1})
        if not existing:
            raise HTTPException(404, "Send not found")
        events = [e for e in (existing.get("events") or []) if e.get("type") != "replied"]
        last = events[-1] if events else None
        await db.email_sends.update_one(
            {"id": send_id},
            {"$set": {
                "events": events,
                "last_event": (last or {}).get("type") or "sent",
                "last_event_at": (last or {}).get("at"),
            }},
        )
        return {"ok": True}

    # -------------------------------------------------------- lead temperature
    # Phase 4 — auto-compute a lead-temperature score per contact based
    # on their engagement signals: email opens/clicks, landing-page
    # views/downloads, and (Phase 5a) manual "replied" markers.
    # Weights are intentionally simple:
    #   open      +2 (cap 6  — opening 4+ times doesn't add more signal)
    #   click     +5 (cap 15)
    #   page view +3 (cap 9)
    #   download  +8 (cap 16)
    #   replied   +15 (capped at one — a reply is conclusive interest)
    # Events older than 30 days are halved (recency decay).
    #
    # Bands:
    #   Hot   ≥ 15
    #   Warm  8–14
    #   Cold  0–7
    @router.get("/contacts/{contact_id}/temperature")
    async def contact_temperature(
        contact_id: str,
        _user: dict = Depends(require_role("admin")),
    ):
        from datetime import datetime as _dt, timezone as _tz
        now = _dt.now(_tz.utc)
        opens = clicks = views = downloads = 0
        replied = False
        details: list[dict] = []

        def _decay(at_iso: str | None) -> float:
            if not at_iso:
                return 1.0
            try:
                dt = _dt.fromisoformat(at_iso.replace("Z", "+00:00"))
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=_tz.utc)
                age_days = (now - dt).days
                return 0.5 if age_days > 30 else 1.0
            except Exception:  # noqa: BLE001
                return 1.0

        # Email engagement
        async for send in db.email_sends.find({"contact_id": contact_id}, {"_id": 0, "events": 1}):
            for ev in (send.get("events") or []):
                t = (ev.get("type") or "").lower()
                w = _decay(ev.get("at"))
                if t == "opened":
                    opens += 1 * w
                elif t == "clicked":
                    clicks += 1 * w
                elif t == "replied":
                    # A reply is binary — capture once per contact even
                    # if multiple sends were marked replied.
                    replied = True
        # Landing page engagement
        async for v in db.landing_page_visits.find({"contact_id": contact_id}, {"_id": 0, "outcome": 1, "at": 1}):
            w = _decay(v.get("at"))
            if v.get("outcome") == "view":
                views += 1 * w
            elif v.get("outcome") == "download":
                downloads += 1 * w

        score = (
            min(opens * 2, 6)
            + min(clicks * 5, 15)
            + min(views * 3, 9)
            + min(downloads * 8, 16)
            + (15 if replied else 0)
        )
        score = round(score, 1)

        if score >= 15:
            band = "hot"
        elif score >= 8:
            band = "warm"
        else:
            band = "cold"

        details = [
            {"label": "Email opens", "count": round(opens, 1), "weight": 2, "max": 6},
            {"label": "Link clicks", "count": round(clicks, 1), "weight": 5, "max": 15},
            {"label": "Landing-page views", "count": round(views, 1), "weight": 3, "max": 9},
            {"label": "Landing-page downloads", "count": round(downloads, 1), "weight": 8, "max": 16},
            {"label": "Marked as replied", "count": 1 if replied else 0, "weight": 15, "max": 15},
        ]
        return {
            "contact_id": contact_id,
            "score": score,
            "band": band,
            "details": details,
            "computed_at": now.isoformat(),
        }

    @router.get("/pipeline/temperatures")
    async def bulk_temperatures(
        _user: dict = Depends(require_role("admin")),
    ):
        """Bulk lead-temperature for every contact currently in the pipeline.
        Used by the Sales Pipeline kanban to render the AUTO score on
        every card without N+1 round-trips. Aggregation pipelines do all
        the per-contact maths in MongoDB so this scales to hundreds of
        contacts without falling over.

        Returns: ``{contact_id: {score, band}}`` map.
        """
        from datetime import datetime as _dt, timezone as _tz
        now = _dt.now(_tz.utc)
        out: dict[str, dict] = {}

        def _decay(at_iso: str | None) -> float:
            if not at_iso:
                return 1.0
            try:
                dt = _dt.fromisoformat(at_iso.replace("Z", "+00:00"))
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=_tz.utc)
                return 0.5 if (now - dt).days > 30 else 1.0
            except Exception:  # noqa: BLE001
                return 1.0

        # Walk email_sends ONCE, then landing_page_visits ONCE — every
        # contact's score is built up in a single dict.
        agg: dict[str, dict] = {}
        async for send in db.email_sends.find({}, {"_id": 0, "contact_id": 1, "events": 1}):
            cid = send.get("contact_id")
            if not cid:
                continue
            entry = agg.setdefault(cid, {"opens": 0, "clicks": 0, "views": 0, "downloads": 0, "replied": False})
            for ev in (send.get("events") or []):
                t = (ev.get("type") or "").lower()
                w = _decay(ev.get("at"))
                if t == "opened":
                    entry["opens"] += w
                elif t == "clicked":
                    entry["clicks"] += w
                elif t == "replied":
                    entry["replied"] = True
        async for v in db.landing_page_visits.find({}, {"_id": 0, "contact_id": 1, "outcome": 1, "at": 1}):
            cid = v.get("contact_id")
            if not cid:
                continue
            entry = agg.setdefault(cid, {"opens": 0, "clicks": 0, "views": 0, "downloads": 0, "replied": False})
            w = _decay(v.get("at"))
            if v.get("outcome") == "view":
                entry["views"] += w
            elif v.get("outcome") == "download":
                entry["downloads"] += w

        for cid, e in agg.items():
            score = (
                min(e["opens"] * 2, 6)
                + min(e["clicks"] * 5, 15)
                + min(e["views"] * 3, 9)
                + min(e["downloads"] * 8, 16)
                + (15 if e["replied"] else 0)
            )
            score = round(score, 1)
            band = "hot" if score >= 15 else ("warm" if score >= 8 else "cold")
            out[cid] = {"score": score, "band": band}

        return {"temperatures": out, "computed_at": now.isoformat()}

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
