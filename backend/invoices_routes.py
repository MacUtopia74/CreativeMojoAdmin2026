"""Invoices module — merged from the standalone "Sandra's Invoices" app
(GitHub: MacUtopia74/Sandras-Admin, deployed at pay-paperwork.emergent.host).

What changed from the original standalone server:
- All routes now sit under `/api/invoices/...` and require `admin` role via
  the host app's JWT login (the original shared-password auth has been
  dropped — admins are already authenticated when they reach these routes).
- MongoDB collections renamed to avoid host collisions:
    clients   -> invoice_clients
    settings  -> invoice_settings  (with _id "app_settings")
    invoices  -> invoices  (unique already)
- The setup-password / verify-password / check-password endpoints are
  removed — they protected a single-tenant app and serve no purpose under
  the host's per-user JWT.
- PDF generation, stats and next-invoice-number endpoints carried across
  intact.

Mount via:
    from invoices_routes import build_invoices_router
    api.include_router(build_invoices_router(db, require_role))
"""
from __future__ import annotations

from datetime import datetime, timezone
from io import BytesIO
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict, Field
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import (
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)
import uuid


# =========================== MODELS ===========================

class LineItem(BaseModel):
    description: str
    quantity: float = 1
    unit_price: float
    amount: float = 0


class ClientBase(BaseModel):
    name: str
    email: Optional[str] = ""
    email2: Optional[str] = ""
    phone: Optional[str] = ""
    address: Optional[str] = ""
    city: Optional[str] = ""
    country: Optional[str] = ""
    # Per-invoice display toggles
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
    subtotal: float
    tax_rate: float = 0
    tax_amount: float = 0
    discount_rate: float = 0
    discount_amount: float = 0
    total: float
    notes: Optional[str] = ""
    payment_terms: Optional[str] = "Net 14 Days"
    status: str = "draft"  # draft, sent, partial, paid, deleted
    deleted_at: Optional[str] = None
    # Payment-linking fields — populated by /link-payment routes. Kept on
    # the base model so they round-trip through the response models.
    linked_transactions: Optional[List[dict]] = None
    linked_transaction_id: Optional[str] = None
    linked_transaction_amount: Optional[float] = None
    linked_transaction_timestamp: Optional[str] = None
    linked_transaction_description: Optional[str] = None
    paid_at: Optional[str] = None


class InvoiceCreate(InvoiceBase):
    pass


class InvoiceUpdate(BaseModel):
    client_id: Optional[str] = None
    client_name: Optional[str] = None
    client_email: Optional[str] = None
    client_email2: Optional[str] = None
    client_phone: Optional[str] = None
    client_address: Optional[str] = None
    invoice_number: Optional[str] = None
    issue_date: Optional[str] = None
    due_date: Optional[str] = None
    line_items: Optional[List[LineItem]] = None
    subtotal: Optional[float] = None
    tax_rate: Optional[float] = None
    tax_amount: Optional[float] = None
    discount_rate: Optional[float] = None
    discount_amount: Optional[float] = None
    total: Optional[float] = None
    notes: Optional[str] = None
    payment_terms: Optional[str] = None
    status: Optional[str] = None


class Invoice(InvoiceBase):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    created_at: str = Field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )
    updated_at: str = Field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )


class StatusUpdate(BaseModel):
    status: str


class LinkPayment(BaseModel):
    transaction_id: str


class InvoiceSettings(BaseModel):
    id: str = "app_settings"
    business_name: str = "Sandra Caldeira-Dunkerley"
    business_address: str = (
        "Channings, Brithem Bottom. Cullompton, EX15 1NB"
    )
    business_address_line1: str = "Channings, Brithem Bottom,"
    business_address_line2: str = "Cullompton, EX15 1NB"
    business_phone: str = "07957 343449"
    business_email: str = "sandracaldeiradunkerley77@gmail.com"
    bank_payment_info: str = "Payments by BACS/Online should be made to:"
    bank_account_name: str = "Sandra Caldeira-Dunkerley"
    bank_details: str = "Sort Code: 40-07-33 Account No. 62079658"


