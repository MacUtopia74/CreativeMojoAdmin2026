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
    """Project a local order onto Xero's Invoices schema.

    Account-code mapping (per franchise owner spec, May 2026):
    * **Art-kit / product lines** → ``253`` (Deliverable Art Kit Sales (HQ))
      with ``TaxType: OUTPUT2`` (20% VAT on Income, UK standard rate).
    * **Shipping line** → ``204`` (Delivery Charges) with ``TaxType: NONE``
      (no VAT on delivery).
    * **PO number** — if the order has ``po_number`` we prepend a
      description-only line at the top of the invoice (no AccountCode,
      no UnitAmount) so it shows on the printed PDF for the customer
      to reconcile, and we also write the PO into the invoice
      ``Reference`` field as a fallback.
    """
    contact = {"Name": order.get("customer_label") or "Unknown customer"}
    email = order.get("customer_email") or (order.get("billing") or {}).get("email")
    if email:
        contact["EmailAddress"] = email

    line_items = []

    # Description-only PO row at the top — Xero accepts a line with only
    # a Description (no AccountCode, no UnitAmount, no Quantity).
    po_number = (order.get("po_number") or "").strip()
    if po_number:
        line_items.append({"Description": f"PO Number: {po_number}"})

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
            "AccountCode": "253",
            "TaxType": "OUTPUT2",
        })

    ship_total = float(order.get("shipping_total") or 0)
    if ship_total > 0:
        line_items.append({
            "Description": "Shipping",
            "Quantity": 1,
            "UnitAmount": round(ship_total, 2),
            "AccountCode": "204",
            "TaxType": "NONE",
        })

    if not any("AccountCode" in li for li in line_items):
        # Fallback — Xero requires at least one priced line item.
        line_items.append({
            "Description": f"Order {order.get('display_order_id') or order.get('id')}",
            "Quantity": 1,
            "UnitAmount": float(order.get("total") or 0),
            "AccountCode": "253",
            "TaxType": "OUTPUT2",
        })

    reference_bits = [f"Order #{order.get('display_order_id') or order.get('woo_number') or order.get('id')}"]
    if po_number:
        reference_bits.insert(0, f"PO {po_number}")

    invoice = {
        "Type": "ACCREC",  # Accounts Receivable — sales invoice
        "Contact": contact,
        "LineItems": line_items,
        "LineAmountTypes": "Exclusive",
        "Status": "DRAFT",
        "Reference": " · ".join(reference_bits),
    }
    if order.get("xero_contact_id"):
        # When we've already matched the customer to a Xero ContactID, we
        # use that as the single source of truth so we don't accidentally
        # create a duplicate contact based on Name alone.
        invoice["Contact"] = {"ContactID": order["xero_contact_id"]}
    if order.get("due_date"):
        try:
            invoice["DueDate"] = datetime.fromisoformat(order["due_date"].replace("Z", "+00:00")).date().isoformat()
        except Exception:
            pass
    return {"Invoices": [invoice]}


