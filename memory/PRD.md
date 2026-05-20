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
- **Phase Invoicing+Banking** ✅ (Feb 2026)
  - Merged standalone "Pay-Paperwork" invoicing app into the admin shell at `/invoices` (49 invoices, 22 clients migrated)
  - Banking module pivoted from TrueLayer (KYC-blocked) to manual HSBC CSV statement upload — 2,043 transactions imported, dedup'd via fingerprint hash
  - **Invoice ↔ Payment linking** (Feb 18 2026): one-to-many — an invoice can be matched to multiple banking receipts (deposit + balance, instalments). Auto-marks "Paid" when total reaches invoice amount, "Partial" otherwise. Picker prioritises exact-amount matches and auto-retargets to the remaining balance on subsequent links. Two-way mirror — banking transactions tag back to their linked invoice.
  - **Supplier keyword filters** on Banking page: 16 seed chips (DENE LODGE, HAZELGATE, etc.) — click-to-filter, add/remove inline, persists in `banking_supplier_keywords`.



- **GF Delete Tombstones + Contacts Search Clear button** ✅ (May 20 2026)
  - Bug: Deleted contacts (Paul Caldeira-Dunkerley) kept reappearing in the kanban NEW column because the hourly GF backfill had no memory of admin deletions.
  - Fix: New `gf_deleted_entries` collection (keyed by `gravity_entry_id`). `DELETE /api/contacts/{id}` now upserts a tombstone row when the contact has a `gravity_entry_id`. Both `POST /api/intake/gravity-forms` (live webhook) and `gf_backfill.run_backfill` consult the tombstone set and skip any matching entry.
  - UI: Contacts page search input now shows an inline "X" clear button (`data-testid="contact-search-clear"`) whenever the field has a value.
  - Regression test: `/app/backend/tests/test_gf_tombstones.py` (seeds a fake GF contact, deletes via API, asserts tombstone created, asserts subsequent webhook POST returns `{"skipped":"tombstoned"}`).

- **Mojo Portal — mobile-first redesign (Option B)** ✅ (May 20 2026)
  - **PWA foundation**: `index.html` updated with `viewport-fit=cover, maximum-scale=5`, `apple-mobile-web-app-capable=yes`, `apple-mobile-web-app-title=Mojo Portal`, `format-detection=telephone=no`. New `public/manifest.json` (name="Creative Mojo Portal", short_name="Mojo Portal", standalone display, `start_url=/portal`). Apple touch icon link.
  - **Safe-area-insets utility classes** in `index.css`: `pb-safe`, `pt-safe`, `pl-safe`, `pr-safe`, `mb-safe` (use `max(0.5rem, env(safe-area-inset-bottom, 0.5rem))`). New `touch-target` utility = 44×44px min (WCAG / Apple HIG). New `ios-no-zoom` utility = `font-size: 16px` (prevents iOS Safari input zoom).
  - **New `PortalBottomNav` component** — fixed bottom tab bar visible only `<md` (≤767px). 5 tabs: HOME / FILES / EVENTS / PROFILE / SIGN OUT. Smooth-scrolls to section anchors via `getElementById + scrollTo`. Active state tracked via `IntersectionObserver` (rootMargin `-30% 0px -50% 0px`). Respects `pb-safe` so it sits above the iPhone home indicator.
  - **`PortalDashboardPage`** rewritten mobile-first: hero stacks vertically `sm:row`, profile/territory/events/files panels are independently collapsible and full-width, all CTAs `touch-target` sized, header sign-out hidden on mobile (handled by bottom nav), bottom padding `pb-28 md:pb-8` so the fixed nav doesn't cover content. Territory widget uses `mapHeight=360` on phones, `640` on desktop.
  - **`PortalLoginPage`**: `pl-safe pr-safe pt-safe pb-safe`, centered headings on mobile, mobile logo with "Franchisee Portal" caption, `inputMode=email`, `ios-no-zoom` input class, `autoComplete=username/new-password/current-password`, 44px tap targets on all buttons including eye-toggle.
  - **`FranchiseeFilesPanel`**: tab strip becomes horizontally scrollable on phones with shortened labels ("My documents", "Shared files"), search input full-width on mobile + 16px font, view-toggle + ZIP button touch-target sized. File rows: filesize moves below filename on mobile, download button always 44px tall, label "Save" hidden on phone showing just the icon.
  - **`PortalEventsPanel`**: header toggle + content padding scales `px-4 sm:px-6`, "Join meeting" button becomes full-width below event details on mobile, next-event teaser hidden when collapsed on phone (keeps header compact).
  - **`FilePreviewModal`**: modal goes full-screen on mobile (`items-stretch sm:items-center`, `p-0 sm:p-6`, `h-full sm:h-auto`, no rounded corners on phone), `playsInline` on video to avoid forced fullscreen on iOS, key path hidden on small screens, close-button enlarged to touch-target.
  - **Tested at 390×844 (iPhone 12 Pro)** — `window.matchMedia(min-width:768px) = false`, bottom nav `display: block`, all 4 tabs scroll-to-section correctly with active-state highlight, no horizontal scroll. Admin pages untouched.

