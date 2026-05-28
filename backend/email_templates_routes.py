"""Email Templates — admin-side CRUD for reusable outbound emails.

Stage 1 of the email reply feature: persist + edit + duplicate. Stage 2
(post-deploy) will wire up Resend send + open/click tracking using these
templates. Storage is kept deliberately simple — one document per
template, full body stored as HTML, attachments stored as R2 file keys
which get resolved to fresh signed URLs at send time so links never
expire.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class EmailAttachment(BaseModel):
    """A linked file inside a template body. The R2 ``key`` is stored so
    we can mint a fresh signed URL at send time — that way templates
    don't break when a 30-day share link expires."""

    key: str                       # R2 object key, e.g. "creative-mojo/Franchise Pack 2026.pdf"
    name: str                      # Display label, e.g. "Creative Mojo Franchise Pack 2026"
    placeholder: Optional[str] = None  # Body placeholder like "{{file:franchise_pack}}"


class EmailTemplate(BaseModel):
    """Top-level template document.

    ``body_html`` is rich HTML (output of the WYSIWYG editor) with two
    classes of placeholder:
      • ``{{first_name}}`` — replaced with the contact's first name at
        send time. (We deliberately keep the variable set tiny in v1.)
      • Anchor tags whose ``href`` is a ``{{file:<placeholder>}}`` token,
        resolved to a fresh signed share URL just before despatch.
    """

    name: str
    subject: str = ""
    body_html: str = ""
    default_from: Optional[str] = None        # e.g. "paul@creativemojo.co.uk"
    sender_name: Optional[str] = None         # e.g. "Paul Caldeira-Dunkerley"
    default_cc: list[str] = Field(default_factory=list)
    default_bcc: list[str] = Field(default_factory=list)
    attachments: list[EmailAttachment] = Field(default_factory=list)
    category: Optional[str] = None            # free-text tag — e.g. "franchise" / "licence"


def build_email_templates_router(db, require_role):  # noqa: D401
    router = APIRouter()

    async def _serialise(doc: dict) -> dict:
        # Drop Mongo's _id, keep everything else.
        doc.pop("_id", None)
        return doc

    @router.get("/email-templates")
    async def list_templates(_user: dict = Depends(require_role("admin"))):
        cur = db.email_templates.find({}, {"_id": 0}).sort("updated_at", -1)
        items = await cur.to_list(500)
        return {"items": items, "count": len(items)}

    @router.get("/email-templates/{template_id}")
    async def get_template(template_id: str, _user: dict = Depends(require_role("admin"))):
        doc = await db.email_templates.find_one({"id": template_id}, {"_id": 0})
        if not doc:
            raise HTTPException(404, detail="Template not found")
        return doc

    @router.post("/email-templates")
    async def create_template(body: EmailTemplate, user: dict = Depends(require_role("admin"))):
        if not body.name.strip():
            raise HTTPException(400, detail="Template name is required")
        doc = body.model_dump()
        doc["id"] = str(uuid.uuid4())
        doc["created_at"] = _now_iso()
        doc["created_by"] = user.get("email")
        doc["updated_at"] = doc["created_at"]
        doc["updated_by"] = user.get("email")
        await db.email_templates.insert_one(doc)
        return await _serialise(doc)

    @router.patch("/email-templates/{template_id}")
    async def update_template(
        template_id: str,
        body: dict,
        user: dict = Depends(require_role("admin")),
    ):
        existing = await db.email_templates.find_one({"id": template_id}, {"_id": 0})
        if not existing:
            raise HTTPException(404, detail="Template not found")
        # Only allow these keys through; ignore anything else the
        # frontend might accidentally pass.
        EDITABLE = {
            "name", "subject", "body_html", "default_from", "sender_name",
            "default_cc", "default_bcc", "attachments", "category",
        }
        update = {k: v for k, v in (body or {}).items() if k in EDITABLE}
        if not update:
            raise HTTPException(400, detail="No editable fields provided")
        update["updated_at"] = _now_iso()
        update["updated_by"] = user.get("email")
        await db.email_templates.update_one({"id": template_id}, {"$set": update})
        merged = {**existing, **update}
        return merged

    @router.delete("/email-templates/{template_id}")
    async def delete_template(template_id: str, _user: dict = Depends(require_role("admin"))):
        r = await db.email_templates.delete_one({"id": template_id})
        if r.deleted_count == 0:
            raise HTTPException(404, detail="Template not found")
        return {"ok": True}

    @router.post("/email-templates/{template_id}/duplicate")
    async def duplicate_template(template_id: str, user: dict = Depends(require_role("admin"))):
        original = await db.email_templates.find_one({"id": template_id}, {"_id": 0})
        if not original:
            raise HTTPException(404, detail="Template not found")
        clone = dict(original)
        clone["id"] = str(uuid.uuid4())
        clone["name"] = f"{original.get('name', 'Untitled')} (copy)"
        clone["created_at"] = _now_iso()
        clone["created_by"] = user.get("email")
        clone["updated_at"] = clone["created_at"]
        clone["updated_by"] = user.get("email")
        await db.email_templates.insert_one(clone)
        return await _serialise(clone)

    @router.post("/email-templates/refresh-signature")
    async def refresh_signature(user: dict = Depends(require_role("admin"))):
        """Re-apply the latest ``SIGNATURE_HTML`` constant from
        ``seed_email_templates.py`` to every template that contains the
        old marker (``Best Regards,``). Replaces from "Have a great day."
        downwards so the per-template body above stays intact. Safe to
        re-run — idempotent on already-updated templates.
        """
        from seed_email_templates import SIGNATURE_HTML  # local import to avoid cycle
        import re
        updated = 0
        skipped = 0
        async for tpl in db.email_templates.find({}, {"_id": 0, "id": 1, "body_html": 1, "name": 1}):
            body = tpl.get("body_html") or ""
            # Find the "Have a great day." paragraph and everything after.
            # Tolerant to slight markup variants (extra spaces, &nbsp; etc.).
            split_re = re.compile(r"<p[^>]*>\s*Have a great day\.\s*</p>", re.IGNORECASE)
            m = split_re.search(body)
            if not m:
                skipped += 1
                continue
            new_body = body[: m.start()] + SIGNATURE_HTML.strip()
            await db.email_templates.update_one(
                {"id": tpl["id"]},
                {"$set": {
                    "body_html": new_body,
                    "updated_at": _now_iso(),
                    "updated_by": user.get("email"),
                }},
            )
            updated += 1
        return {"updated": updated, "skipped": skipped}

    return router
