"""Portal Marketing module — franchisee-private "Send a marketing e-shot".

Gated by BOTH ``portal_modules.marketing`` AND ``portal_modules.territory_plus``
on the franchisee record (Demo tag bypasses both — for the demo account).

Mirrors the HQ Updates feature but scoped to a single franchisee's own
"My Territory+" clients. Hard-capped at **5 recipients per send** to keep
the Resend account out of bulk-spam territory.

Data model:
  • Collection ``marketing_campaigns`` — one document per send. Carries
    ``franchisee_id`` so it can never be read across franchisees.
    ``recipients`` is an array of ``{client_id, contact_index, email,
    first_name, organisation, resend_id, send_id, last_event,
    last_event_at, events[]}`` so the per-recipient open/click report
    has somewhere to land.

Resend tags carried on every send so the existing
``/api/email/resend-webhook`` can attribute events back:
  • ``kind=marketing-campaign``
  • ``campaign_id=<uuid>``
  • ``recipient_send_id=<uuid>``  (matches ``recipients[i].send_id``)
"""
from __future__ import annotations

import asyncio
import logging
import os
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import Depends, HTTPException, UploadFile, File, Request
from pydantic import BaseModel, Field

logger = logging.getLogger("creative-mojo-admin.portal_marketing")

LOGO_URL = "https://hub.creativemojo.co.uk/brand/creative-mojo-logo.png"
MAX_RECIPIENTS_PER_SEND = 5


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _frontend_base(request: Request | None = None, body_origin: str = "") -> str:
    """Pick the public base URL to use when minting links inside the
    rendered email. Same priority order as HQ Updates."""
    bo = (body_origin or "").rstrip("/")
    if bo:
        return bo
    if request is not None:
        origin = request.headers.get("origin") or ""
        if origin and "emergentcf.cloud" not in origin:
            return origin.rstrip("/")
        ref = request.headers.get("referer") or ""
        if ref:
            from urllib.parse import urlparse
            parsed = urlparse(ref)
            if parsed.scheme and parsed.netloc and "emergentcf.cloud" not in parsed.netloc:
                return f"{parsed.scheme}://{parsed.netloc}".rstrip("/")
    return (os.environ.get("FRONTEND_URL") or "").rstrip("/")


# ---------------------------------------------------------------- access
async def _check_access(db, user: dict) -> dict:
    """Return the franchisee record if access is allowed; otherwise raise.

    Marketing requires BOTH the ``marketing`` AND ``territory_plus`` Plus
    modules (the latter because the recipients come from the Territory+
    clients list). The Demo tag bypasses both so the demo account is
    fully exercised on the demo portal.
    """
    fid = (user or {}).get("franchisee_id")
    if not fid:
        raise HTTPException(403, detail="Franchisee account required")
    fr = await db.franchisees.find_one(
        {"id": fid},
        {"_id": 0, "id": 1, "first_name": 1, "last_name": 1, "organisation": 1,
         "mojo_email": 1, "tags": 1, "portal_modules": 1},
    )
    if not fr:
        raise HTTPException(404, detail="Franchisee not found")
    mods = (fr.get("portal_modules") or {})
    is_demo = any(str(t).strip().lower() == "demo" for t in (fr.get("tags") or []))
    if is_demo:
        return fr
    if not mods.get("marketing"):
        raise HTTPException(403, detail="Marketing module is not enabled on your account.")
    if not mods.get("territory_plus"):
        raise HTTPException(403, detail="Marketing requires My Territory+ to be enabled (recipients come from your Territory+ clients).")
    return fr