- **Pipeline kanban — shift-select bug fix** ✅ (May 20 2026)
  - Bug: shift-clicking checkboxes in the NEW column also selected unrelated cards in INTERESTED / TERRITORY MAP / etc. Root cause: `toggleSelect` walked the range through `visibleItems` (all stages interleaved) rather than the column-specific list.
  - Fix: when in pipeline view, the shift-range is now scoped to `grouped[anchorStage]`. If the anchor and target are in DIFFERENT stages, the shift modifier is ignored and only the single target is toggled.

- **Sales Pipeline — Form 1 ("Contact Form") now ingested + Lucy Cook mandate linked** ✅ (May 20 2026)
  - **Bug 1**: Clare Shannon (and Paul Caldeira-Dunkerley etc.) were submitted via the general /contact/ form (`form_id=1`) and selected "Franchise enquiry" in the dropdown. We never ingested form 1 — only forms 17/32 — so 21 franchise enquiries were silently lost.
    - Fix: added form 1 to `GF_BACKFILL_FORM_IDS=1,17,32`, extended `FIELD_LABELS_BY_FORM` to map its layout (field 9/12/4/5/13/14/15/16/21/20/6), added `FORM1_REASON_TO_SOURCE` so the "Reason for contacting" dropdown (field 20) drives source assignment: "Franchise enquiry" → `franchise_enquiry`, "Licence enquiry" → `licence_enquiry`, anything else (care-home, art-kit, other) → `general_enquiry` (ingested into CRM but stays OUT of pipeline kanban). Field 21 → `establishment_name`. `pipeline_status="new"` only set when reason is franchise/licence.
    - One-off run: `{inserted: 179, updated: 0, errors: []}` — recovered 21 missed franchise enquiries (now in pipeline) + 108 general enquiries (CRM only).
  - **Bug 2**: Lucy Cook had Active mandate on GoCardless but flagged as missing. Root cause: GC customer email was `lucy91@gmail.com` whereas her DB `secondary_email` was `lucycook91@gmail.com,Lucindacook@hotmail.co.uk` — different addresses, no match.
    - One-off fix: appended `lucy91@gmail.com` to her `secondary_email` and re-ran `/gocardless/franchisees/{id}/refresh` → linked → mandate `MD000H1RDFF8H3` status `active`. Banner count 2 → 1.
  - **New endpoint**: `POST /api/franchisees/{id}/link-gocardless-by-email {email}` appends the email + immediately re-runs single-franchisee refresh. Backed by extracted module-level `refresh_single_franchisee()` helper in `gocardless_integration.py`.
  - **New UI**: each missing-mandate banner row now has a **`LINK BY EMAIL`** toggle → reveals an email input + `ADD + RE-SYNC` button. On success, the row disappears + the franchisee list reloads. Solves future Lucy-style mismatches without DB surgery.

- **GoCardless mandate links + missing-mandate alert** ✅ (May 20 2026)
  - Every live mandate pill now opens the GoCardless dashboard in a new tab (`https://manage.gocardless.com/mandates/{id}`). Applies to the Franchisees list table cell, the franchisee detail KPI tile, and the GoCardless panel debug line. GC customer IDs are also clickable (`/customers/{id}`).
  - If a franchisee has NO mandate, the pill is replaced by a `Set up in GoCardless ↗` link to `https://manage.gocardless.com/sign-in`.
  - New backend endpoint `GET /api/franchisees/alerts/missing-mandate?days=14` returns count + list of active franchisees who went live ≥ 14 days ago but have no `gocardless_mandate_id`. "Went live" = earliest contract `commencement_date` (with `date_added`/`created_at` fallback).
  - **Sidebar red badge** on the "Franchisees" nav item showing the count (auto-refreshes every 5 minutes). Tap the badge → land on the Franchisees page which shows a red expandable banner at the top listing every offending franchisee with `Live {Nd} · No mandate` chip + direct `OPEN GOCARDLESS ↗` button.
  - Currently flagging 2 active franchisees: Lucy Cook #0061 (live 2545d, no mandate) and Monica Diodato #0094 (live 41d, no mandate).

