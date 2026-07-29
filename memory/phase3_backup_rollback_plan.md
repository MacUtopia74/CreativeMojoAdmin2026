# Phase 3 CQC repair — Backup, rollback and durable-storage plan

**Last updated:** Feb 2026 · **Status:** Dry-run ready. Awaiting HQ approval.

## What Phase 3 writes

Only:
* `cqc_locations_live` — new `insert_one` operations (never updates).
* `cqc_phase3_jobs` — one job document per commit run.
* `cqc_phase3_insert_log` — one Mongo audit row per commit run.
* R2 bucket `creativemojo-files` under prefix `admin/cqc-phase3-backups/{job_id}/`
  * `pre_commit_live_ids.txt` — full snapshot of every locationId in `cqc_locations_live` at the moment the commit began. Written **before** any insert.
  * `inserted_ids.txt` — the exact list of locationIds actually inserted.

Every inserted document also carries two extra fields to make rollback surgical:

```
phase3_inserted_at : timestamp
phase3_job_id      : string
```

Rollback deletes documents whose `phase3_job_id` matches, and never touches any pre-existing row.

## Durable storage

R2 (Cloudflare Object Storage) is the durable backing store. Both artefacts are written with:

* `ContentType: text/plain`
* `CacheControl: private, no-store`
* `Metadata: job-id, row-count, sha256`

R2 lives outside the Kubernetes pod, retains data through pod restarts / rebuilds, is versioned by Cloudflare, and is the same bucket used for all other durable HQ artefacts (contract PDFs, franchisee photos, DBS files).

**Endpoint requires R2 to be configured** — `_write_backup_to_r2()` raises `RuntimeError("R2 not configured — refuse to run without durable backup")` if `R2_ENDPOINT_URL/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY/R2_BUCKET` are not all set. This means the endpoint physically cannot run without a durable backup path.

## Rollback procedure

**Option 1 — API rollback (recommended, tested):**

```
POST /api/cqc/phase3/rollback
  Authorization: Bearer <admin token>
  { "job_id": "phase3-<timestamp>-<hex>" }
```

Behaviour:
1. Load the `inserted_ids.txt` from R2 (durable source).
2. For each ID, call `delete_one({"locationId": lid, "phase3_job_id": job_id})`.
3. The `phase3_job_id` clause ensures we can only ever delete rows this job inserted — pre-existing rows (which never carry the `phase3_job_id`) are provably safe.
4. Mark the job as `rolled_back` with count and timestamp.

**Option 2 — Manual disaster recovery (if the API is unreachable):**

1. Download `admin/cqc-phase3-backups/{job_id}/pre_commit_live_ids.txt` from R2.
2. Diff against current `cqc_locations_live` to identify the delta.
3. Delete: `db.cqc_locations_live.delete_many({"phase3_job_id": "<job_id>"})`.

## Explicit non-goals of Phase 3

* No status flips on existing rows.
* No service-type updates on existing rows.
* No changes to `franchisee_clients`, `hq_home_notes`, `territories`, `franchisees`, `contacts`, `email_sends`, or any CRM data.
* No changes to the `reclassified_records` set (154 records with Registered/filter-matching live vs Deregistered/non-matching staging). These are exported by the diff-report only and remain visible to franchisees exactly as they are today.
* No `mode` argument on the commit endpoint — upsert semantics are physically impossible without editing and redeploying the endpoint source.

## Confirmation-token binding

The `POST /cqc/phase3/commit-append` endpoint re-computes the dry-run in-process and rejects any request whose `confirmation_token` does not match the current data. The token is `SHA256(SHA256(sorted_ids) || SHA256(counts))`, so:

* Approving a dry-run at time T, then finding staging has changed at time T+n, will 403 the commit until a fresh dry-run is issued and re-approved.
* Replaying a stale token cannot cause a different set of records to be inserted.

## Sample workflow

```
1. GET  /api/cqc/phase3/dry-run              → confirmation_token = X
2. (HQ reviews counts, gives approval)
3. POST /api/cqc/phase3/commit-append
        { "confirmation_token": "X" }         → job_id = J
4. GET  /api/cqc/phase3/status?job_id=J       → progress
5. (Optional rollback if anything looks off)
   POST /api/cqc/phase3/rollback
        { "job_id": "J" }
```

## Test coverage

`tests/test_cqc_phase3_insert_only.py` — 7 tests, all green:

1. Dry-run counts match hand-computed values (reads only, writes nothing).
2. Dry-run mutates no collection counts.
3. Static contract: `_run_insert_only` signature contains no `mode/upsert/update/replace/delete` parameter; module source uses no `LIVE_COLL].update_*` / `delete_*` / `replace_*` operations.
4. Existing live docs are byte-identical (except `_id`) before and after a full run against a duplicate ID.
5. Duplicate `locationId` returns `DuplicateKeyError` from Mongo and is counted as `skipped_duplicate_count`, not converted to an update.
6. `franchisee_clients`, `hq_home_notes`, `franchisees`, `territories` all hash byte-identical before and after (SHA-256 over the full document set).
7. Deregistered staging documents are never inserted, even if their locationId is passed in the expected list.
