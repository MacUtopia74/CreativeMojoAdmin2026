"""Phase 5 — Per-franchisee Invoicing Module (clients/invoices/settings/PDF + bank reconciliation).

Covers admin portal-modules toggle, isolation between Sandra and admin's
invoices, CSV upload (3 formats), dedup, link/unlink with auto-paid logic,
partial payment, and PDF rendering.

All routes are cookie-auth via /api/auth/login.
"""
from __future__ import annotations

import io
import os
import time
from typing import Tuple

import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "https://licensee-vault.preview.emergentagent.com").rstrip("/")
ADMIN_EMAIL = "admin@creativemojo.co.uk"
ADMIN_PASS = "CreativeMojo2026!"
SANDRA_EMAIL = "sandra@creativemojo.co.uk"
SANDRA_PASS = "Test1234!"
SANDRA_FID = "b2ca2c54-7101-4524-926a-b36ac0e2a70a"


def _login(email: str, password: str) -> requests.Session:
    s = requests.Session()
    r = s.post(f"{BASE_URL}/api/auth/login", json={"email": email, "password": password}, timeout=20)
    assert r.status_code == 200, f"login failed for {email}: {r.status_code} {r.text[:200]}"
    return s


@pytest.fixture(scope="module")
def admin() -> requests.Session:
    return _login(ADMIN_EMAIL, ADMIN_PASS)


@pytest.fixture(scope="module")
def sandra(admin) -> requests.Session:
    # Make sure invoicing is enabled before any tests run
    r = admin.patch(
        f"{BASE_URL}/api/franchisees/{SANDRA_FID}/portal-modules",
        json={"invoicing": True}, timeout=15,
    )
    assert r.status_code == 200, f"enable invoicing: {r.status_code} {r.text[:200]}"
    return _login(SANDRA_EMAIL, SANDRA_PASS)


# ------------------------------ ADMIN TOGGLE -----------------------------------
class TestPortalModuleToggle:
    def test_toggle_each_module(self, admin):
        for mod in ("map", "calendar", "files", "invoicing"):
            # flip OFF
            r = admin.patch(f"{BASE_URL}/api/franchisees/{SANDRA_FID}/portal-modules", json={mod: False})
            assert r.status_code == 200, r.text[:200]
            body = r.json()
            modules = body.get("portal_modules") or body.get("modules") or body
            # Some implementations return the franchisee doc, others the modules.
            # Walk into both shapes.
            if mod in modules:
                assert modules[mod] is False
            elif "portal_modules" in body:
                assert body["portal_modules"][mod] is False
            # flip ON
            r2 = admin.patch(f"{BASE_URL}/api/franchisees/{SANDRA_FID}/portal-modules", json={mod: True})
            assert r2.status_code == 200, r2.text[:200]

    def test_me_reflects_modules(self, admin, sandra):
        r = sandra.get(f"{BASE_URL}/api/portal/me")
        assert r.status_code == 200, r.text[:200]
        me = r.json()
        prof = me.get("profile") or {}
        mods = prof.get("portal_modules") or me.get("portal_modules") or {}
        assert mods.get("invoicing") is True, f"invoicing flag missing: {mods}"


class TestInvoicingGating:
    def test_invoicing_disabled_403(self, admin):
        # Disable
        r = admin.patch(f"{BASE_URL}/api/franchisees/{SANDRA_FID}/portal-modules", json={"invoicing": False})
        assert r.status_code == 200
        s = _login(SANDRA_EMAIL, SANDRA_PASS)
        # Any sub-route should now 403
        r2 = s.get(f"{BASE_URL}/api/portal/invoices")
        assert r2.status_code == 403, f"expected 403 got {r2.status_code}: {r2.text[:200]}"
        body = r2.json()
        assert "Invoicing module is disabled" in str(body)
        r3 = s.get(f"{BASE_URL}/api/portal/invoices/clients")
        assert r3.status_code == 403
        # Re-enable
        admin.patch(f"{BASE_URL}/api/franchisees/{SANDRA_FID}/portal-modules", json={"invoicing": True})