class InvoiceSettingsUpdate(BaseModel):
    business_name: Optional[str] = None
    business_address: Optional[str] = None
    business_address_line1: Optional[str] = None
    business_address_line2: Optional[str] = None
    business_phone: Optional[str] = None
    business_email: Optional[str] = None
    bank_payment_info: Optional[str] = None
    bank_account_name: Optional[str] = None
    bank_details: Optional[str] = None


DEFAULT_SETTINGS = InvoiceSettings().model_dump()


# =========================== ROUTER ===========================

def build_invoices_router(db, require_role):
    """Wire up the invoices module against the host MongoDB + auth."""
    router = APIRouter(prefix="/invoices", tags=["invoices"])
    admin = Depends(require_role("admin"))

    # ------------- CLIENTS (invoice_clients collection) -------------
    @router.get("/clients", response_model=List[Client])
    async def get_clients(_=admin):
        return await db.invoice_clients.find({}, {"_id": 0}).to_list(1000)

    @router.get("/clients/{client_id}", response_model=Client)
    async def get_client(client_id: str, _=admin):
        c = await db.invoice_clients.find_one(
            {"id": client_id}, {"_id": 0}
        )
        if not c:
            raise HTTPException(404, "Client not found")
        return c

    @router.post("/clients", response_model=Client)
    async def create_client(body: ClientCreate, _=admin):
        c = Client(**body.model_dump())
        await db.invoice_clients.insert_one(c.model_dump())
        return c

    @router.put("/clients/{client_id}", response_model=Client)
    async def update_client(client_id: str, body: ClientCreate, _=admin):
        existing = await db.invoice_clients.find_one(
            {"id": client_id}, {"_id": 0}
        )
        if not existing:
            raise HTTPException(404, "Client not found")
        await db.invoice_clients.update_one(
            {"id": client_id}, {"$set": body.model_dump()}
        )
        return await db.invoice_clients.find_one(
            {"id": client_id}, {"_id": 0}
        )

    @router.delete("/clients/{client_id}")
    async def delete_client(client_id: str, _=admin):
        res = await db.invoice_clients.delete_one({"id": client_id})
        if res.deleted_count == 0:
            raise HTTPException(404, "Client not found")
        return {"message": "Client deleted"}

    # ------------------------ INVOICES ------------------------
    # NOTE: order matters in FastAPI — the literal `/deleted/list` and
    # `/next-number` routes must be declared BEFORE `/{invoice_id}` so the
    # path matcher doesn't treat them as ids.

    @router.get("", response_model=List[Invoice])
    async def list_invoices(
        status: Optional[str] = None,
        include_deleted: bool = False,
        _=admin,
    ):
        query: dict = {}
        if status:
            query["status"] = status
        elif not include_deleted:
            query["status"] = {"$ne": "deleted"}
        return (
            await db.invoices.find(query, {"_id": 0})
            .sort("created_at", -1)
            .to_list(1000)
        )

    @router.get("/deleted/list", response_model=List[Invoice])
    async def list_deleted_invoices(_=admin):
        return (
            await db.invoices.find({"status": "deleted"}, {"_id": 0})
            .sort("deleted_at", -1)
            .to_list(1000)
        )

    @router.get("/stats")
    async def get_stats(_=admin):
        total_invoices = await db.invoices.count_documents({})
        draft = await db.invoices.count_documents({"status": "draft"})
        sent = await db.invoices.count_documents({"status": "sent"})
        partial = await db.invoices.count_documents({"status": "partial"})
        paid = await db.invoices.count_documents({"status": "paid"})
        totals = await db.invoices.aggregate(
            [{"$group": {"_id": "$status", "total": {"$sum": "$total"}}}]
        ).to_list(10)
        total_revenue = sum(
            t["total"] for t in totals if t["_id"] == "paid"
        )
        outstanding = sum(
            t["total"] for t in totals if t["_id"] in ("draft", "sent", "partial")
        )
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
    async def next_invoice_number(_=admin):
        last = await db.invoices.find_one(
            {},
            {"_id": 0, "invoice_number": 1},
            sort=[("created_at", -1)],
        )
        if not last:
            return {"invoice_number": "SCD-001"}
        try:
            n = int(last["invoice_number"].split("-")[1])
            return {"invoice_number": f"SCD-{n + 1:03d}"}
        except (ValueError, IndexError):
            return {"invoice_number": "SCD-001"}

    @router.get("/{invoice_id}", response_model=Invoice)
    async def get_invoice(invoice_id: str, _=admin):
        inv = await db.invoices.find_one(
            {"id": invoice_id}, {"_id": 0}
        )
        if not inv:
            raise HTTPException(404, "Invoice not found")
        return inv

    @router.post("", response_model=Invoice)
    async def create_invoice(body: InvoiceCreate, _=admin):
        inv = Invoice(**body.model_dump())
        await db.invoices.insert_one(inv.model_dump())
        return inv

    @router.put("/{invoice_id}", response_model=Invoice)
    async def update_invoice(
        invoice_id: str, body: InvoiceUpdate, _=admin
    ):
        existing = await db.invoices.find_one(
            {"id": invoice_id}, {"_id": 0}
        )
        if not existing:
            raise HTTPException(404, "Invoice not found")
        update = {
            k: v for k, v in body.model_dump().items() if v is not None
        }
        update["updated_at"] = datetime.now(timezone.utc).isoformat()
        await db.invoices.update_one(
            {"id": invoice_id}, {"$set": update}
        )
        return await db.invoices.find_one(
            {"id": invoice_id}, {"_id": 0}
        )

    @router.delete("/{invoice_id}")
    async def delete_invoice(
        invoice_id: str, permanent: bool = False, _=admin
    ):
        existing = await db.invoices.find_one(
            {"id": invoice_id}, {"_id": 0}
        )
        if not existing:
            raise HTTPException(404, "Invoice not found")
        if permanent:
            await db.invoices.delete_one({"id": invoice_id})
            return {"message": "Invoice permanently deleted"}
        previous_status = existing.get("status", "draft")
        await db.invoices.update_one(
            {"id": invoice_id},
            {"$set": {
                "status": "deleted",
                "previous_status": previous_status,
                "deleted_at": datetime.now(timezone.utc).isoformat(),
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }},
        )
        return {"message": "Invoice moved to deleted"}

    @router.post("/{invoice_id}/restore", response_model=Invoice)
    async def restore_invoice(invoice_id: str, _=admin):
        existing = await db.invoices.find_one(
            {"id": invoice_id}, {"_id": 0}
        )
        if not existing:
            raise HTTPException(404, "Invoice not found")
        if existing.get("status") != "deleted":
            raise HTTPException(400, "Invoice is not deleted")
        previous = existing.get("previous_status", "draft")
        await db.invoices.update_one(
            {"id": invoice_id},
            {
                "$set": {
                    "status": previous,
                    "deleted_at": None,
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                },
                "$unset": {"previous_status": ""},
            },
        )
        return await db.invoices.find_one(
            {"id": invoice_id}, {"_id": 0}
        )

    @router.patch("/{invoice_id}/status", response_model=Invoice)
    async def update_invoice_status(
        invoice_id: str, body: StatusUpdate, _=admin
    ):
        existing = await db.invoices.find_one(
            {"id": invoice_id}, {"_id": 0}
        )
        if not existing:
            raise HTTPException(404, "Invoice not found")
        if body.status not in ("draft", "sent", "partial", "paid", "deleted"):
            raise HTTPException(400, "Invalid status")
        update = {
            "status": body.status,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
        if body.status == "deleted":
            update["previous_status"] = existing.get("status", "draft")
            update["deleted_at"] = datetime.now(
                timezone.utc
            ).isoformat()
        await db.invoices.update_one(
            {"id": invoice_id}, {"$set": update}
        )
        return await db.invoices.find_one(
            {"id": invoice_id}, {"_id": 0}
        )

    # -------------------- PAYMENT LINKING --------------------
    # Connects an invoice to one or more banking transactions. An invoice
    # can be paid by several receipts (deposit + balance, instalments,
    # bundled-with-other-invoices, etc.), so we store them as a list and
    # derive status from the running total vs. the invoice total.

    def _recalc_payment_state(invoice: dict) -> dict:
        """Returns {linked_transactions, paid_total, status, paid_at} based
        on the invoice's current `linked_transactions` list."""
        links = invoice.get("linked_transactions") or []
        paid_total = round(sum(float(x.get("amount") or 0) for x in links), 2)
        total = round(float(invoice.get("total") or 0), 2)
        # Use latest tx timestamp as the "paid" date.
        latest = max(
            (x.get("timestamp") for x in links if x.get("timestamp")),
            default=None,
        )
        if not links:
            # Restore to "sent" if previously paid/partial, else keep current.
            cur = invoice.get("status", "draft")
            status = "sent" if cur in ("paid", "partial") else cur
        elif paid_total + 0.005 >= total:
            status = "paid"
        else:
            status = "partial"
        return {
            "paid_total": paid_total,
            "status": status,
            "paid_at": latest,
        }

    @router.get("/{invoice_id}/payment-candidates")
    async def payment_candidates(invoice_id: str, _=admin):
        """Returns the 50 most plausible incoming banking transactions
        for this invoice — sorted by amount-match-and-recency. Already-
        linked transactions on THIS invoice are excluded so the user can
        focus on still-unmatched receipts (a partial balance match)."""
        invoice = await db.invoices.find_one(
            {"id": invoice_id}, {"_id": 0}
        )
        if not invoice:
            raise HTTPException(404, "Invoice not found")
        invoice_total = round(float(invoice.get("total") or 0), 2)
        already = {x.get("transaction_id") for x in
                   (invoice.get("linked_transactions") or [])}
        paid_state = _recalc_payment_state(invoice)
        remaining = round(invoice_total - paid_state["paid_total"], 2)
        # Suggest matches based on the OUTSTANDING balance (so for a
        # partial invoice we surface the next instalment) — fall back to
        # the full total if nothing is paid yet.
        target = remaining if paid_state["paid_total"] > 0 else invoice_total
        creds = await db.banking_transactions.find(
            {"transaction_type": "CREDIT"},
            {"_id": 0, "transaction_id": 1, "amount": 1,
             "description": 1, "timestamp": 1, "currency": 1,
             "linked_invoice_id": 1, "linked_invoice_number": 1},
        ).to_list(5000)
        creds = [c for c in creds if c["transaction_id"] not in already]
        def _score(t):
            if abs(t["amount"] - target) < 0.005:
                return 0
            if abs(t["amount"] - target) < 1.0:
                return 1
            return 2
        # Two-pass stable sort: newest-first, then by score. Python's sort
        # is stable so the secondary key (score) wins, ties broken by date.
        creds.sort(key=lambda t: t.get("timestamp") or "", reverse=True)
        creds.sort(key=_score)
        return {
            "candidates": creds[:50],
            "invoice_total": invoice_total,
            "paid_total": paid_state["paid_total"],
            "remaining": remaining,
            "target_amount": target,
        }

    @router.post("/{invoice_id}/link-payment")
    async def link_payment(invoice_id: str, body: LinkPayment, _=admin):
        invoice = await db.invoices.find_one(
            {"id": invoice_id}, {"_id": 0}
        )
        if not invoice:
            raise HTTPException(404, "Invoice not found")
        tx = await db.banking_transactions.find_one(
            {"transaction_id": body.transaction_id}, {"_id": 0}
        )
        if not tx:
            raise HTTPException(404, "Transaction not found")
        now = datetime.now(timezone.utc).isoformat()
        # Append to the linked_transactions list (dedupe by tx_id).
        existing_links = invoice.get("linked_transactions") or []
        if any(x.get("transaction_id") == body.transaction_id for x in existing_links):
            raise HTTPException(400, "Transaction already linked to this invoice")
        link_entry = {
            "transaction_id": body.transaction_id,
            "amount": tx.get("amount"),
            "timestamp": tx.get("timestamp"),
            "description": tx.get("description"),
            "linked_at": now,
        }
        new_links = existing_links + [link_entry]
        # Compute new status from the running total.
        merged = {**invoice, "linked_transactions": new_links}
        state = _recalc_payment_state(merged)
        update: dict = {
            "linked_transactions": new_links,
            "status": state["status"],
            "updated_at": now,
        }
        if state["status"] == "paid":
            update["paid_at"] = state["paid_at"] or now
        # Keep legacy single-field mirror so any older UI bits still work.
        update["linked_transaction_id"] = body.transaction_id
        update["linked_transaction_amount"] = tx.get("amount")
        update["linked_transaction_timestamp"] = tx.get("timestamp")
        update["linked_transaction_description"] = tx.get("description")
        await db.invoices.update_one({"id": invoice_id}, {"$set": update})
        await db.banking_transactions.update_one(
            {"transaction_id": body.transaction_id},
            {"$set": {
                "linked_invoice_id": invoice_id,
                "linked_invoice_number": invoice.get("invoice_number"),
            }},
        )
        return await db.invoices.find_one({"id": invoice_id}, {"_id": 0})

    @router.delete("/{invoice_id}/link-payment/{transaction_id}")
    async def unlink_single_payment(
        invoice_id: str, transaction_id: str, _=admin
    ):
        """Unlink one specific transaction from the invoice."""
        invoice = await db.invoices.find_one(
            {"id": invoice_id}, {"_id": 0}
        )
        if not invoice:
            raise HTTPException(404, "Invoice not found")
        existing_links = invoice.get("linked_transactions") or []
        new_links = [x for x in existing_links
                     if x.get("transaction_id") != transaction_id]
        if len(new_links) == len(existing_links):
            raise HTTPException(404, "Transaction not linked to this invoice")
        merged = {**invoice, "linked_transactions": new_links}
        state = _recalc_payment_state(merged)
        now = datetime.now(timezone.utc).isoformat()
        update: dict = {
            "linked_transactions": new_links,
            "status": state["status"],
            "updated_at": now,
        }
        # Refresh the legacy mirror to whichever link remains (or unset).
        if new_links:
            last = new_links[-1]
            update["linked_transaction_id"] = last.get("transaction_id")
            update["linked_transaction_amount"] = last.get("amount")
            update["linked_transaction_timestamp"] = last.get("timestamp")
            update["linked_transaction_description"] = last.get("description")
            await db.invoices.update_one({"id": invoice_id}, {"$set": update})
        else:
            await db.invoices.update_one(
                {"id": invoice_id},
                {"$set": update, "$unset": {
                    "linked_transaction_id": "",
                    "linked_transaction_amount": "",
                    "linked_transaction_timestamp": "",
                    "linked_transaction_description": "",
                    "paid_at": "",
                }},
            )
        await db.banking_transactions.update_one(
            {"transaction_id": transaction_id},
            {"$unset": {"linked_invoice_id": "", "linked_invoice_number": ""}},
        )
        return await db.invoices.find_one({"id": invoice_id}, {"_id": 0})

    @router.delete("/{invoice_id}/link-payment")
    async def unlink_all_payments(invoice_id: str, _=admin):
        """Unlink every transaction from this invoice in one go."""
        invoice = await db.invoices.find_one(
            {"id": invoice_id}, {"_id": 0}
        )
        if not invoice:
            raise HTTPException(404, "Invoice not found")
        tx_ids = [x.get("transaction_id")
                  for x in (invoice.get("linked_transactions") or [])
                  if x.get("transaction_id")]
        # Also pick up legacy single-link rows.
        legacy = invoice.get("linked_transaction_id")
        if legacy and legacy not in tx_ids:
            tx_ids.append(legacy)
        for tx_id in tx_ids:
            await db.banking_transactions.update_one(
                {"transaction_id": tx_id},
                {"$unset": {"linked_invoice_id": "", "linked_invoice_number": ""}},
            )
        now = datetime.now(timezone.utc).isoformat()
        prev_status = invoice.get("status")
        new_status = ("sent" if prev_status in ("paid", "partial")
                      else prev_status)
        await db.invoices.update_one(
            {"id": invoice_id},
            {
                "$set": {
                    "linked_transactions": [],
                    "status": new_status,
                    "updated_at": now,
                },
                "$unset": {
                    "linked_transaction_id": "",
                    "linked_transaction_amount": "",
                    "linked_transaction_timestamp": "",
                    "linked_transaction_description": "",
                    "paid_at": "",
                },
            },
        )
        return {"ok": True, "unlinked_count": len(tx_ids)}

    # -------------------- PDF GENERATION --------------------
    @router.get("/{invoice_id}/pdf")
    async def invoice_pdf(
        invoice_id: str,
        mark_sent: bool = True,
        download: bool = False,
        _=admin,
    ):
        invoice = await db.invoices.find_one(
            {"id": invoice_id}, {"_id": 0}
        )
        if not invoice:
            raise HTTPException(404, "Invoice not found")
        if mark_sent and invoice.get("status") == "draft":
            await db.invoices.update_one(
                {"id": invoice_id},
                {"$set": {
                    "status": "sent",
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                }},
            )
        settings = (
            await db.invoice_settings.find_one(
                {"id": "app_settings"}, {"_id": 0}
            )
        ) or DEFAULT_SETTINGS
        pdf_bytes = _render_invoice_pdf(invoice, settings)
        filename = f"{invoice['invoice_number']}.pdf"
        disposition = (
            f"attachment; filename={filename}"
            if download
            else f"inline; filename={filename}"
        )
        return Response(
            content=pdf_bytes,
            media_type="application/pdf",
            headers={
                "Content-Disposition": disposition,
                "Cache-Control": "no-cache",
            },
        )

    # -------------------- SETTINGS --------------------
    @router.get("/settings/me", response_model=InvoiceSettings)
    async def get_settings(_=admin):
        s = await db.invoice_settings.find_one(
            {"id": "app_settings"}, {"_id": 0}
        )
        if not s:
            await db.invoice_settings.insert_one(DEFAULT_SETTINGS)
            return DEFAULT_SETTINGS
        return s

    @router.put("/settings/me", response_model=InvoiceSettings)
    async def update_settings(
        body: InvoiceSettingsUpdate, _=admin
    ):
        update = {
            k: v for k, v in body.model_dump().items() if v is not None
        }
        existing = await db.invoice_settings.find_one(
            {"id": "app_settings"}, {"_id": 0}
        )
        if not existing:
            new_settings = {**DEFAULT_SETTINGS, **update}
            await db.invoice_settings.insert_one(new_settings)
            return new_settings
        await db.invoice_settings.update_one(
            {"id": "app_settings"}, {"$set": update}
        )
        return await db.invoice_settings.find_one(
            {"id": "app_settings"}, {"_id": 0}
        )

    return router


# =========================== PDF HELPER ===========================
# Pulled out of the route to keep it testable and to avoid bloating the
# router. Same look-and-feel as the original standalone app.

def _render_invoice_pdf(invoice: dict, settings: dict) -> bytes:
    buffer = BytesIO()
    doc = SimpleDocTemplate(
        buffer,
        pagesize=A4,
        rightMargin=30 * mm,
        leftMargin=30 * mm,
        topMargin=30 * mm,
        bottomMargin=30 * mm,
    )
    styles = getSampleStyleSheet()
    title_style = ParagraphStyle(
        "Title",
        parent=styles["Heading1"],
        fontSize=28,
        spaceAfter=5,
        fontName="Helvetica-Bold",
    )
    subtitle_style = ParagraphStyle(
        "Subtitle",
        parent=styles["Normal"],
        fontSize=14,
        spaceAfter=15,
        fontName="Courier",
    )
    heading_style = ParagraphStyle(
        "Heading",
        parent=styles["Normal"],
        fontSize=9,
        spaceAfter=3,
        textColor=colors.HexColor("#64748b"),
        fontName="Helvetica-Bold",
    )
    normal_style = ParagraphStyle(
        "Normal",
        parent=styles["Normal"],
        fontSize=10,
        spaceAfter=2,
    )
    small_style = ParagraphStyle(
        "Small",
        parent=styles["Normal"],
        fontSize=9,
        spaceAfter=2,
        textColor=colors.HexColor("#475569"),
    )
    right_style = ParagraphStyle(
        "Right",
        parent=styles["Normal"],
        fontSize=9,
        spaceAfter=2,
        alignment=2,
        textColor=colors.HexColor("#475569"),
    )
    right_bold = ParagraphStyle(
        "RightBold",
        parent=styles["Normal"],
        fontSize=10,
        spaceAfter=2,
        alignment=2,
        fontName="Helvetica-Bold",
    )

    elements = []
    business_name = settings.get(
        "business_name", "Sandra Caldeira-Dunkerley"
    )
    addr1 = settings.get(
        "business_address_line1", "Channings, Brithem Bottom,"
    )
    addr2 = settings.get(
        "business_address_line2", "Cullompton, EX15 1NB"
    )
    phone = settings.get("business_phone", "07957 343449")
    email = settings.get(
        "business_email", "sandracaldeiradunkerley77@gmail.com"
    )

    header = [
        [Paragraph("INVOICE", title_style),
         Paragraph(f"<b>{business_name}</b>", right_bold)],
        [Paragraph(invoice["invoice_number"], subtitle_style),
         Paragraph(addr1, right_style)],
        ["", Paragraph(addr2, right_style)],
        ["", Paragraph(phone, right_style)],
        ["", Paragraph(email, right_style)],
    ]
    header_table = Table(header, colWidths=[230, 230])
    header_table.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("ALIGN", (1, 0), (1, -1), "RIGHT"),
    ]))
    elements.append(header_table)
    elements.append(Spacer(1, 20))

    # Format dates to UK
    issue_date = invoice["issue_date"]
    due_date = invoice["due_date"]
    try:
        from datetime import datetime as dt
        for src_name in ("issue_date", "due_date"):
            v = invoice[src_name]
            d = (
                dt.fromisoformat(v.replace("Z", "+00:00"))
                if "T" in v
                else dt.strptime(v, "%Y-%m-%d")
            )
            if src_name == "issue_date":
                issue_date = d.strftime("%d/%m/%Y")
            else:
                due_date = d.strftime("%d/%m/%Y")
    except Exception:  # noqa: BLE001
        pass

    details = [[Paragraph("INVOICE TO:", heading_style), ""]]
    if invoice.get("client_name"):
        details.append([
            Paragraph(f"<b>{invoice['client_name']}</b>", normal_style),
            "",
        ])
    for f in ("client_email", "client_email2", "client_phone", "client_address"):
        if invoice.get(f):
            details.append([Paragraph(invoice[f], small_style), ""])
    details_table = Table(details, colWidths=[230, 230])
    details_table.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ]))
    elements.append(details_table)
    elements.append(Spacer(1, 15))

    dates = [
        [Paragraph("ISSUE DATE", heading_style)],
        [Paragraph(issue_date, normal_style)],
        [Spacer(1, 8)],
        [Paragraph("DUE DATE", heading_style)],
        [Paragraph(due_date, normal_style)],
    ]
    if invoice.get("payment_terms"):
        dates.append([Spacer(1, 8)])
        dates.append([Paragraph("PAYMENT TERMS", heading_style)])
        dates.append([Paragraph(invoice["payment_terms"], normal_style)])
    elements.append(Table(dates, colWidths=[460]))
    elements.append(Spacer(1, 25))

    # Line-items table
    rows = [["Description", "Qty", "Unit Price", "Amount"]]
    for it in invoice["line_items"]:
        rows.append([
            it["description"],
            str(it["quantity"]),
            f"£{it['unit_price']:.2f}",
            f"£{it['amount']:.2f}",
        ])
    line_table = Table(rows, colWidths=[250, 50, 80, 80])
    line_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#f8fafc")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.HexColor("#64748b")),
        ("ALIGN", (0, 0), (0, -1), "LEFT"),
        ("ALIGN", (1, 0), (-1, -1), "RIGHT"),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, 0), 8),
        ("BOTTOMPADDING", (0, 0), (-1, 0), 10),
        ("TOPPADDING", (0, 0), (-1, 0), 10),
        ("BACKGROUND", (0, 1), (-1, -1), colors.white),
        ("LINEBELOW", (0, 0), (-1, 0), 1.5, colors.HexColor("#e2e8f0")),
        ("LINEBELOW", (0, 1), (-1, -2), 0.5, colors.HexColor("#f1f5f9")),
        ("FONTNAME", (0, 1), (-1, -1), "Helvetica"),
        ("FONTSIZE", (0, 1), (-1, -1), 9),
        ("TOPPADDING", (0, 1), (-1, -1), 10),
        ("BOTTOMPADDING", (0, 1), (-1, -1), 10),
    ]))
    elements.append(line_table)
    elements.append(Spacer(1, 20))

    # Totals
    totals = [["Subtotal:", f"£{invoice['subtotal']:.2f}"]]
    if invoice.get("discount_rate", 0) > 0:
        totals.append([
            f"Discount ({invoice['discount_rate']}%):",
            f"-£{invoice['discount_amount']:.2f}",
        ])
    if invoice.get("tax_rate", 0) > 0:
        totals.append([
            f"Tax ({invoice['tax_rate']}%):",
            f"£{invoice['tax_amount']:.2f}",
        ])
    totals.append(["Total:", f"£{invoice['total']:.2f}"])
    totals_table = Table(totals, colWidths=[350, 110])
    totals_table.setStyle(TableStyle([
        ("ALIGN", (0, 0), (-1, -1), "RIGHT"),
        ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 10),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("LINEABOVE", (0, -1), (-1, -1), 1, colors.black),
    ]))
    elements.append(totals_table)
    elements.append(Spacer(1, 30))

    if invoice.get("notes"):
        elements.append(Paragraph("Notes:", heading_style))
        elements.append(Paragraph(invoice["notes"], normal_style))
        elements.append(Spacer(1, 10))
    if invoice.get("payment_terms"):
        elements.append(Paragraph(
            f"Payment Terms: {invoice['payment_terms']}", normal_style
        ))
    elements.append(Spacer(1, 30))
    elements.append(Paragraph(
        settings.get(
            "bank_payment_info",
            "Payments by BACS/Online should be made to:",
        ),
        normal_style,
    ))
    elements.append(Paragraph(
        settings.get(
            "bank_account_name", "Sandra Caldeira-Dunkerley"
        ),
        normal_style,
    ))
    elements.append(Paragraph(
        settings.get(
            "bank_details",
            "Sort Code: 40-07-33 Account No. 62079658",
        ),
        normal_style,
    ))

    doc.build(elements)
    buffer.seek(0)
    return buffer.getvalue()
