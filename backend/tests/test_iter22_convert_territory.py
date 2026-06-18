"""Iteration 22 — verify that POST /api/contacts/{id}/convert-to-franchisee
auto-links any territory_plan previously built for that contact and surfaces
territory metadata on the response.

Covers:
1. Convert with NO plan → territory_linked=false, sectors=[]
2. Convert with a plan → sectors copied onto franchisee + plan back-linked
3. Multiple plans → newest (latest created_at) wins
4. Frontend payload includes territory_home_count + linked_plan_id
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
    assert r.status_code == 200, f"login failed: {r.status_code} {r.text}"
    return sess


@pytest.fixture(scope="module")
def cleanup():
    return {"contacts": [], "franchisees": [], "plans": []}


def _make_contact(s, suffix):
    payload = {
        "first_name": "TEST",
        "last_name": f"Convert_TER_{suffix}",
        "email": f"TEST_convert_ter_{suffix}@example.com",
        "source": "franchise_enquiry",
        "target": "pipeline",
        "establishment_name": f"TEST Org TER {suffix}",
        "postcode": "CO7 0",
        "city": "Colchester",
        "telephone": "020 1234 5678",
        "mobile_phone": "07700 900000",
        "date": "2026-01-15",
    }
    r = s.post(f"{BASE}/api/contacts", json=payload)
    assert r.status_code in (200, 201), r.text
    body = r.json()
    cid = body.get("id") or body.get("contact", {}).get("id")
    assert cid
    return cid


def _make_plan(s, contact_id, sectors, home_count=None, name="TEST plan"):
    payload = {
        "contact_id": contact_id,
        "name": name,
        "sectors": sectors,
        "home_count": home_count,
        "centre_postcode": "CO7 0",
    }
    r = s.post(f"{BASE}/api/territory-plans", json=payload)
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


# ---------- 1. Convert without any plan ----------
def test_convert_without_plan(s, cleanup):
    cid = _make_contact(s, "noplan")
    cleanup["contacts"].append(cid)
    r = s.post(f"{BASE}/api/contacts/{cid}/convert-to-franchisee")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body.get("territory_linked") is False
    assert body.get("territory_sectors") == []
    assert body.get("linked_plan_id") is None
    fid = body["franchisee"]["id"]
    cleanup["franchisees"].append(fid)
    # Franchisee record should NOT carry territory_sectors when none linked
    fr = s.get(f"{BASE}/api/franchisees/{fid}").json()
    fr = fr.get("franchisee", fr)
    assert not fr.get("territory_sectors")


# ---------- 2. Convert with a single plan ----------
def test_convert_with_plan(s, cleanup):
    cid = _make_contact(s, "withplan")
    cleanup["contacts"].append(cid)
    sectors = ["CO7 0", "CO6 1", "CO5 9"]
    pid = _make_plan(s, cid, sectors, home_count=42)
    cleanup["plans"].append(pid)

    r = s.post(f"{BASE}/api/contacts/{cid}/convert-to-franchisee")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body.get("territory_linked") is True
    assert sorted(body.get("territory_sectors") or []) == sorted(sectors)
    assert body.get("territory_home_count") == 42
    assert body.get("linked_plan_id") == pid
    fid = body["franchisee"]["id"]
    cleanup["franchisees"].append(fid)

    # Plan should now be back-linked to the franchisee
    plans = s.get(f"{BASE}/api/territory-plans?franchisee_id={fid}").json().get("plans", [])
    assert any(p["id"] == pid for p in plans), "plan not back-linked to franchisee"

    # Franchisee should carry the sectors so the territory widget renders
    fr = s.get(f"{BASE}/api/franchisees/{fid}/territory").json()
    assert sorted(fr.get("territory_sectors") or []) == sorted(sectors)
    assert fr.get("territory_home_count") == 42

    # Territory history should record this auto-copy as one snapshot
    hist = s.get(f"{BASE}/api/franchisees/{fid}/territory/history").json().get("items", [])
    assert any(h.get("source") == "convert_to_franchisee" for h in hist), \
        "expected an audit-log entry tagged source=convert_to_franchisee"


# ---------- 3. Multiple plans — newest wins ----------
def test_convert_picks_latest_plan(s, cleanup):
    cid = _make_contact(s, "multiplan")
    cleanup["contacts"].append(cid)
    old_pid = _make_plan(s, cid, ["CO1 1"], home_count=5, name="OLD plan")
    new_pid = _make_plan(s, cid, ["EX15 1", "EX14 2"], home_count=99, name="NEW plan")
    cleanup["plans"].extend([old_pid, new_pid])

    r = s.post(f"{BASE}/api/contacts/{cid}/convert-to-franchisee")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["linked_plan_id"] == new_pid, "expected newest plan to win"
    assert sorted(body["territory_sectors"]) == ["EX14 2", "EX15 1"]
    cleanup["franchisees"].append(body["franchisee"]["id"])


# ---------- Cleanup ----------
def test_zz_cleanup(s, cleanup):
    for fid in cleanup["franchisees"]:
        s.delete(f"{BASE}/api/franchisees/{fid}")
    for cid in cleanup["contacts"]:
        s.delete(f"{BASE}/api/contacts/{cid}")
    for pid in cleanup["plans"]:
        s.delete(f"{BASE}/api/territory-plans/{pid}")
