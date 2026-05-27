"""Monthly subscription drafts — Phase 2 Orders enhancement.

Lets admins flag a customer (by ``customer_label`` — e.g. "Cumnor Hill House")
as a monthly subscriber. On the 1st of every month at 08:00 Europe/London a
background scheduler then auto-creates an empty Draft order for that customer
with a memo line so it's easy to spot in the Draft tab. The admin opens the
draft, drops in the month's line items, and flips it Active.

State lives in a tiny ``order_subscriptions`` collection so we never touch the
order documents themselves. Identification is by *normalised customer name*
(case-insensitive, whitespace-collapsed) which matches what the user sees on
screen and survives small typo drift across Woo and direct orders.
"""
from __future__ import annotations

import asyncio
import logging
import re
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import Depends, HTTPException, Query
from zoneinfo import ZoneInfo

logger = logging.getLogger("creative-mojo-admin.subscriptions")

UK_TZ = ZoneInfo("Europe/London")
MEMO_PRODUCT_NAME = "Monthly subscription — fill in this month's items"


def _normalise_key(label: str) -> str:
    """Customer match key: lowercase, trim, collapse whitespace."""
    if not label:
        return ""
    return re.sub(r"\s+", " ", str(label).strip().lower())


def _current_month_str(now: Optional[datetime] = None) -> str:
    now = now or datetime.now(UK_TZ)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc).astimezone(UK_TZ)
    else:
        now = now.astimezone(UK_TZ)
    return f"{now.year:04d}-{now.month:02d}"


async def _next_display_order_id(db) -> int:
    top = await db.woo_orders.find_one(
        {"display_order_id": {"$ne": None}},
        sort=[("display_order_id", -1)],
        projection={"_id": 0, "display_order_id": 1},
    )
    return int((top or {}).get("display_order_id") or 8066) + 1


async def _create_draft_for_subscription(db, sub: dict) -> str:
    """Create the empty draft + memo line. Returns the new order id."""
    oid = f"sub-{uuid.uuid4().hex[:8]}"
    display = await _next_display_order_id(db)
    now_iso = datetime.now(timezone.utc).isoformat()
    today_uk = datetime.now(UK_TZ).strftime("%d/%m/%Y")
    doc = {
        "id": oid,
        "display_order_id": display,
        "woo_id": None,
        "woo_number": None,
        "customer_label": sub.get("customer_label") or "Subscription Customer",
        "customer_email": sub.get("customer_email"),
        "billing": {"company": sub.get("customer_label")},
        "shipping": {},
        "date_created": now_iso,
        "date_modified": now_iso,
        "date_paid": None,
        "due_date": None,
        "currency": "GBP",
        "total": "0.00",
        "shipping_total": "0.00",
        "line_items": [
            {
                "id": 1,
                "product_id": None,
                "name": f"{MEMO_PRODUCT_NAME} ({today_uk})",
                "sku": None,
                "quantity": 1,
                "subtotal": "0.00",
                "total": "0.00",
            }
        ],
        "invoiced": False,
        "is_draft": True,
        "status": "active",
        "woo_status": "subscription-draft",
        "production_status": "Awaiting Assembly",
        "payment_status": "Pending",
        "channel": "direct",
        "channel_label": "Subscription",
        "subscription_id": sub.get("id"),
        "created_by": "subscription-scheduler",
        "admin_notes": (
            f"Auto-created on {today_uk} by the monthly subscription scheduler "
            f"for {sub.get('customer_label')}."
        ),
        "updated_at": now_iso,
    }
    await db.woo_orders.insert_one(doc)
    return oid


