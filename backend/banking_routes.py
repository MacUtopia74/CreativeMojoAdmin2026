"""Banking module — TrueLayer Data API integration for read-only Open
Banking. Connects HSBC UK Personal (sandbox or live) so Sandra can see
incoming receipts inside the admin app.

Design notes:
- Single-tenant: there's one banking connection for the whole admin app.
  We don't multi-tenant per user; the admin sees Sandra's HSBC feed.
- Read-only by policy: no payment initiation endpoints are called.
- Daily refresh: scheduled in the FastAPI lifespan (3am UK time). Well
  within TrueLayer's rate limits.
- Idempotent storage: transactions keyed by (account_id, transaction_id)
  with a unique index. Re-runs upsert in place.
- All currency is GBP.

Env vars consumed:
- TRUELAYER_CLIENT_ID
- TRUELAYER_CLIENT_SECRET
- TRUELAYER_ENV          ("sandbox" or "live")
- TRUELAYER_REDIRECT_URI (must match the URL whitelisted in TrueLayer console)
"""
from __future__ import annotations

import hashlib
import os
import re
from datetime import datetime, timedelta, timezone
from typing import Optional
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from fastapi.responses import RedirectResponse
from pydantic import BaseModel

from bank_statement_parser import (
    parse_hsbc_personal,
    parse_hsbc_csv,
    transaction_fingerprint,
)

# ---------------- URLs ----------------
def _urls() -> dict:
    env = (os.environ.get("TRUELAYER_ENV") or "sandbox").lower()
    if env == "live":
        return {
            "auth": "https://auth.truelayer.com",
            "api": "https://api.truelayer.com",
        }
    return {
        "auth": "https://auth.truelayer-sandbox.com",
        "api": "https://api.truelayer-sandbox.com",
    }


# Default scopes — covers everything we need for read-only AISP usage:
# accounts (list), balance (current/available), transactions (history),
# offline_access (refresh tokens so we don't need re-consent every 1h),
# info (account-holder name).
DEFAULT_SCOPES = "info accounts balance transactions offline_access"


def _frontend_url() -> str:
    return os.environ.get("FRONTEND_URL") or ""


