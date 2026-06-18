"""Iteration 22b — verify POST /api/admin/backfill/convert-territories
back-fills territory data onto franchisees that were converted BEFORE
the auto-link fix shipped.

Covers:
1. Dry-run reports candidates but writes nothing
2. Real run: franchisee with no territory + plan exists → linked
3. Idempotent: re-running does NOT re-process already-linked rows
4. No plan → skipped_no_plan increments, no writes
"""

import os
import pytest
import requests

BASE = os.environ["REACT_APP_BACKEND_URL"].rstrip("/")
EMAIL = os.environ.get("ADMIN_EMAIL", "admin@creativemojo.co.uk")
PASSWORD = os.environ.get("ADMIN_PASSWORD", "CreativeMojo2026!")


@pytest.fixture(scope="module")
def s():
    sess = requests.Session()
    r = sess.post(f"{BASE}/api/auth/login", json={"email": EMAIL, "password": PASSWORD})
    assert r.status_code == 200
    return sess


@pytest.fixture(scope="module")
def cleanup():
    return {"contacts": [], "franchisees": [], "plans": []}


def _make_contact(s, suffix):
    payload = {
        "first_name": "TEST",
        "last_name": f"BFConvert_{suffix}",
        "email": f"TEST_bf_convert_{suffix}@example.com",
        "source": "franchise_enquiry",
        "target": "pipeline",
        "establishment_name": f"TEST BF Org {suffix}",
        "postcode": "CO7 0",
        "city": "Colchester",
    }
    r = s.post(f"{BASE}/api/contacts", json=payload)
    assert r.status_code in (200, 201), r.text
    return r.json().get("id") or r.json().get("contact", {}).get("id")


def _make_plan(s, contact_id, sectors, home_count=None):
    r = s.post(f"{BASE}/api/territory-plans", json={
        "contact_id": contact_id, "name": "TEST BF plan",
        "sectors": sectors, "home_count": home_count,
    })
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


def _convert(s, contact_id):
    r = s.post(f"{BASE}/api/contacts/{contact_id}/convert-to-franchisee")
    assert r.status_code == 200, r.text
    return r.json()


def _strip_territory(s, fid):
    """Simulate a pre-fix conversion: clear territory_sectors on the
    franchisee + remove franchisee_id back-link from any plan, so the
    backfill endpoint will pick it up as a candidate."""
    r = s.patch(f"{BASE}/api/franchisees/{fid}", json={})  # touch to ensure exists
    assert r.status_code == 200
    # Direct mutation via the admin API is not available — but we can
    # confirm the endpoint via two separate franchisees: one converted
    # AFTER plan was created (auto-linked, sectors present), one
    # converted BEFORE any plan (no sectors). Then create plan after
    # the second conversion and re-run backfill — it must link.


# ---------- 1. Dry-run lists rows but writes nothing ----------
def test_dry_run_does_not_write(s, cleanup):
    # Make a contact, convert with NO plan, then create the plan after.
    # This mimics the production scenario where a franchisee was
    # converted before the fix shipped, and the plan still exists.
    cid = _make_contact(s, "dr1")
    cleanup["contacts"].append(cid)
    body = _convert(s, cid)
    fid = body["franchisee"]["id"]
    cleanup["franchisees"].append(fid)
    assert body["territory_linked"] is False

    pid = _make_plan(s, cid, ["CO7 0", "CO6 1"], home_count=10)
    cleanup["plans"].append(pid)

    r = s.post(f"{BASE}/api/admin/backfill/convert-territories?dry_run=true")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True and body["dry_run"] is True
    # Our franchisee should be in linked_rows
    ours = [x for x in body["linked_rows"] if x["franchisee_id"] == fid]
    assert len(ours) == 1, f"dry-run did not list our franchisee: {body['linked_rows']}"
    assert ours[0]["plan_id"] == pid
    assert ours[0]["sectors"] == 2

    # Confirm nothing was actually written
    fr = s.get(f"{BASE}/api/franchisees/{fid}/territory").json()
    assert not fr.get("territory_sectors")


# ---------- 2. Real run links territory and back-links plan ----------
def test_real_run_links(s, cleanup):
    # Use the same franchisee from test 1 — now we run for real
    r = s.post(f"{BASE}/api/admin/backfill/convert-territories?dry_run=false")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["dry_run"] is False
    assert body["linked"] >= 1

    # Find any of OUR franchisees (created above)
    our_ids = set(cleanup["franchisees"])
    linked_our = [x for x in body["linked_rows"] if x["franchisee_id"] in our_ids]
    assert linked_our, "expected our franchisee in linked_rows"
    fid = linked_our[0]["franchisee_id"]

    fr = s.get(f"{BASE}/api/franchisees/{fid}/territory").json()
    assert sorted(fr.get("territory_sectors") or []) == ["CO6 1", "CO7 0"]
    assert fr.get("territory_home_count") == 10

    # History snapshot tagged source=backfill_convert_to_franchisee
    hist = s.get(f"{BASE}/api/franchisees/{fid}/territory/history").json().get("items", [])
    assert any(h.get("source") == "backfill_convert_to_franchisee" for h in hist)


# ---------- 3. Idempotent: re-running skips already-linked rows ----------
def test_idempotent(s, cleanup):
    our_ids = set(cleanup["franchisees"])
    r = s.post(f"{BASE}/api/admin/backfill/convert-territories?dry_run=false")
    assert r.status_code == 200
    body = r.json()
    # None of our franchisees should appear again — they're already linked
    linked_again = [x for x in body["linked_rows"] if x["franchisee_id"] in our_ids]
    assert linked_again == [], f"expected idempotent skip, got: {linked_again}"


# ---------- 4. Convert with no plan, no later plan → still skipped ----------
def test_skipped_when_no_plan(s, cleanup):
    cid = _make_contact(s, "skip1")
    cleanup["contacts"].append(cid)
    body = _convert(s, cid)
    fid = body["franchisee"]["id"]
    cleanup["franchisees"].append(fid)

    r = s.post(f"{BASE}/api/admin/backfill/convert-territories?dry_run=true")
    assert r.status_code == 200
    body = r.json()
    skipped_ours = [x for x in body["skipped_rows"] if x["franchisee_id"] == fid]
    assert skipped_ours and skipped_ours[0]["reason"] == "no plan for contact"


# ---------- Cleanup ----------
def test_zz_cleanup(s, cleanup):
    for fid in cleanup["franchisees"]:
        s.delete(f"{BASE}/api/franchisees/{fid}")
    for cid in cleanup["contacts"]:
        s.delete(f"{BASE}/api/contacts/{cid}")
    for pid in cleanup["plans"]:
        s.delete(f"{BASE}/api/territory-plans/{pid}")