- **Sales Pipeline — Dormant stage + collapsible columns + editable Notes** ✅ (May 20 2026)
  - **New "Dormant" stage** (orange) between Territory Map and Lost — for leads who were interested and almost came on board but didn't quite make it. Available to BOTH franchise and licence contacts (unlike `demo_booked`/`converted` which stay franchise-only). Added to `PIPELINE_STAGES` on backend + dashboard funnel.
  - **Collapsible columns** — kanban switched from `grid grid-cols-6` to `flex` layout. Each column header has a `«` collapse button; collapsed columns become a narrow 40px-wide vertical strip with a rotated label + count. State persists in `localStorage.pipelineCollapsedStages`. Keeps the 7-column layout usable on a 1920 viewport even when 2-3 columns are open.
  - **Editable running notes** — new `AdminNotesEditor` component in the drawer (below Original Enquiry, above legacy Internal Notes). Auto-saves on blur, ⌘/Ctrl+Enter shortcut, "Saving…" / "Unsaved changes" / "Saved {Nm ago}" indicator, character count, "Save now" inline button. Stored in new `admin_notes` field via `PATCH /api/contacts/{id}/admin-notes` (admin-only). Tracks `admin_notes_updated_at` + `admin_notes_updated_by` for audit.

- **Sales Pipeline — Reply lozenge regression fix + "Mark Contacted" feature** ✅ (May 20 2026)
  - Bug: a new contact (Deborah Tiver, GF entry 6035) appeared in the NEW kanban column overnight but with NO red Reply lozenge. Root cause: `gf_backfill.py` inserts new rows with `in_pipeline=True` but never set `pipeline_status`; the frontend's `c.pipeline_status === "new" && c.email` check required strict equality, so null-status cards fell into the New column via the fallback grouping but never rendered the button. The live webhook handler ALREADY set `pipeline_status="new"` — the backfill safety net didn't.
  - Backend fix: `gf_backfill.py` now writes `"pipeline_status": "new"` on insert AND on stub-repair, mirroring the live webhook. One-off DB sweep set the 1 affected row (Deborah Tiver) to `pipeline_status="new"`.
  - Frontend fix: Reply button visibility loosened to `(!c.pipeline_status || c.pipeline_status === "new") && c.email`. Auto-advance logic in `replyByEmail` mirrored.
  - Feature: NEW `Mark contacted` mini-button (white pill with check icon) sits next to Reply on every kanban card in the NEW column, and as a separate header CTA in the drawer. Click → just advances stage to "contacted" without opening any email client. Use when you've already replied via your own email app.
  - Test IDs: `mark-contacted-{id}` (kanban), `drawer-mark-contacted` (drawer).

- **Sales Pipeline — "Link to existing franchisee" flow** ✅ (May 19 2026)
  - Use case: pipeline contacts who are actually *already* in the franchisees collection from the historic migration. The standard "Convert" flow created an unwanted duplicate franchisees row; this skips that.
  - New backend endpoints (admin-only):
    - `GET /api/contacts/{id}/franchisee-matches` — returns all 88 active franchisees, top-3 ranked via heuristic (email exact +100, full name +60, postcode exact +35, area code +12, surname +15, phone last-7 +20) with human-readable `match_reasons[]` and a `suggested=True` flag.
    - `POST /api/contacts/{id}/link-to-franchisee {franchisee_id, append_to_notes}` — mirrors convert-side-effects: sets `converted_to_franchisee_id`, clears pipeline, stamps `linked_to_existing`/`linked_by`/`linked_at`, and (default ON) appends the original enquiry — source, date, referral, message, comments — to the franchisee's `notes` for audit. 409 if contact already linked/converted.
  - New frontend modal `LinkExistingFranchiseeModal.jsx` with a searchable picker. Suggested matches block (amber highlight + reasons row) renders at top when scoring > 0, then the full browseable list below. Filter box matches across name, organisation, email, postcode, franchise#. Dynamic CTA label "Link to {name}". Pre-checked "Append original enquiry to notes" toggle.
  - Wired as a secondary CTA inside the existing Convert section in the drawer ("Already in the franchisees list? Skip creating a new record and link to the existing one.").

