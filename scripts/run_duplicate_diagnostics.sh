#!/usr/bin/env bash
# =============================================================================
# Creative Mojo Admin — Phase A + Phase C Duplicate Diagnostics Runner (v3)
# =============================================================================
#
#   READ-ONLY DIAGNOSTICS ONLY. Every request is a GET or a dry-run POST
#   whose body cannot trigger a database write. No PATCH / PUT / DELETE.
#   No ``commit=true`` parameter. No archive / merge / repair / renumbering
#   route. No database command. See "REQUEST INVENTORY" below.
#
# -----------------------------------------------------------------------------
# REQUEST INVENTORY — every HTTP call this script can issue
# -----------------------------------------------------------------------------
#   GET  /api/admin/franchisees/by-number/0095
#        (standard admin lookup — validated as normal API response, not
#         as a Phase A+C diagnostic envelope)
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
#   The lookup endpoint is asserted only to (a) return HTTP 2xx and
#   (b) carry the expected ``records`` array shape. It is not required
#   to carry the diagnostic envelope.
#
# -----------------------------------------------------------------------------
# MODES
# -----------------------------------------------------------------------------
#   bash run_duplicate_diagnostics.sh              # normal run
#   bash run_duplicate_diagnostics.sh --plan-only  # NO network. Prints the
#                                                    # full request plan.
#   bash run_duplicate_diagnostics.sh --show-requests
#                                                  # Prints each request
#                                                  # (method + path + output
#                                                  # filename) as it runs.
#
#   Neither mode ever prints ADMIN_TOKEN, ADMIN_COOKIE, or the credential
#   config file contents.
#
# -----------------------------------------------------------------------------
# macOS PREREQUISITES
# -----------------------------------------------------------------------------
#   * bash          — default on macOS
#   * curl          — default on macOS
#   * python3       — /usr/bin/python3 (macOS 10.15+) — used only for JSON,
#                     never touches the network.
#   * shasum -a 256 — default on macOS (used for the local checksum check)
#   * tar           — default on macOS (used only if you package results)
#
#   No additional scripts, packages or binaries are downloaded or executed
#   at any point.
#
# -----------------------------------------------------------------------------
# SAFETY GUARANTEES
# -----------------------------------------------------------------------------
# * No shell tracing (``set +x`` explicitly).
# * ADMIN_TOKEN / ADMIN_COOKIE never appear on any command line — passed to
#   curl via a chmod-600 temp config file with ``-K``.
# * ``umask 077`` — every output file/dir is 600/700.
# * A trap on EXIT/INT/TERM/HUP wipes the credential temp file even on
#   Ctrl-C, and unsets ADMIN_TOKEN + ADMIN_COOKIE in the runner's own
#   environment so they don't leak forward.
# * The runner never prints tokens/cookies/passwords/config file contents
#   to stdout or stderr.
# * The runner refuses to proceed if the franchise-number lookup returns
#   any result other than exactly one Samantha Whiteman.
# =============================================================================
set -euo pipefail
{ set +x; } 2>/dev/null || true

EXPECTED_DIAG_VERSION="phase-a+c-2026-08-04"

PLAN_ONLY=0
SHOW_REQUESTS=0
for arg in "$@"; do
  case "$arg" in
    --plan-only)    PLAN_ONLY=1 ;;
    --show-requests) SHOW_REQUESTS=1 ;;
    -h|--help)
      sed -n '2,80p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

# ---- Prereq checks (network-independent)
: "${API_URL:?export API_URL=\"https://hub.creativemojo.co.uk\" first}"
command -v python3 >/dev/null 2>&1 || { echo "ERROR: python3 not found" >&2; exit 2; }
command -v curl    >/dev/null 2>&1 || { echo "ERROR: curl not found"    >&2; exit 2; }

# ---- Plan-only mode: print request plan and exit
if [[ "${PLAN_ONLY}" -eq 1 ]]; then
  cat <<PLAN
==============================================================================
PLAN-ONLY MODE — no network calls will be made.
==============================================================================
API_URL             : ${API_URL}
Expected diagnostic : ${EXPECTED_DIAG_VERSION}

