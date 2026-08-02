# Creative Mojo Admin — PRD

## Original problem statement
Bespoke admin system for a franchise business consolidating Airtable, FileCamp, legacy CRM, Invoicing, and Banking modules into a single robust platform. Modules include: Territory mapping, Marketing e-shot composer, Franchise Store, Xero integration, File Vault, Video Hub, Sales Pipeline CRM, Project Linking, WYSIWYG Email Template Editor, Lead Temperature Scoring, custom PDF Landing Pages, CQC database sync, Contract Management System (CMS), MyTerritory+ (per-franchisee CRM + client pool).

## Architecture
- Backend: FastAPI (`/app/backend/server.py` monolith >7000 lines + modular routers e.g. `find_class_routes.py`, `contracts_routes.py`)
- Frontend: React + Tailwind + shadcn/ui + Mapbox GL JS
- DB: MongoDB
- Object storage: Cloudflare R2
- Integrations: Xero, Resend, WooCommerce, CQC API, Mapbox

## Recent changelog
- 2026-02-02 — Sales Pipeline Feb tweaks: Summary panel gains 2nd Line of Address, County/State, Country fields (edit + display); "Town" renamed to "Town/City"; contact name bolded (font-bold) in row top bar; Convert-to-Franchisee panel narrowed and paired with new CHANGE TYPE dropdown (Franchise / Licence / General) that reuses POST /api/contacts/{id}/move for reclassification. Drawer's Change type menu now shares the same `changeContactSource` helper for behavioural parity.
- 2026-02-XX — Fix: Numbered map markers on MyTerritory+ (`FranchiseeTerritoryWidget`) now open the detail entry modal on click (same as row click), instead of only highlighting the circle. Plus/admin layouts only; basic franchisees unchanged.
- Map Popup Overhaul: public map now pulls from Franchisee Portal checkboxes only, no WP fallbacks.
- Portal UI: Territory/Name/Image/Facebook opt-in checkboxes on `PortalDetailsPage`.
- Contract Renewal Fee: £500 default on Add/Renew modal.
- Map iframe: `/api/find-class/embed.html` exposed publicly with `frame-ancestors` CSP for WordPress embedding.

## Backlog (prioritised)
### P0 / In progress
- Verify WP iframe replacement (user action on WordPress side)
- After WP iframe confirmed, delete dormant WP Bio Migration tooling

### P1
- Sam Whiteman's File Vault empty — build `/api/admin/files/diag`
- Contacts Page blank on Preview (recurring 6×)
- `/api/email/sends` 500 hardening (Kathryn Wal malformed BSON)
- Harden CQC sync (retry, completeness, stale warnings)
- Mobile-friendly Admin Sales Pipeline
- `{{first_name}}` chip pill in Tiptap editor
- Marketing+ insert image from File Vault into e-shot composer
- "Plan a Route" → Mapbox Directions
- Resend inbound webhook (blocked on user secret)

### P2
- Phase 5c auto-draft follow-up emails
- 60-day Hub+ free trial automation
- GoCardless recurring subscription post-trial
- Meta Ads Dashboard for Hub
- Admin view of MyTerritory+ Clients
- Phase 3 Website Migration (WooCommerce products, content, order history)
- Refactor `server.py` into distinct routers
- Specialisms filter dropdown on MyTerritory+ Territory pool (paused by user)

## Changelog

### 2026-07-31 — Admin force-delete for test contracts
- Added `DELETE /api/admin/contracts/{id}/force?confirm=true&reason=...` (in `contract_issuance_routes.py`) for testing-only hard-delete of issued / signed / superseded / revoked contracts. Requires explicit `confirm=true` + written reason, removes personalised + signed PDFs from R2, reverses supersede on predecessor, audit event is preserved.
- Added "Delete (test)" button on `AdminContractsPage.jsx` for every non-draft row with double confirmation (window.confirm + reason prompt).
- Unblocks the drawn-signature test flow — a stale signed test contract no longer forces the new one into "renewal" mode.

