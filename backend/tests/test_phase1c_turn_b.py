"""Phase 1C Turn B — Contract Value Resolver.

Two layers:

* **Unit tests** on ``contract_value_resolver.resolve_contract_variables``
  with synthetic template / contract / franchisee / library data.
  These pin down date / currency / casing / hyperlink / hard-fail
  semantics without touching the DB or HTTP.
* **Integration tests** against the live preview backend covering the
  three endpoints:
    - ``POST /admin/contracts/{id}/variables/preview`` (dry-run)
    - ``POST /admin/contracts/{id}/resolve-variables`` (first freeze)
    - ``POST /admin/contracts/{id}/refresh-variables`` (HQ refresh)
  Also exercises: TERRITORY_MAP_URL hard-fail without a snapshot,
  refresh audit trail, and — critically — that later franchisee-profile
  edits DO NOT alter frozen contract_variables.
"""
from __future__ import annotations

import copy
import os
import time
from datetime import datetime, timezone

import fitz
import pytest
import requests

import contract_value_resolver as cvr


BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")
ADMIN_EMAIL = "admin@creativemojo.co.uk"
ADMIN_PASSWORD = "CreativeMojo2026!"

if not BASE_URL:
    raise RuntimeError("REACT_APP_BACKEND_URL must be set")


_STATE: dict = {}


# ============================================================
# LAYER 1 — PURE UNIT TESTS
# ============================================================
def _library_for(codes):
    """Return the library subset for the given codes — pulled straight
    from the seed catalogue so we test what the DB actually contains."""
    import contract_markers_library as lib
    return [e for e in lib.SEED_MARKERS if e["code"] in codes]


