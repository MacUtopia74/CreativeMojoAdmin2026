"""Announcements / Updates system — Phase 6.

Admin composes an "Update" (title + intro + N panels referencing files or
folders + thumbnail + link), picks which franchisees to send to (default
all active), and we email them via Resend in branded Creative Mojo
template. Each announcement is then archived to ``announcements`` and
visible to recipients at ``/portal/updates`` so they can refer back.

The email template uses absolute https URLs everywhere so Gmail/Outlook
render images without warnings. Thumbnails come from the
``thumbnail_key`` (an R2 object) which we wrap with our own
``/api/files/announcement-thumb/{key}`` proxy that always issues a fresh
signed URL — no rotating presigned URLs in the email body.

Lifetime decision: we only ever send the link a recipient sees once.
File / folder share tokens are created at *send* time with
``days=0 (lifetime)`` so the email never rots.
"""
from __future__ import annotations

import logging
import os
import secrets
import uuid
from datetime import datetime, timezone, timedelta, date as date_cls
# date.fromisoformat — pulled out for clarity since we use it just for
# input validation on `pinned_until`.
date_fromisoformat = date_cls.fromisoformat
from typing import Optional

from fastapi import Depends, HTTPException, UploadFile, File, Request

logger = logging.getLogger("creative-mojo-admin.announcements")

LOGO_URL = "https://hub.creativemojo.co.uk/brand/creative-mojo-logo.png"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _frontend_base(request: Request | None = None, body_origin: str = "") -> str:
    """Resolve the public base URL for the share-link viewer.

    Priority:
      1. ``body_origin`` — the composer sends ``window.location.origin``
         in the request body. Browser-truth, no proxy rewriting.
      2. ``Origin`` header (skipped if it's the internal Kubernetes
         ingress host — the preview ingress rewrites Origin to
         ``cluster-X.preview.emergentcf.cloud`` which is not reachable
         from outside).
      3. ``Referer`` header.
      4. ``FRONTEND_URL`` env var.
    """
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


async def _resolve_link_for_panel(db, panel: dict, request: Request | None = None, body_origin: str = "") -> tuple[str, Optional[str]]:
    """Mint a permanent (lifetime) share URL for the panel's target and
    return (file_url, thumbnail_url). For folder panels the thumbnail
    falls back to whatever the admin provided (we don't try to auto-pick).

    Each panel is either a single file (``kind=file``, ``key=...``) or a
    folder (``kind=folder``, ``prefix=...``). We always create a fresh
    token so revoking an old announcement's links doesn't break a new
    one. URLs point at our backend's share resolver which 302s to a
    freshly signed R2 URL — so the URL embedded in the recipient's
    email never goes stale.
    """
    base = _frontend_base(request, body_origin)
    if panel.get("kind") == "folder":
        prefix = (panel.get("prefix") or "").strip("/")
        if not prefix:
            return base, None
        # Normalise to trailing slash so the file-count regex matches.
        prefix_pfx = prefix + "/"
        token = secrets.token_urlsafe(18)
        # Compute file_count so the public viewer can show "+ N files".
        import re as _re
        file_count = await db.files_index.count_documents({
            "key": {"$regex": f"^{_re.escape(prefix_pfx)}"},
            "hidden": {"$ne": True},
        })
        leaf = prefix.rstrip("/").rsplit("/", 1)[-1] or prefix.rstrip("/")
        # IMPORTANT: must live in the SAME collection (`files_share_links`)
        # and use `kind: "folder"` so the public resolver finds it. An
        # earlier version of this code wrote to a separate
        # `folder_share_links` collection — those links 404'd.
        await db.files_share_links.insert_one({
            "token": token,
            "kind": "folder",
            "prefix": prefix_pfx,
            "label": leaf.replace("-", " "),
            "file_count": file_count,
            "expires_at": None,
            "lifetime": True,
            "revoked": False,
            "created_at": _now_iso(),
            "created_by": "announcement",
            "hits": 0,
        })
        return f"{base}/share/folder/{token}", None
    # File panel
    key = panel.get("key")
    if not key:
        return base, None
    existing = await db.files_index.find_one({"key": key}, {"_id": 0, "name": 1})
    if not existing:
        return base, None
    token = secrets.token_urlsafe(18)
    await db.files_share_links.insert_one({
        "token": token,
        "key": key,
        "filename": existing.get("name"),
        "expires_at": None,
        "lifetime": True,
        "revoked": False,
        "created_at": _now_iso(),
        "created_by": "announcement",
        "hits": 0,
    })
    file_url = f"{base}/api/files/share/{token}"
    # Best-effort permanent thumbnail URL — backend will 415 if the file
    # type doesn't support thumbnails, in which case admin's manually
    # supplied thumbnail_url wins.
    thumb_url = f"{base}/api/files/share/{token}/thumb?size=md"
    return file_url, thumb_url


async def _public_thumb_url_for_key(db, key: str, request: Request | None = None, body_origin: str = "") -> Optional[str]:
    """Mint a lifetime share token for ``key`` and return the public
    ``/api/files/share/{token}/thumb?size=md`` URL. Used when admin
    picks a custom thumbnail file for a panel (typically for folder
    panels where there's no obvious auto-thumbnail).
    """
    existing = await db.files_index.find_one({"key": key}, {"_id": 0, "name": 1})
    if not existing:
        return None
    token = secrets.token_urlsafe(18)
    await db.files_share_links.insert_one({
        "token": token,
        "key": key,
        "filename": existing.get("name"),
        "expires_at": None,
        "lifetime": True,
        "revoked": False,
        "created_at": _now_iso(),
        "created_by": "announcement-thumb",
        "hits": 0,
    })
    return f"{_frontend_base(request, body_origin)}/api/files/share/{token}/thumb?size=md"


