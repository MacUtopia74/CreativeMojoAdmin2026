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
         "mojo_email": 1, "tags": 1, "portal_modules": 1,
         # Needed by the e-shot builder for the logo target + footer
         # contact block + GDPR sender block.
         "mobile_phone": 1, "facebook_url": 1, "facebook": 1,
         "wp_page_url": 1, "marketing_settings": 1,
         "address_street": 1, "city": 1, "postcode": 1},
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
def _sanitise_intro_html(raw: str) -> str:
    """Strict allowlist sanitiser for the intro field. The composer
    saves HTML so a franchisee can bold/centre selected text, but we
    can't trust the payload — script tags, iframes, event handlers,
    style attributes etc would let a hostile draft inject arbitrary
    CSS/JS into every recipient's inbox. So we keep only ``<b>``,
    ``<strong>``, ``<i>``, ``<em>``, ``<u>``, ``<br>`` and ``<div>``/
    ``<p>`` with a single style attr restricted to ``text-align: …``.

    Plain text (the common case) passes straight through with newline
    → ``<br/>`` so it still looks right in the email.
    """
    if not raw:
        return ""
    # Plain text fallback — no angle brackets at all
    if "<" not in raw and ">" not in raw:
        return raw.replace("\n", "<br/>")
    try:
        from html.parser import HTMLParser
        ALLOWED_TAGS = {
            "b", "strong", "i", "em", "u", "br", "div", "p", "span",
        }
        # Only keep ``text-align`` from style attributes, and only
        # if the value is one of left/right/center/justify.
        import re as _re
        STYLE_RX = _re.compile(r"text-align\s*:\s*(left|right|center|justify)", _re.I)

        out_parts: list[str] = []

        class Cleaner(HTMLParser):
            def handle_starttag(self, tag, attrs):
                t = tag.lower()
                if t not in ALLOWED_TAGS:
                    return
                kept: list[str] = []
                for k, v in attrs:
                    if k.lower() == "style" and v:
                        m = STYLE_RX.search(v)
                        if m:
                            kept.append(f'style="text-align:{m.group(1).lower()}"')
                attr_str = (" " + " ".join(kept)) if kept else ""
                out_parts.append(f"<{t}{attr_str}>")
            def handle_endtag(self, tag):
                t = tag.lower()
                if t in ALLOWED_TAGS and t != "br":
                    out_parts.append(f"</{t}>")
            def handle_startendtag(self, tag, attrs):
                t = tag.lower()
                if t == "br":
                    out_parts.append("<br/>")
            def handle_data(self, data):
                # html.escape so the literal text can't reintroduce
                # tags via entities.
                from html import escape as _esc
                out_parts.append(_esc(data))

        cleaner = Cleaner()
        cleaner.feed(raw)
        return "".join(out_parts)
    except Exception:
        # If anything goes wrong, fall back to fully escaped text — the
        # email still goes out, just without formatting.
        from html import escape as _esc
        return _esc(raw).replace("\n", "<br/>")


def _build_panel_html(panel: dict) -> str:
    """Render a single content panel — intro text + image + link
    button. Empty subsections are skipped. Each panel is later
    separated by the brand-yellow divider."""
    intro_html = _sanitise_intro_html((panel.get("intro") or ""))
    image_url = (panel.get("image_url") or "").strip()
    link_url = (panel.get("link_url") or "").strip()
    link_label = (panel.get("link_label") or "Find out more").strip() or "Find out more"

    blocks: list[str] = []
    if intro_html:
        blocks.append(
            f'<tr><td style="padding:14px 30px 18px;font-size:15px;line-height:1.6;color:#1a1a1a;">{intro_html}</td></tr>'
        )
    if image_url:
        blocks.append(
            '<tr><td align="center" style="padding:0 30px 16px 30px;">'
            f'<img src="{image_url}" alt="" width="540" '
            'style="max-width:100%;height:auto;border-radius:8px;display:block;margin:0 auto;" />'
            '</td></tr>'
        )
    if link_url:
        blocks.append(
            f'<tr><td align="center" style="padding:6px 30px 18px 30px;">'
            f'<a href="{link_url}" style="display:inline-block;background:#dddd16;color:#1a1a1a;'
            'font-weight:700;text-decoration:none;padding:13px 32px;border-radius:4px;'
            f'font-size:13px;letter-spacing:0.5px;margin:4px;">{link_label.upper()} &rsaquo;</a>'
            '</td></tr>'
        )
    return "".join(blocks)