# ---------------------------------------------------------------------------
# Router wiring
# ---------------------------------------------------------------------------
def _zero_value_order(order: dict) -> bool:
    """Returns True if this order has no priced line items AND a £0
    total / shipping. Pushing one of these to Xero produces a £0
    invoice (real bug we hit in early-June 2026 with legacy-imported
    orders missing their prices), so the export endpoints refuse to
    send these and surface a clear error to the admin instead.
    """
    try:
        total = float(order.get("total") or 0)
        ship = float(order.get("shipping_total") or 0)
    except (TypeError, ValueError):
        total = 0.0
        ship = 0.0
    if total or ship:
        return False
    for li in order.get("line_items") or []:
        try:
            if float(li.get("subtotal") or 0) or float(li.get("total") or 0) or float(li.get("price") or 0):
                return False
        except (TypeError, ValueError):
            continue
    return True


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

    @api.get("/xero/contacts/{contact_id}")
    async def xero_contact_detail(
        contact_id: str,
        _: dict = Depends(require_role("admin")),
    ):
        """Fetch a single Xero contact in full, including addresses.

        Used by the Order Detail page to pull the customer's
        ``Shipping`` address (``AddressType=DELIVERY``) when the local
        Woo shipping object is empty — typically the case for legacy
        imports where we only carry the company name."""
        data = await _xero_get(db, f"/Contacts/{contact_id}")
        contacts = data.get("Contacts") or []
        if not contacts:
            raise HTTPException(404, "Xero contact not found")
        c = contacts[0]
        addresses = []
        for a in (c.get("Addresses") or []):
            addresses.append({
                "type": a.get("AddressType"),  # POBOX, STREET, DELIVERY
                "address_1": a.get("AddressLine1"),
                "address_2": a.get("AddressLine2"),
                "city": a.get("City"),
                "region": a.get("Region"),
                "postcode": a.get("PostalCode"),
                "country": a.get("Country"),
            })
        phones = []
        for p in (c.get("Phones") or []):
            num = " ".join(filter(None, [p.get("PhoneCountryCode"), p.get("PhoneAreaCode"), p.get("PhoneNumber")])).strip()
            if num:
                phones.append({"type": p.get("PhoneType"), "number": num})
        return {
            "contact_id": c.get("ContactID"),
            "name": c.get("Name"),
            "email": c.get("EmailAddress"),
            "first_name": c.get("FirstName"),
            "last_name": c.get("LastName"),
            "status": c.get("ContactStatus"),
            "addresses": addresses,
            "phones": phones,
        }

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
            # Exclude ARCHIVED contacts so historic accounts the user has
            # tidied up in Xero stop appearing in the picker.
            q = {
                "status": {"$ne": "ARCHIVED"},
                "$or": [
                    {"name_lc": {"$regex": safe_lower}},
                    {"email_lc": {"$regex": safe_lower}},
                ],
            }
            cached = await db.xero_contacts_cache.find(q, {"_id": 0}).limit(25).to_list(25)
            if cached:
                return {"contacts": [
                    {"contact_id": c["contact_id"], "name": c["name"], "email": c.get("email"), "status": c.get("status")}
                    for c in cached
                ], "from_cache": True}
            # Ask Xero only for ACTIVE contacts when going live too.
            params["where"] = (
                f'(Name.ToLower().Contains("{safe_lower}") OR EmailAddress.ToLower().Contains("{safe_lower}"))'
                ' AND ContactStatus=="ACTIVE"'
            )
        data = await _xero_get(db, "/Contacts", params=params)
        contacts = [
            {
                "contact_id": c.get("ContactID"),
                "name": c.get("Name"),
                "email": c.get("EmailAddress"),
                "status": c.get("ContactStatus"),
            }
            for c in (data.get("Contacts") or [])
            if (c.get("ContactStatus") or "ACTIVE") != "ARCHIVED"
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
        so we can match orders → Xero contacts entirely offline.

        We also tag any cache entries no longer returned by Xero as
        ``ARCHIVED`` — so when the franchise owner tidies up old legacy
        accounts in Xero, those names stop showing up in the picker
        without us having to delete the row (we still need it for
        historic order links)."""
        access_token, tenant_id = await get_valid_token(db)
        page = 1
        total = 0
        seen_ids: set[str] = set()
        sync_started_at = _now().isoformat()
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
                    cid = c.get("ContactID")
                    seen_ids.add(cid)
                    name = c.get("Name") or ""
                    email = c.get("EmailAddress") or ""
                    await db.xero_contacts_cache.update_one(
                        {"contact_id": cid},
                        {"$set": {
                            "contact_id": cid,
                            "name": name,
                            "name_lc": name.lower(),
                            "email": email,
                            "email_lc": email.lower(),
                            "status": c.get("ContactStatus") or "ACTIVE",
                            "synced_at": sync_started_at,
                        }},
                        upsert=True,
                    )
                total += len(batch)
                if len(batch) < 500:
                    break
                page += 1

        # Mark any cache rows we DIDN'T see this run as ARCHIVED so they
        # disappear from the picker. We keep the row so historic order
        # linkages still resolve.
        archived_result = await db.xero_contacts_cache.update_many(
            {"contact_id": {"$nin": list(seen_ids)} if seen_ids else {}, "status": {"$ne": "ARCHIVED"}},
            {"$set": {"status": "ARCHIVED", "archived_at": sync_started_at}},
        )
        return {"ok": True, "synced": total, "archived": archived_result.modified_count}

    @api.post("/xero/contacts/create")
    async def create_xero_contact(
        body: dict,
        _: dict = Depends(require_role("admin")),
    ):
        """Create a brand new Contact in Xero (and cache it locally).

        Body: ``{name, email, first_name?, last_name?, phone?,
        address_1?, address_2?, city?, postcode?, country?, region?}``.
        Returns the new contact id so the caller can immediately link
        it onto an order."""
        name = (body or {}).get("name", "").strip()
        if not name:
            raise HTTPException(400, "Name is required")
        email = (body or {}).get("email", "").strip() or None
        phone = (body or {}).get("phone", "").strip() or None
        # Build an Addresses payload if any address field is filled in
        # — Xero rejects "empty" Address records that have only a type,
        # so we only attach when at least one component is present.
        addr_parts = {
            "AddressLine1": (body.get("address_1") or "").strip(),
            "AddressLine2": (body.get("address_2") or "").strip(),
            "City":         (body.get("city") or "").strip(),
            "Region":       (body.get("region") or body.get("state") or "").strip(),
            "PostalCode":   (body.get("postcode") or "").strip(),
            "Country":      (body.get("country") or "").strip(),
        }
        addr_parts = {k: v for k, v in addr_parts.items() if v}
        addresses_payload: list[dict] = []
        if addr_parts:
            # Send the same address as both STREET and POBOX so it shows
            # up under "Postal" AND "Delivery" inside Xero. This matches
            # how Xero's own contact form behaves when the user only
            # enters one address.
            addresses_payload = [
                {"AddressType": "STREET", **addr_parts},
                {"AddressType": "POBOX", **addr_parts},
            ]
        payload = {"Contacts": [{
            "Name": name,
            **({"EmailAddress": email} if email else {}),
            **({"FirstName": body.get("first_name")} if body.get("first_name") else {}),
            **({"LastName": body.get("last_name")} if body.get("last_name") else {}),
            **({"Phones": [{"PhoneType": "DEFAULT", "PhoneNumber": phone}]} if phone else {}),
            **({"Addresses": addresses_payload} if addresses_payload else {}),
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

    @api.post("/orders/{order_id}/push-customer-to-xero")
    async def push_customer_to_xero(
        order_id: str,
        _: dict = Depends(require_role("admin")),
    ):
        """Push the order's customer details (name, email, billing+shipping
        address, phone, first/last name) up to Xero.

        - If the order is already linked (``xero_contact_id`` set) → the
          existing Xero contact is UPDATED with whatever the order has
          that's currently missing in Xero.
        - If the order is NOT linked → a brand new Xero contact is
          created and the order is linked to it on the way back.

        Xero merges contacts by POSTing ``{ContactID, ...fields}`` to
        ``/Contacts``, so the same code path handles both cases."""
        order = await db.woo_orders.find_one({"id": order_id}, {"_id": 0})
        if not order:
            raise HTTPException(404, "Order not found")

        billing = order.get("billing") or {}
        shipping = order.get("shipping") or {}

        # ----- Pick best values -----
        # Name (company): prefer the canonical customer_label, fall back
        # through company / first+last on either address.
        def _first_nonempty(*vals):
            for v in vals:
                if v and str(v).strip():
                    return str(v).strip()
            return ""

        name = _first_nonempty(
            order.get("customer_label"),
            billing.get("company"),
            shipping.get("company"),
            (f"{billing.get('first_name') or ''} {billing.get('last_name') or ''}").strip(),
        )
        if not name:
            raise HTTPException(400, "Order has no customer name/company to push")

        email = _first_nonempty(order.get("customer_email"), billing.get("email"))
        first_name = _first_nonempty(billing.get("first_name"), shipping.get("first_name"))
        last_name = _first_nonempty(billing.get("last_name"), shipping.get("last_name"))
        phone = _first_nonempty(billing.get("phone"), shipping.get("phone"))

        # Shipping (delivery) is usually the address the admin cares about;
        # fall back to billing if shipping is empty (manual one-line entries).
        def _addr_from(src):
            return {
                "AddressLine1": _first_nonempty(src.get("address_1")),
                "AddressLine2": _first_nonempty(src.get("address_2")),
                "City":         _first_nonempty(src.get("city")),
                "Region":       _first_nonempty(src.get("state")),
                "PostalCode":   _first_nonempty(src.get("postcode")),
                "Country":      _first_nonempty(src.get("country")) or "GB",
            }

        delivery_addr = _addr_from(shipping if shipping.get("address_1") else billing)
        billing_addr = _addr_from(billing if billing.get("address_1") else shipping)

        addresses_payload: list[dict] = []
        if any(v for k, v in delivery_addr.items() if k not in ("Country",)):
            addresses_payload.append({"AddressType": "STREET", **{k: v for k, v in delivery_addr.items() if v}})
        if any(v for k, v in billing_addr.items() if k not in ("Country",)):
            addresses_payload.append({"AddressType": "POBOX", **{k: v for k, v in billing_addr.items() if v}})
        # De-dup if delivery == billing (avoid sending two identical blocks).
        if len(addresses_payload) == 2:
            a, b = addresses_payload[0], addresses_payload[1]
            if {k: v for k, v in a.items() if k != "AddressType"} == {k: v for k, v in b.items() if k != "AddressType"}:
                addresses_payload = [a, {**a, "AddressType": "POBOX"}]

        xcid = order.get("xero_contact_id")
        contact_payload: dict = {
            "Name": name,
            **({"EmailAddress": email} if email else {}),
            **({"FirstName": first_name} if first_name else {}),
            **({"LastName": last_name} if last_name else {}),
            **({"Phones": [{"PhoneType": "DEFAULT", "PhoneNumber": phone}]} if phone else {}),
            **({"Addresses": addresses_payload} if addresses_payload else {}),
        }
        if xcid:
            # Update existing Xero contact — Xero merges on ContactID.
            contact_payload["ContactID"] = xcid

        resp = await _xero_post(db, "/Contacts", {"Contacts": [contact_payload]})
        contacts = resp.get("Contacts") or []
        if not contacts:
            raise HTTPException(502, f"Xero returned no contact: {resp}")
        new_xcid = contacts[0].get("ContactID")
        new_name = contacts[0].get("Name") or name
        new_email = contacts[0].get("EmailAddress") or email

        # Persist the link on the order so future invoices route correctly,
        # AND update the local Xero contact cache so the picker shows the
        # fresh data without a full re-sync.
        await db.woo_orders.update_one(
            {"id": order_id},
            {"$set": {
                "xero_contact_id": new_xcid,
                "xero_contact_name": new_name,
                "xero_contact_match_status": "matched",
                "updated_at": _now().isoformat(),
            }},
        )
        await db.xero_contacts_cache.update_one(
            {"contact_id": new_xcid},
            {"$set": {
                "contact_id": new_xcid,
                "name": new_name,
                "email": new_email,
                "name_lc": (new_name or "").lower(),
                "email_lc": (new_email or "").lower(),
                "synced_at": _now().isoformat(),
                "pushed_via_order": order_id,
            }},
            upsert=True,
        )

        return {
            "ok": True,
            "xero_contact_id": new_xcid,
            "name": new_name,
            "email": new_email,
            "fields_pushed": {
                "name": True,
                "email": bool(email),
                "phone": bool(phone),
                "first_name": bool(first_name),
                "last_name": bool(last_name),
                "addresses": len(addresses_payload),
            },
            "created": not bool(xcid),
            "updated": bool(xcid),
        }

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
                suggestion = await db.xero_contacts_cache.find_one({"email_lc": email, "status": {"$ne": "ARCHIVED"}}, {"_id": 0})
            if not suggestion and name:
                # Try exact name match first
                suggestion = await db.xero_contacts_cache.find_one({"name_lc": name, "status": {"$ne": "ARCHIVED"}}, {"_id": 0})
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
        async for c in db.xero_contacts_cache.find({"status": {"$ne": "ARCHIVED"}}, {"_id": 0}):
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

    @api.post("/xero/orders/{order_id}/unlink")
    async def unlink_xero_invoice(order_id: str, _: dict = Depends(require_role("admin"))):
        """Forget any existing Xero invoice link on an order so it can
        be re-pushed (used after backfilling prices on a legacy order
        whose first Xero export went out as £0). Doesn't touch the
        actual Xero invoice — admin should void/delete the £0 draft in
        Xero manually first."""
        r = await db.woo_orders.update_one(
            {"id": order_id},
            {"$unset": {
                "xero_invoice_id": "", "xero_invoice_number": "",
                "xero_invoice_status": "", "xero_invoice_url": "",
                "xero_sent_at": "",
            }},
        )
        if not r.matched_count:
            raise HTTPException(404, "Order not found")
        return {"ok": True}

    @api.post("/xero/orders/backfill-prices")
    async def backfill_legacy_order_prices(body: dict, _: dict = Depends(require_role("admin"))):
        """Look up prices for line items on legacy-imported orders that
        came in without them. Matches each line item against the local
        ``woo_products`` mirror by SKU first, then by name. Updates the
        line's ``price``/``subtotal``/``total`` and rolls up the order
        total. Doesn't touch line items that already have a price.

        Body: ``{order_ids?: [str], dry_run?: bool}``. If ``order_ids``
        is omitted we operate on every order with ``total=0`` AND
        ``legacy_import=True``. ``dry_run`` returns the proposed
        changes without writing them.
        """
        dry = bool(body.get("dry_run"))
        order_ids = body.get("order_ids") or None

        q: dict = {"legacy_import": True, "$or": [{"total": 0}, {"total": "0.00"}, {"total": None}]}
        if order_ids:
            q = {"id": {"$in": list(order_ids)}}

        # Build a name → price lookup from the Woo mirror once.
        # Normalisation: lowercase + strip + replace en-dash / em-dash
        # with plain hyphen + collapse runs of whitespace. The legacy
        # CSV exporter rewrote unicode dashes to ASCII so the mirror's
        # ``World Cup 2026 – Group Art Kit`` doesn't match the order's
        # ``World Cup 2026 - Group Art Kit`` without this step.
        import re as _re
        def _norm(s: str) -> str:
            if not s:
                return ""
            s = str(s).replace("\u2013", "-").replace("\u2014", "-")
            s = _re.sub(r"\s+", " ", s).strip().lower()
            return s

        product_by_sku: dict[str, dict] = {}
        product_by_name: dict[str, dict] = {}
        async for p in db.woo_products.find(
            {"$or": [{"price": {"$ne": None}}, {"regular_price": {"$ne": None}}]},
            {"_id": 0, "sku": 1, "name": 1, "price": 1, "regular_price": 1},
        ):
            if p.get("sku"):
                product_by_sku[_norm(p["sku"])] = p
            if p.get("name"):
                product_by_name[_norm(p["name"])] = p

        def _price_for(li: dict) -> Optional[float]:
            sku = _norm(li.get("sku") or "")
            if sku and sku in product_by_sku:
                p = product_by_sku[sku]
            else:
                name = _norm(li.get("name") or "")
                if name in product_by_name:
                    p = product_by_name[name]
                else:
                    return None
            raw = p.get("price") or p.get("regular_price")
            try:
                v = float(raw)
                # Woo "variable" parent products carry the parent's
                # display price (often 0). Skip £0 results — let the
                # admin know we couldn't find a price rather than
                # silently re-marking the order as £0.
                return v if v > 0 else None
            except (TypeError, ValueError):
                return None

        results: list[dict] = []
        repaired_count = 0
        async for order in db.woo_orders.find(q, {"_id": 0}):
            new_items = []
            total = 0.0
            touched = False
            for li in order.get("line_items") or []:
                qty = int(li.get("quantity") or 1)
                price = li.get("price")
                if price in (None, "", 0, "0", "0.00"):
                    unit = _price_for(li)
                    if unit is not None:
                        line_total = round(unit * qty, 2)
                        new_li = {**li,
                                  "price": unit,
                                  "subtotal": f"{line_total:.2f}",
                                  "total": f"{line_total:.2f}"}
                        touched = True
                        total += line_total
                        new_items.append(new_li)
                        continue
                # untouched line — still add to total
                try:
                    total += float(li.get("total") or li.get("subtotal") or 0)
                except (TypeError, ValueError):
                    pass
                new_items.append(li)
            if touched:
                total += float(order.get("shipping_total") or 0)
                repaired_count += 1
                results.append({
                    "id": order.get("id"),
                    "display": order.get("display_order_id"),
                    "old_total": order.get("total"),
                    "new_total": f"{total:.2f}",
                    "lines_repaired": sum(1 for a, b in zip(order.get("line_items") or [], new_items)
                                          if a.get("price") != b.get("price")),
                })
                if not dry:
                    await db.woo_orders.update_one(
                        {"id": order["id"]},
                        {"$set": {
                            "line_items": new_items,
                            "total": f"{total:.2f}",
                            "line_items_unavailable": False,
                            "updated_at": _now().isoformat(),
                        }},
                    )
        return {"ok": True, "dry_run": dry, "repaired": repaired_count, "details": results}

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
        if _zero_value_order(order):
            raise HTTPException(
                400,
                "This order has no priced line items so it would create a £0 invoice in Xero. "
                "Run /xero/orders/backfill-prices first (or edit the line items by hand).",
            )

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

    @api.post("/xero/orders/bulk-create-invoices")
    async def bulk_create_invoices(
        body: dict,
        _: dict = Depends(require_role("admin")),
    ):
        """Create DRAFT Xero invoices for a list of order IDs in one go.

        Body: ``{ids: ["uuid1", "uuid2", ...]}``. Idempotent per order —
        if an order already has ``xero_invoice_id`` it's counted as
        skipped rather than failed. Returns a per-id status array so the
        UI can show a small summary toast."""
        ids = (body or {}).get("ids") or []
        if not ids:
            raise HTTPException(400, "ids[] required")
        results = {"created": 0, "skipped": 0, "failed": 0, "errors": []}
        for oid in ids:
            order = await db.woo_orders.find_one({"id": oid}, {"_id": 0})
            if not order:
                results["failed"] += 1
                results["errors"].append({"id": oid, "error": "not found"})
                continue
            if order.get("xero_invoice_id"):
                results["skipped"] += 1
                continue
            if _zero_value_order(order):
                results["failed"] += 1
                results["errors"].append({
                    "id": oid,
                    "display": order.get("display_order_id"),
                    "error": "Order is £0 — line items have no prices. Run the price backfill first.",
                })
                continue
            try:
                payload = _build_xero_invoice_payload(order)
                resp = await _xero_post(db, "/Invoices", payload)
                invs = resp.get("Invoices") or []
                if not invs:
                    raise RuntimeError("no invoice returned")
                xi = invs[0]
                await db.woo_orders.update_one({"id": oid}, {"$set": {
                    "xero_invoice_id": xi.get("InvoiceID"),
                    "xero_invoice_number": xi.get("InvoiceNumber"),
                    "xero_invoice_status": xi.get("Status"),
                    "invoiced": True,
                    "invoice_pending_xero": False,
                    "updated_at": _now().isoformat(),
                }})
                results["created"] += 1
            except HTTPException as e:
                results["failed"] += 1
                results["errors"].append({"id": oid, "error": e.detail[:200] if isinstance(e.detail, str) else str(e.detail)})
            except Exception as e:  # noqa: BLE001
                results["failed"] += 1
                results["errors"].append({"id": oid, "error": str(e)[:200]})
        return {"ok": True, **results}

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
