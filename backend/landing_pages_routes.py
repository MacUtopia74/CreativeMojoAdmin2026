"""Public PDF landing pages — admin CRUD + public viewer + visit tracking.

Why a separate route module?
  • Admin endpoints sit behind ``require_role('admin')`` like every other
    admin surface.
  • Public endpoints are deliberately **unauthenticated** so they work
    when a recipient clicks a CTA in an email forwarded outside the
    organisation.
  • Both flows touch the same ``landing_pages`` collection, so keeping
    them co-located makes the schema obvious in one place.

Email-side integration
~~~~~~~~~~~~~~~~~~~~~~
Email templates embed CTAs as ``{{landing:<slug>}}`` tokens. The Resend
send pipeline (resend_routes.py) substitutes the token for the public
URL at send time — including an optional ``?t=<send_id>`` tracking
parameter so visits/downloads attribute back to the originating
``email_sends`` row.

Schema
~~~~~~
``landing_pages``
    id, slug (unique), title, intro_html, cta_label, file_key,
    file_name, bullets[], active, created_at, updated_at,
    created_by_id, created_by_email.

``landing_page_visits``
    id, page_id, page_slug, at, ip, user_agent, referrer,
    outcome ("view"|"download"), token (X-CM-Send-Id of the email if
    accessed from one), contact_id (resolved from token), email_send_id.
"""

from __future__ import annotations

import logging
import re
import uuid
from datetime import datetime, timezone
from typing import Optional, List

from fastapi import APIRouter, Depends, HTTPException, Request, Query
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

_SLUG_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$")


def _slugify(value: str) -> str:
    out = re.sub(r"[^a-z0-9]+", "-", (value or "").lower()).strip("-")
    return out[:64] or f"page-{uuid.uuid4().hex[:8]}"


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------
class LandingPageIn(BaseModel):
    slug: Optional[str] = Field(default=None, max_length=64)
    title: str = Field(min_length=1, max_length=160)
    intro_html: str = Field(default="", max_length=8000)
    cta_label: str = Field(default="Download", max_length=80)
    file_key: Optional[str] = None
    file_name: Optional[str] = None
    bullets: List[str] = Field(default_factory=list)
    active: bool = True


class LandingPagePatch(BaseModel):
    slug: Optional[str] = Field(default=None, max_length=64)
    title: Optional[str] = Field(default=None, max_length=160)
    intro_html: Optional[str] = Field(default=None, max_length=8000)
    cta_label: Optional[str] = Field(default=None, max_length=80)
    file_key: Optional[str] = None
    file_name: Optional[str] = None
    bullets: Optional[List[str]] = None
    active: Optional[bool] = None


