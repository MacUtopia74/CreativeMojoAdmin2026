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
import base64
import logging
import uuid
from datetime import datetime, timezone
from zoneinfo import ZoneInfo
from typing import Any, Dict, Optional, Tuple

import fitz
from fastapi import Depends, HTTPException, Request
from fastapi.responses import Response as FastAPIResponse

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
        # True when the template used to issue this contract contained
        # a [[FRANCHISEE_SIGNATURE_POSITION]] marker. Drives the portal
        # UI's decision between showing the signature pad and showing
        # the "reissue required" message.
        "has_signature_anchor": bool(_find_signature_anchors(contract)),
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


def _find_signature_anchors(contract: Dict[str, Any]) -> list:
    """Return the list of signature-anchor occurrences captured on the
    contract at issuance time — each a dict with ``page`` (1-based)
    and ``render_bbox`` (x0,y0,x1,y1 in PDF points).

    Contracts issued from templates that did NOT contain the
    ``[[FRANCHISEE_SIGNATURE_POSITION]]`` marker return an empty list;
    the accept endpoint uses that to hard-block signing with a clear
    "reissue from an updated template" message.
    """
    if not contract:
        return []
    anchors: list = []
    for occ in (contract.get("signature_anchors") or []):
        bbox = occ.get("render_bbox") or []
        if len(bbox) != 4:
            continue
        anchors.append({
            "page": int(occ.get("page") or 0),
            "render_bbox": [float(v) for v in bbox],
            "occurrence_id": occ.get("occurrence_id"),
        })
    return anchors


def _trim_png_padding(png_bytes: bytes) -> bytes:
    """Crop transparent padding around a PNG so it scales tightly to
    its bounding box. Returns the cropped PNG. If the image is fully
    opaque (no alpha or all pixels visible) it's returned unchanged.
    """
    try:
        from PIL import Image
    except ImportError:
        # Pillow is a transitive dependency of the R2 SDK stack — this
        # branch should never fire in prod. Fail open: leave the PNG
        # as-is rather than blocking a sign attempt on a missing dep.
        return png_bytes
    im = Image.open(io.BytesIO(png_bytes)).convert("RGBA")
    bbox = im.getchannel("A").getbbox()
    if not bbox or bbox == (0, 0, *im.size):
        return png_bytes
    cropped = im.crop(bbox)
    out = io.BytesIO()
    cropped.save(out, format="PNG", optimize=True)
    return out.getvalue()


def _overlay_signature(
    personalised_bytes: bytes,
    *,
    anchors: list,
    signature_png_bytes: bytes,
    accepted_at: datetime,
) -> Tuple[bytes, Dict[str, Any]]:
    """Return ``(new_pdf_bytes, stamp_visible_fields)``.

    Iterates every signature anchor recorded on the contract and:
      1. Crops the transparent padding around the signature PNG
      2. Scales it to fit the anchor's width preserving aspect ratio,
         clipped to the anchor's height
      3. Places the image sitting on the signature line (aligned to
         the bottom of the render_bbox)
      4. Writes ``Signed on {DD Month YYYY}`` immediately underneath

    The source ``personalised_bytes`` buffer is never modified — we
    open via ``BytesIO`` and save to a fresh buffer so the R2 object
    for the issued PDF stays byte-for-byte immutable.
    """
    if not anchors:
        # Caller enforces this too — belt-and-braces so we never mint
        # a signed PDF without a marker-recorded anchor.
        raise ValueError(
            "No FRANCHISEE_SIGNATURE_POSITION anchors on this contract."
        )
    trimmed_png = _trim_png_padding(signature_png_bytes)
    # Reuse a single Pixmap across every anchor — PyMuPDF requires a
    # fitz.Pixmap or bytes; passing raw bytes is fine and simpler.
    src = fitz.open(stream=io.BytesIO(personalised_bytes), filetype="pdf")
    try:
        accepted_uk = accepted_at.astimezone(ZoneInfo("Europe/London"))
        # UK-friendly "Signed on 31 July 2026" — no time here, per spec.
        date_display = f"Signed on {accepted_uk.strftime('%-d %B %Y')}"

        anchors_stamped = []
        for anchor in anchors:
            page_num = anchor["page"]
            if page_num < 1 or page_num > src.page_count:
                # Skip anchors that don't map onto the actual PDF (a
                # template with a signature marker on a page that was
                # dropped by a page-range render, for instance).
                continue
            page = src[page_num - 1]
            x0, y0, x1, y1 = anchor["render_bbox"]
            box_w = max(1.0, x1 - x0)
            box_h = max(1.0, y1 - y0)

            # Signature area: bottom half of the anchor box (the ink
            # sits on the signature LINE, which we treat as the
            # bottom edge of the anchor). The "Signed on" text lands
            # in a small strip below the anchor.
            sig_max_w = box_w
            sig_max_h = max(6.0, box_h * 0.85)

            # Compute the image's aspect ratio to fit width-preserving.
            from PIL import Image
            im = Image.open(io.BytesIO(trimmed_png))
            im_w, im_h = im.size
            aspect = (im_h / im_w) if im_w else 1.0
            draw_w = sig_max_w
            draw_h = draw_w * aspect
            if draw_h > sig_max_h:
                draw_h = sig_max_h
                draw_w = draw_h / aspect if aspect > 0 else sig_max_w

            # Position: ink sits ON the signature line — align the
            # image's bottom edge with the bottom of the anchor bbox
            # (which is where a "Signature: ______" line typically
            # lives after Word→PDF conversion).
            img_x0 = x0
            img_y0 = y1 - draw_h
            img_x1 = img_x0 + draw_w
            img_y1 = y1
            page.insert_image(
                fitz.Rect(img_x0, img_y0, img_x1, img_y1),
                stream=trimmed_png,
                keep_proportion=True,
                overlay=True,
            )

            # "Signed on 31 July 2026" — sits ~4pt below the signature
            # line, left-aligned with the anchor.
            date_y = y1 + 12
            page.insert_text(
                (x0, date_y),
                date_display,
                fontsize=9.5, fontname="helv", color=(0.15, 0.15, 0.15),
            )
            anchors_stamped.append({
                "page": page_num,
                "render_bbox": [x0, y0, x1, y1],
                "image_bbox": [img_x0, img_y0, img_x1, img_y1],
                "date_text_baseline": date_y,
            })

        out = io.BytesIO()
        src.save(out, deflate=True, garbage=3, clean=True)

        stamp_visible_fields = {
            "signature_wording": "Electronically signed",
            "signed_on_text": date_display,
            "signed_at": accepted_at.astimezone(ZoneInfo("Europe/London")).isoformat(),
            "anchors_stamped": anchors_stamped,
        }
        return out.getvalue(), stamp_visible_fields
    finally:
        src.close()


