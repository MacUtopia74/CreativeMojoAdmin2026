#!/usr/bin/env bash
# =============================================================================
# Creative Mojo Admin — Phase A + Phase C Duplicate Diagnostics Runner (v4)
# =============================================================================
#
#   READ-ONLY DIAGNOSTICS ONLY. Every request is a GET or a dry-run POST
#   whose body cannot trigger a database write. No PATCH / PUT / DELETE.
#   No ``commit=true`` parameter. No archive / merge / repair / renumbering
#   route. No database command. See "REQUEST INVENTORY" below.
#
# -----------------------------------------------------------------------------
# CHANGES IN v4 (post the Aug-04 production run defects)
# -----------------------------------------------------------------------------
#   1. --show-requests output now goes to STDERR (was: leaking into the
#      $status capture and producing "[[: [req] ... 200: syntax error").
#   2. HTTP status is explicitly validated as a 3-digit numeric code before
#      any comparison — refuses to proceed on non-numeric output.
#   3. ``while read`` loops now tolerate the last line missing a trailing
#      newline (was: dropping the last group when python wrote 3 lines
#      joined by \n only — hence "3 queued, 2 completed").
#   4. Identity-resolution files use the FULL client_id in the name so two
#      IDs sharing the same 8-char prefix can no longer overwrite each other.
#   5. Explicit expected/completed counters — SUMMARY.json now includes:
#        duplicate_client_ids_detected, identity_resolutions_expected,
#        identity_resolutions_completed, duplicate_groups_detected,
#        merge_dry_runs_expected, merge_dry_runs_completed,
#        site_groups_detected, site_dry_runs_expected, site_dry_runs_completed
#      run_status == "OK" only when every expected count == its completed
#      count AND environment matches --require-environment (if set).
#   6. Environment-mismatch guard: pass --require-environment=production and
#      the runner aborts if any diagnostic response says otherwise.
#   7. Any curl error, non-2xx status, missing envelope field, or file that
#      failed to write is recorded in SUMMARY.json ``issues[]`` and returns
#      run_status="FAIL".
#
# -----------------------------------------------------------------------------
# REQUEST INVENTORY — every HTTP call this script can issue
# -----------------------------------------------------------------------------
#   GET  /api/admin/franchisees/by-number/0095
#        (standard admin lookup — validated as normal API response, not
#         a Phase A+C diagnostic envelope)
#
#   GET  /api/admin/diagnostics/homes-list-duplicates?home_name=…
#   GET  /api/admin/diagnostics/clients/duplicates?franchisee_id=…
#   GET  /api/admin/diagnostics/user-activity?franchisee_id=…&email=…&days=7
#   GET  /api/admin/diagnostics/clients/{client_id}/resolve-identity
#   POST /api/admin/diagnostics/dry-run/client-merge   (body: {"record_ids":[…]})
#   POST /api/admin/diagnostics/dry-run/site-group     (body: {"cqc_location_ids":[…]})
#
#   All six diagnostic responses are asserted to carry:
#     * write_performed === false
#     * diagnostic_version === phase-a+c-2026-08-04
#
# -----------------------------------------------------------------------------
# MODES
# -----------------------------------------------------------------------------
#   bash run_duplicate_diagnostics.sh                        # normal run
#   bash run_duplicate_diagnostics.sh --plan-only            # no network calls
#   bash run_duplicate_diagnostics.sh --show-requests        # verbose stderr
#   bash run_duplicate_diagnostics.sh --require-environment=production
#                                                            # abort if any
#                                                            # response reports
#                                                            # a different env
# =============================================================================
set -euo pipefail
{ set +x; } 2>/dev/null || true

EXPECTED_DIAG_VERSION="phase-a+c-2026-08-04"