### 2026-08-01 — Fix: stale-variables completeness check + Refresh-and-issue UX
- **Root cause of the recurring "missing markers" 409:** `_all_marker_codes` was reading `data_type` from the template's `markers[*]` array — where `data_type` is always `None`. The Marker Library is the authoritative source (matching what the resolver already does). Old check silently included `signature_anchor` markers in the required set.
- **Fix:** `_all_marker_codes(markers, library_by_code)` now consults the library. Added `POSITIONAL_ONLY_DATA_TYPES = {"signature_anchor"}` constant — extensible for future positional/redaction-only marker types.
- **Better error payload:** `/admin/contracts/{id}/issue` now returns `reason_code: "stale_frozen_variables"`, `missing_marker_codes: [...]`, `template_id`, `template_version` alongside a plain-English admin message.
- **Frontend recovery flow:** `resolveAndIssueContract` detects `reason_code === "stale_frozen_variables"`; new `<RefreshAndIssueModal>` on AdminContractsPage shows the missing marker chips and a "Refresh and issue" action that calls `POST /admin/contracts/{id}/refresh-variables` with a reason then retries `/issue`. Browser `alert()` no longer leaks API instructions.

### 2026-08-01 — Fix: render engine now sees signature_anchor + structured invariant errors
- **Real root cause found:** the render engine looks at `data_type` on each marker dict it receives — but `template.markers[*]` has `data_type: None` (only the Marker Library stores it). Signature-anchor markers therefore fell through into the `missing_value` invariant. Combined with my earlier `_all_marker_codes` fix (which correctly excluded them from `values_map`), the render step then hard-failed on issuance every time.
- **Fix at the issuance layer:** `contract_issuance_routes.py` now enriches each marker with the library `data_type` BEFORE calling `engine.render`. Positional-only markers reach the engine's `signature_anchor` branch and get redacted + recorded, exactly as designed.
- **Structured invariant errors:** `RenderError` now carries `invariant`, `marker_code`, `page`, `bbox`, `context` fields. Every raise site in the engine populates them. The 422 response body now returns `reason_code: "render_invariant_failed"`, `failed_invariant`, `marker_code`, `page`, `bbox`, `template_id`, `template_version`, `render_job_id`, `offenders`, `raw_error`, `context`. Every failure is also logged with the full traceback + all context against the contract ID for post-mortem.
- **Frontend:** `resolveAndIssueContract` returns `{kind: "render_invariant_failed", failedInvariant, markerCode, page, bbox, renderJobId, ...}`. New `<RenderErrorModal>` on AdminContractsPage shows the invariant, marker, page, bbox, template + render job id and a human-friendly copy line keyed off `failed_invariant` (e.g. "Issue failed because the signature anchor could not be located in the rendered PDF. Please check the marker placement in the template."). Browser `alert()` no longer used for these classes of failure.
- **Belt-and-braces guard:** if template library declares `signature_anchor` but render_report has zero anchor occurrences (should not happen after the fix), return `failed_invariant: "signature_anchor_not_persisted"` with the specific message + log the full context.

### 2026-08-02 — Sales Pipeline Tabs: layout matched to reference (New visual.jpg)
- **Structural fix:** collapsed row and expanded card used to be separate components with separate top bars. Now unified — one `PipelineRow` renders a persistent `<TopBar>` in both states + a conditional `<ExpandedBody>` beneath, all inside a single tinted container so the heat wash + thick keyline wrap the whole selected unit.
- **Top-bar actions never move:** Reply-with-Template + View-Correspondence buttons now sit in the top bar of every collapsed AND expanded row. Old bottom action row removed. Quick Reply removed entirely.
- **4-column expanded grid:** Summary (col 1, full-height) | Move to Stage (col 2) | Plan Their Territory + Convert to Franchisee stack (col 3) | Notes (col 4, full-height). Follow-up Status spans cols 2+3 beneath the middle stack, no longer stretching under Summary or Notes.
- **Summary panel:** email/phone/town/postcode+MAP with breathing room, date + age at the bottom above a divider (matches the mockup). Email no longer duplicated where the town should be.
- **Move to Stage 2×3 grid** in the visual order New/Contacted, Interested/Dormant, Follow-up Due/Lost with solid coloured pill for the current stage.
- **Notes panel full height** — `AdminNotesEditor` gained a `fullHeight` prop that swaps `rows={4}` for `flex-1` so the textarea grows to fill the right column.
- **Stage pill removed from top bar** — the active tab strip already signals the stage; keeps the top bar clean per the mockup.
- Verified on preview: 135 collapsed rows carry both top-bar actions, expanded row shows all six panels with no quick-reply footer, tinted keyline wraps the whole unit.

