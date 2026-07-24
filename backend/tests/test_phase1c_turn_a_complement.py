"""Phase 1C Turn A — complementary coverage.

Complements ``test_phase1c_turn_a.py`` with the extra assertions the
review request calls out but the primary suite doesn't already cover:

* Marker library ``TERRITORY_MAP_URL`` full spec + total (29 seed
  entries).
* ``/approve`` on a non-existent template → 404.
* ``/approve`` with a corrupted source-PDF SHA on the DB record → 400
  with the "SHA-256 in object store does not match" blocker. The
  mutation is reverted at test teardown so no state leaks.
* Auto-retire only affects templates of the SAME contract_type — a
  freshly-approved sibling of a DIFFERENT type stays approved.
* ``/retire`` audit event persisted.
* ``versions`` list sort order + shape.
* Contracts list filters + GET 404.
* PATCH / DELETE on a non-draft → 400.
* Freeze on a franchisee with an empty ``territory_ids`` list → 400.
* Public snapshot: unauthenticated works, ``secure_token`` never
  leaked in the public body, wrong snapshot_id → 404, tile shape
  scrubbed to ``{id, postcode, county, airtable_id}``.
* Admin snapshots list omits the heavy ``territory_docs`` field.
* Regression: Paloma template stays ``draft``, evidence-pack ZIP
  still valid, marker library still has 29 entries.
"""
from __future__ import annotations

import io
import os
import time
import zipfile
from typing import Any, Dict, List

import fitz
import pytest
import requests
from pymongo import MongoClient

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")
ADMIN_EMAIL = "admin@creativemojo.co.uk"
ADMIN_PASSWORD = "CreativeMojo2026!"
PALOMA_TEMPLATE_ID = "c12c8ce1-423b-4667-b5f7-da897546fa23"

if not BASE_URL:
    raise RuntimeError("REACT_APP_BACKEND_URL must be set")


# --------------------------------------------------------------------
# Fixtures
# --------------------------------------------------------------------
@pytest.fixture(scope="session")
def admin_client() -> requests.Session:
    s = requests.Session()
    r = s.post(
        f"{BASE_URL}/api/auth/login",
        json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
        timeout=15,
    )
    assert r.status_code == 200, r.text
    tok = r.json().get("access_token") or r.json().get("token")
    s.headers.update({"Authorization": f"Bearer {tok}"})
    return s


@pytest.fixture(scope="session")
def mongo_db():
    # Read Mongo config from backend/.env — this test file is executed
    # in the same container as the backend, so localhost is fine.
    from dotenv import dotenv_values
    cfg = dotenv_values("/app/backend/.env")
    url = cfg["MONGO_URL"].strip('"')
    name = cfg["DB_NAME"].strip('"')
    client = MongoClient(url)
    yield client[name]
    client.close()


def _mini_pdf(marker: str = "AGREEMENT_DATE") -> bytes:
    doc = fitz.open()
    p = doc.new_page(width=595, height=842)
    p.insert_text((72, 120), f"AGREEMENT DATED [[{marker}]]", fontsize=11, fontname="helv")
    p.insert_text((72, 180), "Complementary Turn A test template.", fontsize=11, fontname="helv")
    b = doc.tobytes()
    doc.close()
    return b


def _wait_job(client, job_id, timeout=30):
    deadline = time.time() + timeout
    while time.time() < deadline:
        r = client.get(f"{BASE_URL}/api/admin/contract-templates/upload-jobs/{job_id}", timeout=10)
        assert r.status_code == 200
        j = r.json()
        if j.get("status") in ("complete", "failed"):
            return j
        time.sleep(0.3)
    raise AssertionError("upload job timed out")


def _upload_template(client, name: str, contract_type: str, marker: str = "AGREEMENT_DATE") -> str:
    files = {"pdf": (f"{name}.pdf", _mini_pdf(marker), "application/pdf")}
    data = {"name": name, "contract_type": contract_type}
    r = client.post(
        f"{BASE_URL}/api/admin/contract-templates/upload-marker-pdf",
        files=files, data=data, timeout=30,
    )
    assert r.status_code == 200, r.text
    job = _wait_job(client, r.json()["job_id"])
    assert job["status"] == "complete", job
    return job["template_id"]


