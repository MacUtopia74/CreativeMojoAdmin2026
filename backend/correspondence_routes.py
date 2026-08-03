"""Correspondence — full inbound + outbound email history per contact.

Feb 2026 build. Ties three concerns together:

* Outbound emails already write to ``email_sends`` (see ``resend_routes``).
  We stamp a ``Reply-To: reply+{token}@messages.creativemojo.co.uk`` header
  on every outbound so replies land back into the Resend Receiving inbox
  keyed to the exact contact.
* Inbound webhook (``POST /api/webhooks/resend/inbound``) verifies Svix
  signatures, fetches the full body + attachments via the Resend
  Receiving API, streams attachments into R2, and writes a canonical
  record to ``email_inbounds``. Matching order (per playbook):
  plus-token → In-Reply-To → any Message-ID in References → sender
  email → unmatched (quarantined for admin review).
* ``GET /api/contacts/{id}/correspondence`` merges outbound + inbound
  chronologically for the front-end Correspondence modal.
* ``POST /api/contacts/{id}/correspondence/send`` is a thin wrapper that
  delegates to the existing reply-with-template endpoint but supports
  both a blank New Email and a Template-prefilled compose.

Receiving is set up on the dedicated subdomain ``messages.creativemojo.co.uk``
so the production sending domain ``creativemojo.co.uk`` MX records are
never touched.
"""
from __future__ import annotations

import asyncio
import base64
import logging
import os
import re
import secrets
from datetime import datetime, timezone
from typing import Optional
from urllib.parse import quote_plus

import httpx
import resend
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from svix.webhooks import Webhook

logger = logging.getLogger("creative-mojo-admin.correspondence")

RESEND_API_KEY = os.environ.get("RESEND_API_KEY", "")
RESEND_INBOUND_WEBHOOK_SECRET = os.environ.get("RESEND_INBOUND_WEBHOOK_SECRET", "")
RECEIVING_DOMAIN = os.environ.get("RESEND_RECEIVING_DOMAIN", "messages.creativemojo.co.uk")

if RESEND_API_KEY:
    resend.api_key = RESEND_API_KEY

# Reply-To local part looks like ``reply+{token}@{RECEIVING_DOMAIN}``. The
# token is generated with ``secrets.token_urlsafe(24)`` which yields a
# ~32-char URL-safe base64 string; the regex is tolerant of 16-128 chars
# to leave room for future rotation schemes.
_TOKEN_RE = re.compile(r"^reply\+([A-Za-z0-9_-]{16,128})@([^@]+)$", re.I)


def make_reply_to(token: str) -> str:
    """Build the plus-addressed Reply-To for a given contact token."""
    return f"reply+{token}@{RECEIVING_DOMAIN}"


async def ensure_reply_token(db, contact_id: str) -> str:
    """Return the contact's ``reply_token``, generating one if missing.

    Handles contacts stored in either ``contacts`` or ``web_form_contacts``
    (the pipeline aggregates both). Uses a uniqueness check + retry loop
    guarded by the unique index on ``reply_token``. Cryptographic
    randomness — never derived from the contact id."""
    for coll_name in ("contacts", "web_form_contacts"):
        doc = await db[coll_name].find_one({"id": contact_id}, {"_id": 0, "reply_token": 1})
        if doc is None:
            continue
        if doc.get("reply_token"):
            return doc["reply_token"]
        # Contact exists in this collection without a token — allocate.
        for _ in range(6):
            token = secrets.token_urlsafe(18)
            try:
                res = await db[coll_name].update_one(
                    {"id": contact_id},
                    {"$set": {"reply_token": token}},
                )
                if res.matched_count:
                    return token
            except Exception:  # noqa: BLE001
                logger.exception("reply_token generation collision — retrying")
        break
    raise RuntimeError("Could not allocate reply_token for contact")