def _build_html(campaign: dict, first_name: str = "{{first_name}}") -> str:
    """Branded HTML email. Supports a multi-panel composition: every
    panel = ``{intro, image_url, link_url, link_label}`` and is
    separated by the brand-yellow horizontal divider. The classic
    single-panel campaign is rendered as a one-element panel list.
    """
    panels = campaign.get("panels")
    if not panels:
        # Legacy single-panel data — synthesise a one-entry array.
        panels = [{
            "intro":      campaign.get("intro"),
            "image_url":  campaign.get("image_url"),
            "link_url":   campaign.get("link_url"),
            "link_label": campaign.get("link_label") or "Find out more",
        }]

    bookings_url = (campaign.get("bookings_url") or "").strip()
    franchisee_name = (campaign.get("franchisee_name") or "Creative Mojo").strip()
    franchisee_org = (campaign.get("franchisee_organisation") or "Creative Mojo").strip()
    # Logo click-through target. Falls back gracefully if the franchisee
    # hasn't configured a Mojo franchise page yet — we don't want a
    # broken link in the email, so we omit the anchor wrapper instead.
    logo_target = (campaign.get("logo_target_url") or "").strip()
    # Per-send footer toggles. Each value is a string the franchisee
    # picked from the compose-modal checkboxes; if blank we hide the
    # corresponding line.
    footer_phone = (campaign.get("footer_phone") or "").strip()
    footer_email = (campaign.get("footer_email") or "").strip()
    footer_facebook = (campaign.get("footer_facebook") or "").strip()
    franchisee_address = (campaign.get("franchisee_address") or "").strip()
    divider = (
        '<tr><td style="padding:0 30px 18px 30px;">'
        '<div style="height:0;border-top:1px solid #dddd16;margin:0;"></div>'
        '</td></tr>'
    )

    panel_html: list[str] = []
    for i, p in enumerate(panels):
        rendered = _build_panel_html(p or {})
        if not rendered:
            continue
        if panel_html:
            # Yellow divider between panels (mirrors HQ Updates)
            panel_html.append(divider)
        panel_html.append(rendered)
    body_panels = "".join(panel_html)

    bookings_block = ""
    if bookings_url:
        bookings_block = (
            f'<tr><td align="center" style="padding:6px 30px 28px 30px;">'
            f'<a href="{bookings_url}" style="display:inline-block;background:#1a1a1a;color:#dddd16;'
            'font-weight:700;text-decoration:none;padding:13px 32px;border-radius:4px;'
            'font-size:13px;letter-spacing:0.5px;margin:8px;">BOOK A SESSION &rsaquo;</a>'
            '</td></tr>'
        )

    # Header logo — wrap in <a> only if we have a sensible target so
    # we never ship a broken anchor.
    logo_img = (
        f'<img src="{LOGO_URL}" alt="Creative Mojo" width="220"'
        ' style="max-width:220px;height:auto;display:block;border:0;" />'
    )
    if logo_target:
        logo_block = (
            f'<a href="{logo_target}" target="_blank" rel="noopener" '
            f'style="display:inline-block;text-decoration:none;">{logo_img}</a>'
        )
    else:
        logo_block = logo_img

    # ---- Footer contact block. Rendered only when at least one
    # checkbox is ticked. Kept compact, single column, easy to scan.
    contact_lines: list[str] = []
    if footer_phone:
        contact_lines.append(
            f'<a href="tel:{footer_phone}" style="color:#1a1a1a;text-decoration:none;">'
            f'Tel: {footer_phone}</a>'
        )
    if footer_email:
        contact_lines.append(
            f'<a href="mailto:{footer_email}" style="color:#1a1a1a;text-decoration:none;">'
            f'{footer_email}</a>'
        )
    if footer_facebook:
        contact_lines.append(
            f'<a href="{footer_facebook}" target="_blank" rel="noopener" '
            f'style="color:#1a1a1a;text-decoration:none;">Find us on Facebook</a>'
        )
    contact_block = ""
    if contact_lines:
        contact_block = (
            '<tr><td align="center" style="padding:8px 30px 18px 30px;'
            'font-size:13px;line-height:1.7;color:#1a1a1a;">'
            + ' &middot; '.join(contact_lines) +
            '</td></tr>'
        )

    # ---- GDPR / compliance block. Always rendered. Identifies the
    # sender (organisation + postal address) and explains lawful basis
    # + opt-out path in plain English so it satisfies UK PECR + GDPR.
    addr_line = f"{franchisee_address}<br/>" if franchisee_address else ""
    compliance_block = (
        '<tr><td style="padding:18px 30px 24px 30px;font-size:11px;'
        'color:#999999;line-height:1.6;text-align:center;'
        'border-top:1px solid #eaeaea;">'
        f'Sent by <strong>{franchisee_name}</strong> &middot; {franchisee_org}<br/>'
        f'{addr_line}'
        "You're receiving this because you're a Creative Mojo customer."
        " To unsubscribe, simply reply to this email with"
        ' <em>UNSUBSCRIBE</em> in the subject line and we\'ll remove you'
        ' from our list immediately.'
        '</td></tr>'
    )

    return f"""<!doctype html>
<html><body style="margin:0;background:#f7f7f4;font-family:Helvetica,Arial,sans-serif;">
<table cellpadding="0" cellspacing="0" border="0" width="100%" bgcolor="#f7f7f4" style="background:#f7f7f4;">
  <tr><td align="center" style="padding:30px 16px;">
    <table cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;background:#ffffff;border:1px solid #ececec;">
      <tr><td align="center" style="padding:30px 30px 14px;">
        {logo_block}
      </td></tr>
      <tr><td align="center" style="padding:22px 30px 0;">
        <div style="font-family:Helvetica,Arial,sans-serif;font-size:24px;font-weight:800;
                    color:#1a1a1a;line-height:1.2;text-align:center;">
          {campaign.get('title','')}
        </div>
      </td></tr>
      <tr><td style="padding:14px 30px 6px;font-size:15px;line-height:1.6;color:#1a1a1a;">
        <div>Hi <strong>{first_name}</strong>,</div>
      </td></tr>
      {body_panels}
      {bookings_block}
      {contact_block}
      {compliance_block}
    </table>
  </td></tr>
</table>
</body></html>"""


