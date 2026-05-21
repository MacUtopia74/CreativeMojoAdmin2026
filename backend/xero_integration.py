"""Xero accounting integration — Stage C of the Phase 2 Orders module.

Wires our local woo_orders mirror into Xero so admins can issue draft sales
invoices straight from the admin UI, then have payment status flow back
automatically when the customer pays inside Xero.

What this module owns
=====================
* OAuth 2.0 authorization-code flow with Xero (PKCE-friendly even though we
  use a confidential client + secret). The org owner clicks "Connect Xero"
  on the admin settings page → we redirect to login.xero.com → callback
  exchanges the code for an access+refresh token set we persist in
  ``xero_tokens``.
* Automatic refresh — ``get_valid_token()`` refreshes silently whenever the
  stored access token is about to expire.
* Read endpoints — list the connected tenants and fetch contacts so the UI
  can show "matched in Xero" hints.
* Write endpoint — POST /api/xero/orders/{order_id}/create-invoice converts
  one of our local ``woo_orders`` rows into a DRAFT Xero invoice. We store
  the returned ``InvoiceID`` + status on the order so the UI can show a
  "View in Xero" link instead of the "Create invoice" button next time.
* Webhook receiver — POST /api/xero/webhook validates the HMAC signature
  exactly as documented (raw body, base64-of-SHA256, ``hmac.compare_digest``)
  and updates the matching order's ``payment_status`` when Xero tells us an
  invoice was paid.

Env vars (set in backend/.env)
==============================
    XERO_CLIENT_ID         (from developer.xero.com → My Apps → Configuration)
    XERO_CLIENT_SECRET     (same screen — generate one)
    XERO_REDIRECT_URI      (must match the URI registered in Xero exactly,
                            e.g. https://admin.creativemojo.co.uk/api/xero/callback)
    XERO_WEBHOOK_SIGNING_KEY (from Webhooks tab on the same page)
    XERO_SCOPES            (optional — defaults to the minimal set we need)

If creds are missing the routes still mount but every endpoint returns a
clear 400 telling the admin which env var to set, mirroring how the Woo
module behaves before its creds are wired in.
"""
from __future__ import annotations

import base64
import hmac
import json
import logging
import os
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any, Optional
from urllib.parse import urlencode, quote

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import HTMLResponse, RedirectResponse

logger = logging.getLogger("creative-mojo-admin.xero")

XERO_AUTH_URL = "https://login.xero.com/identity/connect/authorize"
XERO_TOKEN_URL = "https://identity.xero.com/connect/token"
XERO_CONNECTIONS_URL = "https://api.xero.com/connections"
XERO_API_BASE = "https://api.xero.com/api.xro/2.0"
DEFAULT_SCOPES = "openid profile email offline_access accounting.invoices accounting.contacts"

# Singleton key used in the xero_tokens collection — we only ever connect a
# single Creative Mojo Ltd. tenant, so one document is enough.
TOKEN_DOC_KEY = "primary"


def _env(name: str, default: Optional[str] = None) -> Optional[str]:
    val = os.environ.get(name)
    return val if val not in (None, "") else default


def _require_env(name: str) -> str:
    v = _env(name)
    if not v:
        raise HTTPException(
            400,
            f"Xero is not configured. Add {name} to backend/.env and restart the service.",
        )
    return v


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ---------------------------------------------------------------------------
# Token storage helpers
# ---------------------------------------------------------------------------
async def _store_token_set(db, payload: dict, tenant_id: Optional[str] = None) -> dict:
    """Persist a fresh OAuth token set to Mongo. We keep history-tracking
    flags so we can show ``connected_at`` and ``last_refreshed_at`` on the
    settings page."""
    now = _now()
    doc = {
        "_id": TOKEN_DOC_KEY,
        "access_token": payload["access_token"],
        "refresh_token": payload.get("refresh_token"),
        "expires_at": (now + timedelta(seconds=int(payload.get("expires_in", 1800)))).isoformat(),
        "id_token": payload.get("id_token"),
        "scope": payload.get("scope"),
        "token_type": payload.get("token_type", "Bearer"),
        "updated_at": now.isoformat(),
    }
    if tenant_id:
        doc["tenant_id"] = tenant_id
    existing = await db.xero_tokens.find_one({"_id": TOKEN_DOC_KEY}, {"_id": 0})
    if existing:
        # Preserve original connection metadata across refreshes.
        for k in ("connected_at", "connected_by", "tenant_id", "tenant_name"):
            if k in existing and k not in doc:
                doc[k] = existing[k]
    else:
        doc["connected_at"] = now.isoformat()
    await db.xero_tokens.replace_one({"_id": TOKEN_DOC_KEY}, doc, upsert=True)
    return doc


