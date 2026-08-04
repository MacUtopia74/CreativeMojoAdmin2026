#!/usr/bin/env bash
# =============================================================================
# Creative Mojo Admin — Phase A + Phase C Duplicate Diagnostics Runner
# =============================================================================
#
#   READ-ONLY DIAGNOSTICS ONLY.
#
#   Every request in this script is a GET or a dry-run POST whose body cannot
#   trigger a database write. There is no ``commit`` parameter anywhere. There
#   are no DELETE / PATCH / PUT calls. Nothing here archives, merges,
#   soft-deletes, or updates any record.
#
#   If ANY response has HTTP status ≥ 400, the script exits non-zero and
#   stops WITHOUT continuing to the next endpoint.
#
# -----------------------------------------------------------------------------
# HOW TO RUN
# -----------------------------------------------------------------------------
#   1. Copy this file to your local machine (do NOT commit any tokens).
#   2. In a terminal, export the API URL:
#          export API_URL="https://hub.creativemojo.co.uk"
#   3. Obtain a short-lived admin token:
#         a) POST /api/auth/login in a curl call, capture ``access_token``, and
#                export ADMIN_TOKEN="paste-here"
#            e.g.
#                curl -s -X POST "$API_URL/api/auth/login" \
#                     -H "Content-Type: application/json" \
#                     -d '{"email":"admin@creativemojo.co.uk","password":"<yourpass>"}' \
#                     | jq -r .access_token
#         b) OR, if production only accepts session cookies:
#                # log in with Chrome, copy the "access_token" cookie value
#                export ADMIN_COOKIE="access_token=<value>"
#      The script will NEVER print the token or cookie to stdout.
#   4. Look up Sam's franchisee UUID (the endpoint takes UUID, not "0095"):
#          export SAM_FRANCHISEE_ID="<uuid>"
#      You can find it in the admin UI URL bar when viewing Sam's profile,
#      or by:
#          curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
#               "$API_URL/api/admin/franchisees?search=0095" | jq .
#   5. Optional — override Sam's account email if it isn't the default below:
#          export SAM_EMAIL="sam.whiteman@creativemojo.co.uk"
#   6. Run:
#          bash run_duplicate_diagnostics.sh
#      Output JSON files are written to  ./diagnostic_reports/<timestamp>/
#
# -----------------------------------------------------------------------------
# WARNING
# -----------------------------------------------------------------------------
# * Runs against your PRODUCTION API. Confirm before executing.
# * If any response has  "write_performed": true  — STOP and escalate.
# * Emergent preview and production databases are separate; results here
#   reflect production ONLY.
# =============================================================================
set -euo pipefail

: "${API_URL:?export API_URL=\"https://hub.creativemojo.co.uk\" first}"
: "${SAM_FRANCHISEE_ID:?export SAM_FRANCHISEE_ID=<uuid for franchise 0095>}"
SAM_EMAIL="${SAM_EMAIL:-sam.whiteman@creativemojo.co.uk}"

if [[ -n "${ADMIN_TOKEN:-}" ]]; then
  AUTH_HEADER=(-H "Authorization: Bearer ${ADMIN_TOKEN}")
elif [[ -n "${ADMIN_COOKIE:-}" ]]; then
  AUTH_HEADER=(-H "Cookie: ${ADMIN_COOKIE}")
else
  echo "ERROR: export ADMIN_TOKEN or ADMIN_COOKIE before running." >&2
  exit 2
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_DIR="./diagnostic_reports/${STAMP}"
mkdir -p "${OUT_DIR}"
echo "Writing reports to: ${OUT_DIR}"
echo

# ------------------------------------------------------------------
# Helper: GET a URL, save body, abort on non-2xx, one-line summary.
run_get() {
  local label="$1" url="$2"
  local out="${OUT_DIR}/${label}.json"
  local status
  status=$(curl -sS -o "${out}" -w "%{http_code}" "${AUTH_HEADER[@]}" \
                -H "Accept: application/json" "${url}")
  if [[ "${status}" -lt 200 || "${status}" -ge 300 ]]; then
    echo "[FAIL] ${label} — HTTP ${status} — body saved to ${out}" >&2
    exit 1
  fi
  summarise "${label}" "${out}"
}

