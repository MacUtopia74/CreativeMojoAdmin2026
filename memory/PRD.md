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
- **Phase 1.5** GoCardless live mandate status (read-only API + webhook). Replaces static `mandate` field with live status pill + last/next payment.
- **Phase 1.6** ✅ Sales pipeline (simple): Kanban view of enquiries with stages New → Contacted → Qualified → Demo Booked → Converted → Lost
- **Phase 2** Order management + WooCommerce live sync + Gantt view
- **Phase 3** Franchisee logins + Cloudflare R2 file storage + file browser (FileCamp retired)
- **Phase 4** Territory mapping tool + public find-a-class embed (replaces DaD Postcode Lookup)
- **Phase 5** Licensee portal + 8-download/month quota + optional GoCardless webhook

## What's Implemented (2026-05-14)

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
