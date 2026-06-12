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
  • ``franchisee_clients`` — per-contact ``marketing_unsubscribed`` +
    ``marketing_unsubscribed_at`` + ``marketing_unsubscribed_source``
    fields. Set either by the franchisee toggling a contact off in the
    UI or by the recipient clicking the one-click unsubscribe link in
    the email footer (signed token → GET /api/u/{token}).

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
from fastapi.responses import HTMLResponse
from itsdangerous import URLSafeSerializer, BadSignature
from pydantic import BaseModel, Field

logger = logging.getLogger("creative-mojo-admin.portal_marketing")

LOGO_URL = "https://hub.creativemojo.co.uk/brand/creative-mojo-logo.png"
MAX_RECIPIENTS_PER_SEND = 5

# Salted serializer for the one-click unsubscribe links. The token is
# stuffed straight into the email footer href as
# /api/u/{token} → no DB lookup needed to validate, just verify the
# signature. Salt scopes the secret so unsubscribe tokens can't be
# used as login tokens (or vice versa) even if both share a key.
_UNSUBSCRIBE_SALT = "creative-mojo:marketing-unsubscribe:v1"


def _unsubscribe_serializer() -> URLSafeSerializer:
    """Build (lazily) the URLSafeSerializer used to sign one-click
    unsubscribe links. The secret is the same JWT_SECRET we already
    use for auth — colocated under a different salt so the two
    token families can never be cross-used."""
    key = os.environ.get("JWT_SECRET") or "dev-only-fallback-do-not-use"
    return URLSafeSerializer(key, salt=_UNSUBSCRIBE_SALT)


def _mint_unsubscribe_token(franchisee_id: str, client_id: str,
                            contact_index: int, email: str) -> str:
    """Pack the recipient identity into a signed, URL-safe token so
    the unsubscribe page can verify the click came from a legitimate
    email send (and not, e.g., a curious bot guessing tokens).

    We include ``email`` in the payload primarily so the confirmation
    page can show "we've unsubscribed sandra@example.com" without
    leaking franchisee_id / client_id to the recipient.
    """
    return _unsubscribe_serializer().dumps({
        "f": franchisee_id,
        "c": client_id,
        "i": int(contact_index),
        "e": (email or "").lower(),
    })


def _verify_unsubscribe_token(token: str) -> Optional[dict]:
    try:
        data = _unsubscribe_serializer().loads(token)
    except BadSignature:
        return None
    # Minimal shape check — anything missing means we can't act on it.
    if not isinstance(data, dict) or not data.get("f") or not data.get("c"):
        return None
    return data


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
    saves HTML so a franchisee can bold/italic/underline/colour/align
    selected text, but we can't trust the payload — script tags,
    iframes, event handlers, arbitrary style/class attributes etc would
    let a hostile draft inject CSS/JS into every recipient's inbox.
    So we keep only ``<b><strong><i><em><u><br>`` and ``<div>``/``<p>``/
    ``<span>``/``<font>`` carrying a tightly-restricted ``style`` /
    ``color`` attribute (text-align + colour only).

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
            "b", "strong", "i", "em", "u", "br", "div", "p", "span", "font",
        }
        import re as _re
        ALIGN_RX = _re.compile(r"text-align\s*:\s*(left|right|center|justify)", _re.I)
        # Accept #abc / #aabbcc / rgb(…) — keep it simple but tight.
        COLOR_RX = _re.compile(
            r"color\s*:\s*(#[0-9a-fA-F]{3,8}|rgb\([^)]{1,40}\)|[a-zA-Z]{3,20})",
            _re.I,
        )
        HEX_NAMED_RX = _re.compile(
            r"^(#[0-9a-fA-F]{3,8}|rgb\([^)]{1,40}\)|[a-zA-Z]{3,20})$",
        )

        out_parts: list[str] = []

        class Cleaner(HTMLParser):
            def handle_starttag(self, tag, attrs):
                t = tag.lower()
                if t not in ALLOWED_TAGS:
                    return
                kept: list[str] = []
                styles: list[str] = []
                for k, v in attrs:
                    kl = k.lower()
                    if kl == "style" and v:
                        m = ALIGN_RX.search(v)
                        if m:
                            styles.append(f"text-align:{m.group(1).lower()}")
                        c = COLOR_RX.search(v)
                        if c:
                            styles.append(f"color:{c.group(1)}")
                    elif kl == "color" and v and t == "font" and HEX_NAMED_RX.match(v.strip()):
                        # ``execCommand("foreColor")`` in some browsers
                        # emits ``<font color="…">``; convert it to a
                        # style attr so the email client respects it.
                        styles.append(f"color:{v.strip()}")
                if styles:
                    kept.append(f'style="{";".join(styles)}"')
                attr_str = (" " + " ".join(kept)) if kept else ""
                # Normalise <font> → <span> with style so we control the
                # output shape regardless of browser quirks.
                emit_tag = "span" if t == "font" else t
                out_parts.append(f"<{emit_tag}{attr_str}>")
            def handle_endtag(self, tag):
                t = tag.lower()
                if t in ALLOWED_TAGS and t != "br":
                    emit_tag = "span" if t == "font" else t
                    out_parts.append(f"</{emit_tag}>")
            def handle_startendtag(self, tag, attrs):
                t = tag.lower()
                if t == "br":
                    out_parts.append("<br/>")
            def handle_data(self, data):
                from html import escape as _esc
                out_parts.append(_esc(data))

        cleaner = Cleaner()
        cleaner.feed(raw)
        return "".join(out_parts)
    except Exception:
        from html import escape as _esc
        return _esc(raw).replace("\n", "<br/>")