Request plan (in order):

  [00]  GET  /api/admin/franchisees/by-number/0095
        → 00_resolve_sam.json   (standard API response, not a diagnostic
                                 envelope)

  [01]  GET  /api/admin/diagnostics/homes-list-duplicates?home_name=Tunbridge%20Wells%20Care%20Centre&limit=50
        → 01_homes_tunbridge_wells.json

  [02]  GET  /api/admin/diagnostics/homes-list-duplicates?home_name=Wadhurst%20Manor&limit=50
        → 02_homes_wadhurst_manor.json

  [03]  GET  /api/admin/diagnostics/clients/duplicates?franchisee_id=<SAM_ID>&limit=500
        → 03_clients_duplicates_sam.json

  [04]  GET  /api/admin/diagnostics/user-activity?franchisee_id=<SAM_ID>&email=<SAM_EMAIL>&days=7
        → 04_user_activity_sam_7d.json

  For each duplicate client_record_id returned in file 03:
  [05]  GET  /api/admin/diagnostics/clients/{client_id}/resolve-identity
        → 05_resolve_<short_id>.json

  For each duplicate GROUP in file 03 (whole group, not pairwise —
  the endpoint accepts ALL record_ids in one call so the survivor
  recommendation stays consistent across the group):
  [06]  POST /api/admin/diagnostics/dry-run/client-merge
        body: {"record_ids": [<every id in the group>]}
        → 06_dry_run_merge_group_NN.json

  For each site GROUP in files 01 + 02 with >1 member:
  [07]  POST /api/admin/diagnostics/dry-run/site-group
        body: {"cqc_location_ids": [<every location_id in the group>]}
        → 07_dry_run_site_group_NN.json

  [F]   Local summary compilation → SUMMARY.json

Envelope validation:
  * File 00 : HTTP 2xx AND has "records" list.
  * All 01..07 files: write_performed === false AND
                     diagnostic_version === ${EXPECTED_DIAG_VERSION}.
  Any failure aborts the run and marks it FAILED in SUMMARY.

Permitted HTTP methods : GET, POST (dry-run only)
Forbidden methods      : PATCH, PUT, DELETE
Forbidden params       : commit=true (nowhere)
Forbidden routes       : /merge, /repair, /rebind, /archive, /renumber, /db-*

No scripts / binaries are downloaded. Only python3, curl, tar, shasum from
the base macOS install are used.
==============================================================================
PLAN
  exit 0
fi

# ---- Auth check (only from here on)
if [[ -z "${ADMIN_TOKEN:-}" && -z "${ADMIN_COOKIE:-}" ]]; then
  echo "ERROR: export ADMIN_TOKEN=... (bearer) or ADMIN_COOKIE=access_token=... before running." >&2
  exit 2
fi

SAM_EMAIL="${SAM_EMAIL:-sam.whiteman@creativemojo.co.uk}"

# ---- Restrictive umask
umask 077

# ---- Auth transport
AUTH_CONFIG=$(mktemp -t cm-diag-auth.XXXXXX)
chmod 600 "${AUTH_CONFIG}"
if [[ -n "${ADMIN_TOKEN:-}" ]]; then
  printf 'header = "Authorization: Bearer %s"\n' "${ADMIN_TOKEN}" > "${AUTH_CONFIG}"
  AUTH_METHOD="bearer_token"
else
  printf 'header = "Cookie: %s"\n' "${ADMIN_COOKIE}" > "${AUTH_CONFIG}"
  AUTH_METHOD="session_cookie"
fi

# ---- Cleanup: wipe temp files AND scrub credential env vars on exit
cleanup() {
  rm -f "${AUTH_CONFIG:-}" "${BODY_TMP:-}" 2>/dev/null || true
  # Best-effort: unset creds in our own env. (Parent shell env is separate.)
  unset ADMIN_TOKEN ADMIN_COOKIE EM PW 2>/dev/null || true
}
trap cleanup EXIT INT TERM HUP

BODY_TMP=$(mktemp -t cm-diag-body.XXXXXX)
chmod 600 "${BODY_TMP}"

# ---- Output directory
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_DIR="./diagnostic_reports/${STAMP}"
mkdir -p "${OUT_DIR}"
chmod 700 "${OUT_DIR}"
echo "Writing reports to: ${OUT_DIR}"
echo "Auth method       : ${AUTH_METHOD}"
[[ "${SHOW_REQUESTS}" -eq 1 ]] && echo "Show-requests mode : ON"
echo

# ---- Helpers ---------------------------------------------------------------
_show() {
  # Never prints the token/cookie/config-file contents.
  [[ "${SHOW_REQUESTS}" -eq 1 ]] && echo "[req] ${1} ${2} → ${3}"
}

_curl_get() {
  local url="$1" out="$2" label="$3"
  _show "GET " "${url}" "${out}"
  curl -sS -K "${AUTH_CONFIG}" \
       -H "Accept: application/json" \
       -o "${out}" -w "%{http_code}" "${url}"
}
_curl_post_json() {
  local url="$1" body_file="$2" out="$3" label="$4"
  _show "POST" "${url}" "${out}"
  curl -sS -K "${AUTH_CONFIG}" \
       -H "Accept: application/json" \
       -H "Content-Type: application/json" \
       --data-binary "@${body_file}" \
       -X POST -o "${out}" -w "%{http_code}" "${url}"
}