# --------------------------------------------------------------------
# Marker library
# --------------------------------------------------------------------
class TestMarkerLibrary:
    def test_territory_map_url_seed_shape(self, admin_client):
        r = admin_client.get(f"{BASE_URL}/api/admin/markers-library", timeout=15)
        assert r.status_code == 200, r.text
        body = r.json()
        items = body["items"] if isinstance(body, dict) else body
        # Total count = 29 approved seed entries
        assert len(items) == 29, f"Expected 29 seed markers, got {len(items)}"

        by_code = {m["code"]: m for m in items}
        assert "TERRITORY_MAP_URL" in by_code, "TERRITORY_MAP_URL not in library"
        m = by_code["TERRITORY_MAP_URL"]
        assert m["value_source"] == "system_generated"
        assert m["data_type"] == "hyperlink"
        assert m["formula"] == "frozen_territory_map_link"
        fmt = m.get("format") or {}
        assert fmt.get("display_text_default") == "View Agreed Territory Map"
        assert fmt.get("requires_frozen_snapshot") is True
        dp = m.get("default_presentation") or {}
        assert dp.get("wrapping") == "no_wrap"
        assert dp.get("min_font_size") == 11
        assert sorted(m["eligible_contract_types"]) == sorted(
            ["new_franchise", "franchise_renewal", "territory_amendment"]
        )


# --------------------------------------------------------------------
# Approve — negative paths
# --------------------------------------------------------------------
class TestApproveNegative:
    def test_approve_nonexistent_template_returns_404(self, admin_client):
        r = admin_client.post(
            f"{BASE_URL}/api/admin/contract-templates/does-not-exist-xyz/approve",
            timeout=15,
        )
        assert r.status_code == 404, r.text

    def test_approve_with_sha_mismatch_returns_400(self, admin_client, mongo_db):
        # Upload a fresh draft template we can mutate safely.
        tid = _upload_template(
            admin_client,
            name="phase1c-cmp-sha-mismatch",
            contract_type="new_franchise",
            marker="AGREEMENT_DATE",
        )
        # Grab the freshly-computed SHA (Mongo lookup is more reliable
        # than assuming the API surfaces it).
        col = mongo_db["contract_templates"]
        doc = col.find_one({"id": tid})
        assert doc, "uploaded template not found in Mongo"
        original_sha = doc["pdf_sha256"]
        try:
            col.update_one({"id": tid}, {"$set": {"pdf_sha256": "0" * 64}})
            r = admin_client.post(
                f"{BASE_URL}/api/admin/contract-templates/{tid}/approve",
                timeout=30,
            )
            assert r.status_code == 400, r.text
            body = r.json()
            # FastAPI packages detail under 'detail'
            blockers = (body.get("detail") or {}).get("blockers") or []
            joined = " ".join(blockers).lower()
            assert "sha-256 in object store does not match" in joined, blockers
        finally:
            # ALWAYS restore original SHA so state doesn't leak.
            col.update_one({"id": tid}, {"$set": {"pdf_sha256": original_sha}})
            # Also verify restoration is sane.
            restored = col.find_one({"id": tid})
            assert restored["pdf_sha256"] == original_sha


# --------------------------------------------------------------------
# Auto-retire scoping + retire endpoint audit
# --------------------------------------------------------------------
class TestAutoRetireScope:
    def test_auto_retire_only_same_contract_type(self, admin_client, mongo_db):
        # Approve template A of contract_type X (unique to avoid clobbering
        # module-level fixtures elsewhere).
        ctype_target = "territory_amendment"
        ctype_other = "licence"

        tid_a = _upload_template(admin_client, "cmp-autoretire-a", ctype_target)
        tid_b = _upload_template(admin_client, "cmp-autoretire-b", ctype_target)
        tid_other = _upload_template(admin_client, "cmp-autoretire-other", ctype_other)

        # Approve A + "other"
        r = admin_client.post(f"{BASE_URL}/api/admin/contract-templates/{tid_a}/approve", timeout=30)
        assert r.status_code == 200, r.text
        r = admin_client.post(f"{BASE_URL}/api/admin/contract-templates/{tid_other}/approve", timeout=30)
        assert r.status_code == 200, r.text

        # Approve B of SAME type → A should be auto-retired, "other" untouched
        r = admin_client.post(f"{BASE_URL}/api/admin/contract-templates/{tid_b}/approve", timeout=30)
        assert r.status_code == 200, r.text

        col = mongo_db["contract_templates"]
        assert col.find_one({"id": tid_a})["status"] == "retired"
        assert col.find_one({"id": tid_b})["status"] == "approved"
        assert col.find_one({"id": tid_other})["status"] == "approved", (
            "Different contract_type was incorrectly auto-retired"
        )

    def test_retire_endpoint_audit_and_idempotent(self, admin_client, mongo_db):
        tid = _upload_template(admin_client, "cmp-retire-audit", "licence_renewal")
        r = admin_client.post(f"{BASE_URL}/api/admin/contract-templates/{tid}/approve", timeout=30)
        assert r.status_code == 200

        r = admin_client.post(f"{BASE_URL}/api/admin/contract-templates/{tid}/retire", timeout=15)
        assert r.status_code == 200
        assert r.json()["status"] == "retired"
        assert r.json().get("retired_at")

        # Idempotent
        r2 = admin_client.post(f"{BASE_URL}/api/admin/contract-templates/{tid}/retire", timeout=15)
        assert r2.status_code == 200
        assert r2.json()["status"] == "retired"

        # Audit event persisted
        audit = list(mongo_db["contract_template_audit"].find(
            {"template_id": tid, "action": "template.retire"}
        ))
        assert audit, "template.retire audit event not written"