async def create_indexes(db):
    """Idempotent startup indexer for the correspondence collections."""
    try:
        await db.contacts.create_index("reply_token", unique=True, sparse=True)
        await db.web_form_contacts.create_index("reply_token", unique=True, sparse=True)
        await db.email_inbounds.create_index("resend_email_id", unique=True, sparse=True)
        await db.email_inbounds.create_index("message_id")
        await db.email_inbounds.create_index("contact_id")
        await db.email_inbounds.create_index("received_at")
        await db.svix_events.create_index("svix_id", unique=True)
    except Exception:  # noqa: BLE001
        logger.exception("correspondence index creation failed")


# ============================================================ Resend API
async def _fetch_received(email_id: str) -> dict:
    """Retrieve the full inbound email JSON via the Resend Receiving API."""
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.get(
            f"https://api.resend.com/emails/receiving/{email_id}",
            headers={"Authorization": f"Bearer {RESEND_API_KEY}"},
        )
        r.raise_for_status()
        return r.json()


async def _fetch_attachments(email_id: str) -> list[dict]:
    """List attachments with fresh 1-hour download URLs."""
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.get(
            f"https://api.resend.com/emails/receiving/{email_id}/attachments",
            headers={"Authorization": f"Bearer {RESEND_API_KEY}"},
        )
        r.raise_for_status()
        return r.json().get("data", [])


# Attachment safety caps. Anything larger than these limits is stored
# as metadata only — the download link stays unavailable. Prevents
# malicious inbounds from ballooning R2 storage or exposing exotic
# executables via a friendly-looking filename.
MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024  # 25MB per file
MAX_ATTACHMENTS_PER_MESSAGE = 20
_ALLOWED_ATTACHMENT_MIME_PREFIXES = (
    "image/", "video/", "audio/", "text/", "application/pdf",
    "application/msword", "application/vnd.openxmlformats-officedocument",
    "application/vnd.ms-excel", "application/vnd.ms-powerpoint",
    "application/zip", "application/x-zip", "application/vnd.rar",
    "application/octet-stream",  # fallback for well-behaved unknowns
)
_BLOCKED_EXTS = {".exe", ".bat", ".cmd", ".scr", ".msi", ".vbs", ".js", ".jar", ".ps1", ".sh"}


def _attachment_is_safe(filename: str, content_type: str, size: Optional[int]) -> tuple[bool, str]:
    """Return (safe, reason) — reason set only when unsafe."""
    if size is not None and size > MAX_ATTACHMENT_BYTES:
        return False, f"exceeds {MAX_ATTACHMENT_BYTES} byte limit"
    ext = "." + (filename.rsplit(".", 1)[-1].lower()) if "." in filename else ""
    if ext in _BLOCKED_EXTS:
        return False, f"blocked extension {ext}"
    ct = (content_type or "").lower()
    if ct and not any(ct.startswith(p) for p in _ALLOWED_ATTACHMENT_MIME_PREFIXES):
        return False, f"disallowed content-type {ct}"
    return True, ""


def _sanitize_html_server(html: Optional[str]) -> Optional[str]:
    """Server-side HTML sanitisation for inbound bodies before storage.

    Strips ``<script>``, inline event handlers, and ``javascript:``
    URIs so a malicious sender cannot smuggle JS into an admin's browser
    even if the client-side sanitiser regresses."""
    if not html:
        return html
    s = str(html)
    s = re.sub(r"<script[\s\S]*?</script>", "", s, flags=re.IGNORECASE)
    s = re.sub(r"<style[\s\S]*?</style>", "", s, flags=re.IGNORECASE)
    s = re.sub(r"on[a-z]+\s*=\s*\"[^\"]*\"", "", s, flags=re.IGNORECASE)
    s = re.sub(r"on[a-z]+\s*=\s*'[^']*'", "", s, flags=re.IGNORECASE)
    s = re.sub(r"javascript\s*:", "", s, flags=re.IGNORECASE)
    return s