- **Sales Pipeline — licence contacts hide franchise-only stages** ✅ (May 19 2026)
  - For contacts whose `source === 'licence_enquiry'`, the drawer "Move to Stage" grid, the kanban "Move to…" dropdown, and the "Plan their territory" CTA all hide the two franchise-only stages (`demo_booked` "Shadow Day Booked" + `converted` "Territory Map"). Licence prospects see only New / Contacted / Interested / Lost — conversion is done via the explicit "Convert to Licencee" button. Helper `stagesForContact()` keeps the contact's CURRENT stage visible even if it's a legacy franchise stage (so it can be moved out).

- **Sales Pipeline — fixed 63 "UNNAMED" cards + recovered 150 missing leads** ✅ (May 19 2026)
  - Root cause: `gf_backfill.py` was using the wrong Gravity Forms field-ID mapping (assumed dotted-id schema `1.3 / 1.6 / 5.x`), but the LIVE Franchise (17) + Licence (32) forms use the flat numeric IDs `9 / 12 / 4 / 5 / 13 / 14 / 15 / 16 / 28 / 6 / 24.x`. Result: 63 entries inserted with `first_name=null`, `last_name=null`, all other fields empty, surname mis-stuffed into the `google` field.
  - Fix: rewrote `FIELD_LABELS_BY_FORM` + the doc-build path to read the real field IDs, added a `repair_stubs` mode that REPLACES rows previously inserted as nameless stubs (matched on `ingested_via='gf_backfill' AND first_name IS NULL AND last_name IS NULL`).
  - Outcome: 0 unnamed enquiries left across both `web_form_contacts` (740 in pipeline) and `contacts`. 150 brand-new entries also recovered in the same sweep — entries that were dropped by the intermittent WP→backend webhook between May 8 and May 19. Spam filter correctly skipped entry `6024` (`MiltonIdova MiltonIdova`).
  - Admin trigger: `POST /api/intake/backfill/run?limit=200&repair=true` (limit clamped to 1-500).


## What's Implemented (2026-05-19)
- **Territory Builder — saved plans panel + public share links** ✅ (May 19 2026)
  - New "Saved plans" panel in the bottom-right of `/territory-builder` (when no contact/franchisee in URL). Lists every saved plan with name, contact (where linked), home count, sector count, centre postcode. Quick actions: Open (loads onto the map), Copy share link, Revoke share, Delete. Filter box appears once there are >5 plans.
  - Per-plan share toggle ("Share with prospect" card) in the plan-details column once a plan is saved. Mints a `share_token`, exposes a `/share/territory/<token>` URL, tracks `view_count` + `last_viewed_at`. Admin can revoke at any time.
  - New public viewer page `/share/territory/:token` (no login required). Branded header with Creative Mojo logo, "PROPOSED TERRITORY" eyebrow + plan name, live CQC care-home count badge, read-only Mapbox view of the polygons with per-sector counts, "At a glance" + sector-chip panels, "Shared by Creative Mojo" footer. No PII (no contact names / internal notes).
  - Backend: 3 new endpoints — `POST /api/territory-plans/:id/share`, `DELETE /api/territory-plans/:id/share`, `GET /api/public/territory-plans/:token` (unauthenticated). `GET /api/territory-plans` now eagerly joins `contact_name` so the panel can label plans with the prospect.
  - Fixed: axios 401 interceptor was bouncing unauthenticated visitors off `/share/*` paths. Whitelisted now.