PLAN_ONLY=0
SHOW_REQUESTS=0
REQUIRE_ENV=""
for arg in "$@"; do
  case "$arg" in
    --plan-only)                PLAN_ONLY=1 ;;
    --show-requests)            SHOW_REQUESTS=1 ;;
    --require-environment=*)    REQUIRE_ENV="${arg#*=}" ;;
    -h|--help)
      sed -n '2,90p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

# ---- Prereq checks (network-independent)
: "${API_URL:?export API_URL=\"https://hub.creativemojo.co.uk\" first}"
command -v python3 >/dev/null 2>&1 || { echo "ERROR: python3 not found" >&2; exit 2; }
command -v curl    >/dev/null 2>&1 || { echo "ERROR: curl not found"    >&2; exit 2; }

# ---- Plan-only mode
if [[ "${PLAN_ONLY}" -eq 1 ]]; then
  cat >&2 <<PLAN
==============================================================================
PLAN-ONLY MODE — no network calls will be made.
==============================================================================
API_URL             : ${API_URL}
Expected diagnostic : ${EXPECTED_DIAG_VERSION}
Require environment : ${REQUIRE_ENV:-<not set>}

Request plan (in order):

  [00]  GET  /api/admin/franchisees/by-number/0095
        → 00_resolve_sam.json          (standard API — no envelope)

  [01]  GET  /api/admin/diagnostics/homes-list-duplicates?home_name=Tunbridge%20Wells%20Care%20Centre&limit=50
        → 01_homes_tunbridge_wells.json

  [02]  GET  /api/admin/diagnostics/homes-list-duplicates?home_name=Wadhurst%20Manor&limit=50
        → 02_homes_wadhurst_manor.json

  [03]  GET  /api/admin/diagnostics/clients/duplicates?franchisee_id=<SAM_ID>&limit=500
        → 03_clients_duplicates_sam.json

  [04]  GET  /api/admin/diagnostics/user-activity?franchisee_id=<SAM_ID>&email=<SAM_EMAIL>&days=7
        → 04_user_activity_sam_7d.json

  For each unique client_record_id in file 03 (deduplicated across groups):
  [05]  GET  /api/admin/diagnostics/clients/{client_id}/resolve-identity
        → 05_resolve_<full-uuid>.json  (v4: full UUID, no 8-char collision)

  For each duplicate GROUP in file 03 (whole-group, one call per group):
  [06]  POST /api/admin/diagnostics/dry-run/client-merge
        body: {"record_ids": [<every id in the group>]}
        → 06_dry_run_merge_group_NN.json

  For each site GROUP in files 01 + 02 with ≥2 members:
  [07]  POST /api/admin/diagnostics/dry-run/site-group
        body: {"cqc_location_ids": [<every location_id in the group>]}
        → 07_dry_run_site_group_NN.json

  [F]   Local summary compilation → SUMMARY.json
        (includes expected vs completed counters; FAIL on any mismatch)

Envelope validation:
  * File 00 : HTTP 2xx AND has "records" list.
  * All 01..07 files: write_performed === false AND
                      diagnostic_version === ${EXPECTED_DIAG_VERSION}
                      (AND environment == "${REQUIRE_ENV}" if --require-environment set)

Permitted HTTP methods : GET, POST (dry-run only)
Forbidden methods      : PATCH, PUT, DELETE
Forbidden params       : commit=true (nowhere)
Forbidden routes       : /merge/commit, /repair, /rebind, /archive, /renumber

Only standard macOS tools used: bash, curl, python3, tar, shasum.
No scripts / binaries downloaded.
==============================================================================
PLAN
  exit 0
fi

# ---- Auth
if [[ -z "${ADMIN_TOKEN:-}" && -z "${ADMIN_COOKIE:-}" ]]; then
  echo "ERROR: export ADMIN_TOKEN=... or ADMIN_COOKIE=access_token=... before running." >&2
  exit 2
fi

SAM_EMAIL="${SAM_EMAIL:-sam.whiteman@creativemojo.co.uk}"
umask 077

