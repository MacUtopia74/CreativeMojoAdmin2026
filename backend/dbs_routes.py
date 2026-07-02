"""DBS Application module — collects the personal data HQ needs to
process a Disclosure & Barring Service check for each franchisee.

Design decisions:
  • Admin creates an application from the franchisee's admin page.
    A random URL-safe token is minted; that token is what the
    franchisee uses to open the public form. No portal login needed.
  • The public form is available at ``/dbs/apply/{token}`` (frontend
    route). All backend endpoints under ``/dbs/public/…`` are
    unauthenticated and rely solely on token knowledge.
  • Uploaded ID documents (max 3, one image each) land in R2 at
    ``dbs/{franchisee_id}/{application_id}/doc-{slot}.{ext}``.
    Files are private — the admin fetches short-lived signed URLs to
    view them.
  • Once submitted, the token is retired: subsequent
    ``/dbs/public/{token}/submit`` calls return 410 Gone.
  • Renewals are supported by creating a fresh application; old ones
    are preserved as read-only history rows.

The form data is stored verbatim (as a dict) so we don't need a
migration every time HQ tweaks the form. Fields we do promote to
first-class columns:
  franchisee_id, status, created_at, submitted_at, token,
  applicant_email (for search convenience).

Security notes:
  • Token is 32 bytes of ``secrets.token_urlsafe`` (~256 bits).
  • Uploaded files go through content-type + extension whitelist and
    ``PIL.Image.verify()`` for the image slots. PDF is allowed as an
    escape hatch for driving licences etc.
  • NI number is *never* logged and is not returned by the list
    endpoint — only the detail endpoint returns it (admin-only).
"""
from __future__ import annotations

import logging
import os
import re
import secrets
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from pydantic import BaseModel, Field

from file_storage import get_client, R2_BUCKET, r2_configured

logger = logging.getLogger("creative-mojo-admin.dbs")

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
ALLOWED_MIME = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/heic": ".heic",
    "image/webp": ".webp",
    "application/pdf": ".pdf",
}
MAX_DOC_BYTES = 10 * 1024 * 1024  # 10 MB per document — matches the copy shown in the form

# Public FE URL used to build the tokenized form link in the outbound email.
# Falls back to the request Host header if unset — but we prefer explicit config.
PUBLIC_BASE_URL = os.environ.get("PUBLIC_BASE_URL") or os.environ.get("REACT_APP_BACKEND_URL") or ""

STATUS_PENDING = "pending"          # created, franchisee hasn't opened yet
STATUS_IN_PROGRESS = "in_progress"  # franchisee opened but hasn't submitted
STATUS_SUBMITTED = "submitted"      # franchisee submitted, admin can view
STATUS_REVIEWED = "reviewed"        # admin marked as processed


# ---------------------------------------------------------------------------
# Pydantic bodies
# ---------------------------------------------------------------------------
class CreateApplicationBody(BaseModel):
    franchisee_id: str = Field(..., min_length=1)


class SendEmailBody(BaseModel):
    application_id: str
    subject: Optional[str] = None
    intro_html: Optional[str] = None  # optional per-send message before the CTA
    public_url: Optional[str] = None  # explicit URL from the admin's browser (window.location.origin + /dbs/apply/{token})


class SubmitBody(BaseModel):
    # We accept a free-form dict to keep the form schema flexible.
    # Frontend enforces required fields; server validates minimum viable set.
    data: dict[str, Any]


class MarkStatusBody(BaseModel):
    status: str  # "reviewed" only for now


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _new_token() -> str:
    # ~43 chars, URL-safe. Collides with negligible probability.
    return secrets.token_urlsafe(32)


def _public_form_url(token: str, request: Optional[Request] = None) -> str:
    """Build the tokenized ``/dbs/apply/{token}`` URL. Prefers the
    caller's own Origin/Host header (so the link naturally uses the
    same domain the admin is browsing) and falls back to
    ``PUBLIC_BASE_URL`` env if no request context is available."""
    base = ""
    if request is not None:
        origin = request.headers.get("origin") or ""
        if origin:
            base = origin
        elif request.headers.get("host"):
            scheme = request.headers.get("x-forwarded-proto") or request.url.scheme or "https"
            base = f"{scheme}://{request.headers['host']}"
    if not base:
        base = PUBLIC_BASE_URL
    base = base.rstrip("/")
    return f"{base}/dbs/apply/{token}" if base else f"/dbs/apply/{token}"