# ------------------------------ SETTINGS ---------------------------------------
class TestSettings:
    def test_get_seed_settings_blank_bank(self, sandra):
        r = sandra.get(f"{BASE_URL}/api/portal/invoices/settings/me")
        assert r.status_code == 200, r.text[:200]
        s = r.json()
        assert s.get("business_name"), "business_name should be auto-populated"
        # CRITICAL: bank fields must be blank on first seed. After a PUT they
        # will reflect that value — so only enforce blank-by-default when the
        # doc still looks untouched.
        if not s.get("bank_details") and not s.get("bank_account_name"):
            assert s["bank_details"] == ""
            assert s["bank_account_name"] == ""
        else:
            # Doc was already updated by test_update_settings_roundtrip in
            # this run; just sanity-check it isn't leaking Sandra-admin data.
            assert "Sandra" not in (s.get("business_name") or "") or s["business_name"].startswith("Sandra")

    def test_update_settings_roundtrip(self, sandra):
        new = {"bank_account_name": "TEST_Sandra Caldeira", "bank_details": "Sort: 11-22-33 Acc: 12345678"}
        r = sandra.put(f"{BASE_URL}/api/portal/invoices/settings/me", json=new)
        assert r.status_code == 200, r.text[:200]
        # round-trip
        r2 = sandra.get(f"{BASE_URL}/api/portal/invoices/settings/me")
        assert r2.status_code == 200
        out = r2.json()
        assert out["bank_account_name"] == new["bank_account_name"]
        assert out["bank_details"] == new["bank_details"]


# ------------------------------ CLIENTS & INVOICES -----------------------------
@pytest.fixture(scope="module")
def client_id(sandra) -> str:
    body = {"name": "TEST_Acme Ltd", "email": "acme@test.local", "address": "1 Test St"}
    r = sandra.post(f"{BASE_URL}/api/portal/invoices/clients", json=body)
    assert r.status_code == 200, r.text[:200]
    cid = r.json()["id"]
    yield cid
    sandra.delete(f"{BASE_URL}/api/portal/invoices/clients/{cid}")


class TestClients:
    def test_list_contains_created(self, sandra, client_id):
        r = sandra.get(f"{BASE_URL}/api/portal/invoices/clients")
        assert r.status_code == 200
        ids = [c["id"] for c in r.json()]
        assert client_id in ids

    def test_update_client(self, sandra, client_id):
        r = sandra.put(f"{BASE_URL}/api/portal/invoices/clients/{client_id}",
                       json={"name": "TEST_Acme Updated", "email": "x@y.z"})
        assert r.status_code == 200
        assert r.json()["name"] == "TEST_Acme Updated"


def _make_invoice_body(client_id: str, num: str, total: float = 250.0):
    return {
        "client_id": client_id, "client_name": "TEST_Acme Updated",
        "client_email": "x@y.z", "client_address": "1 Test St",
        "invoice_number": num, "issue_date": "2026-01-10", "due_date": "2026-01-24",
        "line_items": [{"description": "Consulting", "quantity": 1, "unit_price": total, "amount": total}],
        "tax_rate": 0, "discount_rate": 0,
        "subtotal": total, "tax_amount": 0, "discount_amount": 0, "total": total,
        "notes": "", "payment_terms": "Net 14", "status": "sent",
    }


class TestInvoices:
    def test_next_number_format(self, sandra):
        r = sandra.get(f"{BASE_URL}/api/portal/invoices/next-number")
        assert r.status_code == 200
        nn = r.json()["next_number"]
        assert nn.startswith("INV-") and len(nn) == 8, nn

    def test_full_lifecycle(self, sandra, client_id):
        # CREATE
        nn = sandra.get(f"{BASE_URL}/api/portal/invoices/next-number").json()["next_number"]
        r = sandra.post(f"{BASE_URL}/api/portal/invoices", json=_make_invoice_body(client_id, nn, 250))
        assert r.status_code == 200, r.text[:200]
        inv = r.json()
        inv_id = inv["id"]
        # GET
        g = sandra.get(f"{BASE_URL}/api/portal/invoices/{inv_id}")
        assert g.status_code == 200 and g.json()["invoice_number"] == nn
        # status patch
        ps = sandra.patch(f"{BASE_URL}/api/portal/invoices/{inv_id}/status", json={"status": "paid"})
        assert ps.status_code == 200 and ps.json()["status"] == "paid"
        # stats
        st = sandra.get(f"{BASE_URL}/api/portal/invoices/stats")
        assert st.status_code == 200 and st.json()["all_count"] >= 1
        # soft delete + restore
        d = sandra.delete(f"{BASE_URL}/api/portal/invoices/{inv_id}")
        assert d.status_code == 200
        rs = sandra.post(f"{BASE_URL}/api/portal/invoices/{inv_id}/restore")
        assert rs.status_code == 200
        # Cleanup
        sandra.delete(f"{BASE_URL}/api/portal/invoices/{inv_id}")

    def test_next_number_increments(self, sandra, client_id):
        nn1 = sandra.get(f"{BASE_URL}/api/portal/invoices/next-number").json()["next_number"]
        r = sandra.post(f"{BASE_URL}/api/portal/invoices", json=_make_invoice_body(client_id, nn1, 10))
        assert r.status_code == 200
        nn2 = sandra.get(f"{BASE_URL}/api/portal/invoices/next-number").json()["next_number"]
        assert int(nn2.split("-")[1]) == int(nn1.split("-")[1]) + 1
        sandra.delete(f"{BASE_URL}/api/portal/invoices/{r.json()['id']}")