# ---- Auth transport (curl -K config file, 600, never on the command line)
AUTH_CONFIG=$(mktemp -t cm-diag-auth.XXXXXX); chmod 600 "${AUTH_CONFIG}"
if [[ -n "${ADMIN_TOKEN:-}" ]]; then
  printf 'header = "Authorization: Bearer %s"\n' "${ADMIN_TOKEN}" > "${AUTH_CONFIG}"
  AUTH_METHOD="bearer_token"
else
  printf 'header = "Cookie: %s"\n' "${ADMIN_COOKIE}" > "${AUTH_CONFIG}"
  AUTH_METHOD="session_cookie"
fi

cleanup() {
  rm -f "${AUTH_CONFIG:-}" "${BODY_TMP:-}" 2>/dev/null || true
  unset ADMIN_TOKEN ADMIN_COOKIE EM PW 2>/dev/null || true
}
trap cleanup EXIT INT TERM HUP

BODY_TMP=$(mktemp -t cm-diag-body.XXXXXX); chmod 600 "${BODY_TMP}"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_DIR="./diagnostic_reports/${STAMP}"
mkdir -p "${OUT_DIR}"; chmod 700 "${OUT_DIR}"
echo "Writing reports to  : ${OUT_DIR}"
echo "Auth method         : ${AUTH_METHOD}"
[[ "${SHOW_REQUESTS}" -eq 1 ]] && echo "Show-requests       : ON (verbose stderr)"
[[ -n "${REQUIRE_ENV}"    ]] && echo "Require environment : ${REQUIRE_ENV}"
echo

# ============================================================================
# Helpers ---------------------------------------------------------------------
# ============================================================================

# --show-requests logging → STDERR ONLY so nothing leaks into $(status=...)
_show() {
  [[ "${SHOW_REQUESTS}" -eq 1 ]] && echo "[req] ${1} ${2} → ${3}" >&2 || true
}

# Runs curl and returns ONLY the 3-digit HTTP status code on stdout.
# Refuses to return non-numeric output.
_http_get() {
  local url="$1" out="$2" label="$3"
  _show "GET " "${url}" "${out}"
  local code
  if ! code=$(curl -sS -K "${AUTH_CONFIG}" \
                   -H "Accept: application/json" \
                   -o "${out}" -w "%{http_code}" "${url}" 2>>"${OUT_DIR}/_curl_stderr.log"); then
    echo "000"; return
  fi
  # Numeric sanity — 3 digits, else return 000
  if [[ "${code}" =~ ^[0-9]{3}$ ]]; then
    echo "${code}"
  else
    echo "000"
  fi
}

_http_post() {
  local url="$1" body_file="$2" out="$3" label="$4"
  _show "POST" "${url}" "${out}"
  local code
  if ! code=$(curl -sS -K "${AUTH_CONFIG}" \
                   -H "Accept: application/json" \
                   -H "Content-Type: application/json" \
                   --data-binary "@${body_file}" \
                   -X POST -o "${out}" -w "%{http_code}" "${url}" 2>>"${OUT_DIR}/_curl_stderr.log"); then
    echo "000"; return
  fi
  if [[ "${code}" =~ ^[0-9]{3}$ ]]; then echo "${code}"; else echo "000"; fi
}

