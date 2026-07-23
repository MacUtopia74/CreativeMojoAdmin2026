"""Admin — Contract Templates (Phase 1A).

Routes gated by ``require_role("admin")``. Endpoints follow the
established Hub convention: ``/admin/contract-templates/...``,
UUID string IDs, ``_id`` never leaked back to the client.

Collections owned by this module:
- ``contract_templates``            — one doc per template (master).
- ``contract_template_versions``    — append-only history.

Phase 1A ships everything required for Section 35's Phase 1 completion
test: PDF upload → conversion → correction → editing → versioning →
preview. Contract issuance / signing / renewal are OUT of scope here.
"""
from __future__ import annotations

import io
import logging
import os
import re
import uuid
import base64
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form, Query
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field

import contract_placeholders as placeholders_module
import contract_branding as branding_module
import contract_numbering as numbering_module
import contract_pdf_pipeline as pdf_pipeline

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
CONTRACT_TYPES = {
    "new_franchise",
    "franchise_renewal",
    "licence",
    "licence_renewal",
    "territory_amendment",
    "other",
}
STATUSES = {"draft", "current", "archived"}

TEMPLATES_COLLECTION = "contract_templates"
VERSIONS_COLLECTION = "contract_template_versions"

# R2 key layout — kept flat so a single ListPrefix returns everything
# that belongs to one template.
R2_PREFIX = "contract-templates"
SOURCE_PDF_NAME = "source.pdf"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _new_id() -> str:
    return str(uuid.uuid4())


# ---------------------------------------------------------------------------
# Pydantic bodies
# ---------------------------------------------------------------------------
class CreateBlankIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    contract_type: str = "other"


class DraftIn(BaseModel):
    content_html: str


class SaveVersionIn(BaseModel):
    content_html: str
    change_note: Optional[str] = None


class RenameIn(BaseModel):
    name: Optional[str] = None
    contract_type: Optional[str] = None


class SetDefaultIn(BaseModel):
    is_default: bool = True


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _public_view(doc: dict) -> dict:
    """Strip Mongo internals + heavy source_pdf blob before returning."""
    out = dict(doc)
    out.pop("_id", None)
    return out


def _validate_type(t: str) -> str:
    t = (t or "").strip().lower()
    if t not in CONTRACT_TYPES:
        raise HTTPException(400, detail=f"contract_type must be one of {sorted(CONTRACT_TYPES)}")
    return t


async def _create_version(db, template_id: str, content_html: str,
                           change_note: str, created_by: str) -> int:
    """Bump ``current_version`` on the template and append an immutable
    row to the versions collection. Returns the new version number."""
    tpl = await db[TEMPLATES_COLLECTION].find_one({"id": template_id})
    if not tpl:
        raise HTTPException(404, detail="Template not found")
    next_ver = int(tpl.get("current_version", 0)) + 1
    version_doc = {
        "id": _new_id(),
        "template_id": template_id,
        "version_number": next_ver,
        "content_html": content_html,
        "change_note": change_note or "",
        "created_at": _now_iso(),
        "created_by": created_by,
    }
    await db[VERSIONS_COLLECTION].insert_one(version_doc)
    await db[TEMPLATES_COLLECTION].update_one(
        {"id": template_id},
        {"$set": {
            "current_version": next_ver,
            "current_content_html": content_html,
            "updated_at": _now_iso(),
            "updated_by": created_by,
        }},
    )
    return next_ver


def _r2_key(template_id: str, name: str) -> str:
    return f"{R2_PREFIX}/{template_id}/{name}"


def _r2_put(bytes_body: bytes, key: str, content_type: str = "application/octet-stream") -> None:
    """Upload a bytes payload to R2. Silent no-op if R2 isn't configured
    (dev)."""
    from file_storage import get_client, R2_BUCKET, r2_configured
    if not r2_configured():
        logger.warning("R2 not configured — skipping upload of %s", key)
        return
    client = get_client()
    client.put_object(
        Bucket=R2_BUCKET, Key=key, Body=bytes_body, ContentType=content_type,
    )


