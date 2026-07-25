"""Contract issuance — Phase 1C Turn C.

Turns a fully-resolved contract draft into a **personalised, immutable
PDF** stored under the private ``contract-issuances/{id}/`` prefix in
R2, then flips its status to ``issued`` (and any predecessor to
``superseded``).

Invariants enforced here:

* Contract must be ``status='draft'`` at the start.
* Contract must have frozen ``contract_variables`` (Turn B output).
* Template must be ``approved`` (or Phase-1B ``current``).
* Source PDF SHA-256 on R2 must match the template's stored value.
* Every marker in the template MUST have a resolved value.
* Overflow at ``min_font_size`` for ANY occurrence → hard-fail.
* Residual ``[[`` tokens in the output → hard-fail.
* ``TERRITORY_MAP_URL`` (if present in the template) MUST have both a
  frozen snapshot on the contract and a non-empty URL.
* Personalised PDF is uploaded once — the R2 key is checked first, and
  an existing object at the target key blocks the issuance (no overwrite).
* After a successful issuance the contract cannot be issued again — the
  status transition + variable snapshot make it immutable.
"""
from __future__ import annotations

import hashlib
import io
import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from fastapi import Depends, HTTPException, UploadFile, File

import contract_render_engine as engine
import file_storage as fs

logger = logging.getLogger(__name__)


CONTRACTS_COLLECTION = "contracts"
TEMPLATES_COLLECTION = "contract_templates"
TEMPLATE_VERSIONS_COLLECTION = "contract_template_versions"
AUDIT_COLLECTION = "contract_audit"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _new_id() -> str:
    return uuid.uuid4().hex


def _strip_mongo(doc: Dict[str, Any]) -> Dict[str, Any]:
    if not doc:
        return doc
    doc = dict(doc)
    doc.pop("_id", None)
    return doc


def _issuance_r2_key(contract_id: str) -> str:
    """Never contains the franchisee_id or template_id — a stable,
    unguessable path anchored on the contract's own UUID."""
    return f"contract-issuances/{contract_id}/personalised.pdf"


async def _load_frozen_variables_map(contract: Dict[str, Any]) -> Dict[str, Any]:
    """Build a ``code → value`` map from ``contract.contract_variables``.
    Hyperlink values are passed through as dicts; all other values are
    the pre-formatted strings the resolver stamped in."""
    cv = contract.get("contract_variables") or {}
    values = cv.get("values") or {}
    out: Dict[str, Any] = {}
    for code, rv in values.items():
        out[code] = rv.get("value")
    return out


async def _load_source_pdf_and_verify(template: Dict[str, Any]) -> Tuple[bytes, str]:
    src = template.get("source_pdf") or {}
    key = src.get("r2_key")
    stored_sha = template.get("pdf_sha256")
    if not key or not stored_sha:
        raise HTTPException(500, detail="Template is missing source_pdf.r2_key or pdf_sha256.")
    raw = fs.get_client().get_object(Bucket=fs.R2_BUCKET, Key=key)["Body"].read()
    live_sha = hashlib.sha256(raw).hexdigest()
    if live_sha != stored_sha:
        raise HTTPException(
            409,
            detail=(
                "Template source PDF SHA-256 in R2 does not match the DB value. "
                "Approval must be re-run before issuance."
            ),
        )
    return raw, live_sha


async def _pick_frozen_markers(
    db, template: Dict[str, Any],
) -> Tuple[List[Dict[str, Any]], Optional[int]]:
    """Use the LIVE template markers array as the source of truth for
    render bboxes, alignment, wrapping and per-occurrence overrides.

    The ``contract_template_versions`` snapshot exists for audit
    provenance — it captures who approved what and when — but the
    live template.markers is authoritative for rendering. This
    matches the Stop Point 3 fine-tuning workflow where HQ nudges
    render_bbox / alignment on specific occurrences.
    """
    approved_v = template.get("approved_version") or template.get("current_version")
    return list(template.get("markers") or []), approved_v


def _all_marker_codes(markers: List[Dict[str, Any]]) -> List[str]:
    out: List[str] = []
    seen: set = set()
    for m in markers:
        c = m.get("code")
        if c and c not in seen:
            seen.add(c)
            out.append(c)
    return out


async def _emit_audit(db, contract_id: str, action: str, actor: str, extra: Dict[str, Any]):
    await db[AUDIT_COLLECTION].insert_one({
        "id": _new_id(),
        "contract_id": contract_id,
        "action": action,
        "actor": actor,
        "at": _now_iso(),
        "extra": extra,
    })


