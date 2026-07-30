"""Portal contract acceptance — franchisee in-Hub signing (MVP).

Simple authenticated acceptance (no drawn signatures, no certificates,
no DocuSign). Endpoints under ``/portal/contracts`` gated by
``require_role("franchisee")`` — the request's authenticated user
must own the contract via ``franchisee_id``.

The acceptance flow:

    1. Franchisee logs into the Hub.
    2. Opens their issued contract in the portal.
    3. Ticks a checkbox affirming they've read the terms.
    4. Types their full name.
    5. Clicks "Accept and sign contract".

On acceptance we:

    * Verify the contract is theirs and its status is ``issued``.
    * Load the personalised PDF from R2 and compute its SHA-256.
    * Append a single **signing page** with the acceptance details:
      typed name, contract reference, exact issued-PDF SHA, acceptance
      wording, UTC timestamp, IP, browser user-agent.
    * Store the signed-final PDF at
      ``contract-issuances/{id}/signed-final.pdf`` (never overwrites).
    * Persist ``acceptance_record`` on the contract, flip status
      ``issued → signed``, and emit an audit event.

The existing HQ ``POST /admin/contracts/{id}/upload-signed`` endpoint
stays available as a fallback (offline signature).
"""
from __future__ import annotations

import hashlib
import io
import logging
import uuid
from datetime import datetime, timezone
from zoneinfo import ZoneInfo
from typing import Any, Dict, Optional, Tuple

import fitz
from fastapi import Depends, HTTPException, Request

import file_storage as fs


logger = logging.getLogger(__name__)


CONTRACTS_COLLECTION = "contracts"
FRANCHISEES_COLLECTION = "franchisees"
AUDIT_COLLECTION = "contract_audit"

ACCEPTANCE_WORDING = (
    "I confirm that I have read and agree to the terms of this franchise agreement."
)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _now_iso() -> str:
    return _now().isoformat()


def _new_id() -> str:
    return uuid.uuid4().hex


def _strip_mongo(doc: Dict[str, Any]) -> Dict[str, Any]:
    if not doc:
        return doc
    doc = dict(doc)
    doc.pop("_id", None)
    return doc


def _pick_ip(request: Request) -> str:
    """Behind Kubernetes ingress the client's real IP arrives in
    ``X-Forwarded-For`` (comma-separated). We take the first entry
    (client's actual IP) with a fallback to the socket peer."""
    fwd = request.headers.get("x-forwarded-for") or request.headers.get("x-real-ip") or ""
    if fwd:
        return fwd.split(",")[0].strip()
    if request.client:
        return request.client.host
    return "unknown"


def _redact_franchisee_contract(contract: Dict[str, Any]) -> Dict[str, Any]:
    """Only expose fields the franchisee is allowed to see. HQ-only
    fields like ``render_report_summary`` and R2 keys are stripped."""
    if not contract:
        return contract
    out = {
        "id": contract["id"],
        "status": contract.get("status"),
        "contract_type": contract.get("contract_type"),
        "issued_at": contract.get("issued_at"),
        "signed_at": contract.get("signed_at"),
        "superseded_at": contract.get("superseded_at"),
        "superseded_by_contract_id": contract.get("superseded_by_contract_id"),
        "personalised_pdf_sha256": contract.get("personalised_pdf_sha256"),
        "personalised_pdf_byte_size": contract.get("personalised_pdf_byte_size"),
        "personalised_pdf_created_at": contract.get("personalised_pdf_created_at"),
        "signed_pdf_sha256": contract.get("signed_pdf_sha256"),
        "signed_pdf_byte_size": contract.get("signed_pdf_byte_size"),
        "signed_pdf_uploaded_at": contract.get("signed_pdf_uploaded_at"),
        "template_id": contract.get("template_id"),
        "acceptance_record": contract.get("acceptance_record"),
    }
    # Include the contract_reference from the frozen variables (if present)
    cv = contract.get("contract_variables") or {}
    values = cv.get("values") or {}
    ref = (values.get("CONTRACT_REFERENCE") or {}).get("value")
    if ref:
        out["contract_reference"] = ref
    return out


def _default_signing_block(pdf_page_count: int) -> Dict[str, Any]:
    """Fallback rectangle used when a template has no ``signing_block``
    configured yet. Sits low on the last page, roughly where a
    franchisee signature line typically lives (below the last body
    text, above the footer)."""
    return {
        "page": pdf_page_count,
        "x": 60,
        "y": 680,
        "width": 340,
        "height": 70,
    }


