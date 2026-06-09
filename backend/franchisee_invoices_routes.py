"""Phase 5 — Per-franchisee Invoicing module (portal-side).

Cloned from ``invoices_routes`` (the merged Sandra's-Invoices code) and
scoped by ``franchisee_id`` so each franchisee sees ONLY their own data:

- Collections (separate from admin invoices to keep Sandra's data
  fully isolated):
    franchisee_invoice_clients         (one per franchisee_id)
    franchisee_invoices                (one per franchisee_id)
    franchisee_invoice_settings        (one per franchisee_id, _id=franchisee_id)
    franchisee_bank_transactions       (CSV uploads — Phase 2)

- All routes mounted at /api/portal/invoices/* and require role
  "franchisee". ``user["franchisee_id"]`` is injected by the JWT so we
  never trust client-supplied scoping.

- Default invoice settings auto-populate from the franchisee's own
  profile (organisation, address, email, phone) — NOT Sandra's. Bank
  fields are blank by default so each franchisee fills in their own.

- "Sandra's Invoices" admin module is untouched. The portal module is
  a parallel-but-isolated copy.

Phase 1 (this file): clients CRUD, invoices CRUD, settings, PDF download.
Phase 2 (later): /reconcile endpoints — CSV upload + match + link.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from io import BytesIO
from typing import List, Optional

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict, Field

from franchisee_bank_csv import parse_bank_csv
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import (
    Image as RLImage,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)
from pathlib import Path as _Path
import re

# Brand logo embedded at the top-left of every generated invoice.
_LOGO_PATH = _Path(__file__).resolve().parent / "assets" / "cm-invoice-logo.png"


# Filename helper — keeps the PDF metadata title and the Save-As default
# (and Content-Disposition) all aligned. Chrome's PDF viewer pulls its
# default filename from the PDF's /Title metadata when the file is
# opened inline (e.g. via a blob: URL the frontend uses).
def _invoice_filename(invoice: dict) -> str:
    raw_client = (invoice.get("client_name") or "").strip()
    safe_client = re.sub(r"[\\/:*?\"<>|]+", "", raw_client)
    safe_client = re.sub(r"\s+", "-", safe_client)[:60] or "client"
    date_bit = ""
    iso = invoice.get("issue_date") or invoice.get("created_at") or ""
    try:
        d = datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
        date_bit = d.strftime("%d.%m.%y")
    except (ValueError, TypeError):
        date_bit = ""
    number_bit = (invoice.get("invoice_number") or "draft").strip()
    parts = [safe_client]
    if date_bit:
        parts.append(date_bit)
    parts.append(number_bit)
    return "_".join(parts)


# Signed URL helpers for the inline-view flow. Safari's PDF viewer
# ignores PDF /Title metadata when the file is opened from a blob URL —
# the "Save As…" dialog defaults to the blob's auto-UUID, which is why
# franchisees kept seeing UUID filenames. The fix is to serve the PDF
# from a real signed URL (no blob) so the browser can use the URL's
# last path segment + the Content-Disposition header.
#
# The token covers ``{invoice_id}:{exp}``, signed with the existing
# JWT secret. Short TTL (10 minutes) because tokens are minted on every
# click and the link is single-use in practice.
import hmac as _hmac
import hashlib as _hashlib
import time as _time


def _sign_pdf_link(invoice_id: str, ttl_seconds: int = 600) -> tuple[str, int]:
    # Local import avoids a circular import at module load; server.py
    # imports the invoice router, and we import the secret back.
    from server import JWT_SECRET as _secret
    exp = int(_time.time()) + ttl_seconds
    payload = f"{invoice_id}:{exp}".encode("utf-8")
    sig = _hmac.new(_secret.encode("utf-8"), payload, _hashlib.sha256).hexdigest()[:32]
    return sig, exp


def _verify_pdf_link(invoice_id: str, exp: int, sig: str) -> bool:
    from server import JWT_SECRET as _secret
    if exp < int(_time.time()):
        return False
    payload = f"{invoice_id}:{exp}".encode("utf-8")
    expected = _hmac.new(_secret.encode("utf-8"), payload, _hashlib.sha256).hexdigest()[:32]
    return _hmac.compare_digest(expected, sig)


# =========================== MODELS ===========================

class LineItem(BaseModel):
    description: str
    quantity: float = 1
    unit_price: float
    amount: float = 0
    # Optional date the class / event happened.
    class_date: Optional[str] = None


class ClientBase(BaseModel):
    name: str
    email: Optional[str] = ""
    email2: Optional[str] = ""
    phone: Optional[str] = ""
    address: Optional[str] = ""
    address_line2: Optional[str] = ""
    city: Optional[str] = ""
    county: Optional[str] = ""
    postcode: Optional[str] = ""
    country: Optional[str] = ""
    show_name: bool = True
    show_email: bool = True
    show_email2: bool = True
    show_phone: bool = False
    show_address: bool = True
    show_city: bool = True
    show_country: bool = True


class ClientCreate(ClientBase):
    pass


class Client(ClientBase):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    created_at: str = Field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )


class InvoiceBase(BaseModel):
    client_id: str
    client_name: str
    client_email: Optional[str] = ""
    client_email2: Optional[str] = ""
    client_phone: Optional[str] = ""
    client_address: Optional[str] = ""
    invoice_number: str
    issue_date: str
    due_date: str
    line_items: List[LineItem]
    tax_rate: float = 0
    discount_rate: float = 0
    subtotal: float = 0
    tax_amount: float = 0
    discount_amount: float = 0
    total: float = 0
    notes: Optional[str] = ""
    payment_terms: str = "Net 14 Days"
    status: str = "draft"


class InvoiceCreate(InvoiceBase):
    pass


class Invoice(InvoiceBase):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    created_at: str = Field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )
    deleted: bool = False
    deleted_at: Optional[str] = None
    paid_at: Optional[str] = None
    payment_link_id: Optional[str] = None
    payment_transaction_ids: List[str] = Field(default_factory=list)


class InvoiceSettings(BaseModel):
    """Per-franchisee settings — auto-derived from the franchisee profile
    the first time the settings page is opened. Bank fields are blank by
    default; each franchisee fills their own."""
    id: str = ""  # set to franchisee_id by the router
    franchise_name: str = ""  # e.g. "Creative Mojo North & West Devon" — shown large at top of every invoice
    business_name: str = ""
    business_address: str = ""
    business_address_line1: str = ""
    business_address_line2: str = ""
    business_city: str = ""
    business_county: str = ""
    business_postcode: str = ""
    business_phone: str = ""
    business_email: str = ""
    bank_payment_info: str = "Payments by BACS/Online should be made to:"
    bank_account_name: str = ""
    bank_details: str = ""  # e.g. "Sort Code: 00-00-00 Account No. 00000000"


class InvoiceSettingsUpdate(BaseModel):
    franchise_name: Optional[str] = None
    business_name: Optional[str] = None
    business_address: Optional[str] = None
    business_address_line1: Optional[str] = None
    business_address_line2: Optional[str] = None
    business_city: Optional[str] = None
    business_county: Optional[str] = None
    business_postcode: Optional[str] = None
    business_phone: Optional[str] = None
    business_email: Optional[str] = None
    bank_payment_info: Optional[str] = None
    bank_account_name: Optional[str] = None
    bank_details: Optional[str] = None


# =========================== HELPERS ===========================

def _default_settings_from_franchisee(franchisee: dict) -> dict:
    """Build a fresh InvoiceSettings for a franchisee whose settings doc
    doesn't yet exist. We pull whatever address/contact data is on their
    franchisees record so they can start invoicing in 30 seconds; they
    refine via the Settings page after.

    Bank details are deliberately blank — each franchisee owns those and
    we never want to inherit Sandra's (or anyone else's) account number.
    """
    addr_parts = [
        franchisee.get("address") or franchisee.get("address_street"),
        franchisee.get("address_line2"),
        franchisee.get("city") or franchisee.get("town"),
        franchisee.get("county"),
        franchisee.get("postcode"),
    ]
    addr_full = ", ".join([p for p in addr_parts if p])
    line1 = franchisee.get("address") or franchisee.get("address_street") or ""
    line2 = franchisee.get("address_line2") or ""
    biz_name = (
        franchisee.get("full_name")
        or f"{franchisee.get('first_name') or ''} {franchisee.get('last_name') or ''}".strip()
        or franchisee.get("organisation")
        or ""
    )
    return {
        "id": franchisee["id"],
        "franchise_name": franchisee.get("organisation") or biz_name,
        "business_name": biz_name,
        "business_address": addr_full,
        "business_address_line1": line1,
        "business_address_line2": line2,
        "business_city": franchisee.get("city") or franchisee.get("town") or "",
        "business_county": franchisee.get("county") or "",
        "business_postcode": franchisee.get("postcode") or "",
        "business_phone": franchisee.get("phone") or franchisee.get("mobile") or "",
        "business_email": franchisee.get("primary_email") or franchisee.get("email") or franchisee.get("contact_email") or "",
        "bank_payment_info": "Payments by BACS/Online should be made to:",
        "bank_account_name": "",
        "bank_details": "",
    }


class LinkPaymentBody(BaseModel):
    transaction_id: str


# =========================== ROUTER ===========================

def build_franchisee_invoices_router(db, require_role):
    """Mount under prefix `/portal/invoices`. All endpoints scoped by
    the franchisee_id baked into the JWT — clients can NEVER pass their
    own franchisee_id."""
    router = APIRouter(prefix="/portal/invoices", tags=["portal-invoices"])
    franchisee = Depends(require_role("franchisee"))

    async def _fid(user: dict) -> str:
        fid = user.get("franchisee_id")
        if not fid:
            raise HTTPException(400, detail="Franchisee link missing")
        # Belt-and-braces: confirm the invoicing module is enabled for
        # this franchisee. Admin can flip this off any time.
        f = await db.franchisees.find_one({"id": fid}, {"_id": 0, "portal_modules": 1})
        if not f:
            raise HTTPException(404, detail="Franchisee not found")
        modules = f.get("portal_modules") or {}
        if modules.get("invoicing") is False:
            raise HTTPException(403, detail="Invoicing module is disabled for your portal")
        return fid

    # ----------------------------- CLIENTS
    #
    # Per Paul (Jun 2026): the invoicing client list MUST be the same
    # list as My Territory+. Previously this endpoint returned a
    # separate ``franchisee_invoice_clients`` collection that you had
    # to populate manually — duplicate data entry.
    #
    # We now project every Territory+ client into the legacy ``Client``
    # shape so the existing front-end keeps rendering without any UI
    # changes. The bookkeeping fields (``franchisee_invoice_clients``)
    # is left in place as a fallback for any franchisee who hasn't
    # opted into Territory+ yet — we union the two lists, de-duped by
    # name+postcode.
    @router.get("/clients", response_model=List[Client])
    async def list_clients(user: dict = franchisee):
        fid = await _fid(user)
        seen: set[tuple[str, str]] = set()
        out: list[dict] = []

        # 1) Pull every Territory+ client this franchisee owns and
        # adapt its shape to the legacy Client model. Each row carries
        # ``id``, ``name``, ``email``, ``phone``, ``address``, etc.
        async for c in db.franchisee_clients.find(
            {"franchisee_id": fid}, {"_id": 0},
        ).sort([("name", 1)]):
            # Pick a primary contact email if there isn't one on the
            # client doc — Territory+ stores per-person contacts in a
            # nested array.
            primary_email = c.get("email")
            primary_phone = c.get("phone")
            if not primary_email or not primary_phone:
                for ct in c.get("contacts") or []:
                    primary_email = primary_email or ct.get("email")
                    primary_phone = primary_phone or ct.get("phone")
                    if primary_email and primary_phone:
                        break
            key = ((c.get("name") or "").strip().lower(),
                   (c.get("postcode") or "").strip().lower())
            if key in seen:
                continue
            seen.add(key)
            out.append({
                "id": c.get("id"),
                "name": c.get("name") or "—",
                "email": primary_email,
                "phone": primary_phone,
                "address": c.get("address"),
                "notes": c.get("notes"),
            })

        # 2) Anything still in the legacy collection that isn't already
        # represented in Territory+ — falls through here.
        async for c in db.franchisee_invoice_clients.find(
            {"franchisee_id": fid}, {"_id": 0, "franchisee_id": 0},
        ):
            key = ((c.get("name") or "").strip().lower(),
                   (c.get("postcode") or "").strip().lower() if c.get("postcode") else "")
            if key in seen:
                continue
            seen.add(key)
            out.append(c)

        return out

    @router.get("/clients/{client_id}", response_model=Client)
    async def get_client(client_id: str, user: dict = franchisee):
        fid = await _fid(user)
        c = await db.franchisee_invoice_clients.find_one(
            {"id": client_id, "franchisee_id": fid}, {"_id": 0, "franchisee_id": 0},
        )
        if not c:
            raise HTTPException(404, "Client not found")
        return c

    @router.post("/clients", response_model=Client)
    async def create_client(body: ClientCreate, user: dict = franchisee):
        fid = await _fid(user)
        c = Client(**body.model_dump())
        doc = c.model_dump()
        doc["franchisee_id"] = fid
        await db.franchisee_invoice_clients.insert_one(doc)
        doc.pop("franchisee_id", None)
        doc.pop("_id", None)
        return doc

    @router.put("/clients/{client_id}", response_model=Client)
    async def update_client(client_id: str, body: ClientCreate, user: dict = franchisee):
        fid = await _fid(user)
        existing = await db.franchisee_invoice_clients.find_one(
            {"id": client_id, "franchisee_id": fid}, {"_id": 0},
        )
        if not existing:
            raise HTTPException(404, "Client not found")
        await db.franchisee_invoice_clients.update_one(
            {"id": client_id, "franchisee_id": fid}, {"$set": body.model_dump()},
        )
        out = await db.franchisee_invoice_clients.find_one(
            {"id": client_id, "franchisee_id": fid}, {"_id": 0, "franchisee_id": 0},
        )
        return out

    @router.delete("/clients/{client_id}")
    async def delete_client(client_id: str, user: dict = franchisee):
        fid = await _fid(user)
        res = await db.franchisee_invoice_clients.delete_one(
            {"id": client_id, "franchisee_id": fid},
        )
        if res.deleted_count == 0:
            raise HTTPException(404, "Client not found")
        return {"message": "Client deleted"}

    # ----------------------------- INVOICES
    # IMPORTANT — literal sub-paths declared before /{invoice_id} so the
    # FastAPI matcher doesn't treat "next-number", "stats" etc. as ids.

    @router.get("", response_model=List[Invoice])
    async def list_invoices(
        status: Optional[str] = None,
        include_deleted: bool = False,
        user: dict = franchisee,
    ):
        fid = await _fid(user)
        q: dict = {"franchisee_id": fid}
        if status:
            q["status"] = status
        if not include_deleted:
            q["deleted"] = {"$ne": True}
        return await db.franchisee_invoices.find(
            q, {"_id": 0, "franchisee_id": 0},
        ).sort("created_at", -1).to_list(2000)

    @router.get("/deleted/list", response_model=List[Invoice])
    async def list_deleted(user: dict = franchisee):
        fid = await _fid(user)
        return await db.franchisee_invoices.find(
            {"franchisee_id": fid, "deleted": True}, {"_id": 0, "franchisee_id": 0},
        ).sort("deleted_at", -1).to_list(500)

    @router.get("/stats")
    async def stats(user: dict = franchisee):
        fid = await _fid(user)
        base = {"franchisee_id": fid, "deleted": {"$ne": True}}
        total_invoices = await db.franchisee_invoices.count_documents(base)
        draft = await db.franchisee_invoices.count_documents({**base, "status": "draft"})
        sent = await db.franchisee_invoices.count_documents({**base, "status": "sent"})
        partial = await db.franchisee_invoices.count_documents({**base, "status": "partial"})
        paid = await db.franchisee_invoices.count_documents({**base, "status": "paid"})
        totals = await db.franchisee_invoices.aggregate(
            [{"$match": base}, {"$group": {"_id": "$status", "total": {"$sum": "$total"}}}]
        ).to_list(10)
        total_revenue = sum(t["total"] for t in totals if t["_id"] == "paid")
        outstanding = sum(t["total"] for t in totals if t["_id"] in ("draft", "sent", "partial"))
        return {
            "total_invoices": total_invoices,
            "draft_count": draft,
            "sent_count": sent,
            "partial_count": partial,
            "paid_count": paid,
            "total_revenue": total_revenue,
            "outstanding": outstanding,
        }

    @router.get("/next-number")
    async def next_number(user: dict = franchisee):
        """Each franchisee gets their own invoice number sequence (INV-XXXX)."""
        fid = await _fid(user)
        latest = await db.franchisee_invoices.find_one(
            {"franchisee_id": fid}, {"_id": 0, "invoice_number": 1},
            sort=[("created_at", -1)],
        )
        last_num = 0
        if latest and latest.get("invoice_number"):
            try:
                last_num = int(str(latest["invoice_number"]).split("-")[-1])
            except (ValueError, IndexError):
                last_num = 0
        return {"invoice_number": f"INV-{(last_num + 1):04d}"}

    @router.get("/{invoice_id}", response_model=Invoice)
    async def get_invoice(invoice_id: str, user: dict = franchisee):
        fid = await _fid(user)
        inv = await db.franchisee_invoices.find_one(
            {"id": invoice_id, "franchisee_id": fid}, {"_id": 0, "franchisee_id": 0},
        )
        if not inv:
            raise HTTPException(404, "Invoice not found")
        return inv

    @router.post("", response_model=Invoice)
    async def create_invoice(body: InvoiceCreate, user: dict = franchisee):
        fid = await _fid(user)
        inv = Invoice(**body.model_dump())
        doc = inv.model_dump()
        doc["franchisee_id"] = fid
        await db.franchisee_invoices.insert_one(doc)
        doc.pop("franchisee_id", None)
        doc.pop("_id", None)
        return doc

    @router.put("/{invoice_id}", response_model=Invoice)
    async def update_invoice(invoice_id: str, body: InvoiceCreate, user: dict = franchisee):
        fid = await _fid(user)
        existing = await db.franchisee_invoices.find_one(
            {"id": invoice_id, "franchisee_id": fid}, {"_id": 0},
        )
        if not existing:
            raise HTTPException(404, "Invoice not found")
        await db.franchisee_invoices.update_one(
            {"id": invoice_id, "franchisee_id": fid}, {"$set": body.model_dump()},
        )
        return await db.franchisee_invoices.find_one(
            {"id": invoice_id, "franchisee_id": fid}, {"_id": 0, "franchisee_id": 0},
        )

    @router.delete("/{invoice_id}")
    async def soft_delete(invoice_id: str, user: dict = franchisee):
        fid = await _fid(user)
        res = await db.franchisee_invoices.update_one(
            {"id": invoice_id, "franchisee_id": fid, "deleted": {"$ne": True}},
            {"$set": {"deleted": True, "deleted_at": datetime.now(timezone.utc).isoformat()}},
        )
        if res.matched_count == 0:
            raise HTTPException(404, "Invoice not found")
        return {"message": "Invoice moved to bin"}

    @router.post("/{invoice_id}/restore", response_model=Invoice)
    async def restore(invoice_id: str, user: dict = franchisee):
        fid = await _fid(user)
        res = await db.franchisee_invoices.update_one(
            {"id": invoice_id, "franchisee_id": fid, "deleted": True},
            {"$set": {"deleted": False}, "$unset": {"deleted_at": ""}},
        )
        if res.matched_count == 0:
            raise HTTPException(404, "Invoice not found")
        return await db.franchisee_invoices.find_one(
            {"id": invoice_id, "franchisee_id": fid}, {"_id": 0, "franchisee_id": 0},
        )

    @router.patch("/{invoice_id}/status", response_model=Invoice)
    async def update_status(invoice_id: str, body: dict, user: dict = franchisee):
        fid = await _fid(user)
        status = (body or {}).get("status")
        if status not in ("draft", "sent", "paid", "overdue"):
            raise HTTPException(400, "Invalid status")
        update = {"status": status}
        if status == "paid":
            update["paid_at"] = datetime.now(timezone.utc).isoformat()
        res = await db.franchisee_invoices.update_one(
            {"id": invoice_id, "franchisee_id": fid}, {"$set": update},
        )
        if res.matched_count == 0:
            raise HTTPException(404, "Invoice not found")
        return await db.franchisee_invoices.find_one(
            {"id": invoice_id, "franchisee_id": fid}, {"_id": 0, "franchisee_id": 0},
        )

    # ----------------------------- SETTINGS
    @router.get("/settings/me", response_model=InvoiceSettings)
    async def get_settings(user: dict = franchisee):
        fid = await _fid(user)
        s = await db.franchisee_invoice_settings.find_one({"_id": fid})
        if not s:
            # Lazy-create from the franchisee profile so the user sees
            # their own brand the moment they open the page.
            f = await db.franchisees.find_one({"id": fid}, {"_id": 0})
            if not f:
                raise HTTPException(404, "Franchisee profile not found")
            seed = _default_settings_from_franchisee(f)
            await db.franchisee_invoice_settings.insert_one({**seed, "_id": fid})
            return seed
        # Lazy-backfill any newly-added fields (franchise_name, business_city,
        # county, postcode) from the franchisee profile so older settings
        # docs created before this iteration also render correctly.
        backfill = {}
        for key in ("franchise_name", "business_city", "business_county", "business_postcode"):
            if key not in s or s.get(key) in (None, ""):
                backfill[key] = ""
        if backfill:
            f = await db.franchisees.find_one({"id": fid}, {"_id": 0})
            if f:
                seed = _default_settings_from_franchisee(f)
                for key in list(backfill.keys()):
                    backfill[key] = seed.get(key, "") or ""
                await db.franchisee_invoice_settings.update_one(
                    {"_id": fid}, {"$set": backfill},
                )
                s.update(backfill)
        s.pop("_id", None)
        s["id"] = fid
        return s

    @router.put("/settings/me", response_model=InvoiceSettings)
    async def update_settings(body: InvoiceSettingsUpdate, user: dict = franchisee):
        fid = await _fid(user)
        update = {k: v for k, v in body.model_dump(exclude_none=True).items()}
        if not update:
            raise HTTPException(400, "No fields to update")
        await db.franchisee_invoice_settings.update_one(
            {"_id": fid}, {"$set": update}, upsert=True,
        )
        out = await db.franchisee_invoice_settings.find_one({"_id": fid})
        if out:
            out.pop("_id", None)
            out["id"] = fid
            return out
        return None

    # ----------------------------- PDF
    @router.get("/{invoice_id}/pdf")
    async def invoice_pdf(invoice_id: str, download: bool = False, user: dict = franchisee):
        fid = await _fid(user)
        inv = await db.franchisee_invoices.find_one(
            {"id": invoice_id, "franchisee_id": fid}, {"_id": 0, "franchisee_id": 0},
        )
        if not inv:
            raise HTTPException(404, "Invoice not found")
        settings = await db.franchisee_invoice_settings.find_one({"_id": fid})
        if not settings:
            # Auto-seed if the franchisee jumped straight to PDF without
            # visiting Settings first — avoids a confusing "no business
            # name" PDF.
            f = await db.franchisees.find_one({"id": fid}, {"_id": 0})
            settings = _default_settings_from_franchisee(f) if f else {}
        pdf_bytes = _render_invoice_pdf(inv, settings)
        filename = f"{_invoice_filename(inv)}.pdf"
        disposition = (
            f'attachment; filename="{filename}"'
            if download
            else f'inline; filename="{filename}"'
        )
        return Response(
            content=pdf_bytes,
            media_type="application/pdf",
            headers={"Content-Disposition": disposition},
        )

    # Signed URL for the inline-view flow. Returns a short-lived URL
    # whose last path segment is the friendly filename — that's what
    # Safari uses as the "Save As…" default when the user views the
    # PDF in a new tab. We can't just `window.open()` the regular
    # /pdf endpoint because the browser can't carry the Bearer header
    # through a new tab; signing the URL lets us auth without one.
    @router.get("/{invoice_id}/pdf-url")
    async def invoice_pdf_url(invoice_id: str, user: dict = franchisee):
        fid = await _fid(user)
        inv = await db.franchisee_invoices.find_one(
            {"id": invoice_id, "franchisee_id": fid},
            {"_id": 0, "invoice_number": 1, "client_name": 1,
             "issue_date": 1, "created_at": 1, "id": 1},
        )
        if not inv:
            raise HTTPException(404, "Invoice not found")
        sig, exp = _sign_pdf_link(invoice_id)
        filename = f"{_invoice_filename(inv)}.pdf"
        # Path-segment filename so the browser uses it as Save-As
        # fallback even if Content-Disposition is stripped by a proxy.
        url = (
            f"/api/portal/invoices/pdf-share/{filename}"
            f"?inv={invoice_id}&exp={exp}&sig={sig}"
        )
        return {"url": url, "filename": filename, "expires_at": exp}

    # Public-ish endpoint — auth is by HMAC signature, not Bearer
    # token. Verifies the signature, fetches the invoice, returns the
    # PDF with the friendly filename in Content-Disposition.
    @router.get("/pdf-share/{filename:path}")
    async def invoice_pdf_share(
        filename: str,
        inv: str,
        exp: int,
        sig: str,
        download: bool = False,
    ):
        if not _verify_pdf_link(inv, exp, sig):
            raise HTTPException(403, "Invalid or expired link")
        invoice = await db.franchisee_invoices.find_one(
            {"id": inv}, {"_id": 0, "franchisee_id": 0},
        )
        if not invoice:
            raise HTTPException(404, "Invoice not found")
        fid = (await db.franchisee_invoices.find_one(
            {"id": inv}, {"_id": 0, "franchisee_id": 1}
        ) or {}).get("franchisee_id")
        settings = await db.franchisee_invoice_settings.find_one({"_id": fid}) if fid else None
        if not settings and fid:
            f = await db.franchisees.find_one({"id": fid}, {"_id": 0})
            settings = _default_settings_from_franchisee(f) if f else {}
        pdf_bytes = _render_invoice_pdf(invoice, settings or {})
        # Strip any path components from the filename to avoid an
        # attacker crafting a Content-Disposition with embedded
        # newlines (`filename:path` would let `..` through otherwise).
        safe_filename = filename.replace("\r", "").replace("\n", "").split("/")[-1]
        disposition = (
            f'attachment; filename="{safe_filename}"'
            if download
            else f'inline; filename="{safe_filename}"'
        )
        return Response(
            content=pdf_bytes,
            media_type="application/pdf",
            headers={"Content-Disposition": disposition},
        )

    # ----------------------------- INVOICE → PAYMENT linking
    # Mirrors the admin Invoices module's `/payment-candidates` and
    # `/link-payment` endpoints. Surfaces incoming bank CREDITS from
    # `franchisee_bank_transactions` (filtered by this franchisee's
    # franchisee_id) so the franchisee can match a deposit to one of
    # their own invoices and have the invoice flip to paid / partial.

    def _recalc_invoice_state(inv: dict) -> dict:
        total = round(float(inv.get("total") or 0), 2)
        links = inv.get("linked_transactions") or []
        paid_total = round(sum(float(x.get("amount") or 0) for x in links), 2)
        if paid_total + 0.005 >= total > 0:
            status, paid_at = "paid", (inv.get("paid_at") or datetime.now(timezone.utc).isoformat())
        elif paid_total > 0:
            status, paid_at = "partial", None
        else:
            status, paid_at = inv.get("status") or "draft", None
            # Don't flip a "sent" invoice back to draft on unlink.
            if status not in {"draft", "sent", "partial", "paid", "deleted"}:
                status = "sent"
            if status == "partial":
                status = "sent"  # zero links → no longer partial
        return {"status": status, "paid_total": paid_total, "paid_at": paid_at}

    @router.get("/{invoice_id}/payment-candidates")
    async def payment_candidates(invoice_id: str, user: dict = franchisee):
        fid = await _fid(user)
        invoice = await db.franchisee_invoices.find_one(
            {"id": invoice_id, "franchisee_id": fid, "deleted": {"$ne": True}}, {"_id": 0},
        )
        if not invoice:
            raise HTTPException(404, "Invoice not found")
        total = round(float(invoice.get("total") or 0), 2)
        state = _recalc_invoice_state(invoice)
        remaining = round(total - state["paid_total"], 2)
        target = remaining if state["paid_total"] > 0 else total
        already = {x.get("transaction_id") for x in (invoice.get("linked_transactions") or [])}
        creds = await db.franchisee_bank_transactions.find(
            {"franchisee_id": fid, "transaction_type": "CREDIT"},
            {"_id": 0, "id": 1, "amount": 1, "description": 1, "date": 1,
             "linked_invoice_ids": 1},
        ).to_list(5000)
        # Normalise shape to match the admin candidate response
        out = []
        for t in creds:
            tid = t.get("id")
            if tid in already:
                continue
            linked_to = t.get("linked_invoice_ids") or []
            out.append({
                "transaction_id": tid,
                "amount": t.get("amount"),
                "description": t.get("description"),
                "timestamp": t.get("date"),
                "currency": "GBP",
                "linked_invoice_id": linked_to[0] if linked_to else None,
                "linked_invoice_number": None,
            })
        def _score(t):
            if abs(float(t["amount"] or 0) - target) < 0.005:
                return 0
            if abs(float(t["amount"] or 0) - target) < 1.0:
                return 1
            return 2
        out.sort(key=lambda t: t.get("timestamp") or "", reverse=True)
        out.sort(key=_score)
        return {
            "candidates": out[:50],
            "invoice_total": total,
            "paid_total": state["paid_total"],
            "remaining": remaining,
            "target_amount": target,
        }

    @router.post("/{invoice_id}/link-payment")
    async def link_payment(invoice_id: str, body: LinkPaymentBody, user: dict = franchisee):
        fid = await _fid(user)
        invoice = await db.franchisee_invoices.find_one(
            {"id": invoice_id, "franchisee_id": fid, "deleted": {"$ne": True}}, {"_id": 0},
        )
        if not invoice:
            raise HTTPException(404, "Invoice not found")
        tx = await db.franchisee_bank_transactions.find_one(
            {"id": body.transaction_id, "franchisee_id": fid}, {"_id": 0},
        )
        if not tx:
            raise HTTPException(404, "Transaction not found")
        existing = invoice.get("linked_transactions") or []
        if any(x.get("transaction_id") == body.transaction_id for x in existing):
            raise HTTPException(400, "Transaction already linked to this invoice")
        now = datetime.now(timezone.utc).isoformat()
        link_entry = {
            "transaction_id": body.transaction_id,
            "amount": tx.get("amount"),
            "timestamp": tx.get("date"),
            "description": tx.get("description"),
            "linked_at": now,
        }
        new_links = existing + [link_entry]
        merged = {**invoice, "linked_transactions": new_links}
        state = _recalc_invoice_state(merged)
        update = {
            "linked_transactions": new_links,
            "status": state["status"],
            "updated_at": now,
        }
        if state["status"] == "paid":
            update["paid_at"] = state["paid_at"] or now
        await db.franchisee_invoices.update_one(
            {"id": invoice_id, "franchisee_id": fid},
            {"$set": update, "$addToSet": {"payment_transaction_ids": body.transaction_id}},
        )
        await db.franchisee_bank_transactions.update_one(
            {"id": body.transaction_id, "franchisee_id": fid},
            {"$addToSet": {"linked_invoice_ids": invoice_id}},
        )
        return await db.franchisee_invoices.find_one(
            {"id": invoice_id, "franchisee_id": fid}, {"_id": 0},
        )

    @router.delete("/{invoice_id}/link-payment/{transaction_id}")
    async def unlink_single_payment(invoice_id: str, transaction_id: str, user: dict = franchisee):
        fid = await _fid(user)
        invoice = await db.franchisee_invoices.find_one(
            {"id": invoice_id, "franchisee_id": fid}, {"_id": 0},
        )
        if not invoice:
            raise HTTPException(404, "Invoice not found")
        existing = invoice.get("linked_transactions") or []
        new_links = [x for x in existing if x.get("transaction_id") != transaction_id]
        if len(new_links) == len(existing):
            raise HTTPException(404, "Transaction not linked to this invoice")
        merged = {**invoice, "linked_transactions": new_links}
        state = _recalc_invoice_state(merged)
        now = datetime.now(timezone.utc).isoformat()
        update = {
            "linked_transactions": new_links,
            "status": state["status"],
            "updated_at": now,
        }
        if state["status"] != "paid":
            await db.franchisee_invoices.update_one(
                {"id": invoice_id, "franchisee_id": fid},
                {"$set": update, "$unset": {"paid_at": ""},
                 "$pull": {"payment_transaction_ids": transaction_id}},
            )
        else:
            await db.franchisee_invoices.update_one(
                {"id": invoice_id, "franchisee_id": fid},
                {"$set": update, "$pull": {"payment_transaction_ids": transaction_id}},
            )
        await db.franchisee_bank_transactions.update_one(
            {"id": transaction_id, "franchisee_id": fid},
            {"$pull": {"linked_invoice_ids": invoice_id}},
        )
        return await db.franchisee_invoices.find_one(
            {"id": invoice_id, "franchisee_id": fid}, {"_id": 0},
        )

    @router.delete("/{invoice_id}/link-payment")
    async def unlink_all_payments(invoice_id: str, user: dict = franchisee):
        fid = await _fid(user)
        invoice = await db.franchisee_invoices.find_one(
            {"id": invoice_id, "franchisee_id": fid}, {"_id": 0},
        )
        if not invoice:
            raise HTTPException(404, "Invoice not found")
        tx_ids = [x.get("transaction_id") for x in (invoice.get("linked_transactions") or [])]
        now = datetime.now(timezone.utc).isoformat()
        await db.franchisee_invoices.update_one(
            {"id": invoice_id, "franchisee_id": fid},
            {"$set": {"linked_transactions": [], "status": "sent",
                      "updated_at": now, "payment_transaction_ids": []},
             "$unset": {"paid_at": ""}},
        )
        if tx_ids:
            await db.franchisee_bank_transactions.update_many(
                {"id": {"$in": tx_ids}, "franchisee_id": fid},
                {"$pull": {"linked_invoice_ids": invoice_id}},
            )
        return await db.franchisee_invoices.find_one(
            {"id": invoice_id, "franchisee_id": fid}, {"_id": 0},
        )

    # ----------------------------- BANK RECONCILIATION (Phase 2 — manual CSV)
    # Per franchisee: upload a CSV from their own bank, then match each
    # CREDIT line against an outstanding invoice. No TrueLayer / API
    # integration — strictly manual to keep things simple and free.

    @router.post("/bank/upload")
    async def upload_bank_csv(file: UploadFile = File(...), user: dict = franchisee):
        fid = await _fid(user)
        blob = await file.read()
        if not blob:
            raise HTTPException(400, "Empty file")
        if len(blob) > 5 * 1024 * 1024:
            raise HTTPException(400, "CSV too large (max 5 MB)")
        try:
            parsed = parse_bank_csv(blob)
        except Exception as e:  # noqa: BLE001
            raise HTTPException(400, f"Couldn't parse CSV: {e}") from e
        if not parsed:
            raise HTTPException(400, "No transactions detected — please check the CSV format.")
        now = datetime.now(timezone.utc).isoformat()
        inserted = 0
        skipped = 0
        for tx in parsed:
            doc = {
                "id": str(uuid.uuid4()),
                "franchisee_id": fid,
                "date": tx["date"],
                "description": tx["description"],
                "amount": tx["amount"],
                "transaction_type": tx["transaction_type"],
                "fingerprint": tx["fingerprint"],
                "source_filename": file.filename or "upload.csv",
                "imported_at": now,
                "linked_invoice_ids": [],
            }
            try:
                res = await db.franchisee_bank_transactions.update_one(
                    {"franchisee_id": fid, "fingerprint": tx["fingerprint"]},
                    {"$setOnInsert": doc},
                    upsert=True,
                )
                if res.upserted_id is not None:
                    inserted += 1
                else:
                    skipped += 1
            except Exception:  # noqa: BLE001
                skipped += 1
        return {
            "filename": file.filename,
            "total_rows_parsed": len(parsed),
            "inserted": inserted,
            "skipped_duplicates": skipped,
        }

    @router.get("/bank/transactions")
    async def list_bank_transactions(
        only_credits: bool = True,
        only_unreconciled: bool = False,
        user: dict = franchisee,
    ):
        fid = await _fid(user)
        q: dict = {"franchisee_id": fid}
        if only_credits:
            q["transaction_type"] = "CREDIT"
        if only_unreconciled:
            q["linked_invoice_ids"] = {"$in": [None, []]}
        rows = await db.franchisee_bank_transactions.find(
            q, {"_id": 0, "franchisee_id": 0, "raw": 0}
        ).sort("date", -1).to_list(2000)

        # Build a fast lookup of outstanding invoices for suggestion logic.
        outstanding = await db.franchisee_invoices.find(
            {
                "franchisee_id": fid,
                "deleted": {"$ne": True},
                "status": {"$in": ["sent", "draft", "overdue"]},
            },
            {"_id": 0, "id": 1, "invoice_number": 1, "client_name": 1, "total": 1, "issue_date": 1, "due_date": 1, "status": 1},
        ).to_list(2000)
        for tx in rows:
            tx["suggested_invoice"] = None
            if tx.get("linked_invoice_ids"):
                continue
            # Suggest exact-amount match first
            exact = [
                inv for inv in outstanding
                if round(float(inv.get("total") or 0), 2) == round(float(tx["amount"]), 2)
            ]
            if len(exact) == 1:
                tx["suggested_invoice"] = exact[0]
            elif len(exact) > 1:
                # Pick the one closest to the transaction date
                def _date_dist(inv):
                    try:
                        return abs(
                            (datetime.fromisoformat(inv.get("issue_date") or tx["date"])
                             - datetime.fromisoformat(tx["date"])).days
                        )
                    except (ValueError, TypeError):
                        return 9999
                exact.sort(key=_date_dist)
                tx["suggested_invoice"] = exact[0]
        return rows

    @router.post("/bank/transactions/{txn_id}/link")
    async def link_transaction(txn_id: str, body: dict, user: dict = franchisee):
        fid = await _fid(user)
        invoice_id = (body or {}).get("invoice_id")
        if not invoice_id:
            raise HTTPException(400, "invoice_id required")
        tx = await db.franchisee_bank_transactions.find_one(
            {"id": txn_id, "franchisee_id": fid}, {"_id": 0}
        )
        if not tx:
            raise HTTPException(404, "Transaction not found")
        inv = await db.franchisee_invoices.find_one(
            {"id": invoice_id, "franchisee_id": fid, "deleted": {"$ne": True}}, {"_id": 0}
        )
        if not inv:
            raise HTTPException(404, "Invoice not found")
        # Link tx → invoice
        await db.franchisee_bank_transactions.update_one(
            {"id": txn_id, "franchisee_id": fid},
            {"$addToSet": {"linked_invoice_ids": invoice_id}},
        )
        # Mirror invoice → tx, and auto-flip invoice to "paid" when the
        # sum of linked credit transactions reaches the invoice total.
        await db.franchisee_invoices.update_one(
            {"id": invoice_id, "franchisee_id": fid},
            {"$addToSet": {"payment_transaction_ids": txn_id}},
        )
        # Compute total credited so far for this invoice
        inv2 = await db.franchisee_invoices.find_one(
            {"id": invoice_id, "franchisee_id": fid}, {"_id": 0}
        )
        linked_ids = inv2.get("payment_transaction_ids") or []
        if linked_ids:
            credited = 0.0
            async for t in db.franchisee_bank_transactions.find(
                {"franchisee_id": fid, "id": {"$in": linked_ids}, "transaction_type": "CREDIT"},
                {"_id": 0, "amount": 1},
            ):
                credited += float(t.get("amount") or 0)
            target = float(inv2.get("total") or 0)
            if credited + 0.005 >= target > 0:
                await db.franchisee_invoices.update_one(
                    {"id": invoice_id, "franchisee_id": fid},
                    {"$set": {"status": "paid", "paid_at": datetime.now(timezone.utc).isoformat()}},
                )
            elif credited > 0 and inv2.get("status") == "draft":
                # Partial — mark as sent so it stops looking like a draft
                await db.franchisee_invoices.update_one(
                    {"id": invoice_id, "franchisee_id": fid},
                    {"$set": {"status": "sent"}},
                )
        return {"ok": True}

    @router.delete("/bank/transactions/{txn_id}/link/{invoice_id}")
    async def unlink_transaction(txn_id: str, invoice_id: str, user: dict = franchisee):
        fid = await _fid(user)
        res = await db.franchisee_bank_transactions.update_one(
            {"id": txn_id, "franchisee_id": fid},
            {"$pull": {"linked_invoice_ids": invoice_id}},
        )
        await db.franchisee_invoices.update_one(
            {"id": invoice_id, "franchisee_id": fid},
            {"$pull": {"payment_transaction_ids": txn_id}},
        )
        if res.matched_count == 0:
            raise HTTPException(404, "Transaction not found")
        # If invoice was auto-paid, recompute — drop back to sent if
        # under-credited again.
        inv = await db.franchisee_invoices.find_one(
            {"id": invoice_id, "franchisee_id": fid}, {"_id": 0}
        )
        if inv and inv.get("status") == "paid":
            linked_ids = inv.get("payment_transaction_ids") or []
            credited = 0.0
            if linked_ids:
                async for t in db.franchisee_bank_transactions.find(
                    {"franchisee_id": fid, "id": {"$in": linked_ids}, "transaction_type": "CREDIT"},
                    {"_id": 0, "amount": 1},
                ):
                    credited += float(t.get("amount") or 0)
            if credited + 0.005 < float(inv.get("total") or 0):
                await db.franchisee_invoices.update_one(
                    {"id": invoice_id, "franchisee_id": fid},
                    {"$set": {"status": "sent"}, "$unset": {"paid_at": ""}},
                )
        return {"ok": True}

    @router.delete("/bank/transactions/{txn_id}")
    async def delete_transaction(txn_id: str, user: dict = franchisee):
        fid = await _fid(user)
        # Also pull this tx out of any invoice it was linked to
        tx = await db.franchisee_bank_transactions.find_one(
            {"id": txn_id, "franchisee_id": fid}, {"_id": 0, "linked_invoice_ids": 1}
        )
        if not tx:
            raise HTTPException(404, "Transaction not found")
        for inv_id in tx.get("linked_invoice_ids") or []:
            await db.franchisee_invoices.update_one(
                {"id": inv_id, "franchisee_id": fid},
                {"$pull": {"payment_transaction_ids": txn_id}},
            )
        await db.franchisee_bank_transactions.delete_one(
            {"id": txn_id, "franchisee_id": fid}
        )
        return {"ok": True}

    return router


# =========================== PDF RENDERING ===========================

def _render_invoice_pdf(invoice: dict, settings: dict) -> bytes:
    """Reuses the same visual layout as Sandra's invoices — A4, big
    invoice number top-right, line items table, total row, bank details
    block at the foot. Only the data source differs (per-franchisee
    settings + invoice doc)."""
    buf = BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=A4,
        leftMargin=18 * mm, rightMargin=18 * mm,
        topMargin=18 * mm, bottomMargin=18 * mm,
        # Sets the PDF's /Title metadata — Chrome / Safari / Firefox use
        # this as the default "Save As" filename when the file is opened
        # inline (no Content-Disposition, e.g. via a blob: URL).
        title=_invoice_filename(invoice),
    )
    styles = getSampleStyleSheet()
    h_left = ParagraphStyle("hl", parent=styles["Normal"], fontSize=10, leading=12)
    h_right = ParagraphStyle("hr", parent=styles["Normal"], fontSize=10, leading=12, alignment=2)
    franchise_style = ParagraphStyle(
        "franchise",
        parent=styles["Normal"],
        fontSize=18,
        leading=22,
        fontName="Helvetica-Bold",
        alignment=2,  # right
        textColor=colors.HexColor("#0f172a"),
    )
    # Build the address block for the top-right corner. Each line is its
    # own field so we never get stray commas or double-spaces when a line
    # is blank.
    addr_lines = []
    for k in (
        "business_address_line1",
        "business_address_line2",
    ):
        if settings.get(k):
            addr_lines.append(settings[k])
    city_line_parts = [
        settings.get("business_city"),
        settings.get("business_county"),
        settings.get("business_postcode"),
    ]
    city_line = ", ".join([p for p in city_line_parts if p])
    if city_line:
        addr_lines.append(city_line)
    if settings.get("business_phone"):
        addr_lines.append(settings["business_phone"])
    if settings.get("business_email"):
        addr_lines.append(settings["business_email"])
    business_block = (
        f"<b>{settings.get('business_name') or ''}</b><br/>"
        + "<br/>".join(addr_lines)
    )

    # Build a top header row: logo top-left, franchise-name + invoice
    # info top-right. The logo is sized proportionally — image is 616x241
    # (~2.56:1), so 50mm wide ≈ 19.5mm tall fits comfortably in the
    # header without dominating the page.
    logo_flowable = None
    if _LOGO_PATH.exists():
        try:
            logo_flowable = RLImage(str(_LOGO_PATH), width=50 * mm, height=19.5 * mm)
        except Exception:  # noqa: BLE001
            logo_flowable = None

    franchise_name = settings.get("franchise_name") or settings.get("business_name") or ""
    inv_block = (
        f"<font size=18><b>INVOICE</b></font><br/>"
        f"<b>{invoice.get('invoice_number') or ''}</b><br/>"
        f"Issue: {invoice.get('issue_date') or ''}<br/>"
        f"Due: {invoice.get('due_date') or ''}"
    )
    # Top row — logo left, franchise name on the right (large, bold).
    title_table = Table(
        [[logo_flowable or "", Paragraph(franchise_name, franchise_style)]],
        colWidths=[60 * mm, 110 * mm],
    )
    title_table.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
    ]))

    # Second row — INVOICE label + number on the left, business name +
    # address block on the right.
    header_table = Table(
        [[Paragraph(inv_block, h_left), Paragraph(business_block, h_right)]],
        colWidths=[100 * mm, 70 * mm],
    )
    header_table.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP")]))

    # Client / Bill-To
    bill_lines = []
    if invoice.get("client_name"):
        bill_lines.append(f"<b>{invoice['client_name']}</b>")
    for k in ("client_address", "client_email", "client_email2", "client_phone"):
        if invoice.get(k):
            bill_lines.append(invoice[k])
    bill_block = "<br/>".join(bill_lines) or "&nbsp;"

    # Line items table
    rows = [["Description", "Qty", "Unit", "Amount"]]
    desc_style = ParagraphStyle("desc", parent=styles["Normal"], fontSize=9, leading=11)
    for li in invoice.get("line_items") or []:
        desc = li.get("description") or ""
        if li.get("class_date"):
            try:
                dt = datetime.strptime(li["class_date"][:10], "%Y-%m-%d")
                desc = f"{desc}<br/><font size=8 color='#64748b'>Date of class/event: {dt.strftime('%d %b %Y')}</font>"
            except (ValueError, TypeError):
                pass
        rows.append([
            Paragraph(desc, desc_style),
            f"{float(li.get('quantity') or 0):g}",
            f"£{float(li.get('unit_price') or 0):,.2f}",
            f"£{float(li.get('amount') or 0):,.2f}",
        ])
    items_table = Table(rows, colWidths=[100 * mm, 18 * mm, 26 * mm, 26 * mm], repeatRows=1)
    items_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#f5f5f4")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.HexColor("#1c1917")),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("LINEBELOW", (0, 0), (-1, 0), 0.5, colors.HexColor("#a8a29e")),
        ("LINEBELOW", (0, -1), (-1, -1), 0.5, colors.HexColor("#a8a29e")),
        ("ALIGN", (1, 0), (-1, -1), "RIGHT"),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
    ]))

    totals_data = [
        ["Subtotal", f"£{float(invoice.get('subtotal') or 0):,.2f}"],
    ]
    if float(invoice.get("discount_amount") or 0) != 0:
        totals_data.append([f"Discount ({invoice.get('discount_rate', 0)}%)", f"−£{float(invoice['discount_amount']):,.2f}"])
    if float(invoice.get("tax_amount") or 0) != 0:
        totals_data.append([f"VAT ({invoice.get('tax_rate', 0)}%)", f"£{float(invoice['tax_amount']):,.2f}"])
    totals_data.append(["Total", f"£{float(invoice.get('total') or 0):,.2f}"])
    totals_table = Table(totals_data, colWidths=[40 * mm, 30 * mm], hAlign="RIGHT")
    totals_table.setStyle(TableStyle([
        ("ALIGN", (1, 0), (-1, -1), "RIGHT"),
        ("FONTSIZE", (0, 0), (-1, -1), 10),
        ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
        ("LINEABOVE", (0, -1), (-1, -1), 0.6, colors.HexColor("#1c1917")),
        ("TOPPADDING", (0, -1), (-1, -1), 6),
    ]))

    bank_block = (
        f"<b>{settings.get('bank_payment_info') or ''}</b><br/>"
        f"{settings.get('bank_account_name') or ''}<br/>"
        f"{settings.get('bank_details') or ''}"
    )

    story = [
        title_table,
        Spacer(1, 3 * mm),
        header_table,
        Spacer(1, 8 * mm),
        Paragraph("<b>Bill To</b>", styles["Normal"]),
        Paragraph(bill_block, styles["Normal"]),
        Spacer(1, 6 * mm),
        items_table,
        Spacer(1, 4 * mm),
        totals_table,
        Spacer(1, 10 * mm),
        Paragraph(bank_block, styles["Normal"]),
    ]
    if invoice.get("notes"):
        story.extend([Spacer(1, 6 * mm), Paragraph(f"<i>{invoice['notes']}</i>", styles["Normal"])])

    doc.build(story)
    return buf.getvalue()
