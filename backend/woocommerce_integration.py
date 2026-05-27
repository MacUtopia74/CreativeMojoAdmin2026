"""WooCommerce REST API v3 integration — Stage A (read-only sync).

Pulls live orders + products from https://www.creativemojo.com into our
``woo_orders`` and ``woo_products`` Mongo collections so the Orders module
inside our admin can display them. Future stages will add Xero invoicing.

Env vars (set in backend/.env):
    WOO_BASE_URL          (e.g. https://www.creativemojo.com)
    WOO_CONSUMER_KEY      (ck_…)
    WOO_CONSUMER_SECRET   (cs_…)
    WOO_WEBHOOK_SECRET    (shared HMAC secret configured in Woo admin)
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import logging
import os
from datetime import datetime, timedelta, timezone
from typing import Any, AsyncIterator, Optional

import httpx
from fastapi import APIRouter, BackgroundTasks, Depends, Header, HTTPException, Query, Request
from pymongo import UpdateOne

logger = logging.getLogger("creative-mojo-admin.woocommerce")

API_PREFIX = "/wp-json/wc/v3"

# Production-status mapping from Woo's order status → our internal labels
# (matches the user's screenshots: "Awaiting Assembly", "Ready To Ship", etc.)
WOO_STATUS_TO_PRODUCTION = {
    "pending":    "Awaiting Assembly",
    "on-hold":    "Awaiting Assembly",
    "processing": "Ready To Ship",
    "completed":  "Completed",
    "cancelled":  "Cancelled",
    "refunded":   "Refunded",
    "failed":     "Failed",
}
TERMINAL_STATUSES = {"completed", "cancelled", "refunded", "failed"}


def _client() -> httpx.AsyncClient:
    """Build a one-shot async client from env credentials. Returns a fresh
    client per call (the caller is responsible for ``aclose``) — fine for
    the modest call volumes in Stage A and avoids cross-event-loop issues
    when called from BackgroundTasks."""
    base = (os.environ.get("WOO_BASE_URL") or "").rstrip("/")
    key = os.environ.get("WOO_CONSUMER_KEY")
    secret = os.environ.get("WOO_CONSUMER_SECRET")
    if not (base and key and secret):
        raise RuntimeError(
            "WOO_BASE_URL / WOO_CONSUMER_KEY / WOO_CONSUMER_SECRET not configured"
        )
    return httpx.AsyncClient(
        base_url=base,
        auth=httpx.BasicAuth(key, secret),
        timeout=30.0,
    )


async def _iter_paginated(path: str, params: dict | None = None, per_page: int = 100) -> AsyncIterator[list[dict]]:
    """Yield successive pages of a Woo collection endpoint, honouring the
    ``X-WP-TotalPages`` header for termination."""
    base_params: dict[str, Any] = dict(params or {})
    base_params.setdefault("per_page", per_page)
    page = 1
    total_pages: Optional[int] = None
    async with _client() as http:
        while True:
            base_params["page"] = page
            r = await http.get(f"{API_PREFIX}{path}", params=base_params)
            if r.status_code != 200:
                raise RuntimeError(f"Woo {path} returned {r.status_code}: {r.text[:300]}")
            if total_pages is None:
                tph = r.headers.get("X-WP-TotalPages")
                total_pages = int(tph) if tph and tph.isdigit() else -1
            data = r.json()
            if not data:
                break
            yield data
            page += 1
            if total_pages != -1 and page > total_pages:
                break


def _derive_status_fields(woo: dict) -> dict:
    """Extract the canonical fields our admin UI needs from a raw Woo order.
    Keeps the full Woo payload too so we can render anything else later."""
    woo_status = (woo.get("status") or "").lower()
    production = WOO_STATUS_TO_PRODUCTION.get(woo_status, "Awaiting Assembly")
    is_paid = bool(woo.get("date_paid")) or woo_status in ("processing", "completed")
    # Channel pill — for Woo orders we record the Woo order number.
    channel_label = f"Woo#{woo.get('number') or woo.get('id')}"
    return {
        "woo_status": woo_status,
        "production_status": production,
        "status": "completed" if woo_status in TERMINAL_STATUSES else "active",
        "payment_status": "Paid" if is_paid else "Pending",
        "channel": "woocommerce",
        "channel_label": channel_label,
    }


import re as _re
import html as _html

_HTML_TAG_RE = _re.compile(r"<[^>]+>")


def _strip_html(s: str) -> str:
    """Woo stores product titles with inline HTML (e.g. ``<strong>FREE</strong>
    Queen Camilla Colouring-In Sheet``) AND with HTML-encoded entities like
    ``&amp;``. Strip tags, unescape entities, then collapse whitespace."""
    if not s:
        return s
    return _re.sub(r"\s+", " ", _html.unescape(_HTML_TAG_RE.sub("", s))).strip()


def _summarise_order(woo: dict) -> dict:
    """Reduce the (huge) raw Woo order to the doc shape we store in Mongo."""
    derived = _derive_status_fields(woo)
    billing = woo.get("billing") or {}
    shipping = woo.get("shipping") or {}
    line_items = [
        {
            "id": li.get("id"),
            "product_id": li.get("product_id"),
            "name": _strip_html(li.get("name") or ""),
            "sku": li.get("sku"),
            "quantity": li.get("quantity"),
            "subtotal": li.get("subtotal"),
            "total": li.get("total"),
        }
        for li in (woo.get("line_items") or [])
    ]
    customer_label = (
        (billing.get("company") or "").strip()
        or f"{billing.get('first_name') or ''} {billing.get('last_name') or ''}".strip()
        or "Unknown customer"
    )
    return {
        "id": str(woo.get("id")),
        "woo_id": woo.get("id"),
        "woo_number": woo.get("number"),
        "customer_label": customer_label,
        "customer_email": billing.get("email"),
        "billing": billing,
        "shipping": shipping,
        "date_created": woo.get("date_created"),
        "date_modified": woo.get("date_modified"),
        "date_paid": woo.get("date_paid"),
        "due_date": woo.get("meta_data") and next(
            (m.get("value") for m in (woo.get("meta_data") or [])
             if m.get("key") in ("_due_date", "_order_due_date", "due_date")),
            None,
        ),
        "currency": woo.get("currency"),
        "total": woo.get("total"),
        "shipping_total": woo.get("shipping_total"),
        "line_items": line_items,
        "invoiced": False,  # set true once Xero invoice raised (stage C)
        **derived,
        "raw": woo,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }


async def backfill_orders(db, months: int = 24) -> dict:
    """Pull the last ``months`` of orders and idempotently upsert them.
    Returns ``{inserted, updated, checked, errors}``."""
    cutoff = (datetime.now(timezone.utc) - timedelta(days=30 * months)).isoformat()
    checked = inserted = updated = 0
    errors: list[str] = []
    try:
        async for page in _iter_paginated("/orders", params={"after": cutoff}):
            ops: list[UpdateOne] = []
            for raw in page:
                checked += 1
                doc = _summarise_order(raw)
                ops.append(UpdateOne({"id": doc["id"]}, {"$set": doc}, upsert=True))
            if ops:
                r = await db.woo_orders.bulk_write(ops, ordered=False)
                inserted += r.upserted_count or 0
                updated += r.modified_count or 0
    except Exception as exc:  # noqa: BLE001
        errors.append(str(exc))
        logger.warning("Woo backfill failed: %s", exc)
    return {"checked": checked, "inserted": inserted, "updated": updated, "errors": errors}


async def sync_products(db) -> dict:
    """Refresh the local mirror of Woo products (powers the autocomplete).

    Variable products in Woo have their actual purchasable SKUs/prices on
    child ``variations`` (e.g. "Group Art Kit" → Medium / Large / 1-2-1).
    We pull those too and store each variation as its own row, tagged with
    ``parent_id`` + ``variant_label`` so the autocomplete can show every
    purchasable option separately."""
    checked = upserted = 0
    variations_synced = 0
    errors: list[str] = []
    try:
        async for page in _iter_paginated("/products", params={"status": "publish"}):
            ops: list[UpdateOne] = []
            variable_parent_ids: list[int] = []
            for raw in page:
                checked += 1
                doc = {
                    "id": str(raw.get("id")),
                    "woo_id": raw.get("id"),
                    "name": raw.get("name"),
                    "sku": raw.get("sku"),
                    "type": raw.get("type"),
                    "price": raw.get("price"),
                    "regular_price": raw.get("regular_price"),
                    "stock_status": raw.get("stock_status"),
                    "attributes": raw.get("attributes") or [],
                    "is_variation": False,
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                }
                ops.append(UpdateOne({"id": doc["id"]}, {"$set": doc}, upsert=True))
                if raw.get("type") == "variable":
                    variable_parent_ids.append(int(raw.get("id")))
            if ops:
                r = await db.woo_products.bulk_write(ops, ordered=False)
                upserted += (r.upserted_count or 0) + (r.modified_count or 0)

            # Variations are fetched per-parent.
            for parent_id in variable_parent_ids:
                try:
                    parent_doc = await db.woo_products.find_one({"woo_id": parent_id}, {"name": 1, "_id": 0})
                    parent_name = (parent_doc or {}).get("name") or f"Product {parent_id}"
                    async for vpage in _iter_paginated(f"/products/{parent_id}/variations", params={}):
                        vops: list[UpdateOne] = []
                        for vraw in vpage:
                            variations_synced += 1
                            # Build a "Medium" / "Large" style label from the variation attributes.
                            attrs = vraw.get("attributes") or []
                            label_parts = [a.get("option") for a in attrs if a.get("option")]
                            variant_label = " / ".join(label_parts) if label_parts else (vraw.get("sku") or "Variation")
                            vdoc = {
                                "id": str(vraw.get("id")),
                                "woo_id": vraw.get("id"),
                                "parent_id": parent_id,
                                "parent_name": parent_name,
                                "name": f"{parent_name} – {variant_label}",
                                "variant_label": variant_label,
                                "sku": vraw.get("sku"),
                                "type": "variation",
                                "price": vraw.get("price"),
                                "regular_price": vraw.get("regular_price"),
                                "stock_status": vraw.get("stock_status"),
                                "attributes": attrs,
                                "is_variation": True,
                                "downloadable": vraw.get("downloadable", False),
                                "updated_at": datetime.now(timezone.utc).isoformat(),
                            }
                            vops.append(UpdateOne({"id": vdoc["id"]}, {"$set": vdoc}, upsert=True))
                        if vops:
                            r = await db.woo_products.bulk_write(vops, ordered=False)
                            upserted += (r.upserted_count or 0) + (r.modified_count or 0)
                except Exception as inner:  # noqa: BLE001
                    errors.append(f"variations for {parent_id}: {inner}")
                    logger.warning("Variation sync failed for product %s: %s", parent_id, inner)
    except Exception as exc:  # noqa: BLE001
        errors.append(str(exc))
        logger.warning("Woo product sync failed: %s", exc)
    return {"checked": checked, "upserted": upserted, "variations_synced": variations_synced, "errors": errors}


# ---------------------------------------------------------------- webhook
def verify_webhook_signature(body: bytes, header_sig: Optional[str]) -> bool:
    secret = os.environ.get("WOO_WEBHOOK_SECRET") or ""
    if not header_sig or not secret:
        return False
    digest = hmac.new(secret.encode(), body, hashlib.sha256).digest()
    expected = base64.b64encode(digest).decode()
    return hmac.compare_digest(expected, header_sig)


# ---------------------------------------------------------------- scheduler
async def schedule_periodic(db, every_seconds: int = 3600):
    """Hourly safety re-sync — pulls orders modified in the last 2h to catch
    anything the webhook dropped."""
    await asyncio.sleep(60)
    while True:
        try:
            if os.environ.get("WOO_CONSUMER_KEY"):
                window = (datetime.now(timezone.utc) - timedelta(hours=2)).isoformat()
                async for page in _iter_paginated("/orders", params={"modified_after": window}):
                    ops = [
                        UpdateOne({"id": _summarise_order(o)["id"]},
                                  {"$set": _summarise_order(o)}, upsert=True)
                        for o in page
                    ]
                    if ops:
                        await db.woo_orders.bulk_write(ops, ordered=False)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Woo hourly resync failed: %s", exc)
        await asyncio.sleep(every_seconds)


# ---------------------------------------------------------------- HTTP API
def attach(api, db, require_role):
    """Register all Orders + Woo-sync endpoints on the parent FastAPI router."""

    async def _next_display_order_id(db) -> int:
        """Return the next continuous order number — picks up right after
        the highest existing `display_order_id` (which already covers
        live Woo + legacy + previous manual drafts)."""
        top = await db.woo_orders.find_one(
            {"display_order_id": {"$ne": None}},
            sort=[("display_order_id", -1)],
            projection={"_id": 0, "display_order_id": 1},
        )
        return int((top or {}).get("display_order_id") or 8066) + 1

    @api.get("/orders")
    async def list_orders(
        tab: str = Query("active"),  # active | completed | all | draft
        search: Optional[str] = None,
        limit: int = Query(500, le=2000),
        _: dict = Depends(require_role("admin")),
    ):
        """Return orders matching the chosen tab + optional search string.

        Search behaviour mirrors Contacts: when ``search`` is non-empty the
        tab filter is bypassed so admins can find any order from any tab.
        Each result still carries its ``status`` / ``channel`` so the UI
        pills make it obvious which tab it really lives in.
        """
        is_search = bool(search and search.strip())
        # The Franchisee tab is implemented as a *post-decoration* filter
        # because the franchisee_match field is added after the DB query.
        # We therefore widen the underlying tab to "all" and apply the
        # filter once the rows have been decorated below.
        franchisee_only = (tab == "franchisee")
        q: dict = {}
        if not is_search and not franchisee_only:
            if tab == "active":
                q["status"] = "active"
                q["is_draft"] = {"$ne": True}
            elif tab == "completed":
                q["status"] = "completed"
            elif tab == "draft":
                q["is_draft"] = True
            # "all" → no filter
        if is_search:
            import re
            rx = {"$regex": re.escape(search.strip()), "$options": "i"}
            q["$or"] = [
                {"customer_label": rx},
                {"customer_email": rx},
                {"woo_number": rx},
                {"id": rx},
                {"legacy_order_id": rx},
                {"display_order_id": int(search.strip()) if search.strip().isdigit() else -1},
                {"line_items.name": rx},
                {"line_items.sku": rx},
            ]
        items = await db.woo_orders.find(q, {"_id": 0, "raw": 0}) \
            .sort("date_created", -1).limit(limit).to_list(limit)
        from order_franchisee_match import decorate_orders
        await decorate_orders(db, items)
        if franchisee_only:
            items = [o for o in items if o.get("franchisee_match")]
        return {"items": items, "total": len(items)}

    @api.get("/orders/counts")
    async def order_counts(_: dict = Depends(require_role("admin"))):
        active = await db.woo_orders.count_documents({"status": "active", "is_draft": {"$ne": True}})
        completed = await db.woo_orders.count_documents({"status": "completed"})
        draft = await db.woo_orders.count_documents({"is_draft": True})
        # Franchisee count needs the same decoration logic as the list
        # endpoint (email + org-name match), so we just load everything and
        # re-use the helper. With ~1.3k orders this stays well under 100ms.
        all_docs = await db.woo_orders.find(
            {}, {"_id": 0, "customer_label": 1, "customer_email": 1},
        ).to_list(5000)
        from order_franchisee_match import decorate_orders
        await decorate_orders(db, all_docs)
        franchisee = sum(1 for o in all_docs if o.get("franchisee_match"))
        return {
            "active": active,
            "completed": completed,
            "draft": draft,
            "franchisee": franchisee,
            "all": active + completed + draft,
        }

    @api.get("/orders/{order_id}")
    async def get_order(order_id: str, _: dict = Depends(require_role("admin"))):
        doc = await db.woo_orders.find_one({"id": order_id}, {"_id": 0})
        if not doc:
            raise HTTPException(404, "Order not found")
        from order_franchisee_match import decorate_one
        await decorate_one(db, doc)
        return doc

    # ------------------------------------------------------------ Stage B mutations
    @api.post("/orders")
    async def create_manual_order(
        body: dict,
        user: dict = Depends(require_role("admin")),
    ):
        """Create a manually-entered Draft order. These never sync to Woo
        (channel='direct') and start in the Draft tab. The admin works on
        them locally and flips them Active via the Actions menu, which
        moves them onto the Active tab.

        Body shape: ``{customer_label, customer_email?, line_items[], shipping_total?, due_date?}``
        ``line_items`` items are ``{name, sku?, quantity, subtotal}``.
        """
        import uuid as _uuid
        oid = f"draft-{_uuid.uuid4().hex[:8]}"
        # Reserve a continuous display number up-front so the admin sees
        # the human ID (e.g. 8068) from the moment they create the draft.
        next_display = await _next_display_order_id(db)
        line_items = [
            {
                "id": idx + 1,
                "product_id": li.get("product_id"),
                "name": li.get("name") or "",
                "sku": li.get("sku"),
                "quantity": int(li.get("quantity") or 1),
                "subtotal": str(li.get("subtotal") or "0.00"),
                "total": f"{float(li.get('subtotal') or 0) * int(li.get('quantity') or 1):.2f}",
            }
            for idx, li in enumerate(body.get("line_items") or [])
        ]
        shipping_total = float(body.get("shipping_total") or 0)
        order_total = shipping_total + sum(float(li["total"]) for li in line_items)
        now = datetime.now(timezone.utc).isoformat()
        doc = {
            "id": oid,
            "display_order_id": next_display,
            "woo_id": None,
            "woo_number": None,
            "customer_label": (body.get("customer_label") or "").strip() or "New Customer",
            "customer_email": body.get("customer_email"),
            "billing": {
                "company": body.get("customer_label"),
                "email": body.get("customer_email"),
            },
            "shipping": {},
            "date_created": now,
            "date_modified": now,
            "date_paid": None,
            "due_date": body.get("due_date"),
            "currency": "GBP",
            "total": f"{order_total:.2f}",
            "shipping_total": f"{shipping_total:.2f}",
            "line_items": line_items,
            "invoiced": False,
            "is_draft": True,
            "status": "active",  # will be promoted off draft via PATCH
            "woo_status": "manual-draft",
            "production_status": "Awaiting Assembly",
            "payment_status": "Pending",
            "channel": "direct",
            "channel_label": "Direct",
            "created_by": user.get("email"),
            "updated_at": now,
        }
        await db.woo_orders.insert_one(doc)
        return {"ok": True, "id": oid, "order": {k: v for k, v in doc.items() if k != "_id"}}

    @api.patch("/orders/{order_id}")
    async def update_order(
        order_id: str,
        body: dict,
        user: dict = Depends(require_role("admin")),
    ):
        """In-place edit of a single order. Whitelisted fields only so we
        never accidentally let a PATCH overwrite the Woo source-of-truth
        payload. Accepts: ``shipping_total``, ``due_date``, ``customer_label``,
        ``customer_email``, ``production_status``, ``payment_status``,
        ``status``, ``is_draft``, ``invoiced``, ``line_items`` (full replace),
        ``admin_notes``.
        """
        existing = await db.woo_orders.find_one({"id": order_id}, {"_id": 0})
        if not existing:
            raise HTTPException(404, "Order not found")
        allowed = {
            "shipping_total", "due_date", "customer_label", "customer_email",
            "production_status", "payment_status", "status", "is_draft",
            "invoiced", "line_items", "admin_notes",
            "po_number", "customer_reference",
        }
        updates: dict = {}
        for k, v in (body or {}).items():
            if k in allowed:
                updates[k] = v
        if "line_items" in updates:
            # Normalise + recompute totals when caller swaps the line items.
            li_norm = []
            for i, li in enumerate(updates["line_items"] or []):
                qty = int(li.get("quantity") or 1)
                sub = float(li.get("subtotal") or 0)
                li_norm.append({
                    "id": li.get("id") or (i + 1),
                    "product_id": li.get("product_id"),
                    "name": li.get("name") or "",
                    "sku": li.get("sku"),
                    "quantity": qty,
                    "subtotal": f"{sub:.2f}",
                    "total": f"{sub * qty:.2f}",
                })
            updates["line_items"] = li_norm
            ship = float(updates.get("shipping_total") or existing.get("shipping_total") or 0)
            updates["total"] = f"{ship + sum(float(li['total']) for li in li_norm):.2f}"
        elif "shipping_total" in updates:
            ship = float(updates["shipping_total"] or 0)
            li_total = sum(float(li.get("total") or 0) for li in existing.get("line_items") or [])
            updates["shipping_total"] = f"{ship:.2f}"
            updates["total"] = f"{ship + li_total:.2f}"
        updates["updated_at"] = datetime.now(timezone.utc).isoformat()
        updates["updated_by"] = user.get("email")
        await db.woo_orders.update_one({"id": order_id}, {"$set": updates})
        fresh = await db.woo_orders.find_one({"id": order_id}, {"_id": 0, "raw": 0})
        return {"ok": True, "order": fresh}

    @api.post("/orders/{order_id}/action")
    async def order_action(
        order_id: str,
        body: dict,
        user: dict = Depends(require_role("admin")),
    ):
        """Apply one of the five Actions-menu shortcuts from the legacy admin.

        ``action`` ∈ {
          ``mark_completed``, ``complete_and_invoice``, ``create_invoice``,
          ``mark_paid``, ``mark_active``, ``change_customer``
        }
        Invoice actions write a placeholder until Stage C wires Xero.
        """
        existing = await db.woo_orders.find_one({"id": order_id}, {"_id": 0})
        if not existing:
            raise HTTPException(404, "Order not found")
        action = (body or {}).get("action")
        now = datetime.now(timezone.utc).isoformat()
        updates: dict = {"updated_at": now, "updated_by": user.get("email")}
        if action == "mark_completed":
            updates["status"] = "completed"
            updates["production_status"] = "Completed"
        elif action == "mark_active":
            updates["is_draft"] = False
            updates["status"] = "active"
            updates["woo_status"] = "processing"
            # NB: We do NOT overwrite display_order_id here — drafts are
            # already assigned a continuous number at creation time.
        elif action == "mark_paid":
            updates["payment_status"] = "Paid"
            updates["date_paid"] = now
        elif action == "create_invoice":
            updates["invoiced"] = True
            updates["invoice_pending_xero"] = True  # Stage C will pick this up
        elif action == "complete_and_invoice":
            updates["status"] = "completed"
            updates["production_status"] = "Completed"
            updates["invoiced"] = True
            updates["invoice_pending_xero"] = True
        elif action == "change_customer":
            new_label = (body.get("customer_label") or "").strip()
            new_email = (body.get("customer_email") or "").strip()
            if not new_label:
                raise HTTPException(400, "customer_label required for change_customer")
            updates["customer_label"] = new_label
            updates["customer_email"] = new_email or existing.get("customer_email")
            updates["billing"] = {
                **(existing.get("billing") or {}),
                "company": new_label,
                "email": new_email or (existing.get("billing") or {}).get("email"),
            }
        else:
            raise HTTPException(400, f"Unknown action: {action!r}")
        await db.woo_orders.update_one({"id": order_id}, {"$set": updates})
        fresh = await db.woo_orders.find_one({"id": order_id}, {"_id": 0, "raw": 0})
        return {"ok": True, "order": fresh}

    @api.post("/orders/bulk-action")
    async def orders_bulk_action(
        body: dict,
        user: dict = Depends(require_role("admin")),
    ):
        """Apply one action to many orders at once. Currently used to mass-
        archive the 220+ stale "active" Woo orders that were never marked
        complete in WooCommerce."""
        ids = body.get("ids") or []
        action = body.get("action")
        if not ids or not action:
            raise HTTPException(400, "ids and action are required")
        if action not in {"mark_completed", "mark_paid", "mark_active", "delete"}:
            raise HTTPException(400, f"Unsupported bulk action: {action!r}")
        now = datetime.now(timezone.utc).isoformat()
        if action == "delete":
            r = await db.woo_orders.delete_many({"id": {"$in": ids}})
            return {"ok": True, "deleted": r.deleted_count}
        if action == "mark_active":
            # Promote drafts to active orders. Display number was already
            # allocated at draft creation, so we just flip the flag.
            r = await db.woo_orders.update_many(
                {"id": {"$in": ids}, "is_draft": True},
                {"$set": {
                    "is_draft": False,
                    "status": "active",
                    "updated_at": now,
                    "updated_by": user.get("email"),
                }},
            )
            return {"ok": True, "promoted": r.modified_count}
        upd: dict = {"updated_at": now, "updated_by": user.get("email")}
        if action == "mark_completed":
            upd["status"] = "completed"
            upd["production_status"] = "Completed"
        elif action == "mark_paid":
            upd["payment_status"] = "Paid"
            upd["date_paid"] = now
        r = await db.woo_orders.update_many({"id": {"$in": ids}}, {"$set": upd})
        return {"ok": True, "matched": r.matched_count, "modified": r.modified_count}

    @api.delete("/orders/{order_id}")
    async def delete_order(
        order_id: str,
        _: dict = Depends(require_role("admin")),
    ):
        """Hard-delete a manual draft order. Live Woo-sourced orders are
        kept (deleting them locally would just have the next sync recreate
        them anyway) — caller is told to use ``mark_completed`` instead."""
        existing = await db.woo_orders.find_one({"id": order_id}, {"_id": 0, "is_draft": 1, "channel": 1})
        if not existing:
            raise HTTPException(404, "Order not found")
        if existing.get("channel") == "woocommerce":
            raise HTTPException(400, "Cannot delete a WooCommerce-sourced order — mark it completed instead.")
        r = await db.woo_orders.delete_one({"id": order_id})
        return {"ok": True, "deleted": r.deleted_count}

    @api.get("/woo/products/autocomplete")
    async def products_autocomplete(
        q: str = Query("", min_length=0),
        limit: int = Query(25, ge=1, le=100),
        _: dict = Depends(require_role("admin")),
    ):
        """Returns a flat list with both simple products and per-variation
        rows (so picking "World Cup 2026 – Large" is a single click).

        For variable parents we HIDE the parent itself (it's not purchasable)
        and only surface the child variations. Simple/external/grouped
        products surface normally."""
        filt: dict = {"type": {"$ne": "variable"}}  # never show pure parents
        if q.strip():
            import re
            rx = {"$regex": re.escape(q.strip()), "$options": "i"}
            filt["$or"] = [
                {"name": rx},
                {"parent_name": rx},
                {"sku": rx},
                {"variant_label": rx},
            ]
        items = await db.woo_products.find(
            filt,
            {"_id": 0, "id": 1, "name": 1, "sku": 1, "price": 1, "type": 1,
             "parent_id": 1, "parent_name": 1, "variant_label": 1, "is_variation": 1,
             "downloadable": 1, "stock_status": 1},
        ).sort([("parent_name", 1), ("name", 1)]).limit(limit).to_list(limit)
        return {"items": items}

    @api.post("/admin/woo/backfill-orders")
    async def trigger_backfill(
        background: BackgroundTasks,
        months: int = 24,
        user: dict = Depends(require_role("admin")),
    ):
        async def _job():
            await backfill_orders(db, months=months)
        background.add_task(_job)
        return {"ok": True, "scheduled": True, "months": months}

    @api.post("/admin/woo/sync-products")
    async def trigger_products_sync(
        background: BackgroundTasks,
        user: dict = Depends(require_role("admin")),
    ):
        async def _job():
            await sync_products(db)
        background.add_task(_job)
        return {"ok": True, "scheduled": True}

    @api.post("/intake/woocommerce")
    async def woo_webhook(
        request: Request,
        x_wc_webhook_signature: Optional[str] = Header(None, alias="X-WC-Webhook-Signature"),
        x_wc_webhook_topic: Optional[str] = Header(None, alias="X-WC-Webhook-Topic"),
        x_wc_webhook_source: Optional[str] = Header(None, alias="X-WC-Webhook-Source"),
        x_wc_webhook_id: Optional[str] = Header(None, alias="X-WC-Webhook-ID"),
    ):
        raw = await request.body()
        # Woo sends a one-off, UNSIGNED test ping on webhook save —
        # tiny body (~13 bytes), no X-WC-Webhook-Signature header. Accept
        # silently so the logs stay clean and Woo marks the webhook alive.
        if not x_wc_webhook_signature and len(raw) < 64:
            logger.info("Woo webhook test ping accepted (body_bytes=%d)", len(raw))
            return {"ok": True, "skipped": "test-ping"}
        if not verify_webhook_signature(raw, x_wc_webhook_signature):
            # Compute the signature we WOULD have accepted so we can diff it
            # against what Woo sent (first 8 chars only — never leak the full
            # secret-derived digest in case logs are exfiltrated).
            secret = os.environ.get("WOO_WEBHOOK_SECRET") or ""
            expected = base64.b64encode(
                hmac.new(secret.encode(), raw, hashlib.sha256).digest()
            ).decode() if secret else ""
            logger.warning(
                "Woo webhook signature mismatch · topic=%s · webhook_id=%s · "
                "source=%s · body_bytes=%d · received_sig=%s… · expected_sig=%s… · "
                "secret_len=%d",
                x_wc_webhook_topic, x_wc_webhook_id, x_wc_webhook_source,
                len(raw),
                (x_wc_webhook_signature or "")[:8],
                expected[:8],
                len(secret),
            )
            raise HTTPException(401, "Invalid webhook signature")
        try:
            payload = await request.json()
        except Exception:
            raise HTTPException(400, "Invalid JSON")
        # Woo sends a test ping ("webhook_id" only, no order) on save — ack it.
        if not payload.get("id"):
            logger.info("Woo webhook test ping accepted (topic=%s)", x_wc_webhook_topic)
            return {"ok": True, "skipped": "no-id-test-ping"}
        doc = _summarise_order(payload)
        await db.woo_orders.update_one({"id": doc["id"]}, {"$set": doc}, upsert=True)
        logger.info("Woo webhook: upserted order %s (topic=%s)", doc["id"], x_wc_webhook_topic)
        return {"ok": True, "id": doc["id"]}