async def _load_token_doc(db) -> Optional[dict]:
    return await db.xero_tokens.find_one({"_id": TOKEN_DOC_KEY}, {"_id": 0})


async def _refresh_token(db, refresh_token: str) -> dict:
    """Swap a refresh token for a new access+refresh pair. Xero rotates
    refresh tokens so we always store the new one."""
    client_id = _require_env("XERO_CLIENT_ID")
    client_secret = _require_env("XERO_CLIENT_SECRET")
    async with httpx.AsyncClient(timeout=20) as client:
        r = await client.post(
            XERO_TOKEN_URL,
            data={"grant_type": "refresh_token", "refresh_token": refresh_token},
            auth=(client_id, client_secret),
            headers={"Accept": "application/json"},
        )
    if r.status_code != 200:
        logger.error("Xero token refresh failed (%s): %s", r.status_code, r.text[:300])
        raise HTTPException(401, "Xero token refresh failed — please reconnect from settings.")
    return await _store_token_set(db, r.json())


async def get_valid_token(db) -> tuple[str, str]:
    """Return ``(access_token, tenant_id)`` ready for an authenticated Xero
    call, refreshing transparently if the stored token has fewer than 60s
    of life left. Raises 400 if no token has ever been stored."""
    doc = await _load_token_doc(db)
    if not doc:
        raise HTTPException(400, "Xero not connected. Open Settings → Xero and click Connect.")
    try:
        expires_at = datetime.fromisoformat(doc["expires_at"])
    except Exception:
        expires_at = _now() - timedelta(seconds=1)
    if expires_at <= _now() + timedelta(seconds=60):
        if not doc.get("refresh_token"):
            raise HTTPException(401, "Xero session expired and no refresh token on file — please reconnect.")
        doc = await _refresh_token(db, doc["refresh_token"])
    tenant_id = doc.get("tenant_id")
    if not tenant_id:
        raise HTTPException(400, "Xero connection has no tenant — please reconnect.")
    return doc["access_token"], tenant_id


# ---------------------------------------------------------------------------
# Xero API helpers
# ---------------------------------------------------------------------------
async def _xero_get(db, path: str, params: Optional[dict] = None) -> Any:
    access_token, tenant_id = await get_valid_token(db)
    async with httpx.AsyncClient(timeout=20) as client:
        r = await client.get(
            f"{XERO_API_BASE}{path}",
            params=params or {},
            headers={
                "Authorization": f"Bearer {access_token}",
                "Xero-Tenant-Id": tenant_id,
                "Accept": "application/json",
            },
        )
    if r.status_code != 200:
        logger.warning("Xero GET %s failed (%s): %s", path, r.status_code, r.text[:300])
        raise HTTPException(r.status_code, f"Xero API error: {r.text[:300]}")
    return r.json()


async def _xero_post(db, path: str, json_body: dict) -> Any:
    access_token, tenant_id = await get_valid_token(db)
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.post(
            f"{XERO_API_BASE}{path}",
            json=json_body,
            headers={
                "Authorization": f"Bearer {access_token}",
                "Xero-Tenant-Id": tenant_id,
                "Accept": "application/json",
                "Content-Type": "application/json",
            },
        )
    if r.status_code not in (200, 201):
        logger.warning("Xero POST %s failed (%s): %s", path, r.status_code, r.text[:400])
        raise HTTPException(r.status_code, f"Xero API error: {r.text[:400]}")
    return r.json()


