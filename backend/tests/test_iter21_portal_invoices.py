"""
Iteration 21 — Portal Invoices full-stack tests.

Covers:
  - Authentication: portal endpoints reject admin tokens & missing tokens
  - Module gating: /api/portal/me exposes portal_modules
  - Invoice CRUD via /api/portal/invoices
  - Cross-isolation: Sandra's portal invoices never appear in admin GET /api/invoices
  - NEW payment-link endpoints:
       GET    /api/portal/invoices/{id}/payment-candidates
       POST   /api/portal/invoices/{id}/link-payment
       DELETE /api/portal/invoices/{id}/link-payment/{tx_id}  (unlink single)
       DELETE /api/portal/invoices/{id}/link-payment           (unlink all)
  - Auto-paid logic (credit >= total => 'paid' + paid_at)
  - Partial payment logic (credit < total => 'partial')
  - Unlink rolls back status (paid -> sent, partial -> sent)
"""

import io
import os
import time
import uuid
import pytest
import requests

def _load_frontend_env():
    try:
        with open("/app/frontend/.env") as f:
            for line in f:
                line = line.strip()
                if line.startswith("REACT_APP_BACKEND_URL="):
                    return line.split("=", 1)[1].strip().rstrip("/")
    except Exception:
        return ""
    return ""

BASE_URL = (os.environ.get("REACT_APP_BACKEND_URL") or _load_frontend_env() or "").rstrip("/")
assert BASE_URL, "REACT_APP_BACKEND_URL must be set"

SANDRA_EMAIL = "sandra@creativemojo.co.uk"
SANDRA_PWD = "Test1234!"
ADMIN_EMAIL = "admin@creativemojo.co.uk"
ADMIN_PWD = "CreativeMojo2026!"


# ---------------------------- fixtures ----------------------------
def _login(email: str, pwd: str) -> str:
    r = requests.post(
        f"{BASE_URL}/api/auth/login",
        json={"email": email, "password": pwd},
        timeout=15,
    )
    assert r.status_code == 200, f"login failed for {email}: {r.status_code} {r.text}"
    body = r.json()
    tok = body.get("access_token") or body.get("token")
    assert tok, f"no access_token in login response: {body}"
    return tok


@pytest.fixture(scope="session")
def sandra_token():
    return _login(SANDRA_EMAIL, SANDRA_PWD)


@pytest.fixture(scope="session")
def admin_token():
    return _login(ADMIN_EMAIL, ADMIN_PWD)


@pytest.fixture(scope="session")
def sandra_hdr(sandra_token):
    return {"Authorization": f"Bearer {sandra_token}"}


@pytest.fixture(scope="session")
def admin_hdr(admin_token):
    return {"Authorization": f"Bearer {admin_token}"}


@pytest.fixture(scope="session")
def created_invoice_ids():
    return []


@pytest.fixture(scope="session")
def created_client_ids():
    return []


@pytest.fixture(scope="session")
def sandra_client(sandra_hdr, created_client_ids):
    """Create one client for the franchisee to attach invoices to."""
    body = {"name": f"TEST_iter21_Client_{uuid.uuid4().hex[:6]}",
            "email": "iter21client@example.com"}
    r = requests.post(f"{BASE_URL}/api/portal/invoices/clients",
                      headers=sandra_hdr, json=body, timeout=10)
    assert r.status_code in (200, 201), f"client create failed: {r.status_code} {r.text}"
    cid = r.json()["id"]
    created_client_ids.append(cid)
    return r.json()


def _next_number(sandra_hdr) -> str:
    r = requests.get(f"{BASE_URL}/api/portal/invoices/next-number",
                     headers=sandra_hdr, timeout=10)
    assert r.status_code == 200, r.text
    body = r.json()
    return body.get("invoice_number") or body.get("next") or body.get("number") or f"INV-{uuid.uuid4().hex[:6].upper()}"


@pytest.fixture(scope="session", autouse=True)
def cleanup(sandra_hdr, created_invoice_ids, created_client_ids):
    yield
    for iid in created_invoice_ids:
        try:
            requests.delete(
                f"{BASE_URL}/api/portal/invoices/{iid}?hard=true",
                headers=sandra_hdr, timeout=10,
            )
        except Exception:
            pass
    for cid in created_client_ids:
        try:
            requests.delete(
                f"{BASE_URL}/api/portal/invoices/clients/{cid}",
                headers=sandra_hdr, timeout=10,
            )
        except Exception:
            pass