# ---------------------------------------------------------------------------
# Router factory — mirrors the convention used by other route modules so
# the main server.py can pass `db`, `require_role`, etc. in.
# ---------------------------------------------------------------------------
def build_router(*, db, require_role, sanitize_html):
    router = APIRouter()

    # ----- Admin: list / create / update / delete -----------------------

    @router.get("/admin/landing-pages")
    async def list_pages(_: dict = Depends(require_role("admin"))):
        items: list[dict] = []
        async for p in db.landing_pages.find({}, {"_id": 0}).sort("created_at", -1):
            # Hydrate live counts so the list view shows engagement at a
            # glance without N+1 calls.
            views = await db.landing_page_visits.count_documents({"page_id": p["id"], "outcome": "view"})
            downloads = await db.landing_page_visits.count_documents({"page_id": p["id"], "outcome": "download"})
            p["views"] = views
            p["downloads"] = downloads
            items.append(p)
        return {"items": items}

    async def _ensure_unique_slug(slug: str, exclude_id: str | None = None) -> None:
        q: dict = {"slug": slug}
        if exclude_id:
            q["id"] = {"$ne": exclude_id}
        if await db.landing_pages.find_one(q, {"_id": 1}):
            raise HTTPException(409, f"Slug '{slug}' is already in use")

    @router.post("/admin/landing-pages")
    async def create_page(body: LandingPageIn, user: dict = Depends(require_role("admin"))):
        slug = _slugify(body.slug or body.title)
        if not _SLUG_RE.match(slug):
            raise HTTPException(400, "Invalid slug")
        await _ensure_unique_slug(slug)
        now = datetime.now(timezone.utc).isoformat()
        doc = {
            "id": str(uuid.uuid4()),
            "slug": slug,
            "title": body.title.strip(),
            "intro_html": sanitize_html(body.intro_html or ""),
            "cta_label": (body.cta_label or "Download").strip(),
            "file_key": (body.file_key or "").strip() or None,
            "file_name": (body.file_name or "").strip() or None,
            "bullets": [b.strip() for b in (body.bullets or []) if b and b.strip()][:12],
            "active": bool(body.active),
            "created_at": now,
            "updated_at": now,
            "created_by_id": user.get("user_id") or user.get("id"),
            "created_by_email": user.get("email"),
        }
        await db.landing_pages.insert_one(doc)
        doc.pop("_id", None)
        return doc

    @router.patch("/admin/landing-pages/{page_id}")
    async def update_page(
        page_id: str, body: LandingPagePatch,
        _: dict = Depends(require_role("admin")),
    ):
        existing = await db.landing_pages.find_one({"id": page_id}, {"_id": 0})
        if not existing:
            raise HTTPException(404, "Page not found")
        update: dict = {}
        if body.slug is not None:
            new_slug = _slugify(body.slug)
            if new_slug != existing.get("slug"):
                if not _SLUG_RE.match(new_slug):
                    raise HTTPException(400, "Invalid slug")
                await _ensure_unique_slug(new_slug, exclude_id=page_id)
                update["slug"] = new_slug
        if body.title is not None:
            update["title"] = body.title.strip()
        if body.intro_html is not None:
            update["intro_html"] = sanitize_html(body.intro_html)
        if body.cta_label is not None:
            update["cta_label"] = body.cta_label.strip() or "Download"
        if body.file_key is not None:
            update["file_key"] = body.file_key.strip() or None
        if body.file_name is not None:
            update["file_name"] = body.file_name.strip() or None
        if body.bullets is not None:
            update["bullets"] = [b.strip() for b in body.bullets if b and b.strip()][:12]
        if body.active is not None:
            update["active"] = bool(body.active)
        if not update:
            return existing
        update["updated_at"] = datetime.now(timezone.utc).isoformat()
        await db.landing_pages.update_one({"id": page_id}, {"$set": update})
        doc = await db.landing_pages.find_one({"id": page_id}, {"_id": 0})
        return doc

    @router.delete("/admin/landing-pages/{page_id}")
    async def delete_page(page_id: str, _: dict = Depends(require_role("admin"))):
        # Hard delete the page row; visit history is kept so audit logs
        # remain intact even after a page is removed.
        r = await db.landing_pages.delete_one({"id": page_id})
        if r.deleted_count == 0:
            raise HTTPException(404, "Page not found")
        return {"ok": True}

    @router.get("/admin/landing-pages/{page_id}/stats")
    async def page_stats(
        page_id: str,
        limit: int = Query(200, ge=1, le=2000),
        _: dict = Depends(require_role("admin")),
    ):
        page = await db.landing_pages.find_one({"id": page_id}, {"_id": 0})
        if not page:
            raise HTTPException(404, "Page not found")
        visits: list[dict] = []
        async for v in db.landing_page_visits.find({"page_id": page_id}, {"_id": 0}) \
                .sort("at", -1).limit(limit):
            visits.append(v)
        return {
            "page": page,
            "visits": visits,
            "views": await db.landing_page_visits.count_documents({"page_id": page_id, "outcome": "view"}),
            "downloads": await db.landing_page_visits.count_documents({"page_id": page_id, "outcome": "download"}),
        }

    # ----- Public: view / download --------------------------------------

    async def _record_visit(*, page: dict, request: Request, outcome: str, token: str | None) -> None:
        # Resolve the optional X-CM-Send-Id token back to an email_sends
        # row so we can attribute the visit to a specific contact.
        send_row = None
        if token:
            send_row = await db.email_sends.find_one(
                {"$or": [{"id": token}, {"send_id": token}]},
                {"_id": 0, "id": 1, "contact_id": 1},
            )
        await db.landing_page_visits.insert_one({
            "id": str(uuid.uuid4()),
            "page_id": page["id"],
            "page_slug": page["slug"],
            "at": datetime.now(timezone.utc).isoformat(),
            "ip": (request.client.host if request.client else None),
            "user_agent": (request.headers.get("user-agent") or "")[:300],
            "referrer": (request.headers.get("referer") or "")[:500] or None,
            "outcome": outcome,
            "token": token,
            "email_send_id": (send_row or {}).get("id"),
            "contact_id": (send_row or {}).get("contact_id"),
        })

    @router.get("/public/landing/{slug}")
    async def public_landing(
        slug: str,
        request: Request,
        t: Optional[str] = None,
    ):
        page = await db.landing_pages.find_one(
            {"slug": slug, "active": True},
            {"_id": 0},
        )
        if not page:
            raise HTTPException(404, "Page not found")
        await _record_visit(page=page, request=request, outcome="view", token=t)
        # Don't leak admin metadata to the public renderer.
        return {
            "id": page["id"],
            "slug": page["slug"],
            "title": page.get("title"),
            "intro_html": page.get("intro_html") or "",
            "cta_label": page.get("cta_label") or "Download",
            "bullets": page.get("bullets") or [],
            "has_file": bool(page.get("file_key")),
            "file_name": page.get("file_name"),
        }

    @router.get("/public/landing/{slug}/download")
    async def public_download(
        slug: str,
        request: Request,
        t: Optional[str] = None,
    ):
        page = await db.landing_pages.find_one(
            {"slug": slug, "active": True},
            {"_id": 0},
        )
        if not page:
            raise HTTPException(404, "Page not found")
        if not page.get("file_key"):
            raise HTTPException(404, "No file attached")
        await _record_visit(page=page, request=request, outcome="download", token=t)
        try:
            from file_storage import presigned_get_url  # type: ignore
        except Exception:  # noqa: BLE001
            raise HTTPException(500, "File storage not configured")
        try:
            # Short-lived URL — the recipient is redirected straight
            # into the download, so 5 minutes is plenty.
            url = presigned_get_url(page["file_key"], expires_in=300)
        except Exception as e:  # noqa: BLE001
            logger.exception("presigned_get_url failed for %s: %s", page["file_key"], e)
            raise HTTPException(500, "Could not generate download URL")
        return RedirectResponse(url, status_code=302)

    return router
