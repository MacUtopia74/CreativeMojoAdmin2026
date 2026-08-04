#!/usr/bin/env bash
# =============================================================================
# Creative Mojo Admin — Phase A + Phase C Duplicate Diagnostics Runner (v2)
# =============================================================================
#
#   READ-ONLY DIAGNOSTICS ONLY. Every request is a GET or a dry-run POST
#   whose body cannot trigger a database write. There is no ``commit``
#   parameter anywhere. No DELETE / PATCH / PUT calls. Nothing here
#   archives, merges, soft-deletes, or updates any record.
#
#   The script ABORTS (non-zero exit) if ANY of the following happens:
#     * HTTP status code < 200 or >= 300
#     * response is missing ``write_performed``
#     * ``write_performed`` is anything other than the literal boolean ``false``
#     * ``diagnostic_version`` != ``phase-a+c-2026-08-04``
#     * Sam's franchisee record cannot be uniquely resolved from
#       franchise_number 0095 (unless SAM_FRANCHISEE_ID is set)
#
# -----------------------------------------------------------------------------
# HOW TO RUN — macOS
# -----------------------------------------------------------------------------
# Prerequisites: bash (default macOS), curl (default macOS), python3
#   (macOS 10.15+ has it at /usr/bin/python3 — check: python3 --version).
#
#   1. Save this file locally, e.g. ~/cm-diagnostics/run_duplicate_diagnostics.sh
#   2. Make it executable and lock down file permissions:
#          chmod 700 ~/cm-diagnostics/run_duplicate_diagnostics.sh
#          mkdir -p ~/cm-diagnostics/output
#   3. Export the API URL:
#          export API_URL="https://hub.creativemojo.co.uk"
#   4. Obtain an admin token WITHOUT posting it anywhere:
#          # Interactive login. -s hides the password characters as you type.
#          # Everything stays local to your Mac.
#          read -s -p "Admin email: " ADMIN_EMAIL; echo
#          read -s -p "Admin password: " ADMIN_PASSWORD; echo
#          export ADMIN_TOKEN=$(
#            curl -sS -X POST "$API_URL/api/auth/login" \
#              -H "Content-Type: application/json" \
#              -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" \
#              | python3 -c "import sys,json;print(json.load(sys.stdin)['access_token'])"
#          )
#          unset ADMIN_EMAIL ADMIN_PASSWORD
#      Alternative — if the production API only serves session cookies:
#          # In Chrome: log in, DevTools → Application → Cookies →
#          # copy the "access_token" cookie value.
#          read -s -p "access_token cookie value: " CV; echo
#          export ADMIN_COOKIE="access_token=$CV"
#          unset CV
#   5. (Optional) Override Sam's franchisee record — only needed if
#      the auto-lookup by franchise number 0095 fails:
#          export SAM_FRANCHISEE_ID="<uuid>"
#      (Optional) override Sam's account email if not the default below:
#          export SAM_EMAIL="sam.whiteman@creativemojo.co.uk"
#   6. Run:
#          cd ~/cm-diagnostics/output
#          bash ~/cm-diagnostics/run_duplicate_diagnostics.sh
#
# Output: ./diagnostic_reports/<UTC-timestamp>/*.json  plus  SUMMARY.json
#
# -----------------------------------------------------------------------------
# SAFETY GUARANTEES
# -----------------------------------------------------------------------------
# * The script never prints ADMIN_TOKEN, ADMIN_COOKIE, or any Authorization
#   header value to stdout or stderr.
# * Shell tracing (``set -x``) is explicitly disabled.
# * No credentials are written to result files or SUMMARY.json.
# * Auth headers are passed via a temp env-file with mode 600 read by curl
#   using ``-K``, so they never appear in ``ps`` output.
# * All temp files are wiped on exit (trap on EXIT / INT / TERM / HUP).
# * Output directory + files are created with restrictive umask.
# * The script refuses to run if diagnostic_version drifts from the
#   expected version — protects against accidental production regressions.
# =============================================================================
set -euo pipefail
{ set +x; } 2>/dev/null || true    # belt & braces: no shell tracing

EXPECTED_DIAG_VERSION="phase-a+c-2026-08-04"

# ---- Prereq checks
: "${API_URL:?export API_URL=\"https://hub.creativemojo.co.uk\" first}"
command -v python3 >/dev/null 2>&1 || { echo "ERROR: python3 not found" >&2; exit 2; }
command -v curl    >/dev/null 2>&1 || { echo "ERROR: curl not found"    >&2; exit 2; }

if [[ -z "${ADMIN_TOKEN:-}" && -z "${ADMIN_COOKIE:-}" ]]; then
  echo "ERROR: export ADMIN_TOKEN=... (bearer) or ADMIN_COOKIE=access_token=... before running." >&2
  exit 2
fi

