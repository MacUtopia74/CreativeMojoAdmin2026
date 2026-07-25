"""Contract template lifecycle — Phase 1C strict approval + retire.

Adds the Phase 1C ``approve`` endpoint that ENFORCES the strict Stop
Point 3 gate before a template can be used to issue real contracts:

    * every occurrence renders at ≥ its ``min_font_size``
      (no overflow anywhere in the preview render report)
    * every required substitution is acknowledged
    * ``residual_token_count == 0`` (no leftover ``[[...]]`` in preview)
    * source PDF SHA on the object store matches the DB value
    * template is in ``draft`` or ``pending_approval`` status

There is no force-approve. If any check fails, the endpoint responds
400 with an itemised list of blockers.

Also exposes:

    * ``POST  /admin/contract-templates/{id}/retire``
      — soft-retires an approved template. Existing issuances keep
      working; new drafts referring to this template are refused.
    * ``GET   /admin/contract-templates/{id}/versions``
      — history of frozen versions for auditing.

The Phase 1B ``/publish`` endpoint is left untouched for backwards
compatibility and continues to publish under the older
``ready_for_approval`` gate.
"""
from __future__ import annotations

import hashlib
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List

from fastapi import Depends, HTTPException

import contract_markers_library as markers_library
import contract_preview_generator as previewgen
import file_storage as fs


TEMPLATES_COLLECTION = "contract_templates"
VERSIONS_COLLECTION = "contract_template_versions"
AUDIT_COLLECTION = "contract_template_audit"


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


def _build_substitution_groups(
    markers: List[Dict[str, Any]],
    acknowledgements: Dict[str, Any],
) -> List[Dict[str, Any]]:
    """Mirror of the Marker Review UI's family-group rollup — a family
    needs HQ acknowledgement only when the source font is embedded but
    as a non-reusable subset (matches ``contract_font_resolver``)."""
    by_family: Dict[str, Dict[str, Any]] = {}
    for m in markers:
        family = m.get("font_family") or "Unknown"
        g = by_family.setdefault(
            family,
            {
                "font_family": family,
                "is_embedded": bool(m.get("is_embedded")),
                "is_reusable": bool(m.get("is_reusable")),
                "occurrence_count": 0,
            },
        )
        g["occurrence_count"] += 1
    out: List[Dict[str, Any]] = []
    for family, g in by_family.items():
        sub_req = bool(g["is_embedded"]) and not bool(g["is_reusable"])
        acked = bool(acknowledgements.get(family))
        out.append({**g, "substitution_required": sub_req, "acknowledged": acked})
    return out