_validate_diagnostic() {
  local label="$1" file="$2"
  EXPECTED_VER="${EXPECTED_DIAG_VERSION}" REQUIRE_ENV="${REQUIRE_ENV}" \
    python3 - "${label}" "${file}" <<'PY'
import json, os, sys
label, path = sys.argv[1], sys.argv[2]
expected = os.environ["EXPECTED_VER"]
require_env = os.environ.get("REQUIRE_ENV") or ""
try:
    d = json.load(open(path))
except Exception as e:
    print(f"[FAIL] {label} — non-JSON response ({e})", file=sys.stderr); sys.exit(3)
if "write_performed" not in d:
    print(f"[FAIL] {label} — response missing 'write_performed'", file=sys.stderr); sys.exit(3)
if d["write_performed"] is not False:
    print(f"[!!!!] {label} — write_performed = {d['write_performed']!r} — STOP AND ESCALATE", file=sys.stderr); sys.exit(3)
if d.get("diagnostic_version") != expected:
    print(f"[FAIL] {label} — diagnostic_version = {d.get('diagnostic_version')!r}, expected {expected!r}", file=sys.stderr); sys.exit(3)
if require_env and d.get("environment") != require_env:
    ee = d.get("environment_evidence", {})
    print(f"[FAIL] {label} — environment = {d.get('environment')!r}, expected {require_env!r}", file=sys.stderr)
    print(f"       resolved_host = {ee.get('resolved_host')!r} db_name = {ee.get('db_name')!r}", file=sys.stderr)
    sys.exit(3)
bits = ["write_performed=false", f"diag={d['diagnostic_version']}",
        f"env={d.get('environment')}",
        f"host={str(d.get('environment_evidence',{}).get('resolved_host',''))[:40]}",
        f"db={d.get('environment_evidence',{}).get('db_name')}",
        f"build={str(d.get('build_commit','?'))[:12]}"]
for k in ("group_count", "status", "proposed_survivor_id", "proposed_canonical_site_id"):
    if k in d: bits.append(f"{k}={d[k]}")
print(f"[ OK ] {label} — " + " ".join(bits))
PY
}

_validate_lookup() {
  local label="$1" file="$2"
  python3 - "${label}" "${file}" <<'PY'
import json, sys
label, path = sys.argv[1], sys.argv[2]
try: d = json.load(open(path))
except Exception as e:
    print(f"[FAIL] {label} — non-JSON response ({e})", file=sys.stderr); sys.exit(3)
if not isinstance(d, dict) or "records" not in d or not isinstance(d["records"], list):
    print(f"[FAIL] {label} — expected {{records: [...] }} shape", file=sys.stderr); sys.exit(3)
print(f"[ OK ] {label} — records={len(d['records'])}")
PY
}

run_get_diagnostic() {
  local label="$1" url="$2"
  local out="${OUT_DIR}/${label}.json"
  local status; status=$(_http_get "${url}" "${out}" "${label}")
  if [[ ! "${status}" =~ ^[0-9]{3}$ ]] || [[ "${status}" -lt 200 || "${status}" -ge 300 ]]; then
    echo "[FAIL] ${label} — HTTP ${status} — body at ${out}" >&2; return 1
  fi
  _validate_diagnostic "${label}" "${out}"
}

run_post_dry_run() {
  local label="$1" url="$2" body="$3"
  local out="${OUT_DIR}/${label}.json"
  printf '%s' "${body}" > "${BODY_TMP}"
  local status; status=$(_http_post "${url}" "${BODY_TMP}" "${out}" "${label}")
  if [[ ! "${status}" =~ ^[0-9]{3}$ ]] || [[ "${status}" -lt 200 || "${status}" -ge 300 ]]; then
    echo "[FAIL] ${label} — HTTP ${status} — body at ${out}" >&2; return 1
  fi
  _validate_diagnostic "${label}" "${out}"
}

# ============================================================================
# PHASE 0 — Resolve Sam
# ============================================================================
if [[ -n "${SAM_FRANCHISEE_ID:-}" ]]; then
  echo "[info] MANUAL OVERRIDE — SAM_FRANCHISEE_ID is set explicitly."
  echo "       No auto-resolution performed. Masked ID: ${SAM_FRANCHISEE_ID:0:8}…${SAM_FRANCHISEE_ID: -4}"
  echo