SAM_EMAIL="${SAM_EMAIL:-sam.whiteman@creativemojo.co.uk}"

# ---- Restrictive umask so all output files are 600/700
umask 077

# ---- Auth transport: use a temp curl config file (never on the command line)
AUTH_CONFIG=$(mktemp -t cm-diag-auth.XXXXXX)
chmod 600 "${AUTH_CONFIG}"
if [[ -n "${ADMIN_TOKEN:-}" ]]; then
  printf 'header = "Authorization: Bearer %s"\n' "${ADMIN_TOKEN}" > "${AUTH_CONFIG}"
  AUTH_METHOD="bearer_token"
else
  printf 'header = "Cookie: %s"\n' "${ADMIN_COOKIE}" > "${AUTH_CONFIG}"
  AUTH_METHOD="session_cookie"
fi

# ---- Guaranteed cleanup of the credential file + any body temp files
cleanup() {
  rm -f "${AUTH_CONFIG:-}" "${BODY_TMP:-}" 2>/dev/null || true
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
echo "Auth method: ${AUTH_METHOD}"
echo

# ---- Helpers ----------------------------------------------------------------
_curl_get() {
  local url="$1" out="$2"
  curl -sS -K "${AUTH_CONFIG}" \
       -H "Accept: application/json" \
       -o "${out}" -w "%{http_code}" "${url}"
}
_curl_post_json() {
  local url="$1" body_file="$2" out="$3"
  curl -sS -K "${AUTH_CONFIG}" \
       -H "Accept: application/json" \
       -H "Content-Type: application/json" \
       --data-binary "@${body_file}" \
       -X POST -o "${out}" -w "%{http_code}" "${url}"
}

_validate() {
  # Aborts if:
  #   * write_performed missing or != false
  #   * diagnostic_version != EXPECTED_DIAG_VERSION
  # Prints one-line OK summary otherwise.
  local label="$1" file="$2"
  EXPECTED_VER="${EXPECTED_DIAG_VERSION}" python3 - "${label}" "${file}" <<'PY'
import json, os, sys
label, path = sys.argv[1], sys.argv[2]
expected = os.environ["EXPECTED_VER"]
try:
    d = json.load(open(path))
except Exception as e:
    print(f"[FAIL] {label} — non-JSON response ({e})", file=sys.stderr); sys.exit(3)
wp = d.get("write_performed", "__MISSING__")
if wp == "__MISSING__":
    print(f"[FAIL] {label} — response is missing 'write_performed'", file=sys.stderr); sys.exit(3)
if wp is not False:
    print(f"[!!!!] {label} — write_performed = {wp!r} — STOP AND ESCALATE", file=sys.stderr); sys.exit(3)
ver = d.get("diagnostic_version")
if ver != expected:
    print(f"[FAIL] {label} — diagnostic_version = {ver!r}, expected {expected!r}", file=sys.stderr); sys.exit(3)
bits = ["write_performed=false", f"diag={ver}", f"build={d.get('build_commit','?')[:12]}"]
for k in ("group_count", "status", "proposed_survivor_id", "proposed_canonical_site_id"):
    if k in d: bits.append(f"{k}={d[k]}")
print(f"[ OK ] {label} — " + " ".join(bits))
PY
}

run_get() {
  local label="$1" url="$2"
  local out="${OUT_DIR}/${label}.json"
  local status
  status=$(_curl_get "${url}" "${out}") || { echo "[FAIL] ${label} — curl error" >&2; exit 1; }
  if [[ "${status}" -lt 200 || "${status}" -ge 300 ]]; then
    echo "[FAIL] ${label} — HTTP ${status} — body at ${out}" >&2; exit 1
  fi
  _validate "${label}" "${out}"
}

run_post_dry_run() {
  local label="$1" url="$2" body="$3"
  local out="${OUT_DIR}/${label}.json"
  printf '%s' "${body}" > "${BODY_TMP}"
  local status
  status=$(_curl_post_json "${url}" "${BODY_TMP}" "${out}") || { echo "[FAIL] ${label} — curl error" >&2; exit 1; }
  if [[ "${status}" -lt 200 || "${status}" -ge 300 ]]; then
    echo "[FAIL] ${label} — HTTP ${status} — body at ${out}" >&2; exit 1
  fi
  _validate "${label}" "${out}"
}

# ============================================================================
# PHASE 0 — Resolve Sam's franchisee record from franchise_number 0095 + name
# ============================================================================
# Uses the existing admin endpoint that returns a LIST (never silently picks):
#   GET /api/admin/franchisees/by-number/0095
# Aborts if 0 or >1 results. SAM_FRANCHISEE_ID override skips the lookup.
# ============================================================================
if [[ -z "${SAM_FRANCHISEE_ID:-}" ]]; then
  echo "Resolving Sam's franchisee record from franchise_number=0095 ..."
  RESOLVE_OUT="${OUT_DIR}/00_resolve_sam.json"
  status=$(_curl_get "${API_URL}/api/admin/franchisees/by-number/0095" "${RESOLVE_OUT}")
  if [[ "${status}" -lt 200 || "${status}" -ge 300 ]]; then
    echo "[FAIL] Sam lookup — HTTP ${status} — body at ${RESOLVE_OUT}" >&2; exit 1
  fi
  RESOLVED=$(python3 - "${RESOLVE_OUT}" <<'PY'
import json, sys
data = json.load(open(sys.argv[1]))
# Endpoint shape (verified against server): {franchise_number_query, count, records: [...]}
if isinstance(data, dict):
    items = data.get("records") or data.get("items") or data.get("results") or []
elif isinstance(data, list):
    items = data
else:
    items = []
def _name(fr):
    return " ".join([str(fr.get("first_name") or ""), str(fr.get("last_name") or "")]).strip()
if not items:
    print("STATUS=none"); sys.exit(0)
if len(items) == 1:
    hit = items[0]
    print(f"STATUS=one\nID={hit.get('id','')}\nNAME={_name(hit)}\nNUMBER={hit.get('franchise_number','')}")
    sys.exit(0)
# >1 result: only proceed if a single record's name matches Samantha Whiteman.
# Otherwise we ABORT — the user must resolve the franchise-number duplicate first.
whitemans = [fr for fr in items if "whiteman" in _name(fr).lower()]
if len(whitemans) == 1:
    hit = whitemans[0]
    print(f"STATUS=one_by_name\nID={hit.get('id','')}\nNAME={_name(hit)}\nNUMBER={hit.get('franchise_number','')}")
else:
    print(f"STATUS=multi\nCOUNT={len(items)}")
    for fr in items:
        print(f"  - id={str(fr.get('id','?'))[:8]}… name={_name(fr) or '?'} number={fr.get('franchise_number','?')} archived={fr.get('archived','?')}")
PY
)
  echo "${RESOLVED}" > "${OUT_DIR}/00_resolve_sam.txt"
  case "$(echo "${RESOLVED}" | head -1 | cut -d= -f2)" in
    one|one_by_name)
      SAM_FRANCHISEE_ID=$(echo "${RESOLVED}" | awk -F= '/^ID=/{print $2; exit}')
      SAM_NAME=$(echo "${RESOLVED}"        | awk -F= '/^NAME=/{print $2; exit}')
      SAM_NUM=$(echo "${RESOLVED}"         | awk -F= '/^NUMBER=/{print $2; exit}')
      # Print a masked/short ID for confirmation
      MASKED="${SAM_FRANCHISEE_ID:0:8}…${SAM_FRANCHISEE_ID: -4}"
      echo "[ OK ] Resolved: ${SAM_NAME} — franchise_number=${SAM_NUM} — id=${MASKED}"
      echo
      ;;
    none)
      echo "[FAIL] No franchisee found with franchise_number=0095. Aborting." >&2
      echo "Set SAM_FRANCHISEE_ID=<uuid> manually if you know it, or check the admin UI." >&2
      exit 1 ;;
    multi)
      echo "[FAIL] franchise_number=0095 is DUPLICATED across multiple franchisees." >&2
      echo "The Sam diagnostic MUST NOT proceed until the franchise-number reconciliation is done." >&2
      echo "See ${OUT_DIR}/00_resolve_sam.txt for the full list." >&2
      echo "${RESOLVED}" >&2
      exit 1 ;;
    *)
      echo "[FAIL] Unexpected resolver output. See ${OUT_DIR}/00_resolve_sam.txt" >&2
      echo "${RESOLVED}" >&2
      exit 1 ;;
  esac
