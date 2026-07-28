"""Backend tests for CmsContractsPanel bugfix: draft preview + delete."""
import os
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "https://licensee-vault.preview.emergentagent.com").rstrip("/")
ADMIN_EMAIL = "admin@creativemojo.co.uk"
ADMIN_PW = "CreativeMojo2026!"


@pytest.fixture(scope="module")
def admin_session():
    s = requests.Session()
    r = s.post(f"{BASE_URL}/api/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PW}, timeout=30)
    assert r.status_code == 200, f"admin login failed: {r.status_code} {r.text[:400]}"
    return s


def _pick_franchisee_and_template(session):
    fr = session.get(f"{BASE_URL}/api/franchisees", params={"limit": 500}, timeout=30)
    assert fr.status_code == 200
    fitems = fr.json().get("items") or fr.json()
    assert fitems, "no franchisees available"
    tr = session.get(f"{BASE_URL}/api/admin/contract-templates", timeout=30)
    assert tr.status_code == 200
    tpls = [t for t in tr.json().get("items", []) if t.get("status") in ("approved", "current")]
    assert tpls, "no approved/current contract templates available"
    return fitems[0]["id"], tpls[0]["id"]


def _create_draft(session, franchisee_id, template_id):
    payload = {
        "franchisee_id": franchisee_id,
        "template_id": template_id,
        "monthly_fee": 100,
    }
    r = session.post(f"{BASE_URL}/api/admin/contracts", json=payload, timeout=30)
    assert r.status_code in (200, 201), f"create draft failed: {r.status_code} {r.text[:400]}"
    data = r.json()
    assert data.get("status") == "draft"
    assert data.get("id")
    return data["id"]


# ---- Preview PDF endpoint ----
def test_preview_pdf_returns_pdf_blob(admin_session):
    franchisee_id, template_id = _pick_franchisee_and_template(admin_session)
    cid = _create_draft(admin_session, franchisee_id, template_id)
    try:
        r = admin_session.post(f"{BASE_URL}/api/admin/contracts/{cid}/preview-pdf", timeout=60)
        assert r.status_code == 200, f"preview-pdf failed: {r.status_code} {r.text[:400]}"
        # Should be PDF binary
        ctype = r.headers.get("content-type", "")
        assert "pdf" in ctype.lower() or r.content[:4] == b"%PDF", f"expected PDF, got {ctype} / {r.content[:20]!r}"
        assert len(r.content) > 500, "preview PDF suspiciously small"
    finally:
        admin_session.delete(f"{BASE_URL}/api/admin/contracts/{cid}", timeout=30)


# ---- DELETE draft ----
def test_delete_draft_contract_success(admin_session):
    franchisee_id, template_id = _pick_franchisee_and_template(admin_session)
    cid = _create_draft(admin_session, franchisee_id, template_id)

    r = admin_session.delete(f"{BASE_URL}/api/admin/contracts/{cid}", timeout=30)
    assert r.status_code == 200, f"delete failed: {r.status_code} {r.text[:400]}"
    body = r.json()
    assert body.get("deleted") is True
    assert body.get("id") == cid

    # verify gone
    g = admin_session.get(f"{BASE_URL}/api/admin/contracts/{cid}", timeout=30)
    assert g.status_code == 404, f"expected 404 after delete, got {g.status_code}"


# ---- DELETE non-draft returns 400 ----
def test_delete_non_draft_contract_returns_400(admin_session):
    # Find an issued or signed contract on the register
    r = admin_session.get(f"{BASE_URL}/api/admin/contracts", params={"limit": 200}, timeout=30)
    assert r.status_code == 200
    items = r.json().get("items", [])
    non_draft = next((c for c in items if c.get("status") in ("issued", "signed", "superseded")), None)
    if not non_draft:
        pytest.skip("No non-draft contract available to verify 400 guard")
    r = admin_session.delete(f"{BASE_URL}/api/admin/contracts/{non_draft['id']}", timeout=30)
    assert r.status_code == 400, f"expected 400 for non-draft, got {r.status_code}: {r.text[:400]}"
    detail = (r.json().get("detail") or "").lower()
    assert "only drafts" in detail or "draft" in detail, f"unexpected detail: {detail}"


def test_delete_nonexistent_contract_returns_404(admin_session):
    r = admin_session.delete(f"{BASE_URL}/api/admin/contracts/does-not-exist-xyz", timeout=30)
    assert r.status_code == 404