def _overlay_acceptance_block(
    personalised_bytes: bytes,
    *,
    signing_block: Dict[str, Any],
    typed_name: str,
    organisation: str,
    contract_reference: Optional[str],
    accepted_at: datetime,
) -> Tuple[bytes, Dict[str, Any]]:
    """Return ``(new_pdf_bytes, stamp_visible_fields)``.

    The returned ``stamp_visible_fields`` dict is the exact set of
    values written onto the PDF stamp — persisted alongside the
    acceptance record so the DB audit and the on-page stamp are
    provably from the same signing event. Every caller MUST persist
    that dict verbatim; do not mutate before storing.

    The source ``personalised_bytes`` buffer is never modified; we
    open it via ``BytesIO`` and save to a fresh buffer so the R2
    object for the issued PDF stays byte-for-byte immutable.
    """
    src = fitz.open(stream=io.BytesIO(personalised_bytes), filetype="pdf")
    try:
        page_num = int(signing_block.get("page") or src.page_count)
        if page_num < 1 or page_num > src.page_count:
            page_num = src.page_count
        x = float(signing_block.get("x", 60))
        y = float(signing_block.get("y", 700))
        w = float(signing_block.get("width", 300))
        # Grow the stamp block a bit — the extra "Electronically signed"
        # heading + organisation line push us past the historical 60pt
        # height. Templates that already specify a taller height win.
        h = float(signing_block.get("height", 92))
        page = src[page_num - 1]

        # Subtle border so HQ can locate the overlay clearly.
        page.draw_rect(fitz.Rect(x, y, x + w, y + h),
                       color=(0.6, 0.6, 0.6), width=0.4)

        # UK local time for the acceptance date/time line + ISO for
        # the audit copy. Both come from the same ``accepted_at``.
        accepted_uk = accepted_at.astimezone(ZoneInfo("Europe/London"))
        date_display = accepted_uk.strftime("%-d %B %Y, %H:%M %Z").strip()

        # Wording matches the DB-persisted ``signature_wording`` field
        # so the stamp text and the audit record can never drift apart.
        signature_wording = "Electronically signed"

        # Layout — heading in bold, details in normal weight, 12pt line
        # step so five lines fit comfortably in the 92pt tall block.
        page.insert_text(
            (x + 6, y + 14),
            signature_wording,
            fontsize=10, fontname="helv", color=(0, 0, 0),
            render_mode=0,
        )
        # Simulate bold on the heading via a second overlay pass — the
        # bundled ``helv`` font has no true bold, but a subtle offset
        # gives an unmistakable weight without embedding a new font.
        page.insert_text(
            (x + 6.4, y + 14),
            signature_wording,
            fontsize=10, fontname="helv", color=(0, 0, 0),
        )

        def _line(offset_y: int, text: str) -> None:
            page.insert_text(
                (x + 6, y + offset_y),
                text,
                fontsize=9.5, fontname="helv", color=(0.1, 0.1, 0.1),
            )

        _line(30, f"Name: {typed_name}")
        _line(45, f"Organisation: {organisation or '—'}")
        _line(60, f"Date and time: {date_display}")
        if contract_reference:
            _line(75, f"Contract reference: {contract_reference}")

        out = io.BytesIO()
        src.save(out, deflate=True, garbage=3, clean=True)

        stamp_visible_fields = {
            "typed_name": typed_name,
            "organisation": organisation or "",
            "signed_at": accepted_at.astimezone(ZoneInfo("Europe/London")).isoformat(),
            "contract_reference": contract_reference or "",
            "signature_wording": signature_wording,
        }
        return out.getvalue(), stamp_visible_fields
    finally:
        src.close()


