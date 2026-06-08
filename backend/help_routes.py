"""Help Centre — admin uploads a marked-up screenshot per portal page,
franchisees pull the right one when they click the Help button.

Storage: R2 (under ``admin/help-centre/{slug}.png``) — same client used by
File Vault. We hand the franchisee a presigned GET URL so the bucket can
stay private; URLs are valid for 1 hour, easily refreshed on the next load.

Mongo collection: ``help_pages`` — one doc per portal page slug:
    {
      "_id": "calendar",
      "page_slug": "calendar",
      "title": "Calendar",
      "caption": "…",
      "image_key": "admin/help-centre/calendar-<uuid>.png",
      "image_content_type": "image/png",
      "updated_at": iso,
      "updated_by": email,
    }
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile

from file_storage import get_client, R2_BUCKET, r2_configured

logger = logging.getLogger("creative-mojo-admin.help-centre")

# Canonical list of portal pages that have a help entry. Order matters —
# this drives the admin index ordering. Adding a new entry here is the
# only change needed to teach the system a new page; the admin upload UI
# and portal lookup both read from it.
HELP_PAGES: list[dict] = [
    {"slug": "my-franchise",  "title": "My Franchise",  "match_paths": ["/portal/details", "/portal/profile"]},
    {"slug": "my-territory",  "title": "My Territory",  "match_paths": ["/portal/territory/basic"]},
    {"slug": "my-territory-plus", "title": "My Territory+", "match_paths": ["/portal/territory"]},
    {"slug": "bookings",      "title": "Bookings+",     "match_paths": ["/portal/bookings"]},
    {"slug": "marketing",     "title": "Marketing+",    "match_paths": ["/portal/marketing"]},
    {"slug": "invoicing",     "title": "Invoicing+",    "match_paths": ["/portal/invoices"]},
    {"slug": "calendar",      "title": "Calendar",      "match_paths": ["/portal/events"]},
    {"slug": "video-hub",     "title": "Video Hub",     "match_paths": ["/portal/training"]},
    {"slug": "hq-updates",    "title": "HQ Updates",    "match_paths": ["/portal/updates"]},
    {"slug": "file-vault",    "title": "File Vault",    "match_paths": ["/portal/files"]},
    {"slug": "franchise-store", "title": "Franchise Store", "match_paths": ["/portal/shape-orders"]},
    {"slug": "change-password", "title": "Change password", "match_paths": ["/portal/account/password"]},
    {"slug": "subscriptions", "title": "Subscriptions", "match_paths": ["/portal/account/subscriptions"]},
    # Catch-all for "I clicked Help and don't match any of the above"
    {"slug": "home",          "title": "Portal home",   "match_paths": ["/portal", "/portal/home"]},
]
_SLUG_SET = {p["slug"] for p in HELP_PAGES}

# AI-suggested first-draft captions — admin can edit/keep/wipe each one.
# Kept here (not in code-gen) so editing the wording is a one-line change.
SUGGESTED_CAPTIONS: dict[str, str] = {
    "my-franchise":     "Your franchise control panel — personal details, contact info, and the franchise stats HQ uses to recognise your area. Edit anything in the cards below and hit Save.",
    "my-territory":     "A read-only view of the postcode sectors HQ has allocated to your franchise. Use this to confirm coverage before quoting a job — if the boundary looks wrong, contact HQ.",
    "my-territory-plus": "The interactive Territory+ map. Click postcode sectors to add them to your territory, search any CRM client by name or postcode, and use the action cards (Plan a route, Add a client, Marketing send) to keep momentum.",
    "bookings":         "Your bookings calendar with the public booking form, package builder, and franchisee diary. Use the colour-coded chips to spot conflicts at a glance.",
    "marketing":        "The Marketing+ composer — pick a template, drop in images, address it to specific clients or your whole CRM, and the system tracks opens / clicks / unsubscribes for you.",
    "invoicing":        "Create, send and track invoices. Live status pills (Draft / Sent / Paid / Overdue) sync from Xero so you always see the up-to-date state of every job.",
    "calendar":         "Your unified calendar — workshops, holidays, repeat events and yearly milestones in one grid. Search by client name or event title; results auto-jump to the right month.",
    "video-hub":        "On-demand training videos from HQ. Use the categories on the left to filter, hit play to watch — your progress is saved automatically.",
    "hq-updates":       "The HQ feed — broadcasts, policy updates and Q&A threads from head office. Anything pinned to the top is mandatory reading.",
    "file-vault":       "Your franchise file library — branded assets, manuals, social media templates. The folder tree on the left mirrors the FileCamp setup you're used to.",
    "franchise-store":  "Order shape sets (free, ship in pairs) and signage / clothing (charged at Woo prices). Tick the personalisation options each product requires before hitting Finalise.",
    "change-password":  "Set a new password for your portal account. The strength meter helps you pick something secure; you'll be signed out elsewhere once saved.",
    "subscriptions":    "Your active subscription tier and any bolt-on modules (Marketing+, Bookings+, etc.). Use this page to view your invoice history and to add/remove bolt-ons.",
    "home":             "The Portal home screen — at-a-glance KPIs, recent bookings, last marketing send, and shortcuts to the modules you use most.",
}


def build_help_router(db, require_role):
    router = APIRouter()

    def _now() -> str:
        return datetime.now(timezone.utc).isoformat()

    async def _presign_get(image_key: str, *, ttl: int = 3600) -> Optional[str]:
        if not image_key or not r2_configured():
            return None
        try:
            return get_client().generate_presigned_url(
                "get_object",
                Params={"Bucket": R2_BUCKET, "Key": image_key},
                ExpiresIn=ttl,
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("Help screenshot presign failed for %s: %s", image_key, exc)
            return None

    async def _load_pages(include_url: bool = True) -> list[dict]:
        # Build the full list in canonical order — backfilling DB entries
        # as we go so the admin UI never shows blank rows.
        existing: dict[str, dict] = {}
        async for doc in db.help_pages.find({}, {"_id": 1, "page_slug": 1, "caption": 1, "image_key": 1, "image_content_type": 1, "updated_at": 1, "updated_by": 1}):
            existing[doc.get("page_slug") or doc.get("_id")] = doc
        out: list[dict] = []
        for page in HELP_PAGES:
            doc = existing.get(page["slug"], {})
            image_url = await _presign_get(doc.get("image_key")) if include_url else None
            out.append({
                "slug": page["slug"],
                "title": page["title"],
                "match_paths": page["match_paths"],
                "caption": doc.get("caption") or "",
                "has_image": bool(doc.get("image_key")),
                "image_url": image_url,
                "updated_at": doc.get("updated_at"),
                "updated_by": doc.get("updated_by"),
                "suggested_caption": SUGGESTED_CAPTIONS.get(page["slug"], ""),
            })
        return out

    # --------------------------------------------------- admin endpoints
    @router.get("/admin/help-centre/pages")
    async def admin_list(_user=Depends(require_role("admin"))):
        return {"pages": await _load_pages(include_url=True)}

    @router.post("/admin/help-centre/pages/{slug}/upload")
    async def admin_upload(
        slug: str,
        file: UploadFile = File(...),
        caption: Optional[str] = Form(None),
        user: dict = Depends(require_role("admin")),
    ):
        if slug not in _SLUG_SET:
            raise HTTPException(404, detail=f"Unknown page slug: {slug}")
        if not r2_configured():
            raise HTTPException(503, detail="R2 storage isn't configured on this environment.")
        content_type = (file.content_type or "").lower()
        if not content_type.startswith("image/"):
            raise HTTPException(400, detail="Please upload an image (PNG / JPG).")
        ext = (file.filename or "").rsplit(".", 1)[-1].lower() if "." in (file.filename or "") else "png"
        if ext not in {"png", "jpg", "jpeg", "webp", "gif"}:
            ext = "png"
        # Use a fresh uuid each upload so the previous file is harmless to
        # leave behind (R2 lifecycle / janitor can sweep them later).
        key = f"admin/help-centre/{slug}-{uuid.uuid4().hex[:10]}.{ext}"
        body = await file.read()
        if len(body) > 25 * 1024 * 1024:
            raise HTTPException(400, detail="Image too large — max 25 MB.")
        try:
            get_client().put_object(
                Bucket=R2_BUCKET,
                Key=key,
                Body=body,
                ContentType=content_type,
            )
        except Exception as exc:  # noqa: BLE001
            logger.exception("R2 upload failed")
            raise HTTPException(502, detail=f"Upload failed: {exc}") from exc

        update = {
            "page_slug": slug,
            "image_key": key,
            "image_content_type": content_type,
            "updated_at": _now(),
            "updated_by": user.get("email"),
        }
        if caption is not None:
            update["caption"] = caption.strip()
        await db.help_pages.update_one(
            {"_id": slug}, {"$set": update}, upsert=True,
        )
        signed = await _presign_get(key)
        return {"ok": True, "slug": slug, "image_url": signed, "caption": update.get("caption", "")}

    @router.patch("/admin/help-centre/pages/{slug}")
    async def admin_patch(slug: str, body: dict, user: dict = Depends(require_role("admin"))):
        """Update caption-only (no new image). Useful for tweaking copy."""
        if slug not in _SLUG_SET:
            raise HTTPException(404, detail=f"Unknown page slug: {slug}")
        update: dict = {"updated_at": _now(), "updated_by": user.get("email"), "page_slug": slug}
        if "caption" in body:
            update["caption"] = (body.get("caption") or "").strip()
        await db.help_pages.update_one({"_id": slug}, {"$set": update}, upsert=True)
        return {"ok": True, "slug": slug, "caption": update.get("caption", "")}

    @router.delete("/admin/help-centre/pages/{slug}/image")
    async def admin_delete_image(slug: str, _user=Depends(require_role("admin"))):
        """Clear the screenshot only — keeps the caption. Mirrors the
        File Vault delete semantics: best-effort R2 delete, then null
        out the Mongo pointer."""
        if slug not in _SLUG_SET:
            raise HTTPException(404, detail=f"Unknown page slug: {slug}")
        doc = await db.help_pages.find_one({"_id": slug}, {"image_key": 1})
        if doc and doc.get("image_key") and r2_configured():
            try:
                get_client().delete_object(Bucket=R2_BUCKET, Key=doc["image_key"])
            except Exception as exc:  # noqa: BLE001
                logger.warning("R2 delete failed for %s: %s", doc.get("image_key"), exc)
        await db.help_pages.update_one(
            {"_id": slug},
            {"$set": {"image_key": None, "image_content_type": None, "updated_at": _now()}},
            upsert=True,
        )
        return {"ok": True}

    # --------------------------------------------------- portal endpoints
    # Any signed-in user (admin or franchisee) can read — every portal
    # role benefits from the same help content.
    @router.get("/portal/help/pages/{slug}")
    async def portal_get(slug: str, _user=Depends(require_role("franchisee"))):
        if slug not in _SLUG_SET:
            raise HTTPException(404, detail="No help page for that slug.")
        page = next(p for p in HELP_PAGES if p["slug"] == slug)
        doc = await db.help_pages.find_one({"_id": slug}, {"_id": 0}) or {}
        return {
            "slug": slug,
            "title": page["title"],
            "caption": doc.get("caption") or "",
            "image_url": await _presign_get(doc.get("image_key")),
            "has_image": bool(doc.get("image_key")),
        }

    @router.get("/portal/help/index")
    async def portal_index(_user=Depends(require_role("franchisee"))):
        """Lightweight index — the portal Help button uses this to map
        the current path → slug client-side, so it can context-load."""
        return {
            "pages": [
                {"slug": p["slug"], "title": p["title"], "match_paths": p["match_paths"]}
                for p in HELP_PAGES
            ],
        }

    return router