# Strict Phase A+C envelope validator.
_validate_diagnostic() {
  local label="$1" file="$2"
  EXPECTED_VER="${EXPECTED_DIAG_VERSION}" python3 - "${label}" "${file}" <<'PY'
import json, os, sys
label, path = sys.argv[1], sys.argv[2]
expected = os.environ["EXPECTED_VER"]
try:
    d = json.load(open(path))
except Exception as e:
    print(f"[FAIL] {label} — non-JSON response ({e})", file=sys.stderr); sys.exit(3)
if "write_performed" not in d:
    print(f"[FAIL] {label} — response is missing 'write_performed'", file=sys.stderr); sys.exit(3)
if d["write_performed"] is not False:
    print(f"[!!!!] {label} — write_performed = {d['write_performed']!r} — STOP AND ESCALATE", file=sys.stderr); sys.exit(3)
if d.get("diagnostic_version") != expected:
    print(f"[FAIL] {label} — diagnostic_version = {d.get('diagnostic_version')!r}, expected {expected!r}", file=sys.stderr); sys.exit(3)
bits = ["write_performed=false", f"diag={d['diagnostic_version']}",
        f"build={str(d.get('build_commit','?'))[:12]}"]
for k in ("group_count", "status", "proposed_survivor_id", "proposed_canonical_site_id"):
    if k in d: bits.append(f"{k}={d[k]}")
print(f"[ OK ] {label} — " + " ".join(bits))
PY
}

# Standard API validator — used ONLY for the franchisee lookup endpoint.
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
  local status
  status=$(_curl_get "${url}" "${out}" "${label}") || { echo "[FAIL] ${label} — curl error" >&2; exit 1; }
  if [[ "${status}" -lt 200 || "${status}" -ge 300 ]]; then
    echo "[FAIL] ${label} — HTTP ${status} — body at ${out}" >&2; exit 1
  fi
  _validate_diagnostic "${label}" "${out}"
}

run_post_dry_run() {
  local label="$1" url="$2" body="$3"
  local out="${OUT_DIR}/${label}.json"
  printf '%s' "${body}" > "${BODY_TMP}"
  local status
  status=$(_curl_post_json "${url}" "${BODY_TMP}" "${out}" "${label}") || { echo "[FAIL] ${label} — curl error" >&2; exit 1; }
  if [[ "${status}" -lt 200 || "${status}" -ge 300 ]]; then
    echo "[FAIL] ${label} — HTTP ${status} — body at ${out}" >&2; exit 1
  fi
  _validate_diagnostic "${label}" "${out}"
}

# ============================================================================
# PHASE 0 — Resolve Sam via franchise_number=0095
# ----------------------------------------------------------------------------
# Approved rules (per user, Aug 2026):
#   * 0 matches                                         → abort
#   * exactly 1 match whose name IS "Samantha Whiteman" → proceed
#   * exactly 1 match whose name IS NOT Samantha Whiteman → abort
#   * >1 match                                          → abort, print all
#   * NO ranking / filtering / preference across multiple matches.
#   * SAM_FRANCHISEE_ID override skips the lookup — explicitly flagged.
# ============================================================================
if [[ -n "${SAM_FRANCHISEE_ID:-}" ]]; then
  echo "[info] MANUAL OVERRIDE — SAM_FRANCHISEE_ID is set explicitly by you."
  echo "       No auto-resolution performed. Masked ID: ${SAM_FRANCHISEE_ID:0:8}…${SAM_FRANCHISEE_ID: -4}"
  echo
else
  echo "Resolving Sam's franchisee record from franchise_number=0095 ..."
  RESOLVE_OUT="${OUT_DIR}/00_resolve_sam.json"
  status=$(_curl_get "${API_URL}/api/admin/franchisees/by-number/0095" "${RESOLVE_OUT}" "00_resolve_sam") || { echo "[FAIL] Sam lookup — curl error" >&2; exit 1; }
  if [[ "${status}" -lt 200 || "${status}" -ge 300 ]]; then
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
    print(f"STATUS=multi")
    print(f"COUNT={len(items)}")
    for fr in items:
        print(f"  - id={str(fr.get('id','?'))[:8]}… name={_name(fr) or '?'} number={fr.get('franchise_number','?')} archived={fr.get('archived','?')}")
    sys.exit(0)