def _overlay_acceptance_block(
    personalised_bytes: bytes,
    *,
    signing_block: Dict[str, Any],
    typed_name: str,
    organisation: str,
    contract_reference: Optional[str],
    accepted_at: datetime,
) -> Tuple[bytes, Dict[str, Any]]:
    """LEGACY signature overlay — kept for reference only. New signing
    flow uses ``_overlay_signature`` which reads its coordinates from
    the ``[[FRANCHISEE_SIGNATURE_POSITION]]`` marker recorded at
    issuance time, not from a hard-coded rectangle. This function is
    unreachable from production code paths after Turn D; it stays so
    the pytest suite that still exercises the old wording keeps
    passing while it's rewritten.
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

    @api.get("/portal/contracts/{contract_id}/pdf")
    async def portal_contract_pdf_stream(
        contract_id: str,
        request: Request,
        variant: str = "auto",
        user: dict = Depends(require_role("franchisee")),
    ):
        """Stream the PDF bytes back through the Hub origin.

        Direct R2 pre-signed URLs work in curl but break when the
        browser's PDF.js worker fetches them: R2 CORS blocks the
        cross-origin ``fetch``. Streaming through this endpoint
        keeps the PDF request same-origin, which means the browser
        already sends the session cookie / bearer for auth and no
        CORS handshake is needed.

        ``variant`` values:
          * ``"personalised"`` — the pristine issued PDF
          * ``"signed"`` — the immutable signed copy (only after accept)
          * ``"auto"`` (default) — signed if the contract is signed,
            personalised otherwise. Matches what the portal detail
            modal wants to show without an extra round-trip.
        """
        c = await _load_own_contract(contract_id, user)

        v = (variant or "auto").lower()
        if v == "auto":
            v = "signed" if c.get("status") == "signed" and c.get("signed_pdf_r2_key") else "personalised"

        if v == "signed":
            key = c.get("signed_pdf_r2_key")
            sha = c.get("signed_pdf_sha256")
            filename = f"{contract_id}-signed.pdf"
        elif v == "personalised":
            key = c.get("personalised_pdf_r2_key")
            sha = c.get("personalised_pdf_sha256")
            filename = f"{contract_id}.pdf"
        else:
            raise HTTPException(400, detail=f"Unknown variant '{variant}'.")

        if not key:
            raise HTTPException(404, detail=f"{v.title()} PDF not available on this contract.")

        # Fetch from R2 server-side. Single read into memory is fine
        # for contract PDFs (typically 200-800 KB, hard-capped by the
        # personalise step). Streaming chunked would add complexity
        # for no meaningful gain at this size.
        try:
            obj = fs.get_client().get_object(Bucket=fs.R2_BUCKET, Key=key)
            body = obj["Body"].read()
        except Exception as e:
            logging.exception("portal.contract.pdf.stream.r2_read_failed", extra={
                "contract_id": contract_id, "variant": v, "key": key,
            })
            raise HTTPException(502, detail=f"Could not read contract PDF from storage: {e}")

        # Tamper-proof: if the stored SHA doesn't match, refuse to
        # serve the bytes. Same logic as the accept endpoint — we
        # never let a mutated R2 object reach the franchisee.
        if sha:
            live_sha = hashlib.sha256(body).hexdigest()
            if live_sha != sha:
                logging.error("portal.contract.pdf.stream.sha_mismatch", extra={
                    "contract_id": contract_id, "variant": v,
                    "expected": sha, "actual": live_sha,
                })
                raise HTTPException(500, detail="Contract PDF integrity check failed.")

        # Weak ETag from the SHA — lets the browser 304 on refresh.
        etag = f'W/"{(sha or "").split(":")[-1][:16] or "nosha"}"'
        if request.headers.get("If-None-Match", "") == etag:
            return FastAPIResponse(status_code=304, headers={"ETag": etag})

        return FastAPIResponse(
            content=body,
            media_type="application/pdf",
            headers={
                "Content-Length": str(len(body)),
                "Content-Disposition": f'inline; filename="{filename}"',
                # Contract PDFs shouldn't sit in caches for long — the
                # signed copy replaces the personalised one on accept.
                "Cache-Control": "private, max-age=60, must-revalidate",
                "ETag": etag,
                # Hint to any accidentally-configured intermediary that
                # this response is binary; do not rewrite it.
                "X-Content-Type-Options": "nosniff",
            },
        )

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
        # Payload validation — enforce the checkbox + signature PNG
        confirmed = bool(payload.get("checkbox_confirmed"))
        if not confirmed:
            raise HTTPException(400, detail="The acceptance checkbox must be ticked.")
        # Signature PNG (base64, data URI or raw). Rejected outright
        # when missing so we never mint a signed PDF without ink on
        # the page.
        raw_sig = (payload.get("signature_png_b64") or "").strip()
        if not raw_sig:
            raise HTTPException(400, detail="Please draw your signature to sign.")
        if raw_sig.startswith("data:"):
            # ``data:image/png;base64,...`` — strip the URI prefix.
            _, _, raw_sig = raw_sig.partition(",")
        try:
            signature_png_bytes = base64.b64decode(raw_sig, validate=False)
        except Exception:
            raise HTTPException(400, detail="Signature image is not valid base64.")
        if not signature_png_bytes.startswith(b"\x89PNG\r\n\x1a\n"):
            raise HTTPException(400, detail="Signature image must be a PNG.")
        if len(signature_png_bytes) > 500 * 1024:
            raise HTTPException(413, detail="Signature image is too large (max 500 KB).")

        if not c.get("personalised_pdf_r2_key"):
            raise HTTPException(500, detail="Personalised PDF is missing on this contract.")

        # Signature-anchor gate — HARD-BLOCK legacy contracts that
        # were issued from templates without the
        # ``[[FRANCHISEE_SIGNATURE_POSITION]]`` marker. Neither text
        # detection nor the old boxed overlay is used as a fallback.
        anchors = _find_signature_anchors(c)
        if not anchors:
            raise HTTPException(
                409,
                detail=(
                    "This contract was issued before signature-anchor "
                    "support and cannot be signed electronically. "
                    "Please contact Creative Mojo to reissue the "
                    "contract from an updated template."
                ),
            )

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
        signed_bytes, stamp_visible_fields = _overlay_signature(
            personalised_bytes,
            anchors=anchors,
            signature_png_bytes=signature_png_bytes,
            accepted_at=accepted_at,
        )
        signed_sha = hashlib.sha256(signed_bytes).hexdigest()
        signed_size = len(signed_bytes)
        signature_png_sha = hashlib.sha256(signature_png_bytes).hexdigest()

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
            "contract_id": contract_id,
            "contract_reference": ref,
            "issued_pdf_sha256": live_sha,
            "acceptance_wording": ACCEPTANCE_WORDING,
            "accepted_at": accepted_at.isoformat(),
            "ip": ip,
            "user_agent": user_agent,
            "method": "portal.electronic",
            "signed_pdf_sha256": signed_sha,
            # Drawn signature bundle — the transparent PNG that got
            # baked into the signed PDF, plus SHAs and anchor metadata
            # so the DB record and PDF are provably from the same
            # signing event.
            "signature_png_b64": base64.b64encode(signature_png_bytes).decode("ascii"),
            "signature_png_sha256": signature_png_sha,
            "signature_anchors": anchors,
            "signer_identity": {
                "user_id": user.get("id"),
                "email": franchisee_email,
                "full_name": franchisee_full_name,
                "organisation": stamp_organisation,
            },
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