# --------------------------------------------------------------------
# Versions endpoint shape
# --------------------------------------------------------------------
class TestVersionsEndpoint:
    def test_versions_sorted_desc_and_shape(self, admin_client):
        tid = _upload_template(admin_client, "cmp-versions", "new_franchise")
        r = admin_client.post(f"{BASE_URL}/api/admin/contract-templates/{tid}/approve", timeout=30)
        assert r.status_code == 200

        r = admin_client.get(
            f"{BASE_URL}/api/admin/contract-templates/{tid}/versions", timeout=15,
        )
        assert r.status_code == 200
        items = r.json()["items"]
        assert items, "versions list empty"
        vnums = [it.get("version_number") for it in items]
        assert vnums == sorted(vnums, reverse=True), f"not sorted desc: {vnums}"
        # First item is the frozen approved version
        assert items[0].get("frozen_at") is not None
        # Snapshot fields the reviewer called out
        assert "markers" in items[0] or "marker_summary" in items[0], (
            "version snapshot missing markers/marker_summary keys"
        )


# --------------------------------------------------------------------
# Contracts CRUD — filters + status guards
# --------------------------------------------------------------------
@pytest.fixture(scope="module")
def approved_template_module(admin_client):
    tid = _upload_template(admin_client, "cmp-approved-fixture", "other")
    r = admin_client.post(f"{BASE_URL}/api/admin/contract-templates/{tid}/approve", timeout=30)
    assert r.status_code == 200
    return r.json()


@pytest.fixture(scope="module")
def franchisee_with_territory(admin_client):
    r = admin_client.get(f"{BASE_URL}/api/franchisees?limit=500", timeout=15)
    assert r.status_code == 200
    body = r.json()
    items = body.get("items") if isinstance(body, dict) else body
    for f in items or []:
        if f.get("territory_ids"):
            return f
    pytest.skip("No franchisee with territory_ids in DB")


class TestContractsFiltersAndGuards:
    def test_list_filters_and_get_404(self, admin_client, approved_template_module, franchisee_with_territory):
        r = admin_client.post(
            f"{BASE_URL}/api/admin/contracts",
            json={
                "template_id": approved_template_module["id"],
                "franchisee_id": franchisee_with_territory["id"],
                "monthly_fee": 42.0,
            },
            timeout=15,
        )
        assert r.status_code == 200, r.text
        cid = r.json()["id"]

        # Filter by template_id
        r = admin_client.get(
            f"{BASE_URL}/api/admin/contracts",
            params={"template_id": approved_template_module["id"]},
            timeout=15,
        )
        assert r.status_code == 200
        assert any(c["id"] == cid for c in r.json()["items"])

        # Filter by franchisee_id
        r = admin_client.get(
            f"{BASE_URL}/api/admin/contracts",
            params={"franchisee_id": franchisee_with_territory["id"]},
            timeout=15,
        )
        assert r.status_code == 200
        assert any(c["id"] == cid for c in r.json()["items"])

        # Filter by status=draft
        r = admin_client.get(
            f"{BASE_URL}/api/admin/contracts", params={"status": "draft"}, timeout=15,
        )
        assert r.status_code == 200
        assert any(c["id"] == cid for c in r.json()["items"])

        # GET non-existent → 404
        r = admin_client.get(f"{BASE_URL}/api/admin/contracts/no-such-id", timeout=15)
        assert r.status_code == 404

        # Cleanup this draft
        r = admin_client.delete(f"{BASE_URL}/api/admin/contracts/{cid}", timeout=15)
        assert r.status_code == 200

    def test_patch_status_field_rejected_and_unknown_fields_listed(
        self, admin_client, approved_template_module, franchisee_with_territory,
    ):
        r = admin_client.post(
            f"{BASE_URL}/api/admin/contracts",
            json={
                "template_id": approved_template_module["id"],
                "franchisee_id": franchisee_with_territory["id"],
            },
            timeout=15,
        )
        cid = r.json()["id"]
        try:
            # PATCH status → 400
            r = admin_client.patch(
                f"{BASE_URL}/api/admin/contracts/{cid}",
                json={"status": "issued"}, timeout=15,
            )
            assert r.status_code == 400
            # PATCH unknown field → 400 and lists offender
            r = admin_client.patch(
                f"{BASE_URL}/api/admin/contracts/{cid}",
                json={"totally_bogus_field": "x"}, timeout=15,
            )
            assert r.status_code == 400
            assert "totally_bogus_field" in r.text
            # PATCH multiple allow-listed fields — verify updated_at/by move
            r0 = admin_client.get(f"{BASE_URL}/api/admin/contracts/{cid}", timeout=15)
            before_updated_at = r0.json()["updated_at"]
            time.sleep(0.05)
            r = admin_client.patch(
                f"{BASE_URL}/api/admin/contracts/{cid}",
                json={
                    "monthly_fee": 199.99,
                    "special_terms": "cmp test clause",
                    "hq_signatory_name": "Test HQ",
                },
                timeout=15,
            )
            assert r.status_code == 200
            body = r.json()
            assert body["monthly_fee"] == 199.99
            assert body["special_terms"] == "cmp test clause"
            assert body["hq_signatory_name"] == "Test HQ"
            assert body["updated_by"] == ADMIN_EMAIL
            assert body["updated_at"] > before_updated_at
        finally:
            admin_client.delete(f"{BASE_URL}/api/admin/contracts/{cid}", timeout=15)