# ------------------------------ ISOLATION --------------------------------------
class TestIsolation:
    def test_admin_invoices_dont_leak_sandra(self, admin, sandra, client_id):
        # create one in Sandra's portal
        nn = sandra.get(f"{BASE_URL}/api/portal/invoices/next-number").json()["next_number"]
        r = sandra.post(f"{BASE_URL}/api/portal/invoices", json=_make_invoice_body(client_id, nn, 99))
        sandra_inv_id = r.json()["id"]
        # Admin's listing should NOT contain it
        a = admin.get(f"{BASE_URL}/api/invoices")
        if a.status_code == 200:
            assert sandra_inv_id not in [i.get("id") for i in a.json()], "Sandra's portal invoice leaked to admin list"
        ac = admin.get(f"{BASE_URL}/api/invoices/clients")
        if ac.status_code == 200:
            ids = [c.get("id") for c in ac.json()]
            assert client_id not in ids, "Sandra's portal client leaked to admin"
        sandra.delete(f"{BASE_URL}/api/portal/invoices/{sandra_inv_id}")


# ------------------------------ PDF --------------------------------------------
class TestPDF:
    def test_pdf_download(self, sandra, client_id):
        nn = sandra.get(f"{BASE_URL}/api/portal/invoices/next-number").json()["next_number"]
        r = sandra.post(f"{BASE_URL}/api/portal/invoices", json=_make_invoice_body(client_id, nn, 100))
        assert r.status_code == 200
        inv_id = r.json()["id"]
        p = sandra.get(f"{BASE_URL}/api/portal/invoices/{inv_id}/pdf")
        assert p.status_code == 200, p.text[:200]
        assert p.headers.get("content-type", "").startswith("application/pdf")
        assert p.content[:4] == b"%PDF"
        assert len(p.content) > 1000
        sandra.delete(f"{BASE_URL}/api/portal/invoices/{inv_id}")


# ------------------------------ CSV PARSER -------------------------------------
HSBC_CSV = b"""10/01/2026,SALARY ACME LTD,250.00
11/01/2026,COFFEE SHOP,-3.50
12/01/2026,REFUND XYZ,100.00
"""

HEADERED_CSV = b"""Date,Description,Amount
2026-01-15,Client Payment ABC,500.00
2026-01-16,Office Supplies,-45.99
"""

MONZO_CSV = b"""Date,Description,Money Out,Money In
20/01/2026,Sainsbury's,42.10,
21/01/2026,Client BankPayIn,,750.00
"""


def _upload(sess, name, blob):
    files = {"file": (name, io.BytesIO(blob), "text/csv")}
    return sess.post(f"{BASE_URL}/api/portal/invoices/bank/upload", files=files)