async def _run_strict_approval_check(
    db,
    template: Dict[str, Any],
) -> Dict[str, Any]:
    """Rebuild the preview report and enforce the strict gate.

    Returns a report dict with ``blockers: List[str]`` empty on
    success. The caller decides whether to translate to HTTP 400.
    """
    blockers: List[str] = []

    if template.get("status") not in {"draft", "pending_approval"}:
        blockers.append(
            f"Template status is '{template.get('status')}' — only drafts and "
            "pending_approval templates can be approved."
        )

    # Source PDF integrity
    src = (template.get("source_pdf") or {})
    key = src.get("r2_key")
    stored_sha = template.get("pdf_sha256")
    if not key or not stored_sha:
        blockers.append("Template is missing source PDF r2_key or pdf_sha256.")
        return {"blockers": blockers}
    try:
        raw = fs.get_client().get_object(Bucket=fs.R2_BUCKET, Key=key)["Body"].read()
    except Exception as exc:  # noqa: BLE001
        blockers.append(f"Unable to read source PDF from object store: {exc}")
        return {"blockers": blockers}
    live_sha = hashlib.sha256(raw).hexdigest()
    if live_sha != stored_sha:
        blockers.append(
            "Source PDF SHA-256 in object store does not match the DB value. "
            f"stored={stored_sha[:12]}… live={live_sha[:12]}…"
        )

    # Substitution acks
    markers_list = template.get("markers") or []
    acks = template.get("substitution_acknowledgements") or {}
    groups = _build_substitution_groups(markers_list, acks)
    unacked = [
        g["font_family"]
        for g in groups
        if g["substitution_required"] and not g["acknowledged"]
    ]
    if unacked:
        blockers.append(
            "Substitution acknowledgement missing for font "
            f"famil{'y' if len(unacked) == 1 else 'ies'}: "
            f"{', '.join(unacked)}."
        )

    # Preview render → overflow + residual tokens
    lib_docs = [d async for d in db[markers_library.LIBRARY_COLLECTION].find({})]
    lib_by = {d["code"]: d for d in lib_docs}
    enriched = []
    for m in markers_list:
        e = dict(m)
        entry = lib_by.get(m.get("code"))
        if entry:
            e["data_type"] = entry.get("data_type", "string")
        enriched.append(e)

    try:
        _preview_bytes, report = previewgen.generate_sample_preview(
            raw, enriched, values=None, template_name=template.get("name") or "template",
        )
    except Exception as exc:  # noqa: BLE001
        blockers.append(f"Preview render failed: {exc}")
        return {"blockers": blockers, "substitution_groups": groups}

    overflow_offenders = [
        f"{r['code']} p{r['page']}"
        for r in report["occurrences"]
        if r.get("overflow")
    ]
    if overflow_offenders:
        blockers.append(
            "Overflow detected on: " + ", ".join(overflow_offenders)
        )

    residual = int(report.get("residual_token_count") or 0)
    if residual != 0:
        blockers.append(
            f"Residual token count is {residual} (must be 0). "
            "Some `[[MARKER]]` tokens are not being redacted."
        )
    if not report.get("redaction_verified"):
        blockers.append("Redaction verification failed on the rebuild.")

    # Recognised-markers gate (Phase 1B)
    summary = template.get("marker_summary") or {}
    for label, field in [
        ("unrecognised markers", "unrecognised"),
        ("duplicate offenders", "duplicate_offenders"),
        ("template-required missing", "template_required_missing"),
    ]:
        vals = summary.get(field) or []
        if vals:
            blockers.append(
                f"{label}: {', '.join(str(v) for v in vals)}."
            )
    if summary.get("cross_line_errors_count", 0):
        blockers.append(
            f"Cross-line errors present: {summary['cross_line_errors_count']}."
        )

    return {
        "blockers": blockers,
        "substitution_groups": groups,
        "preview_report_summary": {
            "occurrence_count": len(report["occurrences"]),
            "residual_token_count": residual,
            "redaction_verified": report.get("redaction_verified"),
        },
        "source_pdf_sha256_live": live_sha,
    }


