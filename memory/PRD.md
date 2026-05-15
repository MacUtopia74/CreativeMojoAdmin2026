# Creative Mojo — Unified Admin Platform PRD

## Original Problem Statement (from user)
A UK franchise business (Creative Mojo — creative arts activities in care homes) wants to replace its fragmented stack (Airtable + FileCamp + a legacy bespoke admin built by an absent friend) with a single, owned, head-office-controlled platform.

## User Personas
- **Admin (Head Office staff)** — Paul Dunkerley and team. Full access.
- **Franchisee** (Phase 3) — Owns a territory; accesses own files + shared brand files. ~88 active.
- **Licensee** (Phase 5) — Pays AUD monthly via GoCardless; 8 downloads/month quota.

## Tech Stack
- Backend: FastAPI + MongoDB + bcrypt + PyJWT + httpx
- Frontend: React 19 + React Router 7 + Tailwind + lucide-react
- Storage (future): Cloudflare R2
- Map (future): Mapbox GL JS
- Auth: Email + password JWT with httpOnly cookies

## Design Direction
Swiss & high-contrast light theme. Cabinet Grotesk (display) + Manrope (body). Yellow `#D4FF00` accent used sparingly.

## Build Plan
- **Phase 1** ✅ Admin shell + login + CRM core + Airtable migration + WordPress form pipeline (×3 forms) + anniversary reminders scaffold
- **Phase 1.5** ✅ GoCardless live mandate status (read-only API + webhook). Live status pill + last/next payment + dashboard alerts + dry-run sync.
- **Phase 1.6** ✅ Sales pipeline (simple): Kanban view of enquiries with stages New → Contacted → Qualified → Demo Booked → Converted → Lost
- **Phase 1.7** ✅ One-click Convert to Franchisee/Licencee from sales pipeline; Franchisee detail page consolidates contracts (Contracts sidebar tab retired)
- **Phase 2** Order management + WooCommerce live sync + Gantt view
- **Phase 3** Franchisee logins + Cloudflare R2 file storage + file browser (FileCamp retired)
- **Phase 4** Territory mapping tool + public find-a-class embed (replaces DaD Postcode Lookup)
- **Phase 5** Licensee portal + 8-download/month quota + optional GoCardless webhook

## What's Implemented (2026-05-15)

### Phase 3 — Iteration 20 (2026-05-15) ✅ Thumbnails + Recent folders + Recent strip enhancements
- **Real thumbnails for images and PDFs** in both the Recents strip grid and the main file grid view. Implementation:
  - **Images**: `<img>` with lazy loading + object-cover, served directly from R2 via 1h-signed inline URLs.
  - **PDFs**: client-side PDF.js (4.7.76) renders page 1 → JPEG dataURL → in-memory cache keyed by R2 key. Worker loaded from `unpkg.com/pdfjs-dist/.../pdf.worker.min.mjs`.
  - Backend `_attach_preview_url` enriches eligible items with `preview_url` (for `<img>`) and `pdf_proxy_url` (for PDF.js).
  - **R2 CORS workaround**: new same-origin endpoint `GET /api/files/proxy?key=...` streams R2 object bytes through the backend (admin-only). PDF.js can fetch via XHR without browser CORS blocking.
- **Recent strip**: added folder rendering. `/api/files/recent` now returns a `folders` array — distinct parent prefixes that received new files in the last 30 days, with file count + bytes + latest_at + franchisee label. Folders are sorted first; click jumps into them.
- **Recent strip view toggle**: independent **List / Grid** toggle inside the strip (persisted as `localStorage.recentStripView`), decoupled from the main browser's view mode.

### Phase 3 — Iteration 19 (2026-05-15) ✅ Trash bin + Recent-files strip
- **Trash bin UI**: new sidebar "Trash" entry → main pane lists every soft-deleted folder with `deleted_at`, who deleted it, file count, size. Per-entry **Restore** (moves it back to its original path) and **Delete forever** (hard-purges from R2 + index). Header has **"Delete all now"** which requires a `EMPTY` typed-confirmation before purging the whole trash.
- **Recent files strip**: moved out of the sidebar into a **collapsible card directly above** the file tree. Default open, persisted in `localStorage.recentStripOpen`. Switches between thumbnail tiles (when grid view is on) and a dense scrollable list (when list view is on). Click a file to preview; one-click download per row.
- **New backend endpoints**: `GET /files/trash`, `POST /files/trash/restore`, `DELETE /files/trash/item?trash_prefix=...`, `DELETE /files/trash/empty?confirm=EMPTY`.
- **New frontend components**: `components/files/RecentFilesStrip.jsx`, `components/files/TrashView.jsx`.