def build_banking_router(db, require_role):
    router = APIRouter(prefix="/banking", tags=["banking"])
    admin = Depends(require_role("admin"))

    # -------------- helpers --------------
    async def _exchange_code(code: str) -> dict:
        urls = _urls()
        async with httpx.AsyncClient(timeout=20.0) as client:
            r = await client.post(
                f"{urls['auth']}/connect/token",
                data={
                    "grant_type": "authorization_code",
                    "client_id": os.environ["TRUELAYER_CLIENT_ID"],
                    "client_secret": os.environ["TRUELAYER_CLIENT_SECRET"],
                    "redirect_uri": os.environ["TRUELAYER_REDIRECT_URI"],
                    "code": code,
                },
            )
            if r.status_code != 200:
                raise HTTPException(502, f"TrueLayer token exchange failed: {r.text}")
            return r.json()

    async def _refresh_token(refresh_token: str) -> dict:
        urls = _urls()
        async with httpx.AsyncClient(timeout=20.0) as client:
            r = await client.post(
                f"{urls['auth']}/connect/token",
                data={
                    "grant_type": "refresh_token",
                    "client_id": os.environ["TRUELAYER_CLIENT_ID"],
                    "client_secret": os.environ["TRUELAYER_CLIENT_SECRET"],
                    "refresh_token": refresh_token,
                },
            )
            if r.status_code != 200:
                raise HTTPException(502, f"TrueLayer refresh failed: {r.text}")
            return r.json()

    async def _get_connection() -> Optional[dict]:
        return await db.banking_connections.find_one(
            {"_id": "default"}, {"_id": 0, "access_token": 1, "refresh_token": 1,
                                  "token_expires_at": 1, "consent_expires_at": 1,
                                  "institution_name": 1, "accounts": 1,
                                  "last_sync_at": 1, "status": 1, "created_at": 1}
        )

    async def _ensure_access_token() -> str:
        """Returns a fresh access token, refreshing if it's within 60s of
        expiry. Raises if no connection exists yet."""
        conn = await db.banking_connections.find_one({"_id": "default"})
        if not conn or not conn.get("access_token"):
            raise HTTPException(400, "No bank connection. Connect HSBC first.")
        expires_at = conn.get("token_expires_at")
        now = datetime.now(timezone.utc)
        # Stored as ISO string — normalise.
        if isinstance(expires_at, str):
            expires_at = datetime.fromisoformat(expires_at)
        if expires_at and expires_at > now + timedelta(seconds=60):
            return conn["access_token"]
        if not conn.get("refresh_token"):
            raise HTTPException(401, "Bank connection expired — please reconnect HSBC.")
        token = await _refresh_token(conn["refresh_token"])
        new_expiry = now + timedelta(seconds=int(token.get("expires_in", 3600)))
        update = {
            "access_token": token["access_token"],
            "token_expires_at": new_expiry.isoformat(),
            "updated_at": now.isoformat(),
        }
        if token.get("refresh_token"):
            update["refresh_token"] = token["refresh_token"]
        await db.banking_connections.update_one(
            {"_id": "default"}, {"$set": update}
        )
        return token["access_token"]

    async def _api_get(path: str, params: dict | None = None) -> dict:
        urls = _urls()
        token = await _ensure_access_token()
        async with httpx.AsyncClient(timeout=20.0) as client:
            r = await client.get(
                f"{urls['api']}{path}",
                params=params,
                headers={"Authorization": f"Bearer {token}"},
            )
            if r.status_code == 401:
                raise HTTPException(401, "Bank consent expired — reconnect HSBC.")
            if r.status_code >= 400:
                raise HTTPException(502, f"TrueLayer API error: {r.text}")
            return r.json()

    # -------------- routes --------------
    @router.get("/status")
    async def status(_=admin):
        """Lightweight check used by the UI to decide between the empty
        state and the dashboard view. We treat the dashboard as "live"
        whenever EITHER a TrueLayer connection OR any uploaded statements
        exist."""
        conn = await _get_connection()
        statement_count = await db.banking_statements.count_documents({})
        connected_truelayer = bool(conn)
        if not connected_truelayer and statement_count == 0:
            return {"connected": False, "statement_count": 0}
        now = datetime.now(timezone.utc)
        consent_expires = (conn or {}).get("consent_expires_at")
        days_until_expiry = None
        if consent_expires:
            exp = (datetime.fromisoformat(consent_expires)
                   if isinstance(consent_expires, str) else consent_expires)
            days_until_expiry = max(0, (exp - now).days)
        return {
            "connected": True,
            "source": "truelayer" if connected_truelayer else "statements",
            "institution_name": (conn or {}).get("institution_name")
                                 or ("HSBC UK (Statements)" if statement_count else None),
            "account_count": len((conn or {}).get("accounts") or []),
            "statement_count": statement_count,
            "last_sync_at": (conn or {}).get("last_sync_at"),
            "consent_expires_at": consent_expires,
            "days_until_consent_expires": days_until_expiry,
            "status": (conn or {}).get("status", "active"),
        }

    @router.get("/auth-url")
    async def auth_url(_=admin):
        """Builds the TrueLayer authorisation URL the admin clicks to start
        the consent journey. In sandbox we restrict the provider list to
        mock banks only — picking a real bank in sandbox results in an
        endless "Connecting…" loop because sandbox apps can't authenticate
        against live HSBC/etc."""
        env = (os.environ.get("TRUELAYER_ENV") or "sandbox").lower()
        if env == "live":
            providers = "uk-ob-all uk-oauth-all"
        else:
            # Sandbox: mock providers only, no fallback to real banks.
            providers = "uk-cs-mock"
        params = {
            "response_type": "code",
            "client_id": os.environ["TRUELAYER_CLIENT_ID"],
            "scope": DEFAULT_SCOPES,
            "redirect_uri": os.environ["TRUELAYER_REDIRECT_URI"],
            "providers": providers,
        }
        return {"url": f"{_urls()['auth']}/?{urlencode(params)}"}

    @router.get("/callback")
    async def callback(
        code: Optional[str] = Query(None),
        error: Optional[str] = Query(None),
    ):
        """TrueLayer redirects the user here after consent. We exchange the
        one-time code for tokens, persist the connection, fetch the
        accounts, and bounce the user to the in-app banking page."""
        front = _frontend_url()
        if error or not code:
            return RedirectResponse(url=f"{front}/banking?error={error or 'no_code'}")
        token = await _exchange_code(code)
        now = datetime.now(timezone.utc)
        expires_at = now + timedelta(seconds=int(token.get("expires_in", 3600)))
        # Consent under PSD2 lasts 90 days from issuance; TrueLayer doesn't
        # always echo this back, so we record our own assumed deadline and
        # show a renewal banner before it hits.
        consent_until = now + timedelta(days=90)
        await db.banking_connections.update_one(
            {"_id": "default"},
            {"$set": {
                "_id": "default",
                "access_token": token["access_token"],
                "refresh_token": token.get("refresh_token"),
                "token_expires_at": expires_at.isoformat(),
                "consent_expires_at": consent_until.isoformat(),
                "status": "active",
                "created_at": now.isoformat(),
                "updated_at": now.isoformat(),
            }},
            upsert=True,
        )
        # Pre-warm accounts so the UI has something to render immediately.
        try:
            await _sync_now()
        except HTTPException:
            pass  # callback should never fail — UI surface will show the issue
        return RedirectResponse(url=f"{front}/banking?connected=1")

    async def _sync_now() -> dict:
        """Pull accounts → balance → transactions for each account and
        idempotently upsert into Mongo. Returns a summary for the UI."""
        accounts_resp = await _api_get("/data/v1/accounts")
        accounts = accounts_resp.get("results", [])
        now = datetime.now(timezone.utc)

        await db.banking_connections.update_one(
            {"_id": "default"},
            {"$set": {
                "accounts": accounts,
                "institution_name": (
                    accounts[0].get("provider", {}).get("display_name")
                    if accounts else None
                ),
                "last_sync_at": now.isoformat(),
            }},
        )
        new_tx_total = 0
        for acc in accounts:
            acc_id = acc.get("account_id")
            if not acc_id:
                continue
            # Balance
            try:
                bal = await _api_get(f"/data/v1/accounts/{acc_id}/balance")
                bal_result = (bal.get("results") or [{}])[0]
                await db.banking_balances.update_one(
                    {"account_id": acc_id},
                    {"$set": {
                        "account_id": acc_id,
                        "current": bal_result.get("current"),
                        "available": bal_result.get("available"),
                        "currency": bal_result.get("currency"),
                        "updated_at": now.isoformat(),
                    }},
                    upsert=True,
                )
            except HTTPException:
                pass
            # Transactions — pull last 90 days by default. TrueLayer returns
            # the bank's full history if from/to omitted, but we cap it to
            # keep the call snappy and stay polite with rate limits.
            from_d = (now - timedelta(days=90)).date().isoformat()
            to_d = now.date().isoformat()
            try:
                tx_resp = await _api_get(
                    f"/data/v1/accounts/{acc_id}/transactions",
                    params={"from": from_d, "to": to_d},
                )
            except HTTPException:
                continue
            for tx in tx_resp.get("results", []):
                tx_id = tx.get("transaction_id") or tx.get("normalised_provider_transaction_id")
                if not tx_id:
                    continue
                doc = {
                    "account_id": acc_id,
                    "transaction_id": tx_id,
                    "amount": tx.get("amount"),
                    "currency": tx.get("currency"),
                    "description": tx.get("description"),
                    "merchant_name": tx.get("merchant_name"),
                    "transaction_type": tx.get("transaction_type"),  # CREDIT/DEBIT
                    "transaction_category": tx.get("transaction_category"),
                    "timestamp": tx.get("timestamp"),
                    "raw": tx,
                    "updated_at": now.isoformat(),
                }
                res = await db.banking_transactions.update_one(
                    {"account_id": acc_id, "transaction_id": tx_id},
                    {"$set": doc, "$setOnInsert": {"created_at": now.isoformat()}},
                    upsert=True,
                )
                if res.upserted_id is not None:
                    new_tx_total += 1
        return {"accounts": len(accounts), "new_transactions": new_tx_total}

    @router.post("/sync")
    async def sync(_=admin):
        """Manual refresh button — same code path as the daily cron."""
        return await _sync_now()

    @router.delete("/connection")
    async def disconnect(_=admin):
        """Remove the stored consent. Doesn't revoke at TrueLayer (which
        would require a separate /data/v1/me/connections/delete call) — the
        90-day clock there will lapse on its own. This just stops our app
        from using the tokens."""
        await db.banking_connections.delete_one({"_id": "default"})
        return {"ok": True}

    @router.get("/transactions")
    async def transactions(
        direction: str = Query("in", pattern="^(in|out|all)$"),
        date_from: Optional[str] = None,
        date_to: Optional[str] = None,
        search: Optional[str] = None,
        keywords: Optional[str] = Query(None, description="Comma-separated; any-match"),
        limit: int = Query(200, le=2000),
        _=admin,
    ):
        """List transactions stored locally. Defaults to incoming only —
        per the brief, we want to see what's come in to the account."""
        q: dict = {}
        if direction == "in":
            q["transaction_type"] = "CREDIT"
        elif direction == "out":
            q["transaction_type"] = "DEBIT"
        if date_from or date_to:
            ts: dict = {}
            if date_from:
                ts["$gte"] = date_from
            if date_to:
                ts["$lte"] = date_to + "T23:59:59"
            q["timestamp"] = ts
        if search:
            q["$or"] = [
                {"description": {"$regex": search, "$options": "i"}},
                {"merchant_name": {"$regex": search, "$options": "i"}},
            ]
        # Keyword "supplier chips" — any-match across descriptions. Escape
        # the keywords so regex special chars in supplier names (`.`, `(`)
        # don't blow up the query.
        if keywords:
            words = [k.strip() for k in keywords.split(",") if k.strip()]
            if words:
                kw_regex = "|".join(re.escape(w) for w in words)
                # If a `$or` from `search` is already present, combine
                # via `$and` so both filters apply.
                kw_clause = {"description": {"$regex": kw_regex, "$options": "i"}}
                if "$or" in q:
                    q.setdefault("$and", []).append({"$or": q.pop("$or")})
                    q["$and"].append(kw_clause)
                else:
                    q.update(kw_clause)
        rows = await db.banking_transactions.find(q, {"_id": 0, "raw": 0}) \
            .sort("timestamp", -1).to_list(limit)
        return {"transactions": rows, "count": len(rows)}

    @router.get("/dashboard")
    async def dashboard(months: int = Query(6, ge=1, le=24), _=admin):
        """Monthly incoming totals + top sources — the P&L view the user
        asked for. Outgoing is intentionally excluded from the headline
        numbers; flip `direction=out` on the transactions list to peek."""
        now = datetime.now(timezone.utc)
        cutoff = (now - timedelta(days=months * 31)).date().isoformat()
        balance = await db.banking_balances.find_one(
            {}, {"_id": 0, "current": 1, "available": 1, "currency": 1, "updated_at": 1}
        )

        pipeline_monthly = [
            {"$match": {
                "transaction_type": "CREDIT",
                "timestamp": {"$gte": cutoff},
            }},
            {"$addFields": {
                "month": {"$substr": ["$timestamp", 0, 7]},  # YYYY-MM
            }},
            {"$group": {
                "_id": "$month",
                "total": {"$sum": "$amount"},
                "count": {"$sum": 1},
            }},
            {"$sort": {"_id": -1}},
        ]
        monthly = await db.banking_transactions.aggregate(pipeline_monthly).to_list(50)
        # Top sources by merchant_name (fallback to description first 30 chars).
        pipeline_sources = [
            {"$match": {
                "transaction_type": "CREDIT",
                "timestamp": {"$gte": cutoff},
            }},
            {"$addFields": {
                "source": {"$ifNull": [
                    "$merchant_name",
                    {"$substr": [{"$ifNull": ["$description", ""]}, 0, 40]},
                ]},
            }},
            {"$group": {
                "_id": "$source",
                "total": {"$sum": "$amount"},
                "count": {"$sum": 1},
            }},
            {"$sort": {"total": -1}},
            {"$limit": 10},
        ]
        sources = await db.banking_transactions.aggregate(pipeline_sources).to_list(20)
        total_in = sum(m["total"] for m in monthly)
        return {
            "balance": balance,
            "months": [{"month": m["_id"], "total": round(m["total"], 2),
                        "count": m["count"]} for m in monthly],
            "top_sources": [{"name": s["_id"], "total": round(s["total"], 2),
                             "count": s["count"]} for s in sources],
            "total_in_window": round(total_in, 2),
        }

    # ---------------- PDF Statement Upload ----------------
    # The primary import path now that we're not using TrueLayer. Admin
    # uploads one or more HSBC personal statement PDFs; we parse each
    # into the same `banking_transactions` collection the rest of the
    # banking UI already reads from, so the dashboard "just works".

    @router.post("/statements")
    async def upload_statements(
        files: list[UploadFile] = File(...),
        _=admin,
    ):
        if not files:
            raise HTTPException(400, "No files supplied")
        results = []
        now = datetime.now(timezone.utc)
        for upload in files:
            name = (upload.filename or "").lower()
            is_csv = name.endswith(".csv")
            is_pdf = name.endswith(".pdf")
            if not (is_csv or is_pdf):
                results.append({"filename": upload.filename, "status": "error",
                                "message": "Only PDF or CSV files accepted"})
                continue
            blob = await upload.read()
            try:
                parsed = (parse_hsbc_csv(blob) if is_csv
                          else parse_hsbc_personal(blob))
            except Exception as exc:  # noqa: BLE001
                results.append({"filename": upload.filename, "status": "error",
                                "message": f"Parse failed: {exc}"})
                continue
            if not parsed.transactions:
                results.append({"filename": upload.filename, "status": "warning",
                                "message": "No transactions found — let us know and we'll tune the parser",
                                "page_count": parsed.page_count})
                continue
            statement_id = f"stmt_{int(now.timestamp() * 1000)}_{hashlib.md5(upload.filename.encode()).hexdigest()[:6]}"
            new_tx = 0
            duplicates = 0
            for tx in parsed.transactions:
                fp = transaction_fingerprint(tx)
                doc = {
                    "account_id": "statement-import",
                    "transaction_id": fp,
                    "amount": tx.amount,
                    "currency": "GBP",
                    "description": tx.description,
                    "merchant_name": None,
                    "transaction_type": tx.transaction_type,
                    "transaction_category": tx.transaction_type,
                    "timestamp": tx.date + "T00:00:00Z",
                    "source": "statement",
                    "source_statement_id": statement_id,
                    "raw_line": tx.raw,
                    "updated_at": now.isoformat(),
                }
                res = await db.banking_transactions.update_one(
                    {"account_id": "statement-import", "transaction_id": fp},
                    {"$set": doc, "$setOnInsert": {"created_at": now.isoformat()}},
                    upsert=True,
                )
                if res.upserted_id is not None:
                    new_tx += 1
                else:
                    duplicates += 1
            # Persist statement metadata so the user can see / delete it later
            await db.banking_statements.insert_one({
                "_id": statement_id,
                "filename": upload.filename,
                "uploaded_at": now.isoformat(),
                "file_size": len(blob),
                "page_count": parsed.page_count,
                "transaction_count": len(parsed.transactions),
                "new_transactions": new_tx,
                "duplicates_skipped": duplicates,
                "period_from": parsed.period_from,
                "period_to": parsed.period_to,
                "opening_balance": parsed.opening_balance,
                "closing_balance": parsed.closing_balance,
            })
            # Update the headline balance from the closing balance — gives
            # the dashboard a sensible "current balance" KPI.
            if parsed.closing_balance is not None:
                await db.banking_balances.update_one(
                    {"account_id": "statement-import"},
                    {"$set": {
                        "account_id": "statement-import",
                        "current": parsed.closing_balance,
                        "available": parsed.closing_balance,
                        "currency": "GBP",
                        "updated_at": now.isoformat(),
                    }},
                    upsert=True,
                )
            results.append({
                "filename": upload.filename,
                "status": "ok",
                "statement_id": statement_id,
                "transaction_count": len(parsed.transactions),
                "new_transactions": new_tx,
                "duplicates_skipped": duplicates,
                "period_from": parsed.period_from,
                "period_to": parsed.period_to,
            })
        return {"results": results}

    @router.get("/statements")
    async def list_statements(_=admin):
        rows = await db.banking_statements.find({}, {"_id": 1, "filename": 1,
            "uploaded_at": 1, "file_size": 1, "page_count": 1,
            "transaction_count": 1, "new_transactions": 1,
            "duplicates_skipped": 1, "period_from": 1, "period_to": 1,
            "opening_balance": 1, "closing_balance": 1}) \
            .sort("uploaded_at", -1).to_list(500)
        for r in rows:
            r["id"] = r.pop("_id")
        return {"statements": rows, "count": len(rows)}

    @router.delete("/statements/{statement_id}")
    async def delete_statement(statement_id: str, _=admin):
        # Pull every transaction tied to this statement, then check if
        # each row is shared with another statement. Only transactions
        # exclusively from this upload are removed.
        await db.banking_transactions.delete_many(
            {"source_statement_id": statement_id}
        )
        await db.banking_statements.delete_one({"_id": statement_id})
        # If there are no statements left, also wipe the synthetic balance
        # we wrote so the UI returns to the empty state cleanly.
        remaining = await db.banking_statements.count_documents({})
        if remaining == 0:
            await db.banking_balances.delete_many(
                {"account_id": "statement-import"}
            )
        return {"ok": True, "remaining_statements": remaining}

    # ---------------- Supplier Keyword Filters ----------------
    # Sandra wants a way to quickly filter the transactions list to a
    # known set of care-home suppliers (DENE LODGE, HAZELGATE, etc.).
    # We store the keyword list once globally (single-tenant admin app)
    # and let any incoming filter request name a subset.

    DEFAULT_KEYWORDS = [
        "DENE LODGE", "HAZELGATE", "NORTHAM", "VANEAL", "Swimbridge",
        "DUFFIELD", "Abbeyfield", "PARKVIEW", "EASTLEIGH", "HATHERLEIGH",
        "PILTON", "GLEN LYN", "STOURPORT", "Highwood", "Edenmore",
        "Parklands",
    ]

    @router.get("/supplier-keywords")
    async def list_supplier_keywords(_=admin):
        doc = await db.banking_supplier_keywords.find_one(
            {"_id": "default"}, {"_id": 0, "keywords": 1}
        )
        keywords = (doc or {}).get("keywords")
        if keywords is None:
            # Seed on first read so the user immediately sees the chips.
            await db.banking_supplier_keywords.update_one(
                {"_id": "default"},
                {"$set": {"keywords": DEFAULT_KEYWORDS}},
                upsert=True,
            )
            keywords = DEFAULT_KEYWORDS
        return {"keywords": keywords}

    class KeywordsUpdate(BaseModel):
        keywords: list[str]

    @router.put("/supplier-keywords")
    async def update_supplier_keywords(body: KeywordsUpdate, _=admin):
        # Trim + dedupe (case-insensitive, but preserve the user's casing
        # on the first occurrence).
        seen: set[str] = set()
        cleaned: list[str] = []
        for k in body.keywords:
            k = (k or "").strip()
            if not k:
                continue
            low = k.lower()
            if low in seen:
                continue
            seen.add(low)
            cleaned.append(k)
        await db.banking_supplier_keywords.update_one(
            {"_id": "default"},
            {"$set": {"keywords": cleaned}},
            upsert=True,
        )
        return {"keywords": cleaned}

    return router


async def ensure_banking_indexes(db) -> None:
    """Idempotent — call from app startup."""
    await db.banking_transactions.create_index(
        [("account_id", 1), ("transaction_id", 1)],
        unique=True, name="uniq_account_tx",
    )
    await db.banking_transactions.create_index([("timestamp", -1)])
    await db.banking_balances.create_index("account_id", unique=True)