## What's Implemented (2026-05-19)
- **Airtable decommissioned** ✅ (May 19 2026)
  - Frontend: removed sidebar items (Airtable Inspector, Migration Plan), removed dashboard "Re-run migration" button, deleted page components, removed routes. Kept the "Migrated from Airtable · {date}" stamp as a historical marker.
  - Backend: removed `/api/airtable/*` endpoints, `/api/migration/decisions/*` endpoints, `/api/migration/run`, `/api/franchisees/refresh-photos`, the airtable summary block on `/api/dashboard/stats`, the startup-time seeding of `migration_table_decisions`, the env-var imports (`AIRTABLE_PAT`, `AIRTABLE_BASE_ID`).
  - Removed `AIRTABLE_PAT` + `AIRTABLE_BASE_ID` from `backend/.env`.
  - Kept Mongo collections (`migration_runs`, `migration_table_decisions`, `migration_field_decisions`) untouched for audit, but no code reads them anymore.
  - Net effect: ~189 lines deleted from `server.py` + 2 frontend page files removed. Cleaner, smaller, no live Airtable API calls.

- **CQC full sync (re-)kicked off** — running in the background. Total target: 121,283 records. Currently at page 3, climbing.

- **Territory Builder map polish** ✅ (May 19 2026)
  - Public share viewer map now taller (820px vs 620px) so prospects can see the territory at a glance.
  - Light / Roads basemap toggle added to the public viewer (top-left of map).
  - Per-sector outline thickness reduced (selected: 2 → 1.25px; available: 0.8 → 0.5px; franchisee inner: 0.75 → 0.4px).
  - Franchisee fill opacity dialled back (30/55 → 18/35).
  - Boosted town/city label layer (text-size scaled by zoom, font upgraded to bold, halo widened to 2.2px) so prospects can read the map.

## What's Implemented (2026-05-18)
- **Zoom Server-to-Server OAuth — Calendar one-click meeting creation** ✅ (May 18 2026)
  - Marketplace Server-to-Server OAuth app on `headoffice@creativemojo.co.uk` (single shared host). Granular scopes: `meeting:write:meeting:admin`, `meeting:read:meeting:admin`, `user:read:user:admin`.
  - New backend module `backend/zoom_routes.py` — in-memory token cache (1h TTL, 60s safety margin, asyncio lock), `GET /api/zoom/status`, `POST /api/zoom/meetings`. Audit trail in `zoom_audit` collection.
  - Frontend: new `ZoomMeetingModal` inside the calendar `EventModal`. Blue "Create Zoom meeting" button next to the meeting-link field opens a small dialog (duration auto-defaulted from event start↔end, passcode toggle [on by default], waiting-room toggle). On confirm, the returned `join_url` auto-fills `meeting_url` and a green success notice shows the passcode. Manual paste still works (Teams/Meet/etc).
  - Pivot away from MS Teams (Microsoft 365 dev-app restrictions on the user's tenant). Manual paste kept as fallback.
- **Mojo Orders promoted to primary nav** ✅ (May 18 2026)
  - Moved out of the collapsed Admin sub-menu in `Layout.js` to the main sidebar (just under CQC Definitions).

## What's Implemented (2026-05-16)
- **Teams meeting links (manual paste flow)** ✅ (Feb 18 2026)
  - Calendar event form already supported a `meeting_url` field (typically MS Teams join link). Admin pastes it once when creating/editing → both admin Calendar page and the new portal Events panel render a one-click "Join meeting" button.
  - New `GET /api/calendar/portal-events` — same shape as admin endpoint, requires login only (no admin role), gracefully returns `connected: false` when calendar not configured instead of 500.
  - New `PortalEventsPanel` on the franchisee portal — collapsible, lives between "Your Territory" and "Your Files". Shows next-event preview when collapsed. When open: date tile + title + time + location + description + Teams-detected blue "Join meeting" button. "Show recent past" toggle for events ≤30d ago.
  - Path C (full Microsoft Graph OAuth + auto-generate links + Outlook two-way sync) **declined** — Microsoft Family subscription has no Azure AD; M365 Developer Program sandbox locked behind Visual Studio Enterprise in 2024. Manual paste flow chosen as the pragmatic free alternative. If user later subscribes to M365 Business Basic, can swap in the auto-generated flow without changing data shape.

- **Phase Account-Security** ✅ (Feb 18 2026)
  - **Admin Users page** (Feb 18 2026) — replaces standalone "Password Resets". Two-tab layout at `/admin/users` (legacy `/admin/password-resets` route preserved):
    - **Users tab**: roster of all login accounts with name, email, role pill, linked franchisee, created-at; search box + role filter; "+ New User" modal supports admin/franchisee/licensee with linked-franchisee picker for franchisee accounts; generates a strong password on demand; reveals new credentials ONCE post-creation for the admin to share out-of-band; delete-user (self-delete blocked).
    - **Password Resets tab**: same admin-mediated flow as before, with a red badge on the tab showing the count of pending requests (polled every 30 s).
  - **Forced password change** — login response now exposes `force_password_change`; `ProtectedRoute` redirects to `/change-password` on every request until the user picks a new password (≥8 chars). Voluntary changes also work via the same endpoint.
  - **Files page restructure** — search moved to a wide top-bar pill (replaces yellow-header search), breadcrumb now lives in the yellow action bar, "Per franchisee preview" and "Franchisees" panels are collapsible (preserve state in localStorage), and a top-left sidebar toggle hides BOTH side panels for full-width file work.


### Phase 4 — Iteration 25 (2026-05-16) ✅ Admin master territory overlay
**Live franchisees overlay on the Territory Builder map**
- New backend `GET /api/territory/all-franchisees` (admin-only) returns every active franchisee's locked territory as a single GeoJSON FeatureCollection plus per-franchisee metadata (name, franchise number, HQ postcode, deterministic 24-colour palette index, sector list, resolved HQ lat/lng). HQ coords are bulk-resolved through `postcodes.io` (100/call) and cached for future requests, so all 26 active franchisees show pins on first load.
- `TerritoryMap.jsx` accepts a `franchiseeOverlay={franchisees,geojson}` prop and renders the overlay UNDER the active builder layers: a `fill` painted by `feature.properties.color` and a 2.5px `line` outline in the same colour so each franchisee's edge contrasts against its neighbours. Clicking any coloured sector pops a `<owner · sector>` popup so admins can identify overlaps instantly.
- Per-franchisee HQ pins (coloured dot with `#franchise_number`) with a rich popup (name, HQ postcode, sector count). `onFranchiseeClick` hook for future "edit territory" deep-links.
- `TerritoryBuilderPage.jsx` fetches the overlay on mount, passes `exclude_id` when locking a franchisee so the active franchisee isn't double-drawn, and adds a top-of-map legend (clickable colour chips that recentre the map on each franchisee's HQ) plus a one-click Eye/EyeOff toggle to hide the overlay if it gets in the way during prospect drawing.
- Smoke test: 26 franchisees · 1915 polygons rendered · all 26 HQ pins resolved.

