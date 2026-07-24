"""Admin — Contract Templates (Phase 1A, fixed-PDF marker approach).

Retained routes:
  - Templates list / detail / rename / publish / archive / duplicate /
    set-default
  - Source PDF download (from R2)
  - Upload job status polling
  - Blank-template create (kept for backwards compat with tests)

New routes:
  - POST /admin/contract-templates/upload-marker-pdf   (async, no LLM)
  - GET  /admin/contract-templates/{id}/marker-summary

Retired routes (moved to /app/backend/_legacy/):
  - upload-pdf (sync, LLM)
  - upload-pdf-async
  - upload-async (DOCX branch)
  - approve-conversion (imported-numbering strip)
  - preview-pdf (WeasyPrint HTML→PDF)
  - draft (HTML autosave)
  - versions (HTML snapshots)
  - rollback (HTML snapshot restore)
  - source-docx
  - placeholders (legacy Tiptap {{}} placeholders)
  - branding

Collections owned by this module:
  - contract_templates
  - contract_template_versions
  - contract_upload_jobs

All routes require admin role.
"""
from __future__ import annotations

import asyncio
import io
import logging
import os
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import Depends, HTTPException, UploadFile, File, Form, Query
from fastapi.responses import Response

import contract_markers_pipeline as markers_pipeline
import contract_markers_library as markers_library

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

TEMPLATES_COLLECTION = "contract_templates"
VERSIONS_COLLECTION = "contract_template_versions"
JOBS_COLLECTION = "contract_upload_jobs"

# 6-stage progression — matches user's Phase 0 approval spec.
UPLOAD_STAGES = [
    ("uploading",         "Uploading PDF",                5),
    ("extracting-text",   "Extracting text",              25),
    ("detecting-markers", "Detecting markers",            55),
    ("validating",        "Validating against library",   80),
    ("creating",          "Creating template record",     95),
    ("complete",          "Complete",                     100),
]
STAGE_LABELS = {c: l for c, l, _ in UPLOAD_STAGES}
STAGE_PROGRESS = {c: p for c, _, p in UPLOAD_STAGES}

# R2 layout
R2_PREFIX = "contract-templates"
SOURCE_PDF_NAME = "source.pdf"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _new_id() -> str:
    return str(uuid.uuid4())


def _validate_type(ct: str) -> str:
    if ct not in CONTRACT_TYPES:
        raise HTTPException(400, detail=f"contract_type must be one of {sorted(CONTRACT_TYPES)}")
    return ct


def _r2_key(template_id: str, name: str) -> str:
    return f"{R2_PREFIX}/{template_id}/{name}"


def _r2_put(data: bytes, key: str, *, content_type: str = "application/octet-stream") -> None:
    from file_storage import get_client, R2_BUCKET, r2_configured
    if not r2_configured():
        # Local dev fallback — persist to /tmp/mock_r2/
        import pathlib
        base = pathlib.Path("/tmp/mock_r2")
        p = base / key
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
        return
    get_client().put_object(
        Bucket=R2_BUCKET, Key=key, Body=data, ContentType=content_type,
    )


def _r2_get_bytes(key: str) -> Optional[bytes]:
    from file_storage import get_client, R2_BUCKET, r2_configured
    if not r2_configured():
        import pathlib
        p = pathlib.Path("/tmp/mock_r2") / key
        if p.exists():
            return p.read_bytes()
        return None
    try:
        obj = get_client().get_object(Bucket=R2_BUCKET, Key=key)
        return obj["Body"].read()
    except Exception as exc:  # noqa: BLE001
        logger.warning("R2 get_object %s failed: %s", key, exc)
        return None


def _public_view(doc: Dict[str, Any]) -> Dict[str, Any]:
    """Strip Mongo internals + heavy blobs from API responses."""
    if not doc:
        return doc
    out = dict(doc)
    out.pop("_id", None)
    return out