async def _thumb_base64_for_key(db, key: str) -> Optional[str]:
    """Return a ``data:image/jpeg;base64,...`` URI for the given R2 key,
    or ``None`` if the file isn't thumbnail-eligible. Used by:
      • Live preview HTML (iframe can't carry our Bearer header).
      • Admin-picked folder thumbnails (``thumbnail_key`` on the panel).
    """
    from thumbnail_service import get_cached_thumbnail, build_thumbnail
    import base64
    import anyio
    existing = await db.files_index.find_one(
        {"key": key}, {"_id": 0, "content_type": 1, "name": 1},
    )
    if not existing:
        return None
    ct = (existing.get("content_type") or "").lower()
    ext = (existing.get("name") or "").rsplit(".", 1)[-1].lower()
    if not (ct.startswith("image/") or ct == "application/pdf"
            or ext in {"jpg", "jpeg", "png", "gif", "webp", "heic", "pdf"}):
        return None
    data = get_cached_thumbnail(key, "md")
    if not data:
        try:
            data = await anyio.to_thread.run_sync(
                build_thumbnail, key, "md", existing.get("content_type"),
            )
        except Exception:  # noqa: BLE001
            return None
    if not data:
        return None
    return "data:image/jpeg;base64," + base64.b64encode(data).decode("ascii")


def _build_html(announcement: dict) -> str:
    """Branded HTML email. Mirrors the user-supplied example:
    Creative Mojo logo header → yellow title banner → intro text → list
    of panels (thumbnail left, name + blurb + button right) →
    Creative Mojo footer.
    """
    panels_html: list[str] = []
    for idx, p in enumerate(announcement.get("panels", [])):
        thumb = p.get("thumbnail_url") or ""
        title = p.get("title") or ""
        blurb = (p.get("blurb") or "").replace("\n", "<br/>")
        href = p.get("resolved_url") or "#"
        # Separator: 0.5pt grey horizontal keyline between subsequent
        # panels (first panel uses the green keyline above the table for
        # separation, so no top border here).
        sep_style = ("border-top:1px solid #d4d4d4;padding:28px 0;"
                     if idx > 0 else "padding:0 0 28px 0;")
        thumb_html = (
            f'<img src="{thumb}" alt="{title}" width="320" '
            'style="max-width:100%;height:auto;border-radius:8px;display:block;margin:0 auto 18px auto;" />'
        ) if thumb else ""
        # Order: TITLE → THUMBNAIL → BLURB → BUTTON
        panels_html.append(f"""
<tr><td align="center" style="{sep_style}">
  <div style="font-size:22px;font-weight:700;color:#1a1a1a;line-height:1.25;margin:0 auto 18px auto;text-align:center;max-width:480px;word-wrap:break-word;">{title}</div>
  {thumb_html}
  {('<div style="font-size:14px;line-height:1.6;color:#666666;margin:0 auto 16px auto;text-align:center;max-width:480px;">' + blurb + '</div>') if blurb else ''}
  <a href="{href}" style="display:inline-block;background:#dddd16;color:#1a1a1a;font-weight:700;text-decoration:none;padding:11px 26px;border-radius:4px;font-size:13px;letter-spacing:0.5px;">OPEN {('FOLDER' if p.get('kind')=='folder' else 'FILE')} &rsaquo;</a>
</td></tr>
""")
    intro_html = (announcement.get("intro") or "").replace("\n", "<br/>")
    return f"""
<!doctype html>
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
          {announcement.get('title','')}
        </div>
      </td></tr>
      <tr><td style="padding:14px 30px 0;font-size:15px;line-height:1.6;color:#1a1a1a;">
        <div>Hi <strong>{{{{first_name}}}}</strong>,</div>
        <div style="margin-top:10px;">{intro_html}</div>
      </td></tr>
      <tr><td style="padding:30px 30px 30px 30px;">
        <div style="height:0;border-top:1px solid #dddd16;margin:0;"></div>
      </td></tr>
      <tr><td style="padding:0 30px 30px 30px;">
        <table cellpadding="0" cellspacing="0" border="0" width="100%">{''.join(panels_html)}</table>
      </td></tr>
      <tr><td style="padding:30px;font-size:11px;color:#999999;line-height:1.5;text-align:center;border-top:1px solid #eaeaea;">
        Creative Mojo Ltd · Channings, Brithem Bottom, Cullompton, Devon EX15 1NB<br/>
        This update is for franchisees only. Please don't forward externally.
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>
"""


