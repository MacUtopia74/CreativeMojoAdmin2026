"""Phase 1C Turn B — Complementary coverage.

Fills gaps in test_phase1c_turn_b.py against review-request checklist:

* MONTHLY_FEE Decimal quantisation (99.999 → £100.00) — no float drift.
* Provenance shape on frozen values (source + resolver + format_applied).
* Refresh audit trail: contract_audit collection entry with reason +
  both hashes, and refresh_history[0] full field-set.
* Refresh on a contract with no prior freeze → 400 mentioning
  /resolve-variables.
* AGREEMENT_DATE / CONTRACT_REFERENCE via the /preview endpoint with
  HQ overrides (source flips accordingly).
* Phase 1B / Turn A regression — Paloma template stays draft; marker
  library still 29 seed entries; TERRITORY_MAP_URL is present in the
  seed catalogue with the correct shape.
"""
from __future__ import annotations

import os
import time

import fitz
import pytest
import requests

import contract_value_resolver as cvr
import contract_markers_library as lib


BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")
ADMIN_EMAIL = "admin@creativemojo.co.uk"
ADMIN_PASSWORD = "CreativeMojo2026!"
PALOMA_TEMPLATE_ID = "c12c8ce1-423b-4667-b5f7-da897546fa23"

if not BASE_URL:
    raise RuntimeError("REACT_APP_BACKEND_URL must be set")


# ------------------------------------------------------------------
# Helpers (mirror the primary file so this can run standalone)
# ------------------------------------------------------------------
def _library_for(codes):
    return [e for e in lib.SEED_MARKERS if e["code"] in codes]


def _make_template(codes):
    return {
        "id": "tpl-x",
        "pdf_sha256": "a" * 64,
        "approved_version": 1,
        "markers": [
            {"code": c, "page": 1, "occurrence_id": f"occ-{c}"} for c in codes
        ],
    }


def _make_franchisee(**overrides):
    base = {
        "id": "franchisee-1",
        "first_name": "Paloma",
        "last_name": "Ibarra",
        "organisation": "Creative Mojo Sample Area",
        "mojo_email": "paloma@creativemojo.co.uk",
        "mobile_phone": "07777 000 111",
        "address_street": "2 Wordsworth Cottages",
        "city": "Robertsbridge",
        "county": "East Sussex",
        "postcode": "tn32 5jg",
        "country": "United Kingdom",
        "franchise_number": "0094",
        "territory_ids": ["t1"],
    }
    base.update(overrides)
    return base


def _make_contract(**overrides):
    base = {
        "id": "contract-1",
        "template_id": "tpl-x",
        "franchisee_id": "franchisee-1",
        "monthly_fee": 113.30,
        "commencement_date": "2026-08-01",
        "franchisee_legal_name": "Paloma Ibarra Limited",
        "hq_signatory_name": "Emma Creative",
        "hq_signatory_title": "Director",
        "agreement_date": None,
        "contract_reference": None,
    }
    base.update(overrides)
    return base


# ==================================================================
# LAYER 1 — Pure resolver — quantisation + provenance
# ==================================================================
class TestMonthlyFeeQuantisation:
    def test_no_float_drift_ceilings_to_two_dp(self):
        """99.999 must round HALF_UP to £100.00 — Decimal, not float."""
        report = cvr.resolve_contract_variables(
            _make_template(["MONTHLY_FEE"]),
            _make_contract(monthly_fee=99.999),
            _make_franchisee(),
            _library_for(["MONTHLY_FEE"]),
        )
        assert report.is_valid(), report.errors
        assert report.resolved["MONTHLY_FEE"].value == "£100.00"

    def test_exact_two_dp_stable(self):
        report = cvr.resolve_contract_variables(
            _make_template(["MONTHLY_FEE"]),
            _make_contract(monthly_fee=1000),
            _make_franchisee(),
            _library_for(["MONTHLY_FEE"]),
        )
        assert report.resolved["MONTHLY_FEE"].value == "£1,000.00"

    def test_null_monthly_fee_errors(self):
        report = cvr.resolve_contract_variables(
            _make_template(["MONTHLY_FEE"]),
            _make_contract(monthly_fee=None),
            _make_franchisee(),
            _library_for(["MONTHLY_FEE"]),
        )
        assert not report.is_valid()
        assert any(e.code == "MONTHLY_FEE" for e in report.errors)


class TestProvenanceShapePure:
    def test_every_resolved_value_carries_source_resolver_format(self):
        codes = [
            "AGREEMENT_DATE",
            "FRANCHISEE_LEGAL_NAME",
            "FRANCHISEE_ORGANISATION",
            "MONTHLY_FEE",
        ]
        report = cvr.resolve_contract_variables(
            _make_template(codes),
            _make_contract(),
            _make_franchisee(),
            _library_for(codes),
        )
        assert report.is_valid(), report.errors
        for code in codes:
            rv = report.resolved[code]
            # Every provenance triple should be populated
            assert rv.source, f"{code} missing .source"
            assert rv.resolver, f"{code} missing .resolver"
            assert rv.format_applied is not None, f"{code} missing .format_applied"