class TestNonDraftGuards:
    def test_patch_and_delete_reject_non_draft(
        self, admin_client, mongo_db, approved_template_module, franchisee_with_territory,
    ):
        r = admin_client.post(
            f"{BASE_URL}/api/admin/contracts",
            json={
                "template_id": approved_template_module["id"],
                "franchisee_id": franchisee_with_territory["id"],
            },
            timeout=15,
        )
        cid = r.json()["id"]
        try:
            # Directly flip status → issued in Mongo so we can test guards.
            mongo_db["contracts"].update_one(
                {"id": cid}, {"$set": {"status": "issued"}},
            )
            r = admin_client.patch(
                f"{BASE_URL}/api/admin/contracts/{cid}",
                json={"monthly_fee": 1.0}, timeout=15,
            )
            assert r.status_code == 400
            assert "only drafts can be edited" in r.text.lower()

            r = admin_client.delete(f"{BASE_URL}/api/admin/contracts/{cid}", timeout=15)
            assert r.status_code == 400
            assert "only drafts can be deleted" in r.text.lower()
        finally:
            mongo_db["contracts"].delete_one({"id": cid})


# --------------------------------------------------------------------
# Freeze territory — negative + public read hardening
# --------------------------------------------------------------------
class TestFreezeAndPublicRead:
    def test_freeze_refuses_when_no_territory_ids(
        self, admin_client, mongo_db, approved_template_module,
    ):
        # Find a franchisee with empty territory_ids; if none exists,
        # synthesise one via Mongo. Then create draft against it.
        franchisees = mongo_db["franchisees"]
        f = franchisees.find_one({"$or": [{"territory_ids": []}, {"territory_ids": None}]})
        synthesised = False
        if not f:
            # Grab any franchisee and clone into a synthetic one with no territories.
            template_f = franchisees.find_one({})
            assert template_f, "no franchisees at all in DB"
            fid = f"TEST-cmp-no-territory-{int(time.time()*1000)}"
            f = dict(template_f)
            f.pop("_id", None)
            f["id"] = fid
            f["territory_ids"] = []
            franchisees.insert_one(f)
            synthesised = True
        try:
            r = admin_client.post(
                f"{BASE_URL}/api/admin/contracts",
                json={
                    "template_id": approved_template_module["id"],
                    "franchisee_id": f["id"],
                },
                timeout=15,
            )
            assert r.status_code == 200, r.text
            cid = r.json()["id"]
            try:
                r = admin_client.post(
                    f"{BASE_URL}/api/admin/contracts/{cid}/freeze-territory",
                    timeout=15,
                )
                assert r.status_code == 400, r.text
                assert "no territory tiles" in r.text.lower()
            finally:
                admin_client.delete(f"{BASE_URL}/api/admin/contracts/{cid}", timeout=15)
        finally:
            if synthesised:
                franchisees.delete_one({"id": f["id"]})

    def test_public_snapshot_scrubbed_and_no_token_leak(
        self, admin_client, approved_template_module, franchisee_with_territory,
    ):
        # Create + freeze
        r = admin_client.post(
            f"{BASE_URL}/api/admin/contracts",
            json={
                "template_id": approved_template_module["id"],
                "franchisee_id": franchisee_with_territory["id"],
            },
            timeout=15,
        )
        cid = r.json()["id"]
        try:
            r = admin_client.post(
                f"{BASE_URL}/api/admin/contracts/{cid}/freeze-territory", timeout=30,
            )
            assert r.status_code == 200, r.text
            c = r.json()
            snap_id = c["frozen_territory_snapshot_id"]
            url = c["frozen_territory_map_url"]
            token = url.rsplit("/", 1)[-1]
            assert c.get("frozen_territory_by") == ADMIN_EMAIL
            assert c.get("frozen_territory_at")

            # Public read WITHOUT auth
            public_sess = requests.Session()
            r = public_sess.get(
                f"{BASE_URL}/api/territory-snapshots/{snap_id}/{token}", timeout=15,
            )
            assert r.status_code == 200, r.text
            body = r.json()
            assert body["snapshot_id"] == snap_id
            assert body["tile_count"] >= 1
            # secure_token MUST NOT appear anywhere in the body
            assert "secure_token" not in body
            assert token not in r.text, "secure_token leaked in public response body"
            # Tiles scrubbed to {id, postcode, county, airtable_id}
            allowed = {"id", "postcode", "county", "airtable_id"}
            for tile in body["territory_tiles"]:
                extra = set(tile.keys()) - allowed
                assert not extra, f"public tile leaks extra fields: {extra}"

            # Wrong token → 404
            r = public_sess.get(
                f"{BASE_URL}/api/territory-snapshots/{snap_id}/deadbeef-wrong",
                timeout=15,
            )
            assert r.status_code == 404
            # Wrong snapshot_id → 404 (same shape as wrong token)
            r = public_sess.get(
                f"{BASE_URL}/api/territory-snapshots/00000000000000000000000000000000/{token}",
                timeout=15,
            )
            assert r.status_code == 404

            # Admin read — full doc with secure_token + territory_docs
            r = admin_client.get(
                f"{BASE_URL}/api/admin/territory-snapshots/{snap_id}", timeout=15,
            )
            assert r.status_code == 200
            adoc = r.json()
            assert adoc["secure_token"] == token
            assert isinstance(adoc.get("territory_docs"), list)
            assert adoc["tile_count"] == len(adoc["territory_docs"])
            assert adoc["tile_count"] > 0
            for t in adoc["territory_docs"]:
                assert "id" in t and "postcode" in t

            # Admin list — kept light (no territory_docs)
            r = admin_client.get(
                f"{BASE_URL}/api/admin/territory-snapshots",
                params={"franchisee_id": franchisee_with_territory["id"]},
                timeout=15,
            )
            assert r.status_code == 200
            for item in r.json()["items"]:
                assert "territory_docs" not in item, "list should not include territory_docs"
        finally:
            # Contract with a frozen snapshot is still a draft in Turn A —
            # deletion should still work.
            admin_client.delete(f"{BASE_URL}/api/admin/contracts/{cid}", timeout=15)