async def _download_attachment_to_r2(att: dict, contact_id: str, message_id: str) -> Optional[dict]:
    """Stream one attachment into R2 and return the persistent record.

    The Resend ``download_url`` expires after ~1 hour so we download it
    immediately. If R2 isn't configured we still store the metadata so
    the row can render — the download link just won't be available."""
    try:
        from file_storage import get_client, R2_BUCKET, r2_configured, SCOPE_ADMIN
    except ImportError:
        return None
    filename = att.get("filename") or "attachment"
    content_type = att.get("content_type") or "application/octet-stream"
    size = att.get("size")
    safe, reason = _attachment_is_safe(filename, content_type, size)
    if not safe:
        logger.warning("Rejecting inbound attachment %s (%s) — %s", filename, content_type, reason)
        return {
            "id": att.get("id"),
            "filename": filename,
            "content_type": content_type,
            "size": size,
            "r2_key": None,
            "blocked": True,
            "block_reason": reason,
        }
    if not r2_configured():
        return {
            "id": att.get("id"),
            "filename": filename,
            "content_type": content_type,
            "size": att.get("size"),
            "r2_key": None,
        }
    download_url = att.get("download_url")
    if not download_url:
        return None
    try:
        async with httpx.AsyncClient(timeout=60) as client:
            r = await client.get(download_url)
            r.raise_for_status()
            payload = r.content
        # Enforce byte cap even when Resend didn't declare a size —
        # defence in depth against manipulated size headers.
        if len(payload) > MAX_ATTACHMENT_BYTES:
            logger.warning("Rejecting oversized inbound attachment %s (%s bytes)", filename, len(payload))
            return {
                "id": att.get("id"),
                "filename": filename,
                "content_type": content_type,
                "size": len(payload),
                "r2_key": None,
                "blocked": True,
                "block_reason": "oversized",
            }
    except Exception:  # noqa: BLE001
        logger.exception("attachment download failed for %s", att.get("id"))
        return None
    safe_name = re.sub(r"[^A-Za-z0-9._-]+", "_", filename)[:120] or "attachment"
    key = f"{SCOPE_ADMIN}/correspondence/{contact_id}/{message_id}/{att.get('id') or secrets.token_hex(4)}_{safe_name}"
    try:
        await asyncio.to_thread(
            get_client().put_object,
            Bucket=R2_BUCKET,
            Key=key,
            Body=payload,
            ContentType=content_type,
        )
    except Exception:  # noqa: BLE001
        logger.exception("attachment upload to R2 failed for %s", att.get("id"))
        return None
    return {
        "id": att.get("id"),
        "filename": filename,
        "content_type": content_type,
        "size": len(payload),
        "r2_key": key,
    }


# ==================================================== Contact matching
def _addr(value) -> str:
    if isinstance(value, list) and value:
        value = value[0]
    return (value or "").strip().lower()


def _extract_email(raw: str) -> str:
    """Pull ``foo@bar`` out of ``"Foo Bar" <foo@bar>`` style values."""
    if not raw:
        return ""
    m = re.search(r"<([^>]+)>", raw)
    if m:
        return m.group(1).strip().lower()
    return raw.strip().lower()


def _headers_lookup(headers: dict, name: str) -> Optional[str]:
    if not headers:
        return None
    lower = name.lower()
    for k, v in headers.items():
        if str(k).lower() == lower:
            return str(v)
    return None


async def _resolve_contact(db, to_values: list, full: dict) -> dict:
    """Return ``{contact_id, match_method}`` following the priority chain."""
    # 1) plus-token
    for value in (to_values or []):
        addr = _extract_email(value if isinstance(value, str) else value.get("address", ""))
        m = _TOKEN_RE.match(addr)
        if m and m.group(2).lower() == RECEIVING_DOMAIN.lower():
            token = m.group(1)
            for coll_name in ("contacts", "web_form_contacts"):
                contact = await db[coll_name].find_one({"reply_token": token}, {"_id": 0, "id": 1})
                if contact:
                    return {"contact_id": contact["id"], "match_method": "plus_token"}

    # 2) In-Reply-To / References — look up the outbound send we made
    hs = full.get("headers", {}) or {}
    in_reply_to = _headers_lookup(hs, "In-Reply-To")
    references = _headers_lookup(hs, "References") or ""
    ids = []
    if in_reply_to:
        ids.append(in_reply_to.strip("<> "))
    ids += [ref.strip("<> ") for ref in re.findall(r"<[^>]+>", references)]
    ids = [i for i in ids if i]
    if ids:
        prior = await db.email_sends.find_one(
            {"message_id": {"$in": [f"<{i}>" for i in ids] + ids}},
            {"_id": 0, "contact_id": 1},
        )
        if prior and prior.get("contact_id"):
            return {"contact_id": prior["contact_id"], "match_method": "thread_header"}

    # 3) sender email exact match — only if there is EXACTLY ONE contact
    # with that email across BOTH collections combined. If two different
    # contacts share an email we refuse to guess and leave the row
    # unmatched so an admin can link it manually. Prevents silently
    # attaching a reply to the wrong pipeline card.
    sender = _extract_email(full.get("from") or "")
    if sender:
        hits: list[str] = []
        for coll_name in ("contacts", "web_form_contacts"):
            async for row in db[coll_name].find({"email": sender}, {"_id": 0, "id": 1}):
                hits.append(row["id"])
                if len(hits) > 1:
                    break
            if len(hits) > 1:
                break
        if len(hits) == 1:
            return {"contact_id": hits[0], "match_method": "sender"}
        if len(hits) > 1:
            return {"contact_id": None, "match_method": "ambiguous_sender"}

    return {"contact_id": None, "match_method": "unmatched"}