# ==================================================================
# LAYER 2 — Live-backend refresh audit + provenance + preview
# ==================================================================
@pytest.fixture(scope="module")
def admin_client():
    s = requests.Session()
    r = s.post(
        f"{BASE_URL}/api/auth/login",
        json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
        timeout=15,
    )
    assert r.status_code == 200
    tok = r.json().get("token") or r.json().get("access_token")
    s.headers.update({"Authorization": f"Bearer {tok}"})
    return s


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


def _pdf_with(codes):
    doc = fitz.open()
    p = doc.new_page(width=595, height=842)
    y = 100
    for c in codes:
        p.insert_text((72, y), f"[[{c}]]", fontsize=11, fontname="helv")
        y += 30
    b = doc.tobytes()
    doc.close()
    return b


@pytest.fixture(scope="module")
def approved_template_licence_renewal(admin_client):
    """Own contract_type so we don't cross-retire the primary suite's licence template."""
    pdf = _pdf_with([
        "AGREEMENT_DATE",
        "FRANCHISEE_LEGAL_NAME",
        "FRANCHISEE_ORGANISATION",
        "MONTHLY_FEE",
        "CONTRACT_REFERENCE",
    ])
    r = admin_client.post(
        f"{BASE_URL}/api/admin/contract-templates/upload-marker-pdf",
        files={"pdf": ("turn-b-cmp.pdf", pdf, "application/pdf")},
        data={"name": "phase1c-turn-b-cmp", "contract_type": "licence_renewal"},
        timeout=30,
    )
    assert r.status_code == 200, r.text
    job = _wait_job(admin_client, r.json()["job_id"])
    tid = job["template_id"]
    r = admin_client.post(
        f"{BASE_URL}/api/admin/contract-templates/{tid}/approve", timeout=30
    )
    assert r.status_code == 200, r.text
    return r.json()


@pytest.fixture(scope="module")
def franchisee(admin_client):
    r = admin_client.get(f"{BASE_URL}/api/franchisees?limit=500", timeout=15)
    assert r.status_code == 200
    body = r.json()
    items = body.get("items") if isinstance(body, dict) else body
    for f in items or []:
        if f.get("territory_ids") and f.get("franchise_number"):
            return f
    pytest.skip("No suitable franchisee found.")


class TestRefreshWithoutPriorFreeze:
    def test_refresh_before_resolve_returns_400(
        self, admin_client, approved_template_licence_renewal, franchisee,
    ):
        r = admin_client.post(
            f"{BASE_URL}/api/admin/contracts",
            json={
                "template_id": approved_template_licence_renewal["id"],
                "franchisee_id": franchisee["id"],
                "monthly_fee": 250.00,
                "franchisee_legal_name": "Test Legal Ltd",
            },
            timeout=15,
        )
        assert r.status_code == 200, r.text
        cid = r.json()["id"]
        r = admin_client.post(
            f"{BASE_URL}/api/admin/contracts/{cid}/refresh-variables",
            json={"reason": "Trying to refresh without freeze"},
            timeout=15,
        )
        assert r.status_code == 400
        assert "/resolve-variables" in r.text or "resolve-variables" in r.text.lower()


