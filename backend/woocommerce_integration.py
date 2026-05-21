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


def _summarise_order(woo: dict) -> dict:
    """Reduce the (huge) raw Woo order to the doc shape we store in Mongo."""
    derived = _derive_status_fields(woo)
    billing = woo.get("billing") or {}
    shipping = woo.get("shipping") or {}
    line_items = [
        {
            "id": li.get("id"),
            "product_id": li.get("product_id"),
            "name": li.get("name"),
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
    """Refresh the local mirror of Woo products (powers the autocomplete)."""
    checked = upserted = 0
    errors: list[str] = []
    try:
        async for page in _iter_paginated("/products", params={"status": "publish"}):
            ops: list[UpdateOne] = []
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
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                }
                ops.append(UpdateOne({"id": doc["id"]}, {"$set": doc}, upsert=True))
            if ops:
                r = await db.woo_products.bulk_write(ops, ordered=False)
                upserted += (r.upserted_count or 0) + (r.modified_count or 0)
    except Exception as exc:  # noqa: BLE001
        errors.append(str(exc))
        logger.warning("Woo product sync failed: %s", exc)
    return {"checked": checked, "upserted": upserted, "errors": errors}


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
        q: dict = {}
        if not is_search:
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
                {"line_items.name": rx},
                {"line_items.sku": rx},
            ]
        items = await db.woo_orders.find(q, {"_id": 0, "raw": 0}) \
            .sort("date_created", -1).limit(limit).to_list(limit)
        return {"items": items, "total": len(items)}

    @api.get("/orders/counts")
    async def order_counts(_: dict = Depends(require_role("admin"))):
        active = await db.woo_orders.count_documents({"status": "active", "is_draft": {"$ne": True}})
        completed = await db.woo_orders.count_documents({"status": "completed"})
        draft = await db.woo_orders.count_documents({"is_draft": True})
        return {"active": active, "completed": completed, "draft": draft, "all": active + completed + draft}

    @api.get("/orders/{order_id}")
    async def get_order(order_id: str, _: dict = Depends(require_role("admin"))):
        doc = await db.woo_orders.find_one({"id": order_id}, {"_id": 0})
        if not doc:
            raise HTTPException(404, "Order not found")
        return doc

    @api.get("/woo/products/autocomplete")
    async def products_autocomplete(
        q: str = Query("", min_length=0),
        limit: int = Query(15, ge=1, le=50),
        _: dict = Depends(require_role("admin")),
    ):
        filt: dict = {}
        if q.strip():
            import re
            rx = {"$regex": re.escape(q.strip()), "$options": "i"}
            filt["$or"] = [{"name": rx}, {"sku": rx}]
        items = await db.woo_products.find(
            filt, {"_id": 0, "id": 1, "name": 1, "sku": 1, "price": 1}
        ).limit(limit).to_list(limit)
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