else
  echo "[info] Using manual SAM_FRANCHISEE_ID override (${SAM_FRANCHISEE_ID:0:8}…${SAM_FRANCHISEE_ID: -4})"
  echo
fi

# ============================================================================
# A. Homes-list duplicates
# ============================================================================
run_get "01_homes_tunbridge_wells" \
  "${API_URL}/api/admin/diagnostics/homes-list-duplicates?home_name=Tunbridge%20Wells%20Care%20Centre&limit=50"
run_get "02_homes_wadhurst_manor" \
  "${API_URL}/api/admin/diagnostics/homes-list-duplicates?home_name=Wadhurst%20Manor&limit=50"

# ============================================================================
# B. Sam Whiteman — client duplicates + 7-day activity
# ============================================================================
run_get "03_clients_duplicates_sam" \
  "${API_URL}/api/admin/diagnostics/clients/duplicates?franchisee_id=${SAM_FRANCHISEE_ID}&limit=500"

SAM_EMAIL_ENC=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "${SAM_EMAIL}")
run_get "04_user_activity_sam_7d" \
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
  run_get "05_resolve_${CID:0:8}" \
    "${API_URL}/api/admin/diagnostics/clients/${CID}/resolve-identity"
done < "${CLIENT_IDS_FILE}"

# ============================================================================
# D. Dry-run client merges — first 2 IDs of each duplicate group
# ============================================================================
PAIRS_FILE="${OUT_DIR}/_merge_pairs.txt"
python3 - "${OUT_DIR}/03_clients_duplicates_sam.json" "${PAIRS_FILE}" <<'PY'
import json, sys
src, dst = sys.argv[1], sys.argv[2]
d = json.load(open(src))
lines = []
for g in d.get("groups") or []:
    ids = [r["client_record_id"] for r in (g.get("records") or []) if r.get("client_record_id")]
    if len(ids) >= 2:
        lines.append(",".join(ids[:2]))