def _make_template(codes, template_id="tpl-x", pdf_sha="abc" * 20):
    return {
        "id": template_id,
        "pdf_sha256": pdf_sha,
        "approved_version": 1,
        "markers": [
            # A single occurrence per code is enough for the resolver
            {"code": c, "page": 1, "occurrence_id": f"occ-{c}"}
            for c in codes
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
        "address_street": "2 Wordsworth Cottages,",  # trailing comma to test cleanup
        "city": "Robertsbridge",
        "county": "East Sussex",
        "postcode": "tn32 5jg",  # lower-case → format should upper it
        "country": "United Kingdom",
        "franchise_number": "0094",
        "territory_ids": ["t1", "t2"],
    }
    base.update(overrides)
    return base


def _make_contract(**overrides):
    base = {
        "id": "contract-1",
        "template_id": "tpl-x",
        "franchisee_id": "franchisee-1",
        "monthly_fee": 113.30,
        "renewal_fee": 500.00,
        "contract_term_years": 10,
        "commencement_date": "2026-08-01",
        "renewal_date": "2036-07-31",
        "term_start_date": "2026-08-01",
        "franchisee_legal_name": "Paloma Ibarra Limited",
        "franchisee_company_number": "12345678",
        "franchisee_trading_address": "2 Wordsworth Cottages\nRobertsbridge\nTN32 5JG",
        "hq_signatory_name": "Emma Creative",
        "hq_signatory_title": "Director",
        "guarantor_name": "Alex Guarantor",
        "special_terms": "None.",
        "territory_description": "East Sussex — TN32 5JG postcode district.",
        "frozen_territory_snapshot_id": None,
        "frozen_territory_map_url": None,
        "frozen_territory_map_url_sha256": None,
        "agreement_date": None,
        "contract_reference": None,
    }
    base.update(overrides)
    return base


class TestResolverPureFranchiseeMarkers:
    def test_first_name_string_asis(self):
        template = _make_template(["FRANCHISEE_FIRST_NAME"])
        report = cvr.resolve_contract_variables(
            template, _make_contract(), _make_franchisee(),
            _library_for(["FRANCHISEE_FIRST_NAME"]),
            at=datetime(2026, 8, 1, tzinfo=timezone.utc),
        )
        assert report.is_valid(), report.errors
        rv = report.resolved["FRANCHISEE_FIRST_NAME"]
        assert rv.value == "Paloma"
        assert rv.source == "franchisees.first_name"
        assert rv.resolver == "auto:string"

    def test_full_name_assembled(self):
        template = _make_template(["FRANCHISEE_FULL_NAME"])
        report = cvr.resolve_contract_variables(
            template, _make_contract(), _make_franchisee(),
            _library_for(["FRANCHISEE_FULL_NAME"]),
            at=datetime(2026, 8, 1, tzinfo=timezone.utc),
        )
        assert report.is_valid()
        assert report.resolved["FRANCHISEE_FULL_NAME"].value == "Paloma Ibarra"
        assert report.resolved["FRANCHISEE_FULL_NAME"].source == "franchisees.full_name (assembled)"

    def test_postcode_casing_upper(self):
        template = _make_template(["FRANCHISEE_POSTCODE"])
        report = cvr.resolve_contract_variables(
            template, _make_contract(), _make_franchisee(),
            _library_for(["FRANCHISEE_POSTCODE"]),
        )
        # Library specifies casing='upper' — should upper-case the input
        assert report.resolved["FRANCHISEE_POSTCODE"].value == "TN32 5JG"

    def test_address_block_assembled_and_cleaned(self):
        template = _make_template(["FRANCHISEE_ADDRESS_BLOCK"])
        report = cvr.resolve_contract_variables(
            template, _make_contract(), _make_franchisee(),
            _library_for(["FRANCHISEE_ADDRESS_BLOCK"]),
        )
        assert report.is_valid()
        val = report.resolved["FRANCHISEE_ADDRESS_BLOCK"].value
        # Trailing comma cleaned; single-line comma-separated
        assert val == (
            "2 Wordsworth Cottages, Robertsbridge, "
            "East Sussex, tn32 5jg, United Kingdom"
        )

    def test_address_block_omits_missing(self):
        template = _make_template(["FRANCHISEE_ADDRESS_BLOCK"])
        franchisee = _make_franchisee(county=None, country=None)
        report = cvr.resolve_contract_variables(
            template, _make_contract(), franchisee,
            _library_for(["FRANCHISEE_ADDRESS_BLOCK"]),
        )
        val = report.resolved["FRANCHISEE_ADDRESS_BLOCK"].value
        # No double commas, no trailing separator
        assert val == "2 Wordsworth Cottages, Robertsbridge, tn32 5jg"
        assert ",," not in val
        assert not val.endswith(",")


class TestResolverContractSpecificMarkers:
    def test_monthly_fee_currency_gbp(self):
        template = _make_template(["MONTHLY_FEE"])
        report = cvr.resolve_contract_variables(
            template, _make_contract(monthly_fee=1234.5), _make_franchisee(),
            _library_for(["MONTHLY_FEE"]),
        )
        assert report.is_valid()
        rv = report.resolved["MONTHLY_FEE"]
        assert rv.value == "£1,234.50"
        assert rv.raw_value == 1234.5
        assert rv.resolver == "auto:currency"

    def test_commencement_date_formatted(self):
        template = _make_template(["COMMENCEMENT_DATE"])
        report = cvr.resolve_contract_variables(
            template, _make_contract(), _make_franchisee(),
            _library_for(["COMMENCEMENT_DATE"]),
        )
        assert report.resolved["COMMENCEMENT_DATE"].value == "1 August 2026"
        assert report.resolved["COMMENCEMENT_DATE"].raw_value == "2026-08-01"

    def test_manual_marker_from_contract(self):
        template = _make_template(["FRANCHISEE_LEGAL_NAME"])
        report = cvr.resolve_contract_variables(
            template, _make_contract(), _make_franchisee(),
            _library_for(["FRANCHISEE_LEGAL_NAME"]),
        )
        rv = report.resolved["FRANCHISEE_LEGAL_NAME"]
        assert rv.value == "Paloma Ibarra Limited"
        assert rv.source == "contracts.franchisee_legal_name"
        assert rv.resolver == "manual:string"

    def test_missing_manual_marker_errors(self):
        template = _make_template(["FRANCHISEE_LEGAL_NAME"])
        report = cvr.resolve_contract_variables(
            template, _make_contract(franchisee_legal_name=None), _make_franchisee(),
            _library_for(["FRANCHISEE_LEGAL_NAME"]),
        )
        assert not report.is_valid()
        assert any(e.code == "FRANCHISEE_LEGAL_NAME" for e in report.errors)

    def test_missing_automatic_contract_marker_errors(self):
        template = _make_template(["MONTHLY_FEE"])
        report = cvr.resolve_contract_variables(
            template, _make_contract(monthly_fee=None), _make_franchisee(),
            _library_for(["MONTHLY_FEE"]),
        )
        assert not report.is_valid()
        assert any(e.code == "MONTHLY_FEE" for e in report.errors)

    def test_integer_marker(self):
        template = _make_template(["CONTRACT_TERM_YEARS"])
        report = cvr.resolve_contract_variables(
            template, _make_contract(contract_term_years=10), _make_franchisee(),
            _library_for(["CONTRACT_TERM_YEARS"]),
        )
        assert report.resolved["CONTRACT_TERM_YEARS"].value == "10"
        assert report.resolved["CONTRACT_TERM_YEARS"].raw_value == 10

    def test_multiline_special_terms(self):
        template = _make_template(["SPECIAL_TERMS"])
        report = cvr.resolve_contract_variables(
            template,
            _make_contract(special_terms="Clause A.\nClause B.\nClause C."),
            _make_franchisee(),
            _library_for(["SPECIAL_TERMS"]),
        )
        rv = report.resolved["SPECIAL_TERMS"]
        assert rv.value == "Clause A.\nClause B.\nClause C."
        assert rv.resolver == "manual:multiline"


class TestSystemGeneratedMarkers:
    def test_agreement_date_defaults_to_issue_date(self):
        template = _make_template(["AGREEMENT_DATE"])
        report = cvr.resolve_contract_variables(
            template, _make_contract(), _make_franchisee(),
            _library_for(["AGREEMENT_DATE"]),
            at=datetime(2026, 8, 1, tzinfo=timezone.utc),
        )
        assert report.resolved["AGREEMENT_DATE"].value == "1 August 2026"
        assert report.resolved["AGREEMENT_DATE"].source == "system:issue_date"

    def test_agreement_date_hq_override_wins(self):
        template = _make_template(["AGREEMENT_DATE"])
        report = cvr.resolve_contract_variables(
            template, _make_contract(agreement_date="2027-01-15"), _make_franchisee(),
            _library_for(["AGREEMENT_DATE"]),
            at=datetime(2026, 8, 1, tzinfo=timezone.utc),
        )
        rv = report.resolved["AGREEMENT_DATE"]
        assert rv.value == "15 January 2027"
        assert rv.source == "contracts.agreement_date"
        assert rv.warning and "override" in rv.warning.lower()

    def test_contract_reference_auto_generated(self):
        template = _make_template(["CONTRACT_REFERENCE"])
        report = cvr.resolve_contract_variables(
            template, _make_contract(), _make_franchisee(franchise_number="94"),
            _library_for(["CONTRACT_REFERENCE"]),
            at=datetime(2026, 8, 1, tzinfo=timezone.utc),
        )
        rv = report.resolved["CONTRACT_REFERENCE"]
        assert rv.value == "CM-2026-0094"
        assert rv.source == "system:cm_year_franchise_ref"
        # Uses issue year from `at`, not calendar today
        assert rv.format_applied["template"] == "CM-{year}-{franchise_number}"

    def test_contract_reference_uses_agreement_override_year(self):
        template = _make_template(["CONTRACT_REFERENCE"])
        # HQ overrode agreement_date → issue year comes from that
        report = cvr.resolve_contract_variables(
            template,
            _make_contract(agreement_date="2027-04-10"),
            _make_franchisee(franchise_number="94"),
            _library_for(["CONTRACT_REFERENCE"]),
            at=datetime(2026, 8, 1, tzinfo=timezone.utc),
        )
        assert report.resolved["CONTRACT_REFERENCE"].value == "CM-2027-0094"

    def test_contract_reference_hq_override_wins(self):
        template = _make_template(["CONTRACT_REFERENCE"])
        report = cvr.resolve_contract_variables(
            template,
            _make_contract(contract_reference="cm-legacy-0001"),
            _make_franchisee(),
            _library_for(["CONTRACT_REFERENCE"]),
        )
        rv = report.resolved["CONTRACT_REFERENCE"]
        # casing=upper applied
        assert rv.value == "CM-LEGACY-0001"
        assert rv.source == "contracts.contract_reference"


class TestTerritoryMapHyperlinkHardFail:
    def test_hard_fail_when_no_snapshot(self):
        template = _make_template(["TERRITORY_MAP_URL"])
        report = cvr.resolve_contract_variables(
            template, _make_contract(), _make_franchisee(),
            _library_for(["TERRITORY_MAP_URL"]),
        )
        assert not report.is_valid()
        err = next(e for e in report.errors if e.code == "TERRITORY_MAP_URL")
        assert "frozen territory snapshot" in err.reason.lower()
        assert err.hint and "freeze-territory" in err.hint.lower()
        # Nothing is put into `resolved` for this code — fail hard
        assert "TERRITORY_MAP_URL" not in report.resolved

    def test_happy_path_when_snapshot_frozen(self):
        template = _make_template(["TERRITORY_MAP_URL"])
        contract = _make_contract(
            frozen_territory_snapshot_id="snap-xyz",
            frozen_territory_map_url="https://hub.creativemojo.co.uk/agreed-territory/snap-xyz/tok",
            frozen_territory_map_url_sha256="a" * 64,
        )
        report = cvr.resolve_contract_variables(
            template, contract, _make_franchisee(),
            _library_for(["TERRITORY_MAP_URL"]),
        )
        assert report.is_valid()
        rv = report.resolved["TERRITORY_MAP_URL"]
        assert isinstance(rv.value, dict)
        assert rv.value["url"].startswith("https://hub.creativemojo.co.uk/agreed-territory/")
        assert rv.value["snapshot_id"] == "snap-xyz"
        assert rv.value["display"] == "View Agreed Territory Map"
        assert rv.resolver == "system:frozen_territory_map_link"

    def test_display_text_override_wins(self):
        template = _make_template(["TERRITORY_MAP_URL"])
        contract = _make_contract(
            frozen_territory_snapshot_id="snap-xyz",
            frozen_territory_map_url="https://hub.creativemojo.co.uk/agreed-territory/snap-xyz/tok",
            frozen_territory_map_url_sha256="a" * 64,
            frozen_territory_map_url_display_text="View my agreed territory",
        )
        # Add the display-text field to DRAFT_EDITABLE_FIELDS runtime schema
        report = cvr.resolve_contract_variables(
            template, contract, _make_franchisee(),
            _library_for(["TERRITORY_MAP_URL"]),
        )
        assert report.resolved["TERRITORY_MAP_URL"].value["display"] == "View my agreed territory"


class TestResolverEdgeCases:
    def test_unknown_marker_code_errors(self):
        template = _make_template(["BOGUS_MARKER_CODE"])
        report = cvr.resolve_contract_variables(
            template, _make_contract(), _make_franchisee(), [],
        )
        assert not report.is_valid()
        assert any(e.code == "BOGUS_MARKER_CODE" for e in report.errors)

    def test_never_mutates_inputs(self):
        template = _make_template(["FRANCHISEE_FIRST_NAME"])
        contract = _make_contract()
        franchisee = _make_franchisee()
        c_before = copy.deepcopy(contract)
        f_before = copy.deepcopy(franchisee)
        cvr.resolve_contract_variables(
            template, contract, franchisee,
            _library_for(["FRANCHISEE_FIRST_NAME"]),
        )
        assert contract == c_before
        assert franchisee == f_before

    def test_full_paloma_suite_resolves(self):
        """All markers used by the Paloma template — verify a clean
        resolve with a fully-populated contract."""
        codes = [
            "AGREEMENT_DATE",
            "FRANCHISEE_LEGAL_NAME",
            "FRANCHISEE_ADDRESS_BLOCK",
            "FRANCHISEE_ORGANISATION",
            "MONTHLY_FEE",
        ]
        report = cvr.resolve_contract_variables(
            _make_template(codes), _make_contract(), _make_franchisee(),
            _library_for(codes),
            at=datetime(2026, 8, 1, tzinfo=timezone.utc),
        )
        assert report.is_valid(), report.errors
        assert set(report.resolved) == set(codes)


# ============================================================
# LAYER 2 — INTEGRATION AGAINST LIVE BACKEND
# ============================================================
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


def _mini_pdf_with_markers(codes):
    """Build a PDF that includes each marker code exactly once."""
    doc = fitz.open()
    p = doc.new_page(width=595, height=842)
    y = 100
    for c in codes:
        p.insert_text((72, y), f"[[{c}]]", fontsize=11, fontname="helv")
        y += 30
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


@pytest.fixture(scope="module")
def approved_template_no_territory(admin_client):
    """Approved template using markers that DON'T need TERRITORY_MAP_URL."""
    pdf = _mini_pdf_with_markers([
        "AGREEMENT_DATE",
        "FRANCHISEE_LEGAL_NAME",
        "FRANCHISEE_ORGANISATION",
        "MONTHLY_FEE",
    ])
    files = {"pdf": ("turn-b-noterr.pdf", pdf, "application/pdf")}
    # Use a contract_type NOT eligible for TERRITORY_MAP_URL so it can
    # never sneak into the template via 'other'-elligibility rules.
    data = {"name": "phase1c-turn-b-noterr", "contract_type": "licence"}
    r = admin_client.post(
        f"{BASE_URL}/api/admin/contract-templates/upload-marker-pdf",
        files=files, data=data, timeout=30,
    )
    assert r.status_code == 200
    job = _wait_job(admin_client, r.json()["job_id"])
    tid = job["template_id"]
    r = admin_client.post(
        f"{BASE_URL}/api/admin/contract-templates/{tid}/approve", timeout=30,
    )
    assert r.status_code == 200, r.text
    return r.json()


@pytest.fixture(scope="module")
def approved_template_with_territory(admin_client):
    """Approved template that includes TERRITORY_MAP_URL — resolver
    must hard-fail without a frozen snapshot."""
    pdf = _mini_pdf_with_markers([
        "AGREEMENT_DATE",
        "FRANCHISEE_LEGAL_NAME",
        "FRANCHISEE_ORGANISATION",
        "MONTHLY_FEE",
        "TERRITORY_MAP_URL",
    ])
    files = {"pdf": ("turn-b-withterr.pdf", pdf, "application/pdf")}
    # Use 'territory_amendment' — eligible for TERRITORY_MAP_URL and
    # disjoint from the 'licence' template above so approval doesn't
    # auto-retire either.
    data = {"name": "phase1c-turn-b-withterr", "contract_type": "territory_amendment"}
    r = admin_client.post(
        f"{BASE_URL}/api/admin/contract-templates/upload-marker-pdf",
        files=files, data=data, timeout=30,
    )
    assert r.status_code == 200
    job = _wait_job(admin_client, r.json()["job_id"])
    tid = job["template_id"]
    r = admin_client.post(
        f"{BASE_URL}/api/admin/contract-templates/{tid}/approve", timeout=30,
    )
    assert r.status_code == 200, r.text
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
    pytest.skip("No franchisee with territory_ids found in DB.")


class TestPreviewEndpoint:
    def test_preview_surfaces_errors_without_freezing(
        self, admin_client, approved_template_no_territory, franchisee_with_territory,
    ):
        # Draft with NO contract-specific values → many errors, no freeze
        r = admin_client.post(
            f"{BASE_URL}/api/admin/contracts",
            json={
                "template_id": approved_template_no_territory["id"],
                "franchisee_id": franchisee_with_territory["id"],
            },
            timeout=15,
        )
        assert r.status_code == 200
        cid = r.json()["id"]
        _STATE["cid_incomplete"] = cid
        r = admin_client.post(
            f"{BASE_URL}/api/admin/contracts/{cid}/variables/preview",
            timeout=30,
        )
        assert r.status_code == 200
        body = r.json()
        assert body["ok"] is False
        codes_in_errors = {e["code"] for e in body["errors"]}
        # MONTHLY_FEE + FRANCHISEE_LEGAL_NAME both missing on the draft
        assert "MONTHLY_FEE" in codes_in_errors
        assert "FRANCHISEE_LEGAL_NAME" in codes_in_errors
        # AGREEMENT_DATE + FRANCHISEE_ORGANISATION resolve regardless
        # (system + franchisee-record sourced)
        codes_in_values = set(body["values"].keys())
        assert "AGREEMENT_DATE" in codes_in_values
        assert "FRANCHISEE_ORGANISATION" in codes_in_values
        # Confirm nothing was frozen onto the contract
        r = admin_client.get(f"{BASE_URL}/api/admin/contracts/{cid}", timeout=15)
        assert r.json()["contract_variables"] is None


class TestResolveFreezeAndImmutability:
    def test_resolve_freezes_all_values(
        self, admin_client, approved_template_no_territory, franchisee_with_territory,
    ):
        r = admin_client.post(
            f"{BASE_URL}/api/admin/contracts",
            json={
                "template_id": approved_template_no_territory["id"],
                "franchisee_id": franchisee_with_territory["id"],
                "monthly_fee": 113.30,
                "franchisee_legal_name": "Paloma Ibarra Limited",
                "hq_signatory_name": "Emma Creative",
                "hq_signatory_title": "Director",
            },
            timeout=15,
        )
        assert r.status_code == 200
        cid = r.json()["id"]
        _STATE["cid_full"] = cid

        r = admin_client.post(
            f"{BASE_URL}/api/admin/contracts/{cid}/resolve-variables",
            timeout=30,
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["ok"] is True
        assert body["values"]["MONTHLY_FEE"]["value"] == "£113.30"
        assert body["values"]["FRANCHISEE_LEGAL_NAME"]["value"] == "Paloma Ibarra Limited"
        assert "values_sha256" in body and len(body["values_sha256"]) == 64
        _STATE["values_sha_v1"] = body["values_sha256"]
        # Confirm persisted
        r = admin_client.get(f"{BASE_URL}/api/admin/contracts/{cid}", timeout=15)
        cv = r.json()["contract_variables"]
        assert cv is not None
        assert cv["values"]["MONTHLY_FEE"]["value"] == "£113.30"
        assert cv["refresh_history"] == []

    def test_second_resolve_refused(self, admin_client):
        r = admin_client.post(
            f"{BASE_URL}/api/admin/contracts/{_STATE['cid_full']}/resolve-variables",
            timeout=15,
        )
        assert r.status_code == 400
        assert "refresh-variables" in r.text.lower()

    def test_franchisee_edit_after_freeze_does_not_alter_frozen(
        self, admin_client, franchisee_with_territory,
    ):
        """Change the franchisee's organisation on the Hub AFTER freeze —
        the contract's frozen variables must NOT change."""
        r = admin_client.get(f"{BASE_URL}/api/admin/contracts/{_STATE['cid_full']}", timeout=15)
        pre = r.json()["contract_variables"]["values"]["FRANCHISEE_ORGANISATION"]["value"]
        # Directly patch the franchisee's organisation
        r = admin_client.patch(
            f"{BASE_URL}/api/franchisees/{franchisee_with_territory['id']}",
            json={"organisation": "MUTATED AFTER FREEZE"},
            timeout=15,
        )
        assert r.status_code == 200, r.text
        try:
            # Frozen values must be unchanged
            r = admin_client.get(f"{BASE_URL}/api/admin/contracts/{_STATE['cid_full']}", timeout=15)
            post = r.json()["contract_variables"]["values"]["FRANCHISEE_ORGANISATION"]["value"]
            assert post == pre, (
                "Frozen contract_variables were altered by a franchisee edit — "
                "this violates the Turn B immutability contract."
            )
        finally:
            # Restore the franchisee record so subsequent tests aren't affected
            admin_client.patch(
                f"{BASE_URL}/api/franchisees/{franchisee_with_territory['id']}",
                json={"organisation": franchisee_with_territory.get("organisation") or ""},
                timeout=15,
            )


class TestRefreshVariables:
    def test_refresh_requires_reason(self, admin_client):
        r = admin_client.post(
            f"{BASE_URL}/api/admin/contracts/{_STATE['cid_full']}/refresh-variables",
            json={},
            timeout=15,
        )
        assert r.status_code == 400
        assert "reason" in r.text.lower()

    def test_refresh_updates_and_records_history(self, admin_client):
        # Change a contract-side field then refresh
        r = admin_client.patch(
            f"{BASE_URL}/api/admin/contracts/{_STATE['cid_full']}",
            json={"monthly_fee": 200.00},
            timeout=15,
        )
        assert r.status_code == 200
        r = admin_client.post(
            f"{BASE_URL}/api/admin/contracts/{_STATE['cid_full']}/refresh-variables",
            json={"reason": "Corrected monthly fee after HQ review."},
            timeout=30,
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["values"]["MONTHLY_FEE"]["value"] == "£200.00"
        assert len(body["refresh_history"]) == 1
        h = body["refresh_history"][0]
        assert h["reason"].startswith("Corrected monthly fee")
        assert h["previous_values_sha256"] == _STATE["values_sha_v1"]
        assert body["values_sha256"] != _STATE["values_sha_v1"]


class TestTerritoryMapHardFailIntegration:
    def test_resolve_rejects_when_snapshot_missing(
        self, admin_client, approved_template_with_territory, franchisee_with_territory,
    ):
        r = admin_client.post(
            f"{BASE_URL}/api/admin/contracts",
            json={
                "template_id": approved_template_with_territory["id"],
                "franchisee_id": franchisee_with_territory["id"],
                "monthly_fee": 113.30,
                "franchisee_legal_name": "Paloma Ibarra Limited",
            },
            timeout=15,
        )
        assert r.status_code == 200
        cid = r.json()["id"]
        _STATE["cid_territory"] = cid
        r = admin_client.post(
            f"{BASE_URL}/api/admin/contracts/{cid}/resolve-variables",
            timeout=30,
        )
        assert r.status_code == 400
        detail = r.json().get("detail", {})
        error_codes = {e["code"] for e in detail.get("errors", [])}
        assert "TERRITORY_MAP_URL" in error_codes
        # Contract must remain unfrozen
        r = admin_client.get(f"{BASE_URL}/api/admin/contracts/{cid}", timeout=15)
        assert r.json()["contract_variables"] is None

    def test_resolve_succeeds_after_freeze_territory(
        self, admin_client,
    ):
        r = admin_client.post(
            f"{BASE_URL}/api/admin/contracts/{_STATE['cid_territory']}/freeze-territory",
            timeout=30,
        )
        assert r.status_code == 200
        r = admin_client.post(
            f"{BASE_URL}/api/admin/contracts/{_STATE['cid_territory']}/resolve-variables",
            timeout=30,
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["ok"] is True
        tm = body["values"]["TERRITORY_MAP_URL"]
        assert isinstance(tm["value"], dict)
        assert tm["value"]["url"].startswith("https://hub.creativemojo.co.uk/agreed-territory/")
        assert tm["value"]["display"] == "View Agreed Territory Map"