# ---------------------------------------------------------------------------
# Invoice builder — turns one of our woo_orders into a Xero Invoices payload
# ---------------------------------------------------------------------------
def _build_xero_invoice_payload(order: dict) -> dict:
    """Project a local order onto Xero's Invoices schema. Uses ``200`` as
    the default revenue account code — admins can edit afterwards in Xero
    if a different code is needed for a particular product line."""
    contact = {"Name": order.get("customer_label") or "Unknown customer"}
    email = order.get("customer_email") or (order.get("billing") or {}).get("email")
    if email:
        contact["EmailAddress"] = email

    line_items = []
    for li in order.get("line_items") or []:
        qty = float(li.get("quantity") or 1)
        try:
            unit_amount = float(li.get("subtotal") or 0) or (float(li.get("total") or 0) / qty if qty else 0)
        except (TypeError, ValueError):
            unit_amount = 0.0
        line_items.append({
            "Description": li.get("name") or li.get("sku") or "Item",
            "Quantity": qty,
            "UnitAmount": round(unit_amount, 2),
            "AccountCode": "200",
        })

    ship_total = float(order.get("shipping_total") or 0)
    if ship_total > 0:
        line_items.append({
            "Description": "Shipping",
            "Quantity": 1,
            "UnitAmount": round(ship_total, 2),
            "AccountCode": "200",
        })

    if not line_items:
        # Fallback — Xero requires at least one line item.
        line_items.append({
            "Description": f"Order {order.get('display_order_id') or order.get('id')}",
            "Quantity": 1,
            "UnitAmount": float(order.get("total") or 0),
            "AccountCode": "200",
        })

    invoice = {
        "Type": "ACCREC",  # Accounts Receivable — sales invoice
        "Contact": contact,
        "LineItems": line_items,
        "Status": "DRAFT",
        "Reference": f"Order #{order.get('display_order_id') or order.get('woo_number') or order.get('id')}",
    }
    if order.get("due_date"):
        try:
            invoice["DueDate"] = datetime.fromisoformat(order["due_date"].replace("Z", "+00:00")).date().isoformat()
        except Exception:
            pass
    return {"Invoices": [invoice]}