# ---------------------------------------------------------------------------
# Route factory
# ---------------------------------------------------------------------------
def attach(api, db, require_role):
    """Mount all Phase 1A admin routes onto ``api``."""

    # ==========================================================
    # LIST / DETAIL
    # ==========================================================
    @api.get("/admin/contract-templates")
    async def list_templates(
        status: Optional[str] = Query(None),
        contract_type: Optional[str] = Query(None),
        _: dict = Depends(require_role("admin")),
    ):
        q: Dict[str, Any] = {}
        if status:
            q["status"] = status
        if contract_type:
            q["contract_type"] = contract_type
        cur = db[TEMPLATES_COLLECTION].find(q).sort([("updated_at", -1)])
        items = [_public_view(d) async for d in cur]
        return {"items": items, "total": len(items)}

    @api.get("/admin/contract-templates/{template_id}")
    async def get_template(template_id: str, _: dict = Depends(require_role("admin"))):
        doc = await db[TEMPLATES_COLLECTION].find_one({"id": template_id})
        if not doc:
            raise HTTPException(404, detail="Template not found")
        return _public_view(doc)

    # ---- Turn B helpers -----------------------------------------------
    async def _ensure_occurrence_ids(template_id: str, markers: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Lazily assign a stable ``occurrence_id`` to any legacy markers
        that pre-date Turn B. Idempotent — writes back only when needed."""
        needs_write = False
        for m in markers:
            if not m.get("occurrence_id"):
                m["occurrence_id"] = _new_id()
                needs_write = True
        if needs_write:
            await db[TEMPLATES_COLLECTION].update_one(
                {"id": template_id},
                {"$set": {"markers": markers, "updated_at": _now_iso()}},
            )
        return markers

    def _build_substitution_groups(
        markers: List[Dict[str, Any]],
        acknowledgements: Dict[str, Any],
    ) -> List[Dict[str, Any]]:
        """Aggregate markers by source ``font_family``. Each group is
        the unit HQ acknowledges — one tick per family covers every
        occurrence that uses that family."""
        groups: Dict[str, Dict[str, Any]] = {}
        for m in markers:
            family = m.get("font_family") or "(unknown)"
            g = groups.setdefault(family, {
                "font_family": family,
                "substitution_family": m.get("substitution_family"),
                "is_embedded": m.get("is_embedded"),
                "is_reusable": m.get("is_reusable"),
                "occurrence_ids": [],
                "occurrence_count": 0,
                "sample_codes": set(),
            })
            g["occurrence_ids"].append(m.get("occurrence_id"))
            g["occurrence_count"] += 1
            g["sample_codes"].add(m.get("code"))
        out: List[Dict[str, Any]] = []
        for family, g in groups.items():
            ack = acknowledgements.get(family) or {}
            substitution_required = bool(g.get("is_embedded")) and not bool(g.get("is_reusable"))
            out.append({
                "font_family": family,
                "substitution_family": g.get("substitution_family"),
                "is_embedded": g.get("is_embedded"),
                "is_reusable": g.get("is_reusable"),
                "substitution_required": substitution_required,
                "occurrence_count": g["occurrence_count"],
                "occurrence_ids": g["occurrence_ids"],
                "sample_codes": sorted(g["sample_codes"]),
                "acknowledged": bool(ack.get("acknowledged")),
                "acknowledged_by": ack.get("acknowledged_by"),
                "acknowledged_at": ack.get("acknowledged_at"),
            })
        # Deterministic order — families that still need ack first
        out.sort(key=lambda r: (r["acknowledged"], r["font_family"]))
        return out

    @api.get("/admin/contract-templates/{template_id}/marker-summary")
    async def marker_summary(template_id: str, _: dict = Depends(require_role("admin"))):
        """Return the current template's marker layout + summary.

        Recomputes summary against the LIVE library so that if HQ has
        just added a missing marker via the Marker Library UI, the
        template's status refreshes without re-uploading the PDF."""
        doc = await db[TEMPLATES_COLLECTION].find_one({"id": template_id})
        if not doc:
            raise HTTPException(404, detail="Template not found")
        markers = doc.get("markers", []) or []
        markers = await _ensure_occurrence_ids(template_id, markers)
        lib_cur = db[markers_library.LIBRARY_COLLECTION].find({})
        lib_docs = [d async for d in lib_cur]
        # Rebuild the summary from stored markers
        occurrences_stub = []
        for m in markers:
            legacy = tuple(m.get("bbox") or (0, 0, 0, 0))
            tb = tuple(m.get("token_bbox") or legacy)
            rb = tuple(m.get("render_bbox") or legacy)
            occurrences_stub.append(markers_pipeline.MarkerOccurrence(
                code=m["code"], page=m["page"],
                token_bbox=tb, render_bbox=rb, bbox=rb,
                font_family=m.get("font_family"),
                font_size=m.get("font_size"),
                font_weight=m.get("font_weight"),
                font_style=m.get("font_style"),
                font_color=m.get("font_color"),
                is_embedded=m.get("is_embedded"),
                is_reusable=m.get("is_reusable"),
                substitution_family=m.get("substitution_family"),
                reconstructed_from_split=m.get("reconstructed_from_split", False),
                raw_token=m.get("raw_token", ""),
            ))
        summary = markers_pipeline.build_marker_summary(
            occurrences_stub,
            doc.get("cross_line_errors", []) or [],
            lib_docs,
            doc.get("contract_type", "other"),
            doc.get("template_required_codes", []) or [],
        )
        acknowledgements = doc.get("substitution_acknowledgements", {}) or {}
        substitution_groups = _build_substitution_groups(markers, acknowledgements)
        all_required_acked = all(
            (not g["substitution_required"]) or g["acknowledged"]
            for g in substitution_groups
        )
        return {
            "template_id": template_id,
            "pdf_page_count": doc.get("pdf_page_count", 0),
            "pdf_sha256": doc.get("pdf_sha256"),
            "markers": markers,
            "cross_line_errors": doc.get("cross_line_errors", []) or [],
            "summary": summary,
            "substitution_groups": substitution_groups,
            "all_substitutions_acknowledged": all_required_acked,
        }

    # ==========================================================
    # UPLOAD JOB POLLING
    # ==========================================================
    @api.get("/admin/contract-templates/upload-jobs/{job_id}")
    async def get_upload_job(job_id: str, _: dict = Depends(require_role("admin"))):
        job = await db[JOBS_COLLECTION].find_one({"id": job_id})
        if not job:
            raise HTTPException(404, detail="Upload job not found")
        job.pop("_id", None)
        return job

    # ==========================================================
    # UPLOAD — Marker PDF (async)
    # ==========================================================
    async def _update_job(job_id: str, **fields) -> None:
        fields["updated_at"] = _now_iso()
        await db[JOBS_COLLECTION].update_one({"id": job_id}, {"$set": fields})

    async def _set_stage(job_id: str, stage: str, message: Optional[str] = None) -> None:
        await _update_job(
            job_id,
            stage=stage,
            status="running" if stage != "complete" else "complete",
            progress=STAGE_PROGRESS[stage],
            message=message or STAGE_LABELS[stage],
        )

    async def _run_marker_detection_job(
        job_id: str, pdf_bytes: bytes, pdf_filename: str,
        template_name: str, ctype: str, user_email: str,
    ) -> None:
        """Async worker — deterministic. No LLM. Never raises."""
        try:
            tid = _new_id()

            # Stage 1 — extract text (implicit in detect_markers, but we
            # split it in the UI progress bar for clarity)
            await _set_stage(job_id, "extracting-text")

            # Stage 2 — detect markers
            await _set_stage(job_id, "detecting-markers")
            try:
                detection = markers_pipeline.detect_markers(pdf_bytes)
            except Exception as exc:  # noqa: BLE001
                logger.exception("Marker detection failed")
                await _update_job(
                    job_id, status="failed", stage="failed",
                    error=f"Marker detection failed: {exc}",
                )
                return

            # Stage 3 — reconcile against the live library
            await _set_stage(job_id, "validating")
            lib_cur = db[markers_library.LIBRARY_COLLECTION].find({})
            lib_docs = [d async for d in lib_cur]
            summary = markers_pipeline.build_marker_summary(
                detection.markers,
                detection.cross_line_errors,
                lib_docs,
                ctype,
                template_required_codes=[],  # empty at initial upload
            )

            # Stage 4 — persist template + source PDF
            await _set_stage(job_id, "creating")
            pdf_key = _r2_key(tid, SOURCE_PDF_NAME)
            _r2_put(pdf_bytes, pdf_key, content_type="application/pdf")

            # Also store a verification record so we can prove the R2
            # object matches the SHA-256 recorded at upload.
            template_doc = {
                "id": tid,
                "name": template_name.strip() or pdf_filename,
                "contract_type": ctype,
                "status": "draft",
                "is_default": False,
                "current_version": 1,
                "pdf_page_count": detection.pdf_page_count,
                "pdf_sha256": detection.pdf_sha256,
                "source_pdf": {
                    "r2_key": pdf_key,
                    "filename": pdf_filename,
                    "byte_size": len(pdf_bytes),
                    "uploaded_at": _now_iso(),
                    "sha256": detection.pdf_sha256,
                },
                "markers": markers_pipeline.occurrences_for_storage(detection.markers),
                "cross_line_errors": detection.cross_line_errors,
                "marker_summary": summary,
                "template_required_codes": [],
                "detection_meta": {
                    "detection_ms": detection.detection_ms,
                    "span_reconstruction_used": detection.span_reconstruction_used,
                    "engine_version": "phase1a-v1",
                    "llm_used": False,
                },
                "created_at": _now_iso(),
                "updated_at": _now_iso(),
                "created_by": user_email,
                "updated_by": user_email,
            }
            await db[TEMPLATES_COLLECTION].insert_one(template_doc)

            # First (immutable) version snapshot
            version_doc = {
                "id": _new_id(),
                "template_id": tid,
                "version_number": 1,
                "pdf_r2_key": pdf_key,
                "pdf_sha256": detection.pdf_sha256,
                "markers": template_doc["markers"],
                "marker_summary": summary,
                "cross_line_errors": detection.cross_line_errors,
                "detection_meta": template_doc["detection_meta"],
                "change_note": f"Initial upload — {pdf_filename}",
                "created_at": _now_iso(),
                "created_by": user_email,
                "frozen_at": None,   # set when the template is published
            }
            await db[VERSIONS_COLLECTION].insert_one(version_doc)

            # Stage 5 — done
            await _update_job(
                job_id,
                stage="complete", status="complete",
                progress=100, message=STAGE_LABELS["complete"],
                template_id=tid,
                summary_counts={
                    "detected": summary["total_occurrences"],
                    "recognised": len(summary["recognised"]),
                    "unrecognised": len(summary["unrecognised"]),
                    "cross_line_errors": summary["cross_line_errors_count"],
                    "ready_for_approval": summary["ready_for_approval"],
                },
            )
        except Exception as exc:  # noqa: BLE001
            logger.exception("Marker upload job crashed")
            await _update_job(
                job_id, status="failed", stage="failed",
                error=f"Unexpected error: {exc}",
            )

    @api.post("/admin/contract-templates/upload-marker-pdf")
    async def upload_marker_pdf(
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
        # Quick PDF signature check — reject anything obviously not a PDF
        if not pdf_bytes[:5].startswith(b"%PDF-"):
            raise HTTPException(400, detail="File does not appear to be a valid PDF (missing %PDF- header).")

        job_id = _new_id()
        job_doc = {
            "id": job_id,
            "status": "running",
            "stage": "uploading",
            "progress": STAGE_PROGRESS["uploading"],
            "message": STAGE_LABELS["uploading"],
            "pdf_filename": pdf.filename,
            "source_filename": pdf.filename,
            "source_kind": "pdf",
            "byte_size": len(pdf_bytes),
            "template_name": name,
            "contract_type": ctype,
            "template_id": None,
            "error": None,
            "created_by": user.get("email"),
            "created_at": _now_iso(),
            "updated_at": _now_iso(),
        }
        await db[JOBS_COLLECTION].insert_one(job_doc)

        asyncio.create_task(_run_marker_detection_job(
            job_id, pdf_bytes, pdf.filename,
            name, ctype, user.get("email") or "unknown",
        ))

        return {
            "job_id": job_id,
            "stage": "uploading",
            "status": "running",
            "progress": STAGE_PROGRESS["uploading"],
            "message": STAGE_LABELS["uploading"],
        }

    # ==========================================================
    # RENAME / METADATA
    # ==========================================================
    @api.patch("/admin/contract-templates/{template_id}")
    async def update_template(template_id: str, payload: Dict[str, Any], user: dict = Depends(require_role("admin"))):
        existing = await db[TEMPLATES_COLLECTION].find_one({"id": template_id})
        if not existing:
            raise HTTPException(404, detail="Template not found")
        allowed = {"name", "contract_type", "template_required_codes"}
        update: Dict[str, Any] = {k: v for k, v in payload.items() if k in allowed}
        if "contract_type" in update:
            _validate_type(update["contract_type"])
        if not update:
            return _public_view(existing)
        update["updated_at"] = _now_iso()
        update["updated_by"] = user.get("email")
        await db[TEMPLATES_COLLECTION].update_one({"id": template_id}, {"$set": update})
        # If either the template_required_codes OR the contract_type
        # changed, recompute the summary against the live library so
        # not_eligible_for_type / template_required_missing stay current
        # without needing an extra GET.
        if "template_required_codes" in update or "contract_type" in update:
            fresh = await db[TEMPLATES_COLLECTION].find_one({"id": template_id})
            lib_docs = [d async for d in db[markers_library.LIBRARY_COLLECTION].find({})]
            occs = []
            for m in (fresh.get("markers", []) or []):
                legacy = tuple(m.get("bbox") or (0, 0, 0, 0))
                tb = tuple(m.get("token_bbox") or legacy)
                rb = tuple(m.get("render_bbox") or legacy)
                occs.append(markers_pipeline.MarkerOccurrence(
                    code=m["code"], page=m["page"],
                    token_bbox=tb, render_bbox=rb, bbox=rb,
                    font_family=m.get("font_family"),
                    font_size=m.get("font_size"),
                    font_weight=m.get("font_weight"),
                    font_style=m.get("font_style"),
                    font_color=m.get("font_color"),
                    is_embedded=m.get("is_embedded"),
                    is_reusable=m.get("is_reusable"),
                    substitution_family=m.get("substitution_family"),
                ))
            summary = markers_pipeline.build_marker_summary(
                occs,
                fresh.get("cross_line_errors", []) or [],
                lib_docs,
                fresh.get("contract_type", "other"),
                fresh.get("template_required_codes", []) or [],
            )
            await db[TEMPLATES_COLLECTION].update_one(
                {"id": template_id},
                {"$set": {"marker_summary": summary}},
            )
        return _public_view(await db[TEMPLATES_COLLECTION].find_one({"id": template_id}))

    # ==========================================================
    # STATUS TRANSITIONS
    # ==========================================================
    @api.post("/admin/contract-templates/{template_id}/publish")
    async def publish_template(template_id: str, user: dict = Depends(require_role("admin"))):
        existing = await db[TEMPLATES_COLLECTION].find_one({"id": template_id})
        if not existing:
            raise HTTPException(404, detail="Template not found")
        summary = existing.get("marker_summary") or {}
        if not summary.get("ready_for_approval"):
            raise HTTPException(
                400,
                detail=(
                    "Template is not ready for approval. Resolve unrecognised markers, "
                    "cross-line errors, duplicate offenders, and any template-required missing markers first."
                ),
            )
        ctype = existing["contract_type"]
        # Archive the previously-current template of the same type
        await db[TEMPLATES_COLLECTION].update_many(
            {"contract_type": ctype, "status": "current", "id": {"$ne": template_id}},
            {"$set": {"status": "archived", "updated_at": _now_iso(), "updated_by": user.get("email")}},
        )
        now = _now_iso()
        await db[TEMPLATES_COLLECTION].update_one(
            {"id": template_id},
            {"$set": {"status": "current", "updated_at": now, "updated_by": user.get("email")}},
        )
        # Freeze the current version — immutable from now on
        await db[VERSIONS_COLLECTION].update_one(
            {"template_id": template_id, "version_number": existing.get("current_version", 1)},
            {"$set": {"frozen_at": now}},
        )
        return _public_view(await db[TEMPLATES_COLLECTION].find_one({"id": template_id}))

    @api.post("/admin/contract-templates/{template_id}/archive")
    async def archive_template(template_id: str, user: dict = Depends(require_role("admin"))):
        existing = await db[TEMPLATES_COLLECTION].find_one({"id": template_id})
        if not existing:
            raise HTTPException(404, detail="Template not found")
        await db[TEMPLATES_COLLECTION].update_one(
            {"id": template_id},
            {"$set": {"status": "archived", "updated_at": _now_iso(), "updated_by": user.get("email")}},
        )
        return _public_view(await db[TEMPLATES_COLLECTION].find_one({"id": template_id}))

    @api.post("/admin/contract-templates/{template_id}/set-default")
    async def set_default_template(template_id: str, user: dict = Depends(require_role("admin"))):
        existing = await db[TEMPLATES_COLLECTION].find_one({"id": template_id})
        if not existing:
            raise HTTPException(404, detail="Template not found")
        ctype = existing["contract_type"]
        await db[TEMPLATES_COLLECTION].update_many(
            {"contract_type": ctype, "id": {"$ne": template_id}},
            {"$set": {"is_default": False, "updated_at": _now_iso(), "updated_by": user.get("email")}},
        )
        await db[TEMPLATES_COLLECTION].update_one(
            {"id": template_id},
            {"$set": {"is_default": True, "updated_at": _now_iso(), "updated_by": user.get("email")}},
        )
        return _public_view(await db[TEMPLATES_COLLECTION].find_one({"id": template_id}))

    @api.post("/admin/contract-templates/{template_id}/duplicate")
    async def duplicate_template(template_id: str, user: dict = Depends(require_role("admin"))):
        existing = await db[TEMPLATES_COLLECTION].find_one({"id": template_id})
        if not existing:
            raise HTTPException(404, detail="Template not found")
        new_id = _new_id()
        # Copy the source PDF to a new R2 key
        original_key = existing.get("source_pdf", {}).get("r2_key")
        new_key = _r2_key(new_id, SOURCE_PDF_NAME)
        if original_key:
            raw = _r2_get_bytes(original_key)
            if raw is not None:
                _r2_put(raw, new_key, content_type="application/pdf")
        clone = {
            **existing,
            "id": new_id,
            "name": f"{existing['name']} (copy)",
            "status": "draft",
            "is_default": False,
            "current_version": 1,
            "source_pdf": {**(existing.get("source_pdf") or {}), "r2_key": new_key},
            "created_at": _now_iso(),
            "updated_at": _now_iso(),
            "created_by": user.get("email"),
            "updated_by": user.get("email"),
        }
        clone.pop("_id", None)
        await db[TEMPLATES_COLLECTION].insert_one(clone)
        # And a matching version-1 snapshot
        version_doc = {
            "id": _new_id(),
            "template_id": new_id,
            "version_number": 1,
            "pdf_r2_key": new_key,
            "pdf_sha256": clone.get("pdf_sha256"),
            "markers": clone.get("markers", []),
            "marker_summary": clone.get("marker_summary", {}),
            "cross_line_errors": clone.get("cross_line_errors", []),
            "detection_meta": clone.get("detection_meta", {}),
            "change_note": f"Duplicated from template {template_id}",
            "created_at": _now_iso(),
            "created_by": user.get("email"),
            "frozen_at": None,
        }
        await db[VERSIONS_COLLECTION].insert_one(version_doc)
        return _public_view(clone)

    # ==========================================================
    # SOURCE PDF DOWNLOAD + INTEGRITY CHECK
    # ==========================================================
    @api.get("/admin/contract-templates/{template_id}/source-pdf")
    async def download_source_pdf(template_id: str, _: dict = Depends(require_role("admin"))):
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

    @api.get("/admin/contract-templates/{template_id}/integrity-check")
    async def integrity_check(template_id: str, _: dict = Depends(require_role("admin"))):
        """Re-hashes the stored R2 source PDF and compares against the
        SHA-256 recorded at upload. Per amendment #5 this runs on-demand
        (not on a schedule) during Phase 1A."""
        doc = await db[TEMPLATES_COLLECTION].find_one({"id": template_id})
        if not doc:
            raise HTTPException(404, detail="Template not found")
        src = doc.get("source_pdf") or {}
        key = src.get("r2_key")
        expected = doc.get("pdf_sha256")
        if not (key and expected):
            raise HTTPException(400, detail="Template has no source PDF or hash on file.")
        raw = _r2_get_bytes(key)
        if raw is None:
            return {"ok": False, "reason": "R2 fetch failed", "expected_sha256": expected}
        import hashlib
        actual = hashlib.sha256(raw).hexdigest()
        return {
            "ok": actual == expected,
            "expected_sha256": expected,
            "actual_sha256": actual,
            "byte_size": len(raw),
        }

    # ==========================================================
    # PAGE THUMBNAIL WITH MARKER OVERLAY (read-only PNG render)
    # ==========================================================
    # For Stop Point 2 evidence we render each PDF page as a PNG with
    # amber rectangles overlaid on every detected marker bbox. This is
    # a rasterised preview only — it does NOT modify the stored PDF.
    @api.get("/admin/contract-templates/{template_id}/pages/{page_num}/thumbnail.png")
    async def page_thumbnail(
        template_id: str,
        page_num: int,
        dpi: int = Query(120, ge=60, le=300),
        overlay: bool = Query(True),
        _: dict = Depends(require_role("admin")),
    ):
        doc = await db[TEMPLATES_COLLECTION].find_one({"id": template_id})
        if not doc:
            raise HTTPException(404, detail="Template not found")
        src = doc.get("source_pdf") or {}
        raw = _r2_get_bytes(src.get("r2_key") or "")
        if raw is None:
            raise HTTPException(502, detail="Source PDF unavailable — R2 fetch failed.")
        import fitz
        try:
            pdf = fitz.open(stream=raw, filetype="pdf")
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(500, detail=f"Failed to open source PDF: {exc}") from exc
        if page_num < 1 or page_num > pdf.page_count:
            pdf.close()
            raise HTTPException(400, detail=f"page_num out of range (1..{pdf.page_count})")
        try:
            page = pdf[page_num - 1]
            # Overlay marker bboxes as amber rectangles BEFORE rendering.
            # We draw onto a copy of the page — the source PDF bytes
            # stored in R2 remain untouched (they were opened from an
            # in-memory stream).
            if overlay:
                for m in doc.get("markers", []) or []:
                    if m.get("page") != page_num:
                        continue
                    bbox = m.get("bbox") or []
                    if len(bbox) != 4:
                        continue
                    rect = fitz.Rect(*bbox)
                    page.draw_rect(rect, color=(1, 0.6, 0), fill=(1, 0.85, 0.4), width=1, fill_opacity=0.30)
                    # Label the marker code above the rect
                    label = f"[[{m.get('code','?')}]]"
                    label_pos = fitz.Point(rect.x0, max(rect.y0 - 2, 8))
                    page.insert_text(label_pos, label, fontsize=7, color=(0.5, 0.15, 0))
            pix = page.get_pixmap(dpi=dpi, alpha=False)
            png_bytes = pix.tobytes("png")
        finally:
            pdf.close()
        return Response(
            content=png_bytes, media_type="image/png",
            headers={"Cache-Control": "no-store"},
        )

    # ==========================================================
    # WHOLE-DOCUMENT SAMPLE PREVIEW (Phase 1B, preview-only)
    # ==========================================================
    # Non-persistent: never writes to R2, never creates a contract
    # record, never mutates template state. Source PDF integrity check
    # runs separately from the preview response (per user requirement).
    @api.post("/admin/contract-templates/{template_id}/sample-preview.pdf")
    async def sample_preview_pdf(
        template_id: str,
        payload: Optional[Dict[str, Any]] = None,
        _: dict = Depends(require_role("admin")),
    ):
        import contract_preview_generator as previewgen
        import hashlib

        doc = await db[TEMPLATES_COLLECTION].find_one({"id": template_id})
        if not doc:
            raise HTTPException(404, detail="Template not found")

        src = doc.get("source_pdf") or {}
        key = src.get("r2_key")
        if not key:
            raise HTTPException(404, detail="No source PDF on file for this template.")
        source_bytes = _r2_get_bytes(key)
        if source_bytes is None:
            raise HTTPException(502, detail="Source PDF unavailable — R2 fetch failed.")

        expected_sha = doc.get("pdf_sha256")
        pre_sha = hashlib.sha256(source_bytes).hexdigest()

        markers = doc.get("markers", []) or []
        # Merge marker with library data_type for synthetic defaults
        lib_docs = [d async for d in db[markers_library.LIBRARY_COLLECTION].find({})]
        lib_by_code = {m["code"]: m for m in lib_docs}
        enriched = []
        for m in markers:
            e = dict(m)
            lib = lib_by_code.get(m.get("code"))
            if lib:
                e["data_type"] = lib.get("data_type", "string")
            enriched.append(e)

        user_values = None
        if payload:
            user_values = payload.get("sample_values") or None

        try:
            pdf_bytes, report = previewgen.generate_sample_preview(
                source_bytes, enriched, user_values, doc.get("name", "template"),
            )
        except Exception as exc:  # noqa: BLE001
            logger.exception("Sample preview generation failed")
            raise HTTPException(500, detail=f"Preview generation failed: {exc}") from exc

        # Separate integrity check — never blocks the response.
        integrity: Dict[str, Any] = {"status": "ok"}
        try:
            reread = _r2_get_bytes(key)
            if reread is None:
                integrity = {"status": "error", "reason": "second R2 read failed"}
            else:
                post_sha = hashlib.sha256(reread).hexdigest()
                if post_sha == pre_sha == expected_sha:
                    integrity = {
                        "status": "ok",
                        "pre_sha256": pre_sha,
                        "post_sha256": post_sha,
                        "expected_sha256": expected_sha,
                    }
                else:
                    integrity = {
                        "status": "mismatch",
                        "pre_sha256": pre_sha,
                        "post_sha256": post_sha,
                        "expected_sha256": expected_sha,
                    }
        except Exception as exc:  # noqa: BLE001
            integrity = {"status": "error", "reason": f"{exc}"}

        fname_stub = previewgen.sanitise_filename_component(doc.get("name", "template"))
        filename = f"PREVIEW_{fname_stub}.pdf"
        return Response(
            content=pdf_bytes,
            media_type="application/pdf",
            headers={
                "Content-Disposition": f'attachment; filename="{filename}"',
                "X-Preview-Not-For-Issue": "1",
                "X-Preview-Watermark-Pages": str(report.get("watermark_pages", 0)),
                "X-Preview-Redaction-Verified": "1" if report.get("redaction_verified") else "0",
                "X-Preview-Residual-Tokens": str(report.get("residual_token_count", 0)),
                "X-Preview-Occurrences": str(len(report.get("occurrences", []))),
                "X-Source-Integrity-Status": integrity.get("status", "unknown"),
                "X-Source-SHA256-Pre":  integrity.get("pre_sha256",  ""),
                "X-Source-SHA256-Post": integrity.get("post_sha256", ""),
                "Cache-Control": "no-store",
            },
        )

    # ==========================================================
    # TURN B — Occurrence CRUD
    # ==========================================================
    # Editable fields on PATCH: render_bbox, alignment, font_size_override,
    # min_font_size. token_bbox is NEVER user-editable — it must remain
    # character-tight against the source glyphs for safe redaction.
    _PATCHABLE_FIELDS = {"render_bbox", "alignment", "font_size_override", "min_font_size"}
    _ALIGNMENT_VALUES = {"left", "center", "right", "justify"}

    def _validate_bbox(name: str, value: Any) -> List[float]:
        if not isinstance(value, (list, tuple)) or len(value) != 4:
            raise HTTPException(400, detail=f"{name} must be a 4-tuple [x0,y0,x1,y1]")
        try:
            v = [float(x) for x in value]
        except (TypeError, ValueError):
            raise HTTPException(400, detail=f"{name} entries must be numeric")
        x0, y0, x1, y1 = v
        if x1 <= x0 or y1 <= y0:
            raise HTTPException(400, detail=f"{name} must have positive width and height")
        return v

    @api.patch("/admin/contract-templates/{template_id}/markers/{occurrence_id}")
    async def patch_marker_occurrence(
        template_id: str, occurrence_id: str,
        payload: Dict[str, Any],
        user: dict = Depends(require_role("admin")),
    ):
        doc = await db[TEMPLATES_COLLECTION].find_one({"id": template_id})
        if not doc:
            raise HTTPException(404, detail="Template not found")
        markers = doc.get("markers", []) or []
        markers = await _ensure_occurrence_ids(template_id, markers)
        idx = next((i for i, m in enumerate(markers) if m.get("occurrence_id") == occurrence_id), None)
        if idx is None:
            raise HTTPException(404, detail="Marker occurrence not found on this template")

        update: Dict[str, Any] = {}
        for k, v in payload.items():
            if k not in _PATCHABLE_FIELDS:
                continue
            if v is None:
                update[k] = None
                continue
            if k == "render_bbox":
                update[k] = _validate_bbox("render_bbox", v)
            elif k == "alignment":
                if v not in _ALIGNMENT_VALUES:
                    raise HTTPException(400, detail=f"alignment must be one of {sorted(_ALIGNMENT_VALUES)}")
                update[k] = v
            elif k in ("font_size_override", "min_font_size"):
                try:
                    fv = float(v)
                except (TypeError, ValueError):
                    raise HTTPException(400, detail=f"{k} must be numeric")
                if fv <= 0 or fv > 96:
                    raise HTTPException(400, detail=f"{k} must be between 0 and 96 points")
                update[k] = fv
        if not update:
            raise HTTPException(400, detail="No editable fields supplied")

        markers[idx].update(update)
        # Keep the legacy `bbox` mirror in sync with render_bbox so the
        # existing amber-overlay thumbnail endpoint stays accurate.
        if "render_bbox" in update:
            markers[idx]["bbox"] = list(update["render_bbox"])

        await db[TEMPLATES_COLLECTION].update_one(
            {"id": template_id},
            {"$set": {
                "markers": markers,
                "updated_at": _now_iso(),
                "updated_by": user.get("email"),
            }},
        )
        return {"ok": True, "occurrence": markers[idx]}

    @api.post("/admin/contract-templates/{template_id}/markers")
    async def add_marker_occurrence(
        template_id: str,
        payload: Dict[str, Any],
        user: dict = Depends(require_role("admin")),
    ):
        """Manually add an occurrence — used when Word swallowed a token
        during export and the deterministic detector had nothing to hook.
        HQ picks a code from the Library, a page, and paints a
        ``render_bbox`` in the UI. ``token_bbox`` is set to the same
        rect (nothing to redact — the token isn't actually present in
        the source PDF text layer)."""
        doc = await db[TEMPLATES_COLLECTION].find_one({"id": template_id})
        if not doc:
            raise HTTPException(404, detail="Template not found")

        code = (payload.get("code") or "").strip()
        if not code:
            raise HTTPException(400, detail="code is required")
        page = payload.get("page")
        if not isinstance(page, int) or page < 1 or page > int(doc.get("pdf_page_count") or 1):
            raise HTTPException(400, detail=f"page must be 1..{doc.get('pdf_page_count')}")
        render_bbox = _validate_bbox("render_bbox", payload.get("render_bbox"))

        # Validate the code against the live Marker Library
        lib_entry = await db[markers_library.LIBRARY_COLLECTION].find_one({"code": code, "hidden": {"$ne": True}})
        if not lib_entry:
            raise HTTPException(400, detail=f"Marker code '{code}' is not in the live Marker Library")

        occurrence = {
            "occurrence_id": _new_id(),
            "code": code,
            "page": page,
            "token_bbox": list(render_bbox),   # nothing to redact — mirror
            "render_bbox": list(render_bbox),
            "bbox": list(render_bbox),
            "font_family": payload.get("font_family"),
            "font_size": float(payload["font_size"]) if payload.get("font_size") else None,
            "font_weight": payload.get("font_weight") or "normal",
            "font_style": payload.get("font_style") or "normal",
            "font_color": payload.get("font_color"),
            "is_embedded": None,
            "is_reusable": None,
            "substitution_family": None,
            "reconstructed_from_split": False,
            "raw_token": f"[[{code}]]",
            "alignment": payload.get("alignment"),
            "font_size_override": None,
            "min_font_size": None,
            "manually_added": True,
        }
        if occurrence["alignment"] and occurrence["alignment"] not in _ALIGNMENT_VALUES:
            raise HTTPException(400, detail=f"alignment must be one of {sorted(_ALIGNMENT_VALUES)}")

        markers = doc.get("markers", []) or []
        markers.append(occurrence)
        await db[TEMPLATES_COLLECTION].update_one(
            {"id": template_id},
            {"$set": {
                "markers": markers,
                "updated_at": _now_iso(),
                "updated_by": user.get("email"),
            }},
        )
        return {"ok": True, "occurrence": occurrence}

    @api.delete("/admin/contract-templates/{template_id}/markers/{occurrence_id}")
    async def delete_marker_occurrence(
        template_id: str, occurrence_id: str,
        user: dict = Depends(require_role("admin")),
    ):
        doc = await db[TEMPLATES_COLLECTION].find_one({"id": template_id})
        if not doc:
            raise HTTPException(404, detail="Template not found")
        markers = doc.get("markers", []) or []
        markers = await _ensure_occurrence_ids(template_id, markers)
        new_markers = [m for m in markers if m.get("occurrence_id") != occurrence_id]
        if len(new_markers) == len(markers):
            raise HTTPException(404, detail="Marker occurrence not found on this template")
        await db[TEMPLATES_COLLECTION].update_one(
            {"id": template_id},
            {"$set": {
                "markers": new_markers,
                "updated_at": _now_iso(),
                "updated_by": user.get("email"),
            }},
        )
        return {"ok": True, "removed": occurrence_id, "remaining": len(new_markers)}

    # ==========================================================
    # TURN B — Substitution acknowledgements (per font_family group)
    # ==========================================================
    @api.post("/admin/contract-templates/{template_id}/substitution-acknowledgements")
    async def set_substitution_ack(
        template_id: str,
        payload: Dict[str, Any],
        user: dict = Depends(require_role("admin")),
    ):
        """Body: {"font_family": "TimesNewRomanPSMT", "acknowledged": true|false}"""
        doc = await db[TEMPLATES_COLLECTION].find_one({"id": template_id})
        if not doc:
            raise HTTPException(404, detail="Template not found")
        family = (payload.get("font_family") or "").strip()
        if not family:
            raise HTTPException(400, detail="font_family is required")
        acknowledged = bool(payload.get("acknowledged"))

        # Verify the family actually appears in this template
        markers = doc.get("markers", []) or []
        markers = await _ensure_occurrence_ids(template_id, markers)
        if not any((m.get("font_family") or "(unknown)") == family for m in markers):
            raise HTTPException(400, detail=f"font_family '{family}' is not used by any marker on this template")

        existing_acks = doc.get("substitution_acknowledgements", {}) or {}
        if acknowledged:
            existing_acks[family] = {
                "acknowledged": True,
                "acknowledged_by": user.get("email"),
                "acknowledged_at": _now_iso(),
            }
        else:
            existing_acks.pop(family, None)

        await db[TEMPLATES_COLLECTION].update_one(
            {"id": template_id},
            {"$set": {
                "substitution_acknowledgements": existing_acks,
                "updated_at": _now_iso(),
                "updated_by": user.get("email"),
            }},
        )
        groups = _build_substitution_groups(markers, existing_acks)
        return {
            "ok": True,
            "font_family": family,
            "acknowledged": acknowledged,
            "substitution_groups": groups,
            "all_substitutions_acknowledged": all(
                (not g["substitution_required"]) or g["acknowledged"] for g in groups
            ),
        }

    # ==========================================================
    # TURN B — Per-marker sample-preview PNG (cropped)
    # ==========================================================
    # Renders the source page at the requested DPI, applies redaction +
    # overlay for JUST this one occurrence, then crops to a padded box
    # around the ``render_bbox`` so the Marker Review UI can show a
    # thumbnail-sized "what will HQ get" preview per row.
    @api.get("/admin/contract-templates/{template_id}/markers/{occurrence_id}/sample-preview.png")
    async def marker_sample_preview_png(
        template_id: str, occurrence_id: str,
        dpi: int = Query(180, ge=72, le=300),
        pad: int = Query(24, ge=0, le=200, description="padding in PDF points around render_bbox"),
        _: dict = Depends(require_role("admin")),
    ):
        import contract_preview_generator as previewgen
        import fitz
        doc = await db[TEMPLATES_COLLECTION].find_one({"id": template_id})
        if not doc:
            raise HTTPException(404, detail="Template not found")
        markers = doc.get("markers", []) or []
        markers = await _ensure_occurrence_ids(template_id, markers)
        marker = next((m for m in markers if m.get("occurrence_id") == occurrence_id), None)
        if not marker:
            raise HTTPException(404, detail="Marker occurrence not found on this template")

        src = doc.get("source_pdf") or {}
        key = src.get("r2_key")
        if not key:
            raise HTTPException(404, detail="No source PDF on file for this template.")
        raw = _r2_get_bytes(key)
        if raw is None:
            raise HTTPException(502, detail="Source PDF unavailable — R2 fetch failed.")

        # Enrich with data_type for synthetic default fallback
        lib_entry = await db[markers_library.LIBRARY_COLLECTION].find_one({"code": marker.get("code")})
        enriched = dict(marker)
        enriched["data_type"] = (lib_entry or {}).get("data_type", "string")

        page_num = int(marker.get("page") or 1)
        pdf = fitz.open(stream=raw, filetype="pdf")
        try:
            if page_num < 1 or page_num > pdf.page_count:
                raise HTTPException(400, detail=f"page {page_num} out of range")
            page = pdf[page_num - 1]

            value = previewgen.synthetic_default_for(
                marker.get("code") or "",
                enriched["data_type"],
            )
            previewgen._write_value(page, enriched, value)  # pylint: disable=protected-access

            # Cropped clip around the render_bbox
            rb = marker.get("render_bbox") or marker.get("bbox") or [0, 0, page.rect.width, page.rect.height]
            x0, y0, x1, y1 = rb
            clip = fitz.Rect(
                max(page.rect.x0, x0 - pad),
                max(page.rect.y0, y0 - pad),
                min(page.rect.x1, x1 + pad),
                min(page.rect.y1, y1 + pad),
            )
            pix = page.get_pixmap(dpi=dpi, clip=clip, alpha=False)
            png_bytes = pix.tobytes("png")
        finally:
            pdf.close()

        return Response(
            content=png_bytes, media_type="image/png",
            headers={
                "Cache-Control": "no-store",
                "X-Marker-Code": marker.get("code") or "",
                "X-Marker-Page": str(page_num),
                "X-Marker-Occurrence-Id": occurrence_id,
            },
        )

    # ==========================================================
    # BACKFILL — split legacy ``bbox`` into ``token_bbox`` + ``render_bbox``
    # ==========================================================
    # Idempotent. Re-fetches the stored source PDF from R2 and re-runs
    # the deterministic pipeline against it, then rewrites ``markers``
    # and ``marker_summary``. The source PDF bytes are never mutated.
    @api.post("/admin/contract-templates/backfill-bbox-split")
    async def backfill_bbox_split(
        template_id: Optional[str] = Query(None, description="Backfill a single template; omit for all."),
        dry_run: bool = Query(False),
        user: dict = Depends(require_role("admin")),
    ):
        q: Dict[str, Any] = {}
        if template_id:
            q["id"] = template_id
        docs = [d async for d in db[TEMPLATES_COLLECTION].find(q)]
        if not docs:
            raise HTTPException(404, detail="No templates matched.")

        results: List[Dict[str, Any]] = []
        for tdoc in docs:
            tid = tdoc.get("id")
            src = tdoc.get("source_pdf") or {}
            key = src.get("r2_key")
            if not key:
                results.append({"template_id": tid, "status": "skipped", "reason": "no source PDF"})
                continue
            raw = _r2_get_bytes(key)
            if raw is None:
                results.append({"template_id": tid, "status": "error", "reason": "R2 fetch failed"})
                continue

            try:
                detection = markers_pipeline.detect_markers(raw)
            except Exception as exc:  # noqa: BLE001
                results.append({"template_id": tid, "status": "error", "reason": f"detection failed: {exc}"})
                continue

            new_markers = markers_pipeline.occurrences_for_storage(detection.markers)
            lib_docs = [d async for d in db[markers_library.LIBRARY_COLLECTION].find({})]
            summary = markers_pipeline.build_marker_summary(
                detection.markers,
                detection.cross_line_errors,
                lib_docs,
                tdoc.get("contract_type", "other"),
                tdoc.get("template_required_codes", []) or [],
            )

            row = {
                "template_id": tid,
                "name": tdoc.get("name"),
                "old_marker_count": len(tdoc.get("markers", []) or []),
                "new_marker_count": len(new_markers),
                "detection_ms": detection.detection_ms,
                "span_reconstruction_used": detection.span_reconstruction_used,
                "pdf_sha256_matches": detection.pdf_sha256 == tdoc.get("pdf_sha256"),
                "status": "dry_run" if dry_run else "updated",
            }

            if not dry_run:
                await db[TEMPLATES_COLLECTION].update_one(
                    {"id": tid},
                    {"$set": {
                        "markers": new_markers,
                        "cross_line_errors": detection.cross_line_errors,
                        "marker_summary": summary,
                        "detection_meta": {
                            **(tdoc.get("detection_meta") or {}),
                            "detection_ms": detection.detection_ms,
                            "span_reconstruction_used": detection.span_reconstruction_used,
                            "engine_version": "phase1a-v2-bbox-split",
                            "backfilled_at": _now_iso(),
                            "backfilled_by": user.get("email"),
                        },
                        "updated_at": _now_iso(),
                        "updated_by": user.get("email"),
                    }},
                )
            results.append(row)

        return {"count": len(results), "dry_run": dry_run, "results": results}

    return api