# ==================================================== Router
def build_correspondence_router(db, require_role):
    r = APIRouter(prefix="", tags=["correspondence"])

    # -------------------------------------------------------------- Inbound
    @r.post("/webhooks/resend/inbound")
    async def resend_inbound_webhook(request: Request):
        """Ingest an ``email.received`` webhook, fetch the full message
        plus attachments, and file it under the correct contact."""
        raw = await request.body()
        # Svix signature verification MUST use the raw body — parsing +
        # re-serialising JSON invalidates the HMAC.
        if not RESEND_INBOUND_WEBHOOK_SECRET:
            raise HTTPException(500, "RESEND_INBOUND_WEBHOOK_SECRET not configured")
        headers = {
            "svix-id": request.headers.get("svix-id", ""),
            "svix-timestamp": request.headers.get("svix-timestamp", ""),
            "svix-signature": request.headers.get("svix-signature", ""),
        }
        if not all(headers.values()):
            raise HTTPException(400, "missing svix signature headers")
        try:
            event = Webhook(RESEND_INBOUND_WEBHOOK_SECRET).verify(raw.decode("utf-8"), headers)
        except Exception as exc:  # noqa: BLE001
            logger.warning("inbound webhook signature invalid: %s", exc)
            raise HTTPException(400, "invalid signature") from exc

        # Idempotency by Svix message id — dedupes any retry from
        # Resend or our own edge before we do any downstream work.
        # ``svix_events`` is a tiny ledger; TTL isn't strictly required
        # (millions of entries take up trivial space) but we could add
        # one via ``created_at`` if noise becomes a problem.
        try:
            await db.svix_events.insert_one({
                "svix_id": headers["svix-id"],
                "channel": "inbound",
                "at": datetime.now(timezone.utc).isoformat(),
            })
        except Exception:  # noqa: BLE001
            # DuplicateKeyError from the unique index → already processed.
            return {"ok": True, "duplicate_svix": True}

        if event.get("type") != "email.received":
            return {"ignored": True, "type": event.get("type")}

        data = event.get("data", {}) or {}
        email_id = data.get("email_id") or data.get("id")
        if not email_id:
            return {"ignored": True, "reason": "no email_id"}

        # Idempotency — Resend can retry.
        existing = await db.email_inbounds.find_one({"resend_email_id": email_id}, {"_id": 1})
        if existing:
            return {"ok": True, "duplicate": True}

        try:
            full = await _fetch_received(email_id)
        except Exception:  # noqa: BLE001
            logger.exception("Resend receiving fetch failed for %s", email_id)
            raise HTTPException(502, "Resend fetch failed") from None

        to_values = full.get("to") or data.get("to") or []
        thread = await _resolve_contact(db, to_values, full)

        message_id = full.get("message_id") or data.get("message_id") or email_id
        received_at = full.get("created_at") or datetime.now(timezone.utc).isoformat()

        # Attachments — download to R2 immediately (Resend URLs expire in 1h).
        # Hard-cap the count so a malicious inbound can't queue up 500
        # downloads and thrash the worker.
        raw_attachments = list((full.get("attachments") or data.get("attachments") or []))[:MAX_ATTACHMENTS_PER_MESSAGE]
        att_records: list[dict] = []
        for att in raw_attachments:
            rec = await _download_attachment_to_r2(att, str(thread["contact_id"] or "unmatched"), email_id)
            if rec:
                att_records.append(rec)

        doc = {
            "id": secrets.token_urlsafe(12),
            "resend_email_id": email_id,
            "message_id": message_id,
            "contact_id": thread["contact_id"],
            "match_method": thread["match_method"],
            "from": full.get("from"),
            "from_email": _extract_email(full.get("from") or ""),
            "to": to_values,
            "cc": full.get("cc") or [],
            "bcc": full.get("bcc") or [],
            "subject": full.get("subject") or "(no subject)",
            "text": full.get("text"),
            "html": _sanitize_html_server(full.get("html")),
            "headers": full.get("headers") or {},
            "in_reply_to": _headers_lookup(full.get("headers") or {}, "In-Reply-To"),
            "references": _headers_lookup(full.get("headers") or {}, "References"),
            "attachments": att_records,
            "starred": False,
            "read": False,
            "received_at": received_at,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        await db.email_inbounds.insert_one(doc)
        return {"ok": True, "id": doc["id"], "match_method": thread["match_method"]}

    # ----------------------------------------- Correspondence read
    @r.get("/contacts/{contact_id}/correspondence")
    async def get_correspondence(
        contact_id: str,
        user=Depends(require_role("admin")),
    ):
        """Return outbound + inbound merged chronologically (newest first)."""
        contact = await db.contacts.find_one({"id": contact_id}, {"_id": 0})
        if not contact:
            contact = await db.web_form_contacts.find_one({"id": contact_id}, {"_id": 0})
        if not contact:
            raise HTTPException(404, "contact not found")

        # Ensure reply_token exists so the modal can echo it.
        token = await ensure_reply_token(db, contact_id)

        out_cursor = db.email_sends.find({"contact_id": contact_id}, {"_id": 0}).sort("sent_at", -1)
        in_cursor = db.email_inbounds.find({"contact_id": contact_id}, {"_id": 0}).sort("received_at", -1)
        outbound = await out_cursor.to_list(500)
        inbound = await in_cursor.to_list(500)

        # Normalise both into a single row shape for the UI.
        rows: list[dict] = []
        for o in outbound:
            events = o.get("events") or []
            last = (o.get("last_event") or "sent").lower()
            rows.append({
                "kind": "outbound",
                "id": o.get("id"),
                "resend_id": o.get("resend_id"),
                "message_id": o.get("message_id"),
                "subject": o.get("subject"),
                "from": o.get("from"),
                "to": o.get("to") or [],
                "cc": o.get("cc") or [],
                "bcc": o.get("bcc") or [],
                "html": o.get("html"),
                "text": o.get("text"),
                "attachments": o.get("attachments") or [],
                "date": o.get("sent_at"),
                "status": last,  # sent | delivered | opened | clicked | bounced
                "opened": any(e.get("type") == "opened" for e in events),
                "delivered": any(e.get("type") == "delivered" for e in events),
                "bounced": any(e.get("type") == "bounced" for e in events),
                "clicked": any(e.get("type") == "clicked" for e in events),
                "starred": bool(o.get("starred")),
            })
        for i in inbound:
            rows.append({
                "kind": "inbound",
                "id": i.get("id"),
                "resend_id": i.get("resend_email_id"),
                "message_id": i.get("message_id"),
                "subject": i.get("subject"),
                "from": i.get("from"),
                "from_email": i.get("from_email"),
                "to": i.get("to") or [],
                "cc": i.get("cc") or [],
                "html": i.get("html"),
                "text": i.get("text"),
                "attachments": i.get("attachments") or [],
                "date": i.get("received_at"),
                "status": "received",
                "match_method": i.get("match_method"),
                "in_reply_to": i.get("in_reply_to"),
                "starred": bool(i.get("starred")),
            })
        rows.sort(key=lambda x: x.get("date") or "", reverse=True)

        return {
            "contact": {
                "id": contact.get("id"),
                "first_name": contact.get("first_name"),
                "last_name": contact.get("last_name"),
                "email": contact.get("email"),
                "telephone": contact.get("telephone") or contact.get("phone"),
                "postcode": contact.get("postcode"),
                "reply_token": token,
                "reply_to": make_reply_to(token),
            },
            "messages": rows,
            "total": len(rows),
        }

    # ------------------------------------- Attachment download proxy
    @r.get("/contacts/{contact_id}/correspondence/attachments/{message_id}/{filename}")
    async def download_attachment(
        contact_id: str, message_id: str, filename: str,
        user=Depends(require_role("admin")),
    ):
        """Signed R2 GET for an inbound attachment. We match on the
        inbound record + filename to avoid exposing arbitrary R2 keys."""
        try:
            from file_storage import presigned_get_url, r2_configured
        except ImportError:
            raise HTTPException(500, "storage backend unavailable")
        if not r2_configured():
            raise HTTPException(503, "R2 not configured")
        row = await db.email_inbounds.find_one(
            {"id": message_id, "contact_id": contact_id},
            {"_id": 0, "attachments": 1},
        )
        if not row:
            raise HTTPException(404, "message not found")
        target = next((a for a in (row.get("attachments") or []) if a.get("filename") == filename and a.get("r2_key")), None)
        if not target:
            raise HTTPException(404, "attachment not found")
        url = presigned_get_url(target["r2_key"], expires_in=900)
        return {"url": url, "filename": filename, "content_type": target.get("content_type")}

    # ------------------------------------------- Star / mark-read
    class StarBody(BaseModel):
        starred: bool

    @r.patch("/contacts/{contact_id}/correspondence/{kind}/{msg_id}/star")
    async def toggle_star(
        contact_id: str, kind: str, msg_id: str, body: StarBody,
        user=Depends(require_role("admin")),
    ):
        if kind not in ("inbound", "outbound"):
            raise HTTPException(400, "kind must be inbound or outbound")
        coll = db.email_inbounds if kind == "inbound" else db.email_sends
        res = await coll.update_one(
            {"id": msg_id, "contact_id": contact_id},
            {"$set": {"starred": bool(body.starred)}},
        )
        if not res.matched_count:
            raise HTTPException(404, "message not found")
        return {"ok": True, "starred": bool(body.starred)}

    # ------------------------------------------- Compose (New Email + Template)
    class ComposeBody(BaseModel):
        subject: str
        body_html: str
        template_id: Optional[str] = None
        cc: list[str] = Field(default_factory=list)
        bcc: list[str] = Field(default_factory=list)

    @r.post("/contacts/{contact_id}/correspondence/send")
    async def send_correspondence(
        contact_id: str, body: ComposeBody,
        user=Depends(require_role("admin")),
    ):
        """Send a fresh email against this contact (blank or template).

        Delegates to the existing reply-with-template plumbing so we
        keep tracking pixel, follow-up detection, and Resend headers
        consistent with all other outbound sends. The only difference
        vs. the old path is we resolve the ``to:`` address ourselves
        (always the contact's primary email) and stamp the plus-token
        Reply-To."""
        contact = await db.contacts.find_one({"id": contact_id}, {"_id": 0})
        if not contact:
            raise HTTPException(404, "contact not found")
        to_email = contact.get("email") or contact.get("email_raw")
        if not to_email:
            raise HTTPException(400, "contact has no email on file")

        # Reuse resend_routes.send_reply logic by calling the same code
        # path — cheapest way to keep behaviour aligned.
        from resend_routes import SendReplyRequest, _send_reply_impl  # type: ignore
        req = SendReplyRequest(
            contact_id=contact_id,
            template_id=body.template_id,
            to=[to_email],
            cc=body.cc,
            bcc=body.bcc,
            subject=body.subject,
            body_html=body.body_html,
        )
        return await _send_reply_impl(db, req, user)

    return r


__all__ = [
    "build_correspondence_router",
    "make_reply_to",
    "ensure_reply_token",
    "create_indexes",
    "RECEIVING_DOMAIN",
]