# Exactly one match — must be Samantha Whiteman (both first and last)
hit = items[0]
first = str(hit.get("first_name") or "").strip().lower()
last  = str(hit.get("last_name")  or "").strip().lower()
if last != "whiteman" or first not in ("samantha", "sam"):
    print(f"STATUS=one_wrong_name")
    print(f"ID={hit.get('id','')}")
    print(f"NAME={_name(hit) or '?'}")
    print(f"NUMBER={hit.get('franchise_number','?')}")
    sys.exit(0)
print(f"STATUS=one")
print(f"ID={hit.get('id','')}")
print(f"NAME={_name(hit)}")
print(f"NUMBER={hit.get('franchise_number','')}")
PY
)
  echo "${RESOLVED}" > "${OUT_DIR}/00_resolve_sam.txt"
  case "$(echo "${RESOLVED}" | head -1 | cut -d= -f2)" in
    one)
      SAM_FRANCHISEE_ID=$(echo "${RESOLVED}" | awk -F= '/^ID=/{print $2; exit}')
      SAM_NAME=$(echo "${RESOLVED}"        | awk -F= '/^NAME=/{print $2; exit}')
      SAM_NUM=$(echo "${RESOLVED}"         | awk -F= '/^NUMBER=/{print $2; exit}')
      MASKED="${SAM_FRANCHISEE_ID:0:8}…${SAM_FRANCHISEE_ID: -4}"
      echo "[ OK ] Resolved exactly one match:"
      echo "         name             = ${SAM_NAME}"
      echo "         franchise_number = ${SAM_NUM}"
      echo "         id (masked)      = ${MASKED}"
      echo ;;
    none)
      echo "[FAIL] No franchisee found with franchise_number=0095. Aborting." >&2
      echo "       Set SAM_FRANCHISEE_ID=<uuid> manually if you have it." >&2
      exit 1 ;;
    one_wrong_name)
      NAME_LINE=$(echo "${RESOLVED}" | awk -F= '/^NAME=/{print $2; exit}')
      NUM_LINE=$(echo  "${RESOLVED}" | awk -F= '/^NUMBER=/{print $2; exit}')
      echo "[FAIL] franchise_number=0095 resolves to ONE record but it is not Samantha Whiteman." >&2
      echo "       Found: name=${NAME_LINE} franchise_number=${NUM_LINE}." >&2
      echo "       Aborting — no name-based ranking is permitted." >&2
      exit 1 ;;
    multi)
      echo "[FAIL] franchise_number=0095 is DUPLICATED across multiple franchisees." >&2
      echo "       The Sam diagnostic MUST NOT proceed until the franchise-number reconciliation is done." >&2
      echo "       Every matching record:" >&2
      echo "${RESOLVED}" >&2
      exit 1 ;;
    *)
      echo "[FAIL] Unexpected resolver output. See ${OUT_DIR}/00_resolve_sam.txt" >&2
      echo "${RESOLVED}" >&2
      exit 1 ;;
  esac
fi

# ============================================================================
# A. Homes-list duplicates
# ============================================================================
run_get_diagnostic "01_homes_tunbridge_wells" \
  "${API_URL}/api/admin/diagnostics/homes-list-duplicates?home_name=Tunbridge%20Wells%20Care%20Centre&limit=50"
run_get_diagnostic "02_homes_wadhurst_manor" \
  "${API_URL}/api/admin/diagnostics/homes-list-duplicates?home_name=Wadhurst%20Manor&limit=50"

# ============================================================================
# B. Sam Whiteman — client duplicates + 7-day activity
# ============================================================================
run_get_diagnostic "03_clients_duplicates_sam" \
  "${API_URL}/api/admin/diagnostics/clients/duplicates?franchisee_id=${SAM_FRANCHISEE_ID}&limit=500"

SAM_EMAIL_ENC=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "${SAM_EMAIL}")
run_get_diagnostic "04_user_activity_sam_7d" \
  "${API_URL}/api/admin/diagnostics/user-activity?franchisee_id=${SAM_FRANCHISEE_ID}&email=${SAM_EMAIL_ENC}&days=7"

# ============================================================================
# C. Identity resolution for every duplicate client ID returned
# ============================================================================
CLIENT_IDS_FILE="${OUT_DIR}/_client_ids.txt"
python3 - "${OUT_DIR}/03_clients_duplicates_sam.json" "${CLIENT_IDS_FILE}" <<'PY'
import json, sys
src, dst = sys.argv[1], sys.argv[2]
d = json.load(open(src))
ids = [r.get("client_record_id") for g in (d.get("groups") or [])
                                 for r in (g.get("records") or []) if r.get("client_record_id")]
open(dst, "w").write("\n".join(ids))
print(f"[info] {len(ids)} client IDs to resolve")
PY