### Phase 4 — Iteration 24 (2026-05-16) ✅ Admin + portal upgrades
**Franchisee admin polish**
- **Photo upload** — admin-only camera overlay on the franchisee detail page hero photo. POST `/api/franchisees/{id}/photo` accepts a multipart image (≤ 8 MB), stores it under `UPLOADS_DIR/franchisees/<id>_<ts>.<ext>`, and rewrites `photos[0]` so the rest of the app picks it up. Previous photos preserved as the tail of the array for audit/revert.
- **Hero info upgrade** — full address (line 1 + line 2 + town + county + postcode + country) rendered with a `MapPin` icon, plus a derived "X years a franchisee · since DD/MM/YYYY" badge computed from the earliest contract `commencement_date` (falls back to `date_added` / `created_at`).
- **Recent files panel** scoped per-franchisee — `RecentFilesStrip` now accepts a `franchiseeId` prop, and `GET /api/files/recent` accepts a matching query param for admins. Franchisees auto-restrict to their own scope as before.
- **File preview "Open in new tab"** relabelled to **"Full page preview"** with a real text button. The proxy endpoint now returns `Content-Disposition: inline; filename="<real name>"` so PDFs render inline in the browser tab instead of triggering a "proxy" save dialog.

**Contracts CRUD (admin-only)**
- `POST /api/contracts` — create a new contract. Body: `franchisee_id`, `contract_term_years` (1–10), `commencement_date` (YYYY-MM-DD), `initial_starting_fee` (£, optional), `monthly_fee` (£, optional), `notes`. Auto-derives `renewal_date` (leap-year safe), allocates the next sequential `ref` number, and copies the franchisee's name/email/org as rollups so listings render fast.
- `PATCH /api/contracts/{id}` — edits term/date/fees/notes; re-derives `renewal_date` if term or commencement change.
- Frontend `AddContractModal` — pill-style 1/2/3/4-year term selector, native date picker, live renewal-date preview, £-prefixed fee inputs, free-text notes. Renamed to "Renew contract" when called with a `previous` prop and pre-fills `commencement_date = previous.renewal_date`. Wired into the franchisee detail page Contracts panel header as "Add / Renew contract".