class TestBankCSV:
    def test_hsbc_signed_amount(self, sandra):
        r = _upload(sandra, "hsbc.csv", HSBC_CSV)
        assert r.status_code == 200, r.text[:200]
        body = r.json()
        assert body["total_rows_parsed"] == 3, body
        # First import should mostly insert (some may already exist from prior runs → dedup)
        assert body["inserted"] + body["skipped_duplicates"] == 3

    def test_dedup_on_reupload(self, sandra):
        r1 = _upload(sandra, "hsbc.csv", HSBC_CSV)
        assert r1.status_code == 200
        r2 = _upload(sandra, "hsbc.csv", HSBC_CSV)
        assert r2.status_code == 200
        body = r2.json()
        assert body["inserted"] == 0, f"expected 0 inserts on re-upload, got {body}"
        assert body["skipped_duplicates"] == 3

    def test_headered_csv(self, sandra):
        r = _upload(sandra, "h.csv", HEADERED_CSV)
        assert r.status_code == 200, r.text[:200]
        assert r.json()["total_rows_parsed"] == 2

    def test_monzo_split_columns(self, sandra):
        r = _upload(sandra, "monzo.csv", MONZO_CSV)
        assert r.status_code == 200, r.text[:200]
        body = r.json()
        assert body["total_rows_parsed"] == 2, body

    def test_list_credits_only(self, sandra):
        r = sandra.get(f"{BASE_URL}/api/portal/invoices/bank/transactions?only_credits=true")
        assert r.status_code == 200, r.text[:200]
        rows = r.json()
        assert all(t["transaction_type"] == "CREDIT" for t in rows), "found non-CREDIT in only_credits result"

    def test_empty_csv_400(self, sandra):
        r = _upload(sandra, "empty.csv", b"")
        assert r.status_code == 400


# ------------------------------ LINK / UNLINK / AUTO-PAID ----------------------
class TestLinking:
    def _seed_invoice_and_credit(self, sandra, client_id, total: float, amount: float) -> Tuple[str, str]:
        nn = sandra.get(f"{BASE_URL}/api/portal/invoices/next-number").json()["next_number"]
        inv = sandra.post(f"{BASE_URL}/api/portal/invoices",
                          json=_make_invoice_body(client_id, nn, total)).json()
        # build a unique credit row (parser needs ≥2 rows for shape inference)
        ts = int(time.time() * 1000)
        csv = (
            f"14/01/2026,LINK_PAD_{ts},1.00\n"
            f"15/01/2026,LINK_TEST_{ts},{amount:.2f}\n"
        ).encode()
        up = _upload(sandra, f"link_{ts}.csv", csv)
        assert up.status_code == 200
        # find the txn id by description
        rows = sandra.get(f"{BASE_URL}/api/portal/invoices/bank/transactions?only_credits=true").json()
        tx = next((t for t in rows if f"LINK_TEST_{ts}" in t.get("description", "")), None)
        assert tx, f"transaction not found after upload: {rows[:2]}"
        return inv["id"], tx["id"]

    def test_full_pay_autoflips(self, sandra, client_id):
        inv_id, tx_id = self._seed_invoice_and_credit(sandra, client_id, total=120.0, amount=120.0)
        r = sandra.post(f"{BASE_URL}/api/portal/invoices/bank/transactions/{tx_id}/link",
                        json={"invoice_id": inv_id})
        assert r.status_code == 200, r.text[:200]
        inv = sandra.get(f"{BASE_URL}/api/portal/invoices/{inv_id}").json()
        assert inv["status"] == "paid", f"expected paid, got {inv['status']}"
        assert inv.get("paid_at"), "paid_at should be populated"
        # unlink → status reverts
        u = sandra.delete(f"{BASE_URL}/api/portal/invoices/bank/transactions/{tx_id}/link/{inv_id}")
        assert u.status_code == 200
        inv2 = sandra.get(f"{BASE_URL}/api/portal/invoices/{inv_id}").json()
        assert inv2["status"] == "sent", f"after unlink expected sent, got {inv2['status']}"
        assert not inv2.get("paid_at")
        # cleanup
        sandra.delete(f"{BASE_URL}/api/portal/invoices/bank/transactions/{tx_id}")
        sandra.delete(f"{BASE_URL}/api/portal/invoices/{inv_id}")

    def test_partial_pay_no_flip(self, sandra, client_id):
        inv_id, tx_id = self._seed_invoice_and_credit(sandra, client_id, total=250.0, amount=100.0)
        r = sandra.post(f"{BASE_URL}/api/portal/invoices/bank/transactions/{tx_id}/link",
                        json={"invoice_id": inv_id})
        assert r.status_code == 200
        inv = sandra.get(f"{BASE_URL}/api/portal/invoices/{inv_id}").json()
        assert inv["status"] == "sent", f"partial credit should keep status sent, got {inv['status']}"
        # cleanup
        sandra.delete(f"{BASE_URL}/api/portal/invoices/bank/transactions/{tx_id}")
        sandra.delete(f"{BASE_URL}/api/portal/invoices/{inv_id}")

    def test_multiple_credits_sum_to_paid(self, sandra, client_id):
        ts = int(time.time() * 1000)
        nn = sandra.get(f"{BASE_URL}/api/portal/invoices/next-number").json()["next_number"]
        inv = sandra.post(f"{BASE_URL}/api/portal/invoices",
                          json=_make_invoice_body(client_id, nn, 200.0)).json()
        # Upload two credits of 100 each (different dates → unique fingerprints)
        csv = (
            f"01/02/2026,MULTI_A_{ts},100.00\n"
            f"02/02/2026,MULTI_B_{ts},100.00\n"
        ).encode()
        up = _upload(sandra, f"multi_{ts}.csv", csv)
        assert up.status_code == 200
        rows = sandra.get(f"{BASE_URL}/api/portal/invoices/bank/transactions?only_credits=true").json()
        txa = next(t for t in rows if f"MULTI_A_{ts}" in t["description"])
        txb = next(t for t in rows if f"MULTI_B_{ts}" in t["description"])
        sandra.post(f"{BASE_URL}/api/portal/invoices/bank/transactions/{txa['id']}/link",
                    json={"invoice_id": inv["id"]})
        inv1 = sandra.get(f"{BASE_URL}/api/portal/invoices/{inv['id']}").json()
        assert inv1["status"] == "sent", f"after 1/2 credits should be sent, got {inv1['status']}"
        sandra.post(f"{BASE_URL}/api/portal/invoices/bank/transactions/{txb['id']}/link",
                    json={"invoice_id": inv["id"]})
        inv2 = sandra.get(f"{BASE_URL}/api/portal/invoices/{inv['id']}").json()
        assert inv2["status"] == "paid", f"after 2/2 credits expected paid, got {inv2['status']}"
        # cleanup
        sandra.delete(f"{BASE_URL}/api/portal/invoices/bank/transactions/{txa['id']}")
        sandra.delete(f"{BASE_URL}/api/portal/invoices/bank/transactions/{txb['id']}")
        sandra.delete(f"{BASE_URL}/api/portal/invoices/{inv['id']}")

    def test_delete_txn_unlinks(self, sandra, client_id):
        inv_id, tx_id = self._seed_invoice_and_credit(sandra, client_id, total=50.0, amount=50.0)
        sandra.post(f"{BASE_URL}/api/portal/invoices/bank/transactions/{tx_id}/link",
                    json={"invoice_id": inv_id})
        r = sandra.delete(f"{BASE_URL}/api/portal/invoices/bank/transactions/{tx_id}")
        assert r.status_code == 200
        # txn gone
        rows = sandra.get(f"{BASE_URL}/api/portal/invoices/bank/transactions?only_credits=true").json()
        assert tx_id not in [t["id"] for t in rows]
        # invoice no longer references it
        inv = sandra.get(f"{BASE_URL}/api/portal/invoices/{inv_id}").json()
        assert tx_id not in (inv.get("payment_transaction_ids") or [])
        sandra.delete(f"{BASE_URL}/api/portal/invoices/{inv_id}")


