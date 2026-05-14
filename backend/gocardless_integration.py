"""
GoCardless live integration — Phase 1.5.

Read-only by design: list customers, list mandates, list payments,
process inbound webhooks. NEVER creates or cancels anything on the
GoCardless side.

Endpoints (all under /api, wired by server.py):
  - POST /api/gocardless/mandates/sync (dry_run=true|false)
  - POST /api/gocardless/franchisees/{id}/refresh
  - GET  /api/gocardless/alerts
  - GET  /api/gocardless/status (config + last sync)
  - POST /api/webhooks/gocardless  (no auth — verified by HMAC signature)
"""
from __future__ import annotations

import os
import hmac
import hashlib
import logging
from datetime import datetime, timezone, timedelta
from typing import Optional, Any
from fastapi import APIRouter, HTTPException, Request, Query, Depends
import gocardless_pro

logger = logging.getLogger("creative-mojo-admin.gocardless")

# ---------------------------------------------------------------------------
# Configuration & client
# ---------------------------------------------------------------------------
GC_TOKEN = os.environ.get("GOCARDLESS_ACCESS_TOKEN", "")
GC_ENV = os.environ.get("GOCARDLESS_ENVIRONMENT", "sandbox")  # "live" | "sandbox"
GC_WEBHOOK_SECRET = os.environ.get("GOCARDLESS_WEBHOOK_SECRET", "")

_client: Optional[gocardless_pro.Client] = None


def get_gc_client() -> gocardless_pro.Client:
    global _client
    if _client is None:
        if not GC_TOKEN:
            raise HTTPException(status_code=503,
                                detail="GoCardless not configured: GOCARDLESS_ACCESS_TOKEN missing")
        _client = gocardless_pro.Client(access_token=GC_TOKEN, environment=GC_ENV)
        logger.info("GoCardless client initialised (env=%s)", GC_ENV)
    return _client


def gc_configured() -> bool:
    return bool(GC_TOKEN)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _money_str(pence: Optional[int], currency: Optional[str]) -> Optional[str]:
    if pence is None:
        return None
    sym = {"GBP": "£", "EUR": "€", "USD": "$", "AUD": "A$"}.get((currency or "").upper(), "")
    return f"{sym}{pence / 100:.2f}"


async def _fetch_mandate_summary(client: gocardless_pro.Client, mandate_id: str) -> dict:
    """Fetch latest mandate + last/next payment for a mandate id. Pure-read."""
    out: dict[str, Any] = {"mandate_id": mandate_id}
    try:
        m = client.mandates.get(mandate_id)
        out.update({
            "status": m.status,
            "scheme": m.scheme,
            "reference": m.reference,
            "next_possible_charge_date": getattr(m, "next_possible_charge_date", None),
            "created_at_gc": m.created_at,
        })
    except Exception as exc:  # noqa: BLE001
        logger.warning("Could not fetch mandate %s: %s", mandate_id, exc)
        out["status"] = "unknown"
        out["error"] = str(exc)
        return out

    # Latest payment (confirmed or paid out)
    try:
        page = client.payments.list(params={"mandate": mandate_id, "limit": 1})
        if page.records:
            p = page.records[0]
            out["last_payment"] = {
                "id": p.id,
                "amount": p.amount,
                "currency": p.currency,
                "status": p.status,
                "charge_date": p.charge_date,
                "amount_str": _money_str(p.amount, p.currency),
            }
    except Exception as exc:  # noqa: BLE001
        logger.debug("No payments for mandate %s: %s", mandate_id, exc)

    # Next scheduled — via subscriptions on this mandate
    try:
        subs = client.subscriptions.list(params={"mandate": mandate_id, "status": "active"})
        if subs.records:
            s = subs.records[0]
            upcoming = getattr(s, "upcoming_payments", None) or []
            if upcoming:
                nxt = upcoming[0]
                out["next_payment"] = {
                    "amount": s.amount,
                    "currency": s.currency,
                    "charge_date": (nxt.get("charge_date") if isinstance(nxt, dict)
                                    else getattr(nxt, "charge_date", None)),
                    "amount_str": _money_str(s.amount, s.currency),
                }
    except Exception as exc:  # noqa: BLE001
        logger.debug("No subscription for mandate %s: %s", mandate_id, exc)

    return out


