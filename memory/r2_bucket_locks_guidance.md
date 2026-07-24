# Creative Mojo — R2 Bucket Locks (Optional Hardening)

*Phase 1A · Storage integrity supplement · NOT enabled by default*

This document explains the optional per-prefix retention hardening the
user can turn on for the contract-templates bucket. Bucket Locks are a
Cloudflare R2 feature separate from AWS S3's `Object Lock`. Per the
Phase 0 amendments, **the application works correctly whether Bucket
Locks are on or off**; enabling this is a Cloudflare-side configuration
change requiring no code deployment.

## What Bucket Locks provide

Per-prefix retention rules on the R2 bucket. Once configured, objects
written under a matching prefix cannot be overwritten or deleted until
the retention expires (or forever, if set to "indefinite retention").
This includes admin API calls — an accidental or malicious `DELETE` or
`PUT` on the same key will be rejected by R2.

Bucket Locks are enforced at the storage layer, independent of
application code. This is the strongest guarantee of physical
immutability we can obtain on R2 today (AWS S3 Object Lock / WORM is
not supported).

## Recommended configuration

For the `creativemojo-files` bucket, once Phase 3 (signed contracts) is
live, apply two rules via the Cloudflare dashboard **or** the R2 API:

| Rule | Prefix | Retention | Rationale |
|---|---|---|---|
| Signed contracts | `contract-templates/*/signed.pdf` | **Indefinite** | Legal artefacts — cannot be modified once written. |
| Source templates | `contract-templates/*/source.pdf` | **7 years** (or your legal retention policy) | Original authoring source. |
| Marker overlay thumbnails | *(not covered)* | none | Rasterised previews — regenerable, not archival. |

## How to enable

**Via the Cloudflare dashboard:**

1. Log in to Cloudflare → R2 → `creativemojo-files` bucket.
2. Open the **Settings** tab.
3. Scroll to **Bucket Lock**.
4. Click **Add rule** → set the prefix (e.g. `contract-templates/`),
   retention period, and mode (`Governance` or `Compliance`).
5. Save.

**Via the R2 API** (equivalent, scriptable):

```
PUT /?bucket-lock HTTP/1.1
Host: <account_id>.r2.cloudflarestorage.com
Content-Type: application/json

{
  "rules": [
    {
      "id": "signed-contracts-indefinite",
      "enabled": true,
      "prefix": "contract-templates/",
      "matches": [{ "type": "suffix", "value": "/signed.pdf" }],
      "condition": { "retentionPeriod": "indefinite" }
    }
  ]
}
```

## What Bucket Locks do NOT provide

- **They are not a cryptographic signature.** The R2 object is still
  physical bytes; a Bucket Lock prevents replacement, not tampering by
  someone who can produce a bit-identical copy. Our SHA-256 hash chain
  is the tampering-detection mechanism.
- **They do not stop a Cloudflare account owner from disabling the
  rule.** Bucket Locks protect against day-to-day admin API calls, not
  against a Cloudflare account compromise. Combine with 2FA + limited
  API tokens.
- **They will slightly complicate template lifecycle operations.**
  Once a `source.pdf` is under a lock rule, `POST /duplicate` cannot
  simply overwrite an R2 key — the current code already writes to a
  fresh key per template, so this is fine, but any future refactor
  that assumes overwritability will break.

## Enable-checklist before turning on

1. Confirm your Cloudflare account has R2 Bucket Locks feature-flag
   enabled (it is generally available as of Nov 2025).
2. Decide the retention policy per prefix and record the decision on
   `/app/memory/PRD.md`.
3. Enable in **Governance** mode first (allows override with a special
   role) rather than **Compliance** mode (no override, ever).
4. Upload a test template + retrieve it + attempt an overwrite from a
   throwaway API token → confirm the overwrite is rejected.
5. Only then flip production keys to `Compliance` mode if desired.

No action is required from Emergent during Phase 1A; this is
documentation-only for HQ operations to enable when appropriate.
