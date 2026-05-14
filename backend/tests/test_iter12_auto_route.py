"""
Iter12 backend tests:
 - 30-day auto-route on POST /api/contacts (franchise/licence)
 - Per-row auto-route on POST /api/contacts/import (franchise/licence)
 - General/Pipeline target rules
 - Data sanity: licence tab empty, pipeline 'new' has 24+ records
 - Validation: empty rows, invalid target, dedupe
"""
import os
import pytest
import requests
from datetime import datetime, timedelta, timezone

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL").rstrip("/")
ADMIN_EMAIL = "admin@creativemojo.co.uk"
ADMIN_PW = "CreativeMojo2026!"


@pytest.fixture(scope="module")
def client():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    r = s.post(f"{BASE_URL}/api/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PW})
    assert r.status_code == 200, f"Login failed: {r.status_code} {r.text}"
    return s


@pytest.fixture(scope="module")
def created_ids():
    ids = []
    yield ids
    # Final cleanup safety net
    s = requests.Session()
    s.post(f"{BASE_URL}/api/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PW})
    for cid in ids:
        try:
            s.delete(f"{BASE_URL}/api/contacts/{cid}")
        except Exception:
            pass


def _today():
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")

def _days_ago(n):
    return (datetime.now(timezone.utc) - timedelta(days=n)).strftime("%Y-%m-%d")


# ─── Single-contact auto-route ────────────────────────────────────────────────
class TestCreateContactAutoRoute:
    def test_licence_target_auto_routes_to_pipeline(self, client, created_ids):
        r = client.post(f"{BASE_URL}/api/contacts", json={
            "target": "licence",
            "first_name": "AutoRoute1",
            "email": "ar1_test_iter12@example.com",
        })
        assert r.status_code == 200, r.text
        contact = r.json()["contact"]
        cid = contact["id"]
        created_ids.append(cid)

        assert contact["in_pipeline"] is True
        assert contact["pipeline_status"] == "new"
        assert contact["source"] == "licence_enquiry"

        # Appears under pipeline tab
        rp = client.get(f"{BASE_URL}/api/contacts?tab=pipeline&limit=200")
        assert rp.status_code == 200
        pipeline_ids = {x["id"] for x in rp.json()["items"]}
        assert cid in pipeline_ids, "contact should be visible under tab=pipeline"

        # NOT under licence tab
        rl = client.get(f"{BASE_URL}/api/contacts?tab=licence&limit=200")
        assert rl.status_code == 200
        licence_ids = {x["id"] for x in rl.json()["items"]}
        assert cid not in licence_ids, "contact should NOT be visible under tab=licence"

        # Cleanup
        d = client.delete(f"{BASE_URL}/api/contacts/{cid}")
        assert d.status_code in (200, 204)
        created_ids.remove(cid)

    def test_franchise_target_auto_routes_to_pipeline(self, client, created_ids):
        r = client.post(f"{BASE_URL}/api/contacts", json={
            "target": "franchise",
            "first_name": "AutoRoute2",
            "email": "ar2_test_iter12@example.com",
        })
        assert r.status_code == 200, r.text
        contact = r.json()["contact"]
        cid = contact["id"]
        created_ids.append(cid)

        assert contact["in_pipeline"] is True
        assert contact["pipeline_status"] == "new"
        assert contact["source"] == "franchise_enquiry"

        client.delete(f"{BASE_URL}/api/contacts/{cid}")
        created_ids.remove(cid)

    def test_general_target_stays_out_of_pipeline(self, client, created_ids):
        r = client.post(f"{BASE_URL}/api/contacts", json={
            "target": "general",
            "first_name": "AutoRoute3General",
            "email": "ar3_test_iter12@example.com",
        })
        assert r.status_code == 200, r.text
        contact = r.json()["contact"]
        cid = contact["id"]
        created_ids.append(cid)

        assert contact["in_pipeline"] is False
        assert contact["pipeline_status"] is None
        assert contact["source"] == "general_enquiry"

        client.delete(f"{BASE_URL}/api/contacts/{cid}")
        created_ids.remove(cid)

    def test_pipeline_target_respects_explicit_status(self, client, created_ids):
        r = client.post(f"{BASE_URL}/api/contacts", json={
            "target": "pipeline",
            "pipeline_status": "qualified",
            "first_name": "AutoRoute4Q",
            "email": "ar4_test_iter12@example.com",
        })
        assert r.status_code == 200, r.text
        contact = r.json()["contact"]
        cid = contact["id"]
        created_ids.append(cid)

        assert contact["in_pipeline"] is True
        assert contact["pipeline_status"] == "qualified"

        client.delete(f"{BASE_URL}/api/contacts/{cid}")
        created_ids.remove(cid)


# ─── Import auto-route per row ───────────────────────────────────────────────
class TestImportAutoRoute:
    def _import_three_rows(self, client, target, prefix):
        rows = [
            {"first_name": f"{prefix}Row1", "email": f"{prefix.lower()}1@i12.test", "date": _today()},
            {"first_name": f"{prefix}Row2", "email": f"{prefix.lower()}2@i12.test", "date": _days_ago(15)},
            {"first_name": f"{prefix}Row3", "email": f"{prefix.lower()}3@i12.test", "date": _days_ago(60)},
        ]
        r = client.post(f"{BASE_URL}/api/contacts/import", json={
            "target": target,
            "rows": rows,
            "dedupe_by_email": True,
        })
        assert r.status_code == 200, r.text
        assert r.json()["inserted"] == 3
        return rows

    def _fetch_by_email(self, client, email, tab):
        # Backend search param is 'search', and it doesn't index email — fall back to full list scan
        r = client.get(f"{BASE_URL}/api/contacts?tab={tab}&limit=2000")
        assert r.status_code == 200
        for x in r.json()["items"]:
            if (x.get("email") or "").lower() == email.lower():
                return x
        return None

    def _cleanup_by_emails(self, client, emails):
        for tab in ("pipeline", "licence", "franchise", "general"):
            r = client.get(f"{BASE_URL}/api/contacts?tab={tab}&limit=2000")
            for x in r.json().get("items", []):
                if (x.get("email") or "").lower() in emails:
                    client.delete(f"{BASE_URL}/api/contacts/{x['id']}")

    def test_import_licence_per_row_decision(self, client):
        prefix = "AutoImportLic"
        emails = {f"{prefix.lower()}{i}@i12.test" for i in (1, 2, 3)}
        try:
            self._import_three_rows(client, "licence", prefix)

            # row1 today → pipeline new
            row1_p = self._fetch_by_email(client, f"{prefix.lower()}1@i12.test", "pipeline")
            assert row1_p is not None and row1_p["in_pipeline"] is True
            assert row1_p["pipeline_status"] == "new"
            assert row1_p["source"] == "licence_enquiry"

            # row2 15 days ago → pipeline new
            row2_p = self._fetch_by_email(client, f"{prefix.lower()}2@i12.test", "pipeline")
            assert row2_p is not None and row2_p["in_pipeline"] is True
            assert row2_p["pipeline_status"] == "new"

            # row3 60 days ago → NOT pipeline, sits in licence tab
            row3_l = self._fetch_by_email(client, f"{prefix.lower()}3@i12.test", "licence")
            assert row3_l is not None, "row3 (60d old) should appear in licence tab"
            assert row3_l["in_pipeline"] is False
            assert row3_l["pipeline_status"] is None
            assert row3_l["source"] == "licence_enquiry"

            # row3 must NOT be in pipeline
            row3_p = self._fetch_by_email(client, f"{prefix.lower()}3@i12.test", "pipeline")
            assert row3_p is None, "row3 (60d old) must NOT be in pipeline"
        finally:
            self._cleanup_by_emails(client, emails)

    def test_import_franchise_per_row_decision(self, client):
        prefix = "AutoImportFr"
        emails = {f"{prefix.lower()}{i}@i12.test" for i in (1, 2, 3)}
        try:
            self._import_three_rows(client, "franchise", prefix)

            row1 = self._fetch_by_email(client, f"{prefix.lower()}1@i12.test", "pipeline")
            assert row1 is not None and row1["in_pipeline"] is True
            assert row1["pipeline_status"] == "new"
            assert row1["source"] == "franchise_enquiry"

            row2 = self._fetch_by_email(client, f"{prefix.lower()}2@i12.test", "pipeline")
            assert row2 is not None and row2["in_pipeline"] is True
            assert row2["pipeline_status"] == "new"

            row3 = self._fetch_by_email(client, f"{prefix.lower()}3@i12.test", "franchise")
            assert row3 is not None
            assert row3["in_pipeline"] is False
            assert row3["source"] == "franchise_enquiry"
        finally:
            self._cleanup_by_emails(client, emails)

    def test_import_general_target_never_pipeline(self, client):
        prefix = "AutoImportGen"
        emails = {f"{prefix.lower()}{i}@i12.test" for i in (1, 2)}
        try:
            rows = [
                {"first_name": f"{prefix}Row1", "email": f"{prefix.lower()}1@i12.test", "date": _today()},
                {"first_name": f"{prefix}Row2", "email": f"{prefix.lower()}2@i12.test", "date": _days_ago(5)},
            ]
            r = client.post(f"{BASE_URL}/api/contacts/import", json={"target": "general", "rows": rows})
            assert r.status_code == 200
            assert r.json()["inserted"] == 2

            for e in emails:
                x = self._fetch_by_email(client, e, "general")
                assert x is not None
                assert x["in_pipeline"] is False
                assert x["pipeline_status"] is None
                assert x["source"] == "general_enquiry"
        finally:
            self._cleanup_by_emails(client, emails)

    def test_import_pipeline_target_with_explicit_status(self, client):
        prefix = "AutoImportPipQ"
        emails = {f"{prefix.lower()}{i}@i12.test" for i in (1, 2)}
        try:
            rows = [
                {"first_name": f"{prefix}Row1", "email": f"{prefix.lower()}1@i12.test", "date": _today()},
                {"first_name": f"{prefix}Row2", "email": f"{prefix.lower()}2@i12.test", "date": _days_ago(120)},
            ]
            r = client.post(f"{BASE_URL}/api/contacts/import", json={
                "target": "pipeline",
                "pipeline_status": "qualified",
                "rows": rows,
            })
            assert r.status_code == 200
            assert r.json()["inserted"] == 2

            for e in emails:
                x = self._fetch_by_email(client, e, "pipeline")
                assert x is not None, f"{e} should be in pipeline regardless of date"
                assert x["in_pipeline"] is True
                assert x["pipeline_status"] == "qualified"
        finally:
            self._cleanup_by_emails(client, emails)


# ─── Data sanity ───────────────────────────────────────────────────────────────
class TestDataSanity:
    def test_licence_tab_empty(self, client):
        r = client.get(f"{BASE_URL}/api/contacts?tab=licence&limit=10")
        assert r.status_code == 200
        items = r.json()["items"]
        assert len(items) == 0, f"Expected 0 licence contacts after sweep, got {len(items)}"

    def test_pipeline_new_has_24_plus(self, client):
        """Spec target: 24+ NEW pipeline contacts after iter12 sweep. Verifies the
        14-licence migration landed (or at minimum that some 'new' records exist).
        Currently soft-asserted: reports observed count if below target."""
        r = client.get(f"{BASE_URL}/api/contacts?tab=pipeline&pipeline_status=new&limit=200")
        assert r.status_code == 200
        items = r.json()["items"]
        # Hard floor: must have at least 1 NEW pipeline record
        assert len(items) >= 1, "Expected at least 1 NEW pipeline contact"
        if len(items) < 24:
            pytest.fail(
                f"Expected ≥24 NEW pipeline contacts per iter12 spec, got {len(items)}. "
                "Iter12 14-licence sweep may not have run, or contacts were advanced past 'new'."
            )


# ─── Validation / dedupe ───────────────────────────────────────────────────────
class TestImportValidation:
    def test_invalid_target_400(self, client):
        r = client.post(f"{BASE_URL}/api/contacts/import", json={
            "target": "nonsense",
            "rows": [{"first_name": "Foo", "email": "foo_invalid_target@i12.test"}],
        })
        assert r.status_code == 400

    def test_empty_rows_400(self, client):
        r = client.post(f"{BASE_URL}/api/contacts/import", json={"target": "licence", "rows": []})
        assert r.status_code == 400

    def test_dedupe_skips_existing_email(self, client):
        email = "dedupe_test_iter12@i12.test"
        try:
            # Insert once
            r1 = client.post(f"{BASE_URL}/api/contacts/import", json={
                "target": "licence",
                "rows": [{"first_name": "DedupeOne", "email": email, "date": _today()}],
            })
            assert r1.status_code == 200
            assert r1.json()["inserted"] == 1

            # Second import same email → dedupe
            r2 = client.post(f"{BASE_URL}/api/contacts/import", json={
                "target": "licence",
                "rows": [{"first_name": "DedupeTwo", "email": email, "date": _today()}],
                "dedupe_by_email": True,
            })
            assert r2.status_code == 200
            assert r2.json()["inserted"] == 0
            assert r2.json()["skipped_duplicate"] == 1
        finally:
            for tab in ("pipeline", "licence"):
                r = client.get(f"{BASE_URL}/api/contacts?tab={tab}&limit=2000")
                for x in r.json().get("items", []):
                    if (x.get("email") or "").lower() == email:
                        client.delete(f"{BASE_URL}/api/contacts/{x['id']}")


# ─── Sally Hare restore safety ───────────────────────────────────────────────
def test_sally_hare_still_new(client):
    """Spec says don't break Sally — verify she's still pipeline_status=new."""
    sid = "937bbeb7-6571-474e-a3c2-0237235cdba3"
    r = client.get(f"{BASE_URL}/api/contacts/{sid}")
    if r.status_code != 200:
        pytest.skip(f"Sally not reachable: {r.status_code}")
    c = r.json().get("contact") or r.json()
    assert c.get("pipeline_status") == "new", f"Sally state should be 'new', got {c.get('pipeline_status')}"
    assert (c.get("source") or "") == "licence_enquiry"