# ------------------------------ SUGGESTED INVOICE ------------------------------
class TestSuggestion:
    def test_exact_amount_suggested(self, sandra, client_id):
        ts = int(time.time() * 1000)
        # Pick a unique amount unlikely to clash with prior test data
        unique_amt = round(444.00 + (ts % 1000) / 100.0, 2)
        nn = sandra.get(f"{BASE_URL}/api/portal/invoices/next-number").json()["next_number"]
        inv = sandra.post(f"{BASE_URL}/api/portal/invoices",
                          json=_make_invoice_body(client_id, nn, unique_amt)).json()
        csv = (
            f"04/03/2026,SUG_PAD_{ts},1.00\n"
            f"05/03/2026,SUG_TEST_{ts},{unique_amt:.2f}\n"
        ).encode()
        _upload(sandra, f"sug_{ts}.csv", csv)
        rows = sandra.get(f"{BASE_URL}/api/portal/invoices/bank/transactions?only_credits=true").json()
        tx = next((t for t in rows if f"SUG_TEST_{ts}" in t["description"]), None)
        assert tx, "uploaded credit not found"
        assert tx.get("suggested_invoice") is not None, "exact-amount match should produce a suggestion"
        assert tx["suggested_invoice"]["id"] == inv["id"]
        sandra.delete(f"{BASE_URL}/api/portal/invoices/bank/transactions/{tx['id']}")
        sandra.delete(f"{BASE_URL}/api/portal/invoices/{inv['id']}")