async def run_monthly_drafts(db, *, force: bool = False) -> dict:
    """Idempotently ensure each active subscription has a draft for the
    *current* UK month. Safe to call repeatedly — second call within the
    same month is a no-op per subscription.
    """
    month_str = _current_month_str()
    created = 0
    skipped = 0
    errors: list[str] = []
    async for sub in db.order_subscriptions.find({"active": True}):
        try:
            if not force and sub.get("last_draft_month") == month_str:
                skipped += 1
                continue
            oid = await _create_draft_for_subscription(db, sub)
            await db.order_subscriptions.update_one(
                {"id": sub["id"]},
                {"$set": {
                    "last_draft_month": month_str,
                    "last_draft_id": oid,
                    "last_run_at": datetime.now(timezone.utc).isoformat(),
                }},
            )
            created += 1
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{sub.get('customer_label')}: {exc}")
            logger.exception("Subscription draft creation failed for %s", sub.get("customer_label"))
    return {"month": month_str, "created": created, "skipped": skipped, "errors": errors}


async def schedule_subscriptions_loop(db, *, every_seconds: int = 3600):
    """Background loop. Every hour, if it's on or after the 1st of the month
    at 08:00 Europe/London and a subscription hasn't yet been processed for
    the current month, create its draft. Robust to server downtime: a sub
    that missed its 08:00 window gets caught up on the next hourly tick.
    """
    await asyncio.sleep(120)  # give the rest of startup a moment to settle
    while True:
        try:
            now_uk = datetime.now(UK_TZ)
            # Window: from the 1st 08:00 onwards until the end of the month.
            ready = (now_uk.day > 1) or (now_uk.day == 1 and now_uk.hour >= 8)
            if ready:
                result = await run_monthly_drafts(db)
                if result["created"]:
                    logger.info(
                        "Subscriptions: created %d monthly drafts (month=%s, skipped=%d)",
                        result["created"], result["month"], result["skipped"],
                    )
        except Exception as exc:  # noqa: BLE001
            logger.warning("Subscriptions scheduler tick failed: %s", exc)
        await asyncio.sleep(every_seconds)