### 2026-08-02 — Sales Pipeline Tabs: UX polish pass
- **Header click collapses.** Clicking anywhere on the expanded card's tinted header strip toggles the row shut. Interactive children (MAP button, chevron button) stop propagation so they still function.
- **Row dividers** darkened from `divide-stone-100` → `divide-stone-200/80` so vertical row boundaries read at a glance.
- **Territory-plan card removed from compact rows** (still shown in the expanded panel). Compact row grid tightened from 7 → 6 columns.
- **Solid-colour active tab.** Tab bar for active section now renders a solid coloured block: New=stone-900 (white text), Contacted=blue-600, Follow-up Due=amber-500, Interested=emerald-600. Matches the count-pill against a lighter tint on the same accent so the active section is unmistakeable.
- **Solid Move-to-Stage lozenges.** `STAGE_PILL.activeCls` swapped from outlined-with-ring to a solid fill in that stage's colour (stone-900 / blue-600 / amber-500 / emerald-600 / orange-500 / red-600). Disabled + `aria-current` when active.
- **View Correspondence full-screen modal.** New `<CorrespondenceModal>` renders a `fixed inset-0` overlay with header (CORRESPONDENCE label + contact name + close) and an empty body placeholder ("Email correspondence layout coming next"). ESC + backdrop click + close button all dismiss. Body scroll locked while open.

