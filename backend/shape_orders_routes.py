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

from fastapi import Body, Depends, HTTPException

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
        # Two kinds: ``shape_set`` (free, ships as pairs) and
        # ``signage_clothing`` (priced, no pair rule, no qty cap).
        kind = (body.get("product_kind") or "shape_set").strip().lower()
        if kind not in {"shape_set", "signage_clothing"}:
            raise HTTPException(400, detail="product_kind must be 'shape_set' or 'signage_clothing'")

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
            "product_kind": kind,
            "active": True,
            "sort_order": next_sort,
            "created_at": _now_iso(),
            "updated_at": _now_iso(),
        }
        await db.shape_order_products.insert_one(doc)
        doc.pop("_id", None)
        return doc

    @api.post("/admin/shape-orders/products/apply-default-personalisation")
    async def admin_apply_default_personalisation(
        body: dict | None = Body(None),
        _: dict = Depends(require_role("admin")),
    ):
        """One-shot helper that fills personalisation defaults for any
        signage / clothing row whose name matches a well-known pattern.
        Idempotent — skips rows that already have personalisation
        configured unless ``body.overwrite`` is true.

        Matches (case-insensitive, substring on ``name``):
          • "T-Shirt"      → size dropdown (S/M/L/XL/XXL) + colour
          • "Apron"        → colour
          • "(Personalised)" — anything else                → text input
        """
        overwrite = bool((body or {}).get("overwrite"))

        chart_url = "https://customer-assets.emergentagent.com/job_licensee-vault/artifacts/2mzmnq4q_image.png"
        default_colours = [
            "Black", "Dark Grey", "Steel", "Silver", "White", "Sage", "Bottle",
            "Apple", "Emerald", "Teal", "Aqua", "Olive", "Sapphire", "Mid Blue",
            "Oasis", "Lime", "Lemon", "Sunflower", "Chestnut", "Terracotta",
            "Orange", "Strawberry Red", "Hot Pink", "Aubergine", "Rich Violet",
            "Purple", "Turquoise", "Light Blue", "Natural", "Khaki", "Mocha",
            "Brown", "Red", "Burgundy", "Fuchsia", "Pink", "Lilac", "Navy",
            "Marine Blue", "Royal",
        ]

        applied: list[dict] = []
        skipped: list[dict] = []
        async for p in db.shape_order_products.find(
            {"product_kind": "signage_clothing"},
            {"_id": 0, "woo_id": 1, "name": 1, "personalisation": 1},
        ):
            name = (p.get("name") or "").lower()
            existing = p.get("personalisation") or {}
            has_any = bool(
                existing.get("text_input", {}).get("enabled")
                or existing.get("size", {}).get("enabled")
                or existing.get("colour", {}).get("enabled")
            )
            if has_any and not overwrite:
                skipped.append({"woo_id": p["woo_id"], "name": p.get("name"), "reason": "already configured"})
                continue

            pers: dict = {}
            if "t-shirt" in name or "tshirt" in name or "t shirt" in name:
                pers = {
                    "size": {"enabled": True, "options": ["S", "M", "L", "XL", "XXL"]},
                    "colour": {"enabled": True, "options": default_colours, "chart_image_url": chart_url},
                }
            elif "apron" in name:
                pers = {
                    "colour": {"enabled": True, "options": default_colours, "chart_image_url": chart_url},
                }
            elif "(personalised)" in name and "non personalised" not in name and "(non personalised)" not in name:
                pers = {
                    "text_input": {"enabled": True, "label": "Your franchise name / phone", "max_length": 120},
                }
            else:
                skipped.append({"woo_id": p["woo_id"], "name": p.get("name"), "reason": "no rule matched"})
                continue

            await db.shape_order_products.update_one(
                {"woo_id": p["woo_id"]},
                {"$set": {"personalisation": pers, "updated_at": _now_iso()}},
            )
            applied.append({
                "woo_id": p["woo_id"],
                "name": p.get("name"),
                "fields": [k for k in pers if pers[k].get("enabled")],
            })
        return {"ok": True, "applied": applied, "skipped": skipped}

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
        if "product_kind" in body:
            kind = (body["product_kind"] or "").strip().lower()
            if kind not in {"shape_set", "signage_clothing"}:
                raise HTTPException(400, detail="product_kind must be 'shape_set' or 'signage_clothing'")
            update["product_kind"] = kind
        if "personalisation" in body:
            # Personalisation options structure (every field optional):
            #   text_input: {enabled, label, max_length}
            #   size:       {enabled, options: ["S","M","L"]}
            #   colour:     {enabled, options: [...names], chart_image_url}
            pers = body.get("personalisation") or {}
            if not isinstance(pers, dict):
                raise HTTPException(400, detail="personalisation must be an object")
            update["personalisation"] = pers
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
        """Bulk-refresh image AND price for every curated catalogue
        product directly from Woo. Click this after editing prices on
        the Woo store to push the new numbers into the franchisee
        Franchise Store. Idempotent; safe to run anytime."""
        from woocommerce_integration import _woo_get  # noqa: E402
        updated = 0
        prices_changed = 0
        errors: list[str] = []
        async for p in db.shape_order_products.find({}, {"_id": 0, "woo_id": 1, "name": 1, "price": 1}):
            try:
                raw = await _woo_get(f"/products/{p['woo_id']}")
                image = (raw.get("images") or [{}])[0].get("src") if raw.get("images") else None
                price = raw.get("price")
                cat_update: dict = {"updated_at": _now_iso()}
                if image:
                    cat_update["image_url"] = image
                if price not in (None, ""):
                    cat_update["price"] = price
                    if str(p.get("price")) != str(price):
                        prices_changed += 1
                await db.shape_order_products.update_one(
                    {"woo_id": p["woo_id"]},
                    {"$set": cat_update},
                )
                woo_update = {"price": price} if price not in (None, "") else {}
                if image:
                    woo_update["image_url"] = image
                    woo_update["images"] = raw.get("images") or []
                if woo_update:
                    await db.woo_products.update_one(
                        {"woo_id": p["woo_id"]},
                        {"$set": woo_update},
                    )
                    updated += 1
            except Exception as exc:  # noqa: BLE001
                errors.append(f"{p.get('name')}: {exc}")
        return {"ok": True, "updated": updated, "prices_changed": prices_changed, "errors": errors}

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

    @api.post("/admin/shape-orders/fix-statuses")
    async def admin_fix_statuses(_: dict = Depends(require_role("admin"))):
        """One-shot repair for shape orders that were created before
        2026-06-03 with ``status="processing"`` instead of ``"active"``.
        Without this fix those orders only show up under the
        FRANCHISEE tab on the Orders page — never under ACTIVE.
        Safe to run multiple times: only updates docs that need it.
        """
        r = await db.woo_orders.update_many(
            {"order_kind": "shape_order",
             "status": {"$nin": ["active", "completed"]}},
            {"$set": {"status": "active", "is_draft": False}},
        )
        return {"ok": True, "updated": r.modified_count, "matched": r.matched_count}

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
        # Enrich price + image from the Woo mirror at list time so the
        # Signage & Clothing cards stay accurate after Woo price edits
        # without HQ having to re-add each product.
        rows: list[dict] = []
        async for p in db.shape_order_products.find(
            {"active": True}, {"_id": 0},
        ).sort("sort_order", 1):
            rows.append(p)
        if rows:
            woo_ids = [r["woo_id"] for r in rows]
            mirror: dict[int, dict] = {}
            async for w in db.woo_products.find(
                {"woo_id": {"$in": woo_ids}},
                {"_id": 0, "woo_id": 1, "price": 1, "image_url": 1, "images": 1},
            ):
                mirror[w["woo_id"]] = w
            for r in rows:
                live = mirror.get(r["woo_id"]) or {}
                if live.get("price") not in (None, ""):
                    r["price"] = live["price"]
                if not r.get("image_url") and live.get("images"):
                    src = (live["images"][0] or {}).get("src")
                    if src:
                        r["image_url"] = src
                # Default kind for any legacy rows that pre-date the new
                # field — they're shape sets.
                r.setdefault("product_kind", "shape_set")
        return {"items": rows, "total": len(rows)}

    @api.post("/portal/shape-orders")
    async def portal_submit(body: dict, user: dict = Depends(require_role("franchisee"))):
        fr = await _check_access(db, user)

        # Two payload shapes are accepted:
        #   • legacy:  {"woo_ids": [int, …]}             — all shape sets
        #   • current: {"shape_set_woo_ids": [...],
        #               "extra_items": [{"woo_id":int, "quantity":int}, ...]}
        # Either side may be empty so long as at least one item ends up
        # in the order overall.
        legacy_ids = body.get("woo_ids") or []
        shape_ids_in = body.get("shape_set_woo_ids") or legacy_ids or []
        extras_in = body.get("extra_items") or []

        try:
            shape_ids = [int(x) for x in shape_ids_in]
        except (TypeError, ValueError):
            raise HTTPException(400, detail="Invalid shape set selection.") from None

        # Validate extras (signage & clothing — quantities allowed).
        extras: list[dict] = []
        for item in extras_in:
            try:
                wid = int(item.get("woo_id"))
                qty = int(item.get("quantity") or 1)
            except (TypeError, ValueError):
                raise HTTPException(400, detail="Invalid extras item.") from None
            if qty < 1:
                continue
            if qty > 999:
                raise HTTPException(400, detail="Quantity 999 is the absolute cap per line.")
            options = item.get("options") or {}
            if not isinstance(options, dict):
                options = {}
            # Trim text, drop empties — keeps line_items tidy.
            cleaned_options: dict = {}
            for k in ("text", "size", "colour"):
                v = options.get(k)
                if isinstance(v, str) and v.strip():
                    cleaned_options[k] = v.strip()[:300]
            extras.append({"woo_id": wid, "quantity": qty, "options": cleaned_options})

        if not shape_ids and not extras:
            raise HTTPException(400, detail="Pick at least one item.")

        # Shape-set rules: no duplicates + ship as pairs.
        if shape_ids:
            if len(shape_ids) != len(set(shape_ids)):
                raise HTTPException(
                    400,
                    detail="No duplicate shape sets allowed — each set can only appear once per order.",
                )
            if len(shape_ids) % 2 != 0:
                raise HTTPException(
                    400,
                    detail="Each box ships two different sets, so your shape selection must be an even number (2, 4, 6…).",
                )

        # Resolve everything against the curated catalogue (one query).
        all_ids = list({*shape_ids, *(e["woo_id"] for e in extras)})
        curated: dict[int, dict] = {}
        async for p in db.shape_order_products.find(
            {"woo_id": {"$in": all_ids}, "active": True}, {"_id": 0},
        ):
            curated[p["woo_id"]] = p
        missing = [w for w in all_ids if w not in curated]
        if missing:
            raise HTTPException(400, detail=f"Some chosen items aren't available right now: {missing}.")

        # Kind safety: shape_ids must be shape_set, extras must be signage_clothing.
        for sid in shape_ids:
            if (curated[sid].get("product_kind") or "shape_set") != "shape_set":
                raise HTTPException(
                    400,
                    detail=f"{curated[sid].get('name') or sid} isn't a shape set — add it via Signage & Clothing.",
                )
        for ex in extras:
            kind = curated[ex["woo_id"]].get("product_kind") or "shape_set"
            if kind != "signage_clothing":
                raise HTTPException(
                    400,
                    detail=f"{curated[ex['woo_id']].get('name') or ex['woo_id']} isn't a signage / clothing product.",
                )

        # Live-price the extras from the Woo mirror to make sure the
        # franchisee can't talk us into the wrong price.
        woo_prices: dict[int, float] = {}
        if extras:
            extra_ids = [e["woo_id"] for e in extras]
            async for w in db.woo_products.find(
                {"woo_id": {"$in": extra_ids}}, {"_id": 0, "woo_id": 1, "price": 1},
            ):
                try:
                    woo_prices[w["woo_id"]] = float(w.get("price") or 0)
                except (TypeError, ValueError):
                    woo_prices[w["woo_id"]] = 0.0

        # Build the order doc. Mimic the manual "Direct" order shape
        # so the existing OrdersPage + OrderDetailPage render it
        # without changes.
        oid = str(uuid.uuid4())
        top = await db.woo_orders.find_one(
            {"display_order_id": {"$ne": None}},
            sort=[("display_order_id", -1)],
            projection={"_id": 0, "display_order_id": 1},
        )
        next_display = int((top or {}).get("display_order_id") or 8066) + 1

        line_items: list[dict] = []
        order_total = 0.0
        for sid in shape_ids:
            c = curated[sid]
            line_items.append({
                "product_id": c["woo_id"],
                "sku": c.get("sku"),
                "name": c.get("name"),
                "quantity": 1,
                "price": 0.0,
                "total": 0.0,
                "image_url": c.get("image_url"),
                "product_kind": "shape_set",
            })
        for ex in extras:
            c = curated[ex["woo_id"]]
            unit = woo_prices.get(ex["woo_id"], 0.0)
            line_total = round(unit * ex["quantity"], 2)
            order_total += line_total
            # Validate that each required personalisation field is filled.
            pers = c.get("personalisation") or {}
            opts = ex.get("options") or {}
            for field in ("text_input", "size", "colour"):
                cfg = pers.get(field) or {}
                if cfg.get("enabled"):
                    # text_input -> "text", size -> "size", colour -> "colour"
                    key = "text" if field == "text_input" else field
                    if not opts.get(key):
                        label = c.get("name") or ex["woo_id"]
                        nice = {"text_input": "personalisation text", "size": "size", "colour": "colour"}[field]
                        raise HTTPException(400, detail=f"Please pick a {nice} for {label}.")
            line_items.append({
                "product_id": c["woo_id"],
                "sku": c.get("sku"),
                "name": c.get("name"),
                "quantity": ex["quantity"],
                "price": unit,
                "total": line_total,
                "image_url": c.get("image_url"),
                "product_kind": "signage_clothing",
                "options": opts,
            })
        order_total = round(order_total, 2)

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
            "total": order_total,
            "currency": "GBP",
            "status": "active",
            "is_draft": False,
            "payment_status": "Pending",
            "production_status": "Awaiting Assembly",
            "channel_label": "Franchise Store",
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
            "boxes": len(shape_ids) // 2,
            "total": order_total,
        }


async def heal_legacy_shape_statuses(db) -> dict:
    """Idempotent migration — flips any shape order with a non-active/
    non-completed status to ``"active"`` so it appears in the Orders >
    ACTIVE tab. Safe to run on every backend startup; only writes when
    there's drift to repair.
    """
    r = await db.woo_orders.update_many(
        {"order_kind": "shape_order",
         "status": {"$nin": ["active", "completed"]}},
        {"$set": {"status": "active", "is_draft": False}},
    )
    if r.modified_count:
        logger.info(
            "shape_orders.heal_legacy_shape_statuses: repaired %s legacy doc(s)",
            r.modified_count,
        )
    return {"matched": r.matched_count, "updated": r.modified_count}