# --------------------------------------------------------------------
# Regression on Phase 1B
# --------------------------------------------------------------------
class TestPhase1BRegression:
    def test_paloma_template_still_draft(self, admin_client):
        r = admin_client.get(
            f"{BASE_URL}/api/admin/contract-templates/{PALOMA_TEMPLATE_ID}", timeout=15,
        )
        assert r.status_code == 200, r.text
        assert r.json()["status"] == "draft", (
            "Paloma template must not have been auto-approved/retired"
        )

    def test_paloma_evidence_pack_still_returns_zip(self, admin_client):
        r = admin_client.post(
            f"{BASE_URL}/api/admin/contract-templates/{PALOMA_TEMPLATE_ID}/evidence-pack",
            timeout=60,
        )
        assert r.status_code == 200, r.text
        # Must be a valid ZIP
        z = zipfile.ZipFile(io.BytesIO(r.content))
        names = set(z.namelist())
        # Sanity — at least the canonical files
        expected = {"README.md", "manifest.json", "source.pdf", "preview.pdf", "markers.csv"}
        assert expected.issubset(names), f"missing files: {expected - names}"

    def test_marker_library_still_29(self, admin_client):
        r = admin_client.get(f"{BASE_URL}/api/admin/markers-library", timeout=15)
        assert r.status_code == 200
        items = r.json()["items"] if isinstance(r.json(), dict) else r.json()
        assert len(items) == 29