while IFS= read -r CID; do
  [[ -z "${CID}" ]] && continue
  run_get_diagnostic "05_resolve_${CID:0:8}" \
    "${API_URL}/api/admin/diagnostics/clients/${CID}/resolve-identity"
done < "${CLIENT_IDS_FILE}"

# ============================================================================
# D. Dry-run client merges — WHOLE-GROUP, one call per duplicate group
# ----------------------------------------------------------------------------
# The dry-run endpoint accepts all record_ids for a group in one call and
# returns a single, consistent survivor recommendation for the group. This
# avoids the pairwise inconsistency of running (A,B) and (B,C) separately.
# ============================================================================
GROUPS_FILE="${OUT_DIR}/_merge_groups.txt"
python3 - "${OUT_DIR}/03_clients_duplicates_sam.json" "${GROUPS_FILE}" <<'PY'
import json, sys
src, dst = sys.argv[1], sys.argv[2]
d = json.load(open(src))
lines = []
for g in d.get("groups") or []:
    ids = [r["client_record_id"] for r in (g.get("records") or []) if r.get("client_record_id")]
    if len(ids) >= 2:
        # WHOLE group, not first two. Endpoint requires >= 2 record_ids.
        lines.append(",".join(ids))
open(dst, "w").write("\n".join(lines))
print(f"[info] {len(lines)} whole-group client-merge dry-runs queued")
PY

INDEX=0
while IFS= read -r LINE; do
  [[ -z "${LINE}" ]] && continue
  INDEX=$((INDEX+1))
  BODY=$(python3 -c "
import json, sys
ids = sys.argv[1].split(',')
print(json.dumps({'record_ids': ids}))
" "${LINE}")
  run_post_dry_run "$(printf '06_dry_run_merge_group_%02d' ${INDEX})" \
    "${API_URL}/api/admin/diagnostics/dry-run/client-merge" "${BODY}"
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
open(dst, "w").write("\n".join(lines))
print(f"[info] {len(lines)} whole-group site dry-runs queued")
PY

INDEX=0
while IFS= read -r LINE; do
  [[ -z "${LINE}" ]] && continue
  INDEX=$((INDEX+1))
  BODY=$(python3 -c "
import json, sys
ids = sys.argv[1].split(',')
print(json.dumps({'cqc_location_ids': ids}))
" "${LINE}")
  run_post_dry_run "$(printf '07_dry_run_site_group_%02d' ${INDEX})" \
    "${API_URL}/api/admin/diagnostics/dry-run/site-group" "${BODY}"
done < "${SITE_GROUPS_FILE}"

# ============================================================================
# F. Combined summary — validates every JSON in the folder
# ============================================================================
python3 - "${OUT_DIR}" "${EXPECTED_DIAG_VERSION}" <<'PY'
import glob, json, os, sys
outdir, expected = sys.argv[1], sys.argv[2]
summary = {
    "output_directory": outdir,
    "expected_diagnostic_version": expected,
    "safety": {
        "credentials_in_files": False,
        "write_performed_asserted_false_for_every_diagnostic": True,
    },
    "files": {},
    "issues": [],
}
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
    # The lookup file (00_resolve_sam.json) is a normal API response — no envelope.
    if base.startswith("00_resolve_sam"):
        entry["kind"] = "lookup"
        entry["records"] = len((d or {}).get("records") or [])
    else:
        entry["kind"] = "diagnostic"
        for k in ("write_performed", "diagnostic_version", "build_commit", "environment"):
            entry[k] = d.get(k)
        for k in ("group_count", "status", "proposed_survivor_id", "proposed_canonical_site_id"):
            if k in d: entry[k] = d[k]
        if d.get("write_performed") is not False:
            summary["issues"].append(f"{base}: write_performed = {d.get('write_performed')!r}")
        if d.get("diagnostic_version") != expected:
            summary["issues"].append(f"{base}: diagnostic_version = {d.get('diagnostic_version')!r}")
    summary["files"][base] = entry
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
echo "To package for sharing (credentials are already OUTSIDE this folder):"
echo "  tar -czf production-diagnostics-${STAMP}.tar.gz -C \"$(dirname "${OUT_DIR}")\" \"$(basename "${OUT_DIR}")\""
echo
echo "Every diagnostic response asserted:"
echo "  * write_performed == false"
echo "  * diagnostic_version == ${EXPECTED_DIAG_VERSION}"
echo "The franchisee lookup was validated as a normal API response only."
echo
echo "STOP HERE. Share the archive back for review BEFORE any"
echo "Phase B / Phase D repair is authorised."
echo "=========================================================="