run_post_dry_run() {
  local label="$1" url="$2" body="$3"
  local out="${OUT_DIR}/${label}.json"
  local status
  status=$(curl -sS -o "${out}" -w "%{http_code}" -X POST "${AUTH_HEADER[@]}" \
                -H "Content-Type: application/json" \
                -H "Accept: application/json" \
                -d "${body}" "${url}")
  if [[ "${status}" -lt 200 || "${status}" -ge 300 ]]; then
    echo "[FAIL] ${label} — HTTP ${status} — body saved to ${out}" >&2
    exit 1
  fi
  summarise "${label}" "${out}"
}

summarise() {
  local label="$1" file="$2"
  python3 - "$label" "$file" <<'PY'
import json, sys
label, path = sys.argv[1], sys.argv[2]
try:
    d = json.load(open(path))
except Exception as e:
    print(f"[WARN] {label} — non-JSON response ({e})")
    sys.exit(0)
wp = d.get("write_performed")
if wp is not False:
    print(f"[!!!!] {label} — write_performed = {wp!r} — STOP AND ESCALATE", file=sys.stderr)
    sys.exit(3)
bits = [f"write_performed={wp}"]
for k in ("group_count", "status", "proposed_survivor_id", "proposed_canonical_site_id"):
    if k in d: bits.append(f"{k}={d[k]}")
print(f"[ OK ] {label} — " + " ".join(bits) + f" — file={path}")
PY
}

# =============================================================================
# A. Homes-list duplicates
# =============================================================================
run_get "01_homes_tunbridge_wells" \
  "${API_URL}/api/admin/diagnostics/homes-list-duplicates?home_name=Tunbridge%20Wells%20Care%20Centre&limit=50"

run_get "02_homes_wadhurst_manor" \
  "${API_URL}/api/admin/diagnostics/homes-list-duplicates?home_name=Wadhurst%20Manor&limit=50"

# =============================================================================
# B. Sam Whiteman (0095) — client duplicates + 7-day activity
# =============================================================================
run_get "03_clients_duplicates_sam" \
  "${API_URL}/api/admin/diagnostics/clients/duplicates?franchisee_id=${SAM_FRANCHISEE_ID}&limit=500"

SAM_EMAIL_ENC=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "${SAM_EMAIL}")
run_get "04_user_activity_sam_7d" \
  "${API_URL}/api/admin/diagnostics/user-activity?franchisee_id=${SAM_FRANCHISEE_ID}&email=${SAM_EMAIL_ENC}&days=7"

# =============================================================================
# C. Identity resolution for every duplicate client ID returned
# =============================================================================
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

# =============================================================================
# D. Dry-run client merges — first 2 IDs of each duplicate group
# =============================================================================
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

# =============================================================================
# E. Dry-run site grouping — pairs of CQC location IDs from files 01 + 02
# =============================================================================
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

# =============================================================================
# F. Combined human-readable summary
# =============================================================================
python3 - "${OUT_DIR}" <<'PY'
import glob, json, os, sys
outdir = sys.argv[1]
summary = {"output_directory": outdir, "files": {}}
for f in sorted(glob.glob(os.path.join(outdir, "*.json"))):
    if os.path.basename(f).startswith("_"): continue
    try: d = json.load(open(f))
    except Exception: continue
    entry = {k: d.get(k) for k in
             ("write_performed", "diagnostic_version", "build_commit", "environment")}
    for k in ("group_count", "status", "proposed_survivor_id", "proposed_canonical_site_id"):
        if k in d: entry[k] = d[k]
    summary["files"][os.path.basename(f)] = entry
with open(os.path.join(outdir, "SUMMARY.json"), "w") as fp:
    json.dump(summary, fp, indent=2)
print()
print("=== SUMMARY ===")
print(json.dumps(summary, indent=2))
PY

echo
echo "=========================================================="
echo "DONE. Reports written to: ${OUT_DIR}"
echo "SUMMARY: ${OUT_DIR}/SUMMARY.json"
echo
echo "Confirm every response has write_performed=false BEFORE"
echo "sharing the reports back for Phase B/D approval."
echo "=========================================================="