# ---------------------------------------------------------------------------
# Router wiring
# ---------------------------------------------------------------------------
def attach(api, db, require_role):
    """Mount /api/xero/* on the parent APIRouter."""

    @api.get("/xero/status")
    async def xero_status(_: dict = Depends(require_role("admin"))):
        """Tell the settings page whether we have a live connection.

        Never returns the tokens themselves — only metadata."""
        configured = bool(_env("XERO_CLIENT_ID") and _env("XERO_CLIENT_SECRET") and _env("XERO_REDIRECT_URI"))
        doc = await _load_token_doc(db)
        if not doc:
            return {
                "configured": configured,
                "connected": False,
                "redirect_uri": _env("XERO_REDIRECT_URI"),
            }
        return {
            "configured": configured,
            "connected": True,
            "tenant_id": doc.get("tenant_id"),
            "tenant_name": doc.get("tenant_name"),
            "connected_at": doc.get("connected_at"),
            "updated_at": doc.get("updated_at"),
            "expires_at": doc.get("expires_at"),
            "redirect_uri": _env("XERO_REDIRECT_URI"),
        }

    @api.get("/xero/connect")
    async def xero_connect(user: dict = Depends(require_role("admin"))):
        """Begin the OAuth flow. Generates a CSRF ``state`` we'll validate
        on the callback. Returns a JSON `{ url }` so the frontend can
        ``window.location.assign`` to it — easier than juggling cookies on
        a 302."""
        client_id = _require_env("XERO_CLIENT_ID")
        redirect_uri = _require_env("XERO_REDIRECT_URI")
        scopes = _env("XERO_SCOPES", DEFAULT_SCOPES)
        state = secrets.token_urlsafe(24)
        await db.xero_oauth_states.replace_one(
            {"_id": state},
            {"_id": state, "created_at": _now().isoformat(), "user": user.get("email")},
            upsert=True,
        )
        # House-keep — drop states older than 1 hour.
        cutoff = (_now() - timedelta(hours=1)).isoformat()
        await db.xero_oauth_states.delete_many({"created_at": {"$lt": cutoff}})
        url = f"{XERO_AUTH_URL}?" + urlencode({
            "response_type": "code",
            "client_id": client_id,
            "redirect_uri": redirect_uri,
            "scope": scopes,
            "state": state,
        }, quote_via=quote)
        return {"url": url}

    @api.get("/xero/callback")
    async def xero_callback(request: Request, code: Optional[str] = None, state: Optional[str] = None, error: Optional[str] = None):
        """OAuth callback — exchanges ``code`` for tokens, fetches the
        tenant id, then closes the window so the frontend tab notices the
        connection via its own polling."""
        if error:
            return HTMLResponse(f"<h1>Xero connection failed</h1><p>{error}</p>", status_code=400)
        if not code or not state:
            return HTMLResponse("<h1>Xero callback missing parameters</h1>", status_code=400)
        # Validate state
        st = await db.xero_oauth_states.find_one({"_id": state})
        if not st:
            return HTMLResponse("<h1>Invalid or expired state — please retry from Settings.</h1>", status_code=400)
        await db.xero_oauth_states.delete_one({"_id": state})

        client_id = _require_env("XERO_CLIENT_ID")
        client_secret = _require_env("XERO_CLIENT_SECRET")
        redirect_uri = _require_env("XERO_REDIRECT_URI")

        async with httpx.AsyncClient(timeout=20) as client:
            r = await client.post(
                XERO_TOKEN_URL,
                data={
                    "grant_type": "authorization_code",
                    "code": code,
                    "redirect_uri": redirect_uri,
                },
                auth=(client_id, client_secret),
                headers={"Accept": "application/json"},
            )
            if r.status_code != 200:
                logger.error("Xero token exchange failed (%s): %s", r.status_code, r.text[:400])
                return HTMLResponse(f"<h1>Token exchange failed</h1><pre>{r.text[:400]}</pre>", status_code=400)
            token_data = r.json()
            # Fetch tenant id
            r2 = await client.get(
                XERO_CONNECTIONS_URL,
                headers={
                    "Authorization": f"Bearer {token_data['access_token']}",
                    "Accept": "application/json",
                },
            )
            if r2.status_code != 200 or not r2.json():
                logger.error("Xero /connections failed (%s): %s", r2.status_code, r2.text[:400])
                return HTMLResponse("<h1>Could not load Xero tenants — please reconnect.</h1>", status_code=400)
            conns = r2.json()
            primary = conns[0]
            tenant_id = primary["tenantId"]
            tenant_name = primary.get("tenantName") or primary.get("tenantType")

        doc = await _store_token_set(db, token_data, tenant_id=tenant_id)
        doc["tenant_name"] = tenant_name
        doc["connected_by"] = st.get("user")
        await db.xero_tokens.update_one(
            {"_id": TOKEN_DOC_KEY},
            {"$set": {"tenant_name": tenant_name, "connected_by": st.get("user")}},
        )

        # Friendly success page — auto-closes the popup if opened via window.open
        html = """
        <html><head><title>Xero connected</title>
        <style>body{font-family:-apple-system,sans-serif;padding:48px;text-align:center;background:#f5f5f4;color:#1c1917}</style>
        </head><body>
        <h1 style='color:#059669'>✓ Xero connected</h1>
        <p>You can close this window and return to the admin.</p>
        <script>setTimeout(()=>{try{window.opener&&window.opener.postMessage({type:'xero-connected'},'*');}catch(e){};window.close();},800)</script>
        </body></html>
        """
        return HTMLResponse(html)

    @api.post("/xero/disconnect")
    async def xero_disconnect(_: dict = Depends(require_role("admin"))):
        await db.xero_tokens.delete_many({})
        return {"ok": True}

    @api.get("/xero/contacts")
    async def xero_contacts(
        search: Optional[str] = None,
        _: dict = Depends(require_role("admin")),
    ):
        """Used by the customer autocomplete + reconciliation picker. We
        ALSO cache every contact we see in ``xero_contacts_cache`` so
        further searches (and matching by email later) can hit Mongo
        instead of Xero — much faster, and avoids burning rate-limit."""
        params = {}
        if search and len(search) >= 2:
            # Escape any double-quote / backslash so the OData filter we
            # forward to Xero stays valid even if a user pastes a quoted
            # search term.
            safe = search.replace("\\", "").replace('"', "")
            safe_lower = safe.lower()
            # Try cache first — return immediately if we have any matches.
            q = {"$or": [
                {"name_lc": {"$regex": safe_lower}},
                {"email_lc": {"$regex": safe_lower}},
            ]}
            cached = await db.xero_contacts_cache.find(q, {"_id": 0}).limit(25).to_list(25)
            if cached:
                return {"contacts": [
                    {"contact_id": c["contact_id"], "name": c["name"], "email": c.get("email"), "status": c.get("status")}
                    for c in cached
                ], "from_cache": True}
            params["where"] = f'Name.ToLower().Contains("{safe_lower}") OR EmailAddress.ToLower().Contains("{safe_lower}")'
        data = await _xero_get(db, "/Contacts", params=params)
        contacts = [
            {
                "contact_id": c.get("ContactID"),
                "name": c.get("Name"),
                "email": c.get("EmailAddress"),
                "status": c.get("ContactStatus"),
            }
            for c in (data.get("Contacts") or [])
        ]
        # Upsert to cache for next time.
        if contacts:
            ops = []
            for c in contacts:
                ops.append({
                    "contact_id": c["contact_id"],
                    "name": c["name"] or "",
                    "name_lc": (c["name"] or "").lower(),
                    "email": c.get("email"),
                    "email_lc": (c.get("email") or "").lower(),
                    "status": c.get("status"),
                    "synced_at": _now().isoformat(),
                })
            for o in ops:
                await db.xero_contacts_cache.update_one(
                    {"contact_id": o["contact_id"]}, {"$set": o}, upsert=True
                )
        return {"contacts": contacts[:200]}

    @api.post("/xero/contacts/sync")
    async def sync_xero_contacts(_: dict = Depends(require_role("admin"))):
        """Pull every Xero contact into our cache. Used during reconcile
        so we can match orders → Xero contacts entirely offline."""
        access_token, tenant_id = await get_valid_token(db)
        page = 1
        total = 0
        async with httpx.AsyncClient(timeout=30) as client:
            while True:
                r = await client.get(
                    f"{XERO_API_BASE}/Contacts",
                    params={"page": page, "pageSize": 500, "includeArchived": "false"},
                    headers={
                        "Authorization": f"Bearer {access_token}",
                        "Xero-Tenant-Id": tenant_id,
                        "Accept": "application/json",
                    },
                )
                if r.status_code != 200:
                    raise HTTPException(r.status_code, f"Xero sync failed: {r.text[:300]}")
                batch = (r.json().get("Contacts") or [])
                if not batch:
                    break
                for c in batch:
                    name = c.get("Name") or ""
                    email = c.get("EmailAddress") or ""
                    await db.xero_contacts_cache.update_one(
                        {"contact_id": c.get("ContactID")},
                        {"$set": {
                            "contact_id": c.get("ContactID"),
                            "name": name,
                            "name_lc": name.lower(),
                            "email": email,
                            "email_lc": email.lower(),
                            "status": c.get("ContactStatus"),
                            "synced_at": _now().isoformat(),
                        }},
                        upsert=True,
                    )
                total += len(batch)
                if len(batch) < 500:
                    break
                page += 1
        return {"ok": True, "synced": total}

    @api.post("/xero/contacts/create")
    async def create_xero_contact(
        body: dict,
        _: dict = Depends(require_role("admin")),
    ):
        """Create a brand new Contact in Xero (and cache it locally).

        Body: ``{name, email, first_name?, last_name?, phone?}``.
        Returns the new contact id so the caller can immediately link
        it onto an order."""
        name = (body or {}).get("name", "").strip()
        if not name:
            raise HTTPException(400, "Name is required")
        email = (body or {}).get("email", "").strip() or None
        phone = (body or {}).get("phone", "").strip() or None
        payload = {"Contacts": [{
            "Name": name,
            **({"EmailAddress": email} if email else {}),
            **({"FirstName": body.get("first_name")} if body.get("first_name") else {}),
            **({"LastName": body.get("last_name")} if body.get("last_name") else {}),
            **({"Phones": [{"PhoneType": "DEFAULT", "PhoneNumber": phone}]} if phone else {}),
        }]}
        resp = await _xero_post(db, "/Contacts", payload)
        contacts = resp.get("Contacts") or []
        if not contacts:
            raise HTTPException(502, f"Xero returned no contact: {resp}")
        c = contacts[0]
        out = {
            "contact_id": c.get("ContactID"),
            "name": c.get("Name"),
            "email": c.get("EmailAddress"),
            "status": c.get("ContactStatus"),
        }
        # Cache immediately.
        await db.xero_contacts_cache.update_one(
            {"contact_id": out["contact_id"]},
            {"$set": {
                **out,
                "name_lc": (out["name"] or "").lower(),
                "email_lc": (out.get("email") or "").lower(),
                "synced_at": _now().isoformat(),
                "created_via_admin": True,
            }},
            upsert=True,
        )
        return out

    @api.post("/orders/{order_id}/link-xero-contact")
    async def link_order_to_xero_contact(
        order_id: str,
        body: dict,
        _: dict = Depends(require_role("admin")),
    ):
        """Store a Xero ContactID on the order so future invoices route
        to the right customer file and so the Reconcile page can hide it.

        Body: ``{xero_contact_id, name?, email?}``. If name/email are
        provided we also update the order's customer_label/email so the
        list view picks up the canonical Xero values."""
        order = await db.woo_orders.find_one({"id": order_id}, {"_id": 0})
        if not order:
            raise HTTPException(404, "Order not found")
        xcid = (body or {}).get("xero_contact_id")
        if not xcid:
            raise HTTPException(400, "xero_contact_id is required")
        updates = {
            "xero_contact_id": xcid,
            "xero_contact_name": (body or {}).get("name"),
            "xero_contact_match_status": "matched",
            "updated_at": _now().isoformat(),
        }
        if body.get("name"):
            updates["customer_label"] = body["name"]
        if body.get("email"):
            updates["customer_email"] = body["email"]
        await db.woo_orders.update_one({"id": order_id}, {"$set": updates})
        return {"ok": True, "xero_contact_id": xcid}

    @api.post("/orders/{order_id}/unlink-xero-contact")
    async def unlink_order_from_xero(
        order_id: str,
        _: dict = Depends(require_role("admin")),
    ):
        await db.woo_orders.update_one(
            {"id": order_id},
            {"$set": {"xero_contact_match_status": "needs_review", "updated_at": _now().isoformat()},
             "$unset": {"xero_contact_id": "", "xero_contact_name": ""}},
        )
        return {"ok": True}

    @api.get("/orders/reconciliation")
    async def orders_reconciliation(
        search: Optional[str] = None,
        skip: int = 0,
        limit: int = 50,
        _: dict = Depends(require_role("admin")),
    ):
        """List orders that aren't yet linked to a Xero contact. Returns
        a suggested match per row (best email or name hit in the cache)
        so the admin can usually one-click confirm."""
        match = {"xero_contact_id": {"$in": [None, ""]}}
        # Apply the same default exclude rule as the Active tab.
        if search:
            s = search.strip()
            match["$or"] = [
                {"customer_label": {"$regex": s, "$options": "i"}},
                {"customer_email": {"$regex": s, "$options": "i"}},
                {"display_order_id": s if not s.isdigit() else int(s)} if s.isdigit() else {"display_order_id": s},
            ]
        # Hide explicitly skipped ones unless searching.
        if not search:
            match["xero_contact_match_status"] = {"$ne": "skipped"}
        total = await db.woo_orders.count_documents(match)
        cursor = (
            db.woo_orders.find(match, {"_id": 0, "raw": 0})
            .sort("date_created", -1)
            .skip(skip).limit(limit)
        )
        items = []
        async for o in cursor:
            email = (o.get("customer_email") or "").lower()
            name = (o.get("customer_label") or "").lower()
            suggestion = None
            if email:
                suggestion = await db.xero_contacts_cache.find_one({"email_lc": email}, {"_id": 0})
            if not suggestion and name:
                # Try exact name match first
                suggestion = await db.xero_contacts_cache.find_one({"name_lc": name}, {"_id": 0})
            items.append({
                "id": o["id"],
                "display_order_id": o.get("display_order_id"),
                "woo_number": o.get("woo_number"),
                "legacy_order_id": o.get("legacy_order_id"),
                "channel": o.get("channel"),
                "date_created": o.get("date_created"),
                "customer_label": o.get("customer_label"),
                "customer_email": o.get("customer_email"),
                "total": o.get("total"),
                "suggested_xero": ({
                    "contact_id": suggestion["contact_id"],
                    "name": suggestion.get("name"),
                    "email": suggestion.get("email"),
                    "match_by": "email" if suggestion.get("email_lc") == email else "name",
                } if suggestion else None),
            })
        return {"items": items, "total": total, "skip": skip, "limit": limit}

    @api.post("/orders/{order_id}/skip-xero-reconcile")
    async def skip_xero_reconcile(
        order_id: str,
        _: dict = Depends(require_role("admin")),
    ):
        await db.woo_orders.update_one(
            {"id": order_id},
            {"$set": {"xero_contact_match_status": "skipped", "updated_at": _now().isoformat()}},
        )
        return {"ok": True}

    @api.post("/orders/auto-match-xero")
    async def bulk_auto_match_xero(_: dict = Depends(require_role("admin"))):
        """Walk every unlinked order, try to find a Xero contact by
        case-insensitive email or exact name match, and link it. Returns
        a summary so the admin knows how many still need attention."""
        # Build an in-memory map of email/name -> contact_id for speed
        cache_emails: dict[str, dict] = {}
        cache_names: dict[str, dict] = {}
        async for c in db.xero_contacts_cache.find({}, {"_id": 0}):
            if c.get("email_lc"):
                cache_emails[c["email_lc"]] = c
            if c.get("name_lc"):
                cache_names[c["name_lc"]] = c
        if not cache_emails and not cache_names:
            raise HTTPException(400, "Xero contacts cache is empty — click 'Sync Xero contacts' first.")
        matched_email = 0
        matched_name = 0
        async for o in db.woo_orders.find(
            {"xero_contact_id": {"$in": [None, ""]}},
            {"_id": 0, "id": 1, "customer_email": 1, "customer_label": 1},
        ):
            email = (o.get("customer_email") or "").lower().strip()
            name = (o.get("customer_label") or "").lower().strip()
            hit = cache_emails.get(email) if email else None
            match_by = "email"
            if not hit and name:
                hit = cache_names.get(name)
                match_by = "name"
            if hit:
                await db.woo_orders.update_one(
                    {"id": o["id"]},
                    {"$set": {
                        "xero_contact_id": hit["contact_id"],
                        "xero_contact_name": hit.get("name"),
                        "xero_contact_match_status": f"auto_matched_by_{match_by}",
                        "updated_at": _now().isoformat(),
                    }},
                )
                if match_by == "email":
                    matched_email += 1
                else:
                    matched_name += 1
        remaining = await db.woo_orders.count_documents({"xero_contact_id": {"$in": [None, ""]}, "xero_contact_match_status": {"$ne": "skipped"}})
        return {"ok": True, "matched_by_email": matched_email, "matched_by_name": matched_name, "remaining": remaining}

    @api.post("/xero/orders/{order_id}/create-invoice")
    async def create_invoice_from_order(
        order_id: str,
        _: dict = Depends(require_role("admin")),
    ):
        """Convert one of our local orders into a DRAFT Xero invoice.

        Idempotent: if the order already has ``xero_invoice_id`` we just
        return the existing record rather than creating a duplicate.
        """
        order = await db.woo_orders.find_one({"id": order_id}, {"_id": 0})
        if not order:
            raise HTTPException(404, "Order not found")
        if order.get("xero_invoice_id"):
            return {
                "ok": True,
                "already_invoiced": True,
                "xero_invoice_id": order["xero_invoice_id"],
                "xero_invoice_number": order.get("xero_invoice_number"),
                "xero_invoice_status": order.get("xero_invoice_status"),
            }

        payload = _build_xero_invoice_payload(order)
        resp = await _xero_post(db, "/Invoices", payload)
        invoices = resp.get("Invoices") or []
        if not invoices:
            raise HTTPException(502, f"Xero returned no invoice: {resp}")
        xi = invoices[0]
        updates = {
            "xero_invoice_id": xi.get("InvoiceID"),
            "xero_invoice_number": xi.get("InvoiceNumber"),
            "xero_invoice_status": xi.get("Status"),
            "invoiced": True,
            "invoice_pending_xero": False,
            "updated_at": _now().isoformat(),
        }
        await db.woo_orders.update_one({"id": order_id}, {"$set": updates})
        return {"ok": True, "xero_invoice_id": xi.get("InvoiceID"), "xero_invoice_number": xi.get("InvoiceNumber"), "xero_invoice_status": xi.get("Status")}

    @api.get("/xero/orders/{order_id}/invoice")
    async def get_invoice_for_order(
        order_id: str,
        _: dict = Depends(require_role("admin")),
    ):
        """Fetch the latest Xero record for an already-invoiced order so
        the UI can show the current Status / AmountPaid / AmountDue."""
        order = await db.woo_orders.find_one({"id": order_id}, {"_id": 0})
        if not order or not order.get("xero_invoice_id"):
            raise HTTPException(404, "Order has no Xero invoice yet")
        data = await _xero_get(db, f"/Invoices/{order['xero_invoice_id']}")
        invs = data.get("Invoices") or []
        if not invs:
            raise HTTPException(404, "Xero invoice not found")
        xi = invs[0]
        return {
            "invoice_id": xi.get("InvoiceID"),
            "invoice_number": xi.get("InvoiceNumber"),
            "status": xi.get("Status"),
            "amount_due": xi.get("AmountDue"),
            "amount_paid": xi.get("AmountPaid"),
            "total": xi.get("Total"),
            "online_invoice_url": f"https://go.xero.com/AccountsReceivable/View.aspx?InvoiceID={xi.get('InvoiceID')}",
        }

    # ----- Webhook ---------------------------------------------------------
    @api.post("/xero/webhook")
    async def xero_webhook(request: Request):
        """Receive payment notifications from Xero. Signature is verified
        using the raw request body — never the parsed JSON — because
        any whitespace difference breaks HMAC equality."""
        signing_key = _env("XERO_WEBHOOK_SIGNING_KEY")
        raw = await request.body()
        sig = request.headers.get("x-xero-signature", "")
        if not signing_key:
            # Xero's "intent to receive" handshake — they expect 401 when no key.
            return HTMLResponse("", status_code=401)
        digest = hmac.new(signing_key.encode("utf-8"), raw, "sha256").digest()
        expected = base64.b64encode(digest).decode("utf-8")
        if not hmac.compare_digest(expected, sig):
            # Xero documents that an *invalid* signature must return 401 and
            # a *valid* signature must return 200, even if events are empty.
            return HTMLResponse("", status_code=401)

        try:
            payload = json.loads(raw.decode("utf-8") or "{}")
        except json.JSONDecodeError:
            payload = {}

        events = payload.get("events") or []
        for ev in events:
            if ev.get("eventCategory") != "INVOICE":
                continue
            invoice_id = ev.get("resourceId")
            if not invoice_id:
                continue
            # Re-fetch the full invoice to learn its current paid status.
            try:
                data = await _xero_get(db, f"/Invoices/{invoice_id}")
            except HTTPException:
                continue
            invs = data.get("Invoices") or []
            if not invs:
                continue
            xi = invs[0]
            status_str = (xi.get("Status") or "").upper()
            amount_due = xi.get("AmountDue") or 0
            fully_paid = status_str == "PAID" or amount_due == 0
            await db.woo_orders.update_one(
                {"xero_invoice_id": invoice_id},
                {"$set": {
                    "xero_invoice_status": xi.get("Status"),
                    "payment_status": "Paid" if fully_paid else "Pending",
                    "date_paid": _now().isoformat() if fully_paid else None,
                    "updated_at": _now().isoformat(),
                }},
            )
        return {"ok": True}