### Phase 3 — Iteration 18 (2026-05-15) ✅ Folder operations + Recents + Folder share + Franchisee Files panel
- **Admin folder operations** (`POST /files/folder/rename`, `POST /files/folder/move`, `DELETE /files/folder`): rename inline, move via tree-picker, soft-delete (moves contents under `.trash/<ISO-ts>/...` — kept for future cron-purge after 30 days). All admin-only.
- **`GET /files/recent?days=30`**: returns files uploaded/imported in the last 30 days, scoped to `franchisee` + `shared` only (admin-only folders intentionally excluded — safe for the future franchisee portal). New sidebar entry `Recently added · 30 days` in FilesPage with badge counts and franchisee labels.
- **Folder Share** (`POST /files/folder-share`, public `GET /files/folder-share/{token}` + `/zip`): admin generates a 1–30 day link; recipient lands on `/share/folder/:token` with a clean public page listing every file with individual download buttons AND a "Download All as ZIP" button. No size cap (in-memory ZIP — fine up to ~100MB folder size as user confirmed).
- **Admin ZIP** (`GET /files/folder-zip?prefix=...`): authenticated download of any folder as a ZIP for in-app workflows.
- **FranchiseeFilesPanel**: reusable component embedded in `FranchiseeDetailPage` — shows a franchisee's own R2 folder with breadcrumb navigation + per-file download + "Download this folder as ZIP". Same component will be the primary view for Phase-3 franchisee portal users.
- **Hygiene**: `/files/scope-tree` and `/files/tree` (root) now exclude the `.trash/` prefix so soft-deleted items don't pollute the admin sidebar or root browser.
- **New frontend modules**: `components/files/FolderActionsMenu.jsx`, `FolderMovePicker.jsx`, `FolderShareModal.jsx`, `FranchiseeFilesPanel.jsx`, `pages/PublicFolderSharePage.jsx`.
- **Testing**: 15/15 regression tests pass (iter17 + iter18 at `/app/backend/tests/`).

**Deferred (per user) — not in this iteration:**
- Auto-create franchisee folder structure (`Artwork / Franchise Agreement / Territory`) on franchisee creation — user said "DON'T DO YET". Will be picked up in a follow-up.
- Drag-and-drop folder move — defer (kebab-menu + tree-picker is the chosen UX).
- ZIP streaming via `zipstream-ng` — in-memory ZIP is fine for the stated 50–100MB cap; revisit if folders grow.

