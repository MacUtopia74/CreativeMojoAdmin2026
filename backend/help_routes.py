"""Help Centre — admin uploads one or more marked-up screenshots per
portal page; franchisees flip through them in a carousel when they click
the Help button.

Storage: R2 (under ``admin/help-centre/{slug}-{uuid}.png``) — same client
used by File Vault. We hand the franchisee a presigned GET URL per slide
so the bucket can stay private; URLs are valid for 1 hour, easily
refreshed on the next modal open.

Mongo collection: ``help_pages`` — one doc per portal page slug:
    {
      "_id": "calendar",
      "page_slug": "calendar",
      "caption": "intro shown above the carousel",
      "slides": [
        {
          "id": "<uuid>",
          "image_key": "admin/help-centre/calendar-<uuid>.png",
          "content_type": "image/png",
          "caption": "Step 1 — click here.",
        },
        …
      ],
      "updated_at": iso,
      "updated_by": email,
    }

Backward-compat: legacy docs with a top-level ``image_key`` (single
image, pre-multi-slide) are migrated lazily on read into a one-element
``slides`` array. They get persisted in the new shape on the next write.
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


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _normalise_slides(doc: dict) -> list[dict]:
    """Pull the canonical slide list off a Mongo doc, migrating the
    legacy single-image shape on the fly. Pure read-side — never writes.
    """
    if not doc:
        return []
    raw = doc.get("slides")
    if isinstance(raw, list) and raw:
        # Ensure each slide has the keys we need; defensively coerce.
        out = []
        for s in raw:
            if not isinstance(s, dict) or not s.get("image_key"):
                continue
            out.append({
                "id": s.get("id") or uuid.uuid4().hex[:12],
                "image_key": s["image_key"],
                "content_type": s.get("content_type") or "image/png",
                "caption": s.get("caption") or "",
            })
        return out
    # Legacy: top-level image_key + caption — promote to a single slide.
    if doc.get("image_key"):
        return [{
            "id": "legacy",
            "image_key": doc["image_key"],
            "content_type": doc.get("image_content_type") or "image/png",
            "caption": "",  # page-level caption stays on the page itself
        }]
    return []


def build_help_router(db, require_role):
    router = APIRouter()

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

    async def _hydrate_slides(slides: list[dict]) -> list[dict]:
        out = []
        for s in slides:
            out.append({
                "id": s["id"],
                "caption": s.get("caption") or "",
                "content_type": s.get("content_type") or "image/png",
                "image_url": await _presign_get(s["image_key"]),
            })
        return out

    async def _load_pages() -> list[dict]:
        existing: dict[str, dict] = {}
        async for doc in db.help_pages.find({}):
            existing[doc.get("page_slug") or doc.get("_id")] = doc
        out: list[dict] = []
        for page in HELP_PAGES:
            doc = existing.get(page["slug"], {}) or {}
            slides = _normalise_slides(doc)
            hydrated = await _hydrate_slides(slides)
            out.append({
                "slug": page["slug"],
                "title": page["title"],
                "match_paths": page["match_paths"],
                "caption": doc.get("caption") or "",
                "slides": hydrated,
                "slide_count": len(hydrated),
                "updated_at": doc.get("updated_at"),
                "updated_by": doc.get("updated_by"),
                "suggested_caption": SUGGESTED_CAPTIONS.get(page["slug"], ""),
            })
        return out

    def _assert_slug(slug: str):
        if slug not in _SLUG_SET:
            raise HTTPException(404, detail=f"Unknown page slug: {slug}")

    async def _ensure_doc(slug: str) -> dict:
        """Fetch the doc (creating an empty shell if missing) and ensure
        it carries a real ``slides`` array — migrating legacy shape if
        present. Returns the in-memory doc; caller persists changes.
        """
        doc = await db.help_pages.find_one({"_id": slug}) or {}
        if not doc:
            doc = {"_id": slug, "page_slug": slug, "slides": [], "caption": ""}
        if not isinstance(doc.get("slides"), list):
            doc["slides"] = _normalise_slides(doc)
        return doc

    # --------------------------------------------------- admin endpoints
    @router.get("/admin/help-centre/pages")
    async def admin_list(_user=Depends(require_role("admin"))):
        return {"pages": await _load_pages()}

    @router.patch("/admin/help-centre/pages/{slug}")
    async def admin_patch(slug: str, body: dict, user: dict = Depends(require_role("admin"))):
        """Update the page-level intro caption (sits above the carousel)."""
        _assert_slug(slug)
        update: dict = {"updated_at": _now(), "updated_by": user.get("email"), "page_slug": slug}
        if "caption" in body:
            update["caption"] = (body.get("caption") or "").strip()
        await db.help_pages.update_one({"_id": slug}, {"$set": update}, upsert=True)
        return {"ok": True, "slug": slug, "caption": update.get("caption", "")}

    @router.post("/admin/help-centre/pages/{slug}/slides")
    async def admin_add_slide(
        slug: str,
        file: UploadFile = File(...),
        caption: Optional[str] = Form(None),
        user: dict = Depends(require_role("admin")),
    ):
        _assert_slug(slug)
        if not r2_configured():
            raise HTTPException(503, detail="R2 storage isn't configured on this environment.")
        content_type = (file.content_type or "").lower()
        if not content_type.startswith("image/"):
            raise HTTPException(400, detail="Please upload an image (PNG / JPG).")
        ext = (file.filename or "").rsplit(".", 1)[-1].lower() if "." in (file.filename or "") else "png"
        if ext not in {"png", "jpg", "jpeg", "webp", "gif"}:
            ext = "png"
        body = await file.read()
        if len(body) > 25 * 1024 * 1024:
            raise HTTPException(400, detail="Image too large — max 25 MB.")
        slide_id = uuid.uuid4().hex[:12]
        key = f"admin/help-centre/{slug}-{slide_id}.{ext}"
        try:
            get_client().put_object(
                Bucket=R2_BUCKET, Key=key, Body=body, ContentType=content_type,
            )
        except Exception as exc:  # noqa: BLE001
            logger.exception("R2 upload failed")
            raise HTTPException(502, detail=f"Upload failed: {exc}") from exc

        doc = await _ensure_doc(slug)
        slides = doc["slides"]
        slides.append({
            "id": slide_id,
            "image_key": key,
            "content_type": content_type,
            "caption": (caption or "").strip(),
        })
        await db.help_pages.update_one(
            {"_id": slug},
            {"$set": {
                "page_slug": slug,
                "slides": slides,
                "updated_at": _now(),
                "updated_by": user.get("email"),
            }},
            upsert=True,
        )
        return {
            "ok": True,
            "slug": slug,
            "slide": {
                "id": slide_id,
                "caption": (caption or "").strip(),
                "content_type": content_type,
                "image_url": await _presign_get(key),
            },
            "slide_count": len(slides),
        }

    @router.patch("/admin/help-centre/pages/{slug}/slides/{slide_id}")
    async def admin_patch_slide(
        slug: str, slide_id: str, body: dict,
        user: dict = Depends(require_role("admin")),
    ):
        _assert_slug(slug)
        doc = await _ensure_doc(slug)
        slides = doc["slides"]
        for s in slides:
            if s.get("id") == slide_id:
                if "caption" in body:
                    s["caption"] = (body.get("caption") or "").strip()
                break
        else:
            raise HTTPException(404, detail="Slide not found.")
        await db.help_pages.update_one(
            {"_id": slug},
            {"$set": {
                "page_slug": slug, "slides": slides,
                "updated_at": _now(), "updated_by": user.get("email"),
            }},
            upsert=True,
        )
        return {"ok": True}

    @router.delete("/admin/help-centre/pages/{slug}/slides/{slide_id}")
    async def admin_delete_slide(
        slug: str, slide_id: str,
        user: dict = Depends(require_role("admin")),
    ):
        _assert_slug(slug)
        doc = await _ensure_doc(slug)
        slides = doc["slides"]
        target = next((s for s in slides if s.get("id") == slide_id), None)
        if not target:
            raise HTTPException(404, detail="Slide not found.")
        # Best-effort R2 delete; if it fails we still drop the pointer.
        if target.get("image_key") and r2_configured():
            try:
                get_client().delete_object(Bucket=R2_BUCKET, Key=target["image_key"])
            except Exception as exc:  # noqa: BLE001
                logger.warning("R2 delete failed for %s: %s", target.get("image_key"), exc)
        remaining = [s for s in slides if s.get("id") != slide_id]
        await db.help_pages.update_one(
            {"_id": slug},
            {"$set": {
                "page_slug": slug, "slides": remaining,
                "updated_at": _now(), "updated_by": user.get("email"),
            }},
            upsert=True,
        )
        return {"ok": True, "slide_count": len(remaining)}

    @router.patch("/admin/help-centre/pages/{slug}/reorder")
    async def admin_reorder(
        slug: str, body: dict,
        user: dict = Depends(require_role("admin")),
    ):
        """Body: {"order": ["id1", "id2", …]}. Any IDs not in the list
        keep their relative order at the tail (defensive)."""
        _assert_slug(slug)
        new_order = list(body.get("order") or [])
        if not new_order:
            raise HTTPException(400, detail="Provide an 'order' list of slide IDs.")
        doc = await _ensure_doc(slug)
        slides = doc["slides"]
        by_id = {s["id"]: s for s in slides}
        seen: set[str] = set()
        reordered: list[dict] = []
        for sid in new_order:
            if sid in by_id and sid not in seen:
                reordered.append(by_id[sid])
                seen.add(sid)
        # Append anything the client forgot, preserving original order.
        for s in slides:
            if s["id"] not in seen:
                reordered.append(s)
        await db.help_pages.update_one(
            {"_id": slug},
            {"$set": {
                "page_slug": slug, "slides": reordered,
                "updated_at": _now(), "updated_by": user.get("email"),
            }},
            upsert=True,
        )
        return {"ok": True, "slide_count": len(reordered)}

    # --------------------------------------------------- portal endpoints
    # Any signed-in user (admin or franchisee) can read — every portal
    # role benefits from the same help content.
    @router.get("/portal/help/pages/{slug}")
    async def portal_get(slug: str, _user=Depends(require_role("franchisee"))):
        _assert_slug(slug)
        page = next(p for p in HELP_PAGES if p["slug"] == slug)
        doc = await db.help_pages.find_one({"_id": slug}) or {}
        slides = _normalise_slides(doc)
        return {
            "slug": slug,
            "title": page["title"],
            "caption": doc.get("caption") or "",
            "slides": await _hydrate_slides(slides),
            "slide_count": len(slides),
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