else
  echo "Resolving Sam's franchisee record from franchise_number=0095 ..."
  RESOLVE_OUT="${OUT_DIR}/00_resolve_sam.json"
  status=$(_http_get "${API_URL}/api/admin/franchisees/by-number/0095" "${RESOLVE_OUT}" "00_resolve_sam")
  if [[ ! "${status}" =~ ^[0-9]{3}$ ]] || [[ "${status}" -lt 200 || "${status}" -ge 300 ]]; then
    echo "[FAIL] Sam lookup — HTTP ${status} — body at ${RESOLVE_OUT}" >&2; exit 1
  fi
  _validate_lookup "00_resolve_sam" "${RESOLVE_OUT}"

  RESOLVED=$(python3 - "${RESOLVE_OUT}" <<'PY'
import json, sys
data = json.load(open(sys.argv[1]))
items = data.get("records") or []
def _name(fr):
    return " ".join([str(fr.get("first_name") or ""), str(fr.get("last_name") or "")]).strip()
if not items:
    print("STATUS=none"); sys.exit(0)
if len(items) > 1:
    print("STATUS=multi"); print(f"COUNT={len(items)}")
    for fr in items:
        print(f"  - id={str(fr.get('id','?'))[:8]}… name={_name(fr) or '?'} number={fr.get('franchise_number','?')} archived={fr.get('archived','?')}")
    sys.exit(0)
hit = items[0]
first = str(hit.get("first_name") or "").strip().lower()
last  = str(hit.get("last_name")  or "").strip().lower()
if last != "whiteman" or first not in ("samantha", "sam"):
    print("STATUS=one_wrong_name"); print(f"ID={hit.get('id','')}"); print(f"NAME={_name(hit) or '?'}"); print(f"NUMBER={hit.get('franchise_number','?')}")
    sys.exit(0)
print("STATUS=one"); print(f"ID={hit.get('id','')}"); print(f"NAME={_name(hit)}"); print(f"NUMBER={hit.get('franchise_number','')}")
PY
)
  echo "${RESOLVED}" > "${OUT_DIR}/00_resolve_sam.txt"
  case "$(echo "${RESOLVED}" | head -1 | cut -d= -f2)" in
    one)
      SAM_FRANCHISEE_ID=$(echo "${RESOLVED}" | awk -F= '/^ID=/{print $2; exit}')
      SAM_NAME=$(echo "${RESOLVED}"        | awk -F= '/^NAME=/{print $2; exit}')
      SAM_NUM=$(echo "${RESOLVED}"         | awk -F= '/^NUMBER=/{print $2; exit}')
      MASKED="${SAM_FRANCHISEE_ID:0:8}…${SAM_FRANCHISEE_ID: -4}"
      echo "[ OK ] Resolved: name=${SAM_NAME} franchise_number=${SAM_NUM} id=${MASKED}"
      echo ;;
    none)             echo "[FAIL] No franchisee found with franchise_number=0095. Aborting." >&2; exit 1 ;;
    one_wrong_name)
      echo "[FAIL] franchise_number=0095 resolves to ONE record but it is not Samantha Whiteman." >&2
      echo "       No name-based ranking is permitted. Aborting." >&2
      echo "${RESOLVED}" >&2; exit 1 ;;
    multi)
      echo "[FAIL] franchise_number=0095 is DUPLICATED. Aborting." >&2
      echo "${RESOLVED}" >&2; exit 1 ;;
    *) echo "[FAIL] Unexpected resolver output." >&2; echo "${RESOLVED}" >&2; exit 1 ;;
  esac
fi

# ============================================================================
# A. Homes-list duplicates + B. Sam client duplicates + user-activity
# ============================================================================
run_get_diagnostic "01_homes_tunbridge_wells" \
  "${API_URL}/api/admin/diagnostics/homes-list-duplicates?home_name=Tunbridge%20Wells%20Care%20Centre&limit=50"
run_get_diagnostic "02_homes_wadhurst_manor" \
  "${API_URL}/api/admin/diagnostics/homes-list-duplicates?home_name=Wadhurst%20Manor&limit=50"
run_get_diagnostic "03_clients_duplicates_sam" \
  "${API_URL}/api/admin/diagnostics/clients/duplicates?franchisee_id=${SAM_FRANCHISEE_ID}&limit=500"