### Phase 3 — Iteration 17 (2026-05-15) ✅ File browser UX fixes
Fixed 6 issues reported by user on the FilesPage in iteration 16:
- **Folder visibility bug**: `GET /api/files/tree` now considers hidden `.keep` placeholders when deriving sub-folders so empty/newly-created folders surface, but still excludes them from the user-facing `files` array.
- **Upload "Network error"** (R2 token can't `PutBucketCors`): switched to **server-proxied multipart** `POST /api/files/upload` (FormData → FastAPI UploadFile → boto3 `put_object`) with XHR upload progress on the frontend. Bypasses R2 CORS entirely. Direct presigned PUT endpoint kept (`/files/upload-url`) for future use once admin token CORS perms are available.
- **PDF Preview**: switched from `<iframe>` to `<object data='...#view=FitH' type='application/pdf'>` with `<embed>` fallback. Backend `GET /api/files/download` now sets `Content-Disposition: inline` (vs `attachment`) based on the `attachment` query flag — fixes browsers that were auto-downloading PDFs instead of rendering them.
- **Download button**: added a permanent yellow `Download` lozenge (data-testid `preview-download`) in the preview-modal header that uses the `attachment` URL.
- **Share links up to 30 days**: redesigned to use a stable app-side token. `POST /api/files/share-link {key, days(1..30)}` creates a token in `files_share_links`; public `GET /api/files/share/{token}` 302-redirects to a freshly-signed 1-hour R2 URL on each click (with `Content-Disposition: inline`). Works around R2's hard 7-day sigv4 cap. Token includes hit counter + revocable flag for future audit/UX.
- **List/Grid view toggle**: new view-mode toggle in the FilesPage toolbar (data-testids `view-list` / `view-grid`). Grid renders large tinted thumbnail tiles per file type, with per-tile Share + Download. Persists per-browser in `localStorage.filesViewMode`.
- **Content indexing** (Q from user): documented as not in scope — R2 is dumb storage. If full-text/OCR search is needed later, would require a background worker (Textract / Tika).

**Backend**: 7/7 pytest regression suite at `/app/backend/tests/test_iter17_files.py`. Frontend: 4/4 Playwright flows verified (view toggle, new folder, upload, preview download, share modal).

**Known recommendations from review (deferred — not blocking):**
- `POST /files/upload` reads full body into memory. Acceptable up to ~50MB; for larger franchise audio (60–200MB), switch to streaming `upload_fileobj`.
- `GET /files/share/{token}` does not pre-check object existence before 302; could surface a friendlier 410 if the underlying R2 object was deleted.

## What's Implemented (2026-05-14)

### Phase 1.5 — Iteration 16 (2026-05-14) ✅ GoCardless Live Read-Only
- **Read-only LIVE GoCardless integration** using the official `gocardless-pro` SDK (v3.4.0), API version `2015-07-06`. Never creates, cancels or modifies anything on the GoCardless side.
- **POST /api/gocardless/mandates/sync?dry_run=true|false** — paginates every GoCardless customer, looks them up by email (matches across `email`, `mojo_email`, **and** comma-split `secondary_email`), fetches each customer's mandate (status/scheme/reference/next_possible_charge_date). Dry-run is the **default**. With live data: 108 customers scanned, 88 franchisees, **89 matched**, 19 unmatched. Sync log persisted to `gocardless_sync_log` collection.
- **POST /api/gocardless/franchisees/{id}/refresh** — re-fetches mandate + latest payment + next subscription payment for one franchisee. Single-record write, no bulk-DB risk.
- **GET /api/gocardless/alerts?hours=24** — returns recent webhook events grouped into `mandate_cancelled / mandate_failed / mandate_expired / payment_failed`.
- **GET /api/gocardless/status** — diagnostic endpoint for the UI: shows whether GC is configured, environment (live/sandbox), webhook-secret presence, and the last sync record.
- **POST /api/webhooks/gocardless** — HMAC-SHA256 signature verification (`hmac.compare_digest` constant-time). Missing or bad signatures get 498. Verified events are stored in `gocardless_events` (audit log) and surface into `gocardless_alerts` on cancel/fail/expire actions. Auto-updates the matching franchisee's cached mandate status.
- **Frontend:**
  - **FranchiseesPage**: new "Sync GoCardless" top-bar button → opens modal with dry-run/commit two-step flow + sample match preview.
  - **FranchiseeDetailPage**: KPI tile replaced with live `MandatePill`; new `GoCardlessPanel` shows Status / Scheme / Last Payment (amount + DD/MM/YYYY) / Next Payment + "Refresh from GoCardless" button.
  - **DashboardPage**: new `gc-dashboard-alerts` tile under "Mandate Status" — green "✓ no failed payments" when clean; counters for failed payments / cancelled mandates when present.
- **Webhook secret left blank by design** — user adds it in `/app/backend/.env` after creating the webhook endpoint on the GoCardless dashboard. Until then the endpoint rejects 498 (safe default).

### Tests (iteration 16)
- Backend: 7/7 pytest pass (`test_iter16_gocardless.py`) — status endpoint, alerts default + custom window, **live dry-run with committed_count=0 assertion**, webhook signature missing → 498, bad sig → 498, good sig → 200 + alert rows in DB for both mandate.cancelled and payment.failed.
- Frontend: 100% — Dashboard tile renders; Franchisees sync modal opens, dry-run shows GC Customers 108 / Matched 89 / Unmatched 19; FranchiseeDetailPage `panel-gocardless` + `mandate-pill` + `kpi-mandate` all render correctly for both linked and unlinked franchisees; gc-refresh button works.
- Live data observed: Clementina Phillips → Mandate `MD01KMCHJGHKWN`, status `Active`, last payment £197.76 on 18/05/2026.

### Phase 1.7 — Iteration 15 (2026-05-14) ✅ Convert + Layout Consolidation
- **One-click Convert to Franchisee/Licencee** — new section in the ContactsPage drawer with a prominent CTA. Auto-derives `record_type` from the contact's source (`licence_enquiry` → Licencee, anything else → Franchisee). Backend `POST /api/contacts/{id}/convert-to-franchisee` creates the franchisee record, copies first/last/email/postcode/phones/organisation, stamps tags=['Converted from enquiry'], builds a notes string from the original message/referral_source/why_contacting/date (date now formatted DD/MM/YYYY), and marks the contact `pipeline_status='converted'` + `converted_to_franchisee_id`. Second call returns 409 idempotency lock. Email auto-lowercased, postcode auto-uppercased at insert-time. Drawer flips to "VIEW RECORD" (emerald) for already-converted contacts.
- **Franchisee Detail Page rewrite** — inline-edit on contact + address fields (Pencil → Save/Cancel, EditField component); prominent Current Contract card with `daysFromToday` countdown ("X days remaining" / "Expired Xd ago" / "Expiring" / "Soon" tiers and colour); Previous Contracts history table; Territory Map placeholder (Phase 4 Mapbox stub with dot-grid + postcode-sector pills); Original Enquiry panel (when present); KPI strip (Contracts / Territory / Mandate); 'Date Added' falls back to `created_at` when `date_added` empty.
- **Contracts sidebar tab removed** — `Layout.js` NAV no longer includes the standalone Contracts link. Contracts now live exclusively inside each franchisee's detail page (single source of truth, no double-handling). The /contracts route is still mounted in App.js for any old bookmarks.
- **Shared date helper** — `/app/frontend/src/lib/date.js` (`formatDate`, `daysFromToday`, `daysBetween`, `daysSinceToday`). All dates on FranchiseeDetailPage, drawer, and convert-note now use DD/MM/YYYY.

### Tests (iteration 15)
- Backend: 9/9 pytest pass (`test_iter15_convert.py`) — franchise→franchisee, licence→licencee, 409 idempotency, GET no _id leak, PATCH normalises postcode/email + updated_at/updated_by, 404 on missing, dashboard funnel intact, move/promote/demote regression, bulk-move regression.
- Frontend: 100% — sidebar without Contracts, drawer-convert label switches Franchisee↔Licencee by source, convert→confirm→navigate flow, FranchiseeDetailPage panels render, inline edit save persists + uppercases postcode, cancel-edit discards draft, already-converted state shows VIEW RECORD, 409 on 2nd convert, DD/MM/YYYY dates throughout.

### Phase 1 — Iteration 14 (2026-05-14)
- **Bulk pipeline stage change** — bulk action bar's "Move Selected ▾" menu (and per-row Move ▾) now lets you bulk-change pipeline stage on any tab. On the Sales Pipeline tab the first option re-labels to "Change Pipeline Stage" and the submenu header to "Change stage to"; selected cards stay visible and update in-place. From Franchise/Licence/General tabs the menu still reads "Sales Pipeline" + "Move to pipeline stage" and moves the contacts into pipeline at the chosen stage in one click. Works for all 6 stages: New / Contacted / Qualified / Demo Booked / Converted / Lost.

### Tests (iteration 14)
- Frontend: 100% — all label switching verified, in-place stage update on Pipeline tab, restore round-trip, Franchise-tab labels unchanged.
- Backend: 100% (implicit) — bulk-move endpoint already supported target=pipeline+pipeline_status; verified via API after each mutation.

### Phase 1 — Iteration 13 (2026-05-14)
- **Dashboard funnel bug fixed** — pipeline_funnel was counting every web_form_contact with `pipeline_status='new'` (1,664 stale ones from earlier import). Now filtered by `in_pipeline=True` so it matches the Sales & Contacts page exactly: New 24 / Demo Booked 1 / Converted 2. New `pipeline_funnel_by_source` field returned. Recent enquiries also gated on in_pipeline.
- **Source toggle on Sales Pipeline** — new 3-button group (All / Franchise / Licence) on /contacts (visible only when tab=pipeline). Each button shows live count, filters both kanban and list views. Composes with the Age filter (e.g. Fresh + Licence = recent licence leads only).
- Dashboard "Recent Enquiries" date now uses DD-MM-YYYY format.

### Tests (iteration 13)
- Backend: 4/4 pass (dashboard funnel & by_source split, recent enquiries date, /contacts?tab=pipeline regression).
- Frontend: 100% — dashboard bars correct (24/0/0/1/2/0), source filter button group on pipeline tab only, kanban+list filtering, compose with age filter, pipeline-summary tiles recompute by source.

### Phase 1 — Iteration 12 (2026-05-14)
- **30-day auto-route rule everywhere** — POST /api/contacts and POST /api/contacts/import now auto-promote franchise/licence contacts to Pipeline 'New' when their date is within 30 days. Per-row decision on imports. General/explicit-pipeline targets behave as before.
- **Date format DD-MM-YYYY** across the contacts page. Drawer "Added manually by … on …" now also uses DD/MM/YYYY.
- **Column order in list view** — Name/Establishment now comes BEFORE Date. Final order: [select] | Name | Date | Contact | Location | Source | Stage (pipeline only) | Move.
- **One-time sweep** — 14 imported licence contacts moved from Licence Contacts → Pipeline 'New' so the tab matches the rule.

### Tests (iteration 12)
- Backend: 13/14 tests pass (the 14th was a data-state observation, not a code defect — testing agent advanced 22 cards while validating the Reply button, restored manually afterwards).
- Frontend: 100% — list view column order verified ['', 'Name / Establishment', 'Date', 'Contact', 'Location', 'Source', 'Stage', 'Move'], dates DOM-scraped match DD-MM-YYYY, drawer manual flag DD/MM/YYYY, AgeBadge unchanged.

### Phase 1 — Iteration 11 (2026-05-14)
- **Airtable email backfill** — 1,661 web_form_contacts records had their `email` field populated with Airtable record IDs (e.g. `recBMgji6M3w1YxlF`) because the Airtable "Email" field is a `multipleRecordLinks` → Contacts table. Built a one-off backfill that resolved every linked record to its real email. Updated migration.py: a pre-Pass-1 step now builds `contacts_email_lookup` and resolves email_raw → email automatically on every future migration.
- **Red "Reply" button on Pipeline "New" cards** — every kanban card whose stage is "new" AND has an email shows a red Reply button (#E2462A) positioned between the source pill and the age badge. Click → opens default mail client via `mailto:` with To/Subject/Body pre-filled AND auto-advances `pipeline_status` from "new" → "contacted". Drawer also has a red Reply button (any stage with email).

### Tests (iteration 11)
- Backend: 5/5 pass. All 10 'New' pipeline contacts have valid emails matching `/^[^@]+@[^@]+\.[^@]+$/`. Email backfill survives roundtrip.
- Frontend: 100% — exactly 10 reply buttons rendered on Pipeline "New" cards with correct styling (#E2462A bg, white text, Send icon), drawer Reply button visible on stages-with-email. Click → stage auto-advanced new → contacted; card moves between columns.

### Phase 1 — Iteration 10 (2026-05-14)
- **30-day pipeline freshness rule** — one-time DB sweep: 9 recent franchise/licence enquiries moved INTO pipeline as "New"; 304 stale "New" records moved OUT to Franchise Contacts. Migration.py updated with the same logic. Records already advanced past "new" (contacted/qualified/etc) stay regardless of age.
- **WP form routing** — `FORM_IDS_IN_PIPELINE = {17, 32}` (Franchise + Licence forms). New submissions land in Sales Pipeline as "New" immediately.
- **Bulk CSV import** — POST `/api/contacts/import` (rows + target + dedupe_by_email). Frontend "Import CSV" button opens 3-step wizard: upload → preview/target → success. Auto-detects 11 common column aliases (Gravity Forms, Mailchimp, generic spreadsheets). Tolerant CSV parser handles quoted multi-line fields. Imported rows stamped with manually_added_by + import_batch.

### Tests (iteration 10)
- Backend: 16/16 pytest pass (target=licence/pipeline/general/franchise; validation; dedupe toggle; ISO-date truncation; auth; intake routing for forms 17/32/1).
- Frontend: 100% — Playwright import wizard E2E, target switching, pipeline-stage reveal/hide, success step, auto-jump to destination tab, manual-badge present on imported rows.

### Phase 1 — Iteration 9 (2026-05-14)
- **Manual-add indicator** — manually-created contacts (those with `manually_added_by` set) show a yellow ✨ Sparkles icon next to their name in both the list view and pipeline kanban cards. Drawer now also displays a banner "Added manually by `<email>` on `<long-format date>`".
- **Pipeline age filter** — on the Sales Pipeline tab, a row of 4 buttons above the summary tiles (All / Fresh ≤30d / Recent 30–90d / Stale >90d) filters the kanban + list to that age window. Live counts on each button. Made it immediately obvious that all 421 of the existing "New" pipeline records are >90 days old.
- **Shift-click range select** — clicking a row checkbox while holding Shift selects every row between the last-clicked anchor and the current one. Works in both list view and pipeline kanban. Gracefully falls back to single-toggle when the anchor is no longer selected.

### Tests (iteration 9)
- Backend: 2/2 tests in `test_phase1_manual_flag.py` pass (manually_added_by + created_at stored on creation and on GET; imported contacts carry no such field).
- Frontend: 100% — Playwright verified all 3 features: sparkle on row + drawer banner; age filter visible only on pipeline tab with correct counts and filter behaviour; shift-click 1→5 = 5 selected, then shift-click 8 = 8 selected (range extension); cleaned up post-test.

### Phase 1 — Iteration 8 (2026-05-14)
- **Smarter contact search** — multi-token AND, OR across fields, with relevance ranking. Searching "Penny Davies" now returns Penny Davies (exact full-name match) first, then anyone else with both tokens present, then partial matches. Single-token search returns all rows containing that token (e.g. "Davies" → 6 Davies-surnamed records). Regex special chars are escaped so "J.K." is safe. Case-insensitive.
- **POST /api/contacts** — admin can manually create a contact in any tab (target: pipeline/franchise/licence/general, with optional pipeline_status). Source mapped from target. Email auto-lowercased, postcode auto-uppercased. Stamped with `manually_added_by`.
- **Add Contact UI** — button at top-right of /contacts opens a modal with 4-target selector (Franchise / Licence / General / Sales Pipeline), pipeline-stage dropdown (only when target=pipeline), full contact fields + referral_source dropdown + notes. After save the page jumps to the destination tab. Defaults to the current tab (or Franchise when on Pipeline).

### Tests (iteration 8)
- Backend: 16/16 new tests in `test_phase1_search_addcontact.py` pass (search ranking, regex safety, case insensitivity; create contact for all 4 targets, validation, postcode/email normalisation, auth required).
- Frontend: 10/10 — Playwright verified search ordering, modal target buttons + pipeline stage reveal, validation, full create-flow with tab jump.

### Phase 1 — Iteration 7 (2026-05-14)
- **Licence Contacts tab** — new 4th tab in /contacts: Sales Pipeline / Franchise Contacts / Licence Contacts / General Contacts. Backend `/api/contacts?tab=licence` filter returns only source=licence_enquiry NOT in pipeline. franchise tab is now strictly source=franchise_enquiry (licence records no longer mixed in).
- **Move target='licence'** added to /contacts/{id}/move + /contacts/bulk-move so contacts can be reassigned between franchise/licence/general tabs and the pipeline freely.
- **Referral source extraction** — intake handler now stores `referral_source` (Instagram / Facebook / X / Google / TikTok / Friend / Word of Mouth / Other). Supports both a single-labelled "Where did you hear about Creative Mojo?" field and Gravity Forms' spread-key pattern (each radio option emitted as its own key with value == label).
- **Drawer UX** — contact drawer now shows referral source with matching social icon (Instagram/Facebook/Twitter for X icon, etc.) plus a "Heard about Creative Mojo via X" line.
- **Pipeline visual differentiation** — kanban cards display a "FRANCHISE" (stone) or "LICENCE" (indigo) source pill with a matching coloured left-border accent, so franchise and licence leads are visually distinct in the pipeline.
- **Form routing rule** — FORM_IDS_IN_PIPELINE = set() (empty). All new Gravity Forms submissions land in their respective Franchise/Licence/General Contacts tab; admin manually promotes worth-pursuing leads into the pipeline.
- **Migration in_pipeline rule** — records with `why_contacting` IN ("Franchise enquiry","Franchise Enquiry","Franchise Enquiry Contact Form") land in Franchise Contacts on import, not the pipeline.

### Tests (iteration 7)
- Backend: 16/16 new tests in `test_phase1_licence.py` pass (tab filters, target=licence move, licence→franchise source change, bulk-move, intake referral_source for forms 1/17/32, plus 6 unit tests on _detect_referral_source).
- Frontend: 100% — Playwright verified 4 tabs, Licence Contacts row + drawer with Instagram badge, Move dropdowns include licence option with current-tab-disabled behaviour, kanban cards have correct source pill + border accent (verified for both franchise stone and licence indigo).

### Current data state (2026-05-14)
- Sales Pipeline: ~421 records (non-franchise/licence enquiries — "Other", "Care home class enquiry", "Deliverable Art Kit Enquiry")
- Franchise Contacts: 1,253 records (all 3 franchise label variants)
- Licence Contacts: 1 (Sally Hare, came in via form 32 with referral=Instagram)
- General Contacts: 5,958 legacy

### Phase 1 — Iteration 6 (2026-05-13)
- **Franchisee photo caching**: Airtable signed photo URLs expire ~2hrs after issue, so migration now downloads each photo to `/app/backend/uploads/franchisees/<id>.<ext>` and rewrites `photos[0].url` to `/api/uploads/franchisees/<id>.<ext>`. FastAPI mounts the uploads directory as static under `/api/uploads`. New `POST /api/franchisees/refresh-photos` endpoint re-fetches Airtable attachment URLs without a full migration (useful when URLs expire between runs).
- **Contact Move (per-row + bulk)**: new endpoints `POST /api/contacts/{id}/move` and `POST /api/contacts/bulk-move` accept `{target: pipeline|franchise|general, pipeline_status?}` and route contacts between the 3 tabs. Legacy contacts (in `contacts` collection) get migrated into `web_form_contacts` when moved to pipeline or franchise so they share the same data model. Source field is updated where appropriate (e.g. → franchise becomes `franchise_enquiry`, → general becomes `general_enquiry`).
- **ContactsPage UX**: checkbox column with select-all, sticky **bulk action bar** appears when ≥1 selected (with "Move Selected ▾" + Clear), per-row **Move ▾** dropdown — both menus offer Sales Pipeline (with stage submenu) / Franchise Contacts / General Contacts; the current tab's option is disabled. Kanban cards also have a select toggle so multi-select works in pipeline view.
- **Global rounded-corner softening**: every page (Dashboard, Franchisees, Contracts, Franchisee Detail, Form Intake, Airtable Inspector, Migration Plan, Login, Placeholder, Sidebar) now uses `rounded-2xl` panels/cards, `rounded-lg` for buttons/inputs, `rounded-md` for badge pills.
- **Franchisee thumbnails bumped** from 96px → **128px** (`w-32 h-32`) per user request ("25% larger than 100px").

### Tests
- Backend: 13/13 new tests in `test_phase1_move.py` pass (move endpoints, bulk-move, photo caching, refresh-photos). Total backend suite: 13/13 new + 62/66 carry-over (4 carry-over dashboard count assertions go red because legacy mutations permanently move records — pre-existing pattern, not a regression).
- Frontend: 100% — Playwright verified franchisee photos serve from `/api/uploads/franchisees/`, contacts checkbox column + select-all + bulk-action-bar + per-row Move + kanban card-select all work, rounded corners present on every audited page.

### Phase 1 — Iteration 5 (Sales/Contacts segregation)
- 3-tab Contacts page: Sales Pipeline / Franchise Contacts / General Contacts (replaced single "Contacts" + tab toggle)
- Backend tab-aware `/api/contacts?tab=` filter; backfill on startup sets `in_pipeline=true` on imported web_form_contacts (1674 records)
- Migration `in_pipeline` regression fixed (now set at insert time, not only on startup backfill)

### Phase 1 — Iteration 1-4 (carried over)
- Admin auth (bcrypt + JWT httpOnly cookies + brute-force protection)
- Airtable Inspector + Migration decision capture + interactive migration plan export
- Full migration: 88 franchisees, 134 contracts, 5958 legacy contacts, 1674 web form contacts, 2470 territory postcodes
- Dashboard with KPIs + anniversaries + pipeline funnel + mandate breakdown
- Sales pipeline kanban (Phase 1.6)
- WordPress plugin for Gravity Forms intake (Phase 1 form pipeline)

## Migration Decisions (final, applied)
**To migrate:** Franchisees/Licencees (88), Contracts (134), Contacts (5,958 → legacy), Web Form - Contact (1,674 → franchise enquiries), DaD Postcode Lookup (2,470 → territories)
**Skipped:** Snowflakes, Avery All Homes, Avery August 2025 Products, Renewals 2025, Franchise Review Survey 2020, Finance Questionnaire Nov 2022, DaD Shop Orders, Shapes/DBS/Other Orders, FSH Home List Lookup

## Gravity Forms (still to wire up — Phase 1 outstanding)
- Form 1 → `general_enquiry`
- Form 17 → `franchise_enquiry`
- Form 32 → `licence_enquiry`
- Free WordPress plugin replacing Zapier (user will self-install ZIP)

## Backlog — P0 (next iteration)
- **Build the WordPress plugin** to capture all 3 Gravity Forms live
- Provide ZIP + install instructions to user
- Test forms → CRM end-to-end

## Backlog — P1 (Phase 1.5 — GoCardless live mandate status)
- GoCardless API token read from `.env`
- `gocardless_mandate_id` field on franchisee
- `/api/gocardless/mandates/sync` to auto-link by email
- `/api/webhooks/gocardless` receiver with signature verification
- Live status pill on franchisee detail page
- Last/next payment date + amount, lifetime total
- Dashboard alert: failed mandates last 24h
- Renewal Fee Paid? auto-tick on detected renewal payment

## Backlog — P1 (Phase 2 — Orders)
- WooCommerce REST API + webhook integration
- Orders list (Active/Completed/Draft/All filters)
- Gantt view of orders vs due dates
- Order detail page (products, shipping, billing, notes, emails)
- Manual "Create Order" workflow
- Production status workflow

## Backlog — P2+ (Phases 3, 4, 5)
- Phase 3: Franchisee role login, Cloudflare R2 storage, file browser with per-franchisee permissions, FileCamp retirement
- Phase 4: Mapbox territory map, postcode sector polygons, care-home tally, public find-a-class embed
- Phase 5: Licensee portal, 8-download/month quota, audit log, optional GoCardless webhook for auto-suspend

## Backlog — minor refinements
- Split `server.py` (~775 lines) into modules: auth.py, airtable.py, crm.py
- Add pagination (skip/limit + total) to /api/contacts for browsing beyond 2000 records
- Anniversaries: optimise N+1 franchisee lookup with batched query
- Consider downloading franchisee photos from Airtable's expiring URLs to local storage

## Active Credentials & Secrets (in `/app/backend/.env`)
- `MONGO_URL`, `DB_NAME=creative_mojo_admin`
- `JWT_SECRET`
- `ADMIN_EMAIL=admin@creativemojo.co.uk`, `ADMIN_PASSWORD=CreativeMojo2026!`
- `AIRTABLE_PAT`, `AIRTABLE_BASE_ID=appc7qwihJ15LxH8P`
- `FRONTEND_URL=https://licensee-vault.preview.emergentagent.com`
