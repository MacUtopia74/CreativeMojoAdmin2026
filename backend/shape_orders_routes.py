"""Shape Orders — Phase 4 franchisee portal feature.

Lets a logged-in franchisee build a simple multi-pair selection of
Die-Cut Shape sets and submit it to HQ. The submission creates a
record in ``woo_orders`` (so it lives alongside Woo + manual orders
in the admin Orders page) with ``order_kind="shape_order"`` so the UI
can tag it distinctly.

Admin curation
==============
Admin operators decide which products are exposed on the portal via
``shape_order_products``. The Woo product mirror (``woo_products``)
is the source of truth for product metadata — we cache name / image /
sku at "add" time so the portal grid doesn't have to round-trip Woo
on every load.

Endpoints
=========
**Admin**
  * ``GET    /api/admin/shape-orders/products``     — curated list
  * ``POST   /api/admin/shape-orders/products``     — add (by woo_id)
  * ``PATCH  /api/admin/shape-orders/products/{woo_id}`` — toggle/reorder
  * ``DELETE /api/admin/shape-orders/products/{woo_id}`` — remove
  * ``GET    /api/admin/shape-orders/woo-products`` — search woo mirror

**Franchisee**
  * ``GET  /api/portal/shape-orders/products``      — what they can order
  * ``GET  /api/portal/shape-orders/access``        — gate flag
  * ``POST /api/portal/shape-orders``               — submit selection
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import Depends, HTTPException

logger = logging.getLogger("creative-mojo-admin.shape_orders")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


async def _check_access(db, user: dict) -> dict:
    fid = (user or {}).get("franchisee_id")
    if not fid:
        raise HTTPException(403, detail="Franchisee account required")
    fr = await db.franchisees.find_one(
        {"id": fid},
        {"_id": 0, "id": 1, "first_name": 1, "last_name": 1, "organisation": 1,
         "mojo_email": 1, "email": 1, "phone": 1, "postcode": 1, "address_line_1": 1,
         "address_line_2": 1, "city": 1, "tags": 1, "portal_modules": 1},
    )
    if not fr:
        raise HTTPException(404, detail="Franchisee not found")
    mods = (fr.get("portal_modules") or {})
    is_demo = any(str(t).strip().lower() == "demo" for t in (fr.get("tags") or []))
    if is_demo or mods.get("shape_orders"):
        return fr
    raise HTTPException(403, detail="Shape Orders is not enabled on your account.")


def attach(api, db, require_role):

    # ----------------------------------------------------------------
    # Admin curation endpoints
    # ----------------------------------------------------------------
    @api.get("/admin/shape-orders/products")
    async def admin_list_products(_: dict = Depends(require_role("admin"))):
        items: list[dict] = []
        async for p in db.shape_order_products.find({}, {"_id": 0}).sort("sort_order", 1):
            items.append(p)
        return {"items": items, "total": len(items)}

    @api.get("/admin/shape-orders/woo-products")
    async def admin_search_woo_products(
        q: str = "",
        _: dict = Depends(require_role("admin")),
    ):
        """Search the Woo product mirror so the admin can pick a
        product by name. Limited to 50 hits to keep the picker zippy."""
        needle = (q or "").strip()
        if not needle:
            return {"items": [], "total": 0}
        regex = {"$regex": needle, "$options": "i"}
        cursor = db.woo_products.find(
            {"$or": [{"name": regex}, {"sku": regex}]},
            {"_id": 0, "woo_id": 1, "name": 1, "sku": 1, "image_url": 1,
             "images": 1, "price": 1, "permalink": 1, "status": 1},
        ).limit(50)
        items = []
        async for p in cursor:
            items.append(p)
        return {"items": items, "total": len(items)}

    @api.post("/admin/shape-orders/products")
    async def admin_add_product(body: dict, _: dict = Depends(require_role("admin"))):
        woo_id = body.get("woo_id")
        if not woo_id:
            raise HTTPException(400, detail="woo_id is required")
        try:
            woo_id = int(woo_id)
        except (TypeError, ValueError):
            raise HTTPException(400, detail="woo_id must be an integer") from None

        existing = await db.shape_order_products.find_one({"woo_id": woo_id})
        if existing:
            raise HTTPException(409, detail="That product is already on the list.")
        woo_prod = await db.woo_products.find_one(
            {"woo_id": woo_id},
            {"_id": 0, "woo_id": 1, "name": 1, "sku": 1, "image_url": 1,
             "images": 1, "price": 1, "permalink": 1},
        )
        if not woo_prod:
            raise HTTPException(404, detail="No Woo product with that id in the mirror.")
        image = (woo_prod.get("image_url")
                 or ((woo_prod.get("images") or [{}])[0].get("src") if woo_prod.get("images") else ""))
        # If the mirror was synced before image_url was a tracked field
        # (most existing rows in production), fetch it live now so the
        # catalogue card never lands without a photo.
        if not image:
            try:
                from woocommerce_integration import _woo_get  # noqa: E402
                raw = await _woo_get(f"/products/{woo_id}")
                image = (raw.get("images") or [{}])[0].get("src") if raw.get("images") else ""
                if image:
                    await db.woo_products.update_one(
                        {"woo_id": woo_id},
                        {"$set": {"image_url": image, "images": raw.get("images") or []}},
                    )
            except Exception:  # noqa: BLE001
                pass
        # Sort to the bottom by default.
        last = await db.shape_order_products.find_one(
            {}, {"_id": 0, "sort_order": 1}, sort=[("sort_order", -1)],
        )
        next_sort = (last.get("sort_order") if last else 0) + 1
        doc = {
            "id": str(uuid.uuid4()),
            "woo_id": woo_id,
            "sku": woo_prod.get("sku"),
            "name": woo_prod.get("name"),
            "image_url": image,
            "permalink": woo_prod.get("permalink"),
            "price": woo_prod.get("price"),
            "active": True,
            "sort_order": next_sort,
            "created_at": _now_iso(),
            "updated_at": _now_iso(),
        }
        await db.shape_order_products.insert_one(doc)
        doc.pop("_id", None)
        return doc

    @api.patch("/admin/shape-orders/products/{woo_id}")
    async def admin_patch_product(woo_id: int, body: dict, _: dict = Depends(require_role("admin"))):
        update: dict = {}
        if "active" in body:
            update["active"] = bool(body["active"])
        if "sort_order" in body:
            try:
                update["sort_order"] = int(body["sort_order"])
            except (TypeError, ValueError):
                raise HTTPException(400, detail="sort_order must be an integer") from None
        if "name" in body and isinstance(body["name"], str):
            update["name"] = body["name"].strip()
        if not update:
            raise HTTPException(400, detail="Nothing to update.")
        update["updated_at"] = _now_iso()
        r = await db.shape_order_products.update_one({"woo_id": woo_id}, {"$set": update})
        if not r.matched_count:
            raise HTTPException(404, detail="Product not on the list.")
        doc = await db.shape_order_products.find_one({"woo_id": woo_id}, {"_id": 0})
        return doc

    @api.post("/admin/shape-orders/products/{woo_id}/refresh-image")
    async def admin_refresh_image(woo_id: int, _: dict = Depends(require_role("admin"))):
        """Pull the latest image for one product directly from Woo
        (bypasses the full product sync — handy when admin notices a
        catalogue card is missing an image)."""
        from woocommerce_integration import _woo_get  # noqa: E402
        try:
            raw = await _woo_get(f"/products/{woo_id}")
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(502, detail=f"Couldn't reach Woo: {exc}") from exc
        image = (raw.get("images") or [{}])[0].get("src") if raw.get("images") else None
        if not image:
            raise HTTPException(404, detail="Woo returned no image for that product.")
        # Refresh both the curated catalogue row and the woo_products
        # mirror so the next sync doesn't blow it away.
        await db.shape_order_products.update_one(
            {"woo_id": woo_id},
            {"$set": {"image_url": image, "updated_at": _now_iso()}},
        )
        await db.woo_products.update_one(
            {"woo_id": woo_id},
            {"$set": {"image_url": image, "images": raw.get("images") or []}},
        )
        return {"ok": True, "image_url": image}

    @api.post("/admin/shape-orders/products/refresh-all-images")
    async def admin_refresh_all_images(_: dict = Depends(require_role("admin"))):
        """Bulk-refresh images on every curated catalogue product. Used
        once after deploy to backfill the image_url for the existing
        rows in production."""
        from woocommerce_integration import _woo_get  # noqa: E402
        updated = 0
        errors: list[str] = []
        async for p in db.shape_order_products.find({}, {"_id": 0, "woo_id": 1, "name": 1}):
            try:
                raw = await _woo_get(f"/products/{p['woo_id']}")
                image = (raw.get("images") or [{}])[0].get("src") if raw.get("images") else None
                if image:
                    await db.shape_order_products.update_one(
                        {"woo_id": p["woo_id"]},
                        {"$set": {"image_url": image, "updated_at": _now_iso()}},
                    )
                    await db.woo_products.update_one(
                        {"woo_id": p["woo_id"]},
                        {"$set": {"image_url": image, "images": raw.get("images") or []}},
                    )
                    updated += 1
            except Exception as exc:  # noqa: BLE001
                errors.append(f"{p.get('name')}: {exc}")
        return {"ok": True, "updated": updated, "errors": errors}

    @api.delete("/admin/shape-orders/products/{woo_id}")
    async def admin_delete_product(woo_id: int, _: dict = Depends(require_role("admin"))):
        r = await db.shape_order_products.delete_one({"woo_id": woo_id})
        if not r.deleted_count:
            raise HTTPException(404, detail="Product not on the list.")
        return {"ok": True}

    @api.post("/admin/shape-orders/products/reorder")
    async def admin_reorder(body: dict, _: dict = Depends(require_role("admin"))):
        """Bulk reorder — body: ``{order: [woo_id, woo_id, …]}``."""
        order = body.get("order") or []
        if not isinstance(order, list):
            raise HTTPException(400, detail="order must be a list")
        for idx, woo_id in enumerate(order, start=1):
            try:
                wid = int(woo_id)
            except (TypeError, ValueError):
                continue
            await db.shape_order_products.update_one(
                {"woo_id": wid},
                {"$set": {"sort_order": idx, "updated_at": _now_iso()}},
            )
        return {"ok": True}

    # ----------------------------------------------------------------
    # Franchisee endpoints
    # ----------------------------------------------------------------
    @api.get("/portal/shape-orders/access")
    async def portal_access(user: dict = Depends(require_role("franchisee"))):
        try:
            fr = await _check_access(db, user)
        except HTTPException as e:
            return {"allowed": False, "reason": e.detail}
        return {
            "allowed": True,
            "franchisee_name": f"{fr.get('first_name','')} {fr.get('last_name','')}".strip()
                               or fr.get("organisation") or "Creative Mojo",
            "organisation": fr.get("organisation") or "",
        }

    @api.get("/portal/shape-orders/products")
    async def portal_list_products(user: dict = Depends(require_role("franchisee"))):
        await _check_access(db, user)
        items: list[dict] = []
        async for p in db.shape_order_products.find(
            {"active": True}, {"_id": 0},
        ).sort("sort_order", 1):
            items.append(p)
        return {"items": items, "total": len(items)}

    @api.post("/portal/shape-orders")
    async def portal_submit(body: dict, user: dict = Depends(require_role("franchisee"))):
        fr = await _check_access(db, user)
        selection_in = body.get("woo_ids") or []
        if not isinstance(selection_in, list) or not selection_in:
            raise HTTPException(400, detail="Pick at least one shape set.")
        # Strict-pairs rule — each shipping box holds exactly two
        # DIFFERENT sets, no duplicates allowed.
        try:
            woo_ids = [int(x) for x in selection_in]
        except (TypeError, ValueError):
            raise HTTPException(400, detail="Invalid selection.") from None
        if len(woo_ids) != len(set(woo_ids)):
            raise HTTPException(
                400,
                detail="No duplicates allowed — each set can only appear once per order.",
            )
        if len(woo_ids) % 2 != 0:
            raise HTTPException(
                400,
                detail="Each box ships two different sets, so your selection must be an even number (2, 4, 6…).",
            )

        # Resolve via curated list so franchisees can't order anything
        # we haven't approved for the portal.
        curated: dict[int, dict] = {}
        async for p in db.shape_order_products.find(
            {"woo_id": {"$in": woo_ids}, "active": True}, {"_id": 0},
        ):
            curated[p["woo_id"]] = p
        missing = [w for w in woo_ids if w not in curated]
        if missing:
            raise HTTPException(400, detail=f"Some chosen sets aren't available right now: {missing}.")

        # Build the order doc. Mimic the manual "Direct" order shape
        # so the existing OrdersPage + OrderDetailPage render it
        # without changes.
        oid = str(uuid.uuid4())
        # ``_next_display_order_id`` from woo integration lives inside its
        # router attach closure, so we replicate the same logic here.
        top = await db.woo_orders.find_one(
            {"display_order_id": {"$ne": None}},
            sort=[("display_order_id", -1)],
            projection={"_id": 0, "display_order_id": 1},
        )
        next_display = int((top or {}).get("display_order_id") or 8066) + 1

        line_items = [{
            "product_id": curated[w]["woo_id"],
            "sku": curated[w].get("sku"),
            "name": curated[w].get("name"),
            "quantity": 1,
            "price": 0.0,
            "total": 0.0,
            "image_url": curated[w].get("image_url"),
        } for w in woo_ids]
        org = fr.get("organisation") or ""
        full_name = f"{fr.get('first_name','')} {fr.get('last_name','')}".strip()
        customer_label = org or full_name or "Franchisee"
        billing = {
            "first_name": fr.get("first_name") or None,
            "last_name":  fr.get("last_name") or None,
            "company":    org or None,
            "email":      fr.get("mojo_email") or fr.get("email") or None,
            "phone":      fr.get("phone") or None,
            "address_1":  fr.get("address_line_1") or None,
            "address_2":  fr.get("address_line_2") or None,
            "city":       fr.get("city") or None,
            "postcode":   fr.get("postcode") or None,
            "country":    "United Kingdom",
        }
        billing = {k: v for k, v in billing.items() if v}
        now = _now_iso()
        doc = {
            "id": oid,
            "display_order_id": next_display,
            "woo_id": None,
            "woo_number": None,
            "order_kind": "shape_order",
            "franchisee_id": fr["id"],
            "customer_label": customer_label,
            "customer_email": fr.get("mojo_email") or fr.get("email"),
            "customer_phone": fr.get("phone"),
            "billing": billing,
            "shipping": dict(billing),
            "line_items": line_items,
            "line_items_unavailable": False,
            "shipping_total": 0.0,
            "total": 0.0,
            "currency": "GBP",
            "status": "processing",
            "payment_status": "Pending",
            "production_status": "Awaiting Assembly",
            "channel_label": "Shape Order",
            "channel_pill": "shape-order",
            "date_created": now,
            "due_date": (body.get("due_date") or None),
            "notes": (body.get("notes") or "").strip() or None,
            "created_via": "franchisee-portal",
            "created_by": user.get("email"),
            "invoiced": False,
            "events": [{"type": "created", "at": now, "by": user.get("email")}],
        }
        await db.woo_orders.insert_one(doc)
        doc.pop("_id", None)
        return {
            "ok": True,
            "order_id": oid,
            "display_order_id": next_display,
            "line_item_count": len(line_items),
            "boxes": len(line_items) // 2,
        }