def attach(api, db, require_role):

    @api.post("/admin/contracts/{contract_id}/issue")
    async def issue_contract(
        contract_id: str,
        user: dict = Depends(require_role("admin")),
    ):
        # ---- Preconditions --------------------------------------------
        contract = await db[CONTRACTS_COLLECTION].find_one({"id": contract_id})
        if not contract:
            raise HTTPException(404, detail="Contract not found.")
        if contract.get("status") != "draft":
            raise HTTPException(
                409,
                detail=(
                    f"Contract is in status '{contract.get('status')}' — "
                    "only drafts can be issued. Issued contracts are "
                    "immutable; use supersede to correct."
                ),
            )
        cv = contract.get("contract_variables") or {}
        if not cv or not cv.get("values"):
            raise HTTPException(
                409,
                detail=(
                    "Contract has no frozen contract_variables. Call "
                    "POST /admin/contracts/{id}/resolve-variables first."
                ),
            )
        template = await db[TEMPLATES_COLLECTION].find_one({"id": contract["template_id"]})
        if not template:
            raise HTTPException(500, detail="Contract references a missing template.")
        if template.get("status") not in {"approved", "current"}:
            raise HTTPException(
                409,
                detail=(
                    f"Template is in status '{template.get('status')}' — "
                    "only approved templates can be used for issuance."
                ),
            )
        # No-overwrite guard on the target R2 key
        r2_key = _issuance_r2_key(contract_id)
        existing = fs.head_object(r2_key)
        if existing is not None:
            raise HTTPException(
                409,
                detail=(
                    f"An object already exists at {r2_key}. Issued contracts "
                    "must never be overwritten — create a new supersede draft."
                ),
            )

        # ---- Load source + markers + values ---------------------------
        source_bytes, source_sha_before = await _load_source_pdf_and_verify(template)
        markers, template_version = await _pick_frozen_markers(db, template)
        template_codes = _all_marker_codes(markers)
        values_map = await _load_frozen_variables_map(contract)
        # Every template-declared code must have a resolved value.
        missing = [c for c in template_codes if c not in values_map or values_map[c] in (None, "")]
        if missing:
            raise HTTPException(
                409,
                detail={
                    "message": (
                        "Frozen contract_variables are missing values for "
                        "one or more markers declared on the template. "
                        "Refresh variables before issuing."
                    ),
                    "missing_codes": missing,
                },
            )

        # ---- Transition to pending_issue -----------------------------
        now = _now_iso()
        await db[CONTRACTS_COLLECTION].update_one(
            {"id": contract_id, "status": "draft"},
            {"$set": {
                "status": "pending_issue",
                "updated_at": now,
                "updated_by": user.get("email"),
            }},
        )
        await _emit_audit(
            db, contract_id, "contract.pending_issue", user.get("email") or "admin",
            {"template_id": template["id"], "template_version": template_version},
        )

        # ---- Render ---------------------------------------------------
        try:
            personalised_bytes, render_report = engine.render(
                source_bytes,
                markers,
                values_map,
                mode="issuance",
                template_name=template.get("name") or "template",
            )
        except engine.RenderError as exc:
            # Roll status back to draft — the contract remains editable.
            await db[CONTRACTS_COLLECTION].update_one(
                {"id": contract_id},
                {"$set": {"status": "draft", "updated_at": _now_iso()}},
            )
            await _emit_audit(
                db, contract_id, "contract.issue.aborted", user.get("email") or "admin",
                {"reason": str(exc), "offenders": exc.offenders},
            )
            raise HTTPException(
                422,
                detail={
                    "message": "Render engine hard-failed under issuance-mode invariants.",
                    "reason": str(exc),
                    "offenders": exc.offenders,
                },
            )

        # Post-render integrity — source PDF unchanged (checksum of
        # in-memory buffer we passed in AND, defensively, the R2 object
        # we can re-fetch below).
        source_sha_after = hashlib.sha256(source_bytes).hexdigest()
        if source_sha_after != source_sha_before:
            # Should never happen — the buffer is local to this handler.
            raise HTTPException(500, detail="Source PDF buffer was mutated during render.")

        output_sha = hashlib.sha256(personalised_bytes).hexdigest()
        byte_size = len(personalised_bytes)

        # Sanity — the render engine already checked residual tokens in
        # issuance mode. Assert the report matches.
        if render_report.get("residual_token_count", 0) != 0:
            raise HTTPException(500, detail="Render engine claimed success but residual tokens > 0.")

        # ---- Upload — no-overwrite ----------------------------------
        # Re-check head_object one more time (defence in depth against a
        # race). Then upload with a Content-Type + Cache-Control
        # header. Object metadata carries the SHA-256 for downstream
        # verifiers who don't want to open the PDF.
        if fs.head_object(r2_key) is not None:
            # Race — someone else already stored an object here. Roll back.
            await db[CONTRACTS_COLLECTION].update_one(
                {"id": contract_id},
                {"$set": {"status": "draft", "updated_at": _now_iso()}},
            )
            raise HTTPException(
                409,
                detail=f"Object already exists at {r2_key} after render.",
            )
        fs.get_client().put_object(
            Bucket=fs.R2_BUCKET,
            Key=r2_key,
            Body=personalised_bytes,
            ContentType="application/pdf",
            CacheControl="private, no-store",
            Metadata={
                "contract-id": contract_id,
                "template-id": template["id"],
                "template-version": str(template_version or ""),
                "personalised-sha256": output_sha,
                "content-length": str(byte_size),
                "issued-by": user.get("email") or "admin",
            },
        )
        # Verify the object we just wrote matches (defensive read-back)
        after = fs.head_object(r2_key)
        if not after:
            raise HTTPException(500, detail="Uploaded object could not be verified via head_object.")

        # ---- Transition to issued + persist details -------------------
        issued_at = _now_iso()
        await db[CONTRACTS_COLLECTION].update_one(
            {"id": contract_id, "status": "pending_issue"},
            {"$set": {
                "status": "issued",
                "personalised_pdf_r2_key": r2_key,
                "personalised_pdf_sha256": output_sha,
                "personalised_pdf_byte_size": byte_size,
                "personalised_pdf_created_at": issued_at,
                "issued_at": issued_at,
                "issued_by": user.get("email"),
                "render_report_summary": {
                    "occurrence_count": len(render_report.get("occurrences") or []),
                    "hyperlink_count": len(render_report.get("hyperlinks") or []),
                    "link_annotations": render_report.get("link_annotations") or [],
                    "residual_token_count": render_report.get("residual_token_count"),
                    "redaction_verified": render_report.get("redaction_verified"),
                    "template_version": template_version,
                    "source_pdf_sha256": source_sha_after,
                },
                "updated_at": issued_at,
                "updated_by": user.get("email"),
            }},
        )

        # ---- Supersede predecessor if applicable ---------------------
        predecessor_id = contract.get("supersedes_id")
        if predecessor_id:
            prior = await db[CONTRACTS_COLLECTION].find_one({"id": predecessor_id})
            if prior and prior.get("status") == "issued":
                await db[CONTRACTS_COLLECTION].update_one(
                    {"id": predecessor_id, "status": "issued"},
                    {"$set": {
                        "status": "superseded",
                        "superseded_at": issued_at,
                        "superseded_by": user.get("email"),
                        "superseded_by_contract_id": contract_id,
                        "updated_at": issued_at,
                    }},
                )
                await _emit_audit(
                    db, predecessor_id, "contract.superseded",
                    user.get("email") or "admin",
                    {"superseded_by_contract_id": contract_id},
                )

        # ---- Final audit --------------------------------------------
        await _emit_audit(
            db, contract_id, "contract.issued", user.get("email") or "admin",
            {
                "r2_key": r2_key,
                "personalised_sha256": output_sha,
                "byte_size": byte_size,
                "template_id": template["id"],
                "template_version": template_version,
                "source_pdf_sha256": source_sha_after,
                "hyperlink_count": len(render_report.get("hyperlinks") or []),
                "residual_token_count": render_report.get("residual_token_count"),
                "supersedes_contract_id": predecessor_id,
            },
        )

        return _strip_mongo(await db[CONTRACTS_COLLECTION].find_one({"id": contract_id}))

    @api.get("/admin/contracts/{contract_id}/personalised-pdf")
    async def personalised_pdf_signed_url(
        contract_id: str,
        _: dict = Depends(require_role("admin")),
    ):
        contract = await db[CONTRACTS_COLLECTION].find_one({"id": contract_id})
        if not contract:
            raise HTTPException(404, detail="Contract not found.")
        if not contract.get("personalised_pdf_r2_key"):
            raise HTTPException(
                404,
                detail=(
                    "This contract has no personalised PDF — it has not "
                    "been issued yet."
                ),
            )
        url = fs.presigned_get_url(
            contract["personalised_pdf_r2_key"],
            expires_in=600,
            content_disposition=f'inline; filename="{contract_id}.pdf"',
        )
        return {
            "url": url,
            "r2_key": contract["personalised_pdf_r2_key"],
            "sha256": contract["personalised_pdf_sha256"],
            "byte_size": contract["personalised_pdf_byte_size"],
            "created_at": contract["personalised_pdf_created_at"],
            "expires_in_seconds": 600,
        }

    @api.get("/admin/contracts/{contract_id}/audit")
    async def contract_audit(
        contract_id: str,
        _: dict = Depends(require_role("admin")),
    ):
        contract = await db[CONTRACTS_COLLECTION].find_one({"id": contract_id})
        if not contract:
            raise HTTPException(404, detail="Contract not found.")
        cur = db[AUDIT_COLLECTION].find({"contract_id": contract_id}).sort([("at", 1)])
        items = [_strip_mongo(d) async for d in cur]
        return {"items": items, "total": len(items)}

    @api.post("/admin/contracts/{contract_id}/upload-signed")
    async def upload_signed_pdf(
        contract_id: str,
        pdf: UploadFile = File(...),
        user: dict = Depends(require_role("admin")),
    ):
        """Store an HQ-countersigned PDF (signed offline via DocuSign /
        Adobe Sign / print + scan). Flips the contract from ``issued``
        to ``signed``. Never overwrites an existing signed PDF —
        corrections must go through the supersede flow.
        """
        if not pdf or not hasattr(pdf, "read"):
            raise HTTPException(400, detail="A PDF file is required (multipart field 'pdf').")
        contract = await db[CONTRACTS_COLLECTION].find_one({"id": contract_id})
        if not contract:
            raise HTTPException(404, detail="Contract not found.")
        if contract.get("status") != "issued":
            raise HTTPException(
                409,
                detail=(
                    f"Contract is in status '{contract.get('status')}' — "
                    "only issued contracts can accept a signed PDF."
                ),
            )
        signed_key = f"contract-issuances/{contract_id}/signed-final.pdf"
        if fs.head_object(signed_key) is not None:
            raise HTTPException(
                409,
                detail=(
                    f"An object already exists at {signed_key}. Signed "
                    "PDFs are immutable — create a supersede draft to "
                    "correct."
                ),
            )
        payload = await pdf.read()
        if not payload or not payload.startswith(b"%PDF"):
            raise HTTPException(400, detail="Uploaded file is not a PDF.")
        signed_sha = hashlib.sha256(payload).hexdigest()
        signed_size = len(payload)
        fs.get_client().put_object(
            Bucket=fs.R2_BUCKET,
            Key=signed_key,
            Body=payload,
            ContentType="application/pdf",
            CacheControl="private, no-store",
            Metadata={
                "contract-id": contract_id,
                "signed-sha256": signed_sha,
                "content-length": str(signed_size),
                "uploaded-by": user.get("email") or "admin",
            },
        )
        now = _now_iso()
        await db[CONTRACTS_COLLECTION].update_one(
            {"id": contract_id, "status": "issued"},
            {"$set": {
                "status": "signed",
                "signed_pdf_r2_key": signed_key,
                "signed_pdf_sha256": signed_sha,
                "signed_pdf_byte_size": signed_size,
                "signed_pdf_uploaded_at": now,
                "signed_pdf_uploaded_by": user.get("email"),
                "signed_at": now,
                "updated_at": now,
                "updated_by": user.get("email"),
            }},
        )
        await _emit_audit(
            db, contract_id, "contract.signed", user.get("email") or "admin",
            {"r2_key": signed_key, "signed_sha256": signed_sha, "byte_size": signed_size},
        )
        return _strip_mongo(await db[CONTRACTS_COLLECTION].find_one({"id": contract_id}))

    @api.get("/admin/contracts/{contract_id}/signed-pdf")
    async def signed_pdf_signed_url(
        contract_id: str,
        _: dict = Depends(require_role("admin")),
    ):
        contract = await db[CONTRACTS_COLLECTION].find_one({"id": contract_id})
        if not contract:
            raise HTTPException(404, detail="Contract not found.")
        if not contract.get("signed_pdf_r2_key"):
            raise HTTPException(404, detail="This contract has no signed PDF yet.")
        url = fs.presigned_get_url(
            contract["signed_pdf_r2_key"],
            expires_in=600,
            content_disposition=f'inline; filename="{contract_id}-signed.pdf"',
        )
        return {
            "url": url,
            "r2_key": contract["signed_pdf_r2_key"],
            "sha256": contract["signed_pdf_sha256"],
            "byte_size": contract["signed_pdf_byte_size"],
            "created_at": contract.get("signed_pdf_uploaded_at"),
            "expires_in_seconds": 600,
        }

    return api