open(dst, "w").write("\n".join(lines))
print(f"[info] {len(lines)} client-merge dry-run pairs queued")
PY

INDEX=0
while IFS= read -r PAIR; do
  [[ -z "${PAIR}" ]] && continue
  INDEX=$((INDEX+1))
  IFS=',' read -r A B <<< "${PAIR}"
  BODY=$(python3 -c "import json,sys;print(json.dumps({'record_ids':[sys.argv[1],sys.argv[2]]}))" "$A" "$B")
  run_post_dry_run "$(printf '06_dry_run_merge_%02d' ${INDEX})" \
    "${API_URL}/api/admin/diagnostics/dry-run/client-merge" "${BODY}"
done < "${PAIRS_FILE}"

# ============================================================================
# E. Dry-run site grouping — pairs from files 01 + 02
# ============================================================================
SITE_PAIRS_FILE="${OUT_DIR}/_site_pairs.txt"
python3 - "${OUT_DIR}" "${SITE_PAIRS_FILE}" <<'PY'
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
            lines.append(",".join(ids[:3]))
open(dst, "w").write("\n".join(lines))
print(f"[info] {len(lines)} site-group dry-run pairs queued")
PY

INDEX=0
while IFS= read -r LINE; do
  [[ -z "${LINE}" ]] && continue
  INDEX=$((INDEX+1))
  BODY=$(python3 -c "import json,sys;print(json.dumps({'cqc_location_ids':sys.argv[1].split(',')}))" "${LINE}")
  run_post_dry_run "$(printf '07_dry_run_site_group_%02d' ${INDEX})" \
    "${API_URL}/api/admin/diagnostics/dry-run/site-group" "${BODY}"
done < "${SITE_PAIRS_FILE}"

# ============================================================================
# F. Combined human-readable summary
# ============================================================================
python3 - "${OUT_DIR}" <<'PY'
import glob, json, os, sys
outdir = sys.argv[1]
summary = {
    "output_directory": outdir,
    "expected_diagnostic_version": "phase-a+c-2026-08-04",
    "safety": {
        "credentials_in_files": False,
        "write_performed_asserted_false_for_every_response": True,
    },
    "files": {},
}
issues = []
for f in sorted(glob.glob(os.path.join(outdir, "*.json"))):
    base = os.path.basename(f)
    if base.startswith("_") or base == "SUMMARY.json":
        continue
    try:
        d = json.load(open(f))
    except Exception as e:
        issues.append(f"{base}: non-JSON ({e})")
        continue
    entry = {k: d.get(k) for k in
             ("write_performed", "diagnostic_version", "build_commit", "environment")}
    for k in ("group_count", "status", "proposed_survivor_id", "proposed_canonical_site_id"):
        if k in d: entry[k] = d[k]
    if d.get("write_performed") is not False:
        issues.append(f"{base}: write_performed = {d.get('write_performed')!r}")
    if d.get("diagnostic_version") != "phase-a+c-2026-08-04":
        issues.append(f"{base}: diagnostic_version = {d.get('diagnostic_version')!r}")
    summary["files"][base] = entry
summary["issues"] = issues
with open(os.path.join(outdir, "SUMMARY.json"), "w") as fp:
    json.dump(summary, fp, indent=2)
print()
print("=== SUMMARY ===")
print(json.dumps(summary, indent=2))
if issues:
    print("\n[FAIL] Issues detected — DO NOT PROCEED. See above.", file=sys.stderr)
    sys.exit(3)
PY

echo
echo "=========================================================="
echo "DONE. Reports written to: ${OUT_DIR}"
echo "SUMMARY: ${OUT_DIR}/SUMMARY.json"
echo
echo "Every response asserted:"
echo "  * write_performed == false"
echo "  * diagnostic_version == phase-a+c-2026-08-04"
echo
echo "STOP HERE. Share SUMMARY.json + the report files back for review"
echo "BEFORE any Phase B / Phase D repair is authorised."
echo "=========================================================="
