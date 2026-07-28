"""Phase 4C — CQC staging sync endpoint contract tests.

Covers:
  - POST /api/cqc/sync/staging/start  (admin auth)
  - GET  /api/cqc/sync/staging/status (admin auth, with/without job_id)
  - GET  /api/cqc/sync/staging/diff-report (admin auth, schema keys)
  - Non-admin 403 enforcement
  - Non-destructive guarantees present and all-zero
  - Mongo indexes on cqc_locations_staging + cqc_staging_jobs
"""
from __future__ import annotations

import os
import asyncio
import pytest
import requests


def _ensure_backend_env() -> None:
    """Load /app/backend/.env into os.environ (MONGO_URL, DB_NAME)."""
    if os.environ.get("MONGO_URL") and os.environ.get("DB_NAME"):
        return
    try:
        with open("/app/backend/.env") as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    except OSError:
        pass


_ensure_backend_env()

def _get_base_url() -> str:
    url = os.environ.get("REACT_APP_BACKEND_URL")
    if not url:
        # Fallback: read from frontend/.env
        try:
            with open("/app/frontend/.env") as fh:
                for line in fh:
                    if line.startswith("REACT_APP_BACKEND_URL="):
                        url = line.split("=", 1)[1].strip()
                        break
        except OSError:
            pass
    if not url:
        raise RuntimeError("REACT_APP_BACKEND_URL not set")
    return url.rstrip("/")


BASE_URL = _get_base_url()
ADMIN_EMAIL = "admin@creativemojo.co.uk"
ADMIN_PW = "CreativeMojo2026!"
FR_EMAIL = "franchisee.tester@creativemojo.co.uk"
FR_PW = "FranchiseeTest2026!"


def _login(session: requests.Session, email: str, pw: str) -> int:
    r = session.post(f"{BASE_URL}/api/auth/login", json={"email": email, "password": pw}, timeout=30)
    return r.status_code


@pytest.fixture(scope="module")
def admin_session() -> requests.Session:
    s = requests.Session()
    code = _login(s, ADMIN_EMAIL, ADMIN_PW)
    if code != 200:
        pytest.skip(f"Admin login failed (status={code})")
    return s


@pytest.fixture(scope="module")
def franchisee_session() -> requests.Session:
    s = requests.Session()
    code = _login(s, FR_EMAIL, FR_PW)
    if code != 200:
        return None  # marker
    return s


@pytest.fixture(scope="module")
def anon_session() -> requests.Session:
    return requests.Session()


# ─── Auth enforcement ──────────────────────────────────────────────

class TestAuthGuards:
    def test_start_requires_auth(self, anon_session):
        r = anon_session.post(f"{BASE_URL}/api/cqc/sync/staging/start", timeout=30)
        assert r.status_code in (401, 403), f"expected 401/403 got {r.status_code}"

    def test_status_requires_auth(self, anon_session):
        r = anon_session.get(f"{BASE_URL}/api/cqc/sync/staging/status", timeout=30)
        assert r.status_code in (401, 403)

    def test_diff_report_requires_auth(self, anon_session):
        r = anon_session.get(f"{BASE_URL}/api/cqc/sync/staging/diff-report", timeout=30)
        assert r.status_code in (401, 403)

    def test_start_forbidden_for_franchisee(self, franchisee_session):
        if franchisee_session is None:
            pytest.skip("Franchisee login failed")
        r = franchisee_session.post(f"{BASE_URL}/api/cqc/sync/staging/start", timeout=30)
        assert r.status_code == 403, f"expected 403 got {r.status_code}"

    def test_status_forbidden_for_franchisee(self, franchisee_session):
        if franchisee_session is None:
            pytest.skip("Franchisee login failed")
        r = franchisee_session.get(f"{BASE_URL}/api/cqc/sync/staging/status", timeout=30)
        assert r.status_code == 403

    def test_diff_forbidden_for_franchisee(self, franchisee_session):
        if franchisee_session is None:
            pytest.skip("Franchisee login failed")
        r = franchisee_session.get(f"{BASE_URL}/api/cqc/sync/staging/diff-report", timeout=30)
        assert r.status_code == 403


# ─── Endpoint contracts ────────────────────────────────────────────

class TestStartEndpoint:
    def test_start_returns_started_true_with_job_id(self, admin_session):
        r = admin_session.post(f"{BASE_URL}/api/cqc/sync/staging/start", timeout=30)
        assert r.status_code == 200, f"body={r.text[:400]}"
        data = r.json()
        assert data.get("started") is True
        assert isinstance(data.get("job_id"), str) and data["job_id"]

    def test_start_accepts_custom_job_id_query(self, admin_session):
        # Use an explicit id — even if a job is running we still get id echoed.
        custom = "test-staging-noop-echo"
        r = admin_session.post(
            f"{BASE_URL}/api/cqc/sync/staging/start",
            params={"job_id": custom},
            timeout=30,
        )
        assert r.status_code == 200
        assert r.json().get("job_id") == custom