def attach(api, db, require_role):
    """Register /admin/contract-templates/{id}/approve etc."""

    @api.post("/admin/contract-templates/{template_id}/approve")
    async def approve_template(
        template_id: str,
        user: dict = Depends(require_role("admin")),
    ):
        existing = await db[TEMPLATES_COLLECTION].find_one({"id": template_id})
        if not existing:
            raise HTTPException(404, detail="Template not found")

        check = await _run_strict_approval_check(db, existing)
        if check["blockers"]:
            raise HTTPException(
                400,
                detail={
                    "message": "Template failed the Phase 1C strict approval gate.",
                    "blockers": check["blockers"],
                    "substitution_groups": check.get("substitution_groups", []),
                },
            )

        now = _now_iso()
        approved_version_number = int(existing.get("current_version") or 1)
        # Archive any prior approved template of the same contract type
        ctype = existing["contract_type"]
        await db[TEMPLATES_COLLECTION].update_many(
            {"contract_type": ctype, "status": "approved", "id": {"$ne": template_id}},
            {"$set": {"status": "retired", "updated_at": now, "updated_by": user.get("email")}},
        )
        # Set this template's status to approved
        await db[TEMPLATES_COLLECTION].update_one(
            {"id": template_id},
            {"$set": {
                "status": "approved",
                "approved_at": now,
                "approved_by": user.get("email"),
                "approved_version": approved_version_number,
                "updated_at": now,
                "updated_by": user.get("email"),
            }},
        )
        # Freeze the version snapshot — immutable from now on
        await db[VERSIONS_COLLECTION].update_one(
            {"template_id": template_id, "version_number": approved_version_number},
            {"$set": {
                "frozen_at": now,
                "frozen_by": user.get("email"),
                "approval_report": check,
            }},
        )
        # Audit
        await db[AUDIT_COLLECTION].insert_one({
            "id": _new_id(),
            "template_id": template_id,
            "action": "template.approve",
            "actor": user.get("email"),
            "at": now,
            "extra": {
                "approved_version": approved_version_number,
                "source_pdf_sha256_live": check.get("source_pdf_sha256_live"),
            },
        })
        return _strip_mongo(await db[TEMPLATES_COLLECTION].find_one({"id": template_id}))

    @api.post("/admin/contract-templates/{template_id}/retire")
    async def retire_template(
        template_id: str,
        user: dict = Depends(require_role("admin")),
    ):
        existing = await db[TEMPLATES_COLLECTION].find_one({"id": template_id})
        if not existing:
            raise HTTPException(404, detail="Template not found")
        if existing.get("status") == "retired":
            return _strip_mongo(existing)
        now = _now_iso()
        await db[TEMPLATES_COLLECTION].update_one(
            {"id": template_id},
            {"$set": {
                "status": "retired",
                "retired_at": now,
                "retired_by": user.get("email"),
                "updated_at": now,
                "updated_by": user.get("email"),
            }},
        )
        await db[AUDIT_COLLECTION].insert_one({
            "id": _new_id(),
            "template_id": template_id,
            "action": "template.retire",
            "actor": user.get("email"),
            "at": now,
        })
        return _strip_mongo(await db[TEMPLATES_COLLECTION].find_one({"id": template_id}))

    @api.patch("/admin/contract-templates/{template_id}/signing-block")
    async def set_signing_block(
        template_id: str,
        payload: dict,
        user: dict = Depends(require_role("admin")),
    ):
        """Set the rectangle on a template where the electronic
        acceptance block (typed name + timestamp + contract reference)
        is overlaid on portal acceptance. When not set, a sensible
        default (last page, bottom-left) is used."""
        existing = await db[TEMPLATES_COLLECTION].find_one({"id": template_id})
        if not existing:
            raise HTTPException(404, detail="Template not found")
        # Accept either a full block or nulls to clear.
        clear = payload.get("clear") is True
        if clear:
            update = {"signing_block": None}
        else:
            try:
                block = {
                    "page":   int(payload.get("page") or 1),
                    "x":      float(payload["x"]),
                    "y":      float(payload["y"]),
                    "width":  float(payload["width"]),
                    "height": float(payload["height"]),
                }
            except (KeyError, TypeError, ValueError):
                raise HTTPException(400, detail="Body must include page, x, y, width, height (numeric), or {clear: true}.")
            if block["width"] < 40 or block["height"] < 20:
                raise HTTPException(400, detail="width must be ≥ 40 and height ≥ 20 points.")
            pages = int(existing.get("pdf_page_count") or 1)
            if block["page"] < 1 or block["page"] > pages:
                raise HTTPException(400, detail=f"page must be between 1 and {pages}.")
            update = {"signing_block": block}
        now = _now_iso()
        update["updated_at"] = now
        update["updated_by"] = user.get("email")
        await db[TEMPLATES_COLLECTION].update_one(
            {"id": template_id}, {"$set": update},
        )
        await db[AUDIT_COLLECTION].insert_one({
            "id": _new_id(),
            "template_id": template_id,
            "action": "template.signing_block.set",
            "actor": user.get("email"),
            "at": now,
            "extra": update.get("signing_block"),
        })
        return _strip_mongo(await db[TEMPLATES_COLLECTION].find_one({"id": template_id}))

    @api.get("/admin/contract-templates/{template_id}/versions")
    async def list_versions(
        template_id: str,
        _: dict = Depends(require_role("admin")),
    ):
        existing = await db[TEMPLATES_COLLECTION].find_one({"id": template_id})
        if not existing:
            raise HTTPException(404, detail="Template not found")
        cur = db[VERSIONS_COLLECTION].find({"template_id": template_id}).sort([("version_number", -1)])
        items = [_strip_mongo(d) async for d in cur]
        return {"items": items, "total": len(items)}

    @api.post("/admin/contract-templates/{template_id}/approval-check")
    async def approval_dry_run(
        template_id: str,
        _: dict = Depends(require_role("admin")),
    ):
        """Dry-run — surface blockers WITHOUT applying any state change.
        HQ uses this in the UI to see what needs fixing before hitting
        the real Approve button."""
        existing = await db[TEMPLATES_COLLECTION].find_one({"id": template_id})
        if not existing:
            raise HTTPException(404, detail="Template not found")
        report = await _run_strict_approval_check(db, existing)
        return {
            "ok": len(report["blockers"]) == 0,
            **report,
        }

    return api