# ---------------------------------------------------------------- HTML builder
def _build_html(campaign: dict, first_name: str = "{{first_name}}") -> str:
    """Branded HTML email. Single image panel (optional), one big CTA
    button (URL link or auto Bookings link), centred layout.
    """
    intro_html = (campaign.get("intro") or "").replace("\n", "<br/>")
    image_url = (campaign.get("image_url") or "").strip()
    link_url = (campaign.get("link_url") or "").strip()
    link_label = (campaign.get("link_label") or "Find out more").strip() or "Find out more"
    bookings_url = (campaign.get("bookings_url") or "").strip()
    franchisee_name = (campaign.get("franchisee_name") or "Creative Mojo").strip()
    franchisee_org = (campaign.get("franchisee_organisation") or "Creative Mojo").strip()

    img_block = (
        f'<tr><td align="center" style="padding:0 30px 16px 30px;">'
        f'<img src="{image_url}" alt="" width="540" '
        'style="max-width:100%;height:auto;border-radius:8px;display:block;margin:0 auto;" />'
        '</td></tr>'
    ) if image_url else ""

    buttons: list[str] = []
    if link_url:
        buttons.append(
            f'<a href="{link_url}" style="display:inline-block;background:#dddd16;color:#1a1a1a;'
            'font-weight:700;text-decoration:none;padding:13px 32px;border-radius:4px;'
            f'font-size:13px;letter-spacing:0.5px;margin:8px;">{link_label.upper()} &rsaquo;</a>'
        )
    if bookings_url:
        buttons.append(
            f'<a href="{bookings_url}" style="display:inline-block;background:#1a1a1a;color:#dddd16;'
            'font-weight:700;text-decoration:none;padding:13px 32px;border-radius:4px;'
            'font-size:13px;letter-spacing:0.5px;margin:8px;">BOOK A SESSION &rsaquo;</a>'
        )
    button_block = (
        f'<tr><td align="center" style="padding:6px 30px 28px 30px;">{"".join(buttons)}</td></tr>'
        if buttons else ""
    )

    return f"""<!doctype html>
<html><body style="margin:0;background:#f7f7f4;font-family:Helvetica,Arial,sans-serif;">
<table cellpadding="0" cellspacing="0" border="0" width="100%" bgcolor="#f7f7f4" style="background:#f7f7f4;">
  <tr><td align="center" style="padding:30px 16px;">
    <table cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;background:#ffffff;border:1px solid #ececec;">
      <tr><td align="center" style="padding:30px 30px 14px;">
        <img src="{LOGO_URL}" alt="Creative Mojo" width="220"
             style="max-width:220px;height:auto;display:block;" />
      </td></tr>
      <tr><td align="center" style="padding:22px 30px 0;">
        <div style="font-family:Helvetica,Arial,sans-serif;font-size:24px;font-weight:800;
                    color:#1a1a1a;line-height:1.2;text-align:center;">
          {campaign.get('title','')}
        </div>
      </td></tr>
      <tr><td style="padding:14px 30px 18px;font-size:15px;line-height:1.6;color:#1a1a1a;">
        <div>Hi <strong>{first_name}</strong>,</div>
        <div style="margin-top:10px;">{intro_html}</div>
      </td></tr>
      <tr><td style="padding:0 30px 18px 30px;">
        <div style="height:0;border-top:1px solid #dddd16;margin:0;"></div>
      </td></tr>
      {img_block}
      {button_block}
      <tr><td style="padding:24px 30px;font-size:11px;color:#999999;line-height:1.5;text-align:center;border-top:1px solid #eaeaea;">
        Sent by <strong>{franchisee_name}</strong> &middot; {franchisee_org}<br/>
        You're receiving this because you're a client of Creative Mojo. Reply to this email if you'd like to be removed.
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>"""


# ---------------------------------------------------------------- attach
async def apply_event(db, campaign_id: str, send_id: Optional[str],
                      resend_id: Optional[str], event_type: str,
                      event: dict) -> bool:
    """Push a Resend webhook event onto the matching campaign recipient.

    Called by ``resend_routes.resend_webhook`` whenever it sees a tag
    with ``name="campaign_id"``. Defined at module level (not nested in
    ``attach``) so resend_routes can ``from portal_marketing_routes
    import apply_event`` without depending on a router instance.
    Returns True if a recipient row was updated.
    """
    if not campaign_id:
        return False
    if not (send_id or resend_id):
        return False
    arr_filter = (
        [{"r.send_id": send_id}] if send_id
        else [{"r.resend_id": resend_id}]
    )
    r = await db.marketing_campaigns.update_one(
        {"id": campaign_id},
        {
            "$push": {"recipients.$[r].events": event},
            "$set": {
                "recipients.$[r].last_event": event_type,
                "recipients.$[r].last_event_at": event["at"],
            },
        },
        array_filters=arr_filter,
    )
    return bool(r.matched_count)