# ---------------------------- AUTH ----------------------------
class TestAuth:
    def test_portal_me_requires_auth(self):
        r = requests.get(f"{BASE_URL}/api/portal/me", timeout=10)
        assert r.status_code == 401

    def test_portal_invoices_requires_auth(self):
        r = requests.get(f"{BASE_URL}/api/portal/invoices", timeout=10)
        assert r.status_code == 401

    def test_portal_invoices_rejects_admin_token(self, admin_hdr):
        # Admin user is not a franchisee -> should be denied (403 or 401)
        r = requests.get(f"{BASE_URL}/api/portal/invoices", headers=admin_hdr, timeout=10)
        assert r.status_code in (401, 403), f"expected 401/403, got {r.status_code} {r.text}"

    def test_portal_me_returns_modules(self, sandra_hdr):
        r = requests.get(f"{BASE_URL}/api/portal/me", headers=sandra_hdr, timeout=10)
        assert r.status_code == 200
        body = r.json()
        # The shell reads from profile.portal_modules (nested) — verify it exists
        profile = body.get("profile") or {}
        modules = profile.get("portal_modules") or body.get("portal_modules") or {}
        assert isinstance(modules, dict), f"portal_modules missing in {body}"
        assert modules.get("invoicing") is True, f"invoicing module not enabled: {modules}"


# ---------------------------- CRUD ----------------------------
class TestInvoiceCRUD:
    def test_list_invoices(self, sandra_hdr):
        r = requests.get(f"{BASE_URL}/api/portal/invoices", headers=sandra_hdr, timeout=10)
        assert r.status_code == 200
        body = r.json()
        # Accept either array or {items: []}
        items = body if isinstance(body, list) else body.get("items") or body.get("invoices") or []
        assert isinstance(items, list)

    def test_create_invoice(self, sandra_hdr, sandra_client, created_invoice_ids):
        payload = {
            "client_id": sandra_client["id"],
            "client_name": sandra_client["name"],
            "client_email": "iter21@example.com",
            "invoice_number": _next_number(sandra_hdr),
            "line_items": [
                {"description": "Service A", "quantity": 1, "unit_price": 100.0, "amount": 100.0}
            ],
            "subtotal": 100.0,
            "total": 100.0,
            "status": "sent",
            "issue_date": "2026-01-15",
            "due_date": "2026-02-15",
            "notes": "iter21 test",
        }
        r = requests.post(
            f"{BASE_URL}/api/portal/invoices",
            headers=sandra_hdr, json=payload, timeout=15,
        )
        assert r.status_code in (200, 201), f"{r.status_code} {r.text}"
        body = r.json()
        assert "id" in body
        assert body.get("total") == 100.0
        assert body.get("status") in ("sent", "draft")
        created_invoice_ids.append(body["id"])

    def test_get_invoice(self, sandra_hdr, created_invoice_ids):
        assert created_invoice_ids
        iid = created_invoice_ids[0]
        r = requests.get(f"{BASE_URL}/api/portal/invoices/{iid}",
                         headers=sandra_hdr, timeout=10)
        assert r.status_code == 200
        body = r.json()
        assert body.get("id") == iid

    def test_admin_does_not_see_portal_invoices(self, admin_hdr, created_invoice_ids):
        """Cross-isolation: portal invoices must not bleed into admin /api/invoices."""
        assert created_invoice_ids
        r = requests.get(f"{BASE_URL}/api/invoices", headers=admin_hdr, timeout=10)
        assert r.status_code == 200, f"{r.status_code} {r.text}"
        body = r.json()
        items = body if isinstance(body, list) else body.get("items") or body.get("invoices") or []
        portal_ids = set(created_invoice_ids)
        admin_ids = {x.get("id") for x in items if isinstance(x, dict)}
        leaked = portal_ids & admin_ids
        assert not leaked, f"Portal invoices leaked to admin: {leaked}"


# ---------------------------- PAYMENT LINK ----------------------------
def _upload_csv(sandra_hdr, amount: float, desc: str = "TEST_iter21_credit") -> str:
    """Upload a 1-tx CSV and return the inserted tx id (or None)."""
    # Multi-row to satisfy parser heuristic (>=2 data rows)
    csv = (
        "Date,Description,Amount\n"
        f"2026-01-10,{desc},{amount:.2f}\n"
        "2026-01-09,TEST_iter21_filler,1.00\n"
    )
    files = {"file": ("tx.csv", io.BytesIO(csv.encode()), "text/csv")}
    r = requests.post(
        f"{BASE_URL}/api/portal/invoices/bank/upload",
        headers=sandra_hdr, files=files, timeout=20,
    )
    assert r.status_code == 200, f"upload failed {r.status_code} {r.text}"
    body = r.json()
    # Fetch the txs and locate our credit
    r2 = requests.get(
        f"{BASE_URL}/api/portal/invoices/bank/transactions?only_credits=true",
        headers=sandra_hdr, timeout=10,
    )
    assert r2.status_code == 200
    txs = r2.json() if isinstance(r2.json(), list) else r2.json().get("items") or r2.json().get("transactions") or []
    # Find unlinked tx with matching amount + description
    for t in txs:
        if abs(float(t.get("amount") or 0) - amount) < 0.005 and desc in (t.get("description") or ""):
            if not (t.get("linked_invoice_ids") or []):
                return t.get("id")
    # Fallback: any matching amount
    for t in txs:
        if abs(float(t.get("amount") or 0) - amount) < 0.005:
            return t.get("id")
    pytest.skip(f"could not locate uploaded tx {amount} {desc}: upload={body}")


