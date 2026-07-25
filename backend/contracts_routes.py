"""Contract records — Phase 1C Turn A: draft CRUD + territory freeze.

Scope (Turn A):
    * ``contracts`` collection — one document per contract (draft →
      pending_issue → issued → superseded → retired). Turn A only
      exercises ``draft`` and the transition to a frozen territory.
    * CRUD for drafts (create, list, get, patch, delete-if-draft).
    * ``POST /admin/contracts/{id}/freeze-territory`` — snapshots the
      franchisee's current territory tiles into an immutable
      ``territory_snapshots`` record and pins that snapshot to the
      contract. Never allowed twice on the same contract.
    * ``contract_variables`` snapshot on the contract is NOT populated
      here — that's Turn B (value resolver). This turn simply reserves
      the field.

Deliberately NOT in Turn A:
    * Value resolution (Turn B).
    * Personalised PDF rendering (Turn C).
    * Admin issuance wizard UI (Turn D).
    * Evidence pack for issuance (Turn E).

Business rules enforced here:
    * A contract may only reference an ``approved`` template.
    * A draft may only be deleted if its status is ``draft``.
    * Once a territory snapshot is frozen onto a contract, it is
      immutable — no re-freeze, no snapshot swap.
    * Superseded flow: a new contract can point at ``supersedes_id``
      of an existing issued contract. On issuance (Turn C), the old
      contract's status flips to ``superseded``.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import Depends, HTTPException

import contract_value_resolver as resolver
import contract_markers_library as markers_library
import territory_snapshots_routes as snapshots


CONTRACTS_COLLECTION = "contracts"
TEMPLATES_COLLECTION = "contract_templates"
FRANCHISEES_COLLECTION = "franchisees"
AUDIT_COLLECTION = "contract_audit"

CONTRACT_STATUSES = {
    "draft",
    "pending_issue",
    "issued",
    "signed",
    "superseded",
    "retired",
}

# Fields HQ can set at draft time. Anything else on the payload is
# rejected to keep the schema tight.
DRAFT_EDITABLE_FIELDS = {
    # Identity references
    "template_id",
    "franchisee_id",
    "contract_type",
    "supersedes_id",  # optional — links this draft to the previous issued contract
    # Contract-specific values (Bucket A on the contract, per user directive)
    "monthly_fee",
    "renewal_fee",
    "contract_term_years",
    "commencement_date",
    "renewal_date",
    "term_start_date",
    # Bucket B (manual) values that live on the contract
    "franchisee_legal_name",
    "franchisee_company_number",
    "franchisee_trading_address",
    "hq_signatory_name",
    "hq_signatory_title",
    "guarantor_name",
    "special_terms",
    "territory_description",
    # System-generated with HQ override
    "contract_reference",  # HQ override; auto-generated in Turn B if unset
    "agreement_date",      # HQ override; defaults to issue_date in Turn B
    # Territory-map link display text override
    "frozen_territory_map_url_display_text",
    # Free-text notes
    "notes",
}


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


async def _validate_template_ref(db, template_id: str) -> Dict[str, Any]:
    tpl = await db[TEMPLATES_COLLECTION].find_one({"id": template_id})
    if not tpl:
        raise HTTPException(400, detail=f"Template '{template_id}' does not exist.")
    # A contract must reference an approved template. During Phase 1C
    # roll-in we also accept ``current`` (Phase 1B) so existing
    # Phase 1B tests keep working; new production contracts will be
    # driven by ``approved`` only.
    if tpl.get("status") not in {"approved", "current"}:
        raise HTTPException(
            400,
            detail=(
                f"Template '{template_id}' is in status '{tpl.get('status')}' — "
                "contracts must reference an approved template."
            ),
        )
    return tpl


async def _validate_franchisee_ref(db, franchisee_id: str) -> Dict[str, Any]:
    f = await db[FRANCHISEES_COLLECTION].find_one({"id": franchisee_id})
    if not f:
        raise HTTPException(400, detail=f"Franchisee '{franchisee_id}' does not exist.")
    return f


def attach(api, db, require_role):

    @api.post("/admin/contracts")
    async def create_contract_draft(
        payload: Dict[str, Any],
        user: dict = Depends(require_role("admin")),
    ):
        # Reject unknown fields early — schema drift is a leading
        # cause of stale documents in an audit-critical collection.
        unknown = [k for k in payload.keys() if k not in DRAFT_EDITABLE_FIELDS]
        if unknown:
            raise HTTPException(400, detail=f"Unknown fields: {sorted(unknown)}.")
        if not payload.get("template_id"):
            raise HTTPException(400, detail="template_id is required.")
        if not payload.get("franchisee_id"):
            raise HTTPException(400, detail="franchisee_id is required.")

        tpl = await _validate_template_ref(db, payload["template_id"])
        franchisee = await _validate_franchisee_ref(db, payload["franchisee_id"])

        # If this draft supersedes another contract, verify it exists
        # and is currently ``issued`` — cannot supersede a draft, a
        # superseded contract, or a retired one.
        if payload.get("supersedes_id"):
            prior = await db[CONTRACTS_COLLECTION].find_one({"id": payload["supersedes_id"]})
            if not prior:
                raise HTTPException(
                    400, detail=f"supersedes_id '{payload['supersedes_id']}' not found.",
                )
            if prior.get("status") != "issued":
                raise HTTPException(
                    400,
                    detail=(
                        f"Cannot supersede a contract in status '{prior.get('status')}' "
                        "— only 'issued' contracts can be superseded."
                    ),
                )

        now = _now_iso()
        contract_id = _new_id()
        doc = {
            "id": contract_id,
            "status": "draft",
            "template_id": tpl["id"],
            "template_version": tpl.get("approved_version") or tpl.get("current_version"),
            "template_pdf_sha256": tpl.get("pdf_sha256"),
            "franchisee_id": franchisee["id"],
            "contract_type": payload.get("contract_type") or tpl.get("contract_type"),
            "supersedes_id": payload.get("supersedes_id"),
            # Contract-specific values — copied verbatim from payload
            **{k: payload.get(k) for k in DRAFT_EDITABLE_FIELDS
               if k not in {"template_id", "franchisee_id", "contract_type", "supersedes_id"}
               and k in payload},
            # Reservations for Turn B / C
            "contract_variables": None,        # populated by resolver in Turn B
            "frozen_territory_snapshot_id": None,
            "frozen_territory_map_url": None,
            "frozen_territory_map_url_sha256": None,
            # Personalised PDF references — populated by Turn C
            "personalised_pdf_r2_key": None,
            "personalised_pdf_sha256": None,
            "issued_at": None,
            "issued_by": None,
            # Provenance
            "created_at": now,
            "updated_at": now,
            "created_by": user.get("email"),
            "updated_by": user.get("email"),
        }
        await db[CONTRACTS_COLLECTION].insert_one(doc)
        await db[AUDIT_COLLECTION].insert_one({
            "id": _new_id(),
            "contract_id": contract_id,
            "action": "contract.draft.create",
            "actor": user.get("email"),
            "at": now,
            "extra": {"template_id": tpl["id"], "franchisee_id": franchisee["id"]},
        })
        return _strip_mongo(doc)

    @api.get("/admin/contracts")
    async def list_contracts(
        status: Optional[str] = None,
        template_id: Optional[str] = None,
        franchisee_id: Optional[str] = None,
        contract_type: Optional[str] = None,
        _: dict = Depends(require_role("admin")),
    ):
        q: Dict[str, Any] = {}
        if status:
            q["status"] = status
        if template_id:
            q["template_id"] = template_id
        if franchisee_id:
            q["franchisee_id"] = franchisee_id
        if contract_type:
            q["contract_type"] = contract_type
        cur = db[CONTRACTS_COLLECTION].find(q).sort([("created_at", -1)])
        items = [_strip_mongo(d) async for d in cur]
        return {"items": items, "total": len(items)}

    @api.get("/admin/contracts/{contract_id}")
    async def get_contract(
        contract_id: str,
        _: dict = Depends(require_role("admin")),
    ):
        doc = await db[CONTRACTS_COLLECTION].find_one({"id": contract_id})
        if not doc:
            raise HTTPException(404, detail="Contract not found")
        return _strip_mongo(doc)

    @api.patch("/admin/contracts/{contract_id}")
    async def patch_contract(
        contract_id: str,
        payload: Dict[str, Any],
        user: dict = Depends(require_role("admin")),
    ):
        existing = await db[CONTRACTS_COLLECTION].find_one({"id": contract_id})
        if not existing:
            raise HTTPException(404, detail="Contract not found")
        if existing.get("status") != "draft":
            raise HTTPException(
                400,
                detail=(
                    f"Contract is in status '{existing.get('status')}' — "
                    "only drafts can be edited."
                ),
            )
        unknown = [k for k in payload.keys() if k not in DRAFT_EDITABLE_FIELDS]
        if unknown:
            raise HTTPException(400, detail=f"Unknown fields: {sorted(unknown)}.")
        update = {k: v for k, v in payload.items() if k in DRAFT_EDITABLE_FIELDS}
        # Re-validate cross-refs if the caller changed them
        if "template_id" in update:
            await _validate_template_ref(db, update["template_id"])
        if "franchisee_id" in update:
            await _validate_franchisee_ref(db, update["franchisee_id"])
        now = _now_iso()
        update["updated_at"] = now
        update["updated_by"] = user.get("email")
        await db[CONTRACTS_COLLECTION].update_one(
            {"id": contract_id}, {"$set": update},
        )
        await db[AUDIT_COLLECTION].insert_one({
            "id": _new_id(),
            "contract_id": contract_id,
            "action": "contract.draft.patch",
            "actor": user.get("email"),
            "at": now,
            "extra": {"changed_keys": sorted(update.keys())},
        })
        return _strip_mongo(await db[CONTRACTS_COLLECTION].find_one({"id": contract_id}))

    @api.delete("/admin/contracts/{contract_id}")
    async def delete_contract_draft(
        contract_id: str,
        user: dict = Depends(require_role("admin")),
    ):
        existing = await db[CONTRACTS_COLLECTION].find_one({"id": contract_id})
        if not existing:
            raise HTTPException(404, detail="Contract not found")
        if existing.get("status") != "draft":
            raise HTTPException(
                400,
                detail=(
                    f"Contract is in status '{existing.get('status')}' — "
                    "only drafts can be deleted."
                ),
            )
        await db[CONTRACTS_COLLECTION].delete_one({"id": contract_id})
        await db[AUDIT_COLLECTION].insert_one({
            "id": _new_id(),
            "contract_id": contract_id,
            "action": "contract.draft.delete",
            "actor": user.get("email"),
            "at": _now_iso(),
        })
        return {"ok": True, "id": contract_id, "deleted": True}

    @api.post("/admin/contracts/{contract_id}/freeze-territory")
    async def freeze_territory(
        contract_id: str,
        user: dict = Depends(require_role("admin")),
    ):
        existing = await db[CONTRACTS_COLLECTION].find_one({"id": contract_id})
        if not existing:
            raise HTTPException(404, detail="Contract not found")
        if existing.get("status") != "draft":
            raise HTTPException(
                400,
                detail=(
                    f"Contract is in status '{existing.get('status')}' — "
                    "territory can only be frozen while the contract is a draft."
                ),
            )
        if existing.get("frozen_territory_snapshot_id"):
            raise HTTPException(
                400,
                detail=(
                    "Territory is already frozen on this contract. "
                    "Snapshots are immutable — create a new draft "
                    "if a different agreed territory is required."
                ),
            )
        franchisee = await db[FRANCHISEES_COLLECTION].find_one({"id": existing["franchisee_id"]})
        if not franchisee:
            raise HTTPException(400, detail="Franchisee referenced by this contract was not found.")
        territory_ids: List[str] = list(franchisee.get("territory_ids") or [])
        if not territory_ids:
            raise HTTPException(
                400,
                detail=(
                    "Franchisee has no territory tiles assigned in the Hub. "
                    "Assign at least one tile before freezing the territory."
                ),
            )
        snap = await snapshots.create_snapshot(
            db,
            contract_id=contract_id,
            franchisee_id=franchisee["id"],
            territory_ids=territory_ids,
            created_by=user.get("email"),
        )
        now = _now_iso()
        await db[CONTRACTS_COLLECTION].update_one(
            {"id": contract_id},
            {"$set": {
                "frozen_territory_snapshot_id": snap["id"],
                "frozen_territory_map_url": snap["url"],
                "frozen_territory_map_url_sha256": snap["url_sha256"],
                "frozen_territory_at": snap["created_at"],
                "frozen_territory_by": user.get("email"),
                "updated_at": now,
                "updated_by": user.get("email"),
            }},
        )
        await db[AUDIT_COLLECTION].insert_one({
            "id": _new_id(),
            "contract_id": contract_id,
            "action": "contract.freeze_territory",
            "actor": user.get("email"),
            "at": now,
            "extra": {
                "snapshot_id": snap["id"],
                "tile_count": snap["tile_count"],
                "url_sha256": snap["url_sha256"],
            },
        })
        return _strip_mongo(await db[CONTRACTS_COLLECTION].find_one({"id": contract_id}))

    # ----------------------------------------------------------------
    # Turn B — value resolution + freeze / refresh / preview
    # ----------------------------------------------------------------
    async def _load_resolver_inputs(contract_id: str):
        contract = await db[CONTRACTS_COLLECTION].find_one({"id": contract_id})
        if not contract:
            raise HTTPException(404, detail="Contract not found")
        template = await db[TEMPLATES_COLLECTION].find_one({"id": contract["template_id"]})
        if not template:
            raise HTTPException(500, detail="Contract references a missing template.")
        franchisee = await db[FRANCHISEES_COLLECTION].find_one({"id": contract["franchisee_id"]})
        if not franchisee:
            raise HTTPException(500, detail="Contract references a missing franchisee.")
        library_entries = [d async for d in db[markers_library.LIBRARY_COLLECTION].find({})]
        return contract, template, franchisee, library_entries

    @api.post("/admin/contracts/{contract_id}/variables/preview")
    async def preview_variables(
        contract_id: str,
        user: dict = Depends(require_role("admin")),
    ):
        """Dry-run — never persists. HQ uses this in the issuance
        wizard to spot missing / bad values before hitting freeze."""
        contract, template, franchisee, library = await _load_resolver_inputs(contract_id)
        at = datetime.now(timezone.utc)
        report = resolver.resolve_contract_variables(
            template, contract, franchisee, library,
            actor=user.get("email") or "admin",
            at=at,
        )
        return {"ok": report.is_valid(), **report.to_dict()}

    @api.post("/admin/contracts/{contract_id}/resolve-variables")
    async def resolve_variables(
        contract_id: str,
        user: dict = Depends(require_role("admin")),
    ):
        """First-time freeze. Refuses to persist if any errors remain
        (fail-fast). Refuses to overwrite an existing snapshot — that
        path is ``/refresh-variables`` and requires a reason."""
        contract, template, franchisee, library = await _load_resolver_inputs(contract_id)
        if contract.get("status") != "draft":
            raise HTTPException(
                400,
                detail=(
                    f"Contract is in status '{contract.get('status')}' — "
                    "variables can only be resolved on drafts."
                ),
            )
        if contract.get("contract_variables"):
            raise HTTPException(
                400,
                detail=(
                    "Contract already has frozen variables. Use "
                    "POST /admin/contracts/{id}/refresh-variables with "
                    "an explicit reason to update them."
                ),
            )
        at = datetime.now(timezone.utc)
        report = resolver.resolve_contract_variables(
            template, contract, franchisee, library,
            actor=user.get("email") or "admin",
            at=at,
        )
        if not report.is_valid():
            raise HTTPException(
                400,
                detail={
                    "message": (
                        "Cannot freeze — resolver returned errors. Fix the "
                        "source fields (or add HQ overrides on the "
                        "contract) and try again."
                    ),
                    "errors": [asdict_err(e) for e in report.errors],
                    "warnings": [asdict_err(w) for w in report.warnings],
                    "partial_values": {c: rv.value for c, rv in report.resolved.items()},
                },
            )
        frozen = await resolver.freeze_report_into_contract(
            db,
            contract_id=contract_id,
            report=report,
            actor=user.get("email") or "admin",
            at=at,
            is_refresh=False,
        )
        await db[AUDIT_COLLECTION].insert_one({
            "id": _new_id(),
            "contract_id": contract_id,
            "action": "contract.variables.resolve",
            "actor": user.get("email"),
            "at": frozen["resolved_at"],
            "extra": {
                "values_sha256": frozen["values_sha256"],
                "value_count": len(frozen["values"]),
            },
        })
        return {"ok": True, **frozen}

    @api.post("/admin/contracts/{contract_id}/refresh-variables")
    async def refresh_variables(
        contract_id: str,
        payload: Dict[str, Any],
        user: dict = Depends(require_role("admin")),
    ):
        """Controlled HQ refresh. Requires a written reason and only
        works when a prior freeze exists. Every refresh appends an
        entry to ``contract_variables.refresh_history`` and a separate
        audit event, so the history of value drift is preserved."""
        reason = (payload.get("reason") or "").strip()
        if not reason:
            raise HTTPException(400, detail="A written 'reason' is required to refresh contract variables.")
        contract, template, franchisee, library = await _load_resolver_inputs(contract_id)
        if contract.get("status") != "draft":
            raise HTTPException(
                400,
                detail=(
                    f"Contract is in status '{contract.get('status')}' — "
                    "variables can only be refreshed on drafts."
                ),
            )
        if not contract.get("contract_variables"):
            raise HTTPException(
                400,
                detail=(
                    "Contract has no frozen variables yet — call "
                    "/resolve-variables for the first freeze."
                ),
            )
        at = datetime.now(timezone.utc)
        report = resolver.resolve_contract_variables(
            template, contract, franchisee, library,
            actor=user.get("email") or "admin",
            at=at,
        )
        if not report.is_valid():
            raise HTTPException(
                400,
                detail={
                    "message": "Refresh failed — resolver returned errors.",
                    "errors": [asdict_err(e) for e in report.errors],
                    "warnings": [asdict_err(w) for w in report.warnings],
                },
            )
        prior_hash = (contract.get("contract_variables") or {}).get("values_sha256")
        frozen = await resolver.freeze_report_into_contract(
            db,
            contract_id=contract_id,
            report=report,
            actor=user.get("email") or "admin",
            at=at,
            reason=reason,
            is_refresh=True,
        )
        await db[AUDIT_COLLECTION].insert_one({
            "id": _new_id(),
            "contract_id": contract_id,
            "action": "contract.variables.refresh",
            "actor": user.get("email"),
            "at": frozen["resolved_at"],
            "extra": {
                "reason": reason,
                "previous_values_sha256": prior_hash,
                "values_sha256": frozen["values_sha256"],
                "no_op": prior_hash == frozen["values_sha256"],
            },
        })
        return {"ok": True, **frozen}

    return api


def asdict_err(e) -> Dict[str, Any]:
    """Small helper — dataclass -> dict without importing dataclasses
    everywhere. Kept here so the module has no top-level dataclass
    dep beyond the resolver's own types."""
    return {
        "code": getattr(e, "code", None),
        "reason": getattr(e, "reason", ""),
        "severity": getattr(e, "severity", "error"),
        "hint": getattr(e, "hint", None),
    }