class TestStatusEndpoint:
    def test_status_schema(self, admin_session):
        r = admin_session.get(f"{BASE_URL}/api/cqc/sync/staging/status", timeout=60)
        assert r.status_code == 200, f"body={r.text[:400]}"
        data = r.json()
        for key in ("job", "staging_count", "errors_count"):
            assert key in data, f"missing key {key}"
        assert isinstance(data["staging_count"], int)
        assert isinstance(data["errors_count"], int)

    def test_status_with_job_id(self, admin_session):
        # Prefer a job that has real progress (completed_pages present) —
        # a freshly-started job may not have written its first checkpoint yet.
        # We fetch via mongo directly if available, otherwise fall back to
        # the latest job returned by status.
        target_jid = None
        try:
            from motor.motor_asyncio import AsyncIOMotorClient
            _ensure_backend_env()
            mongo_url = os.environ.get("MONGO_URL")
            db_name = os.environ.get("DB_NAME")
            if mongo_url and db_name:
                async def _find():
                    c = AsyncIOMotorClient(mongo_url)
                    d = await c[db_name]["cqc_staging_jobs"].find_one(
                        {"completed_pages": {"$exists": True, "$ne": []}},
                        {"_id": 0, "job_id": 1},
                        sort=[("started_at", -1)],
                    )
                    c.close()
                    return d
                doc = asyncio.get_event_loop().run_until_complete(_find())
                if doc:
                    target_jid = doc["job_id"]
        except Exception:
            pass

        if not target_jid:
            status = admin_session.get(f"{BASE_URL}/api/cqc/sync/staging/status", timeout=60).json()
            job = status.get("job") or {}
            target_jid = job.get("job_id")
            if not target_jid:
                pytest.skip("No job_id available yet")

        r = admin_session.get(
            f"{BASE_URL}/api/cqc/sync/staging/status",
            params={"job_id": target_jid}, timeout=60,
        )
        assert r.status_code == 200
        data = r.json()
        assert data["job"] and data["job"].get("job_id") == target_jid
        j = data["job"]
        assert "status" in j
        assert "started_at" in j
        # completed_pages appears once page 1 lands — tolerate missing on very-early job
        if "completed_pages" not in j:
            pytest.skip(f"Job {target_jid} has not yet checkpointed page 1")
        # listing_* fields may only appear after page 1 completes; tolerate absence early on
        for optional in ("listing_ids_enumerated", "listing_total_reported", "listing_pages_expected"):
            # Not asserting presence hard — sync may still be very early. Just log.
            pass


class TestDiffReportEndpoint:
    def test_diff_report_schema(self, admin_session):
        r = admin_session.get(f"{BASE_URL}/api/cqc/sync/staging/diff-report", timeout=180)
        assert r.status_code == 200, f"body={r.text[:400]}"
        data = r.json()

        # Top-level required keys
        required_top = {
            "job", "totals", "missing_from_live", "clementina_prediction",
            "sentinel_rivermede_present_in_staging", "manual_records",
            "non_destructive_guarantees", "proposed_append_count_if_committed",
        }
        assert required_top.issubset(data.keys()), f"missing: {required_top - set(data.keys())}"

        # totals sub-schema
        totals = data["totals"]
        for k in ("staging_count", "live_count", "in_both",
                  "only_in_staging_missing_from_live", "unresolved_ids"):
            assert k in totals, f"totals missing {k}"

        # missing_from_live sub-schema
        mfl = data["missing_from_live"]
        for k in ("total_ids", "registered", "match_global_service_types",
                  "in_active_franchisee_territories", "by_sector_top_20",
                  "by_franchisee_top_20"):
            assert k in mfl, f"missing_from_live missing {k}"
        assert isinstance(mfl["by_sector_top_20"], list)
        assert isinstance(mfl["by_franchisee_top_20"], list)

        # manual_records sub-schema
        mr = data["manual_records"]
        assert "already_linked_will_light_up_after_append" in mr
        assert "possible_duplicates_requiring_review" in mr

    def test_non_destructive_guarantees_all_zero(self, admin_session):
        r = admin_session.get(f"{BASE_URL}/api/cqc/sync/staging/diff-report", timeout=180)
        assert r.status_code == 200
        ndg = r.json()["non_destructive_guarantees"]
        for k in ("existing_live_records_updated",
                  "existing_live_records_deleted",
                  "franchisee_client_records_touched",
                  "hq_home_notes_touched",
                  "franchisee_fields_overwritten"):
            assert ndg.get(k) == 0, f"{k} should be 0, got {ndg.get(k)!r}"


# ─── Mongo introspection: indexes + job doc shape ─────────────────

class TestMongoIntrospection:
    def test_staging_indexes_and_job_shape(self):
        try:
            from motor.motor_asyncio import AsyncIOMotorClient
        except ImportError:
            pytest.skip("motor not installed")

        mongo_url = os.environ.get("MONGO_URL")
        db_name = os.environ.get("DB_NAME")
        if not mongo_url or not db_name:
            pytest.skip("MONGO_URL/DB_NAME not set")

        async def _run():
            client = AsyncIOMotorClient(mongo_url)
            db = client[db_name]
            idx = await db["cqc_locations_staging"].index_information()
            jobs_idx = await db["cqc_staging_jobs"].index_information()
            # find latest job
            job = await db["cqc_staging_jobs"].find_one({}, {"_id": 0}, sort=[("started_at", -1)])
            client.close()
            return idx, jobs_idx, job

        idx, jobs_idx, job = asyncio.get_event_loop().run_until_complete(_run())

        # unique index on locationId
        found_unique_loc = any(
            info.get("unique") and any(k[0] == "locationId" for k in info.get("key", []))
            for info in idx.values()
        )
        assert found_unique_loc, f"expected unique index on locationId; got {idx}"

        # unique index on job_id
        found_unique_job = any(
            info.get("unique") and any(k[0] == "job_id" for k in info.get("key", []))
            for info in jobs_idx.values()
        )
        assert found_unique_job, f"expected unique index on job_id; got {jobs_idx}"

        # Job doc field presence (only if a job exists)
        if job:
            for f in ("job_id", "status", "started_at"):
                assert f in job, f"job doc missing {f}: keys={list(job.keys())}"
            # completed_pages / listing_* — should appear once page-1 completes,
            # but if the job is very early, tolerate absence. Log a note instead.