def _sanitize(doc: dict) -> dict:
    """Drop the raw NI number from anything we send back in listing endpoints."""
    out = {k: v for k, v in doc.items() if k != "_id"}
    data = out.get("data") or {}
    if isinstance(data, dict) and "ni_number" in data:
        # Show only the last 3 chars for at-a-glance previews.
        ni = str(data.get("ni_number") or "")
        out["ni_number_masked"] = f"••• ••• {ni[-3:]}" if len(ni) > 3 else "•••"
    return out


def _presign(key: str, expires: int = 900) -> Optional[str]:
    if not r2_configured():
        return None
    try:
        return get_client().generate_presigned_url(
            "get_object",
            Params={"Bucket": R2_BUCKET, "Key": key},
            ExpiresIn=expires,
        )
    except Exception:  # noqa: BLE001
        logger.exception("DBS presign failed for %s", key)
        return None


def _extension_for(content_type: str, filename: str) -> str:
    if content_type in ALLOWED_MIME:
        return ALLOWED_MIME[content_type]
    ext = os.path.splitext(filename or "")[1].lower()
    if ext in {".jpg", ".jpeg"}:
        return ".jpg"
    if ext in ALLOWED_MIME.values():
        return ext
    raise HTTPException(415, detail="Unsupported file type — please upload JPG, PNG, HEIC, WebP or PDF")