**Franchisee portal map upgrade**
- `TerritoryMap` now accepts a `homes` array and draws a **numbered green marker** (1, 2, 3…) for each home with a hover popup showing name + town + postcode. Click → `onMarkerClick(i)` so the list below scrolls to the matching row.
- New `TerritoryHomesList` component — a collapsible card per home with rating badge, address, manager, phone (tel: link), email status, website (clickable), latest inspection date, provider, beds, specialism chips, **"Open CQC page"** (external `locationURL`) and **"Zoom map here"** buttons. Built-in search bar filters by name / town / postcode / manager / provider; numbering stays stable to the full list.
- `_shape_location()` in `cqc_routes.py` now stores `providerName`, `mainPhoneNumber`, `registrationManagers[]`, `registrationManagerName`, `postalAddressLine2`, `postalAddressCounty`, `fullAddress` (joined string), `locationURL` (`https://www.cqc.org.uk/location/<id>`). Existing 38,180 records back-filled with `fullAddress` + `locationURL`; manager/phone will populate as the in-flight full sync touches each location detail endpoint.
- Tests: contract CRUD round-trip verified via curl (POST 2-yr contract → PATCH to 4-yr → renewal_date auto-recomputed); 5/5 territory regression tests still pass.

### Phase 4 — Iteration 23 (2026-05-16) ✅ Real ONS postcode-sector boundaries
- **Removed all generated polygons** (Voronoi, convex hulls, centroid joins). The map now renders the true Royal Mail / GeoLytix postcode-sector boundaries imported from the Edinburgh DataShare / ONS Open Geography release of 2014 GeoLytix data (OGL licence). 9 232 sectors covering Great Britain (England, Wales, Scotland).
- **New collection** `postcode_sector_polygons` keyed by `sector` (e.g. ``"CO15 1"``, ``"AB10 1"``). 25 MB total in Mongo with a 2dsphere index for fast `$geoIntersects` queries.
- **New importer** `backend/scripts/import_postcode_sectors.py` — reads `data/GB_Postcodes/PostalSector.shp`, reprojects EPSG:27700 → WGS84 with pyproj, applies a 0.0003° Douglas-Peucker simplify (~30 m, invisible at city zoom), upserts into Mongo, builds indexes.
- **New endpoint** `GET /api/territory/sector-polygons?sectors=A,B,C` returns a `FeatureCollection`-style list filtered to the requested codes with live CQC home counts attached. Accepts mixed spacings (`co70`, `CO7 0`, `ex151`) and normalises them.
- **Rewritten** `GET /api/territory/sectors-near` to use a real spatial query (`$geoIntersects` against a 36-vertex circle ring) instead of per-postcode geocoding. Millisecond-scale, exact selection, no postcodes.io chatter.
- **TerritoryMap.jsx** rewritten — single GeoJSON source, one fill layer (translucent `#D4FF00` brand-yellow for selected, light stone for available), one outline layer (`#14532D` dark green), one label layer (`zoom ≥ 9`). Internal sector boundaries are preserved (no merging). Added `interactive={false}` mode for read-only widgets (auto-fits bounds to the selected sectors).
- **Deleted** `backend/build_sector_voronoi.py` and dropped the `sector_geometries` collection (7 171 legacy Voronoi polygons purged). Removed the 180 MB source zip from `/app/backend/data/`; shapefile remains for re-import.
- **Back-compat alias** `GET /api/territory/sector-geometries` kept (delegates to `sector-polygons`) so any cached frontend bundle keeps working.
- **Edge case**: Northern Ireland (`BT…`) sectors aren't in the GB dataset — the endpoint returns the row with `geometry: null` so the UI can flag/skip gracefully. Scotland (`EH…`, `FK…`, `IV…`, etc.) is fully covered, though CQC is England-only so home counts are 0 for now (Care Inspectorate / RQIA integration is still backlog).
- **Tests**: 5/5 in `backend/tests/test_postcode_sectors.py` pass (geometry validity, input normalisation, spatial $geoIntersects against Colchester, null-geometry for unknown sectors, legacy alias).
- **Visual verification**: admin Territory Builder for franchise #0094 (Axminster–Weymouth, 59 sectors) and franchisee portal map for Sandra (Creative Mojo NW Devon, 5 sectors) both render the real postcode-sector polygons exactly as specified.