# ---------------------------------------------------------------- HTTP API
def attach(api, db, require_role):

    @api.get("/orders/subscriptions/customers")
    async def list_customers(
        q: str = Query("", description="Free-text search on customer name"),
        page: int = Query(1, ge=1),
        page_size: int = Query(50, ge=1, le=200),
        _: dict = Depends(require_role("admin")),
    ):
        """Paginated list of distinct customers seen in ``woo_orders``,
        joined with their subscription state. Sorted by most recent order
        first so the busiest customers float to the top.
        """
        match: dict = {"customer_label": {"$nin": [None, ""]}}
        if q.strip():
            rx = {"$regex": re.escape(q.strip()), "$options": "i"}
            match["customer_label"] = {"$regex": re.escape(q.strip()), "$options": "i"}
            _ = rx  # silence linter — we keep the explicit form for clarity
        skip = (page - 1) * page_size
        pipeline = [
            {"$match": match},
            {"$group": {
                "_id": {"$toLower": {"$trim": {"input": "$customer_label"}}},
                "customer_label": {"$first": "$customer_label"},
                "order_count": {"$sum": 1},
                "last_order_date": {"$max": "$date_created"},
                "channels": {"$addToSet": "$channel"},
                "customer_email": {"$first": "$customer_email"},
            }},
            {"$sort": {"last_order_date": -1, "customer_label": 1}},
            {"$facet": {
                "items": [{"$skip": skip}, {"$limit": page_size}],
                "meta": [{"$count": "total"}],
            }},
        ]
        agg = await db.woo_orders.aggregate(pipeline).to_list(1)
        bucket = agg[0] if agg else {"items": [], "meta": []}
        items = bucket.get("items") or []
        total = (bucket.get("meta") or [{"total": 0}])[0].get("total", 0)

        # Join with subscription state.
        keys = [it["_id"] for it in items]
        subs = {}
        async for s in db.order_subscriptions.find(
            {"customer_key": {"$in": keys}},
            {"_id": 0, "id": 1, "customer_key": 1, "active": 1, "last_draft_month": 1},
        ):
            subs[s["customer_key"]] = s

        rows = []
        for it in items:
            key = it["_id"]
            s = subs.get(key)
            rows.append({
                "customer_key": key,
                "customer_label": it.get("customer_label"),
                "customer_email": it.get("customer_email"),
                "order_count": it.get("order_count", 0),
                "last_order_date": it.get("last_order_date"),
                "channels": [c for c in (it.get("channels") or []) if c],
                "subscription_id": s.get("id") if s else None,
                "subscription_active": bool(s and s.get("active")),
                "last_draft_month": s.get("last_draft_month") if s else None,
            })
        return {
            "items": rows,
            "total": total,
            "page": page,
            "page_size": page_size,
            "has_more": skip + len(rows) < total,
        }

    @api.post("/orders/subscriptions")
    async def create_subscription(
        body: dict,
        user: dict = Depends(require_role("admin")),
    ):
        """Add a monthly-subscription flag to a customer. Idempotent — if
        the customer is already subscribed we reactivate the existing row
        rather than creating a duplicate.
        """
        label = (body or {}).get("customer_label") or ""
        label = str(label).strip()
        if not label:
            raise HTTPException(400, "customer_label is required")
        key = _normalise_key(label)
        if not key:
            raise HTTPException(400, "customer_label cannot be empty")
        existing = await db.order_subscriptions.find_one({"customer_key": key}, {"_id": 0})
        now_iso = datetime.now(timezone.utc).isoformat()
        if existing:
            await db.order_subscriptions.update_one(
                {"id": existing["id"]},
                {"$set": {
                    "active": True,
                    "customer_label": label,
                    "updated_at": now_iso,
                    "updated_by": user.get("email"),
                }},
            )
            existing.update({"active": True, "customer_label": label})
            return {"ok": True, "subscription": existing, "reactivated": True}
        doc = {
            "id": f"sub-{uuid.uuid4().hex[:10]}",
            "customer_key": key,
            "customer_label": label,
            "customer_email": (body or {}).get("customer_email"),
            "active": True,
            "created_at": now_iso,
            "created_by": user.get("email"),
            "updated_at": now_iso,
            "last_draft_month": None,
            "last_draft_id": None,
        }
        await db.order_subscriptions.insert_one(doc)
        return {"ok": True, "subscription": {k: v for k, v in doc.items() if k != "_id"}}

    @api.delete("/orders/subscriptions/{sub_id}")
    async def delete_subscription(
        sub_id: str,
        user: dict = Depends(require_role("admin")),
    ):
        """Deactivate a subscription. We soft-delete (active=False) rather
        than hard-delete so the audit trail and last_draft_month survive
        in case the admin re-enables it later in the same month.
        """
        r = await db.order_subscriptions.update_one(
            {"id": sub_id},
            {"$set": {
                "active": False,
                "updated_at": datetime.now(timezone.utc).isoformat(),
                "updated_by": user.get("email"),
            }},
        )
        if not r.matched_count:
            raise HTTPException(404, "Subscription not found")
        return {"ok": True}

    @api.get("/orders/subscriptions")
    async def list_subscriptions(
        _: dict = Depends(require_role("admin")),
    ):
        """List all subscriptions (active + dormant). Handy for an admin
        overview / future settings page."""
        items = await db.order_subscriptions.find({}, {"_id": 0}).sort("customer_label", 1).to_list(500)
        return {"items": items, "total": len(items)}

    @api.post("/admin/subscriptions/run-now")
    async def run_now(
        user: dict = Depends(require_role("admin")),
    ):
        """Manual trigger for the monthly job. Honours idempotency — only
        creates drafts for subscriptions whose ``last_draft_month`` doesn't
        match the current UK month."""
        result = await run_monthly_drafts(db)
        logger.info("Subscriptions manual run by %s: %s", user.get("email"), result)
        return {"ok": True, **result}