class TestFullFreezeProvenanceAndAudit:
    """One contract carries all assertions for provenance shape,
    refresh_history full fields, and the contract_audit collection
    entry — cheaper than one fixture per assertion."""

    def _setup(self, admin_client, template, franchisee):
        r = admin_client.post(
            f"{BASE_URL}/api/admin/contracts",
            json={
                "template_id": template["id"],
                "franchisee_id": franchisee["id"],
                "monthly_fee": 250.00,
                "franchisee_legal_name": "Complement Test Ltd",
                "hq_signatory_name": "Emma Creative",
                "hq_signatory_title": "Director",
            },
            timeout=15,
        )
        assert r.status_code == 200, r.text
        return r.json()["id"]

    def test_full_flow(
        self, admin_client, approved_template_licence_renewal, franchisee,
    ):
        cid = self._setup(admin_client, approved_template_licence_renewal, franchisee)

        # ---- Freeze
        r = admin_client.post(
            f"{BASE_URL}/api/admin/contracts/{cid}/resolve-variables",
            timeout=30,
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["ok"] is True
        first_sha = body["values_sha256"]
        first_resolved_at = body.get("resolved_at")
        first_resolved_by = body.get("resolved_by")
        assert first_resolved_at
        assert first_resolved_by
        # Provenance shape check on frozen values
        for code, rv in body["values"].items():
            assert "source" in rv, f"{code} frozen without .source"
            assert "resolver" in rv, f"{code} frozen without .resolver"
            assert "format_applied" in rv, f"{code} frozen without .format_applied"
        assert body["refresh_history"] == []

        # ---- Modify a contract field then refresh
        r = admin_client.patch(
            f"{BASE_URL}/api/admin/contracts/{cid}",
            json={"monthly_fee": 300.00},
            timeout=15,
        )
        assert r.status_code == 200, r.text
        r = admin_client.post(
            f"{BASE_URL}/api/admin/contracts/{cid}/refresh-variables",
            json={"reason": "HQ corrected monthly fee to £300"},
            timeout=30,
        )
        assert r.status_code == 200, r.text
        body2 = r.json()
        assert body2["values"]["MONTHLY_FEE"]["value"] == "£300.00"
        assert len(body2["refresh_history"]) == 1
        h = body2["refresh_history"][0]

        # Refresh history full field-set
        assert h["reason"].startswith("HQ corrected")
        assert h["previous_values_sha256"] == first_sha
        assert h["previous_resolved_at"] == first_resolved_at
        assert h["previous_resolved_by"] == first_resolved_by
        assert h.get("refreshed_at")
        assert h.get("refreshed_by")
        assert body2["values_sha256"] != first_sha
        assert len(body2["values_sha256"]) == 64

        # ---- Audit collection entry — no public endpoint exposes
        # contract_audit; verify directly via Mongo.
        from motor.motor_asyncio import AsyncIOMotorClient
        from dotenv import load_dotenv
        import asyncio
        load_dotenv("/app/backend/.env")
        mongo_url = os.environ["MONGO_URL"]
        db_name = os.environ["DB_NAME"]

        async def _fetch_audit():
            client = AsyncIOMotorClient(mongo_url)
            try:
                docs = await client[db_name]["contract_audit"].find(
                    {"contract_id": cid, "action": "contract.variables.refresh"}
                ).to_list(length=10)
                return docs
            finally:
                client.close()

        events = asyncio.get_event_loop().run_until_complete(_fetch_audit())
        assert events, "No contract.variables.refresh audit event found in contract_audit"
        latest = events[-1]
        extra = latest.get("extra") or {}
        assert extra.get("reason", "").startswith("HQ corrected")
        assert extra.get("previous_values_sha256") == first_sha
        assert extra.get("values_sha256") == body2["values_sha256"]
        assert latest.get("actor") == ADMIN_EMAIL


class TestPreviewOverrides:
    """The /preview endpoint should reflect HQ overrides on
    system-generated markers without persisting anything."""

    def test_agreement_date_override_via_preview(
        self, admin_client, approved_template_licence_renewal, franchisee,
    ):
        r = admin_client.post(
            f"{BASE_URL}/api/admin/contracts",
            json={
                "template_id": approved_template_licence_renewal["id"],
                "franchisee_id": franchisee["id"],
                "monthly_fee": 200.00,
                "franchisee_legal_name": "Preview Override Ltd",
                "agreement_date": "2027-01-15",
                "contract_reference": "cm-legacy-9999",
            },
            timeout=15,
        )
        assert r.status_code == 200
        cid = r.json()["id"]

        r = admin_client.post(
            f"{BASE_URL}/api/admin/contracts/{cid}/variables/preview",
            timeout=30,
        )
        assert r.status_code == 200, r.text
        body = r.json()
        values = body["values"]
        # AGREEMENT_DATE override reflected
        assert values["AGREEMENT_DATE"]["value"] == "15 January 2027"
        assert values["AGREEMENT_DATE"]["source"] == "contracts.agreement_date"
        # CONTRACT_REFERENCE override reflected + uppercased
        assert values["CONTRACT_REFERENCE"]["value"] == "CM-LEGACY-9999"
        assert values["CONTRACT_REFERENCE"]["source"] == "contracts.contract_reference"
        # Preview must not persist
        r = admin_client.get(f"{BASE_URL}/api/admin/contracts/{cid}", timeout=15)
        assert r.json()["contract_variables"] is None


# ==================================================================
# LAYER 3 — Phase 1B / Turn A regression
# ==================================================================
class TestPhase1BAndTurnARegression:
    def test_marker_library_still_29_entries_with_territory_map(self):
        assert len(lib.SEED_MARKERS) == 29
        tm = next(m for m in lib.SEED_MARKERS if m["code"] == "TERRITORY_MAP_URL")
        assert tm["data_type"] == "hyperlink"
        assert tm["formula"] == "frozen_territory_map_link"
        assert tm.get("format", {}).get("requires_frozen_snapshot") is True
        assert "territory_amendment" in tm.get("eligible_contract_types", [])

    def test_paloma_template_still_draft(self, admin_client):
        r = admin_client.get(
            f"{BASE_URL}/api/admin/contract-templates/{PALOMA_TEMPLATE_ID}",
            timeout=15,
        )
        # 200 with status=draft; if 404 (template missing on this env)
        # skip rather than break the suite.
        if r.status_code == 404:
            pytest.skip("Paloma template not present on this environment.")
        assert r.status_code == 200, r.text
        assert r.json().get("status") == "draft"

    def test_markers_library_endpoint_lists_29(self, admin_client):
        r = admin_client.get(f"{BASE_URL}/api/admin/markers-library", timeout=15)
        assert r.status_code == 200
        body = r.json()
        items = body.get("items") if isinstance(body, dict) else body
        assert isinstance(items, list)
        assert len(items) == 29
        assert any(m["code"] == "TERRITORY_MAP_URL" for m in items)