def attach(api, db, require_role):

    # ---- access probe (used by the page to decide if it should render)
    @api.get("/portal/marketing/access")
    async def check_access(user: dict = Depends(require_role("franchisee"))):
        try:
            fr = await _check_access(db, user)
            mods = fr.get("portal_modules") or {}
            return {
                "allowed": True,
                "bookings_enabled": bool(mods.get("bookings"))
                                    or any(str(t).strip().lower() == "demo" for t in (fr.get("tags") or [])),
                "from_email": fr.get("mojo_email") or "",
                "franchisee_name": f"{fr.get('first_name','')} {fr.get('last_name','')}".strip()
                                   or fr.get("organisation") or "Creative Mojo",
                "organisation": fr.get("organisation") or "",
            }
        except HTTPException as e:
            return {"allowed": False, "reason": e.detail}

    # ---- recipients (Territory+ clients with at least one email)
    @api.get("/portal/marketing/recipients")
    async def list_recipients(user: dict = Depends(require_role("franchisee"))):
        fr = await _check_access(db, user)
        out: list[dict] = []
        async for c in db.franchisee_clients.find(
            {"franchisee_id": fr["id"]}, {"_id": 0},
        ).sort("name", 1):
            # Primary email row (from the client's manager / generic inbox).
            if c.get("email"):
                out.append({
                    "client_id": c["id"],
                    "contact_index": -1,
                    "name": c.get("manager") or c.get("name") or "Manager",
                    "role": "Primary",
                    "organisation": c.get("name"),
                    "email": c.get("email"),
                    "phone": c.get("phone"),
                })
            # Each secondary contact that has an email.
            for idx, ct in enumerate(c.get("contacts") or []):
                if ct and ct.get("email"):
                    out.append({
                        "client_id": c["id"],
                        "contact_index": idx,
                        "name": ct.get("name") or "Contact",
                        "role": ct.get("role") or "Contact",
                        "organisation": c.get("name"),
                        "email": ct.get("email"),
                        "phone": ct.get("phone"),
                    })
        return {"items": out, "total": len(out), "max_per_send": MAX_RECIPIENTS_PER_SEND}

    # ---- image upload + crop (the frontend has already cropped to a Blob)
    @api.post("/portal/marketing/upload-image")
    async def upload_image(
        file: UploadFile = File(...),
        user: dict = Depends(require_role("franchisee")),
    ):
        fr = await _check_access(db, user)
        from file_storage import r2_configured, get_client, R2_BUCKET, SCOPE_SHARED
        if not r2_configured():
            raise HTTPException(503, detail="R2 not configured")
        ct = (file.content_type or "").lower()
        if not ct.startswith("image/"):
            raise HTTPException(415, detail="Only image files are supported")
        ext = (ct.split("/")[-1] if "/" in ct else "jpg").replace("jpeg", "jpg")
        data = await file.read()
        if len(data) > 12 * 1024 * 1024:
            raise HTTPException(413, detail="Image must be ≤ 12 MB")
        new_id = uuid.uuid4().hex[:12]
        safe_name = f"{new_id}.{ext}"
        key = f"shared/_marketing_images/{fr['id']}/{safe_name}"
        client = get_client()
        client.put_object(
            Bucket=R2_BUCKET, Key=key, Body=data,
            ContentType=ct, CacheControl="public, max-age=31536000, immutable",
        )
        await db.files_index.insert_one({
            "key": key,
            "name": file.filename or safe_name,
            "size": len(data),
            "content_type": ct,
            "scope": SCOPE_SHARED,
            "uploaded_at": _now_iso(),
            "uploaded_by": user.get("email"),
            "franchisee_id": fr["id"],
            "purpose": "marketing-image",
        })
        # Mint a permanent share-link viewer URL so the recipient's email
        # client renders the image without auth.
        import secrets as _secrets
        token = _secrets.token_urlsafe(18)
        await db.files_share_links.insert_one({
            "token": token,
            "key": key,
            "filename": file.filename or safe_name,
            "expires_at": None,
            "lifetime": True,
            "revoked": False,
            "created_at": _now_iso(),
            "created_by": "marketing",
            "hits": 0,
        })
        # Return both an image URL (for the email; the share-redirect
        # serves the full-res image — Gmail/Outlook follow the 302 and
        # cache the result, so recipients see the full image not a
        # thumbnail) and the share key so the composer can swap to a
        # presigned URL later if needed.
        base = (os.environ.get("FRONTEND_URL") or "").rstrip("/")
        return {
            "key": key,
            "image_url": f"{base}/api/files/share/{token}",
            "share_url": f"{base}/api/files/share/{token}",
            "size": len(data),
        }

    # ---- live preview
    @api.post("/portal/marketing/preview-html")
    async def preview_html(body: dict, user: dict = Depends(require_role("franchisee"))):
        fr = await _check_access(db, user)
        campaign = {
            "title": (body.get("title") or "").strip() or "(no subject yet)",
            "intro": body.get("intro") or "",
            "image_url": body.get("image_url") or "",
            "link_url": body.get("link_url") or "",
            "link_label": body.get("link_label") or "Find out more",
            "bookings_url": body.get("bookings_url") or "",
            "franchisee_name": f"{fr.get('first_name','')} {fr.get('last_name','')}".strip()
                               or fr.get("organisation") or "Creative Mojo",
            "franchisee_organisation": fr.get("organisation") or "Creative Mojo",
        }
        sample = (body.get("sample_first_name") or "there").strip() or "there"
        return {"html": _build_html(campaign, first_name=sample)}

    # ---- test send (to the franchisee's own email)
    @api.post("/portal/marketing/test-send")
    async def test_send(body: dict, request: Request, user: dict = Depends(require_role("franchisee"))):
        fr = await _check_access(db, user)
        from_email = (fr.get("mojo_email") or "").strip()
        if not from_email:
            raise HTTPException(400, detail="Your Mojo email isn't set — ask HQ to add it on your franchisee record.")
        from resend_routes import RESEND_API_KEY
        if not RESEND_API_KEY:
            raise HTTPException(503, detail="Resend not configured")
        import resend as _resend
        _resend.api_key = RESEND_API_KEY
        title = (body.get("title") or "").strip() or "(no subject)"
        to = (body.get("to") or from_email).strip()
        campaign = {
            "title": title,
            "intro": body.get("intro") or "",
            "image_url": body.get("image_url") or "",
            "link_url": body.get("link_url") or "",
            "link_label": body.get("link_label") or "Find out more",
            "bookings_url": body.get("bookings_url") or "",
            "franchisee_name": f"{fr.get('first_name','')} {fr.get('last_name','')}".strip()
                               or fr.get("organisation") or "Creative Mojo",
            "franchisee_organisation": fr.get("organisation") or "Creative Mojo",
        }
        first_name = (body.get("sample_first_name") or "there").strip() or "there"
        html = _build_html(campaign, first_name=first_name)
        sender_name = campaign["franchisee_name"]
        try:
            await asyncio.to_thread(_resend.Emails.send, {
                "from": f"{sender_name} <{from_email}>",
                "to": [to],
                "reply_to": from_email,
                "subject": f"[TEST] {title}",
                "html": html,
                "tags": [{"name": "kind", "value": "marketing-test"}],
            })
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(502, detail=str(exc)) from exc
        return {"ok": True, "to": to}

    # ---- create + send a campaign
    @api.post("/portal/marketing/campaigns")
    async def create_campaign(body: dict, request: Request, user: dict = Depends(require_role("franchisee"))):
        fr = await _check_access(db, user)
        from_email = (fr.get("mojo_email") or "").strip()
        if not from_email:
            raise HTTPException(400, detail="Your Mojo email isn't set — ask HQ to add it on your franchisee record.")
        title = (body.get("title") or "").strip()
        if not title:
            raise HTTPException(400, detail="Subject line is required.")
        intro = (body.get("intro") or "").strip()
        if not intro:
            raise HTTPException(400, detail="Intro text is required.")
        recipients_in = body.get("recipients") or []
        if not recipients_in:
            raise HTTPException(400, detail="Pick at least one recipient.")
        if len(recipients_in) > MAX_RECIPIENTS_PER_SEND:
            raise HTTPException(
                400,
                detail=f"You can only send to {MAX_RECIPIENTS_PER_SEND} recipients at a time.",
            )

        # Resolve recipient docs from Territory+ clients so the franchisee
        # can't smuggle in arbitrary external emails (anti-spam guardrail).
        resolved: list[dict] = []
        seen_emails: set[str] = set()
        for r in recipients_in:
            client_id = r.get("client_id")
            contact_index = r.get("contact_index", -1)
            if not client_id:
                continue
            client = await db.franchisee_clients.find_one(
                {"id": client_id, "franchisee_id": fr["id"]}, {"_id": 0},
            )
            if not client:
                continue
            if contact_index == -1:
                email = (client.get("email") or "").strip()
                first_name = (client.get("manager") or client.get("name") or "there").split(" ", 1)[0]
                role = "Primary"
            else:
                ct = (client.get("contacts") or [])[contact_index] if 0 <= contact_index < len(client.get("contacts") or []) else None
                if not ct:
                    continue
                email = (ct.get("email") or "").strip()
                first_name = (ct.get("name") or "there").split(" ", 1)[0]
                role = ct.get("role") or "Contact"
            if not email or email.lower() in seen_emails:
                continue
            seen_emails.add(email.lower())
            resolved.append({
                "client_id": client_id,
                "contact_index": contact_index,
                "email": email,
                "first_name": first_name or "there",
                "name": client.get("name") or "",
                "role": role,
            })
        if not resolved:
            raise HTTPException(400, detail="None of the chosen recipients have a valid email address.")
        if len(resolved) > MAX_RECIPIENTS_PER_SEND:
            resolved = resolved[:MAX_RECIPIENTS_PER_SEND]

        body_origin = body.get("frontend_origin") or ""
        base = _frontend_base(request, body_origin)
        bookings_url = (
            f"{base}/portal/bookings"
            if body.get("include_bookings_link") and any(str(t).strip().lower() == "demo" for t in (fr.get("tags") or []))
                or (body.get("include_bookings_link") and (fr.get("portal_modules") or {}).get("bookings"))
            else ""
        )

        campaign_id = str(uuid.uuid4())
        campaign_doc = {
            "id": campaign_id,
            "franchisee_id": fr["id"],
            "title": title,
            "intro": intro,
            "image_url": body.get("image_url") or "",
            "image_key": body.get("image_key") or "",
            "link_url": body.get("link_url") or "",
            "link_label": body.get("link_label") or "Find out more",
            "bookings_url": bookings_url,
            "include_bookings_link": bool(body.get("include_bookings_link")),
            "from_email": from_email,
            "franchisee_name": f"{fr.get('first_name','')} {fr.get('last_name','')}".strip()
                               or fr.get("organisation") or "Creative Mojo",
            "franchisee_organisation": fr.get("organisation") or "Creative Mojo",
            "created_at": _now_iso(),
            "created_by": user.get("email"),
            "recipients": [],
            "delivery": {"status": "pending", "succeeded": 0, "failed": 0, "errors": []},
        }

        from resend_routes import RESEND_API_KEY
        if not RESEND_API_KEY:
            raise HTTPException(503, detail="Resend not configured")
        import resend as _resend
        _resend.api_key = RESEND_API_KEY

        sender_name = campaign_doc["franchisee_name"]
        succeeded = 0
        failures: list[str] = []
        per_recipient: list[dict] = []
        for r in resolved:
            send_id = str(uuid.uuid4())
            html = _build_html(campaign_doc, first_name=r["first_name"])
            try:
                resp = await asyncio.to_thread(_resend.Emails.send, {
                    "from": f"{sender_name} <{from_email}>",
                    "to": [r["email"]],
                    "reply_to": from_email,
                    "subject": title,
                    "html": html,
                    "headers": {"X-CM-Send-Id": send_id},
                    "tags": [
                        {"name": "kind", "value": "marketing-campaign"},
                        {"name": "campaign_id", "value": campaign_id},
                        {"name": "recipient_send_id", "value": send_id},
                    ],
                })
                resend_id = resp.get("id") if isinstance(resp, dict) else None
                succeeded += 1
                per_recipient.append({
                    **r,
                    "send_id": send_id,
                    "resend_id": resend_id,
                    "sent_at": _now_iso(),
                    "status": "sent",
                    "events": [{"type": "sent", "at": _now_iso()}],
                    "last_event": "sent",
                    "last_event_at": _now_iso(),
                })
            except Exception as exc:  # noqa: BLE001
                msg = f"{r['email']}: {exc}"
                failures.append(msg)
                logger.warning("Marketing send failed: %s", msg)
                per_recipient.append({
                    **r,
                    "send_id": send_id,
                    "resend_id": None,
                    "sent_at": _now_iso(),
                    "status": "failed",
                    "error": str(exc),
                    "events": [{"type": "failed", "at": _now_iso(), "reason": str(exc)}],
                    "last_event": "failed",
                    "last_event_at": _now_iso(),
                })

        campaign_doc["recipients"] = per_recipient
        campaign_doc["delivery"] = {
            "status": "sent" if succeeded and not failures
                      else ("partial" if succeeded else "failed"),
            "succeeded": succeeded,
            "failed": len(failures),
            "errors": failures[:10],
        }
        campaign_doc["sent_at"] = _now_iso()
        await db.marketing_campaigns.insert_one(campaign_doc)
        return {"ok": succeeded > 0, "campaign_id": campaign_id, **campaign_doc["delivery"]}

    # ---- list past campaigns
    @api.get("/portal/marketing/campaigns")
    async def list_campaigns(user: dict = Depends(require_role("franchisee"))):
        fr = await _check_access(db, user)
        items: list[dict] = []
        async for doc in db.marketing_campaigns.find(
            {"franchisee_id": fr["id"]}, {"_id": 0},
        ).sort("created_at", -1).limit(200):
            # Roll up open/click counts for the table view.
            opens = sum(1 for r in (doc.get("recipients") or [])
                        if any(e.get("type") in ("opened", "open") for e in (r.get("events") or [])))
            clicks = sum(1 for r in (doc.get("recipients") or [])
                         if any(e.get("type") in ("clicked", "click") for e in (r.get("events") or [])))
            doc["opens_count"] = opens
            doc["clicks_count"] = clicks
            doc["recipient_count"] = len(doc.get("recipients") or [])
            items.append(doc)
        return {"items": items, "total": len(items)}

    # ---- single campaign (report panel)
    @api.get("/portal/marketing/campaigns/{campaign_id}")
    async def get_campaign(campaign_id: str, user: dict = Depends(require_role("franchisee"))):
        fr = await _check_access(db, user)
        doc = await db.marketing_campaigns.find_one(
            {"id": campaign_id, "franchisee_id": fr["id"]}, {"_id": 0},
        )
        if not doc:
            raise HTTPException(404, detail="Campaign not found")
        return doc

    # ---- delete a campaign (history cleanup — doesn't unsend the email)
    @api.delete("/portal/marketing/campaigns/{campaign_id}")
    async def delete_campaign(campaign_id: str, user: dict = Depends(require_role("franchisee"))):
        fr = await _check_access(db, user)
        r = await db.marketing_campaigns.delete_one(
            {"id": campaign_id, "franchisee_id": fr["id"]},
        )
        if not r.deleted_count:
            raise HTTPException(404, detail="Campaign not found")
        return {"ok": True}

    # ---- webhook fan-out: called by ``resend_routes`` via the
    # module-level ``apply_event`` function defined above. Nothing to
    # register on the router itself.
    return None