def _validate_panels(body: dict, require_content: bool = True) -> tuple[list[dict], Optional[str]]:
    """Normalise an incoming campaign body into a list of panels.

    Accepts either:
      • ``body["panels"]`` — the new multi-section composer shape, OR
      • a legacy top-level ``intro / image_url / link_url / link_label`` —
        which we synthesise into a single-panel array so older clients
        and HTTP scripts keep working.

    Caps panels at a sane upper bound and strips out empty entries.
    When ``require_content`` is True (used for send), requires that at
    least one panel has visible content (text, image, or link).

    Returns ``(panels, error_detail)``.
    """
    raw_panels = body.get("panels")
    panels: list[dict] = []
    if isinstance(raw_panels, list) and raw_panels:
        for p in raw_panels[:8]:  # hard-cap at 8 sections — UX/anti-abuse
            if not isinstance(p, dict):
                continue
            cleaned = {
                "intro":      (p.get("intro") or "").strip(),
                "image_url":  (p.get("image_url") or "").strip(),
                "image_key":  (p.get("image_key") or "").strip(),
                "link_url":   (p.get("link_url") or "").strip(),
                "link_label": (p.get("link_label") or "").strip() or "Find out more",
            }
            # Skip totally-empty panels — the user probably added one
            # and forgot to fill it.
            if cleaned["intro"] or cleaned["image_url"] or cleaned["link_url"]:
                panels.append(cleaned)
    else:
        # Legacy shape → one-element array.
        legacy = {
            "intro":      (body.get("intro") or "").strip(),
            "image_url":  (body.get("image_url") or "").strip(),
            "image_key":  (body.get("image_key") or "").strip(),
            "link_url":   (body.get("link_url") or "").strip(),
            "link_label": (body.get("link_label") or "").strip() or "Find out more",
        }
        if legacy["intro"] or legacy["image_url"] or legacy["link_url"]:
            panels.append(legacy)

    if require_content and not panels:
        return [], "Add some content to at least one panel before sending."
    return panels, None


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