SAM_EMAIL_ENC=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "${SAM_EMAIL}")
run_get_diagnostic "04_user_activity_sam_7d" \
  "${API_URL}/api/admin/diagnostics/user-activity?franchisee_id=${SAM_FRANCHISEE_ID}&email=${SAM_EMAIL_ENC}&days=7"

# ============================================================================
# C. Identity resolution for every duplicate client ID (deduplicated, full-UUID filename)
# ============================================================================
CLIENT_IDS_FILE="${OUT_DIR}/_client_ids.txt"
python3 - "${OUT_DIR}/03_clients_duplicates_sam.json" "${CLIENT_IDS_FILE}" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
seen, out = set(), []
for g in d.get("groups") or []:
    for r in g.get("records") or []:
        cid = r.get("client_record_id")
        if cid and cid not in seen:
            seen.add(cid); out.append(cid)
open(sys.argv[2], "w").write("\n".join(out) + ("\n" if out else ""))
print(f"[info] {len(out)} unique client IDs to resolve")
PY

DUP_CLIENT_COUNT=$(wc -l < "${CLIENT_IDS_FILE}" 2>/dev/null | tr -d ' \n' || true)
DUP_CLIENT_COUNT=${DUP_CLIENT_COUNT:-0}
RESOLVE_DONE=0
# Tolerate missing trailing newline (bug fixed in v4)
while IFS= read -r CID || [[ -n "${CID}" ]]; do
  [[ -z "${CID}" ]] && continue
  # v4: use the FULL client_id in the filename so two IDs sharing an
  # 8-char prefix cannot collide.
  if run_get_diagnostic "05_resolve_${CID}" \
      "${API_URL}/api/admin/diagnostics/clients/${CID}/resolve-identity"; then
    RESOLVE_DONE=$((RESOLVE_DONE + 1))
  else
    echo "[FAIL] identity-resolve for ${CID} failed — see log" >&2
    exit 1
  fi
done < "${CLIENT_IDS_FILE}"

# ============================================================================
# D. Dry-run client merges — whole-group, one call per duplicate group
# ============================================================================
GROUPS_FILE="${OUT_DIR}/_merge_groups.txt"
python3 - "${OUT_DIR}/03_clients_duplicates_sam.json" "${GROUPS_FILE}" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
lines = []
for g in d.get("groups") or []:
    ids = [r["client_record_id"] for r in (g.get("records") or []) if r.get("client_record_id")]
    if len(ids) >= 2:
        lines.append(",".join(ids))
open(sys.argv[2], "w").write("\n".join(lines) + ("\n" if lines else ""))
print(f"[info] {len(lines)} whole-group client-merge dry-runs queued")
PY

MERGE_GROUPS_EXPECTED=$(grep -c '.' "${GROUPS_FILE}" 2>/dev/null; true)
MERGE_GROUPS_EXPECTED=${MERGE_GROUPS_EXPECTED:-0}
MERGE_GROUPS_DONE=0
INDEX=0
while IFS= read -r LINE || [[ -n "${LINE}" ]]; do
  [[ -z "${LINE}" ]] && continue
  INDEX=$((INDEX+1))
  BODY=$(python3 -c "import json,sys;print(json.dumps({'record_ids':sys.argv[1].split(',')}))" "${LINE}")
  LABEL=$(printf '06_dry_run_merge_group_%02d' ${INDEX})
  if run_post_dry_run "${LABEL}" \
      "${API_URL}/api/admin/diagnostics/dry-run/client-merge" "${BODY}"; then
    MERGE_GROUPS_DONE=$((MERGE_GROUPS_DONE + 1))
  else
    echo "[FAIL] ${LABEL} failed" >&2; exit 1
  fi
done < "${GROUPS_FILE}"

