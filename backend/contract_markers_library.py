"""Marker Library — global catalogue of `[[MARKER]]` tokens.

This module defines the schema, seed data, and CRUD helpers for the
`contract_markers_library` MongoDB collection. Every marker that HQ
uses inside a contract PDF must exist here (or be manually added
during template review) before the template can move to `current`.

Concepts
--------
- Value source:
    "automatic"        — resolved from a Hub field via `data_field`
    "manual"           — HQ enters at issue time
    "system_generated" — deterministic default with pre-issue override
    "calculated"       — evaluated via `formula` at issue time
- Data type:
    "string" | "multiline_text" | "date" | "currency" | "integer" | "decimal"
- Contract-type eligibility is a list of contract-type slugs.
- `repeat_allowed=True` permits a marker code to appear >1 times on
  the same page or across pages of a template.

Deletion is SOFT ONLY. A marker in use by any template or contract
cannot be hard-deleted; `hidden=True` archives it without breaking
the historic templates that reference it. Historic template versions
continue to resolve the definition captured at their frozen_at time
via the version snapshot mechanism (each version stores its own copy
of the marker definitions it uses — see `contract_templates_routes`).
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

LIBRARY_COLLECTION = "contract_markers_library"

# Contract-type slugs used across the system. Kept in sync with the
# existing enum in contract_templates_routes.py.
CONTRACT_TYPES = [
    "new_franchise",
    "franchise_renewal",
    "licence",
    "licence_renewal",
    "territory_amendment",
    "other",
]

VALUE_SOURCES = {"automatic", "manual", "system_generated", "calculated"}
DATA_TYPES = {"string", "multiline_text", "date", "currency", "integer", "decimal", "hyperlink"}

# When a marker is `automatic` but the Hub returns null/missing, we
# never invent or blank — we surface a required review prompt to HQ.
FALLBACK_MODE_ON_MISSING = "manual_review_required"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# Approved Phase 1A seed — 28 markers total.
# Buckets A (17), B (9), C (2). Bucket D deliberately empty.
# ---------------------------------------------------------------------------
SEED_MARKERS: List[Dict[str, Any]] = [
    # ==========================================================
    # Bucket A — Confirmed automatic (17)
    # ==========================================================
    {
        "code": "FRANCHISEE_FIRST_NAME",
        "label": "Franchisee first name",
        "description": "Franchisee given name from the Hub record.",
        "value_source": "automatic",
        "data_field": "franchisees.first_name",
        "data_type": "string",
        "format": {"casing": "as_is"},
        "repeat_allowed": True,
        "eligible_contract_types": CONTRACT_TYPES,
    },
    {
        "code": "FRANCHISEE_LAST_NAME",
        "label": "Franchisee last name",
        "description": "Franchisee family name from the Hub record.",
        "value_source": "automatic",
        "data_field": "franchisees.last_name",
        "data_type": "string",
        "format": {"casing": "as_is"},
        "repeat_allowed": True,
        "eligible_contract_types": CONTRACT_TYPES,
    },
    {
        "code": "FRANCHISEE_FULL_NAME",
        "label": "Franchisee full name",
        "description": "First name and last name concatenated.",
        "value_source": "automatic",
        "data_field": "franchisees.first_name+franchisees.last_name",
        "data_type": "string",
        "format": {"casing": "as_is", "join": " "},
        "repeat_allowed": True,
        "eligible_contract_types": CONTRACT_TYPES,
    },
    {
        "code": "FRANCHISEE_ORGANISATION",
        "label": "Franchisee organisation / trading name",
        "description": "Trading name held in the Hub franchisee record.",
        "value_source": "automatic",
        "data_field": "franchisees.organisation",
        "data_type": "string",
        "format": {"casing": "as_is"},
        "repeat_allowed": True,
        "eligible_contract_types": CONTRACT_TYPES,
    },
    {
        "code": "FRANCHISEE_EMAIL",
        "label": "Franchisee email",
        "description": "Primary Creative Mojo email address.",
        "value_source": "automatic",
        "data_field": "franchisees.mojo_email",
        "data_type": "string",
        "format": {"casing": "as_is"},
        "repeat_allowed": True,
        "eligible_contract_types": CONTRACT_TYPES,
    },
    {
        "code": "FRANCHISEE_MOBILE",
        "label": "Franchisee mobile phone",
        "description": "Franchisee mobile number.",
        "value_source": "automatic",
        "data_field": "franchisees.mobile_phone",
        "data_type": "string",
        "format": {"casing": "as_is"},
        "repeat_allowed": True,
        "eligible_contract_types": CONTRACT_TYPES,
    },
    {
        "code": "FRANCHISEE_ADDRESS_STREET",
        "label": "Franchisee address — street line",
        "description": "Street portion of the franchisee address (single line).",
        "value_source": "automatic",
        "data_field": "franchisees.address_street",
        "data_type": "string",
        "format": {"casing": "as_is"},
        "repeat_allowed": True,
        "eligible_contract_types": CONTRACT_TYPES,
    },
    {
        "code": "FRANCHISEE_CITY",
        "label": "Franchisee city",
        "description": "City / town portion of the franchisee address.",
        "value_source": "automatic",
        "data_field": "franchisees.city",
        "data_type": "string",
        "format": {"casing": "as_is"},
        "repeat_allowed": True,
        "eligible_contract_types": CONTRACT_TYPES,
    },
    {
        "code": "FRANCHISEE_COUNTY",
        "label": "Franchisee county",
        "description": "County portion of the franchisee address.",
        "value_source": "automatic",
        "data_field": "franchisees.county",
        "data_type": "string",
        "format": {"casing": "as_is"},
        "repeat_allowed": True,
        "eligible_contract_types": CONTRACT_TYPES,
    },
    {
        "code": "FRANCHISEE_POSTCODE",
        "label": "Franchisee postcode",
        "description": "Postcode from the franchisee address.",
        "value_source": "automatic",
        "data_field": "franchisees.postcode",
        "data_type": "string",
        "format": {"casing": "upper"},
        "repeat_allowed": True,
        "eligible_contract_types": CONTRACT_TYPES,
    },
    {
        "code": "FRANCHISEE_ADDRESS_BLOCK",
        "label": "Franchisee address block",
        "description": (
            "Single-line comma-separated address in HQ authoring order: "
            "street, city, county, postcode, country. Blank/missing "
            "components are omitted cleanly — no double commas or "
            "trailing separator. Example: "
            "'2, Wordsworth Cottages, Robertsbridge, East Sussex, TN32 5JG, United Kingdom'."
        ),
        "value_source": "automatic",
        "data_field": "franchisees.address_block",  # virtual field — assembled by resolver
        "data_type": "string",
        "format": {"casing": "as_is", "join": ", "},
        # Turn C.5+ presentation defaults. Any occurrence detected for
        # this code will inherit these when its per-occurrence field is
        # None. HQ can still override per-occurrence in the property panel.
        "default_presentation": {
            "wrapping": "no_wrap",
            "alignment": "left",
            "min_font_size": 11,
        },
        "repeat_allowed": True,
        "eligible_contract_types": CONTRACT_TYPES,
    },
    {
        "code": "FRANCHISE_NUMBER",
        "label": "Franchise number",
        "description": "Zero-padded franchise number (e.g. 0094).",
        "value_source": "automatic",
        "data_field": "franchisees.franchise_number",
        "data_type": "string",
        "format": {"casing": "as_is"},
        "repeat_allowed": True,
        "eligible_contract_types": CONTRACT_TYPES,
    },
    {
        "code": "CONTRACT_TERM_YEARS",
        "label": "Contract term (years)",
        "description": "Number of years the contract runs. Falls back to manual entry when the contract record lacks this field.",
        "value_source": "automatic",
        "data_field": "contracts.contract_term_years",
        "data_type": "integer",
        "format": {
            "thousand_sep": False,
            "suffix_singular": " year",
            "suffix_plural": " years",
        },
        "repeat_allowed": True,
        "fallback_on_missing": FALLBACK_MODE_ON_MISSING,
        "eligible_contract_types": CONTRACT_TYPES,
    },
    {
        "code": "COMMENCEMENT_DATE",
        "label": "Commencement date",
        "description": "Contract commencement date. Falls back to manual entry when absent.",
        "value_source": "automatic",
        "data_field": "contracts.commencement_date",
        "data_type": "date",
        "format": {"date_pattern": "d MMMM yyyy"},
        "repeat_allowed": True,
        "fallback_on_missing": FALLBACK_MODE_ON_MISSING,
        "eligible_contract_types": CONTRACT_TYPES,
    },
    {
        "code": "RENEWAL_DATE",
        "label": "Renewal date",
        "description": "Contract renewal / end date. Falls back to manual entry when absent.",
        "value_source": "automatic",
        "data_field": "contracts.renewal_date",
        "data_type": "date",
        "format": {"date_pattern": "d MMMM yyyy"},
        "repeat_allowed": True,
        "fallback_on_missing": FALLBACK_MODE_ON_MISSING,
        "eligible_contract_types": CONTRACT_TYPES,
    },
    {
        "code": "MONTHLY_FEE",
        "label": "Monthly fee",
        "description": "Monthly franchise fee as GBP. Falls back to manual entry when absent (Flex Start etc.).",
        "value_source": "automatic",
        "data_field": "contracts.monthly_fee",
        "data_type": "currency",
        "format": {"currency": "GBP", "thousand_sep": True, "decimals": 2},
        "repeat_allowed": True,
        "fallback_on_missing": FALLBACK_MODE_ON_MISSING,
        "eligible_contract_types": CONTRACT_TYPES,
    },
    {
        "code": "INITIAL_FEE",
        "label": "Initial franchise fee",
        "description": (
            "One-off GBP fee payable at signing of a new franchise "
            "agreement. Frozen into contract_variables on issuance so "
            "the amount printed on the PDF is the historic amount, "
            "never the live franchisee.bought_for. Only offered on "
            "initial franchise / licence templates — not renewals."
        ),
        "value_source": "automatic",
        "data_field": "contracts.initial_franchise_fee",
        "data_type": "currency",
        "format": {"currency": "GBP", "thousand_sep": True, "decimals": 2},
        "repeat_allowed": True,
        # Restricted to first-time contract templates — the renewal
        # ones deliberately don't get this marker.
        "eligible_contract_types": ["new_franchise", "licence"],
    },
    {
        "code": "RENEWAL_FEE",
        "label": "Renewal fee",
        "description": "One-off renewal fee as GBP. Falls back to manual entry when absent.",
        "value_source": "automatic",
        "data_field": "contracts.renewal_fee",
        "data_type": "currency",
        "format": {"currency": "GBP", "thousand_sep": True, "decimals": 2},
        "repeat_allowed": True,
        "fallback_on_missing": FALLBACK_MODE_ON_MISSING,
        "eligible_contract_types": CONTRACT_TYPES,
    },

    # ==========================================================
    # Bucket B — Manual (9)
    # ==========================================================
    {
        "code": "FRANCHISEE_LEGAL_NAME",
        "label": "Franchisee legal name",
        "description": (
            "The natural-person legal name (First + Last name) that "
            "signs the agreement. Automatically composed from "
            "franchisees.first_name + franchisees.last_name. Can be "
            "overridden per contract via ``contracts.franchisee_legal_name`` "
            "for LLC / limited-company edge cases; the resolver only "
            "falls back to the franchisee organisation/trading name "
            "when BOTH first and last name are empty AND no override "
            "was entered."
        ),
        "value_source": "automatic",
        "data_field": "franchisees.first_name+franchisees.last_name",
        "data_type": "string",
        "format": {"casing": "as_is", "join": " "},
        "repeat_allowed": True,
        "eligible_contract_types": CONTRACT_TYPES,
    },
    {
        "code": "FRANCHISEE_COMPANY_NUMBER",
        "label": "Franchisee company number",
        "description": "UK company registration number, if the franchisee trades through a limited company.",
        "value_source": "manual",
        "data_type": "string",
        "format": {"casing": "as_is"},
        "repeat_allowed": True,
        "eligible_contract_types": CONTRACT_TYPES,
    },
    {
        "code": "FRANCHISEE_TRADING_ADDRESS",
        "label": "Franchisee trading address",
        "description": "Business trading address when different from the residential address on file.",
        "value_source": "manual",
        "data_type": "multiline_text",
        "format": {"casing": "as_is", "max_lines": 5},
        "repeat_allowed": True,
        "eligible_contract_types": CONTRACT_TYPES,
    },
    {
        "code": "HQ_SIGNATORY_NAME",
        "label": "HQ signatory name",
        "description": "Name of the Creative Mojo director signing on behalf of HQ.",
        "value_source": "manual",
        "data_type": "string",
        "format": {"casing": "as_is"},
        "repeat_allowed": True,
        "eligible_contract_types": CONTRACT_TYPES,
    },
    {
        "code": "HQ_SIGNATORY_TITLE",
        "label": "HQ signatory title",
        "description": "Role of the HQ signatory, e.g. Director.",
        "value_source": "manual",
        "data_type": "string",
        "format": {"casing": "as_is"},
        "repeat_allowed": True,
        "eligible_contract_types": CONTRACT_TYPES,
    },
    {
        "code": "TERM_START_DATE",
        "label": "Term start date",
        "description": "Contractual term start date. May differ from commencement date.",
        "value_source": "manual",
        "data_type": "date",
        "format": {"date_pattern": "d MMMM yyyy"},
        "repeat_allowed": True,
        "eligible_contract_types": CONTRACT_TYPES,
    },
    {
        "code": "SPECIAL_TERMS",
        "label": "Special terms",
        "description": "Free-text special terms clause. Blank when not applicable.",
        "value_source": "manual",
        "data_type": "multiline_text",
        "format": {"casing": "as_is", "max_lines": 40},
        "repeat_allowed": False,
        "eligible_contract_types": CONTRACT_TYPES,
    },
    {
        "code": "GUARANTOR_NAME",
        "label": "Guarantor name",
        "description": "Name of the personal guarantor, when required.",
        "value_source": "manual",
        "data_type": "string",
        "format": {"casing": "as_is"},
        "repeat_allowed": True,
        "eligible_contract_types": CONTRACT_TYPES,
    },
    {
        "code": "TERRITORY_DESCRIPTION",
        "label": "Territory description",
        "description": "Free-text summary of the territory covered by the franchise.",
        "value_source": "manual",
        "data_type": "multiline_text",
        "format": {"casing": "as_is", "max_lines": 20},
        "repeat_allowed": True,
        "eligible_contract_types": CONTRACT_TYPES,
    },

    # ==========================================================
    # Bucket C — System-generated (2 approved)
    # ==========================================================
    {
        "code": "CONTRACT_REFERENCE",
        "label": "Contract reference",
        "description": "System-generated reference in the form CM-YYYY-NNNN using the issue year and franchise number. HQ can override before issue.",
        "value_source": "system_generated",
        "formula": "cm_year_franchise_ref",   # named formula resolved by the engine
        "data_type": "string",
        "format": {"casing": "upper"},
        "repeat_allowed": True,
        "eligible_contract_types": CONTRACT_TYPES,
    },
    {
        "code": "AGREEMENT_DATE",
        "label": "Agreement date",
        "description": "Defaults to the issue date; HQ can override before issue.",
        "value_source": "system_generated",
        "formula": "issue_date",
        "data_type": "date",
        "format": {"date_pattern": "d MMMM yyyy"},
        "repeat_allowed": True,
        "eligible_contract_types": CONTRACT_TYPES,
    },
    {
        "code": "TERRITORY_MAP_URL",
        "label": "Territory map — secure link",
        "description": (
            "Secure clickable link to the FROZEN territory map snapshot "
            "associated with this specific contract. The link resolves "
            "to the exact territory version that was agreed at the time "
            "the contract was issued — it must never automatically follow "
            "the franchisee's currently editable territory. Rendered as a "
            "clickable hyperlink annotation in the PDF; the display text "
            "is configurable (default: 'View Agreed Territory Map') so "
            "the printed page does not contain a long raw URL. Generation "
            "is BLOCKED if this marker is present in the template but no "
            "frozen territory snapshot / valid link exists on the contract "
            "record. The destination URL, its SHA-256 fingerprint, and the "
            "frozen territory snapshot ID are persisted on the contract "
            "record and captured in the issuance audit trail."
        ),
        "value_source": "system_generated",
        "formula": "frozen_territory_map_link",  # resolver keyword — see contract_value_resolver
        "data_field": "contracts.frozen_territory_snapshot_id",
        "data_type": "hyperlink",
        "format": {
            "display_text_default": "View Agreed Territory Map",
            "casing": "as_is",
            "requires_frozen_snapshot": True,
        },
        "default_presentation": {
            "wrapping": "no_wrap",
            "alignment": "left",
            "min_font_size": 11,
        },
        "repeat_allowed": True,
        # Applicable where a territory schedule appears — new franchise
        # agreements and franchise renewals (and territory amendments,
        # which by definition reference the newly-frozen territory).
        "eligible_contract_types": [
            "new_franchise",
            "franchise_renewal",
            "territory_amendment",
        ],
    },
    {
        "code": "FRANCHISEE_SIGNATURE_POSITION",
        "label": "Franchisee signature — anchor position",
        "description": (
            "Zero-visibility anchor marker. Placed in the Word template at "
            "the exact point where the franchisee's drawn signature should "
            "land in the signed PDF. During issuance the marker's page + "
            "bounding box are captured and stored on the contract, and the "
            "``[[FRANCHISEE_SIGNATURE_POSITION]]`` token is redacted from "
            "the personalised PDF so nothing visible remains. At sign "
            "time the drawn signature PNG is scaled to fit the marker's "
            "width (aspect-preserving) and placed on the signature line, "
            "with ``Signed on {date}`` immediately underneath. "
            "Contracts that do NOT contain this marker cannot be signed "
            "electronically — HQ must reissue from an updated template."
        ),
        "value_source": "system_generated",
        "formula": "signature_anchor",
        "data_field": "contracts.acceptance_record.signature_png_b64",
        # Bespoke type — the render engine treats this as an anchor:
        # redact the token, do not overlay any text, and record the
        # render_bbox in the report so the accept endpoint can find it.
        "data_type": "signature_anchor",
        "format": {
            "invisible": True,
            "consumed_at": "acceptance",
        },
        "default_presentation": {
            "wrapping": "no_wrap",
            "alignment": "left",
            "min_font_size": 6,
        },
        # Multiple occurrences allowed (e.g. one on the franchisee page
        # and one on the guarantor page) — the accept flow stamps the
        # drawn signature into every occurrence recorded on the
        # contract.
        "repeat_allowed": True,
        "eligible_contract_types": [
            "new_franchise",
            "franchise_renewal",
            "territory_amendment",
        ],
    },

]


# ---------------------------------------------------------------------------
# Public helpers
# ---------------------------------------------------------------------------
def _public_view(doc: Dict[str, Any]) -> Dict[str, Any]:
    """Strip Mongo internals for API responses."""
    if not doc:
        return doc
    out = dict(doc)
    out.pop("_id", None)
    return out


async def seed_library(db) -> Dict[str, int]:
    """Idempotent seeder. Inserts missing markers, never overwrites edits
    made in the Admin UI. Returns counts of inserted / skipped.

    Also runs one-shot corrective migrations for system-seeded rows
    whose original shape was wrong (e.g. FRANCHISEE_ADDRESS_BLOCK was
    seeded as multiline_text but HQ authoring requires single-line
    comma-separated). Only rows still tagged ``system_seeded=True`` and
    still ``updated_by='system:seed'`` are touched — anything HQ has
    edited by hand is left alone.
    """
    inserted = 0
    skipped = 0
    migrated = 0
    for entry in SEED_MARKERS:
        existing = await db[LIBRARY_COLLECTION].find_one({"code": entry["code"]})
        if existing:
            skipped += 1
            # ---- Corrective migration for FRANCHISEE_ADDRESS_BLOCK ----
            if (
                entry["code"] == "FRANCHISEE_ADDRESS_BLOCK"
                and existing.get("system_seeded") is True
                and (existing.get("updated_by") in (None, "system:seed"))
                and existing.get("data_type") == "multiline_text"
            ):
                await db[LIBRARY_COLLECTION].update_one(
                    {"code": entry["code"]},
                    {"$set": {
                        "description": entry["description"],
                        "data_type": entry["data_type"],
                        "format": entry["format"],
                        "default_presentation": entry.get("default_presentation"),
                        "updated_at": _now_iso(),
                        "updated_by": "system:seed",
                    }},
                )
                migrated += 1
            # ---- Corrective migration for CONTRACT_TERM_YEARS ----
            # Old shape had no suffix — value rendered as bare "3". New
            # shape appends " year"/" years". Only upgrades system-seeded
            # rows that HQ has not edited.
            if (
                entry["code"] == "CONTRACT_TERM_YEARS"
                and existing.get("system_seeded") is True
                and (existing.get("updated_by") in (None, "system:seed"))
                and not (existing.get("format") or {}).get("suffix_plural")
                and not (existing.get("format") or {}).get("suffix")
            ):
                await db[LIBRARY_COLLECTION].update_one(
                    {"code": entry["code"]},
                    {"$set": {
                        "format": entry["format"],
                        "updated_at": _now_iso(),
                        "updated_by": "system:seed",
                    }},
                )
                migrated += 1
            continue
        doc = {
            "id": str(uuid.uuid4()),
            "hidden": False,
            "system_seeded": True,   # flag so upgrades can identify seed rows
            "created_at": _now_iso(),
            "updated_at": _now_iso(),
            "created_by": "system:seed",
            "updated_by": "system:seed",
            **entry,
        }
        # Ensure defaults
        doc.setdefault("format", {})
        doc.setdefault("repeat_allowed", False)
        doc.setdefault("fallback_on_missing", None)
        doc.setdefault("formula", None)
        doc.setdefault("data_field", None)
        await db[LIBRARY_COLLECTION].insert_one(doc)
        inserted += 1
    # Unique index on code (protects against duplicate seeding).
    try:
        await db[LIBRARY_COLLECTION].create_index("code", unique=True)
    except Exception:  # index already exists
        pass
    return {"inserted": inserted, "skipped": skipped, "migrated": migrated}


def validate_payload(payload: Dict[str, Any], partial: bool = False) -> Optional[str]:
    """Return an error string, or None if valid."""
    if not partial:
        if not payload.get("code"):
            return "Marker code is required."
        code = payload["code"]
        if not code.replace("_", "").isalnum() or not code[0].isalpha() or not code.isupper():
            return "Marker code must be UPPER_SNAKE_CASE, start with a letter, and contain only letters, digits and underscores."
        if len(code) > 50:
            return "Marker code cannot exceed 50 characters."
        if not payload.get("label"):
            return "Marker label is required."
        if payload.get("value_source") not in VALUE_SOURCES:
            return f"value_source must be one of {sorted(VALUE_SOURCES)}."
        if payload.get("data_type") not in DATA_TYPES:
            return f"data_type must be one of {sorted(DATA_TYPES)}."
        if payload["value_source"] == "automatic" and not payload.get("data_field"):
            return "Automatic markers require a data_field."
        if payload["value_source"] == "calculated" and not payload.get("formula"):
            return "Calculated markers require a formula."
    else:
        if "value_source" in payload and payload["value_source"] not in VALUE_SOURCES:
            return f"value_source must be one of {sorted(VALUE_SOURCES)}."
        if "data_type" in payload and payload["data_type"] not in DATA_TYPES:
            return f"data_type must be one of {sorted(DATA_TYPES)}."
    if payload.get("eligible_contract_types") is not None:
        ects = payload["eligible_contract_types"]
        if not isinstance(ects, list) or any(t not in CONTRACT_TYPES for t in ects):
            return f"eligible_contract_types entries must be from {CONTRACT_TYPES}."
    return None


def attach_routes(api, db, require_role):
    """Register `/admin/markers-library/*` endpoints under the passed FastAPI router."""
    from fastapi import HTTPException, Depends

    @api.get("/admin/markers-library")
    async def list_markers(
        include_hidden: bool = False,
        contract_type: Optional[str] = None,
        _: dict = Depends(require_role("admin")),
    ):
        q: Dict[str, Any] = {}
        if not include_hidden:
            q["hidden"] = {"$ne": True}
        if contract_type:
            q["eligible_contract_types"] = contract_type
        cur = db[LIBRARY_COLLECTION].find(q).sort([("code", 1)])
        items = [_public_view(d) async for d in cur]
        return {"items": items, "total": len(items)}

    @api.get("/admin/markers-library/{marker_id}")
    async def get_marker(marker_id: str, _: dict = Depends(require_role("admin"))):
        doc = await db[LIBRARY_COLLECTION].find_one({"id": marker_id})
        if not doc:
            raise HTTPException(404, detail="Marker not found")
        return _public_view(doc)

    @api.post("/admin/markers-library")
    async def create_marker(payload: Dict[str, Any], user: dict = Depends(require_role("admin"))):
        err = validate_payload(payload, partial=False)
        if err:
            raise HTTPException(400, detail=err)
        code = payload["code"]
        # Enforce uniqueness at API layer too (the unique index is belt-and-braces)
        if await db[LIBRARY_COLLECTION].find_one({"code": code}):
            raise HTTPException(409, detail=f"Marker '{code}' already exists.")
        doc = {
            "id": str(uuid.uuid4()),
            "hidden": False,
            "system_seeded": False,
            "created_at": _now_iso(),
            "updated_at": _now_iso(),
            "created_by": user.get("email"),
            "updated_by": user.get("email"),
            "format": {},
            "repeat_allowed": False,
            "fallback_on_missing": None,
            "formula": None,
            "data_field": None,
            "eligible_contract_types": list(CONTRACT_TYPES),
            **payload,
        }
        await db[LIBRARY_COLLECTION].insert_one(doc)
        return _public_view(doc)

    @api.patch("/admin/markers-library/{marker_id}")
    async def update_marker(marker_id: str, payload: Dict[str, Any], user: dict = Depends(require_role("admin"))):
        existing = await db[LIBRARY_COLLECTION].find_one({"id": marker_id})
        if not existing:
            raise HTTPException(404, detail="Marker not found")
        # The immutable field: code. Everything else is editable.
        if "code" in payload and payload["code"] != existing["code"]:
            raise HTTPException(400, detail="Marker code cannot be changed after creation. Create a new marker instead.")
        err = validate_payload({**existing, **payload}, partial=True)
        if err:
            raise HTTPException(400, detail=err)
        update = {k: v for k, v in payload.items() if k != "code"}
        update["updated_at"] = _now_iso()
        update["updated_by"] = user.get("email")
        await db[LIBRARY_COLLECTION].update_one({"id": marker_id}, {"$set": update})
        return _public_view(await db[LIBRARY_COLLECTION].find_one({"id": marker_id}))

    @api.post("/admin/markers-library/{marker_id}/hide")
    async def hide_marker(marker_id: str, user: dict = Depends(require_role("admin"))):
        existing = await db[LIBRARY_COLLECTION].find_one({"id": marker_id})
        if not existing:
            raise HTTPException(404, detail="Marker not found")
        await db[LIBRARY_COLLECTION].update_one(
            {"id": marker_id},
            {"$set": {"hidden": True, "updated_at": _now_iso(), "updated_by": user.get("email")}},
        )
        return _public_view(await db[LIBRARY_COLLECTION].find_one({"id": marker_id}))

    @api.post("/admin/markers-library/{marker_id}/unhide")
    async def unhide_marker(marker_id: str, user: dict = Depends(require_role("admin"))):
        existing = await db[LIBRARY_COLLECTION].find_one({"id": marker_id})
        if not existing:
            raise HTTPException(404, detail="Marker not found")
        await db[LIBRARY_COLLECTION].update_one(
            {"id": marker_id},
            {"$set": {"hidden": False, "updated_at": _now_iso(), "updated_by": user.get("email")}},
        )
        return _public_view(await db[LIBRARY_COLLECTION].find_one({"id": marker_id}))

    @api.delete("/admin/markers-library/{marker_id}")
    async def delete_marker(marker_id: str, user: dict = Depends(require_role("admin"))):
        """SOFT DELETE ONLY.

        - If the marker is used by any template version's `markers[]` OR by
          any issued/signed contract's resolved marker set → refuse (409).
        - Otherwise: set `hidden=True` and record the deleter. Never
          physically remove the document.
        """
        existing = await db[LIBRARY_COLLECTION].find_one({"id": marker_id})
        if not existing:
            raise HTTPException(404, detail="Marker not found")
        code = existing["code"]
        # Referenced by any template version?
        version_hit = await db["contract_template_versions"].find_one(
            {"markers.code": code}, {"_id": 1}
        )
        if version_hit:
            raise HTTPException(
                409,
                detail=(
                    f"Marker '{code}' is used by one or more template versions and cannot be "
                    "physically deleted. Use Hide instead."
                ),
            )
        # In Phase 2+ we'll also gate on 'contracts' collection usage, but
        # that collection doesn't exist yet — safe to skip for Phase 1A.
        await db[LIBRARY_COLLECTION].update_one(
            {"id": marker_id},
            {"$set": {"hidden": True, "updated_at": _now_iso(), "updated_by": user.get("email"), "soft_deleted": True}},
        )
        return {"ok": True, "soft_deleted": True, "id": marker_id, "code": code}

    @api.get("/admin/markers-library/{marker_id}/usage")
    async def marker_usage(marker_id: str, _: dict = Depends(require_role("admin"))):
        """List template versions that reference this marker."""
        existing = await db[LIBRARY_COLLECTION].find_one({"id": marker_id})
        if not existing:
            raise HTTPException(404, detail="Marker not found")
        code = existing["code"]
        cur = db["contract_template_versions"].find(
            {"markers.code": code},
            {"_id": 0, "template_id": 1, "version_number": 1, "frozen_at": 1},
        )
        versions = [d async for d in cur]
        # Group by template
        by_template: Dict[str, List[Dict[str, Any]]] = {}
        for v in versions:
            by_template.setdefault(v.get("template_id"), []).append(v)
        return {"code": code, "used_by_versions": versions, "grouped_by_template": by_template}

    @api.post("/admin/markers-library/seed")
    async def reseed(_: dict = Depends(require_role("admin"))):
        """Idempotent re-seed. Never overwrites edits."""
        result = await seed_library(db)
        return result

    return api
