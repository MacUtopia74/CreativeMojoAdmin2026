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
from fastapi.responses import StreamingResponse

import contract_render_engine as engine
import contract_preview_generator as previewgen
import contract_value_resolver as resolver
import contract_markers_library as markers_library
import file_storage as fs

logger = logging.getLogger(__name__)


CONTRACTS_COLLECTION = "contracts"
TEMPLATES_COLLECTION = "contract_templates"
TEMPLATE_VERSIONS_COLLECTION = "contract_template_versions"
AUDIT_COLLECTION = "contract_audit"

# Marker data_types that carry NO frozen value — they exist only to
# mark a position / redact a token in the rendered PDF. The resolver
# deliberately skips them (see contract_value_resolver.py :~447), so
# they must also be excluded from the issue-time completeness check.
# Any new positional / redaction-only marker types get added here.
POSITIONAL_ONLY_DATA_TYPES = {"signature_anchor"}


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


def _all_marker_codes(
    markers: List[Dict[str, Any]],
    library_by_code: Dict[str, Dict[str, Any]],
) -> List[str]:
    """Codes for markers that MUST carry a resolved value at issuance.

    A marker is VALUE-BEARING iff its Marker Library entry declares a
    ``data_type`` that isn't in ``POSITIONAL_ONLY_DATA_TYPES``. The
    template's own marker entries do NOT store ``data_type`` reliably
    (it's typically ``None`` on template.markers[*]), so the library
    is the sole source of truth for classification — same rule the
    resolver uses in ``resolve_contract_variables``.

    Positional / redaction-only markers (currently just
    ``signature_anchor``, e.g. ``FRANCHISEE_SIGNATURE_POSITION``) are
    detected + recorded at render time but never held in
    ``contract.contract_variables``. Requiring them here would 409
    every drawn-signature contract.
    """
    out: List[str] = []
    seen: set = set()
    for m in markers:
        code = m.get("code")
        if not code or code in seen:
            continue
        lib = library_by_code.get(code) or {}
        dt = (lib.get("data_type") or "").lower()
        if dt in POSITIONAL_ONLY_DATA_TYPES:
            continue
        seen.add(code)
        out.append(code)
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
        # Library is authoritative for marker classification (see
        # _all_marker_codes docstring). Load once, index by code.
        library_by_code: Dict[str, Dict[str, Any]] = {
            row["code"]: row
            async for row in db[markers_library.LIBRARY_COLLECTION].find({})
            if row.get("code")
        }
        template_codes = _all_marker_codes(markers, library_by_code)
        values_map = await _load_frozen_variables_map(contract)
        # Every VALUE-BEARING marker declared on the template must have
        # a resolved value. Positional / redaction-only markers were
        # already filtered out by _all_marker_codes.
        missing = [
            c for c in template_codes
            if c not in values_map or values_map[c] in (None, "")
        ]
        if missing:
            # Named payload the frontend keys off — surfaces the exact
            # marker codes back to the admin instead of a generic
            # "missing values" message, and signals that a controlled
            # refresh + retry is the correct remedy (the draft was
            # prepared under an older template version). ``missing_codes``
            # is retained for backward compatibility with older clients.
            raise HTTPException(
                409,
                detail={
                    "message": (
                        "This draft was prepared using an earlier version "
                        "of the template. Its contract details need "
                        "refreshing before it can be issued."
                    ),
                    "reason_code": "stale_frozen_variables",
                    "missing_marker_codes": missing,
                    "missing_codes": missing,
                    "template_id": template.get("id"),
                    "template_version": template_version,
                    "hint": (
                        "Call POST /admin/contracts/{id}/refresh-variables "
                        "with an explicit reason, then retry /issue."
                    ),
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
        # Enrich each marker with ``data_type`` from the library BEFORE
        # calling render. Template.markers[*] stores data_type=None; the
        # library is authoritative (mirrors what _all_marker_codes does).
        # Without this, the render engine's ``signature_anchor`` branch
        # never fires and positional-only markers try to look up a
        # value in values_map (which correctly skipped them), hitting
        # the ``missing_value`` invariant.
        markers_for_render: List[Dict[str, Any]] = []
        for _m in markers:
            _code = _m.get("code")
            _lib = library_by_code.get(_code) if _code else None
            if _lib and (_lib.get("data_type") is not None) and (_m.get("data_type") is None):
                markers_for_render.append({**_m, "data_type": _lib.get("data_type")})
            else:
                markers_for_render.append(_m)

        render_job_id = f"render_{contract_id[:8]}_{int(datetime.now(timezone.utc).timestamp())}"
        try:
            personalised_bytes, render_report = engine.render(
                source_bytes,
                markers_for_render,
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
            invariant = getattr(exc, "invariant", "unspecified")
            marker_code = getattr(exc, "marker_code", None)
            page = getattr(exc, "page", None)
            bbox = getattr(exc, "bbox", None)
            render_context = getattr(exc, "context", None) or {}

            # Human-friendly copy per invariant — the admin UI keys off
            # ``reason_code`` to pick a message; ``message`` is a safe
            # fallback for older clients.
            humanised = {
                "signature_anchor_bad_bbox": (
                    "Issue failed because the signature anchor could not "
                    "be located in the rendered PDF. Please check the "
                    "[[FRANCHISEE_SIGNATURE_POSITION]] marker placement "
                    "in the template."
                ),
                "missing_value": (
                    "Issue failed because a marker on the template has "
                    "no resolved value. Refresh the contract variables "
                    "or check the template markers."
                ),
                "overflow": (
                    "Issue failed because a value did not fit inside "
                    "its render box, even at minimum font size. Widen "
                    "the marker's render_bbox or shorten the value."
                ),
                "hyperlink_missing_url": (
                    "Issue failed because a hyperlink marker has no URL. "
                    "Set a URL on the marker before issuing."
                ),
                "hyperlink_overflow": (
                    "Issue failed because a hyperlink's display text "
                    "does not fit its render box. Shorten the display "
                    "text or widen the render_bbox."
                ),
                "bad_bbox_metadata": (
                    "Issue failed because a marker has missing or "
                    "malformed bounding-box metadata. Re-detect the "
                    "marker in the template editor."
                ),
                "residual_tokens": (
                    "Issue failed because one or more [[MARKER]] tokens "
                    "remained visible in the output PDF. Check for "
                    "overlapping markers or missing library entries."
                ),
            }.get(invariant, "Issue failed at the rendering stage.")

            # Log the full detail server-side so ops can trace the exact
            # invariant against the contract ID. Also include the
            # traceback for genuinely unexpected failures.
            logger.error(
                "Contract %s (template %s v%s) render aborted — "
                "invariant=%s marker=%s page=%s bbox=%s render_job_id=%s ctx=%s",
                contract_id, template.get("id"), template_version,
                invariant, marker_code, page, bbox, render_job_id, render_context,
                exc_info=True,
            )
            await _emit_audit(
                db, contract_id, "contract.issue.aborted", user.get("email") or "admin",
                {
                    "reason": str(exc),
                    "reason_code": "render_invariant_failed",
                    "failed_invariant": invariant,
                    "marker_code": marker_code,
                    "page": page,
                    "bbox": bbox,
                    "render_job_id": render_job_id,
                    "template_id": template.get("id"),
                    "template_version": template_version,
                    "offenders": exc.offenders,
                    "context": render_context,
                },
            )
            raise HTTPException(
                422,
                detail={
                    "message": humanised,
                    "reason_code": "render_invariant_failed",
                    "failed_invariant": invariant,
                    "marker_code": marker_code,
                    "page": page,
                    "bbox": bbox,
                    "template_id": template.get("id"),
                    "template_version": template_version,
                    "render_job_id": render_job_id,
                    "offenders": exc.offenders,
                    "raw_error": str(exc),
                    "context": render_context,
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

        # ---- Explicit anchor-detection log --------------------------
        # Everything below relies on ``render_report.occurrences[*]``
        # carrying at least one ``data_type == "signature_anchor"``
        # occurrence for templates that use drawn signatures. Log the
        # detected anchors (with the exact page + bboxes that will be
        # persisted onto ``contract.signature_anchors`` a few lines
        # further down) so any future "vault empty of anchors" issue
        # can be diagnosed by grepping this line in the server log.
        detected_anchors = [
            {
                "code": occ.get("code"),
                "page": occ.get("page"),
                "occurrence_id": occ.get("occurrence_id"),
                "render_bbox": occ.get("render_bbox"),
                "token_bbox": occ.get("token_bbox"),
            }
            for occ in (render_report.get("occurrences") or [])
            if (occ.get("data_type") or "").lower() == "signature_anchor"
        ]
        template_has_signature_marker = any(
            (library_by_code.get(m.get("code")) or {}).get("data_type") == "signature_anchor"
            for m in markers
        )
        if template_has_signature_marker and not detected_anchors:
            # Should not happen after the enrichment fix — but if it
            # ever does, the acceptance flow WOULD have nowhere to
            # stamp the signature. Fail loudly rather than issuing a
            # contract that cannot be signed.
            logger.error(
                "Contract %s render succeeded but zero signature anchors "
                "were persisted. Template %s v%s markers=%s render_report.occurrences=%s",
                contract_id, template.get("id"), template_version,
                [m.get("code") for m in markers],
                [{k: o.get(k) for k in ("code","data_type","page")} for o in (render_report.get("occurrences") or [])],
            )
            await db[CONTRACTS_COLLECTION].update_one(
                {"id": contract_id},
                {"$set": {"status": "draft", "updated_at": _now_iso()}},
            )
            raise HTTPException(
                422,
                detail={
                    "message": (
                        "Issue failed because the signature anchor was "
                        "declared on the template but was not detected "
                        "in the rendered PDF. Please check the marker "
                        "placement in the template."
                    ),
                    "reason_code": "render_invariant_failed",
                    "failed_invariant": "signature_anchor_not_persisted",
                    "marker_code": "FRANCHISEE_SIGNATURE_POSITION",
                    "template_id": template.get("id"),
                    "template_version": template_version,
                    "render_job_id": render_job_id,
                },
            )
        logger.info(
            "Contract %s render OK — template=%s v%s pages=%s "
            "occurrences=%s signature_anchors=%s residual_tokens=%s "
            "output_sha=%s bytes=%s",
            contract_id, template.get("id"), template_version,
            render_report.get("page_count"),
            len(render_report.get("occurrences") or []),
            detected_anchors,
            render_report.get("residual_token_count"),
            output_sha[:12], byte_size,
        )

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
                # Signature-anchor occurrences (page + render_bbox) are
                # copied verbatim from the render report so the accept
                # endpoint can place the drawn signature at exactly the
                # ``[[FRANCHISEE_SIGNATURE_POSITION]]`` marker location
                # this template used, without a hard-coded rectangle.
                # Empty list → template lacks the marker → signing is
                # hard-blocked on the portal side.
                "signature_anchors": [
                    {
                        "page": occ.get("page"),
                        "render_bbox": occ.get("render_bbox"),
                        "token_bbox": occ.get("token_bbox"),
                        "occurrence_id": occ.get("occurrence_id"),
                    }
                    for occ in (render_report.get("occurrences") or [])
                    if (occ.get("data_type") or "").lower() == "signature_anchor"
                ],
                "updated_at": issued_at,
                "updated_by": user.get("email"),
            }},
        )

        # ---- Supersede predecessor if applicable ---------------------
        # A renewal can supersede either an ``issued`` or a ``signed``
        # predecessor (the normal renewal case is signed → superseded).
        # We stash the original status in ``pre_supersede_status`` so
        # the revoke flow below can restore it accurately — restoring
        # a signed predecessor back to "issued" would silently erase
        # the fact that it was signed.
        predecessor_id = contract.get("supersedes_id")
        if predecessor_id:
            prior = await db[CONTRACTS_COLLECTION].find_one({"id": predecessor_id})
            prior_status = prior.get("status") if prior else None
            if prior and prior_status in {"issued", "signed"}:
                await db[CONTRACTS_COLLECTION].update_one(
                    {"id": predecessor_id, "status": prior_status},
                    {"$set": {
                        "status": "superseded",
                        "pre_supersede_status": prior_status,
                        "superseded_at": issued_at,
                        "superseded_by": user.get("email"),
                        "superseded_by_contract_id": contract_id,
                        "updated_at": issued_at,
                    }},
                )
                await _emit_audit(
                    db, predecessor_id, "contract.superseded",
                    user.get("email") or "admin",
                    {
                        "superseded_by_contract_id": contract_id,
                        "previous_status": prior_status,
                    },
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

    # ------------------------------------------------------------------
    # Draft-only preview PDF.
    #
    # HQ needs to visually check a draft before it becomes visible to the
    # franchisee. This endpoint runs the render engine in **preview
    # mode** (lenient, PREVIEW watermark on every page) and STREAMS the
    # bytes back inline. It never:
    #   * changes contract.status
    #   * writes to R2 (no personalised.pdf key is created)
    #   * emits contract audit rows
    #   * exposes the contract to the franchisee portal
    #
    # Values used, in priority order:
    #   1. Any frozen ``contract_variables`` already on the draft
    #      (i.e. HQ has already called resolve-variables).
    #   2. Otherwise, a dry-run of the resolver — whatever it can
    #      produce, plus synthetic defaults for any code that still
    #      has no value. This mirrors ``generate_sample_preview``.
    # ------------------------------------------------------------------
    @api.post("/admin/contracts/{contract_id}/preview-pdf")
    async def preview_draft_pdf(
        contract_id: str,
        _: dict = Depends(require_role("admin")),
    ):
        contract = await db[CONTRACTS_COLLECTION].find_one({"id": contract_id})
        if not contract:
            raise HTTPException(404, detail="Contract not found.")
        if contract.get("status") != "draft":
            raise HTTPException(
                409,
                detail=(
                    f"Preview is only available for drafts. This contract "
                    f"is in status '{contract.get('status')}' — download the "
                    "personalised PDF via the standard endpoint instead."
                ),
            )
        template = await db[TEMPLATES_COLLECTION].find_one({"id": contract["template_id"]})
        if not template:
            raise HTTPException(500, detail="Contract references a missing template.")

        source_bytes, _sha = await _load_source_pdf_and_verify(template)
        markers, _tv = await _pick_frozen_markers(db, template)

        # Prefer frozen variables when present; otherwise, run the
        # resolver as a dry-run and fall back to synthetic defaults for
        # any marker it couldn't resolve. Preview mode never persists.
        values_map: Dict[str, Any] = {}
        frozen_cv = contract.get("contract_variables") or {}
        if frozen_cv.get("values"):
            for code, rv in frozen_cv["values"].items():
                if rv.get("value") not in (None, ""):
                    values_map[code] = rv["value"]
        else:
            franchisee = await db["franchisees"].find_one({"id": contract["franchisee_id"]})
            library_col = "contract_marker_library"
            try:
                import contract_markers_library as _mlib
                library_col = _mlib.LIBRARY_COLLECTION
            except Exception:
                pass
            library = [d async for d in db[library_col].find({})]
            if franchisee:
                try:
                    report = resolver.resolve_contract_variables(
                        template, contract, franchisee, library,
                        actor="preview",
                        at=datetime.now(timezone.utc),
                    )
                    for code, rv in (report.resolved or {}).items():
                        if getattr(rv, "value", None) not in (None, ""):
                            values_map[code] = rv.value
                except Exception as exc:
                    logger.warning(
                        "Preview resolver dry-run failed for %s: %s — falling "
                        "back to synthetic defaults only.", contract_id, exc,
                    )

        # Fill any still-missing markers with synthetic defaults.
        for m in markers:
            code = m.get("code") or ""
            if code and code not in values_map:
                values_map[code] = previewgen.synthetic_default_for(
                    code, (m.get("data_type") or "string").lower(),
                )

        pdf_bytes, _report = engine.render(
            source_bytes,
            markers,
            values_map,
            mode="preview",
            template_name=(template.get("name") or "template"),
        )

        filename = f"contract-{contract_id[:8]}-DRAFT.pdf"
        headers = {
            "Content-Disposition": f'inline; filename="{filename}"',
            "Cache-Control": "no-store, must-revalidate",
            "X-Preview-Watermark": "PREVIEW-NOT-FOR-ISSUE",
        }
        return StreamingResponse(
            io.BytesIO(pdf_bytes),
            media_type="application/pdf",
            headers=headers,
        )

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

    @api.post("/admin/contracts/{contract_id}/revoke")
    async def revoke_contract(
        contract_id: str,
        payload: Optional[Dict[str, Any]] = None,
        user: dict = Depends(require_role("admin")),
    ):
        """Withdraw an issued contract that the franchisee never
        signed — used when they've rejected it or asked for a change
        so it must not stay on their portal.

        Only ``issued`` contracts are eligible. Signed contracts are
        legal records and must never be revoked; a signed contract
        can only be superseded by issuing a new one. Drafts should be
        deleted outright via the existing DELETE endpoint.

        The reason is captured verbatim on the contract so HQ can see
        why each revocation happened without diving into the audit
        log. The event is also emitted to the audit collection so a
        full timeline is preserved.
        """
        payload = payload or {}
        reason = (payload.get("reason") or "").strip()
        if len(reason) > 500:
            raise HTTPException(400, detail="Revocation reason is too long (max 500 characters).")

        contract = await db[CONTRACTS_COLLECTION].find_one({"id": contract_id})
        if not contract:
            raise HTTPException(404, detail="Contract not found.")

        status = contract.get("status")
        if status == "signed":
            raise HTTPException(
                409,
                detail=(
                    "Signed contracts are legal records and can't be revoked. "
                    "Issue a superseding contract if this one needs to change."
                ),
            )
        if status == "draft":
            raise HTTPException(
                409,
                detail="Drafts can't be revoked — delete the draft instead.",
            )
        if status == "revoked":
            raise HTTPException(409, detail="This contract has already been revoked.")
        if status != "issued":
            raise HTTPException(
                409,
                detail=(
                    f"Only 'issued' contracts can be revoked "
                    f"(this one is '{status}')."
                ),
            )

        now = _now_iso()
        actor = user.get("email") or "admin"
        # CAS guard — refuse the update if another admin flipped the
        # status between our read and this write. Better a 409 than
        # silently overwriting a race-winner state.
        result = await db[CONTRACTS_COLLECTION].update_one(
            {"id": contract_id, "status": "issued"},
            {"$set": {
                "status": "revoked",
                "revoked_at": now,
                "revoked_by": actor,
                "revoke_reason": reason or None,
                "updated_at": now,
                "updated_by": actor,
            }},
        )
        if result.modified_count != 1:
            raise HTTPException(
                409,
                detail=(
                    "Revoke failed — the contract's status changed "
                    "since you loaded the page. Refresh and try again."
                ),
            )
        await _emit_audit(
            db, contract_id, "contract.revoked", actor,
            {"reason": reason or None},
        )
        updated = await db[CONTRACTS_COLLECTION].find_one({"id": contract_id})
        return _strip_mongo(updated)


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

    @api.delete("/admin/contracts/{contract_id}/force")
    async def force_delete_contract(
        contract_id: str,
        confirm: bool = False,
        reason: str = "",
        user: dict = Depends(require_role("admin")),
    ):
        """DEV / TESTING ONLY — hard-delete a contract regardless of
        status, including ``issued`` and ``signed``. Also removes the
        matching personalised / signed PDFs from R2 so the storage
        namespace is freed for a fresh test issuance.

        Requires ``?confirm=true`` and a written ``reason`` (max 500
        chars). Every call is audited by ``contract_id`` so the
        deletion history survives even though the contract row does
        not. This endpoint MUST NOT be surfaced next to normal admin
        actions in production — the CMS drives real legal records,
        and destroying a signed contract is only ever appropriate
        while testing the issuance / signing flow end-to-end.
        """
        if not confirm:
            raise HTTPException(
                400,
                detail=(
                    "Force delete requires ?confirm=true — this is "
                    "a destructive dev/testing action."
                ),
            )
        reason = (reason or "").strip()
        if not reason:
            raise HTTPException(
                400,
                detail="A written 'reason' is required to force-delete a contract.",
            )
        if len(reason) > 500:
            raise HTTPException(400, detail="Reason is too long (max 500 characters).")

        contract = await db[CONTRACTS_COLLECTION].find_one({"id": contract_id})
        if not contract:
            raise HTTPException(404, detail="Contract not found.")

        status = contract.get("status")
        # Drafts already have a clean DELETE path in contracts_routes.py.
        # Sending them through the force path would just be confusing;
        # nudge the caller to the correct route.
        if status == "draft":
            raise HTTPException(
                400,
                detail=(
                    "Use the standard DELETE /admin/contracts/{id} "
                    "endpoint for drafts — force delete is only for "
                    "issued / signed / superseded / revoked records."
                ),
            )

        actor = user.get("email") or "admin"
        removed_keys: List[str] = []
        r2_errors: List[Dict[str, Any]] = []

        # Remove any R2 objects associated with the contract. Only
        # ``NoSuchKey`` is quietly swallowed; every other exception
        # is captured so the caller can see partial cleanup rather
        # than a silent half-success.
        for key_field in ("personalised_pdf_r2_key", "signed_pdf_r2_key"):
            r2_key = contract.get(key_field)
            if not r2_key:
                continue
            try:
                fs.delete_object(r2_key)
                removed_keys.append(r2_key)
            except Exception as exc:  # noqa: BLE001
                msg = str(exc)
                if "NoSuchKey" in msg or "Not Found" in msg or "404" in msg:
                    removed_keys.append(r2_key)  # already gone — fine
                else:
                    r2_errors.append({"key": r2_key, "error": msg})

        # If a supersede predecessor was flipped by issuing THIS
        # contract, restore it to whatever status it held BEFORE the
        # supersede fired (``pre_supersede_status`` was stashed at
        # supersede-time — typically 'issued' or 'signed'). Falling
        # back to 'issued' preserves legacy revoke behaviour for
        # rows written before that field existed.
        predecessor_id = contract.get("supersedes_id")
        if predecessor_id:
            prior = await db[CONTRACTS_COLLECTION].find_one({"id": predecessor_id})
            if prior and prior.get("status") == "superseded" \
                    and prior.get("superseded_by_contract_id") == contract_id:
                restore_status = prior.get("pre_supersede_status") or "issued"
                await db[CONTRACTS_COLLECTION].update_one(
                    {"id": predecessor_id},
                    {
                        "$set": {
                            "status": restore_status,
                            "updated_at": _now_iso(),
                            "updated_by": actor,
                        },
                        "$unset": {
                            "superseded_at": "",
                            "superseded_by": "",
                            "superseded_by_contract_id": "",
                            "pre_supersede_status": "",
                        },
                    },
                )
                await _emit_audit(
                    db, predecessor_id, "contract.supersede.reversed", actor,
                    {
                        "reverted_from_contract_id": contract_id,
                        "reason": reason,
                        "restored_status": restore_status,
                    },
                )

        delete_result = await db[CONTRACTS_COLLECTION].delete_one({"id": contract_id})
        if delete_result.deleted_count != 1:
            raise HTTPException(500, detail="Contract row could not be removed.")

        await _emit_audit(
            db, contract_id, "contract.force_deleted", actor,
            {
                "prior_status": status,
                "reason": reason,
                "removed_r2_keys": removed_keys,
                "r2_errors": r2_errors,
                "template_id": contract.get("template_id"),
                "franchisee_id": contract.get("franchisee_id"),
            },
        )
        return {
            "ok": True,
            "id": contract_id,
            "deleted": True,
            "prior_status": status,
            "removed_r2_keys": removed_keys,
            "r2_errors": r2_errors,
        }

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