def _r2_get_bytes(key: str) -> Optional[bytes]:
    from file_storage import get_client, R2_BUCKET, r2_configured
    if not r2_configured():
        return None
    try:
        obj = get_client().get_object(Bucket=R2_BUCKET, Key=key)
        return obj["Body"].read()
    except Exception as exc:  # noqa: BLE001
        logger.warning("R2 get_object %s failed: %s", key, exc)
        return None


# ---------------------------------------------------------------------------
# Router factory
# ---------------------------------------------------------------------------
def attach(api, db, require_role):
    """Register all contract-template routes on ``api``."""

    # -----------------------------------------------------------------
    # Placeholders + branding
    # -----------------------------------------------------------------
    @api.get("/admin/contract-templates/placeholders")
    async def list_placeholders(_: dict = Depends(require_role("admin"))):
        return {"placeholders": placeholders_module.registry()}

    @api.get("/admin/contract-templates/branding")
    async def get_branding(_: dict = Depends(require_role("admin"))):
        # Phase 1A branding is read-only — surface it so the editor's
        # digital preview can render the same header/footer as the PDF.
        return {
            "logo_url": branding_module.LOGO_STATIC_PATH,
            "header_html": branding_module.HEADER_HTML.format(
                logo=branding_module.LOGO_STATIC_PATH,
            ),
            "footer_html": branding_module.FOOTER_HTML,
            "print_css": branding_module.PRINT_CSS,
        }

    # -----------------------------------------------------------------
    # Create blank template (no PDF)
    # -----------------------------------------------------------------
    @api.post("/admin/contract-templates")
    async def create_blank(
        body: CreateBlankIn,
        user: dict = Depends(require_role("admin")),
    ):
        ctype = _validate_type(body.contract_type)
        tid = _new_id()
        doc = {
            "id": tid,
            "name": body.name.strip(),
            "contract_type": ctype,
            "status": "draft",
            "is_default": False,
            "current_version": 0,
            "conversion_approved": False,
            "source_pdf": None,
            "current_content_html": "<h1>Untitled</h1><p>Start typing…</p>",
            "conversion_report": None,
            "created_at": _now_iso(),
            "updated_at": _now_iso(),
            "created_by": user.get("email"),
            "updated_by": user.get("email"),
        }
        await db[TEMPLATES_COLLECTION].insert_one(doc)
        # Blank template still gets a v1 so history is contiguous.
        await _create_version(
            db, tid, doc["current_content_html"],
            "Blank template created", user.get("email"),
        )
        return _public_view(await db[TEMPLATES_COLLECTION].find_one({"id": tid}))

    # -----------------------------------------------------------------
    # Upload PDF → convert → template
    # -----------------------------------------------------------------
    @api.post("/admin/contract-templates/upload-pdf")
    async def upload_pdf(
        pdf: UploadFile = File(...),
        name: str = Form(...),
        contract_type: str = Form("other"),
        user: dict = Depends(require_role("admin")),
    ):
        ctype = _validate_type(contract_type)
        if not pdf.filename or not pdf.filename.lower().endswith(".pdf"):
            raise HTTPException(400, detail="Please upload a PDF file.")
        pdf_bytes = await pdf.read()
        if not pdf_bytes:
            raise HTTPException(400, detail="Uploaded file is empty.")

        # 1) Extract text + image blocks from the PDF (fast, local).
        try:
            extraction = pdf_pipeline.extract_blocks(pdf_bytes)
        except Exception as exc:  # noqa: BLE001
            logger.exception("PDF extraction failed")
            raise HTTPException(400, detail=f"PDF extraction failed: {exc}") from exc

        # 2) Send to Claude Sonnet 4.5 for semantic HTML cleanup.
        emergent_key = os.environ.get("EMERGENT_LLM_KEY")
        if not emergent_key:
            raise HTTPException(
                500,
                detail="EMERGENT_LLM_KEY missing — cannot run PDF conversion cleanup.",
            )
        try:
            html = await pdf_pipeline.convert_to_html(extraction.lines, emergent_key)
        except Exception as exc:  # noqa: BLE001
            logger.exception("LLM cleanup failed")
            raise HTTPException(502, detail=f"Conversion cleanup failed: {exc}") from exc

        # 3) Verbatim diff — capture missing / added phrases so HQ can
        #    review before approving conversion.
        report = pdf_pipeline.verify_verbatim(extraction.plain_text, html)
        report["page_count"] = extraction.page_count
        report["image_count"] = len(extraction.images)
        report["generated_at"] = _now_iso()

        # 4) Persist template + upload original PDF to R2.
        tid = _new_id()
        pdf_key = _r2_key(tid, SOURCE_PDF_NAME)
        _r2_put(pdf_bytes, pdf_key, content_type="application/pdf")

        doc = {
            "id": tid,
            "name": name.strip() or pdf.filename,
            "contract_type": ctype,
            "status": "draft",
            "is_default": False,
            "current_version": 0,
            "conversion_approved": False,
            "source_pdf": {
                "r2_key": pdf_key,
                "filename": pdf.filename,
                "byte_size": len(pdf_bytes),
                "uploaded_at": _now_iso(),
            },
            "current_content_html": html,
            "conversion_report": report,
            "created_at": _now_iso(),
            "updated_at": _now_iso(),
            "created_by": user.get("email"),
            "updated_by": user.get("email"),
        }
        await db[TEMPLATES_COLLECTION].insert_one(doc)
        await _create_version(
            db, tid, html,
            f"Converted from PDF ({pdf.filename})",
            user.get("email"),
        )
        return _public_view(await db[TEMPLATES_COLLECTION].find_one({"id": tid}))

    # -----------------------------------------------------------------
    # List & detail
    # -----------------------------------------------------------------
    @api.get("/admin/contract-templates")
    async def list_templates(
        status: Optional[str] = None,
        contract_type: Optional[str] = None,
        _: dict = Depends(require_role("admin")),
    ):
        q: dict = {}
        if status:
            if status not in STATUSES:
                raise HTTPException(400, detail=f"status must be one of {sorted(STATUSES)}")
            q["status"] = status
        if contract_type:
            _validate_type(contract_type)
            q["contract_type"] = contract_type
        # List view is metadata-only (no huge HTML body).
        proj = {
            "_id": 0, "id": 1, "name": 1, "contract_type": 1,
            "status": 1, "is_default": 1, "current_version": 1,
            "conversion_approved": 1,
            "created_at": 1, "updated_at": 1,
            "created_by": 1, "updated_by": 1,
            "source_pdf.filename": 1, "source_pdf.byte_size": 1,
            "conversion_report.score": 1,
            "conversion_report.total_missing": 1,
            "conversion_report.total_added": 1,
        }
        cursor = db[TEMPLATES_COLLECTION].find(q, proj).sort("updated_at", -1)
        items = await cursor.to_list(500)
        return {"items": items, "count": len(items)}

    @api.get("/admin/contract-templates/{template_id}")
    async def get_template(template_id: str, _: dict = Depends(require_role("admin"))):
        doc = await db[TEMPLATES_COLLECTION].find_one({"id": template_id})
        if not doc:
            raise HTTPException(404, detail="Template not found")
        return _public_view(doc)

    # -----------------------------------------------------------------
    # Draft autosave (NO version created)
    # -----------------------------------------------------------------
    @api.patch("/admin/contract-templates/{template_id}/draft")
    async def save_draft(
        template_id: str,
        body: DraftIn,
        user: dict = Depends(require_role("admin")),
    ):
        r = await db[TEMPLATES_COLLECTION].update_one(
            {"id": template_id},
            {"$set": {
                "current_content_html": body.content_html,
                "updated_at": _now_iso(),
                "updated_by": user.get("email"),
            }},
        )
        if not r.matched_count:
            raise HTTPException(404, detail="Template not found")
        return {"ok": True, "saved_at": _now_iso()}

    # -----------------------------------------------------------------
    # Explicit Save-Version (creates immutable history entry)
    # -----------------------------------------------------------------
    @api.post("/admin/contract-templates/{template_id}/versions")
    async def create_version(
        template_id: str,
        body: SaveVersionIn,
        user: dict = Depends(require_role("admin")),
    ):
        ver = await _create_version(
            db, template_id, body.content_html,
            body.change_note or "Version saved by HQ",
            user.get("email"),
        )
        return {"ok": True, "version_number": ver}

    @api.get("/admin/contract-templates/{template_id}/versions")
    async def list_versions(template_id: str, _: dict = Depends(require_role("admin"))):
        cursor = db[VERSIONS_COLLECTION].find(
            {"template_id": template_id},
            {"_id": 0, "id": 1, "version_number": 1, "change_note": 1,
             "created_at": 1, "created_by": 1},
        ).sort("version_number", -1)
        items = await cursor.to_list(200)
        return {"items": items}

    @api.get("/admin/contract-templates/{template_id}/versions/{version_number}")
    async def get_version(
        template_id: str, version_number: int,
        _: dict = Depends(require_role("admin")),
    ):
        doc = await db[VERSIONS_COLLECTION].find_one(
            {"template_id": template_id, "version_number": version_number},
            {"_id": 0},
        )
        if not doc:
            raise HTTPException(404, detail="Version not found")
        return doc

    @api.post("/admin/contract-templates/{template_id}/rollback/{version_number}")
    async def rollback(
        template_id: str, version_number: int,
        user: dict = Depends(require_role("admin")),
    ):
        target = await db[VERSIONS_COLLECTION].find_one(
            {"template_id": template_id, "version_number": version_number},
        )
        if not target:
            raise HTTPException(404, detail="Version not found")
        new_ver = await _create_version(
            db, template_id, target["content_html"],
            f"Restored from version {version_number}",
            user.get("email"),
        )
        return {"ok": True, "version_number": new_ver}

    # -----------------------------------------------------------------
    # Approve conversion (strips original numbers, creates auto version)
    # -----------------------------------------------------------------
    @api.post("/admin/contract-templates/{template_id}/approve-conversion")
    async def approve_conversion(
        template_id: str,
        user: dict = Depends(require_role("admin")),
    ):
        doc = await db[TEMPLATES_COLLECTION].find_one({"id": template_id})
        if not doc:
            raise HTTPException(404, detail="Template not found")
        if doc.get("conversion_approved"):
            return {"ok": True, "already_approved": True}
        html = doc.get("current_content_html", "")
        stripped = numbering_module.strip_imported_numbers(html)
        await db[TEMPLATES_COLLECTION].update_one(
            {"id": template_id},
            {"$set": {
                "current_content_html": stripped,
                "conversion_approved": True,
                "conversion_approved_at": _now_iso(),
                "conversion_approved_by": user.get("email"),
                "updated_at": _now_iso(),
                "updated_by": user.get("email"),
            }},
        )
        new_ver = await _create_version(
            db, template_id, stripped,
            "Conversion approved (imported numbering stripped)",
            user.get("email"),
        )
        return {"ok": True, "version_number": new_ver}

    # -----------------------------------------------------------------
    # Status transitions
    # -----------------------------------------------------------------
    @api.post("/admin/contract-templates/{template_id}/publish")
    async def publish(template_id: str, user: dict = Depends(require_role("admin"))):
        doc = await db[TEMPLATES_COLLECTION].find_one({"id": template_id})
        if not doc:
            raise HTTPException(404, detail="Template not found")
        if not doc.get("conversion_approved"):
            raise HTTPException(
                400,
                detail="Approve the conversion before publishing so authoritative numbering is in effect.",
            )
        await db[TEMPLATES_COLLECTION].update_one(
            {"id": template_id},
            {"$set": {
                "status": "current",
                "published_at": _now_iso(),
                "published_by": user.get("email"),
                "updated_at": _now_iso(),
                "updated_by": user.get("email"),
            }},
        )
        new_ver = await _create_version(
            db, template_id, doc.get("current_content_html", ""),
            "Published (status → current)",
            user.get("email"),
        )
        return {"ok": True, "version_number": new_ver}

    @api.post("/admin/contract-templates/{template_id}/archive")
    async def archive(template_id: str, user: dict = Depends(require_role("admin"))):
        r = await db[TEMPLATES_COLLECTION].update_one(
            {"id": template_id},
            {"$set": {
                "status": "archived",
                "is_default": False,   # archived cannot be the default
                "updated_at": _now_iso(),
                "updated_by": user.get("email"),
            }},
        )
        if not r.matched_count:
            raise HTTPException(404, detail="Template not found")
        return {"ok": True}

    @api.post("/admin/contract-templates/{template_id}/set-default")
    async def set_default(
        template_id: str,
        body: SetDefaultIn,
        user: dict = Depends(require_role("admin")),
    ):
        doc = await db[TEMPLATES_COLLECTION].find_one({"id": template_id})
        if not doc:
            raise HTTPException(404, detail="Template not found")
        if body.is_default and doc.get("status") == "archived":
            raise HTTPException(400, detail="Archived templates cannot be set as default.")
        # Clear the default flag on siblings of the same type first.
        if body.is_default:
            await db[TEMPLATES_COLLECTION].update_many(
                {"contract_type": doc["contract_type"], "is_default": True, "id": {"$ne": template_id}},
                {"$set": {"is_default": False, "updated_at": _now_iso()}},
            )
        await db[TEMPLATES_COLLECTION].update_one(
            {"id": template_id},
            {"$set": {
                "is_default": bool(body.is_default),
                "updated_at": _now_iso(),
                "updated_by": user.get("email"),
            }},
        )
        return {"ok": True, "is_default": bool(body.is_default)}

    @api.post("/admin/contract-templates/{template_id}/duplicate")
    async def duplicate(template_id: str, user: dict = Depends(require_role("admin"))):
        src = await db[TEMPLATES_COLLECTION].find_one({"id": template_id})
        if not src:
            raise HTTPException(404, detail="Template not found")
        new_id = _new_id()
        clone = {
            "id": new_id,
            "name": f"{src.get('name', 'Untitled')} (copy)",
            "contract_type": src.get("contract_type", "other"),
            "status": "draft",
            "is_default": False,
            "current_version": 0,
            "conversion_approved": bool(src.get("conversion_approved", False)),
            "source_pdf": None,   # original stays with the source template
            "current_content_html": src.get("current_content_html", ""),
            "conversion_report": src.get("conversion_report"),
            "created_at": _now_iso(),
            "updated_at": _now_iso(),
            "created_by": user.get("email"),
            "updated_by": user.get("email"),
        }
        await db[TEMPLATES_COLLECTION].insert_one(clone)
        await _create_version(
            db, new_id, clone["current_content_html"],
            f"Duplicated from template {template_id}",
            user.get("email"),
        )
        return _public_view(await db[TEMPLATES_COLLECTION].find_one({"id": new_id}))

    @api.patch("/admin/contract-templates/{template_id}")
    async def rename(
        template_id: str,
        body: RenameIn,
        user: dict = Depends(require_role("admin")),
    ):
        update: dict = {}
        if body.name is not None:
            n = body.name.strip()
            if not n:
                raise HTTPException(400, detail="Name cannot be empty.")
            update["name"] = n
        if body.contract_type is not None:
            update["contract_type"] = _validate_type(body.contract_type)
        if not update:
            raise HTTPException(400, detail="Nothing to update.")
        update["updated_at"] = _now_iso()
        update["updated_by"] = user.get("email")
        r = await db[TEMPLATES_COLLECTION].update_one(
            {"id": template_id}, {"$set": update},
        )
        if not r.matched_count:
            raise HTTPException(404, detail="Template not found")
        return {"ok": True}

    # -----------------------------------------------------------------
    # Source PDF download
    # -----------------------------------------------------------------
    @api.get("/admin/contract-templates/{template_id}/source-pdf")
    async def download_source_pdf(
        template_id: str,
        _: dict = Depends(require_role("admin")),
    ):
        doc = await db[TEMPLATES_COLLECTION].find_one({"id": template_id})
        if not doc:
            raise HTTPException(404, detail="Template not found")
        src = doc.get("source_pdf") or {}
        key = src.get("r2_key")
        if not key:
            raise HTTPException(404, detail="No source PDF on file for this template.")
        raw = _r2_get_bytes(key)
        if raw is None:
            raise HTTPException(502, detail="Source PDF unavailable — R2 fetch failed.")
        filename = src.get("filename") or "source.pdf"
        return Response(
            content=raw, media_type="application/pdf",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )

    # -----------------------------------------------------------------
    # PDF preview (WeasyPrint)
    # -----------------------------------------------------------------
    @api.post("/admin/contract-templates/{template_id}/preview-pdf")
    async def preview_pdf(
        template_id: str,
        _: dict = Depends(require_role("admin")),
    ):
        doc = await db[TEMPLATES_COLLECTION].find_one({"id": template_id})
        if not doc:
            raise HTTPException(404, detail="Template not found")

        html = doc.get("current_content_html", "")

        # Authoritative numbering — only kicks in once HQ approves.
        if doc.get("conversion_approved"):
            html = numbering_module.apply_legal_numbering(html)

        # Replace placeholder chips with their sample values so the
        # reader sees a realistic layout in preview mode.
        samples = placeholders_module.sample_values()
        def sub_placeholder(m: re.Match) -> str:
            token = m.group(1)
            return samples.get(token, f"[[{token}]]")
        html = re.sub(
            r'<span[^>]*data-placeholder="([^"]+)"[^>]*>.*?</span>',
            sub_placeholder, html, flags=re.DOTALL | re.IGNORECASE,
        )
        # Also swap any surviving bare ``{{token}}`` for the sample.
        html = re.sub(
            r"\{\{\s*([a-z0-9_]+)\s*\}\}",
            sub_placeholder, html, flags=re.IGNORECASE,
        )

        # Build the full HTML document that WeasyPrint renders.
        # We embed the branding running elements at the top so
        # WeasyPrint's ``position: running(...)`` picks them up.
        full_doc = f"""<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>{doc.get('name', 'Contract')}</title>
  <style>{branding_module.PRINT_CSS}</style>
</head>
<body class="cm-doc">
  {branding_module.HEADER_HTML.format(logo=branding_module.LOGO_STATIC_PATH)}
  {branding_module.FOOTER_HTML}
  {html}
</body>
</html>"""

        # WeasyPrint is CPU-heavy — run in default sync mode; the doc
        # is small enough (~1-2s for a 40-page contract).
        try:
            from weasyprint import HTML
            pdf_io = io.BytesIO()
            HTML(string=full_doc, base_url=os.environ.get("REACT_APP_BACKEND_URL", "")).write_pdf(pdf_io)
            pdf_io.seek(0)
        except Exception as exc:  # noqa: BLE001
            logger.exception("WeasyPrint render failed")
            raise HTTPException(500, detail=f"PDF preview failed: {exc}") from exc

        filename = re.sub(r"[^a-z0-9_-]+", "-", (doc.get("name") or "contract").lower()).strip("-")
        return StreamingResponse(
            pdf_io, media_type="application/pdf",
            headers={"Content-Disposition": f'inline; filename="{filename}-preview.pdf"'},
        )

    return api