def _campaign_branding_from(fr: dict, body: dict | None = None) -> dict:
    """Pull the per-franchisee branding bits out of the franchisee
    record + per-send body, returning the dict fragment that
    ``_build_html`` understands.

    ``body`` carries the four per-send toggles
    (``footer_show_phone/email/facebook`` booleans) so the franchisee
    can choose what's on each individual e-shot. ``logo_target_url``
    is fully derived from the franchisee profile — they pick the
    target once in Marketing → Settings and it sticks.
    """
    body = body or {}
    marketing = fr.get("marketing_settings") or {}
    logo_choice = (marketing.get("logo_target") or "mojo_page").lower()
    fb_url = (marketing.get("facebook_url") or fr.get("facebook_url") or fr.get("facebook") or "").strip()
    mojo_url = (marketing.get("mojo_page_url") or fr.get("wp_page_url") or "").strip()
    logo_target = fb_url if logo_choice == "facebook" else mojo_url
    addr = ", ".join([
        p for p in (
            (fr.get("address_street") or "").strip().rstrip(","),
            (fr.get("city") or "").strip(),
            (fr.get("postcode") or "").strip(),
        ) if p
    ])
    return {
        "logo_target_url": logo_target,
        "franchisee_address": addr,
        "footer_phone": (fr.get("mobile_phone") or "").strip()
            if body.get("footer_show_phone") else "",
        "footer_email": (fr.get("mojo_email") or "").strip()
            if body.get("footer_show_email") else "",
        "footer_facebook": fb_url if body.get("footer_show_facebook") else "",
    }