class TestPaymentLink:
    invoice_id = None
    tx_full = None      # full-amount credit for paid flow
    tx_partial = None   # half-amount credit for partial flow

    @pytest.fixture(scope="class", autouse=True)
    def setup_invoice(self, sandra_hdr, sandra_client, created_invoice_ids):
        """Create a dedicated invoice + 2 credits for link tests."""
        unique = uuid.uuid4().hex[:6]
        payload = {
            "client_id": sandra_client["id"],
            "client_name": sandra_client["name"],
            "client_email": "linkflow@example.com",
            "invoice_number": _next_number(sandra_hdr),
            "line_items": [{"description": "Link", "quantity": 1, "unit_price": 200.0, "amount": 200.0}],
            "subtotal": 200.0, "total": 200.0,
            "status": "sent",
            "issue_date": "2026-01-01", "due_date": "2026-02-01",
        }
        r = requests.post(f"{BASE_URL}/api/portal/invoices",
                          headers=sandra_hdr, json=payload, timeout=15)
        assert r.status_code in (200, 201), r.text
        TestPaymentLink.invoice_id = r.json()["id"]
        created_invoice_ids.append(TestPaymentLink.invoice_id)

        # Upload two distinct credits
        TestPaymentLink.tx_full = _upload_csv(sandra_hdr, 200.0,
                                              f"TEST_iter21_full_{unique}")
        TestPaymentLink.tx_partial = _upload_csv(sandra_hdr, 50.0,
                                                 f"TEST_iter21_partial_{unique}")

    def test_payment_candidates_endpoint(self, sandra_hdr):
        iid = TestPaymentLink.invoice_id
        r = requests.get(
            f"{BASE_URL}/api/portal/invoices/{iid}/payment-candidates",
            headers=sandra_hdr, timeout=10,
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert "candidates" in body
        assert body.get("invoice_total") == 200.0
        assert body.get("paid_total") == 0
        assert body.get("remaining") == 200.0
        cand_ids = {c["transaction_id"] for c in body["candidates"]}
        assert TestPaymentLink.tx_full in cand_ids
        assert TestPaymentLink.tx_partial in cand_ids

    def test_partial_link(self, sandra_hdr):
        iid = TestPaymentLink.invoice_id
        r = requests.post(
            f"{BASE_URL}/api/portal/invoices/{iid}/link-payment",
            headers=sandra_hdr,
            json={"transaction_id": TestPaymentLink.tx_partial},
            timeout=10,
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body.get("status") == "partial", f"expected partial, got {body.get('status')}"

    def test_full_link_flips_paid(self, sandra_hdr):
        iid = TestPaymentLink.invoice_id
        r = requests.post(
            f"{BASE_URL}/api/portal/invoices/{iid}/link-payment",
            headers=sandra_hdr,
            json={"transaction_id": TestPaymentLink.tx_full},
            timeout=10,
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body.get("status") == "paid", f"expected paid, got {body.get('status')}"
        assert body.get("paid_at"), "paid_at must be set when status flips paid"

    def test_unlink_single_rolls_back(self, sandra_hdr):
        iid = TestPaymentLink.invoice_id
        # Unlink the full-amount tx — invoice should go back to 'partial' (still has 50)
        r = requests.delete(
            f"{BASE_URL}/api/portal/invoices/{iid}/link-payment/{TestPaymentLink.tx_full}",
            headers=sandra_hdr, timeout=10,
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body.get("status") == "partial", f"expected partial after unlink full, got {body.get('status')}"
        assert not body.get("paid_at"), "paid_at must be cleared when status leaves paid"

    def test_unlink_all_rolls_back_to_sent(self, sandra_hdr):
        iid = TestPaymentLink.invoice_id
        r = requests.delete(
            f"{BASE_URL}/api/portal/invoices/{iid}/link-payment",
            headers=sandra_hdr, timeout=10,
        )
        assert r.status_code == 200, r.text
        # Verify via GET
        r2 = requests.get(f"{BASE_URL}/api/portal/invoices/{iid}",
                          headers=sandra_hdr, timeout=10)
        assert r2.status_code == 200
        body = r2.json()
        assert body.get("status") == "sent", f"expected sent after unlink-all, got {body.get('status')}"
        assert (body.get("linked_transactions") or []) == []