def attach(api, db, require_role):

    @api.post("/admin/announcements/upload-thumbnail")
    async def upload_thumbnail(
        file: UploadFile = File(...),
        user: dict = Depends(require_role("admin")),
    ):
        """Direct-from-computer thumbnail upload. Stores the image under
        the dedicated R2 prefix ``shared/_announcement_thumbs/{uuid}.ext``
        and registers it in ``files_index`` so the same downstream pipeline
        (cached thumbnail builder + public share-token URL) works without
        a special case. Returns ``{ "key": str, "name": str }`` — the
        composer then sets ``thumbnail_key`` on the panel.
        """
        from file_storage import r2_configured, get_client, R2_BUCKET, SCOPE_SHARED
        if not r2_configured():
            raise HTTPException(503, detail="R2 not configured")
        ct = (file.content_type or "").lower()
        ext = (file.filename or "").rsplit(".", 1)[-1].lower() if "." in (file.filename or "") else ""
        if not (ct.startswith("image/") or ext in {"jpg", "jpeg", "png", "gif", "webp", "heic"}):
            raise HTTPException(415, detail="Only image files are supported")
        if not ext:
            ext = (ct.split("/")[-1] if "/" in ct else "jpg")
        # Read body & cap at 20MB
        data = await file.read()
        if len(data) > 20 * 1024 * 1024:
            raise HTTPException(413, detail="Thumbnail must be ≤ 20 MB")
        new_id = uuid.uuid4().hex[:12]
        safe_name = f"{new_id}.{ext}"
        key = f"shared/_announcement_thumbs/{safe_name}"
        client = get_client()
        client.put_object(
            Bucket=R2_BUCKET, Key=key, Body=data,
            ContentType=ct or f"image/{ext}",
        )
        await db.files_index.insert_one({
            "key": key,
            "name": file.filename or safe_name,
            "size": len(data),
            "content_type": ct or f"image/{ext}",
            "scope": SCOPE_SHARED,
            "uploaded_at": _now_iso(),
            "uploaded_by": user.get("email"),
        })
        return {"key": key, "name": file.filename or safe_name, "size": len(data)}

    @api.get("/admin/announcements/recipients")
    async def list_recipients(_: dict = Depends(require_role("admin"))):
        """Active franchisees with usable emails — pre-checked default
        for the composer's recipient picker."""
        items: list[dict] = []
        async for f in db.franchisees.find(
            {},
            {"_id": 0, "id": 1, "first_name": 1, "last_name": 1, "organisation": 1,
             "mojo_email": 1, "secondary_email": 1, "tags": 1},
        ):
            email = (f.get("mojo_email") or f.get("secondary_email") or "").strip()
            if not email:
                continue
            is_ex = any("ex" in str(t).lower() and "franchisee" in str(t).lower()
                        for t in (f.get("tags") or []))
            if is_ex:
                continue
            items.append({
                "id": f.get("id"),
                "first_name": f.get("first_name") or "",
                "last_name": f.get("last_name") or "",
                "organisation": f.get("organisation") or "",
                "email": email,
            })
        items.sort(key=lambda r: (r.get("organisation") or "").lower())
        return {"items": items, "total": len(items)}

    @api.post("/admin/announcements/preview-html")
    async def preview_html(body: dict, _: dict = Depends(require_role("admin"))):
        """Build the rendered HTML for the composer right-pane preview.
        Doesn't write to the DB or mint share tokens — it just substitutes
        the in-flight panel data into the template the real send uses.

        Thumbnails are inlined as base64 ``data:`` URIs so the iframe
        preview shows the real image without needing the auth cookie/
        header. Resolution order per panel:
          1. ``thumbnail_url`` provided by the composer (already a URL).
          2. ``thumbnail_key`` — admin picked any R2 file as the thumbnail
             (works for both file AND folder panels).
          3. File panels only: auto-derived from the panel's own ``key``.
          4. SVG placeholder so the layout doesn't shift.
        """
        panels = list(body.get("panels") or [])
        for p in panels:
            p.setdefault("resolved_url", "#")
            if p.get("thumbnail_url"):
                continue
            # 1. Explicit admin pick
            tk = p.get("thumbnail_key")
            if tk:
                b64 = await _thumb_base64_for_key(db, tk)
                if b64:
                    p["thumbnail_url"] = b64
                    continue
            # 2. Auto-derive for file panels
            if p.get("kind") == "file" and p.get("key"):
                b64 = await _thumb_base64_for_key(db, p["key"])
                if b64:
                    p["thumbnail_url"] = b64
                    continue
            # 3. Placeholder
            p["thumbnail_url"] = ("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20"
                                   "width%3D%22320%22%20height%3D%22200%22%3E%3Crect%20width%3D%22100%25%22%20"
                                   "height%3D%22100%25%22%20fill%3D%22%23f0f0eb%22%2F%3E%3Ctext%20x%3D%2250%25%22%20"
                                   "y%3D%2250%25%22%20fill%3D%22%23999999%22%20font-family%3D%22sans-serif%22%20"
                                   "font-size%3D%2213%22%20text-anchor%3D%22middle%22%20dominant-baseline%3D%22middle%22%3E"
                                   "Pick%20a%20thumbnail%3C%2Ftext%3E%3C%2Fsvg%3E")
        sample = {
            "title": body.get("title") or "(no subject yet)",
            "intro": body.get("intro") or "",
            "panels": panels,
        }
        html = _build_html(sample).replace("{{first_name}}", body.get("sample_first_name") or "Friend")
        return {"html": html}

    @api.post("/admin/announcements/test-send")
    async def test_send(body: dict, request: Request, user: dict = Depends(require_role("admin"))):
        """Send a one-off test copy of the in-flight announcement to the
        admin (or a custom email if provided). Mints lifetime share tokens
        so the buttons actually work, but does NOT archive the
        announcement to ``announcements`` — purely for proofreading.
        """
        title = (body.get("title") or "").strip() or "(test) Announcement preview"
        intro = body.get("intro") or ""
        panels = body.get("panels") or []
        body_origin = body.get("frontend_origin") or ""
        if not isinstance(panels, list):
            raise HTTPException(400, "panels must be a list")
        for p in panels:
            file_url, auto_thumb = await _resolve_link_for_panel(db, p, request, body_origin)
            p["resolved_url"] = file_url
            # Admin-picked thumbnail trumps everything else.
            if p.get("thumbnail_key") and not p.get("thumbnail_url"):
                tk_url = await _public_thumb_url_for_key(db, p["thumbnail_key"], request, body_origin)
                if tk_url:
                    p["thumbnail_url"] = tk_url
            if auto_thumb and not p.get("thumbnail_url"):
                p["thumbnail_url"] = auto_thumb
        to = (body.get("to") or user.get("email") or "").strip()
        if not to:
            raise HTTPException(400, "No recipient email available")
        from resend_routes import (
            RESEND_API_KEY, RESEND_FROM_EMAIL, RESEND_FROM_NAME,
        )
        if not RESEND_API_KEY:
            raise HTTPException(503, "Resend not configured")
        import resend as _resend
        _resend.api_key = RESEND_API_KEY
        html = _build_html({"title": title, "intro": intro, "panels": panels}) \
            .replace("{{first_name}}", body.get("sample_first_name") or user.get("first_name") or "Paul")
        try:
            _resend.Emails.send({
                "from": f"{RESEND_FROM_NAME} <{RESEND_FROM_EMAIL}>",
                "to": [to],
                "subject": f"[TEST] {title}",
                "html": html,
                "tags": [{"name": "kind", "value": "announcement-test"}],
            })
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(502, detail=str(exc)) from exc
        return {"ok": True, "to": to}

    @api.post("/admin/announcements")
    async def create_announcement(
        body: dict,
        request: Request,
        user: dict = Depends(require_role("admin")),
    ):
        """Create + send. Body shape:
        {
          "title": str,
          "intro": str,                    # plain text, newlines allowed
          "panels": [{
              "kind": "file" | "folder",
              "key" | "prefix": str,
              "title": str,
              "blurb": str,
              "thumbnail_url": str        # absolute https URL
          }],
          "recipient_ids": [str] | null   # null/empty = all active franchisees
        }
        """
        title = (body.get("title") or "").strip()
        if not title:
            raise HTTPException(400, "title is required")
        panels = body.get("panels") or []
        if not isinstance(panels, list) or not panels:
            raise HTTPException(400, "At least one panel is required")
        intro = body.get("intro") or ""

        # Pin-to-top metadata. Backend stores `pinned_until` as an ISO
        # date (YYYY-MM-DD) — when set and >= today, the portal lists
        # the announcement above the regular timeline. After the date
        # passes, it falls back into the normal newest-first list. A
        # truthy `pinned` flag without an explicit date defaults to a
        # 14-day window from today (covers a typical "this week's Zoom"
        # scenario plus a bit of slack).
        pinned_until = (body.get("pinned_until") or "").strip() or None
        if not pinned_until and body.get("pinned"):
            pinned_until = (datetime.now(timezone.utc).date()
                            + timedelta(days=14)).isoformat()
        if pinned_until:
            # Validate the date — refuse silently-broken values that
            # would otherwise sort weirdly forever.
            try:
                date_fromisoformat(pinned_until[:10])
            except ValueError as exc:
                raise HTTPException(400, "pinned_until must be YYYY-MM-DD") from exc

        # Resolve recipients
        recipient_ids = body.get("recipient_ids") or None

        # ----- SAFETY GUARDRAILS -----
        # (1) Non-production hosts (preview, localhost) can NEVER broadcast.
        #     If the composer is on a non-production host, force the send
        #     to the calling admin's own email. This stops accidental
        #     fan-outs from preview-environment curl tests or smoke tests.
        host = (body.get("frontend_origin") or
                request.headers.get("origin") or "").lower()
        is_production = ("hub.creativemojo.co.uk" in host)
        if not is_production:
            admin_email = (user.get("email") or "").strip()
            if not admin_email:
                raise HTTPException(400, "Admin email required for non-production sends")
            # Override recipient_ids with an empty marker; we'll send only to
            # the admin themselves with a [PREVIEW] prefix on the subject.
            recipient_ids = ["__admin_only_preview_send__"]

        # (2) Production broadcasts (no recipient_ids => all active)
        #     require an explicit confirm_send_all flag on the body so
        #     no curl/script can fan out by omission.
        confirm_all = bool(body.get("confirm_send_all"))
        if is_production and not recipient_ids and not confirm_all:
            raise HTTPException(400, detail=(
                "Sending to ALL franchisees requires confirm_send_all=true. "
                "Either pick a recipient subset or set confirm_send_all on the request body."
            ))

        match: dict = {}
        if recipient_ids and recipient_ids != ["__admin_only_preview_send__"]:
            match = {"id": {"$in": list(recipient_ids)}}
        recipients: list[dict] = []
        if recipient_ids == ["__admin_only_preview_send__"]:
            # Preview / non-prod: send a single copy to the calling admin.
            recipients.append({
                "id": "__admin_self__",
                "email": (user.get("email") or "").strip(),
                "first_name": (user.get("first_name") or "Admin"),
            })
        else:
            async for f in db.franchisees.find(
                match,
                {"_id": 0, "id": 1, "first_name": 1, "mojo_email": 1,
                 "secondary_email": 1, "tags": 1},
            ):
                email = (f.get("mojo_email") or f.get("secondary_email") or "").strip()
                if not email:
                    continue
                is_ex = any("ex" in str(t).lower() and "franchisee" in str(t).lower()
                            for t in (f.get("tags") or []))
                if is_ex and not recipient_ids:
                    continue
                recipients.append({
                    "id": f.get("id"), "email": email,
                    "first_name": f.get("first_name") or "there",
                })
        if not recipients:
            raise HTTPException(400, "No active franchisees matched the recipient filter")

        # Mint lifetime share links for each panel
        body_origin = body.get("frontend_origin") or ""
        for p in panels:
            file_url, auto_thumb = await _resolve_link_for_panel(db, p, request, body_origin)
            p["resolved_url"] = file_url
            # Admin-picked thumbnail trumps everything else.
            if p.get("thumbnail_key") and not p.get("thumbnail_url"):
                tk_url = await _public_thumb_url_for_key(db, p["thumbnail_key"], request, body_origin)
                if tk_url:
                    p["thumbnail_url"] = tk_url
            # Auto-thumb wins when admin didn't supply one. Admin can
            # always override per-panel via `thumbnail_url` on the body.
            if auto_thumb and not p.get("thumbnail_url"):
                p["thumbnail_url"] = auto_thumb

        ann = {
            "id": str(uuid.uuid4()),
            "title": title,
            "intro": intro,
            "panels": panels,
            "created_at": _now_iso(),
            "created_by": user.get("email"),
            "sent_to": [r["id"] for r in recipients],
            "recipient_count": len(recipients),
            "pinned_until": pinned_until,
            "delivery": {"status": "pending", "succeeded": 0, "failed": 0, "errors": []},
        }
        await db.announcements.insert_one(ann)

        # Send via Resend (re-use the existing client)
        from resend_routes import (
            RESEND_API_KEY, RESEND_FROM_EMAIL, RESEND_FROM_NAME,
        )
        if not RESEND_API_KEY:
            await db.announcements.update_one(
                {"id": ann["id"]},
                {"$set": {"delivery.status": "skipped",
                          "delivery.errors": ["Resend not configured"]}},
            )
            return {"ok": False, "announcement_id": ann["id"], "sent": 0,
                    "reason": "Resend not configured"}
        import resend as _resend
        _resend.api_key = RESEND_API_KEY

        base_html = _build_html(ann)
        succeeded = 0
        failed: list[str] = []
        for r in recipients:
            personal = base_html.replace("{{first_name}}", r["first_name"])
            try:
                _resend.Emails.send({
                    "from": f"{RESEND_FROM_NAME} <{RESEND_FROM_EMAIL}>",
                    "to": [r["email"]],
                    "subject": title,
                    "html": personal,
                    "tags": [{"name": "kind", "value": "announcement"},
                             {"name": "ann_id", "value": ann["id"]}],
                })
                succeeded += 1
            except Exception as exc:  # noqa: BLE001
                failed.append(f"{r['email']}: {exc}")
                logger.warning("Announcement send failed for %s: %s", r["email"], exc)

        delivery = {
            "status": "sent" if succeeded and not failed
                      else ("partial" if succeeded else "failed"),
            "succeeded": succeeded, "failed": len(failed),
            "errors": failed[:10],
        }
        await db.announcements.update_one(
            {"id": ann["id"]},
            {"$set": {"delivery": delivery, "sent_at": _now_iso()}},
        )
        return {"ok": True, "announcement_id": ann["id"], **delivery}

    @api.put("/admin/announcements/{ann_id}")
    async def edit_announcement(
        ann_id: str, body: dict, request: Request,
        user: dict = Depends(require_role("admin")),
    ):
        """Replace an existing announcement and re-send to its (possibly
        changed) recipient list. Same body shape as POST /admin/announcements.
        Keeps the original ``id`` and ``created_at``; refreshes
        ``panels``, ``intro``, ``title``, ``sent_to``, ``sent_at``,
        ``delivery``. Re-mints share-link tokens for every panel — old
        ones still resolve (we don't revoke) so previously-sent emails
        keep working.
        """
        original = await db.announcements.find_one({"id": ann_id}, {"_id": 0})
        if not original:
            raise HTTPException(404, detail="Announcement not found")
        title = (body.get("title") or "").strip()
        if not title:
            raise HTTPException(400, "title is required")
        panels = body.get("panels") or []
        if not isinstance(panels, list) or not panels:
            raise HTTPException(400, "At least one panel is required")
        intro = body.get("intro") or ""

        # Resolve recipients (same guardrails as POST /admin/announcements).
        recipient_ids = body.get("recipient_ids") or None
        host = (body.get("frontend_origin") or
                request.headers.get("origin") or "").lower()
        is_production = ("hub.creativemojo.co.uk" in host)
        if not is_production:
            recipient_ids = ["__admin_only_preview_send__"]
        confirm_all = bool(body.get("confirm_send_all"))
        if is_production and not recipient_ids and not confirm_all:
            raise HTTPException(400, detail=(
                "Re-sending to ALL franchisees requires confirm_send_all=true. "
                "Either pick a recipient subset or set confirm_send_all on the request body."
            ))

        match: dict = {}
        if recipient_ids and recipient_ids != ["__admin_only_preview_send__"]:
            match = {"id": {"$in": list(recipient_ids)}}
        recipients: list[dict] = []
        if recipient_ids == ["__admin_only_preview_send__"]:
            recipients.append({
                "id": "__admin_self__",
                "email": (user.get("email") or "").strip(),
                "first_name": (user.get("first_name") or "Admin"),
            })
        else:
            async for f in db.franchisees.find(
                match,
                {"_id": 0, "id": 1, "first_name": 1, "mojo_email": 1,
                 "secondary_email": 1, "tags": 1},
            ):
                email = (f.get("mojo_email") or f.get("secondary_email") or "").strip()
                if not email:
                    continue
                is_ex = any("ex" in str(t).lower() and "franchisee" in str(t).lower()
                            for t in (f.get("tags") or []))
                if is_ex and not recipient_ids:
                    continue
                recipients.append({
                    "id": f.get("id"), "email": email,
                    "first_name": f.get("first_name") or "there",
                })
        if not recipients:
            raise HTTPException(400, "No active franchisees matched the recipient filter")

        # Re-mint links + thumbs for every panel.
        body_origin = body.get("frontend_origin") or ""
        for p in panels:
            file_url, auto_thumb = await _resolve_link_for_panel(db, p, request, body_origin)
            p["resolved_url"] = file_url
            if p.get("thumbnail_key") and not p.get("thumbnail_url"):
                tk_url = await _public_thumb_url_for_key(db, p["thumbnail_key"], request, body_origin)
                if tk_url:
                    p["thumbnail_url"] = tk_url
            if auto_thumb and not p.get("thumbnail_url"):
                p["thumbnail_url"] = auto_thumb

        # Pin metadata — same handling as POST. None clears any
        # existing pin; explicit YYYY-MM-DD sets a new expiry.
        pinned_until = (body.get("pinned_until") or "").strip() or None
        if not pinned_until and body.get("pinned"):
            pinned_until = (datetime.now(timezone.utc).date()
                            + timedelta(days=14)).isoformat()
        if pinned_until:
            try:
                date_fromisoformat(pinned_until[:10])
            except ValueError as exc:
                raise HTTPException(400, "pinned_until must be YYYY-MM-DD") from exc

        updated = {
            "title": title, "intro": intro, "panels": panels,
            "sent_to": [r["id"] for r in recipients],
            "recipient_count": len(recipients),
            "edited_at": _now_iso(),
            "edited_by": user.get("email"),
            "pinned_until": pinned_until,
            "delivery": {"status": "pending", "succeeded": 0, "failed": 0, "errors": []},
        }
        await db.announcements.update_one({"id": ann_id}, {"$set": updated})

        # Re-send via Resend
        from resend_routes import (
            RESEND_API_KEY, RESEND_FROM_EMAIL, RESEND_FROM_NAME,
        )
        if not RESEND_API_KEY:
            await db.announcements.update_one(
                {"id": ann_id},
                {"$set": {"delivery.status": "skipped",
                          "delivery.errors": ["Resend not configured"]}},
            )
            return {"ok": False, "announcement_id": ann_id, "sent": 0,
                    "reason": "Resend not configured"}
        import resend as _resend
        _resend.api_key = RESEND_API_KEY
        base_html = _build_html({"title": title, "intro": intro, "panels": panels})
        succeeded = 0
        failed: list[str] = []
        for r in recipients:
            personal = base_html.replace("{{first_name}}", r["first_name"])
            try:
                _resend.Emails.send({
                    "from": f"{RESEND_FROM_NAME} <{RESEND_FROM_EMAIL}>",
                    "to": [r["email"]],
                    "subject": title,
                    "html": personal,
                    "tags": [{"name": "kind", "value": "announcement-edit"},
                             {"name": "ann_id", "value": ann_id}],
                })
                succeeded += 1
            except Exception as exc:  # noqa: BLE001
                failed.append(f"{r['email']}: {exc}")
                logger.warning("Announcement re-send failed for %s: %s", r["email"], exc)
        delivery = {
            "status": "sent" if succeeded and not failed
                      else ("partial" if succeeded else "failed"),
            "succeeded": succeeded, "failed": len(failed),
            "errors": failed[:10],
        }
        await db.announcements.update_one(
            {"id": ann_id},
            {"$set": {"delivery": delivery, "sent_at": _now_iso()}},
        )
        return {"ok": True, "announcement_id": ann_id, **delivery}

    @api.get("/admin/announcements")
    async def list_announcements(_: dict = Depends(require_role("admin"))):
        items = await db.announcements.find({}, {"_id": 0}) \
            .sort("created_at", -1).limit(200).to_list(200)
        today = datetime.now(timezone.utc).date().isoformat()
        for it in items:
            pu = (it.get("pinned_until") or "")[:10]
            it["is_pinned"] = bool(pu and pu >= today)
        return {"items": items, "total": len(items)}

    # ---- Admin read/open log. Returns who opened which announcement
    # and when. Joins ``announcement_reads`` (user_key, announcement_id,
    # read_at) with the announcements collection to get titles, and
    # with the franchisees collection to get human-readable names.
    @api.get("/admin/announcements/reads")
    async def list_announcement_reads(
        limit: int = 500, _: dict = Depends(require_role("admin")),
    ):
        # Build small in-memory maps so we can attach titles + names
        # without N+1 queries.
        ann_by_id: dict[str, dict] = {}
        async for a in db.announcements.find({}, {"_id": 0, "id": 1, "title": 1, "sent_at": 1, "created_at": 1}):
            ann_by_id[a["id"]] = a
        fr_by_id: dict[str, dict] = {}
        async for f in db.franchisees.find(
            {}, {"_id": 0, "id": 1, "first_name": 1, "last_name": 1, "organisation": 1, "email": 1},
        ):
            fr_by_id[f["id"]] = f
        items: list[dict] = []
        async for r in db.announcement_reads.find({}, {"_id": 0}) \
                .sort("read_at", -1).limit(limit):
            ann = ann_by_id.get(r.get("announcement_id")) or {}
            fr = fr_by_id.get(r.get("user_key")) or {}
            full_name = (
                f"{fr.get('first_name') or ''} {fr.get('last_name') or ''}".strip()
                or fr.get("organisation") or r.get("user_key")
            )
            items.append({
                "announcement_id": r.get("announcement_id"),
                "announcement_title": ann.get("title"),
                "franchisee_id": r.get("user_key"),
                "franchisee_name": full_name,
                "franchisee_email": fr.get("email"),
                "read_at": r.get("read_at"),
            })
        total = await db.announcement_reads.count_documents({})
        return {"items": items, "returned": len(items), "total": total}

    # --------------------- recent files helper for the composer ----
    # MUST be declared before /admin/announcements/{ann_id} so FastAPI's
    # path matcher routes the literal "recent-files" segment here rather
    # than treating it as an announcement id.
    @api.get("/admin/announcements/recent-files")
    async def recent_files(limit: int = 40, _: dict = Depends(require_role("admin"))):
        """The "Recently added" candidates the composer can quickly tick."""
        items = await db.files_index.find({}, {"_id": 0}) \
            .sort("uploaded_at", -1).limit(limit).to_list(limit)
        return {"items": items}

    @api.get("/admin/announcements/recent-folders")
    async def recent_folders(limit: int = 30, _: dict = Depends(require_role("admin"))):
        """Distinct top-level folders ordered by their most-recent file
        upload — same heuristic the FilesPage's Recently Added strip uses."""
        from datetime import timedelta
        cutoff = (datetime.now(timezone.utc) - timedelta(days=90)).isoformat()
        pipeline = [
            {"$match": {"uploaded_at": {"$gte": cutoff}}},
            {"$project": {
                "_id": 0,
                "uploaded_at": 1,
                "parts": {"$split": ["$key", "/"]},
            }},
            {"$project": {
                "uploaded_at": 1,
                "prefix": {"$concat": [
                    {"$arrayElemAt": ["$parts", 0]}, "/",
                    {"$arrayElemAt": ["$parts", 1]}, "/",
                ]},
                "name": {"$arrayElemAt": ["$parts", 1]},
            }},
            {"$match": {"name": {"$nin": [None, ""]}}},
            {"$group": {
                "_id": "$prefix",
                "name": {"$first": "$name"},
                "last_uploaded": {"$max": "$uploaded_at"},
                "file_count": {"$sum": 1},
            }},
            {"$sort": {"last_uploaded": -1}},
            {"$limit": limit},
        ]
        out = []
        async for row in db.files_index.aggregate(pipeline):
            out.append({
                "prefix": row.get("_id"),
                "name": row.get("name"),
                "file_count": row.get("file_count", 0),
                "last_uploaded": row.get("last_uploaded"),
            })
        return {"items": out}

    @api.get("/admin/announcements/{ann_id}")
    async def get_announcement(ann_id: str, _: dict = Depends(require_role("admin"))):
        doc = await db.announcements.find_one({"id": ann_id}, {"_id": 0})
        if not doc:
            raise HTTPException(404, "Not found")
        return doc

    @api.delete("/admin/announcements/{ann_id}")
    async def delete_announcement(ann_id: str, _: dict = Depends(require_role("admin"))):
        r = await db.announcements.delete_one({"id": ann_id})
        if not r.deleted_count:
            raise HTTPException(404, "Not found")
        return {"ok": True}

    @api.post("/admin/announcements/rewrite-urls")
    async def rewrite_urls(
        body: dict, _: dict = Depends(require_role("admin")),
    ):
        """One-off backfill. Rewrites the host on every panel's
        ``resolved_url`` and ``thumbnail_url`` across every saved
        announcement. Useful when a deployment's ``FRONTEND_URL`` env
        was wrong at compose-time and minted links pointing at the
        wrong host (preview ↔ production drift).

        Body:
        ```
        {"from": "https://licensee-vault.preview.emergentagent.com",
         "to":   "https://hub.creativemojo.co.uk"}
        ```

        Returns: ``{ scanned, updated, panels_touched }``. Safe to run
        multiple times — substitution is idempotent.

        Also migrates any pre-bug ``folder_share_links`` rows into the
        canonical ``files_share_links`` collection so historic OPEN
        FOLDER buttons resolve.
        """
        frm = (body.get("from") or "").rstrip("/")
        to = (body.get("to") or "").rstrip("/")

        # ---- Migrate legacy folder_share_links → files_share_links ----
        migrated = 0
        try:
            import re as _re
            async for doc in db.folder_share_links.find({}, {"_id": 0}):
                token = doc.get("token")
                if not token:
                    continue
                already = await db.files_share_links.find_one(
                    {"token": token}, {"_id": 0, "token": 1},
                )
                if already:
                    continue
                prefix = (doc.get("prefix") or "").rstrip("/") + "/"
                file_count = await db.files_index.count_documents({
                    "key": {"$regex": f"^{_re.escape(prefix)}"},
                    "hidden": {"$ne": True},
                })
                leaf = prefix.rstrip("/").rsplit("/", 1)[-1] or prefix.rstrip("/")
                await db.files_share_links.insert_one({
                    "token": token,
                    "kind": "folder",
                    "prefix": prefix,
                    "label": leaf.replace("-", " "),
                    "file_count": file_count,
                    "expires_at": doc.get("expires_at"),
                    "lifetime": doc.get("lifetime", True),
                    "revoked": doc.get("revoked", False),
                    "created_at": doc.get("created_at"),
                    "created_by": doc.get("created_by") or "announcement-migrated",
                    "hits": doc.get("hits", 0),
                })
                migrated += 1
        except Exception:  # noqa: BLE001
            pass

        if not frm or not to:
            return {"migrated_folder_tokens": migrated,
                    "scanned": 0, "updated": 0, "panels_touched": 0,
                    "note": "from/to not provided — URL rewrite skipped, folder-token migration ran."}
        scanned = 0
        updated = 0
        panels_touched = 0
        async for ann in db.announcements.find({}, {"_id": 0}):
            scanned += 1
            changed = False
            new_panels: list[dict] = []
            for p in (ann.get("panels") or []):
                np = dict(p)
                for field in ("resolved_url", "thumbnail_url"):
                    v = np.get(field) or ""
                    if v.startswith(frm):
                        np[field] = to + v[len(frm):]
                        changed = True
                        panels_touched += 1
                new_panels.append(np)
            if changed:
                await db.announcements.update_one(
                    {"id": ann["id"]},
                    {"$set": {"panels": new_panels}},
                )
                updated += 1
        return {"scanned": scanned, "updated": updated,
                "panels_touched": panels_touched,
                "migrated_folder_tokens": migrated}

    # --------------------- portal endpoint ------------------------
    async def _user_key(user: dict) -> str:
        """Stable key for per-user read tracking. Falls back to email
        when neither franchisee_id nor id is present (shouldn't happen
        in practice, but defensive)."""
        return user.get("franchisee_id") or user.get("id") or user.get("email") or "anon"

    async def _read_set(user_key: str, ann_ids: list[str]) -> set[str]:
        """Return the subset of ``ann_ids`` that ``user_key`` has
        already read. One query, returned as a Python set for O(1)
        membership tests in the listing loop."""
        if not ann_ids:
            return set()
        out: set[str] = set()
        async for r in db.announcement_reads.find(
            {"user_key": user_key, "announcement_id": {"$in": ann_ids}},
            {"_id": 0, "announcement_id": 1},
        ):
            out.add(r["announcement_id"])
        return out

    @api.get("/portal/announcements")
    async def portal_list(user: dict = Depends(require_role("franchisee", "admin"))):
        """Past announcements the logged-in franchisee was a recipient of.
        Admins see everything (handy for QA). Sorted newest first, with
        currently-pinned items lifted to the top of the list. An item
        counts as pinned while ``pinned_until`` (an ISO date) is in the
        future; the moment it slips into the past, the item naturally
        falls back into its place in the newest-first ordering.
        Each item is annotated with ``is_unread=True`` until the user
        opens it on the portal (POST .../read clears the flag) and
        ``is_pinned=True`` for the convenience of the portal renderer.
        """
        if user.get("role") == "admin":
            items = await db.announcements.find({}, {"_id": 0}) \
                .sort("created_at", -1).limit(200).to_list(200)
        else:
            fid = user.get("franchisee_id") or user.get("id")
            items = await db.announcements.find(
                {"sent_to": fid}, {"_id": 0},
            ).sort("created_at", -1).limit(200).to_list(200)

        # Annotate + sort.
        user_key = await _user_key(user)
        ann_ids = [it.get("id") for it in items if it.get("id")]
        read = await _read_set(user_key, ann_ids)
        today = datetime.now(timezone.utc).date().isoformat()
        for it in items:
            it["is_unread"] = it.get("id") not in read
            pu = (it.get("pinned_until") or "")[:10]
            it["is_pinned"] = bool(pu and pu >= today)
        # Stable sort: True ahead of False, ties broken by created_at (already
        # in descending order from Mongo). Python's sort is stable so this
        # preserves the newest-first ordering within each group.
        items.sort(key=lambda x: 0 if x.get("is_pinned") else 1)
        return {"items": items, "total": len(items)}

    @api.get("/portal/announcements/unread-count")
    async def portal_unread_count(user: dict = Depends(require_role("franchisee", "admin"))):
        """Lightweight count for the sidebar badge. Just the IDs the
        user *can* see minus the IDs they've already opened."""
        if user.get("role") == "admin":
            all_ids = await db.announcements.find({}, {"_id": 0, "id": 1}) \
                .sort("created_at", -1).limit(200).to_list(200)
        else:
            fid = user.get("franchisee_id") or user.get("id")
            all_ids = await db.announcements.find(
                {"sent_to": fid}, {"_id": 0, "id": 1},
            ).sort("created_at", -1).limit(200).to_list(200)
        ids = [x["id"] for x in all_ids if x.get("id")]
        if not ids:
            return {"unread": 0}
        user_key = await _user_key(user)
        read = await _read_set(user_key, ids)
        return {"unread": max(0, len(ids) - len(read))}

    @api.post("/portal/announcements/{ann_id}/read")
    async def portal_mark_read(
        ann_id: str,
        user: dict = Depends(require_role("franchisee", "admin")),
    ):
        """Idempotent — upsert one row in ``announcement_reads`` so
        subsequent unread-count queries skip this announcement for
        this user."""
        # Verify the announcement exists + that this user is allowed
        # to read it (admins skip the recipient filter).
        ann = await db.announcements.find_one({"id": ann_id}, {"_id": 0, "sent_to": 1})
        if not ann:
            raise HTTPException(404, detail="Announcement not found")
        if user.get("role") != "admin":
            fid = user.get("franchisee_id") or user.get("id")
            if fid not in (ann.get("sent_to") or []):
                raise HTTPException(403, detail="Not a recipient")
        user_key = await _user_key(user)
        await db.announcement_reads.update_one(
            {"user_key": user_key, "announcement_id": ann_id},
            {"$set": {"user_key": user_key, "announcement_id": ann_id, "read_at": _now_iso()}},
            upsert=True,
        )
        return {"ok": True}