def _build_panel_html(panel: dict, first_name: str = "{{first_name}}",
                       franchisee_email: str = "") -> str:
    """Render a single content section.

    Each section is now structured as:
      • Optional header (bold dark heading on its own row)
      • Image (optional, JPG/PNG/WebP)
      • Body text (rich-text intro — bold / italic / underline / colour
        / alignment) — substitutes ``{{first_name}}`` per recipient
      • Call-to-action button (optional). Two modes via ``link_type``:
          - ``"url"`` (default): button links to ``link_url``
          - ``"email"``: button is a ``mailto:`` to ``franchisee_email``
            with ``email_subject`` as the pre-filled subject line

    The ``layout`` option drives where the text sits in relation to
    the image:
      * ``"image-top"`` (default) — image above text
      * ``"image-left"``           — image left, text right
      * ``"image-right"``          — image right, text left

    Older campaigns stored the body text under ``intro`` and an
    optional caption under ``caption``. We keep reading both for
    backwards compatibility (caption is merged into the body text)
    but the new composer always writes to ``text_html``.
    """
    # Body text — accept new `text_html`, fall back to legacy `intro`,
    # and append legacy caption on its own line if present.
    raw_body = (panel.get("text_html") or panel.get("intro") or "").strip()
    legacy_caption = (panel.get("caption") or "").strip()
    if legacy_caption:
        raw_body = (raw_body + ("<br/>" if raw_body else "")
                    + f'<span style="font-style:italic;color:#525252;">{legacy_caption}</span>')
    text_html = _sanitise_intro_html(raw_body)
    if first_name and text_html:
        from html import escape as _esc
        text_html = text_html.replace("{{first_name}}", _esc(first_name))

    header_raw = (panel.get("header") or "").strip()
    image_url = (panel.get("image_url") or "").strip()
    link_type = (panel.get("link_type") or "url").lower()
    if link_type not in {"url", "email"}:
        link_type = "url"
    link_url = (panel.get("link_url") or "").strip()
    link_label = (panel.get("link_label") or "").strip() or (
        "Email me" if link_type == "email" else "Find out more"
    )
    email_subject = (panel.get("email_subject") or "I'd like more information please").strip()
    layout = (panel.get("layout") or "image-top").lower()
    if layout not in {"image-top", "image-left", "image-right"}:
        layout = "image-top"

    # Pre-render fragments
    from html import escape as _esc
    from urllib.parse import quote as _q
    header_block = ""
    if header_raw:
        header_block = (
            '<tr><td style="padding:18px 30px 6px 30px;'
            'font-family:Helvetica,Arial,sans-serif;font-size:20px;font-weight:800;'
            f'color:#1a1a1a;line-height:1.25;">{_esc(header_raw)}</td></tr>'
        )
    text_block = (
        f'<div style="font-size:15px;line-height:1.6;color:#1a1a1a;">{text_html}</div>'
        if text_html else ""
    )
    img_block = ""
    if image_url:
        img_block = (
            f'<img src="{image_url}" alt="" '
            'style="max-width:100%;height:auto;border-radius:8px;display:block;margin:0 auto;border:0;" />'
        )
    # CTA button — URL link or mailto: depending on link_type.
    link_block = ""
    if link_type == "email" and franchisee_email:
        href = f"mailto:{franchisee_email}?subject={_q(email_subject, safe='')}"
        link_block = (
            f'<a href="{href}" style="display:inline-block;background:#dddd16;color:#1a1a1a;'
            'font-weight:700;text-decoration:none;padding:13px 32px;border-radius:4px;'
            f'font-size:13px;letter-spacing:0.5px;margin:4px;">{_esc(link_label.upper())} &rsaquo;</a>'
        )
    elif link_type == "url" and link_url:
        link_block = (
            f'<a href="{link_url}" style="display:inline-block;background:#dddd16;color:#1a1a1a;'
            'font-weight:700;text-decoration:none;padding:13px 32px;border-radius:4px;'
            f'font-size:13px;letter-spacing:0.5px;margin:4px;">{_esc(link_label.upper())} &rsaquo;</a>'
        )

    if not (header_block or text_block or img_block or link_block):
        return ""

    # Stacked layout — image on top of text. Also used when no image
    # is present (side-by-side has nothing to lay out against).
    if layout == "image-top" or not image_url:
        rows: list[str] = []
        if header_block:
            rows.append(header_block)
        if img_block:
            rows.append(
                '<tr><td align="center" style="padding:8px 30px 6px 30px;">'
                f'{img_block}</td></tr>'
            )
        if text_block:
            rows.append(
                f'<tr><td style="padding:10px 30px 6px 30px;">{text_block}</td></tr>'
            )
        if link_block:
            rows.append(
                '<tr><td align="center" style="padding:6px 30px 18px 30px;">'
                f'{link_block}</td></tr>'
            )
        return "".join(rows)

    # Side-by-side layouts — nested <table> for Outlook compatibility.
    image_col = (
        '<td valign="top" align="center" width="45%" '
        f'style="padding:0 12px 0 0;width:45%;">{img_block}</td>'
    )
    # Text column carries the link inline so it visually belongs to
    # the panel even when the image hangs to the side.
    text_col_inner = "".join([
        text_block,
        (f'<div style="margin-top:10px;">{link_block}</div>' if link_block else ""),
    ])
    text_col = (
        '<td valign="top" width="55%" '
        'style="padding:0 0 0 12px;width:55%;font-size:15px;line-height:1.6;color:#1a1a1a;">'
        f'{text_col_inner}</td>'
    )
    if layout == "image-left":
        cols = image_col + text_col
    else:  # image-right
        cols = text_col + image_col
    body_row = (
        '<tr><td style="padding:10px 30px 14px 30px;">'
        '<table cellpadding="0" cellspacing="0" border="0" width="100%" '
        'style="width:100%;border-collapse:collapse;">'
        f'<tr>{cols}</tr>'
        '</table>'
        '</td></tr>'
    )
    return f"{header_block}{body_row}"