def attach(api, db, require_role):

    async def _load_own_contract(contract_id: str, user: Dict[str, Any]) -> Dict[str, Any]:
        contract = await db[CONTRACTS_COLLECTION].find_one({"id": contract_id})
        if not contract:
            raise HTTPException(404, detail="Contract not found.")
        if contract.get("franchisee_id") != user.get("franchisee_id"):
            # Never leak — same 404 as if the row didn't exist.
            raise HTTPException(404, detail="Contract not found.")
        # Franchisees may only ever see contracts that HQ has already
        # issued. Drafts and ``pending_issue`` rows are HQ-only — even
        # a franchisee who guesses the contract ID must get the same
        # 404 as if the row didn't exist.
        if contract.get("status") not in {"issued", "signed", "superseded"}:
            raise HTTPException(404, detail="Contract not found.")
        return contract

    @api.get("/portal/contracts")
    async def portal_list_contracts(
        user: dict = Depends(require_role("franchisee")),
    ):
        fid = user.get("franchisee_id")
        if not fid:
            raise HTTPException(400, detail="User is not linked to a franchisee record.")
        cur = db[CONTRACTS_COLLECTION].find(
            {"franchisee_id": fid, "status": {"$in": ["issued", "signed", "superseded"]}},
        ).sort([("created_at", -1)])
        items = [_redact_franchisee_contract(_strip_mongo(c)) async for c in cur]
        return {"items": items, "total": len(items)}

    @api.get("/portal/contracts/{contract_id}")
    async def portal_get_contract(
        contract_id: str,
        user: dict = Depends(require_role("franchisee")),
    ):
        c = await _load_own_contract(contract_id, user)
        return _redact_franchisee_contract(c)

    @api.get("/portal/contracts/{contract_id}/personalised-pdf")
    async def portal_personalised_pdf(
        contract_id: str,
        user: dict = Depends(require_role("franchisee")),
    ):
        c = await _load_own_contract(contract_id, user)
        if not c.get("personalised_pdf_r2_key"):
            raise HTTPException(404, detail="Personalised PDF not available on this contract.")
        url = fs.presigned_get_url(
            c["personalised_pdf_r2_key"],
            expires_in=600,
            content_disposition=f'inline; filename="{contract_id}.pdf"',
        )
        return {
            "url": url,
            "sha256": c["personalised_pdf_sha256"],
            "byte_size": c["personalised_pdf_byte_size"],
            "created_at": c["personalised_pdf_created_at"],
            "expires_in_seconds": 600,
        }

    @api.get("/portal/contracts/{contract_id}/signed-pdf")
    async def portal_signed_pdf(
        contract_id: str,
        user: dict = Depends(require_role("franchisee")),
    ):
        c = await _load_own_contract(contract_id, user)
        if not c.get("signed_pdf_r2_key"):
            raise HTTPException(404, detail="Signed PDF not available on this contract.")
        url = fs.presigned_get_url(
            c["signed_pdf_r2_key"],
            expires_in=600,
            content_disposition=f'inline; filename="{contract_id}-signed.pdf"',
        )
        return {
            "url": url,
            "sha256": c["signed_pdf_sha256"],
            "byte_size": c["signed_pdf_byte_size"],
            "created_at": c.get("signed_pdf_uploaded_at"),
            "expires_in_seconds": 600,
        }

    @api.post("/portal/contracts/{contract_id}/accept")
    async def portal_accept_contract(
        contract_id: str,
        payload: Dict[str, Any],
        request: Request,
        user: dict = Depends(require_role("franchisee")),
    ):
        c = await _load_own_contract(contract_id, user)
        if c.get("status") != "issued":
            raise HTTPException(
                409,
                detail=(
                    f"Contract is in status '{c.get('status')}' — "
                    "only issued contracts can be accepted."
                ),
            )
        # Payload validation — enforce the checkbox + non-empty typed name
        confirmed = bool(payload.get("checkbox_confirmed"))
        if not confirmed:
            raise HTTPException(400, detail="The acceptance checkbox must be ticked.")
        typed_name = (payload.get("typed_name") or "").strip()
        if not typed_name:
            raise HTTPException(400, detail="Please type your full name to accept.")
        if len(typed_name) > 120:
            raise HTTPException(400, detail="Typed name is too long (max 120 characters).")
        if not c.get("personalised_pdf_r2_key"):
            raise HTTPException(500, detail="Personalised PDF is missing on this contract.")

        # Guard against a race — another acceptance may have arrived
        # between the read above and now. head_object is atomic on R2.
        signed_key = f"contract-issuances/{contract_id}/signed-final.pdf"
        if fs.head_object(signed_key) is not None:
            raise HTTPException(
                409,
                detail=(
                    f"A signed PDF already exists at {signed_key}. Signed "
                    "PDFs are immutable — refresh the page to see it."
                ),
            )

        # Load personalised PDF + verify its SHA against the stored value
        personalised_bytes = fs.get_client().get_object(
            Bucket=fs.R2_BUCKET, Key=c["personalised_pdf_r2_key"],
        )["Body"].read()
        live_sha = hashlib.sha256(personalised_bytes).hexdigest()
        if c.get("personalised_pdf_sha256") and live_sha != c["personalised_pdf_sha256"]:
            raise HTTPException(
                500,
                detail=(
                    "Personalised PDF SHA-256 in R2 doesn't match the DB "
                    "value — acceptance blocked for tamper protection."
                ),
            )

        # Franchisee identity for the acceptance record + audit
        fr = await db[FRANCHISEES_COLLECTION].find_one({"id": c["franchisee_id"]})
        franchisee_full_name = f"{(fr or {}).get('first_name') or ''} {(fr or {}).get('last_name') or ''}".strip() or (fr or {}).get("organisation") or ""
        franchisee_email = user.get("email") or (fr or {}).get("mojo_email") or ""
        # Organisation stamped on the signed PDF + persisted verbatim
        # in ``stamp_visible_fields``. Falls back to territory_name
        # only if the primary field is empty — so we never stamp an
        # empty "Organisation:" line when both are set.
        stamp_organisation = (
            ((fr or {}).get("organisation") or "").strip()
            or ((fr or {}).get("territory_name") or "").strip()
        )

        # Template — used to pick the signing block rectangle
        tpl = await db["contract_templates"].find_one({"id": c["template_id"]})
        template_name = (tpl or {}).get("name") or c["template_id"]
        signing_block = (tpl or {}).get("signing_block") or _default_signing_block(
            (tpl or {}).get("pdf_page_count") or 1
        )

        # Contract reference from frozen variables
        cv = c.get("contract_variables") or {}
        ref = ((cv.get("values") or {}).get("CONTRACT_REFERENCE") or {}).get("value")

        # Build the signed-final PDF by overlaying the acceptance block
        # onto the personalised PDF. The personalised R2 object is
        # never modified — we work on an in-memory copy.
        accepted_at = _now()
        ip = _pick_ip(request)
        user_agent = request.headers.get("user-agent") or "unknown"
        signed_bytes, stamp_visible_fields = _overlay_acceptance_block(
            personalised_bytes,
            signing_block=signing_block,
            typed_name=typed_name,
            organisation=stamp_organisation,
            contract_reference=ref,
            accepted_at=accepted_at,
        )
        signed_sha = hashlib.sha256(signed_bytes).hexdigest()
        signed_size = len(signed_bytes)

        # Upload — no-overwrite (re-check head_object)
        if fs.head_object(signed_key) is not None:
            raise HTTPException(409, detail="A signed PDF was written in a race — refresh.")
        fs.get_client().put_object(
            Bucket=fs.R2_BUCKET,
            Key=signed_key,
            Body=signed_bytes,
            ContentType="application/pdf",
            CacheControl="private, no-store",
            Metadata={
                "contract-id": contract_id,
                "signed-sha256": signed_sha,
                "content-length": str(signed_size),
                "accepted-by": franchisee_email,
                "acceptance-method": "portal.electronic",
            },
        )

        acceptance_record = {
            "franchisee_user_id": user.get("id"),
            "franchisee_email": franchisee_email,
            "franchisee_full_name": franchisee_full_name,
            "typed_name": typed_name,
            "contract_id": contract_id,
            "contract_reference": ref,
            "issued_pdf_sha256": live_sha,
            "acceptance_wording": ACCEPTANCE_WORDING,
            "accepted_at": accepted_at.isoformat(),
            "ip": ip,
            "user_agent": user_agent,
            "method": "portal.electronic",
            "signed_pdf_sha256": signed_sha,
            # The exact set of values written onto the stamp on the
            # final page of ``signed-final.pdf``. Persisted verbatim
            # so a legal review can prove the DB record and the PDF
            # stamp came from the same signing event.
            "stamp_visible_fields": stamp_visible_fields,
        }

        # Flip status only if it's still 'issued' — CAS guard against races
        result = await db[CONTRACTS_COLLECTION].update_one(
            {"id": contract_id, "status": "issued"},
            {"$set": {
                "status": "signed",
                "signed_pdf_r2_key": signed_key,
                "signed_pdf_sha256": signed_sha,
                "signed_pdf_byte_size": signed_size,
                "signed_pdf_uploaded_at": accepted_at.isoformat(),
                "signed_pdf_uploaded_by": franchisee_email,
                "signed_at": accepted_at.isoformat(),
                "acceptance_record": acceptance_record,
                "updated_at": accepted_at.isoformat(),
                "updated_by": franchisee_email,
            }},
        )
        if result.modified_count != 1:
            # Contract wasn't in 'issued' anymore — race with HQ upload
            raise HTTPException(
                409,
                detail=(
                    "Contract was signed by another path while your "
                    "acceptance was in flight. Refresh the page."
                ),
            )

        # Two audit events — acceptance intent + resulting signed state
        await db[AUDIT_COLLECTION].insert_one({
            "id": _new_id(),
            "contract_id": contract_id,
            "action": "contract.accepted",
            "actor": franchisee_email or (user.get("id") or "franchisee"),
            "at": accepted_at.isoformat(),
            "extra": acceptance_record,
        })
        await db[AUDIT_COLLECTION].insert_one({
            "id": _new_id(),
            "contract_id": contract_id,
            "action": "contract.signed",
            "actor": franchisee_email or (user.get("id") or "franchisee"),
            "at": accepted_at.isoformat(),
            "extra": {
                "method": "portal.electronic",
                "r2_key": signed_key,
                "signed_sha256": signed_sha,
                "byte_size": signed_size,
            },
        })

        return _redact_franchisee_contract(
            await db[CONTRACTS_COLLECTION].find_one({"id": contract_id})
        )

    return api