def attach(api, db, require_role):

    # ---- access probe (used by the page to decide if it should render)
    @api.get("/portal/marketing/access")
    async def check_access(user: dict = Depends(require_role("franchisee"))):
        try:
            fr = await _check_access(db, user)
            mods = fr.get("portal_modules") or {}
            marketing = fr.get("marketing_settings") or {}
            return {
                "allowed": True,
                "bookings_enabled": bool(mods.get("bookings"))
                                    or any(str(t).strip().lower() == "demo" for t in (fr.get("tags") or [])),
                "from_email": fr.get("mojo_email") or "",
                "franchisee_name": f"{fr.get('first_name','')} {fr.get('last_name','')}".strip()
                                   or fr.get("organisation") or "Creative Mojo",
                "organisation": fr.get("organisation") or "",
                # Surface what the compose modal needs to pre-tick its
                # checkboxes + show greyed-out previews of the contact
                # block. Empty strings = "field not set, skip".
                "phone": fr.get("mobile_phone") or "",
                "facebook_url": (marketing.get("facebook_url")
                                 or fr.get("facebook_url")
                                 or fr.get("facebook") or ""),
                "mojo_page_url": (marketing.get("mojo_page_url")
                                  or fr.get("wp_page_url") or ""),
                "logo_target": (marketing.get("logo_target") or "mojo_page"),
            }
        except HTTPException as e:
            return {"allowed": False, "reason": e.detail}

    # ---- Marketing settings (logo destination + Facebook URL). The
    # Mojo franchise page URL is derived from the franchisee's
    # ``wp_page_url`` so admins only have to maintain it in one place.
    @api.get("/portal/marketing/settings")
    async def get_marketing_settings(user: dict = Depends(require_role("franchisee"))):
        fr = await _check_access(db, user)
        m = fr.get("marketing_settings") or {}
        return {
            "logo_target": m.get("logo_target") or "mojo_page",
            "facebook_url": m.get("facebook_url") or fr.get("facebook_url") or fr.get("facebook") or "",
            "mojo_page_url": m.get("mojo_page_url") or fr.get("wp_page_url") or "",
            # Read-only fields surfaced for the UI to render contextual
            # info next to each form input.
            "phone": fr.get("mobile_phone") or "",
            "email": fr.get("mojo_email") or "",
        }

    @api.patch("/portal/marketing/settings")
    async def update_marketing_settings(
        body: dict, user: dict = Depends(require_role("franchisee")),
    ):
        fr = await _check_access(db, user)
        existing = fr.get("marketing_settings") or {}
        update = dict(existing)
        if "logo_target" in body:
            choice = str(body.get("logo_target") or "").lower()
            if choice not in {"facebook", "mojo_page"}:
                raise HTTPException(400, detail="logo_target must be 'facebook' or 'mojo_page'")
            update["logo_target"] = choice
        if "facebook_url" in body:
            update["facebook_url"] = (body.get("facebook_url") or "").strip() or None
        if "mojo_page_url" in body:
            update["mojo_page_url"] = (body.get("mojo_page_url") or "").strip() or None
        # Persist back onto the franchisee doc so the rest of the app
        # (panels, /portal/me, etc.) keeps seeing the same source of truth.
        await db.franchisees.update_one(
            {"id": fr["id"]},
            {"$set": {"marketing_settings": update, "updated_at": _now_iso()}},
        )
        return {"ok": True, "marketing_settings": update}

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
        request: Request,
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
        # Always mint an ABSOLUTE URL — falling back to FRONTEND_URL
        # only when no request origin is available. The previous build
        # relied solely on ``FRONTEND_URL`` and so produced a relative
        # URL on production where that env var was unset, breaking the
        # in-iframe live preview AND the actual email rendering.
        base = _frontend_base(request, "")
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
            "panels": body.get("panels"),
            # Backwards-compat fallback for callers still on the
            # single-panel shape (test-send, older drafts).
            "intro": body.get("intro") or "",
            "image_url": body.get("image_url") or "",
            "link_url": body.get("link_url") or "",
            "link_label": body.get("link_label") or "Find out more",
            "bookings_url": body.get("bookings_url") or "",
            "franchisee_name": f"{fr.get('first_name','')} {fr.get('last_name','')}".strip()
                               or fr.get("organisation") or "Creative Mojo",
            "franchisee_organisation": fr.get("organisation") or "Creative Mojo",
            **_campaign_branding_from(fr, body),
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
        from resend_config import RESEND_API_KEY
        if not RESEND_API_KEY:
            raise HTTPException(503, detail="Resend not configured")
        import resend as _resend
        _resend.api_key = RESEND_API_KEY
        title = (body.get("title") or "").strip() or "(no subject)"
        to = (body.get("to") or from_email).strip()
        campaign = {
            "title": title,
            "panels": body.get("panels"),
            "intro": body.get("intro") or "",
            "image_url": body.get("image_url") or "",
            "link_url": body.get("link_url") or "",
            "link_label": body.get("link_label") or "Find out more",
            "bookings_url": body.get("bookings_url") or "",
            "franchisee_name": f"{fr.get('first_name','')} {fr.get('last_name','')}".strip()
                               or fr.get("organisation") or "Creative Mojo",
            "franchisee_organisation": fr.get("organisation") or "Creative Mojo",
            **_campaign_branding_from(fr, body),
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
        # Either ``panels`` (new multi-section composer) or legacy
        # ``intro`` (old single-block draft) — at least one panel with
        # text or media is required.
        panels_in, _panel_err = _validate_panels(body)
        if _panel_err:
            raise HTTPException(400, detail=_panel_err)
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
        # Support promoting an existing draft → use its id and delete
        # the draft after a successful send so we don't end up with
        # both a draft and a sent copy.
        draft_id = (body.get("draft_id") or "").strip() or None
        if draft_id:
            existing = await db.marketing_campaigns.find_one(
                {"id": draft_id, "franchisee_id": fr["id"]}, {"_id": 0, "status": 1},
            )
            if existing and (existing.get("status") or "draft") == "draft":
                campaign_id = draft_id
        # Legacy single-panel mirror so /campaigns/{id} viewers and
        # reports built before this migration still render.
        first_panel = (panels_in[0] if panels_in else {}) or {}
        campaign_doc = {
            "id": campaign_id,
            "franchisee_id": fr["id"],
            "status": "sent",
            "title": title,
            "panels": panels_in,
            "intro": first_panel.get("intro") or "",
            "image_url": first_panel.get("image_url") or "",
            "image_key": first_panel.get("image_key") or "",
            "link_url": first_panel.get("link_url") or "",
            "link_label": first_panel.get("link_label") or "Find out more",
            "bookings_url": bookings_url,
            "include_bookings_link": bool(body.get("include_bookings_link")),
            "footer_show_phone": bool(body.get("footer_show_phone")),
            "footer_show_email": bool(body.get("footer_show_email")),
            "footer_show_facebook": bool(body.get("footer_show_facebook")),
            "from_email": from_email,
            "franchisee_name": f"{fr.get('first_name','')} {fr.get('last_name','')}".strip()
                               or fr.get("organisation") or "Creative Mojo",
            "franchisee_organisation": fr.get("organisation") or "Creative Mojo",
            **_campaign_branding_from(fr, body),
            "created_at": _now_iso(),
            "created_by": user.get("email"),
            "recipients": [],
            "delivery": {"status": "pending", "succeeded": 0, "failed": 0, "errors": []},
        }

        from resend_config import RESEND_API_KEY
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
        # ``replace_one upsert=True`` so promoting a draft overwrites the
        # existing doc instead of inserting a duplicate. New sends still
        # land via insert (no doc matches the campaign_id yet).
        await db.marketing_campaigns.replace_one(
            {"id": campaign_id, "franchisee_id": fr["id"]},
            campaign_doc, upsert=True,
        )
        return {"ok": succeeded > 0, "campaign_id": campaign_id, **campaign_doc["delivery"]}

    # ---- save / update a draft (no Resend send, no recipient validation)
    @api.post("/portal/marketing/campaigns/draft")
    async def save_draft(body: dict, user: dict = Depends(require_role("franchisee"))):
        fr = await _check_access(db, user)
        title = (body.get("title") or "").strip()
        panels_in, _err = _validate_panels(body, require_content=False)
        # Drafts have softer validation — we only require *something*
        # the user can identify later (either a title or some panel
        # content).
        if not title and not any(
            (p.get("intro") or "").strip() or (p.get("image_url") or "").strip() or (p.get("link_url") or "").strip()
            for p in (panels_in or [])
        ):
            raise HTTPException(400, detail="Add a subject line or some content before saving.")
        first_panel = (panels_in[0] if panels_in else {}) or {}
        # If updating an existing draft, keep its id; otherwise mint a new one.
        draft_id = (body.get("id") or "").strip() or str(uuid.uuid4())
        now = _now_iso()
        # Don't blow away an existing draft's created_at on each save.
        existing = await db.marketing_campaigns.find_one(
            {"id": draft_id, "franchisee_id": fr["id"]}, {"_id": 0, "created_at": 1, "status": 1},
        )
        if existing and (existing.get("status") or "draft") != "draft":
            raise HTTPException(400, detail="That campaign has already been sent and can't be edited.")
        created_at = (existing or {}).get("created_at") or now
        draft_doc = {
            "id": draft_id,
            "franchisee_id": fr["id"],
            "status": "draft",
            "title": title,
            "panels": panels_in or [],
            "intro": first_panel.get("intro") or "",
            "image_url": first_panel.get("image_url") or "",
            "image_key": first_panel.get("image_key") or "",
            "link_url": first_panel.get("link_url") or "",
            "link_label": first_panel.get("link_label") or "Find out more",
            "include_bookings_link": bool(body.get("include_bookings_link")),
            "footer_show_phone": bool(body.get("footer_show_phone")),
            "footer_show_email": bool(body.get("footer_show_email")),
            "footer_show_facebook": bool(body.get("footer_show_facebook")),
            "franchisee_name": f"{fr.get('first_name','')} {fr.get('last_name','')}".strip()
                               or fr.get("organisation") or "Creative Mojo",
            "franchisee_organisation": fr.get("organisation") or "Creative Mojo",
            "created_at": created_at,
            "updated_at": now,
            "created_by": user.get("email"),
            "recipients": [],   # drafts hold no recipients yet
            "delivery": {"status": "draft", "succeeded": 0, "failed": 0, "errors": []},
        }
        await db.marketing_campaigns.replace_one(
            {"id": draft_id, "franchisee_id": fr["id"]},
            draft_doc, upsert=True,
        )
        return {"ok": True, "id": draft_id, "status": "draft"}

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