## What's Implemented (2026-05-15)

### Phase 3 — Iteration 22 (2026-05-15) ✅ Auto-folder bootstrap (Artwork / Franchise Agreement / Territory)
- **`backend/franchisee_folders.py`**: new helper `ensure_franchisee_folders(db, franchisee, user_email)` — idempotent. Builds the canonical R2 prefix from the franchisee's `franchise_number` + `organisation` + `first_name` + `last_name` slug, then creates a hidden `.keep` placeholder under each of the three standard folders (`Artwork`, `Franchise Agreement`, `Territory`). Skips folders that already have any object.
- **Auto-bootstrap on conversion**: `convert_contact_to_franchisee` (Phase 1.7) now calls the helper immediately after `insert_one`, so newly-converted franchisees land with their three sub-folders ready.
- **Admin endpoint**: `POST /api/franchisees/{id}/bootstrap-folders` — single-franchisee idempotent rerun (useful for franchisees imported from Airtable before this feature existed).
- **Bulk backfill**: `POST /api/franchisees/bootstrap-folders/all` — runs the helper across every active franchisee, returning a summary `{processed, created_total, skipped_total, without_prefix, results[]}`. One-shot used 2026-05-15 to bootstrap **84 of 88 active franchisees, creating 250 folders** (the 14 skipped already had migration content).
- **Frontend**: `FranchiseeFilesPanel` empty-state now offers a one-click **"Create standard folders"** button (admin only sees it because the panel is in admin-protected pages; franchisees see folders directly).
- **Bug fix while here**: `PortalLoginPage` was missing the `isReset` state declaration after the previous iteration's edit. Now declared correctly and the "Set a new password / Submit new password" flow renders cleanly after an admin reset.

### Phase 3 — Iteration 21 (2026-05-15) ✅ Franchisee Portal Logins
- **No-email flow per user request**: admin meets franchisees in person, shares URL. First-time visitor → email → "Set your password" → in. Returning → email → password → in. Forgot password → admin one-click reset on detail page.
- **New backend endpoints**:
  - `POST /api/portal/login-check {email}` (public): `{exists, needs_password_setup}`
  - `POST /api/portal/set-password {email, password}` (public, idempotent — 409 if already set)
  - `POST /api/portal/login {email, password}` (public, brute-force protected, shares `login_attempts` collection with admin login)
  - `POST /api/franchisees/{id}/portal-toggle {enabled}` (admin)
  - `POST /api/franchisees/{id}/portal-reset` (admin) — wipes password_hash
  - `GET /api/portal/me` (franchisee) — slim profile + user info for dashboard
- **New `franchisee` role**: users collection holds both admin and franchisee records; franchisee users link to franchisees collection via `franchisee_id`. `user_to_public` now returns `franchisee_id` for portal users so the frontend can scope its UI.
- **File API auto-scoping**: `/api/files/tree`, `/api/files/download`, `/api/files/proxy`, `/api/files/folder-zip` now accept both admin + franchisee roles. For franchisees they auto-scope to `franchisees/<their slug>/...` and `shared/...` — cross-franchisee access returns 403/404.
- **Routes**:
  - `/portal/login` (public, branded entry page with hero side panel)
  - `/portal` (protected, role=franchisee) — dashboard
  - `ProtectedRoute` now accepts a `role` prop and bounces wrong-role users to their correct home.
- **New frontend modules**: `pages/PortalLoginPage.jsx`, `pages/PortalDashboardPage.jsx`, `components/franchisee/FranchiseePortalControls.jsx`.
- **Phase-4 placeholder card** on the dashboard: "Your territory / Map & postcode lookup — Coming in Phase 4".
- **Demo account**: `sandra@creativemojo.co.uk / Test1234!` for franchise #0000. See `/app/memory/test_credentials.md`.
- **Verified end-to-end**: 7/7 backend scenarios pass via curl (portal toggle, login-check, set-password, idempotency 409, login, wrong-pw 401, cross-franchisee 403, admin reset, post-reset re-setup). Frontend smoke test confirms welcome→setup→dashboard flow renders correctly.

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