# ============================================================================
# E. Dry-run site grouping — whole-group per homes-list group with ≥2 members
# ============================================================================
SITE_GROUPS_FILE="${OUT_DIR}/_site_groups.txt"
python3 - "${OUT_DIR}" "${SITE_GROUPS_FILE}" <<'PY'
import json, os, sys
outdir, dst = sys.argv[1], sys.argv[2]
lines = []
for name in ("01_homes_tunbridge_wells.json", "02_homes_wadhurst_manor.json"):
    p = os.path.join(outdir, name)
    if not os.path.exists(p): continue
    d = json.load(open(p))
    for g in d.get("groups") or []:
        ids = [m.get("cqc_location_id") for m in (g.get("members") or []) if m.get("cqc_location_id")]
        if len(ids) >= 2:
            lines.append(",".join(ids))
open(dst, "w").write("\n".join(lines) + ("\n" if lines else ""))
print(f"[info] {len(lines)} whole-group site dry-runs queued")
PY

SITE_GROUPS_EXPECTED=$(grep -c '.' "${SITE_GROUPS_FILE}" 2>/dev/null; true)
SITE_GROUPS_EXPECTED=${SITE_GROUPS_EXPECTED:-0}
SITE_GROUPS_DONE=0
INDEX=0
while IFS= read -r LINE || [[ -n "${LINE}" ]]; do
  [[ -z "${LINE}" ]] && continue
  INDEX=$((INDEX+1))
  BODY=$(python3 -c "import json,sys;print(json.dumps({'cqc_location_ids':sys.argv[1].split(',')}))" "${LINE}")
  LABEL=$(printf '07_dry_run_site_group_%02d' ${INDEX})
  if run_post_dry_run "${LABEL}" \
      "${API_URL}/api/admin/diagnostics/dry-run/site-group" "${BODY}"; then
    SITE_GROUPS_DONE=$((SITE_GROUPS_DONE + 1))
  else
    echo "[FAIL] ${LABEL} failed" >&2; exit 1
  fi
done < "${SITE_GROUPS_FILE}"