### 2026-08-02 — Sales Pipeline Tabs: inline edit + heat-tinted card + stage highlighting
- **Inline edit in Summary** — Edit button no longer opens the drawer. Swaps the panel into an in-place form (email / phone / address / city / postcode) that saves via the existing `PATCH /contacts/{id}/details` endpoint. Diff-only payload so a stale drawer edit isn't overwritten.
- **Move to Stage current-stage highlighting** — active pill picks up its stage colour + a matching ring (e.g. Contacted → blue ring, Interested → emerald, Dormant → orange), and is disabled so it can't be clicked to itself.
- **Checklist panel removed entirely** from the tabs view (it's only relevant after conversion to a franchisee).
- **Heat-tinted expanded card** — whole card background gets a soft gradient wash based on the contact's temperature: cold=blue, warm=purple, hot=orange (three-tier scale matching the flame swatches). Header no longer standalone-tinted; the wash wraps the entire expanded panel so the temperature is visible even when scrolling below the header.
- Expanded layout locked to match the mockup: heat-tinted card → header strip → Row 1 (Summary + edit · Plan territory · Notes · Convert) → Row 2 (Move to Stage · Follow-up Status) → Quick Reply / Reply with Template / View Correspondence.
- Verified on preview: all six panels render, checklist gone, inline email input appears on Edit click, NEW stage button correctly marked disabled/aria-current on a NEW-stage contact.

### 2026-08-02 — Sales Pipeline Tabs: expanded panel now mirrors the drawer
- Expanded row rebuilt so every drawer action is one click away without leaving the tabs view:
  - **Summary** now carries the full contact card — email, phone, address lines, postcode + MAP button, first-seen date + "N days ago" — plus an **Edit** button that opens the drawer for inline editing.
  - **Checklist** panel no longer double-labels — the reused `<InterestedChecklist>` widget carries its own header + blue-tinted outline, so we render it without an outer title.
  - **Convert to Franchisee / Licencee** panel replaces the old empty Activity box. Yellow-gradient background (`from-[#dddd16]/10 to-stone-50`) matching the drawer, primary "Convert" button + "Link to existing" secondary, flips to an emerald "Already converted" card once linked.
  - **Move to Stage** pill grid (New / Contacted / Follow-up Due / Interested / Dormant / Lost) with the current stage highlighted in its stage colour + "Remove from sales pipeline" button.
  - **Follow-up status** amber panel with "MARK FOLLOW-UP ALREADY SENT" (only appears when `follow_up_sent_count == 0`; flips to an emerald "Follow-up recorded" chip otherwise).
- Callbacks wired from `ContactsPage`: `onStageChange`, `onDemote`, `onConvert`, `onLinkExisting`, `onMarkFollowUpSent` — same handlers the drawer uses so behaviour + audit trail stay identical.
- Rounded outlines + tinted backgrounds throughout (default white / yellow-tinted convert / amber follow-up / emerald recorded), matching the drawer's card language.

### 2026-08-01 — Sales Pipeline: Tabbed list view
- New `<SalesPipelineTabsView>` (in `src/components/pipeline/`) replaces the flat list on the Sales Pipeline tab. Four full-width tabs: NEW / CONTACTED / FOLLOW-UP DUE / INTERESTED. Dormant + Lost stay on the kanban only (per user pref).
- LIST toggle renamed to **TABS** with a `Rows3` icon; internal state key kept as `"list"` to avoid churn on saved recentSearches.
- Row layout matches the mockup: CSS-grid columns for Name/email · Stage pill · Postcode + Map button · Heat flame + numeric score · Emailed / Not emailed chip · Territory-plan action card (flips between "Plan their territory / OPEN BUILDER" and "Territory plan linked / SEE LINKED PLAN"). Row expands in place to reveal Summary / Checklist / Activity / Notes side-by-side.
- Postcode MAP button opens the same `ContactPostcodeMapModal` the drawer uses (`onOpenPostcodeMap` callback + top-level modal mount).
- Panels reuse `InterestedChecklist`, `EmailTimeline`, `AdminNotesEditor` via named re-exports.
- **Backend:** `/api/contacts?tab=pipeline` now aggregates `email_sends_count` + `email_sends_last_at` (from `email_sends`) AND a compact `linked_plan` summary (from `territory_plans`, latest per contact) so both the Emailed chip and the Territory-plan action card render accurately with zero per-row network calls.
- Named re-exports `InterestedChecklist` and `AdminNotesEditor` added at the bottom of `ContactsPage.js` so the tabs view uses the exact same widgets as the drawer (single source of truth).
- Verified live on preview: 132 rows render with proper column spread, MAP button, HEAT score, Emailed chip and Territory-plan card correctly.

### 2026-08-01 — Fix: portal signature submission "m7 is not a function"
- **Root cause:** `getTrimmedCanvas()` from `react-signature-canvas` bundles the `trim-canvas` helper lazily; the production CRACO chunk-split mangles the export path so the reference resolves to an undefined minified name (`m7`) at runtime.
- **Fix:** `PortalContractsPage.jsx::accept()` now uses `sigPadRef.current.getCanvas().toDataURL("image/png")` — a direct property on the ref, no lazy dep. Sends the full transparent canvas; the backend's existing `_trim_png_padding` (PIL alpha bbox crop) handles the padding.
- **Split error boundaries:** signature extraction and API upload are now in separate try/catch blocks with distinct console.error logging (stack + status + response body) so the UI can distinguish preparation failures from upload failures.
- Sign button was already disabled during `signing=true` via the existing `canAccept` guard.
- **Root cause of the recurring "missing markers" 409:** `_all_marker_codes` was reading `data_type` from the template's `markers[*]` array — where `data_type` is always `None`. The Marker Library is the authoritative source (matching what the resolver already does). Old check silently included `signature_anchor` markers in the required set.
- **Fix:** `_all_marker_codes(markers, library_by_code)` now consults the library. Added `POSITIONAL_ONLY_DATA_TYPES = {"signature_anchor"}` constant — extensible for future positional/redaction-only marker types.
- **Better error payload:** `/admin/contracts/{id}/issue` now returns `reason_code: "stale_frozen_variables"`, `missing_marker_codes: [...]`, `template_id`, `template_version` alongside a plain-English admin message.
- **Frontend recovery flow:** `resolveAndIssueContract` detects `reason_code === "stale_frozen_variables"`; new `<RefreshAndIssueModal>` on AdminContractsPage shows the missing marker chips and a "Refresh and issue" action that calls `POST /admin/contracts/{id}/refresh-variables` with a reason then retries `/issue`. Browser `alert()` no longer leaks API instructions.

### 2026-07-31 — File Vault diagnostic endpoint
- New `GET /api/admin/files/diag?q=<id|number|name|org>` (admin-only, read-only by default) in `files_routes.py`. Locates the franchisee, derives the expected R2 prefix, counts files_index rows bound to it, surfaces orphan/wrong-id rows under the prefix, lists actual R2 objects, flags un-indexed R2 keys, and searches "nearby" prefixes sharing the same franchise number (catches organisation renames after upload).
- Optional `?rebind_orphans=true` rewrites every row under the expected prefix whose `franchisee_id` is null or wrong, binding them back to this franchisee (nothing deleted; only `franchisee_id`/`scope` updated).
- Verdict codes: `looks_healthy` / `no_files_at_all` / `all_orphaned_under_prefix` / `hidden_or_trashed` / `r2_has_objects_but_no_index` / `renamed_or_wrong_prefix`, each with a plain-English hint on next action.

## Key files
- `/app/frontend/src/components/territory/FranchiseeTerritoryWidget.jsx` — MyTerritory+ orchestrator
- `/app/frontend/src/components/territory/TerritoryMap.jsx` — Mapbox layer + markers
- `/app/frontend/src/components/territory/TerritoryHomesList.jsx` — CQC homes list
- `/app/frontend/src/pages/FranchiseeDetailPage.js` — Admin franchisee page
- `/app/backend/find_class_routes.py` — Public map popup API + iframe embed
- `/app/frontend/src/pages/AdminContractsPage.jsx` — Contracts + renewal fee UI

## Test credentials
See `/app/memory/test_credentials.md`.
