"""Iteration 22d — verify sales pipeline checklist is carried over onto
the franchisee record on Convert + can be backfilled on existing rows.

Covers:
1. Convert: contact with a populated CRM checklist → franchisee gets
   ``sales_handoff`` with the same fields, plus pre-ticked
   ``launch_checklist.territory_defined_confirmed``.
2. Convert: contact with NO checklist → no sales_handoff dict (we don't
   pollute the franchisee with empty handoff objects).
3. Backfill: pre-existing franchisee missing sales_handoff gets it
   populated from the source contact.
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
    return {"contacts": [], "franchisees": []}


def _make_contact(s, suffix):
    payload = {
        "first_name": "TEST", "last_name": f"HO_{suffix}",
        "email": f"TEST_ho_{suffix}@example.com",
        "source": "franchise_enquiry", "target": "pipeline",
        "establishment_name": f"TEST HO Org {suffix}", "postcode": "CO7 0",
    }
    r = s.post(f"{BASE}/api/contacts", json=payload)
    assert r.status_code in (200, 201)
    return r.json().get("id") or r.json().get("contact", {}).get("id")


def _set_checklist(s, cid, **fields):
    r = s.patch(f"{BASE}/api/contacts/{cid}/checklist", json=fields)
    assert r.status_code == 200, r.text


# ---------- 1. Convert copies the checklist ----------
def test_convert_copies_sales_handoff(s, cleanup):
    cid = _make_contact(s, "full")
    cleanup["contacts"].append(cid)
    _set_checklist(s, cid,
        territory_defined=True, contract_sent=True,
        shadow_day_booked=False,
        training_days_booked=True,
        training_day_dates=["2026-09-17", "2026-09-18"],
        shadowing_with="Sandra",
    )

    r = s.post(f"{BASE}/api/contacts/{cid}/convert-to-franchisee")
    assert r.status_code == 200, r.text
    fr = r.json()["franchisee"]
    cleanup["franchisees"].append(fr["id"])
    h = fr.get("sales_handoff")
    assert h, f"expected sales_handoff dict; got {fr}"
    assert h.get("territory_defined") is True
    assert h.get("contract_sent") is True
    # shadow_day_booked=False is preserved as explicit "not done" signal
    assert h.get("shadow_day_booked") is False
    assert h.get("training_days_booked") is True
    assert sorted(h.get("training_day_dates") or []) == ["2026-09-17", "2026-09-18"]
    # shadowing_with should be preserved
    assert h.get("shadowing_with") == "Sandra"
    # audit
    assert h.get("captured_at")
    assert h.get("captured_by")

    # Launch checklist pre-tick (territory only — we don't pre-tick contract
    # because the launch checklist doesn't have a "contract sent" row).
    lc = fr.get("launch_checklist") or {}
    assert lc.get("territory_defined_confirmed") is True


# ---------- 2. Contact with no checklist → no handoff ----------
def test_convert_no_handoff_when_checklist_empty(s, cleanup):
    cid = _make_contact(s, "empty")
    cleanup["contacts"].append(cid)
    r = s.post(f"{BASE}/api/contacts/{cid}/convert-to-franchisee")
    assert r.status_code == 200
    fr = r.json()["franchisee"]
    cleanup["franchisees"].append(fr["id"])
    assert fr.get("sales_handoff") in (None, {})


# ---------- 3. Backfill repairs a missing handoff ----------
def test_backfill_copies_handoff(s, cleanup):
    cid = _make_contact(s, "backf")
    cleanup["contacts"].append(cid)
    _set_checklist(s, cid,
        territory_defined=True, contract_sent=False,
        shadow_day_booked=True, shadow_day_date="2026-08-20",
        shadowing_with="Demo",
        training_days_booked=False, training_day_dates=[],
    )

    # Convert AFTER the checklist exists → handoff already present.
    r = s.post(f"{BASE}/api/contacts/{cid}/convert-to-franchisee")
    assert r.status_code == 200
    fid = r.json()["franchisee"]["id"]
    cleanup["franchisees"].append(fid)
    assert r.json()["franchisee"].get("sales_handoff")

    # Strip the handoff via mongo to simulate a pre-fix franchisee row.
    import asyncio
    from motor.motor_asyncio import AsyncIOMotorClient
    from dotenv import load_dotenv
    load_dotenv("/app/backend/.env")

    async def _strip():
        c = AsyncIOMotorClient(os.environ["MONGO_URL"])
        db = c[os.environ["DB_NAME"]]
        await db.franchisees.update_one({"id": fid}, {"$unset": {"sales_handoff": ""}})
        c.close()
    asyncio.run(_strip())

    # Backfill should now copy it across (handoff_rows non-empty).
    r = s.post(f"{BASE}/api/admin/backfill/convert-territories?dry_run=false")
    assert r.status_code == 200, r.text
    body = r.json()
    rows = [x for x in body.get("handoff_rows", []) if x["franchisee_id"] == fid]
    assert rows, f"expected handoff backfill row for {fid}: {body}"

    # Confirm the franchisee record now carries it.
    fr = s.get(f"{BASE}/api/franchisees/{fid}").json()
    fr = fr.get("franchisee", fr)
    h = fr.get("sales_handoff") or {}
    assert h.get("territory_defined") is True
    assert h.get("shadow_day_booked") is True
    assert h.get("shadow_day_date") == "2026-08-20"
    assert h.get("shadowing_with") == "Demo"


# ---------- Cleanup ----------
def test_zz_cleanup(s, cleanup):
    for fid in cleanup["franchisees"]:
        s.delete(f"{BASE}/api/franchisees/{fid}")
    for cid in cleanup["contacts"]:
        s.delete(f"{BASE}/api/contacts/{cid}")