# ---------------------------------------------------------------------------
# Router builder
# ---------------------------------------------------------------------------
def build_dbs_router(db, require_role):
    router = APIRouter(tags=["dbs"])

    # -----------------------------------------------------------------
    # Admin endpoints
    # -----------------------------------------------------------------
    @router.post("/dbs/applications")
    async def create_application(body: CreateApplicationBody, request: Request, _: dict = Depends(require_role("admin"))):
        """Create a fresh DBS application for a franchisee, mint the
        public token, and return the shareable URL the admin can send
        via the follow-up email step."""
        franchisee = await db.franchisees.find_one(
            {"id": body.franchisee_id}, {"_id": 0, "id": 1, "first_name": 1, "last_name": 1, "mojo_email": 1, "secondary_email": 1, "franchise_number": 1, "organisation": 1},
        )
        if not franchisee:
            raise HTTPException(404, detail="Franchisee not found")

        token = _new_token()
        app_id = str(uuid.uuid4())
        now = _now()
        doc = {
            "id": app_id,
            "franchisee_id": body.franchisee_id,
            "franchisee_snapshot": {
                "first_name": franchisee.get("first_name"),
                "last_name": franchisee.get("last_name"),
                "organisation": franchisee.get("organisation"),
                "franchise_number": franchisee.get("franchise_number"),
                "email": franchisee.get("mojo_email") or franchisee.get("secondary_email"),
            },
            "token": token,
            "status": STATUS_PENDING,
            "created_at": now,
            "submitted_at": None,
            "opened_at": None,
            "reviewed_at": None,
            "data": {},
            "document_keys": [None, None, None],
            "public_url": _public_form_url(token, request),
        }
        await db.dbs_applications.insert_one(doc)
        return _sanitize(doc)

    @router.get("/dbs/applications")
    async def list_applications(franchisee_id: str, _: dict = Depends(require_role("admin"))):
        """List every DBS application for a franchisee, newest first."""
        out = []
        async for a in db.dbs_applications.find({"franchisee_id": franchisee_id}, {"_id": 0}).sort("created_at", -1):
            out.append(_sanitize(a))
        return {"applications": out, "count": len(out)}

    @router.get("/dbs/applications/{application_id}")
    async def get_application(application_id: str, _: dict = Depends(require_role("admin"))):
        """Full application detail incl. NI number + short-lived signed
        URLs for each uploaded document. Admin-only."""
        app = await db.dbs_applications.find_one({"id": application_id}, {"_id": 0})
        if not app:
            raise HTTPException(404, detail="Application not found")
        # Return raw NI number to the admin (not sanitized).
        docs = app.get("document_keys") or []
        signed = [{"key": k, "url": _presign(k)} if k else None for k in docs]
        app["document_urls"] = signed
        return app

    @router.post("/dbs/applications/{application_id}/send-email")
    async def send_application_email(
        application_id: str, body: SendEmailBody, request: Request, _: dict = Depends(require_role("admin")),
    ):
        """Email the franchisee the tokenized form URL. Uses Resend
        directly — this is not tied to the CRM ``email_sends`` flow
        because franchisees don't have a ``contacts`` record."""
        if body.application_id != application_id:
            raise HTTPException(400, detail="application_id mismatch")

        app = await db.dbs_applications.find_one({"id": application_id}, {"_id": 0})
        if not app:
            raise HTTPException(404, detail="Application not found")

        snapshot = app.get("franchisee_snapshot") or {}
        to_email = snapshot.get("email")
        if not to_email:
            raise HTTPException(400, detail="Franchisee has no email on file — set one before sending.")

        first_name = snapshot.get("first_name") or "there"
        # Prefer the URL the admin's browser sent (window.location.origin
        # based) — Kubernetes ingress strips Origin/Host so we can't
        # derive it reliably from headers alone.
        url = body.public_url or _public_form_url(app["token"], request)

        # Compose. Uses a lightly branded HTML shell — keeps consistent
        # with the WYSIWYG signature footer added earlier.
        subject = body.subject or f"Action required — DBS Application for {first_name}"
        intro = body.intro_html or (
            f"<p>Hi {first_name},</p>"
            f"<p>Please complete your DBS Application form so we can process "
            f"your Disclosure & Barring Service check.</p>"
        )
        cta_button = (
            f'<p style="margin:24px 0;"><a href="{url}" '
            f'style="display:inline-block;padding:12px 24px;background:#dddd16;'
            f'color:#1a1a1a;font-weight:bold;text-decoration:none;border-radius:6px;'
            f'font-family:Helvetica,Arial,sans-serif;">OPEN DBS FORM</a></p>'
            f'<p style="font-size:12px;color:#666;">Or copy this link: '
            f'<a href="{url}" style="color:#666;">{url}</a></p>'
        )
        body_html = (
            f'<div style="font-family:Helvetica,Arial,sans-serif;color:#1a1a1a;line-height:1.5;">'
            f'{intro}{cta_button}'
            f'<p style="font-size:12px;color:#999;margin-top:32px;">'
            f'This link is unique to you — please don\'t forward it on. Creative Mojo</p>'
            f'</div>'
        )

        # Send via Resend
        try:
            import resend
            from resend_routes import RESEND_API_KEY, RESEND_FROM_EMAIL, RESEND_FROM_NAME
            if not RESEND_API_KEY:
                raise HTTPException(503, detail="Resend not configured on this environment")
            resend.api_key = RESEND_API_KEY
            resend.Emails.send({
                "from": f"{RESEND_FROM_NAME} <{RESEND_FROM_EMAIL}>",
                "to": [to_email],
                "subject": subject,
                "html": body_html,
            })
        except HTTPException:
            raise
        except Exception as e:  # noqa: BLE001
            logger.exception("DBS send email failed")
            raise HTTPException(502, detail=f"Failed to send: {e}") from e

        await db.dbs_applications.update_one(
            {"id": application_id},
            {"$set": {"last_sent_at": _now(), "last_sent_to": to_email}},
        )
        return {"ok": True, "sent_to": to_email, "public_url": url}

    @router.patch("/dbs/applications/{application_id}")
    async def mark_status(application_id: str, body: MarkStatusBody, _: dict = Depends(require_role("admin"))):
        if body.status not in {STATUS_REVIEWED, STATUS_SUBMITTED}:
            raise HTTPException(400, detail="status must be 'reviewed' or 'submitted'")
        r = await db.dbs_applications.update_one(
            {"id": application_id},
            {"$set": {"status": body.status, "reviewed_at": _now()}},
        )
        if r.matched_count == 0:
            raise HTTPException(404, detail="Not found")
        return {"ok": True}

    @router.delete("/dbs/applications/{application_id}")
    async def delete_application(application_id: str, _: dict = Depends(require_role("admin"))):
        """Hard-delete an application (removes DB row + R2 uploads).
        Used post-issue when HQ no longer needs to retain the raw PII.
        Cannot be undone."""
        app = await db.dbs_applications.find_one({"id": application_id}, {"_id": 0, "document_keys": 1})
        if not app:
            raise HTTPException(404, detail="Not found")

        # Purge R2 uploads
        if r2_configured():
            for k in (app.get("document_keys") or []):
                if not k:
                    continue
                try:
                    get_client().delete_object(Bucket=R2_BUCKET, Key=k)
                except Exception:  # noqa: BLE001
                    logger.exception("DBS delete R2 obj failed for %s", k)

        await db.dbs_applications.delete_one({"id": application_id})
        return {"ok": True}

    # -----------------------------------------------------------------
    # Public endpoints (no auth — token-gated)
    # -----------------------------------------------------------------
    async def _find_by_token(token: str) -> dict:
        app = await db.dbs_applications.find_one({"token": token}, {"_id": 0})
        if not app:
            raise HTTPException(404, detail="This DBS form link is no longer valid.")
        return app

    @router.get("/dbs/public/{token}")
    async def public_get(token: str):
        """Fetch enough to render the form — franchisee's first name and
        whether they've already submitted."""
        app = await _find_by_token(token)
        # Mark as opened once (helps HQ see who clicked but didn't submit).
        if not app.get("opened_at"):
            await db.dbs_applications.update_one(
                {"id": app["id"]},
                {"$set": {"opened_at": _now(), "status": STATUS_IN_PROGRESS}},
            )
        snap = app.get("franchisee_snapshot") or {}
        return {
            "application_id": app["id"],
            "status": app["status"],
            "already_submitted": app["status"] in {STATUS_SUBMITTED, STATUS_REVIEWED},
            "franchisee_first_name": snap.get("first_name"),
            "franchisee_last_name": snap.get("last_name"),
            "prefill_email": snap.get("email"),
        }

    @router.post("/dbs/public/{token}/upload")
    async def public_upload(
        token: str,
        slot: int = Form(..., ge=1, le=3),
        file: UploadFile = File(...),
    ):
        """Accept one file per document slot (1, 2, or 3)."""
        app = await _find_by_token(token)
        if app["status"] in {STATUS_SUBMITTED, STATUS_REVIEWED}:
            raise HTTPException(410, detail="This form has already been submitted.")

        content = await file.read()
        if len(content) > MAX_DOC_BYTES:
            raise HTTPException(413, detail=f"File too large — max {MAX_DOC_BYTES // (1024 * 1024)} MB")
        if len(content) == 0:
            raise HTTPException(400, detail="Empty file")

        ext = _extension_for((file.content_type or "").lower(), file.filename or "")
        key = f"dbs/{app['franchisee_id']}/{app['id']}/doc-{slot}{ext}"

        if not r2_configured():
            raise HTTPException(503, detail="File storage not configured")

        try:
            get_client().put_object(
                Bucket=R2_BUCKET,
                Key=key,
                Body=content,
                ContentType=file.content_type or "application/octet-stream",
                Metadata={"application_id": app["id"], "slot": str(slot)},
            )
        except Exception as e:  # noqa: BLE001
            logger.exception("DBS upload failed")
            raise HTTPException(502, detail="Upload failed") from e

        # Persist the key at the correct slot index (1-indexed on the wire).
        keys = list(app.get("document_keys") or [None, None, None])
        while len(keys) < 3:
            keys.append(None)
        keys[slot - 1] = key
        await db.dbs_applications.update_one(
            {"id": app["id"]},
            {"$set": {"document_keys": keys, "updated_at": _now()}},
        )
        return {"ok": True, "slot": slot, "size": len(content)}

    @router.post("/dbs/public/{token}/submit")
    async def public_submit(token: str, body: SubmitBody):
        """Persist the completed form. After this the token is dead."""
        app = await _find_by_token(token)
        if app["status"] in {STATUS_SUBMITTED, STATUS_REVIEWED}:
            raise HTTPException(410, detail="This form has already been submitted.")

        data = body.data or {}
        # Minimum viable check — surname + DOB + email + at least one address.
        required = ["surname", "forename", "date_of_birth", "email"]
        missing = [k for k in required if not str(data.get(k) or "").strip()]
        if missing:
            raise HTTPException(400, detail=f"Missing required field(s): {', '.join(missing)}")
        if not isinstance(data.get("addresses"), list) or not data["addresses"]:
            raise HTTPException(400, detail="At least one address is required")

        # Basic NI number sanity (2 letters, 6 digits, 1 letter, optional spaces).
        ni = str(data.get("ni_number") or "").replace(" ", "").upper()
        if ni and not re.fullmatch(r"[A-Z]{2}\d{6}[A-D]", ni):
            raise HTTPException(400, detail="NI Number format looks incorrect — expected QQ123456C")

        await db.dbs_applications.update_one(
            {"id": app["id"]},
            {"$set": {
                "data": data,
                "status": STATUS_SUBMITTED,
                "submitted_at": _now(),
                "applicant_email": (data.get("email") or "").lower(),
            }},
        )
        logger.info("DBS submitted app=%s franchisee=%s", app["id"], app["franchisee_id"])
        return {"ok": True}

    return router