def _paginate_customers(client: gocardless_pro.Client, limit: int = 500):
    """Yield every customer in the GoCardless account using cursor pagination."""
    cursor: Optional[str] = None
    while True:
        params: dict[str, Any] = {"limit": limit}
        if cursor:
            params["after"] = cursor
        page = client.customers.list(params=params)
        records = list(page.records or [])
        for c in records:
            yield c
        # SDK exposes meta.cursors.after when there's a next page
        nxt = None
        meta = getattr(page, "meta", None)
        if meta is not None:
            cursors = getattr(meta, "cursors", None)
            nxt = getattr(cursors, "after", None) if cursors else None
        if not nxt:
            break
        cursor = nxt


# ---------------------------------------------------------------------------
# Router (no global auth — each endpoint declares require_role manually)
# ---------------------------------------------------------------------------
def build_router(db, require_role) -> APIRouter:
    """Build the GoCardless APIRouter. db & require_role are injected from server.py."""
    router = APIRouter()

    # ---- status -----------------------------------------------------------
    @router.get("/gocardless/status")
    async def gc_status(_user: dict = Depends(require_role("admin"))):
        last_sync = await db.gocardless_sync_log.find_one(sort=[("started_at", -1)],
                                                          projection={"_id": 0})
        return {
            "configured": gc_configured(),
            "environment": GC_ENV,
            "webhook_secret_set": bool(GC_WEBHOOK_SECRET),
            "last_sync": last_sync,
        }

    # ---- sync (dry-run by default) ----------------------------------------
    @router.post("/gocardless/mandates/sync")
    async def gc_sync_mandates(
        dry_run: bool = Query(True, description="If true (default) no DB writes happen."),
        user: dict = Depends(require_role("admin")),
    ):
        if not gc_configured():
            raise HTTPException(status_code=503, detail="GoCardless not configured.")
        client = get_gc_client()
        started = _now_iso()
        # Build email lookup of all franchisees
        franchisees = await db.franchisees.find(
            {}, {"_id": 0, "id": 1, "email": 1, "mojo_email": 1, "secondary_email": 1,
                 "first_name": 1, "last_name": 1,
                 "organisation": 1, "gocardless_customer_id": 1, "gocardless_mandate_id": 1}
        ).to_list(length=None)
        by_email: dict[str, dict] = {}
        for f in franchisees:
            # Collect every email associated with this franchisee — `email`,
            # `mojo_email`, and `secondary_email` (which can be comma-separated).
            candidates: list[str] = []
            for key in ("email", "mojo_email", "secondary_email"):
                raw = f.get(key)
                if not raw:
                    continue
                if isinstance(raw, list):
                    candidates.extend([str(x) for x in raw])
                else:
                    candidates.extend(str(raw).split(","))
            for c in candidates:
                e = c.strip().lower()
                if e and "@" in e:
                    # Last write wins, which is fine — duplicates point at same record
                    by_email[e] = f

        scanned = 0
        matched: list[dict] = []
        unmatched: list[dict] = []
        updates: list[dict] = []

        try:
            for cust in _paginate_customers(client):
                scanned += 1
                em = (cust.email or "").strip().lower() if cust.email else ""
                if not em:
                    continue
                f = by_email.get(em)
                if not f:
                    unmatched.append({"gc_customer_id": cust.id, "email": em})
                    continue
                # Find latest mandate for this customer (read-only)
                mandate_summary: dict[str, Any] = {}
                try:
                    mpage = client.mandates.list(params={"customer": cust.id, "limit": 5})
                    if mpage.records:
                        # Prefer an "active" mandate; otherwise newest
                        actives = [m for m in mpage.records if m.status == "active"]
                        m = actives[0] if actives else mpage.records[0]
                        mandate_summary = {
                            "mandate_id": m.id,
                            "status": m.status,
                            "scheme": m.scheme,
                            "reference": m.reference,
                            "next_possible_charge_date": getattr(m, "next_possible_charge_date", None),
                        }
                except Exception as exc:  # noqa: BLE001
                    logger.warning("Mandate fetch failed for %s: %s", cust.id, exc)

                rec = {
                    "franchisee_id": f["id"],
                    "franchisee_email": em,
                    "gc_customer_id": cust.id,
                    "mandate": mandate_summary,
                }
                matched.append(rec)
                # Prepare DB update
                update_doc = {
                    "gocardless_customer_id": cust.id,
                    "gocardless_mandate_id": mandate_summary.get("mandate_id"),
                    "gocardless_mandate_status": mandate_summary.get("status"),
                    "gocardless_mandate_reference": mandate_summary.get("reference"),
                    "gocardless_mandate_scheme": mandate_summary.get("scheme"),
                    "gocardless_synced_at": _now_iso(),
                }
                updates.append({"franchisee_id": f["id"], "update": update_doc})
        except gocardless_pro.errors.GoCardlessProError as exc:
            logger.error("GoCardless sync error: %s", exc)
            raise HTTPException(status_code=502, detail=f"GoCardless API error: {exc}") from exc

        committed = 0
        if not dry_run:
            for u in updates:
                await db.franchisees.update_one(
                    {"id": u["franchisee_id"]},
                    {"$set": u["update"]},
                )
                committed += 1

        report = {
            "dry_run": dry_run,
            "started_at": started,
            "finished_at": _now_iso(),
            "customers_scanned": scanned,
            "franchisees_total": len(franchisees),
            "matched_count": len(matched),
            "unmatched_count": len(unmatched),
            "committed_count": committed,
            "operator": user.get("email"),
        }
        # Always log
        await db.gocardless_sync_log.insert_one({**report,
                                                  "sample_matched": matched[:20],
                                                  "sample_unmatched": unmatched[:20]})
        # Include up to 10 of each in the response (for the UI preview)
        return {**report, "matched_preview": matched[:10], "unmatched_preview": unmatched[:10]}

    # ---- bulk payment refresh (last/next payment for every linked franchisee) -
    @router.post("/gocardless/payments/refresh-all")
    async def gc_refresh_payments_all(
        limit: int = Query(200, le=500, description="Cap rows processed per call"),
        only_active: bool = Query(True, description="Only refresh franchisees whose mandate is currently 'active'"),
        user: dict = Depends(require_role("admin")),
    ):
        """Walk every franchisee that has a gocardless_mandate_id set and refresh
        last/next payment + mandate status from GoCardless in one pass.
        Idempotent — safe to re-run."""
        if not gc_configured():
            raise HTTPException(status_code=503, detail="GoCardless not configured.")
        client = get_gc_client()
        q: dict = {"gocardless_mandate_id": {"$exists": True, "$nin": [None, ""]}}
        if only_active:
            q["gocardless_mandate_status"] = "active"
        franchisees = await db.franchisees.find(
            q, {"_id": 0, "id": 1, "gocardless_mandate_id": 1}
        ).limit(limit).to_list(length=None)

        started = _now_iso()
        processed = 0
        updated = 0
        errors: list[dict] = []
        for f in franchisees:
            mid = f["gocardless_mandate_id"]
            try:
                summary = await _fetch_mandate_summary(client, mid)
                update_doc = {
                    "gocardless_mandate_status": summary.get("status"),
                    "gocardless_mandate_reference": summary.get("reference"),
                    "gocardless_mandate_scheme": summary.get("scheme"),
                    "gocardless_last_payment": summary.get("last_payment"),
                    "gocardless_next_payment": summary.get("next_payment"),
                    "gocardless_synced_at": _now_iso(),
                }
                await db.franchisees.update_one({"id": f["id"]}, {"$set": update_doc})
                updated += 1
            except Exception as exc:  # noqa: BLE001
                errors.append({"franchisee_id": f["id"], "mandate_id": mid, "error": str(exc)})
            processed += 1

        report = {
            "started_at": started,
            "finished_at": _now_iso(),
            "processed": processed,
            "updated": updated,
            "errors": errors[:20],
            "error_count": len(errors),
            "operator": user.get("email"),
        }
        await db.gocardless_sync_log.insert_one({"job": "refresh_payments_all", **report})
        return report

    # ---- single franchisee refresh ----------------------------------------
    @router.post("/gocardless/franchisees/{franchisee_id}/refresh")
    async def gc_refresh_one(franchisee_id: str, _user: dict = Depends(require_role("admin"))):
        if not gc_configured():
            raise HTTPException(status_code=503, detail="GoCardless not configured.")
        f = await db.franchisees.find_one({"id": franchisee_id}, {"_id": 0})
        if not f:
            raise HTTPException(status_code=404, detail="Franchisee not found.")
        client = get_gc_client()
        # Prefer the stored mandate_id; otherwise look up via email → customer
        mandate_id = f.get("gocardless_mandate_id")
        customer_id = f.get("gocardless_customer_id")
        if not mandate_id:
            # Gather every email this franchisee has on file
            emails: list[str] = []
            for key in ("email", "mojo_email", "secondary_email"):
                v = f.get(key)
                if not v:
                    continue
                if isinstance(v, list):
                    emails.extend([str(x) for x in v])
                else:
                    emails.extend(str(v).split(","))
            email_set = {e.strip().lower() for e in emails if e and "@" in e}
            if email_set:
                # Paginate through GoCardless customers looking for any match
                try:
                    for cust in _paginate_customers(client):
                        if (cust.email or "").strip().lower() in email_set:
                            customer_id = cust.id
                            break
                except Exception as exc:  # noqa: BLE001
                    logger.warning("Customer lookup failed: %s", exc)
            if customer_id:
                try:
                    mpage = client.mandates.list(params={"customer": customer_id, "limit": 5})
                    if mpage.records:
                        actives = [m for m in mpage.records if m.status == "active"]
                        mandate_id = (actives[0] if actives else mpage.records[0]).id
                except Exception:  # noqa: BLE001
                    pass
        if not mandate_id:
            return {"linked": False, "reason": "No matching GoCardless customer/mandate."}
        summary = await _fetch_mandate_summary(client, mandate_id)
        update_doc = {
            "gocardless_customer_id": customer_id,
            "gocardless_mandate_id": mandate_id,
            "gocardless_mandate_status": summary.get("status"),
            "gocardless_mandate_reference": summary.get("reference"),
            "gocardless_mandate_scheme": summary.get("scheme"),
            "gocardless_last_payment": summary.get("last_payment"),
            "gocardless_next_payment": summary.get("next_payment"),
            "gocardless_synced_at": _now_iso(),
        }
        await db.franchisees.update_one({"id": franchisee_id}, {"$set": update_doc})
        fresh = await db.franchisees.find_one({"id": franchisee_id}, {"_id": 0})
        return {"linked": True, "franchisee": fresh, "summary": summary}

    # ---- alerts -----------------------------------------------------------
    @router.get("/gocardless/alerts")
    async def gc_alerts(
        hours: int = Query(24, ge=1, le=720),
        _user: dict = Depends(require_role("admin")),
    ):
        cutoff = (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat()
        items = await db.gocardless_alerts.find(
            {"created_at": {"$gte": cutoff}}, {"_id": 0}
        ).sort("created_at", -1).to_list(length=200)
        by_type = {"mandate_cancelled": 0, "mandate_failed": 0, "mandate_expired": 0,
                   "payment_failed": 0}
        for a in items:
            t = a.get("type")
            if t in by_type:
                by_type[t] += 1
        return {"items": items, "by_type": by_type, "window_hours": hours}

    # ---- webhook receiver -------------------------------------------------
    @router.post("/webhooks/gocardless")
    async def gc_webhook(request: Request):
        raw = await request.body()
        if not GC_WEBHOOK_SECRET:
            logger.warning("Webhook arrived but no secret configured — rejecting")
            raise HTTPException(status_code=498,
                                detail="Webhook secret not configured on server")
        sig = request.headers.get("Webhook-Signature", "")
        if not sig:
            raise HTTPException(status_code=498, detail="Missing Webhook-Signature header")
        expected = hmac.new(GC_WEBHOOK_SECRET.encode("utf-8"), raw, hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected, sig):
            logger.warning("Invalid webhook signature")
            raise HTTPException(status_code=498, detail="Invalid signature")
        try:
            payload = await request.json()
        except Exception:  # noqa: BLE001
            raise HTTPException(status_code=400, detail="Malformed JSON")
        events = payload.get("events") or []
        await db.gocardless_events.insert_one({
            "received_at": _now_iso(),
            "event_count": len(events),
            "events": events,
        })
        # Process each event minimally — write alerts + update franchisee mandate status
        for ev in events:
            await _handle_event(db, ev)
        return {"ok": True, "processed": len(events)}

    return router


async def _handle_event(db, ev: dict) -> None:
    rtype = ev.get("resource_type")
    action = ev.get("action")
    links = ev.get("links") or {}
    mandate_id = links.get("mandate")
    payment_id = links.get("payment")
    customer_id = links.get("customer")

    franchisee = None
    if mandate_id:
        franchisee = await db.franchisees.find_one(
            {"gocardless_mandate_id": mandate_id}, {"_id": 0})
    if not franchisee and customer_id:
        franchisee = await db.franchisees.find_one(
            {"gocardless_customer_id": customer_id}, {"_id": 0})

    franchisee_id = franchisee.get("id") if franchisee else None
    franchisee_name = ((franchisee.get("first_name") or "") + " " +
                       (franchisee.get("last_name") or "")).strip() if franchisee else None

    if rtype == "mandates":
        # Map GoCardless event actions to mandate statuses
        status_map = {
            "active": "active",
            "submitted": "submitted",
            "created": "pending_submission",
            "cancelled": "cancelled",
            "failed": "failed",
            "expired": "expired",
            "transferred": "active",
            "reinstated": "active",
        }
        new_status = status_map.get(action)
        if franchisee and new_status:
            await db.franchisees.update_one(
                {"id": franchisee_id},
                {"$set": {"gocardless_mandate_status": new_status,
                          "gocardless_synced_at": _now_iso()}},
            )
        if action in {"cancelled", "failed", "expired"}:
            await db.gocardless_alerts.insert_one({
                "type": f"mandate_{action}",
                "mandate_id": mandate_id,
                "franchisee_id": franchisee_id,
                "franchisee_name": franchisee_name,
                "reason": (ev.get("details") or {}).get("description"),
                "cause": (ev.get("details") or {}).get("cause"),
                "created_at": _now_iso(),
                "raw_event_id": ev.get("id"),
                "read": False,
            })

    elif rtype == "payments":
        if action == "failed":
            await db.gocardless_alerts.insert_one({
                "type": "payment_failed",
                "payment_id": payment_id,
                "mandate_id": mandate_id,
                "franchisee_id": franchisee_id,
                "franchisee_name": franchisee_name,
                "reason": (ev.get("details") or {}).get("description"),
                "cause": (ev.get("details") or {}).get("cause"),
                "created_at": _now_iso(),
                "raw_event_id": ev.get("id"),
                "read": False,
            })