def _build_html(campaign: dict, first_name: str = "{{first_name}}",
                 unsubscribe_url: str = "") -> str:
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
    footer_instagram = (campaign.get("footer_instagram") or "").strip()
    footer_custom_url = (campaign.get("footer_custom_url") or "").strip()
    footer_custom_label = (campaign.get("footer_custom_label") or "Visit our website").strip()
    franchisee_address = (campaign.get("franchisee_address") or "").strip()
    # Email page background colour — picker on the composer. Defaults
    # to the existing soft-cream tone so existing/legacy drafts look
    # identical. Sanitised to hex/rgb/named — anything funky falls
    # back to default to keep dodgy CSS out of recipients' inboxes.
    bg_choice = (campaign.get("background_color") or "").strip()
    import re as _re
    if not _re.match(r"^(#[0-9a-fA-F]{3,8}|rgb\([^)]{1,40}\)|[a-zA-Z]{3,20})$", bg_choice or ""):
        bg_choice = "#f7f7f4"
    # Light-grey divider between Intro and each section + between
    # sections.
    divider = (
        '<tr><td style="padding:6px 30px 6px 30px;">'
        '<div style="height:0;border-top:1px solid #e5e5e5;margin:0;"></div>'
        '</td></tr>'
    )

    # ---- Top-level intro (above every section). Rendered as its own
    # row so it always sits above the first section regardless of how
    # the franchisee structures the sections themselves.
    intro_raw = (campaign.get("intro_html") or campaign.get("top_intro") or "").strip()
    intro_clean = _sanitise_intro_html(intro_raw)
    if first_name and intro_clean:
        from html import escape as _esc
        intro_clean = intro_clean.replace("{{first_name}}", _esc(first_name))
    intro_row = ""
    if intro_clean:
        intro_row = (
            '<tr><td style="padding:18px 30px 10px 30px;'
            'font-size:15px;line-height:1.6;color:#1a1a1a;">'
            f'{intro_clean}'
            '</td></tr>'
        )

    panel_html: list[str] = []
    franchisee_email_for_cta = (campaign.get("from_email") or "").strip()
    for i, p in enumerate(panels):
        rendered = _build_panel_html(
            p or {}, first_name=first_name,
            franchisee_email=franchisee_email_for_cta,
        )
        if not rendered:
            continue
        # Divider before EVERY section — including the first one when
        # there's a top-level intro above it.
        if panel_html or intro_row:
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
    if footer_instagram:
        contact_lines.append(
            f'<a href="{footer_instagram}" target="_blank" rel="noopener" '
            f'style="color:#1a1a1a;text-decoration:none;">Find us on Instagram</a>'
        )
    if footer_custom_url:
        from html import escape as _esc_lbl
        contact_lines.append(
            f'<a href="{footer_custom_url}" target="_blank" rel="noopener" '
            f'style="color:#1a1a1a;text-decoration:none;">{_esc_lbl(footer_custom_label)}</a>'
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
    # The one-click unsubscribe URL is signed per-recipient at send
    # time and routes through GET /api/u/{token} on the public site;
    # if it's missing (preview / test-send) we fall back to the older
    # "reply with UNSUBSCRIBE" copy.
    addr_line = f"{franchisee_address}<br/>" if franchisee_address else ""
    if unsubscribe_url:
        opt_out_line = (
            "You're receiving this because you're a Creative Mojo customer. "
            "Don't want any more? "
            f'<a href="{unsubscribe_url}" style="color:#999999;text-decoration:underline;">'
            'Unsubscribe with one click</a> — '
            "we'll remove you immediately."
        )
    else:
        opt_out_line = (
            "You're receiving this because you're a Creative Mojo customer."
            " To unsubscribe, simply reply to this email with"
            ' <em>UNSUBSCRIBE</em> in the subject line and we\'ll remove you'
            ' from our list immediately.'
        )
    compliance_block = (
        '<tr><td style="padding:18px 30px 24px 30px;font-size:11px;'
        'color:#999999;line-height:1.6;text-align:center;'
        'border-top:1px solid #eaeaea;">'
        f'Sent by <strong>{franchisee_name}</strong> &middot; {franchisee_org}<br/>'
        f'{addr_line}'
        f'{opt_out_line}'
        '</td></tr>'
    )

    return f"""<!doctype html>
<html><body style="margin:0;background:{bg_choice};font-family:Helvetica,Arial,sans-serif;">
<table cellpadding="0" cellspacing="0" border="0" width="100%" bgcolor="{bg_choice}" style="background:{bg_choice};">
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
      {intro_row}
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
            layout = (p.get("layout") or "image-top").lower()
            if layout not in {"image-top", "image-left", "image-right"}:
                layout = "image-top"
            link_type = (p.get("link_type") or "url").lower()
            if link_type not in {"url", "email"}:
                link_type = "url"
            cleaned = {
                # New shape: section header + rich text body
                "header":     (p.get("header") or "").strip()[:200],
                "text_html":  (p.get("text_html") or p.get("intro") or "").strip(),
                # ``intro`` retained for backwards-compat reads of
                # older drafts; the composer no longer writes to it.
                "intro":      (p.get("intro") or "").strip(),
                "image_url":  (p.get("image_url") or "").strip(),
                "image_key":  (p.get("image_key") or "").strip(),
                "caption":    (p.get("caption") or "").strip()[:400],
                "layout":     layout,
                "link_type":  link_type,
                "link_url":   (p.get("link_url") or "").strip(),
                "link_label": (p.get("link_label") or "").strip()
                              or ("Email me" if link_type == "email" else "Find out more"),
                # Pre-filled subject for the mailto: button when link_type=email.
                "email_subject": (p.get("email_subject") or "").strip()[:200],
            }
            # Skip totally-empty sections — the user probably added one
            # and forgot to fill it.
            has_link = (
                (cleaned["link_type"] == "url" and cleaned["link_url"]) or
                (cleaned["link_type"] == "email" and cleaned["email_subject"])
            )
            if (cleaned["header"] or cleaned["text_html"] or cleaned["image_url"]
                    or has_link or cleaned["caption"]):
                panels.append(cleaned)
    else:
        # Legacy shape → one-element array.
        legacy = {
            "header":     "",
            "text_html":  (body.get("intro") or "").strip(),
            "intro":      (body.get("intro") or "").strip(),
            "image_url":  (body.get("image_url") or "").strip(),
            "image_key":  (body.get("image_key") or "").strip(),
            "caption":    "",
            "layout":     "image-top",
            "link_url":   (body.get("link_url") or "").strip(),
            "link_label": (body.get("link_label") or "").strip() or "Find out more",
        }
        if legacy["text_html"] or legacy["image_url"] or legacy["link_url"]:
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
    ig_url = (marketing.get("instagram_url") or "").strip()
    custom_url = (marketing.get("custom_link_url") or "").strip()
    custom_label = (marketing.get("custom_link_label") or "").strip() or "Visit our website"
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
        "footer_instagram": ig_url if body.get("footer_show_instagram") else "",
        "footer_custom_url": custom_url if body.get("footer_show_custom") else "",
        "footer_custom_label": custom_label if body.get("footer_show_custom") else "",
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
                "instagram_url": marketing.get("instagram_url") or "",
                "custom_link_url": marketing.get("custom_link_url") or "",
                "custom_link_label": marketing.get("custom_link_label") or "",
                "last_footer_selection": marketing.get("last_footer_selection") or None,
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
            "instagram_url": m.get("instagram_url") or "",
            "custom_link_label": m.get("custom_link_label") or "",
            "custom_link_url": m.get("custom_link_url") or "",
            "mojo_page_url": m.get("mojo_page_url") or fr.get("wp_page_url") or "",
            # Read-only fields surfaced for the UI to render contextual
            # info next to each form input.
            "phone": fr.get("mobile_phone") or "",
            "email": fr.get("mojo_email") or "",
            # Last set of footer toggles the franchisee ticked on a
            # previous send. The compose modal pre-ticks these for new
            # campaigns so franchisees aren't re-selecting the same
            # boxes every time. ``None`` = never sent / no preference.
            "last_footer_selection": m.get("last_footer_selection") or None,
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
        if "instagram_url" in body:
            update["instagram_url"] = (body.get("instagram_url") or "").strip() or None
        if "custom_link_label" in body:
            update["custom_link_label"] = (body.get("custom_link_label") or "").strip() or None
        if "custom_link_url" in body:
            update["custom_link_url"] = (body.get("custom_link_url") or "").strip() or None
        if "mojo_page_url" in body:
            update["mojo_page_url"] = (body.get("mojo_page_url") or "").strip() or None
        # Persist back onto the franchisee doc so the rest of the app
        # (panels, /portal/me, etc.) keeps seeing the same source of truth.
        await db.franchisees.update_one(
            {"id": fr["id"]},
            {"$set": {"marketing_settings": update, "updated_at": _now_iso()}},
        )
        return {"ok": True, "marketing_settings": update}

    # ============================================================
    # ---- One-click unsubscribe (public — no auth)
    # ============================================================
    # Embedded as ``GET /api/u/{token}`` in every campaign footer +
    # ``List-Unsubscribe`` header so recipients can opt out with a
    # single click. Token is HMAC-signed (itsdangerous) so we don't
    # need a DB lookup to verify legitimacy.
    async def _apply_unsubscribe(data: dict, source: str) -> tuple[bool, str]:
        fid = data.get("f")
        cid = data.get("c")
        idx = int(data.get("i", -1))
        email = (data.get("e") or "").lower()
        client = await db.franchisee_clients.find_one(
            {"id": cid, "franchisee_id": fid}, {"_id": 0},
        )
        if not client:
            return False, email
        now = _now_iso()
        if idx == -1:
            # Primary email — flag it on the parent doc rather than
            # bin the email value so the franchisee can still see
            # who/what this row represents.
            await db.franchisee_clients.update_one(
                {"id": cid, "franchisee_id": fid},
                {"$set": {
                    "primary_marketing_unsubscribed": True,
                    "primary_marketing_unsubscribed_at": now,
                    "primary_marketing_unsubscribed_source": source,
                }},
            )
        else:
            # Per-contact array path. Positional update via dot-notation.
            await db.franchisee_clients.update_one(
                {"id": cid, "franchisee_id": fid},
                {"$set": {
                    f"contacts.{idx}.marketing_unsubscribed": True,
                    f"contacts.{idx}.marketing_unsubscribed_at": now,
                    f"contacts.{idx}.marketing_unsubscribed_source": source,
                }},
            )
        return True, email

    def _unsubscribe_page(email: str, ok: bool) -> str:
        """Tiny branded confirmation page — no franchisee identifiers
        exposed to keep the unsubscribe flow neutral for the
        recipient. Matches the email's brand tone (lime accent)."""
        if ok:
            heading = "You've been unsubscribed"
            body = (
                f"<p>We've removed <strong>{(email or 'your email address')}</strong> "
                "from this Creative Mojo franchisee's marketing list.</p>"
                "<p>You won't receive any more marketing emails from them. If "
                "you change your mind later, just reply to one of the previous "
                "messages and ask to be re-added.</p>"
            )
        else:
            heading = "This unsubscribe link is invalid"
            body = (
                "<p>The link you clicked has expired or been tampered with. "
                "If you're still receiving emails you'd like to stop, reply to "
                "any one of them with <em>UNSUBSCRIBE</em> in the subject line "
                "and we'll remove you immediately.</p>"
            )
        return f"""<!doctype html>
<html><head><meta charset="utf-8"><title>Unsubscribed · Creative Mojo</title>
<style>
  body{{margin:0;background:#f7f7f4;font-family:Helvetica,Arial,sans-serif;color:#1a1a1a;}}
  .card{{max-width:520px;margin:80px auto;background:#fff;border:1px solid #ececec;
        padding:40px 36px;border-radius:12px;text-align:center;}}
  h1{{font-size:24px;font-weight:800;margin:8px 0 16px;}}
  p{{font-size:15px;line-height:1.6;color:#3a3a3a;margin:10px 0;}}
  .dot{{width:48px;height:48px;border-radius:50%;background:#dddd16;
       display:inline-flex;align-items:center;justify-content:center;
       font-size:22px;font-weight:800;color:#1a1a1a;}}
</style></head>
<body><div class="card">
  <span class="dot">{('✓' if ok else '!')}</span>
  <h1>{heading}</h1>
  {body}
  <p style="margin-top:24px;font-size:12px;color:#999;">Creative Mojo</p>
</div></body></html>"""

    @api.get("/u/{token}", response_class=HTMLResponse)
    async def unsubscribe_get(token: str):
        """Click-through unsubscribe. Some mail clients pre-fetch
        links (link warming, anti-phishing scanners) so we
        deliberately keep this GET idempotent: it ALWAYS marks the
        recipient unsubscribed when the token is valid, but never
        errors on repeat clicks."""
        data = _verify_unsubscribe_token(token)
        if not data:
            return HTMLResponse(_unsubscribe_page("", False), status_code=400)
        ok, email = await _apply_unsubscribe(data, source="recipient")
        return HTMLResponse(_unsubscribe_page(email, ok))

    @api.post("/u/{token}")
    async def unsubscribe_post(token: str):
        """One-click POST per RFC 8058 — the path Gmail/Outlook hit
        when the user clicks the native unsubscribe affordance. Same
        action as the GET, returns 204 No Content as the spec asks."""
        data = _verify_unsubscribe_token(token)
        if not data:
            raise HTTPException(400, detail="Invalid or expired token")
        await _apply_unsubscribe(data, source="recipient")
        return {"ok": True}

    # ============================================================
    # ---- Franchisee-facing unsubscribe management (authenticated)
    # ============================================================
    @api.post("/portal/marketing/clients/{client_id}/unsubscribe")
    async def franchisee_set_unsubscribed(
        client_id: str,
        body: dict,
        user: dict = Depends(require_role("franchisee")),
    ):
        """Franchisee manually toggles a contact's unsubscribed flag —
        used when somebody replies asking to be removed and the
        franchisee wants to honour it without round-tripping the
        recipient through the one-click link.

        Body shape: ``{"contact_index": int, "unsubscribed": bool}``
        where ``contact_index`` is -1 for the primary email row.
        """
        fr = await _check_access(db, user)
        try:
            contact_index = int(body.get("contact_index", -1))
        except (TypeError, ValueError):
            raise HTTPException(400, detail="contact_index must be an integer")
        unsubscribed = bool(body.get("unsubscribed", True))
        client = await db.franchisee_clients.find_one(
            {"id": client_id, "franchisee_id": fr["id"]}, {"_id": 0},
        )
        if not client:
            raise HTTPException(404, detail="Client not found")
        now = _now_iso()
        if contact_index == -1:
            update = {
                "primary_marketing_unsubscribed": unsubscribed,
                "primary_marketing_unsubscribed_at": now if unsubscribed else None,
                "primary_marketing_unsubscribed_source": "franchisee" if unsubscribed else None,
            }
        else:
            n = len(client.get("contacts") or [])
            if not (0 <= contact_index < n):
                raise HTTPException(400, detail="contact_index out of range")
            update = {
                f"contacts.{contact_index}.marketing_unsubscribed": unsubscribed,
                f"contacts.{contact_index}.marketing_unsubscribed_at": now if unsubscribed else None,
                f"contacts.{contact_index}.marketing_unsubscribed_source": "franchisee" if unsubscribed else None,
            }
        await db.franchisee_clients.update_one(
            {"id": client_id, "franchisee_id": fr["id"]}, {"$set": update},
        )
        return {"ok": True, "contact_index": contact_index, "unsubscribed": unsubscribed}

    # ---- recipients (Territory+ clients with at least one email)
    @api.get("/portal/marketing/recipients")
    async def list_recipients(user: dict = Depends(require_role("franchisee"))):
        fr = await _check_access(db, user)
        out: list[dict] = []
        async for c in db.franchisee_clients.find(
            {"franchisee_id": fr["id"]}, {"_id": 0},
        ).sort("name", 1):
            # Primary email row (from the client's manager / generic inbox).
            # Hide if this primary contact has been unsubscribed (per-
            # contact granularity — other contacts on the same client
            # row are unaffected).
            primary_unsub = bool(c.get("primary_marketing_unsubscribed"))
            if c.get("email") and not primary_unsub and c.get("manager_include_for_marketing", True):
                out.append({
                    "client_id": c["id"],
                    "contact_index": -1,
                    "name": c.get("manager") or c.get("name") or "Manager",
                    "role": "Primary",
                    "organisation": c.get("name"),
                    "email": c.get("email"),
                    "phone": c.get("phone"),
                })
            # Each secondary contact that has an email AND hasn't
            # individually unsubscribed AND has been ticked for marketing.
            for idx, ct in enumerate(c.get("contacts") or []):
                if (ct and ct.get("email")
                        and not ct.get("marketing_unsubscribed")
                        and ct.get("include_for_marketing", True)):
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
            # New top-level intro + background colour.
            "intro_html": body.get("intro_html") or "",
            "background_color": body.get("background_color") or "",
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
            # Used by the "Email me" button mode to render a working
            # mailto: link in the preview iframe.
            "from_email": (fr.get("mojo_email") or fr.get("email") or "").strip(),
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
            "intro_html": body.get("intro_html") or "",
            "background_color": body.get("background_color") or "",
            "intro": body.get("intro") or "",
            "image_url": body.get("image_url") or "",
            "link_url": body.get("link_url") or "",
            "link_label": body.get("link_label") or "Find out more",
            "bookings_url": body.get("bookings_url") or "",
            "franchisee_name": f"{fr.get('first_name','')} {fr.get('last_name','')}".strip()
                               or fr.get("organisation") or "Creative Mojo",
            "franchisee_organisation": fr.get("organisation") or "Creative Mojo",
            # The "Email me" CTA button uses this as the mailto: target.
            "from_email": from_email,
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
                if client.get("primary_marketing_unsubscribed"):
                    continue
                email = (client.get("email") or "").strip()
                first_name = (client.get("manager") or client.get("name") or "there").split(" ", 1)[0]
                role = "Primary"
            else:
                ct = (client.get("contacts") or [])[contact_index] if 0 <= contact_index < len(client.get("contacts") or []) else None
                if not ct or ct.get("marketing_unsubscribed"):
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
            # New top-level intro + bg colour, persisted with the
            # campaign so reports and re-sends render identically.
            "intro_html": (body.get("intro_html") or "").strip(),
            "background_color": (body.get("background_color") or "").strip(),
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
            "footer_show_instagram": bool(body.get("footer_show_instagram")),
            "footer_show_custom": bool(body.get("footer_show_custom")),
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
        # Public base URL for the one-click unsubscribe link. Same
        # priority order as bookings (request → body origin → default).
        unsubscribe_base = base.rstrip("/")
        for r in resolved:
            send_id = str(uuid.uuid4())
            # Per-recipient signed token → /api/u/{token} on the public
            # site. Recipient clicks once, no DB lookup needed to
            # verify, and we tag the exact contact_index so multi-
            # contact clients only kill the right subscription.
            unsub_token = _mint_unsubscribe_token(
                fr["id"], r["client_id"], r.get("contact_index", -1), r["email"],
            )
            unsub_url = f"{unsubscribe_base}/api/u/{unsub_token}"
            html = _build_html(campaign_doc, first_name=r["first_name"],
                               unsubscribe_url=unsub_url)
            try:
                resp = await asyncio.to_thread(_resend.Emails.send, {
                    "from": f"{sender_name} <{from_email}>",
                    "to": [r["email"]],
                    "reply_to": from_email,
                    "subject": title,
                    "html": html,
                    "headers": {
                        "X-CM-Send-Id": send_id,
                        # RFC 2369 + RFC 8058 — Gmail / Outlook surface
                        # a native "Unsubscribe" affordance at the top
                        # of the message when both headers are present.
                        # This also helps deliverability (carriers
                        # actively prefer senders that support one-click).
                        "List-Unsubscribe": f"<{unsub_url}>",
                        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
                    },
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
        # Persist the franchisee's last footer selection so the compose
        # modal can pre-tick the same boxes next time. Saved only when
        # the send actually went out (so an aborted send doesn't
        # mutate the remembered choice).
        if succeeded > 0:
            try:
                marketing = (fr.get("marketing_settings") or {})
                marketing["last_footer_selection"] = {
                    "phone": bool(body.get("footer_show_phone")),
                    "email": bool(body.get("footer_show_email")),
                    "facebook": bool(body.get("footer_show_facebook")),
                    "instagram": bool(body.get("footer_show_instagram")),
                    "custom": bool(body.get("footer_show_custom")),
                }
                await db.franchisees.update_one(
                    {"id": fr["id"]},
                    {"$set": {"marketing_settings": marketing, "updated_at": _now_iso()}},
                )
            except Exception:
                logger.warning("Failed to persist last_footer_selection", exc_info=True)
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
            # New top-level intro + bg colour, kept across save→reload.
            "intro_html": (body.get("intro_html") or "").strip(),
            "background_color": (body.get("background_color") or "").strip(),
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
            {"franchisee_id": fr["id"], "is_template": {"$ne": True}}, {"_id": 0},
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

    # ---- duplicate any campaign (draft, sent or template) into a new draft.
    # The new doc gets a fresh id, status="draft", and the original's
    # recipients / delivery / send-events are stripped — we only carry
    # over the editorial content the franchisee actually composed.
    @api.post("/portal/marketing/campaigns/{campaign_id}/duplicate")
    async def duplicate_campaign(
        campaign_id: str, user: dict = Depends(require_role("franchisee")),
    ):
        fr = await _check_access(db, user)
        src = await db.marketing_campaigns.find_one(
            {"id": campaign_id, "franchisee_id": fr["id"]}, {"_id": 0},
        )
        if not src:
            raise HTTPException(404, detail="Campaign not found")
        new_id = str(uuid.uuid4())
        now = _now_iso()
        base_title = (src.get("title") or "").strip() or "Untitled"
        new_doc = {
            "id": new_id,
            "franchisee_id": fr["id"],
            "status": "draft",
            "is_template": False,
            "title": f"Copy of {base_title}",
            "panels": src.get("panels") or [],
            "intro_html": src.get("intro_html") or "",
            "background_color": src.get("background_color") or "",
            "intro": src.get("intro") or "",
            "image_url": src.get("image_url") or "",
            "image_key": src.get("image_key") or "",
            "link_url": src.get("link_url") or "",
            "link_label": src.get("link_label") or "Find out more",
            "include_bookings_link": bool(src.get("include_bookings_link")),
            "footer_show_phone": bool(src.get("footer_show_phone")),
            "footer_show_email": bool(src.get("footer_show_email")),
            "footer_show_facebook": bool(src.get("footer_show_facebook")),
            "footer_show_instagram": bool(src.get("footer_show_instagram")),
            "footer_show_custom": bool(src.get("footer_show_custom")),
            "franchisee_name": src.get("franchisee_name") or "",
            "franchisee_organisation": src.get("franchisee_organisation") or "",
            "created_at": now,
            "updated_at": now,
            "created_by": user.get("email"),
            "recipients": [],
            "delivery": {"status": "draft", "succeeded": 0, "failed": 0, "errors": []},
        }
        await db.marketing_campaigns.insert_one(new_doc)
        return {"ok": True, "id": new_id, "status": "draft"}

    # ---- save an existing campaign as a reusable template. Idempotent:
    # if a template with this title already exists for the franchisee we
    # update it in place; otherwise insert a new doc.
    @api.post("/portal/marketing/campaigns/{campaign_id}/save-as-template")
    async def save_as_template(
        campaign_id: str,
        body: dict | None = None,
        user: dict = Depends(require_role("franchisee")),
    ):
        body = body or {}
        fr = await _check_access(db, user)
        src = await db.marketing_campaigns.find_one(
            {"id": campaign_id, "franchisee_id": fr["id"]}, {"_id": 0},
        )
        if not src:
            raise HTTPException(404, detail="Campaign not found")
        template_name = (body.get("template_name") or src.get("title") or "Untitled template").strip()
        template_id = str(uuid.uuid4())
        now = _now_iso()
        template_doc = {
            "id": template_id,
            "franchisee_id": fr["id"],
            "status": "template",
            "is_template": True,
            "template_name": template_name,
            "title": template_name,
            "panels": src.get("panels") or [],
            "intro_html": src.get("intro_html") or "",
            "background_color": src.get("background_color") or "",
            "include_bookings_link": bool(src.get("include_bookings_link")),
            "footer_show_phone": bool(src.get("footer_show_phone")),
            "footer_show_email": bool(src.get("footer_show_email")),
            "footer_show_facebook": bool(src.get("footer_show_facebook")),
            "footer_show_instagram": bool(src.get("footer_show_instagram")),
            "footer_show_custom": bool(src.get("footer_show_custom")),
            "created_at": now,
            "updated_at": now,
            "created_by": user.get("email"),
        }
        await db.marketing_campaigns.insert_one(template_doc)
        return {"ok": True, "id": template_id}

    # ---- delete a template
    @api.delete("/portal/marketing/templates/{template_id}")
    async def delete_template(template_id: str, user: dict = Depends(require_role("franchisee"))):
        fr = await _check_access(db, user)
        r = await db.marketing_campaigns.delete_one(
            {"id": template_id, "franchisee_id": fr["id"], "is_template": True},
        )
        if not r.deleted_count:
            raise HTTPException(404, detail="Template not found")
        return {"ok": True}

    # ---- list templates (separate from the main campaigns list)
    @api.get("/portal/marketing/templates")
    async def list_templates(user: dict = Depends(require_role("franchisee"))):
        fr = await _check_access(db, user)
        items: list[dict] = []
        async for doc in db.marketing_campaigns.find(
            {"franchisee_id": fr["id"], "is_template": True}, {"_id": 0},
        ).sort("created_at", -1).limit(50):
            items.append(doc)
        return {"items": items, "total": len(items)}

    # ---- ADMIN AUDIT LOG ---------------------------------------------
    # Surfaces every campaign across every franchisee — admin-only.
    # Builds franchisee_name in-process via a small in-memory map so we
    # don't N+1 query Mongo. Sorted by sent_at desc, defaults to drafts
    # excluded but exposes a ?include_drafts=true flag if HQ ever wants
    # to see who's mid-compose.
    @api.get("/admin/marketing/log")
    async def admin_marketing_log(
        limit: int = 500,
        include_drafts: bool = False,
        _: dict = Depends(require_role("admin")),
    ):
        fr_by_id: dict[str, dict] = {}
        async for f in db.franchisees.find(
            {}, {"_id": 0, "id": 1, "first_name": 1, "last_name": 1, "organisation": 1, "email": 1},
        ):
            fr_by_id[f["id"]] = f
        query: dict = {} if include_drafts else {"status": {"$ne": "draft"}}
        items: list[dict] = []
        async for c in db.marketing_campaigns.find(query, {"_id": 0}) \
                .sort([("sent_at", -1), ("created_at", -1)]).limit(limit):
            fr = fr_by_id.get(c.get("franchisee_id")) or {}
            full_name = (
                f"{fr.get('first_name') or ''} {fr.get('last_name') or ''}".strip()
                or fr.get("organisation") or c.get("franchisee_name") or "—"
            )
            recipients = c.get("recipients") or []
            delivery = c.get("delivery") or {}
            opens = sum(1 for r in recipients if (r.get("last_event") or "") in {"email.opened", "email.clicked"})
            clicks = sum(1 for r in recipients if (r.get("last_event") or "") == "email.clicked")
            items.append({
                "id": c.get("id"),
                "franchisee_id": c.get("franchisee_id"),
                "franchisee_name": full_name,
                "franchisee_email": fr.get("email") or c.get("from_email"),
                "title": c.get("title"),
                "status": c.get("status") or "draft",
                "sent_at": c.get("sent_at"),
                "created_at": c.get("created_at"),
                "recipient_count": len(recipients),
                "delivered": int(delivery.get("succeeded") or 0),
                "failed": int(delivery.get("failed") or 0),
                "opens": opens,
                "clicks": clicks,
            })
        total = await db.marketing_campaigns.count_documents(query)
        return {"items": items, "returned": len(items), "total": total}

    # ---- webhook fan-out: called by ``resend_routes`` via the
    # module-level ``apply_event`` function defined above. Nothing to
    # register on the router itself.
    return None