# ============================================================================
# F. Summary — expected vs completed counters + strict pass/fail
# ============================================================================
COUNTERS=$(python3 -c "
import json, sys
print(json.dumps({
  'duplicate_client_ids_detected'      : int(sys.argv[1] or 0),
  'identity_resolutions_expected'      : int(sys.argv[1] or 0),
  'identity_resolutions_completed'     : int(sys.argv[2] or 0),
  'duplicate_groups_detected'          : int(sys.argv[3] or 0),
  'merge_dry_runs_expected'            : int(sys.argv[3] or 0),
  'merge_dry_runs_completed'           : int(sys.argv[4] or 0),
  'site_groups_detected'               : int(sys.argv[5] or 0),
  'site_dry_runs_expected'             : int(sys.argv[5] or 0),
  'site_dry_runs_completed'            : int(sys.argv[6] or 0),
}))
" "${DUP_CLIENT_COUNT:-0}" "${RESOLVE_DONE:-0}" \
  "${MERGE_GROUPS_EXPECTED:-0}" "${MERGE_GROUPS_DONE:-0}" \
  "${SITE_GROUPS_EXPECTED:-0}" "${SITE_GROUPS_DONE:-0}")

COUNTERS_JSON="${COUNTERS}" REQUIRE_ENV="${REQUIRE_ENV}" \
  python3 - "${OUT_DIR}" "${EXPECTED_DIAG_VERSION}" <<'PY'
import glob, json, os, sys
outdir, expected = sys.argv[1], sys.argv[2]
counters = json.loads(os.environ["COUNTERS_JSON"])
require_env = os.environ.get("REQUIRE_ENV") or ""
summary = {
    "output_directory": outdir,
    "expected_diagnostic_version": expected,
    "required_environment": require_env or None,
    "safety": {
        "credentials_in_files": False,
        "write_performed_asserted_false_for_every_diagnostic": True,
    },
    "counters": counters,
    "files": {},
    "issues": [],
}
# --- Per-file envelope checks
for f in sorted(glob.glob(os.path.join(outdir, "*.json"))):
    base = os.path.basename(f)
    if base.startswith("_") or base == "SUMMARY.json":
        continue
    try:
        d = json.load(open(f))
    except Exception as e:
        summary["issues"].append(f"{base}: non-JSON ({e})")
        continue
    entry = {}
    if base.startswith("00_resolve_sam"):
        entry["kind"] = "lookup"
        entry["records"] = len((d or {}).get("records") or [])
    else:
        entry["kind"] = "diagnostic"
        for k in ("write_performed", "diagnostic_version", "build_commit", "environment"):
            entry[k] = d.get(k)
        ee = d.get("environment_evidence", {})
        entry["resolved_host"] = ee.get("resolved_host")
        entry["db_name"] = ee.get("db_name")
        for k in ("group_count", "status", "proposed_survivor_id", "proposed_canonical_site_id"):
            if k in d: entry[k] = d[k]
        if d.get("write_performed") is not False:
            summary["issues"].append(f"{base}: write_performed = {d.get('write_performed')!r}")
        if d.get("diagnostic_version") != expected:
            summary["issues"].append(f"{base}: diagnostic_version = {d.get('diagnostic_version')!r}")
        if require_env and d.get("environment") != require_env:
            summary["issues"].append(
                f"{base}: environment = {d.get('environment')!r}, "
                f"expected {require_env!r} — resolved_host={ee.get('resolved_host')!r} "
                f"db_name={ee.get('db_name')!r}"
            )
    summary["files"][base] = entry

# --- Counter checks
c = counters
if c["identity_resolutions_completed"] != c["identity_resolutions_expected"]:
    summary["issues"].append(
        f"identity_resolutions: expected={c['identity_resolutions_expected']} "
        f"completed={c['identity_resolutions_completed']}"
    )
if c["merge_dry_runs_completed"] != c["merge_dry_runs_expected"]:
    summary["issues"].append(
        f"merge_dry_runs: expected={c['merge_dry_runs_expected']} "
        f"completed={c['merge_dry_runs_completed']}"
    )
if c["site_dry_runs_completed"] != c["site_dry_runs_expected"]:
    summary["issues"].append(
        f"site_dry_runs: expected={c['site_dry_runs_expected']} "
        f"completed={c['site_dry_runs_completed']}"
    )

# --- curl stderr log — any content = failure
err_log = os.path.join(outdir, "_curl_stderr.log")
if os.path.exists(err_log) and os.path.getsize(err_log) > 0:
    summary["issues"].append(f"curl produced diagnostic output — see _curl_stderr.log")

summary["run_status"] = "FAIL" if summary["issues"] else "OK"
with open(os.path.join(outdir, "SUMMARY.json"), "w") as fp:
    json.dump(summary, fp, indent=2)
print()
print("=== SUMMARY ===")
print(json.dumps(summary, indent=2))
if summary["issues"]:
    print("\n[FAIL] Issues detected — DO NOT PROCEED. See above.", file=sys.stderr)
    sys.exit(3)
PY

echo
echo "=========================================================="
echo "DONE. Reports written to: ${OUT_DIR}"
echo "SUMMARY: ${OUT_DIR}/SUMMARY.json"
echo
echo "Every diagnostic response asserted:"
echo "  * write_performed == false"
echo "  * diagnostic_version == ${EXPECTED_DIAG_VERSION}"
[[ -n "${REQUIRE_ENV}" ]] && echo "  * environment == ${REQUIRE_ENV}"
echo
echo "Package for sharing (credentials are NOT inside this folder):"
echo "  tar -czf production-diagnostics-${STAMP}.tar.gz -C \"$(dirname "${OUT_DIR}")\" \"$(basename "${OUT_DIR}")\""
echo
echo "STOP HERE. Share the archive back for review BEFORE any Phase B / D"
echo "repair is authorised."
echo "=========================================================="
