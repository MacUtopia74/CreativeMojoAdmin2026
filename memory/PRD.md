# Creative Mojo — Unified Admin Platform PRD


## My Territory+ post-deploy hotfix: dim markers + Care Groups provider join (Jun 01 2026)
- **Bug 1 — "Show My Clients only" wasn't visually dimming non-client markers.** Fix: made non-client markers in dim mode much more obviously secondary — opacity 0.22 (was 0.3), `filter: grayscale(0.85) brightness(1.1)`, and shrunk from 24px to 18px. The `activeHomeIndex` highlight effect now respects both client-state AND dim-state when it re-applies styles so toggling the filter never loses the dim/gold treatment.
- **Bug 2 — Care Groups filter pills missing despite homes being present.** Root cause: the live CQC API (`/locations/{id}`) does NOT return `providerName` — all 73,703 live homes have it as null. The legacy Excel-imported `cqc_locations` collection (56,437 rows) DOES carry `provider_name` keyed on `provider_id`. Fix: `_list_homes` in `territory_routes.py` now enriches `providerName` at query time via a single bulk lookup against `cqc_locations` (provider_id → provider_name). For Sandra's Devon territory 24/25 homes are now enriched; for Coventry & Nuneaton 151 distinct providers surface (top group WCS Care Group Limited with 11 homes). Filter pills now appear and meaningfully group homes.
- **Hydration warning cleanup**: nested `<button>` inside `<button>` (home-unmark-quick inside row-toggle, and client-edit inside client-row-toggle) refactored to `<div role="button" tabIndex={0}>` parents with native button children. Console hydration warnings cleared.
- **Tests**: pytest 13/14 PASS (1 known minor data gap — 1 newly-registered CQC home from Feb 2026 not yet in the legacy collection; ~96% enrichment on Sandra's territory, 100% on Coventry). Testing agent iteration_24 verified frontend dim styling + Care Groups pills end-to-end on Sandra's account.
- **Action required: redeploy** so production picks up both fixes. Future enhancement: backfill `cqc_locations` from a fresher Excel dump or fall back to live CQC `/providers/{id}` endpoint at sync time to cover newly-registered providers.


## My Territory+ feature pass: My Clients filter · Sales flow · Editable CQC overrides (Jun 01 2026)
- **"Show My Clients only" toggle** (FranchiseeTerritoryWidget + TerritoryHomesList + TerritoryMap). New toolbar button (`t-plus-my-clients-only`). When ON: client rows pushed to top, non-client rows rendered at 40% opacity in the list; on the map, non-client numbered markers drop to 30% opacity so the gold client markers pop. Default OFF.
- **Sales-flow lead status bar** on every non-client row (LeadStatusBar component in TerritoryHomesList). 3 states: Not Contacted (red, default) / Contacted (green) / Follow Up (blue + datetime-local picker popover). Follow-up rows show an urgency chip — "Overdue · Xd" red, "Due today" amber, "Due in Nd" amber/blue. **Never auto-promotes** a home to My Client — purely a personal CRM bookmark. New backend collection `franchisee_home_leads` (one row per franchisee × home, upsert semantics) with endpoints:
  - `GET    /api/portal/territory-plus/leads`
  - `PUT    /api/portal/territory-plus/leads` body `{source, home_id, status, follow_up_at?}`
  - `DELETE /api/portal/territory-plus/leads` body `{source, home_id}` (idempotent — used as "reset to Not Contacted")
- **CQC-linked clients fully editable**: removed the `disabled` lock from every field in TerritoryClientModal — franchisees can now override `manager`, `email`, `phone`, `website`, `address`, `latest_inspection`, `cqc_rating`, `provider`, etc. on a CQC/Scotland-marked client. Overrides are private to the franchisee — they never write back to the public CQC dataset.
- **"View live CQC data" popup**: amber banner inside the edit modal exposes a button (`t-plus-view-cqc`) that opens a side popup (`t-plus-cqc-popup`) showing the unedited live CQC fields side-by-side: Name / Address / Postcode / Phone / Website / Provider / Manager / CQC rating / Latest inspection / Beds + a "Open on CQC website" link. Sourced from the homes list already loaded by the widget (`homeById` memo) — no extra API call.
- **Tests**: backend pytest 11/11 PASS (`/app/backend/tests/test_territory_plus.py`). All new `data-testid`s compiled into the frontend bundle (verified by testing agent iteration_23). User needs to **redeploy** for production. Demo account has 0 homes-in-territory so per-row buttons can't be clicked against real rows — Sandra's live account (which has a real polygon) will exercise everything end-to-end.


## My Territory+ bug-fix pass — verified for redeploy (Jun 01 2026)
- **Three production bugs verified fixed on preview**, regression suite added at `/app/backend/tests/test_territory_plus.py` (5/5 PASS):
   1. **Unmark client (CQC/Scotland regulated home)**: `DELETE /api/portal/territory-plus/clients/mark-home` was returning 404 in prod because FastAPI was matching the literal `mark-home` as a `client_id` against the parameterized `DELETE /clients/{client_id}` route. Fixed by declaring the mark-home routes BEFORE the parameterized ones in `territory_plus_routes.py:217-273`. Comment at lines 213-216 documents why ordering matters.
   2. **Additional contacts on Add-Client modal**: `TerritoryClientModal.jsx` (lines 192-274) now exposes an "Additional contacts" section with name/role/phone/email/notes per row + "Add contact" button. Backend whitelists `contacts` field in `PERMITTED_FIELDS` and validates each row via a Pydantic `Contact` model (`territory_plus_routes.py:43-56`). Empty rows stripped client-side before POST.
   3. **Care groups filter buttons**: `FranchiseeTerritoryWidget.jsx` (lines 163-175) computes top-12 providers with home counts; `TerritoryHomesList.jsx` (lines 298-329) renders them as click-to-filter pills with a Clear shortcut. Conditional on `plus=true` + at least one provider with a name.
- **Action item for user**: **REDEPLOY** so production picks up these fixes. Once live, mark a few CQC homes as 'My Client' on Sandra's territory to validate the unmark + provider filter end-to-end (demo account needs a territory polygon for those pills to be visible).


## YouTube OAuth — Unlisted/Private playlist sync (May 31 2026)
- **Problem solved**: the standard `YOUTUBE_API_KEY` only returns Public playlists. Creative Mojo Ltd has 5 internal training/meeting playlists set to Unlisted on YouTube (Mojo Grow Meetings, Zoom Chats, Project Videos, Technique Training, Dementia Training) which were therefore missing from the portal.
- **Solution**: added Google OAuth 2.0 flow (scope `youtube.readonly`) so the backend can call the YouTube Data API on behalf of the channel owner using `mine=true`, surfacing Public + Unlisted + Private playlists.
- **New env vars** in `/app/backend/.env`: `YOUTUBE_OAUTH_CLIENT_ID`, `YOUTUBE_OAUTH_CLIENT_SECRET`. Redirect URI defaults to `{REACT_APP_BACKEND_URL}/api/admin/youtube/oauth/callback` (overridable via `YOUTUBE_OAUTH_REDIRECT_URI`). Both preview + prod redirect URIs are registered in Google Cloud Console under "Creative Mojo Admin Portal (YouTube)" OAuth client.
- **New endpoints** in `youtube_routes.py`:
   - `GET /admin/youtube/oauth/status` → `{configured, connected, connected_email, connected_channel, connected_at, redirect_uri}`.
   - `GET /admin/youtube/oauth/auth-url` → returns the Google consent URL (`access_type=offline`, `prompt=consent` to guarantee a refresh_token).
   - `GET /admin/youtube/oauth/callback` → exchanges code, stores `refresh_token` + `access_token` + audit fields (connected email + channel title) in `db.settings._id=youtube_oauth`, redirects to `/admin/youtube?yt_connected=1`.
   - `POST /admin/youtube/oauth/disconnect` → wipes stored credentials.
- **Sync behaviour**: `_sync_all_playlists` now calls `_get_access_token(db)` first. If OAuth is connected, all YouTube calls go out with `Authorization: Bearer …` and `mine=true`; otherwise it falls back to the API key + `channelId=…` (Public-only). Each sync-log row records `auth_mode: oauth|api_key`. Playlist docs now also capture `privacy_status`.
- **Admin UI**: new "Channel authorisation" panel on `/admin/youtube` with `Authorise YouTube channel` button (full-page redirect to Google), connected state badge with Google account + channel + timestamp, plus Re-authorise / Disconnect controls. Surfaces `?yt_connected=1` / `?yt_error=…` query params returned from the callback.
- **OAuth consent screen** is currently in "Testing" mode; `paul@creativemojo.co.uk` is added as a Test User. Authorising account: Creative Mojo Ltd (`@creativemojoltd` channel).



## Training & Meetings — YouTube playlist integration (Feb 28 2026)
- **New module**: `youtube_routes.py` with full sync pipeline — pulls every playlist on Creative Mojo's channel via YouTube Data API v3, caches in MongoDB (`youtube_playlists` + `youtube_sync_log`), serves portal reads from cache only.
- **Endpoints**:
   - Admin: `POST /admin/youtube/sync`, `GET /admin/youtube/playlists`, `PATCH /admin/youtube/playlists/{id}` (category/enabled/sort_order), `POST /admin/youtube/playlists/{id}/refresh`, `GET /admin/youtube/sync-log`.
   - Portal: `GET /portal/training` (enabled+categorised playlists grouped), `GET /portal/training/{id}` (single playlist + video list).
- **Admin UI** at `/admin/youtube`: manual "Sync from YouTube" button + last-sync pill, playlists table with category dropdown (None / Training / Meetings) + enabled toggle + sync log table.
- **Portal page** at `/portal/training`: yellow hero "Training & Meetings", two sections (Training Videos / Franchisee Meetings) of playlist cards. Card click → `/portal/training/{id}` with embedded `youtube-nocookie.com` iframe, Up-Next video list (with durations), and "WATCH ON YOUTUBE" CTA.
- **Defaults**: every newly-synced playlist arrives `enabled=false` + `category=null` — admin must opt-in before it shows on the portal.
- **Fallback**: a failed sync NEVER wipes the cache. Failed runs write a log row; portal keeps serving last-known-good data.
- **Scheduler**: daily 03:00 UTC tick. Env-var-guarded (no-ops without `YOUTUBE_API_KEY` + `YOUTUBE_CHANNEL_ID`).
- **Sidebar**: portal `Training & Meetings` between Calendar and HQ Updates (available to ALL franchisees, NOT gated). Admin `YouTube Playlists` under Admin → Settings.



## Critical safety guardrails — accidental-broadcast prevention (Feb 28 2026)
- **Root cause of mis-send**: while QA'ing the Edit/Duplicate flow earlier this session, the agent ran a curl test against `POST /api/admin/announcements` on the PREVIEW backend with `recipient_ids: null`. Because the preview env shares the same franchisee email addresses and the same Resend API key as production, that test send went out for real to all 31 active franchisees. The test record was deleted from the DB afterwards but Resend had already dispatched the emails. Cheryl + 1 other franchisee replied to Paul about it. Owned and escalated to the user.
- **Backend guardrails added** in `/app/backend/announcements_routes.py` (POST create + PUT edit):
   1. **Non-production hosts can never broadcast**. If `frontend_origin` (or `Origin` header) is not `hub.creativemojo.co.uk`, the request is forced to a single send to the calling admin's own email — regardless of `recipient_ids`. Stops any future curl/preview test from fanning out.
   2. **Production broadcasts require an explicit `confirm_send_all: true` flag** on the request body. Sending to all without it returns HTTP 400. No "accidentally null and default to all".
- **Frontend confirm dialog** added to `ComposeModal.send()` — when "All active" is selected, a `window.confirm` shows `You are about to send "${title}" to ALL N active franchisees…` before any API call. Cancel halts the send.


- **Nav restructured**: dropped the "Home" tab entirely. `/portal` now lands on **My Franchise** (renamed from Profile). Sidebar groups split by thin grey dividers: `My Franchise · My Territory · Invoicing | Calendar · HQ Updates | File Vault`. Renames: Profile → My Franchise; Territory → My Territory; Events → Calendar; Updates → HQ Updates; Files → File Vault.
- **My Franchise page**: hero panel (photo, organisation, years-as-franchisee, mandate badge) moved up from the old Home page. Two large `font-display text-2xl sm:text-3xl font-black` headings — "Your franchise details" and "My franchise documents" — replace the small uppercase micro-labels.
- **Calendar (was Events)**: "Show recent past" checkbox is now always visible (was list-view only) and the back-window respects the toggle for both list AND calendar views.
- **File Vault (was Files)**: large brand-yellow hero banner "Files for all Franchisees" with sparkle icon, matches the admin Files header.
- **Invoicing**:
   - Removed the **Reconcile** tab from the portal invoices shell (parked for 2.0; CSV bank import + reconciliation UI hidden).
   - Removed the duplicate **"+ Create Invoice"** button from the invoices list header — the shell's sticky **"+ New Invoice"** CTA is now the single entry point. The empty-state CTA shown when there are zero invoices is kept (one-off onboarding nudge).
- `PortalHomePage.jsx` file deleted (route no longer referenced).

## Edit/Duplicate + reliable thumbnails (Feb 28 2026)
- **Edit / Resend**: clicking a past announcement now shows two buttons in the modal header: **DUPLICATE** and **EDIT / RESEND**. Edit reopens the full compose modal pre-filled with title, intro, panels and the **original recipient list** pre-selected; saving via the new `PUT /api/admin/announcements/{id}` overwrites the existing record (keeps `id` + `created_at`), re-mints share-link tokens for every panel, and re-sends via Resend. Duplicate opens compose modal with the same data but creates a brand new announcement on send.
- **Robust thumbnail rendering**: the admin view modal AND the franchisee portal `/portal/updates` page now render panel thumbnails via the **authed `/files/thumbnail` proxy** (new `PanelThumb` component on both pages, using `FileThumbnail`). The brittle public `thumbnail_url` (share-token URL) is still stored on the panel and used in the email body, but the in-app views no longer depend on it — they read `thumbnail_key` directly. This fixes the broken thumbnails reported on production where uploaded panel thumbnails were rendering as alt-text only.

## Polish — Announcement template & multi-panel composer (Feb 28 2026)
- **Email design**: dropped the large brand-yellow banner that wrapped the announcement title. Title now appears **centered** as a plain H1. A separate 1pt green (`#dddd16`) keyline now sits between the intro paragraph and the first panel, with a 30px gap below — gives a clear "summary → projects" rhythm.
- **Panel layout**: redesigned to a centered/stacked layout with order **title → thumbnail → blurb → button** (title centered, wraps naturally with `max-width:480px; word-wrap:break-word`). Solves long-title overflow and gives every panel the full email width.
- **Panel separators**: each project panel is now divided by a 0.5pt grey (`#d4d4d4`) horizontal keyline (first panel uses the green keyline above; no top border).
- **Composer "Add another" affordance**: below the panels list there's now an obvious `ADD ANOTHER · + File · + Folder` row. Unlimited panels, each containing its own title/thumbnail/blurb/button.
- **Per-panel thumbnail picker**: every panel (file OR folder) has a "THUMBNAIL · UPLOAD · Pick / Change" row. Admin can either:
   - **UPLOAD from computer** — new `POST /api/admin/announcements/upload-thumbnail` (multipart) stores image to R2 `shared/_announcement_thumbs/` and registers in `files_index`. ≤20MB. Reuses the same downstream thumbnail/share-token pipeline.
   - **PICK from R2** — opens picker mode (`kind=thumb`) over recent files.
- **Broken thumbnails on portal & emails — FIXED**: `/api/files/share/{token}/thumb` was calling `await build_thumbnail(...)` on a synchronous function with missing args. Replaced with `await anyio.to_thread.run_sync(build_thumbnail, key, size, content_type)`. Now serves `image/jpeg` correctly. All historic share-thumb URLs that were 500-ing now resolve.
- **Live preview thumbnails**: `/admin/announcements/preview-html` inlines real file thumbnails as base64 `data:image/jpeg` URIs for both auto file-panel thumbnails AND admin-picked `thumbnail_key` (works without auth, no broken images in the composer iframe).
- **Wider compose modal** (`max-w-[1400px]`): the right-pane preview iframe comfortably fits the 600px email template with no horizontal scrollbar.
- **Improved recipient picker**: full-width list with a "Search Franchisee" box (matches first/last/org/email substrings), per-row organisation + email visible, Select-all-shown / Clear shortcut buttons, `max-h-72` scroll area. Sandra was always in the API but the cramped 2-col x 40px-max-height list made her hard to find.


## Latest change — Franchisee vs Customer Orders visual split (Feb 27 2026)
- New `order_franchisee_match.py` backend module decorates every Order list/detail response with a `franchisee_match` field. Detection: `customer_email` against franchisee `mojo_email`/`secondary_email` first, then `customer_label` against `organisation`. 60-second TTL cache so the lookup isn't rebuilt per request. Includes ex-franchisees with an `is_ex: true` flag so historic orders still group correctly.
- `OrdersPage.jsx` now splits each tab into two grouped sections — "Franchisee Orders · N" (black banner) at the top and "Customer Orders · N" (stone-100 banner) below. Franchisee rows tinted `#f6f6cd` brand yellow with a small black "FRANCHISEE" pill (and "FRANCHISEE · EX" for ex-franchisees) under the customer name.
- `OrderDetailPage.jsx` shows a brand-yellow banner under the header for franchisee orders: "FRANCHISEE — Franchisee order — [organisation] · matched on email/organisation" with an "Open franchisee →" deep link.
- Verified live: 59 of 1,353 orders correctly tagged on the ALL tab; `#8054` resolves to "Dartford, Bexley & Rochester" via email; `#7964` resolves to "Creative Mojo Manchester West" via org name fallback.

## Feature — Updates / Announcements e-shot system (Feb 28 2026)
**Admin side** (`/admin/announcements` + quick "Send Update" button on `/files`):
- Compose modal: title (subject), intro text, N project panels (each file OR folder + title + blurb + auto-derived or manual thumbnail), recipient picker (All active franchisees vs subset).
- Sends branded HTML email via Resend with Creative Mojo logo header, brand-yellow title banner, intro, panels (thumbnail left, name + blurb + "OPEN FILE/FOLDER →" button right), Creative Mojo footer.
- "Recently added" quick-pick chips in the composer make it easy to flag freshly uploaded files without searching.
- List view: every past announcement with status badge (sent/partial/failed), recipient count, panel count; click to re-open inline; soft-delete from archive.

**Backend** (`announcements_routes.py`):
- Mongo `announcements` collection. POST `/api/admin/announcements` creates, mints **lifetime** share tokens for every file/folder panel, generates personalised HTML and dispatches via Resend (re-using `resend_routes` config). Returns delivery stats (succeeded/failed/errors).
- GET/DELETE `/api/admin/announcements`, `/api/admin/announcements/{id}`, plus `/recent-files` + `/recipients` helpers for the composer. `/recent-files` route registered before `{ann_id}` to avoid path-collision.
- New public `GET /api/files/share/{token}/thumb` endpoint serves a cached R2 thumbnail (PNG) using the lifetime share token — works without Bearer auth so Gmail/Outlook render the email thumbnails forever.

**File share lifetime fix**:
- `POST /api/files/share-link` now accepts `days=0` / `"lifetime"` and creates a non-expiring share token, matching folder shares. (Previously file shares were hard-capped at 30 days.)

**Franchisee portal** (`/portal/updates`):
- New "Updates" nav item (Megaphone icon). Page lists every announcement the logged-in franchisee was a recipient of, newest first. Each row expands inline with full panels + working file/folder links (same lifetime share tokens).
- Admins see every announcement (handy for QA).

## Email templates — paragraph spacing fix + rich signature (Feb 28 2026)
- Fixed the WYSIWYG editor → preview gap: empty `<p></p>` paragraphs (a single Enter-Enter blank line) now render with visible vertical space in both the in-app preview and any downstream renderer. Two-part fix:
  1. `RichTextEditor` post-processes Tiptap output and converts `<p></p>` / `<p><br></p>` to `<p>&nbsp;</p>` so real email clients (Gmail/Outlook) preserve the spacing.
  2. `EmailTemplatesPage` `PreviewHtml` now wraps the rendered HTML in `.email-preview-body` with explicit `p { margin: 0 0 14px 0; min-height: 1em; }` (and matching heading/list styles), Helvetica/Arial body — matching how a real recipient sees the email.
- Replaced the seeded `SIGNATURE_HTML` with a rich version mirroring Paul's actual signature: bold yellow name, bold title, hr, phone/mobile/web/email/address with unicode icons, social links (Facebook/Instagram/X/YouTube), "WATCH THE MOJO PROMO VIDEO" yellow-bordered CTA, IMPORTANT confidentiality block in light grey, and the registered company + VAT footer. Includes the Creative Mojo logo image (loaded from `creativemojo.com`).
- New idempotent endpoint `POST /api/email-templates/refresh-signature` swaps the signature block on every existing template (from "Have a great day." downwards), preserving the per-template body above. Already run live — 2 templates updated.
- Verified on `/admin/email-templates` preview: paragraphs now have proper gaps, signature renders correctly.

## Bug fix — Kanban Reply button uses Resend instead of mailto: (Feb 27 2026)
- Root cause: the orange paper-plane **REPLY** button on each pipeline card invoked a `mailto:` URI which only half-fills the user's local email client (no template body, no signature, no attachments, plain-text only).
- Fix: routed it through the existing `ReplyWithTemplateModal` (same flow as the drawer's "Reply with template"). Auto-picks the licence/franchise template by source, pre-fills To/Bcc/Subject, renders the full HTML preview including signature + Mojo promo CTA + attachments, and sends via Resend on submit. Kanban-card auto-advance to Contacted preserved.
- Page-level `kanbanReplyContact` state added so kanban + drawer can share the same modal without coupling them.
- Verified live on `/contacts`: clicking REPLY on a licence pipeline card opens the modal with "Licence Enquiry Reply (Overseas)" auto-selected, To = enquirer email, full HTML preview rendering, "sent via Resend" footer present.
- Known follow-up (pre-existing, not introduced by this fix): the Licence Info Pack attachment slot on the template still shows "needs an R2 file picked in template" — admin needs to pick the R2 file once at `/admin/email-templates` for the attachment to actually ship with the email.

## Bug fix — Customer orders hidden behind pinned Franchisee rows (Feb 27 2026)
- Removed the franchisee-pinned-to-top grouping on standard Orders tabs (ACTIVE/COMPLETED/ALL/DRAFT). With 65 franchisee rows pinned above 1,277 customer rows on COMPLETED, customer orders sat several screens below the fold — user reported "we have lost all the customer orders".
- Rows now render in natural date-desc order. Franchisee rows remain visually distinct via row tint (`#f6f6cd`) + FRANCHISEE pill (handled in `OrderRow`). Group-banner section headers removed entirely from these tabs.
- Dedicated **FRANCHISEE** tab still does single-group drill-in for franchisee-only views.
- Verified live: COMPLETED first 8 rows are all customer orders in date order; ACTIVE 9 customer + 2 franchisee mixed in chronological order; FRANCHISEE shows 67/67.

## Franchisee tab — easier "just franchisee orders" navigation (Feb 27 2026)
- Added a 5th **FRANCHISEE** tab pill (black + brand-yellow text) to OrdersPage alongside ACTIVE / COMPLETED / ALL / DRAFT, with its own count badge.
- Backend `/api/orders?tab=franchisee` widens the base query to `all` then post-filters on `franchisee_match`. `/api/orders/counts` exposes a new `franchisee` total computed via the same decorator.
- Group banners auto-hide on this tab (no point splitting one group). Page title flips to "Franchisee Orders". Limit bumped to 2000 on this tab so older matches don't get cut off by the default 1000-row window.
- Verified live: tab shows 67/67 franchisee orders, every row tinted, no customer rows leaked.

## Latest change — Monthly Subscriptions for Orders (Feb 27 2026)
- New "Subscriptions" button on the Orders page header (next to "Match to Xero" / "Create Order") opens a paginated modal listing every distinct customer that has at least one order in the DB (Woo + Direct, joined by case-insensitive `customer_label`).
- Each row exposes a single "Add Subscription" checkbox; ticking it persists a `order_subscriptions` row keyed on the normalised customer name. Untick soft-deletes (`active: false`) so audit + last-draft history survives toggling.
- Backend `subscriptions_routes.py` mounts BEFORE `woocommerce_integration` so `/api/orders/subscriptions*` wins over the catch-all `/api/orders/{order_id}`. Endpoints: `GET /customers` (paginated + searchable), `GET /` (full list), `POST /` (add — idempotent reactivate), `DELETE /{id}`, `POST /admin/subscriptions/run-now` (manual trigger).
- Scheduler: `schedule_subscriptions_loop` runs hourly. From the 1st of the month at 08:00 Europe/London onwards (DST-aware via `zoneinfo`), it creates one empty Draft per active subscription with a memo line `"Monthly subscription — fill in this month's items (DD/MM/YYYY)"`. Idempotent via `last_draft_month` flag so a single sub gets exactly one draft per month even across server restarts.
- Drafts surface on the Draft tab with `channel_label: "Subscription"` and `subscription_id` back-ref. Mid-month additions wait until the next 1st (per Paul's request) — no immediate backfill.
- Verified live end-to-end: 392 customers loaded, search narrows to 1 row, optimistic tick → POST 200 + toast, untick → DELETE 200, manual run creates the right draft with the right memo, second run is correctly a no-op.

## Latest change — Territory list/map two-way highlight (Feb 26 2026)
- Opening a home row in `TerritoryHomesList` now tints the whole row in soft amber (`bg-amber-50/70`) so the currently-viewed home is unmistakable in a long list. Header button hover tone switches to `amber-100` while a row is active.
- `TerritoryMap` accepts a new `activeHomeIndex` prop. Whichever numbered pin matches that index is re-skinned in brand yellow (`#dddd16`), enlarged to 30px, ringed with a yellow halo, and lifted with `zIndex: 10`. All other pins revert to the default dark-green style. Implemented as a separate effect so toggling active state never recreates Mapbox markers.
- `FranchiseeTerritoryWidget` wires `activeHomeIndex={openHome}` so the highlight flows in both directions: clicking a marker opens & tints the matching row, and clicking a row highlights the matching marker.

## Latest change — Territory map markers auto-expand the Homes list (Feb 26 2026)
- `FranchiseeTerritoryWidget` now lifts the homes-list expanded state out of `TerritoryHomesList` so a click on any numbered map marker (1, 2, 3…) force-opens the collapsed "Homes in your territory" panel, opens the matching row, and scrolls it into view. Previously a marker click on a collapsed panel was a silent no-op.
- `TerritoryHomesList` accepts optional `expanded` / `onExpandedChange` controlled props; internal state is preserved as the uncontrolled fallback.
- Marker click handler waits two `requestAnimationFrame` ticks after expanding so the row exists in the DOM before scrolling. Verified live on `/portal/territory` for Sandra: marker "5" → row #5 (Forge House Services Limited) auto-opens with full details.

## Latest change — Clickable WooCommerce order reference in Orders page (Feb 26 2026)
- `OrdersPage.jsx` order-reference badge ("8063", "8054", "8047" …) now renders as an anchor when `isWoo && order.woo_id`. Pattern reused from the existing Channel column: `${WOO_BASE_URL}/wp-admin/post.php?post={woo_id}&action=edit`, `target="_blank"`, `rel="noopener noreferrer"`, with an `ExternalLink` icon. Legacy / direct orders keep the plain span. Click-through verified on the live preview (3 woo refs found, first href confirmed).

## Latest change — Per-Franchisee Invoicing Module (Feb 25 2026)
- **Phase 1 — Invoicing clone in the Franchisee Portal** ✅
  - New backend `franchisee_invoices_routes.py` mounted at `/api/portal/invoices/*` with full CRUD for clients, invoices, settings, PDF, stats, next-number — all scoped to `user.franchisee_id` injected by the portal JWT (client-supplied scoping is never accepted).
  - New isolated Mongo collections: `franchisee_invoice_clients`, `franchisee_invoices`, `franchisee_invoice_settings`, `franchisee_bank_transactions`. None of Sandra's admin "Sandra's Invoices" data is touched.
  - Per-franchisee Settings auto-seed from the franchisee profile (business_name, address, phone, email) on first read; **bank details deliberately blank** so each franchisee fills their own.
  - PDF download (`GET /api/portal/invoices/{id}/pdf`) — A4 ReportLab layout cloned from Sandra's Invoices, headers built from per-franchisee settings, attachment Content-Disposition.
  - Frontend: new `PortalInvoicingSection.jsx` (collapsible card in `PortalDashboardPage`) with Invoices / Clients / Bank / Settings tabs. Section is hidden unless admin enables the `invoicing` module.
  - Admin toggle UI: new `PortalModulesPanel.jsx` on `FranchiseeDetailPage` with 4 on/off pills (Map / Calendar / Files / Invoicing). Optimistic toggle + toast feedback. Wired to `PATCH /api/franchisees/{id}/portal-modules`.
  - Defaults: existing franchisees auto-backfill `{map: true, calendar: true, files: true, invoicing: false}` on `/api/portal/me`.

- **Phase 2 — CSV bank reconciliation per franchisee** ✅
  - New endpoints under `/api/portal/invoices/bank/*`:
    - `POST /upload` — multipart CSV (≤5 MB), fingerprint-based dedup so re-upload is idempotent
    - `GET /transactions?only_credits=&only_unreconciled=` — lists with `suggested_invoice` populated when amount exactly matches an outstanding invoice
    - `POST /transactions/{txn_id}/link` — links to an invoice; auto-marks invoice **paid** when sum of linked CREDIT transactions ≥ invoice total; partial credit flips draft → sent
    - `DELETE /transactions/{txn_id}/link/{invoice_id}` — unlinks, reverts paid→sent if under-credited again
    - `DELETE /transactions/{txn_id}` — also cleans up reverse links on any tied invoice
  - New `franchisee_bank_csv.py` — generic CSV parser:
    - Auto-detects header row by keyword scan (date / amount / debit / credit / description / narrative)
    - Falls back to shape inference (date column, numeric column(s), longest text column)
    - Supports single-amount-column (signed) AND split debit/credit pairs (Monzo/Starling)
    - Handles UK `DD/MM/YYYY`, ISO `YYYY-MM-DD`, parentheses-negative amounts, `£`/`$`/`€` prefixes, `utf-8-sig`/`latin-1` decoding
  - Frontend: new **Bank** tab inside `PortalInvoicingSection` — upload CSV, filter (Unmatched / Matched / All credits), one-click match against suggested invoice or pick from dropdown, unlink chip, remove transaction. Auto-refreshes the Invoices tab when a link succeeds.
  - Strictly no TrueLayer / Open Banking — manual CSV only, per Paul's request.

- **Validation**: 23/23 backend pytest scenarios pass via the testing agent (data isolation, cross-franchisee scoping, CSV dedup, partial/full payment auto-paid logic, headered + headerless CSV, split debit/credit). Frontend smoke confirms section visibility honours the admin toggle.

## Latest change — Pre-deploy Code Review fixes (May 22 2026)
Applied all 🔴 Critical findings + 🟡 Important (option d) from the platform Code Review pass:
- **Circular import resolved**: extracted `CqcDefinition` + filter helper to `cqc_definition.py`; `ScotlandDefinition` + filter helper to `scotland_definition.py`. `cqc_routes`, `scotland_routes`, and `territory_routes` now all import from these leaf modules, no more lazy cross-router imports. Endpoints `/api/cqc/definition` + `/api/scotland/definition` both verified 200.
- **Hardcoded test secrets removed**: 23 test files in `/app/backend/tests/` now read `ADMIN_EMAIL` / `ADMIN_PASSWORD` / `INTAKE_TOKEN` from `os.environ.get(..., <default>)` — defaults preserved so local pytest still works.
- **9 ruff style errors cleaned** (`server.py` E701/E401, `scrape_wp_franchise_urls.py` F541, `test_iter15_convert.py` F541, `test_xero_stage_c.py` F841). `ruff` now `All checks passed!`.
- **XSS / innerHTML hardening**:
  - `TerritoryMap.jsx` marker rebuilt with `document.createElement` + `textContent` — no more `el.innerHTML = \`...\``.
  - `PdfJsViewer.jsx` clears its container via DOM-API loop instead of `innerHTML = ""`.
  - `EmailTemplatesPage.jsx` + `ReplyWithTemplateModal.jsx` were already using `DOMPurify.sanitize()` — verified.
- **TerritoryBuilderPage.jsx empty catches**: all 10 silent `catch {/* ignore */}` blocks now log via `console.error` / `console.warn` / `console.debug` with contextual messages.
- **Array-index keys → stable keys**: fixed in `InvoiceDetail.jsx`, `EditInvoice.jsx` (with a runtime-only `_uid` on dynamically-added line items, stripped before `PUT` so it doesn't pollute saved invoices), `ContactsPage.js` (CSV preview rows + drawer address lines), `BankingPage.jsx` (top sources list).
- **No behaviour change** — only correctness/maintainability. Backend reloads cleanly, all affected endpoints respond 200, all five frontend lints pass.

Deferred (post-launch, higher regression risk): banking_routes.py + parse_hsbc_personal + calendar_routes.attach() splits, ContactsPage / TerritoryBuilderPage component splits, 182 hook dependency warnings, localStorage → cookie migration for ContactsPage search history.


## Latest change — Email Templates + Reply-with-template (pre-deploy half) (May 22 2026)
- **Backend**: new `email_templates_routes.py` module with CRUD + duplicate endpoints on `/api/email-templates`. Templates store `name`, `subject`, `body_html`, `default_from`, `sender_name`, `default_cc`, `default_bcc`, `attachments[]` (R2 key + name + body-placeholder slug), `category`. Audit fields tracked.
- **Backend seed**: `seed_email_templates.py` (idempotent) creates two starter templates — **Franchise Enquiry Reply** (`paul@creativemojo.co.uk`, BCC `paul@`, attachment placeholder `franchise_pack`) and **Licence Enquiry Reply (Overseas)** (`licence_pack`). Both reproduce Paul's current Mail.app templates verbatim including the dark "Watch the Mojo promo video" CTA and full signature block. Seeded ✓.
- **Frontend**: new `EmailTemplatesPage.jsx` at `/admin/email-templates` (sidebar entry under Admin → Settings; permission key `admin-email-templates`). Two-pane layout — left rail lists templates with `+ New`, right pane is the editor (subject + From + display name + Cc/Bcc + category) plus a Body section with **Insert `{{first_name}}`**, **Insert R2 file link** (opens R2 file picker using `/api/files/search`), and **Preview** toggle. Duplicate + Delete on every template.
- **R2 file picker**: search dialog reads `/api/files/search`, picking a file stores its `key` + `name` against the placeholder slug. Fresh signed URL will be minted at send time post-deploy so links never expire.
- **Reply Modal** on the Contact drawer: new bright "Reply with template" primary button next to the existing "Quick reply" (the old `mailto:` flow is kept as a secondary path). Modal renders Subject / To / Cc / Bcc (pre-filled from template defaults, all editable) + live preview with `{{first_name}}` substituted. **Send button is intentionally disabled with the tooltip "Wires up to Resend after deployment"** — UX is complete; only the Resend call + webhook receiver remain for stage 2.


- The **LAUNCH CHECKLIST** button is now only visible after a contact has been converted to a Franchisee — it lives in the Franchisee detail page top-bar (next to Edit). The button surfaces the "last updated DD/MM/YYYY" stamp once any save has occurred.
- Removed from the Contact drawer (Interested state) — that panel reverts to just the small Checklist (Territory confirmed / Contract sent / Shadow Day / Training Days).
- Extracted the modal to `frontend/src/components/LaunchChecklistModal.jsx` — generic over its subject record + endpoint URL so it can be reused anywhere.
- **Backend**: new `PATCH /api/franchisees/{id}/launch-checklist` endpoint mirrors the contact-side one (same coercion, same audit fields `launch_checklist_updated_at` + `launch_checklist_updated_by`). The pre-conversion endpoint on contacts is kept in case any in-flight prep data was already saved against an Interested contact.
- Validated end-to-end: contact drawer test confirms the button is gone (count = 0); franchisee top-bar shows the new button on Sandra Caldeira-Dunkerley's record; backend PATCH round-trip works + rejects non-dict payloads.

## Previous change — Inline-edit contact details (May 22 2026)
- New **Edit** pencil button in the top-right of the Contact drawer's contact-info card. Click → name + email + telephone + full address (1st line / 2nd line / Town-City / County-State / Postcode / Country) all become editable inputs. Save / Cancel buttons live inside the card.
- **Backend `PATCH /api/contacts/{id}/details`** updates a strict whitelist of fields (`first_name`, `last_name`, `email`, `telephone`, `mobile_phone`, `address_line_1`, `address_line_2`, `city`, `county`, `postcode`, `country`). Email auto-lowercased; postcode auto-uppercased. Legacy field mirrors (`address_line_1 ↔ address_street`, `city ↔ town_city`) kept in sync. Audit fields `details_updated_at` + `details_updated_by` stamped on every patch.
- Saved values are mirrored back into the parent's cached contact list via the existing `onChecklistChanged` channel (now used as a generic "fields-merge" pipe with undefined-stripping), so the kanban / pipeline view updates without a refetch.
- React Hook-order fix: `useEffect` that resets edit mode on contact switch sits above the drawer's early-return.
- Bonus during testing: fixed Samantha Whiteman's "East Sussec" → "East Sussex" county typo end-to-end.

## Previous change — Full address fields on contacts (May 22 2026)
- **Manual Add Contact modal** now has a dedicated **Address** sub-section with all six fields: **1st line of address**, **2nd line of address**, Town / City, **County / State**, Postcode, **Country** (defaults to "United Kingdom", editable). Previously only Postcode + City were collected manually.
- **Backend `POST /api/contacts`** accepts the four new fields (`address_line_1`, `address_line_2`, `county`, `country`) and persists them. `address_line_1` is also mirrored into the legacy `address_street` key so older list views / exports stay populated. `city` is mirrored into `town_city`. Postcode auto-uppercased.
- **Contact drawer** address block now renders as a **multi-line** block (one field per line, with a fixed pin icon at top-left) instead of comma-joined. Falls back through `address_line_1 || address_street`, `city || town_city`, so legacy Airtable / Gravity-form imports render with the same layout — the user noticed this data is already in the database for most contacts.
- Verified end-to-end via curl create + drawer screenshot.

## Previous change — In-House Launch Prep Checklist modal (May 22 2026)
- New **"LAUNCH CHECKLIST"** dark button in the Contact drawer, shown only when `pipeline_status === "qualified"` (Interested) and the contact isn't already converted. Opens a right-hand slide-out modal mirroring Sandra's printed sheet:
  - Sections: **CONTRACT** (1 Contract prep / 2 Territory prep) · **FRANCHISE KIT** (3 Printed materials with two ticks per row — A/W Done + Printed, 4 Materials for kit, "Does the kit require couriering?") · **DIGITAL** (5 Email account + email free-text, 6 Social media + Facebook URL free-text, 7 Website listing, 8 FileCamp, 9 Launch + "If NO what date" date picker) · **DBS** (10 Info supplied) · **RENEWALS & DIRECT DEBITS** (DD mandate setup).
  - Name field is **auto-filled** from `first_name + last_name`; everything else is single-tick (no "No" column) or free text.
  - Strikethrough items from Sandra's printed sheet (2pp A5 One-2-One leaflets, business start-up leaflet, picture prints, Russian dolls, FileCamp setup-user line, renewal-date / 18-month / deferred-fees / anniversary reminders, all SHAPES rows) are excluded.
- **Backend**: `PATCH /api/contacts/{id}/launch-checklist` accepts a free-form `launch_checklist` object (coerced to primitives + one-level nested dicts for the print rows), stores it alongside `launch_checklist_updated_at` + `launch_checklist_updated_by`. Rejects non-dict payloads with 400.
- The drawer button shows "last updated DD/MM/YYYY" once any save has occurred. State persists per-contact so Sandra can save & resume.

## Previous change — Scottish Care Inspectorate dataset wired in (May 22 2026)
- **Backend**:
  - New `scotland_routes.py` (CSV-driven, no API). Endpoints: `GET/PUT /api/scotland/definition`, `GET /api/scotland/definition/preview`, `GET /api/scotland/distinct?field=careService|subtype|clientGroup|councilArea`, `POST /api/scotland/import` (multipart CSV upload), `GET /api/scotland/import/status`. CSV import is atomic — load into `scotland_care_services_tmp`, drop old, rename. Indexed on `csNumber` (unique), `postcode_sector`, `careService`, `subtype`, `clientGroup`, `councilArea`, `serviceStatus`.
  - `territory_routes.py` is now country-aware: `_count_homes_per_sector` and `_list_homes` automatically split a sector list into Scottish (→ `scotland_care_services` + `scotland_definition`) vs rest-of-UK (→ `cqc_locations_live` + `cqc_definition`). All five `/territory/*` endpoints (`sectors-near`, `sector-polygons`, `homes`, `homes-count`, plus the polygon back-compat alias) inherit the merge automatically.
  - `PUT /cqc/definition` AND `PUT /scotland/definition` now both recompute franchisee `territory_home_count` by summing English + Scottish portions of each franchisee's sector list (so border franchisees stay correct).
  - **Auto-detection by postcode prefix.** `is_scottish_postcode()` checks the standard 16 Scottish UK postcode prefixes (AB / DD / DG / EH / FK / G / HS / IV / KA / KW / KY / ML / PA / PH / TD / ZE). No "which database" toggle is required when adding a new franchisee — every sector self-identifies. Validated: Central Scotland (#0046) went from 0 → 140 homes once the rule was saved.
- **Frontend**:
  - New page `ScotlandDefinitionsPage.jsx` (route `/scotland-definitions`, sidebar entry under Admin). Upload-CSV banner + facet chip groups (Care Service / Subtype / Client Group) + min beds + min grade + active toggle + live preview pane (count + top councils + sample homes).
  - Added `scotland-definitions` to the permission whitelist (backend `ADMIN_NAV_KEYS` + frontend `Layout.ADMIN_NAV_KEYS`).
  - Initial CSV loaded: April 2026 Datastore (10,583 services). Initial rule: `Care Home Service` + Active. 1,368 services match.



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
  - **Stage A** ✅ Read-only Woo sync: 246 orders + 325 products mirrored via REST + webhook.
  - **Stage B** ✅ Editable orders, Actions menu, manual Create Order modal, bulk-action bar, legacy CSV import + continuous numbering.
  - **Stage C** ✅ Xero accounting integration (May 21 2026) — OAuth 2.0 flow with secure token storage + auto-refresh, draft invoice creation from any order in one click, Xero invoice ID/Number/Status shown on order header, payment webhook with HMAC signature verification that flips local `payment_status` to "Paid" when Xero invoice is settled. Admin connects via `/admin/xero` settings page. New `xero_tokens` collection. Routes: `/api/xero/{status,connect,callback,disconnect,contacts,webhook}` + `/api/xero/orders/{id}/{create-invoice,invoice}`. Env vars: `XERO_CLIENT_ID`, `XERO_CLIENT_SECRET`, `XERO_REDIRECT_URI`, `XERO_WEBHOOK_SIGNING_KEY`. **Live tenant connected: Creative Mojo Ltd (HQ).** Uses 2026 granular scopes (`openid profile email offline_access accounting.invoices accounting.contacts`).
  - **Stage C.1 — Customer reconciliation tooling** ✅ (May 21 2026) — Stops orders showing up without a Xero contact link.
    - New `xero_contacts_cache` collection (1,085 contacts cached locally).
    - New `crm_customers` collection — 701 legacy customers imported via `import_legacy_customers.py`. 549 auto-linked to Xero by email, 235 linked to existing orders by email, 97 orders propagated through to Xero contacts via the legacy bridge.
    - Bulk auto-match endpoint `POST /api/orders/auto-match-xero` matched a further 1,111 orders by exact name → 145 orders remain genuinely unmatched.
    - **Customer autocomplete** — new `XeroContactPicker` component (debounced, cache-backed). Wired into Create Order modal + Change Customer modal on order detail page. Includes inline "Create '<name>' in Xero" action when no exact match exists.
    - **Reconciliation page** at `/orders/reconcile` — lists unmatched orders with best-guess suggestion (email > name), per-row Confirm/Pick-different/Create/Skip actions, top-bar "Sync Xero contacts" + "Auto-match all" buttons.
    - New routes: `POST /api/xero/contacts/sync`, `POST /api/xero/contacts/create`, `POST /api/orders/{id}/link-xero-contact`, `POST /api/orders/{id}/unlink-xero-contact`, `POST /api/orders/{id}/skip-xero-reconcile`, `GET /api/orders/reconciliation`, `POST /api/orders/auto-match-xero`.
  - **Inline Production status dropdown** ✅ (May 21 2026) — Production column on `/orders` now editable inline as a coloured Airtable-style pill with 5 options: Awaiting Assembly (rose), In Production (orange), Awaiting Labels (teal), Ready To Ship (stone), Complete (emerald). PATCHes `/api/orders/{id}` optimistically. Header on OrderDetailPage uses the same lozenge dropdown.
  - **Editable line items + product variations** ✅ (May 21 2026) — Order detail page line items now have inline-editable SKU + Name + Qty + Price (previous version only allowed delete). `sync_products` now also fetches variations per variable product (Woo `/products/{id}/variations`) so the autocomplete shows "Group Art Kit – Medium / Large / 1-2-1 Kit" as separate rows, grouped under their parent name, with PDF/downloadable badges where applicable. Removed redundant "Production" select from the right info panel.
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

- **Contacts Duplicate Finder** ✅ (May 20 2026)
  - New `GET /api/contacts/duplicates` endpoint — groups all live (non-merged) contacts across `web_form_contacts` + `contacts` collections by case-insensitive trimmed email, returns only groups with 2+ members, sorted by count desc.
  - Initial scan found **1,735 duplicate email groups containing 3,916 contacts** (top offenders: `info@creativemojo.com` x8, `camilla.nygaard@hotmail.com` x8, several at x6).
  - New `<DuplicatesModal>` component (`/app/frontend/src/components/contacts/DuplicatesModal.jsx`): toolbar "Find Duplicates" button on ContactsPage opens a modal listing groups with collapsible accordion. Each row shows name, source pill, pipeline stage, postcode, created date, GF entry id. Admin checks two rows then "Merge Selected" hands off to the existing `<MergeContactsModal>`.
  - Auto-reloads after each merge so survivor + dropped loser update in place; groups that fall below 2 contacts disappear automatically.
  - Email filter input at top of modal narrows the list (shows first 200 groups, refine filter to access tail).

  - **New `PortalBottomNav` component** — fixed bottom tab bar visible only `<md` (≤767px). 5 tabs: HOME / FILES / EVENTS / PROFILE / SIGN OUT. Smooth-scrolls to section anchors via `getElementById + scrollTo`. Active state tracked via `IntersectionObserver` (rootMargin `-30% 0px -50% 0px`). Respects `pb-safe` so it sits above the iPhone home indicator.
  - **`PortalDashboardPage`** rewritten mobile-first: hero stacks vertically `sm:row`, profile/territory/events/files panels are independently collapsible and full-width, all CTAs `touch-target` sized, header sign-out hidden on mobile (handled by bottom nav), bottom padding `pb-28 md:pb-8` so the fixed nav doesn't cover content. Territory widget uses `mapHeight=360` on phones, `640` on desktop.

- **Contact source re-categorisation + new Care Home / Art Kit tabs** ✅ (May 20 2026)
  - **Root cause:** The original Airtable migration lumped every web-form contact into ``source='franchise_enquiry'`` regardless of the user's actual "Reason for contacting". The reason text was preserved (in ``why_contacting`` for legacy / Airtable rows and ``reason_for_contacting`` for Form 1) so we could recover the right category from existing data.
  - **One-shot migration** at ``/app/backend/migrations/20260520_recategorise_sources.py`` re-classified 498 records: **169** franchise → ``care_home_enquiry``, **144** franchise → ``general_enquiry`` (Reason=Other), **104** franchise → ``art_kit_enquiry``, **43** general → ``art_kit_enquiry``, **37** general → ``care_home_enquiry``, **1** licence → franchise. ``in_pipeline=False`` forced on **196** rows that moved out of franchise/licence.
  - **New tabs** in ContactsPage: "Care Home Contacts" (teal pill, ~206) + "Art Kit Contacts" (amber pill, ~147), reference-only (excluded from sales pipeline). Backend ``/api/contacts?tab=care_home|art_kit`` supports the new tabs.
  - **Tab count badges** — new ``GET /api/contacts/counts`` returns totals per tab; ContactsPage renders them next to each tab label so admins can see at a glance: Pipeline 605 · Franchise 1,517 · Licence 41 · Care Home 206 · Art Kit 147 · General 6,128 = **8,644 total** (matches Airtable migration).
  - **List limit raised** from 2,000 to 10,000 — the General tab (~6,128 records) was previously truncated. Now all rows render.
  - **Live webhook (Form 1) + GF backfill** now map ``Care home class enquiry`` → ``care_home_enquiry`` and ``Deliverable Art Kit Enquiry`` → ``art_kit_enquiry`` so new submissions land in the right tab.
  - **Date display in Duplicate Finder** fixed: previously showed ``created_at`` (the 13 May 26 migration timestamp), now shows the original ``date`` field (e.g. 25 Nov 20 from Airtable / Gravity Forms).
  - Regression tests: ``/app/backend/tests/test_contact_categories.py`` — 5 tests covering counts endpoint, source-filtered tabs, and Form-1 reason mapping for both new categories.

  - **`PortalLoginPage`**: `pl-safe pr-safe pt-safe pb-safe`, centered headings on mobile, mobile logo with "Franchisee Portal" caption, `inputMode=email`, `ios-no-zoom` input class, `autoComplete=username/new-password/current-password`, 44px tap targets on all buttons including eye-toggle.

- **Legacy contact re-categorisation + List pagination + Cross-collection tab unification** ✅ (May 20 2026)
  - **Phase-2 migration** at ``/app/backend/migrations/20260520b_recategorise_legacy_contacts.py`` re-sourced **1,546** records from the legacy ``contacts`` collection based on their ``why_contacting`` field (handles list-shaped Airtable multi-selects too): **1,181** → ``franchise_enquiry``, **163** → ``care_home_enquiry``, **117** → ``general_enquiry``, **85** → ``art_kit_enquiry``. Remaining 4,408 stay as ``legacy_general_enquiry`` (no reason recorded in Airtable).
  - **Tab unification**: Each non-pipeline tab (Franchise / Licence / Care Home / Art Kit) now unions BOTH ``web_form_contacts`` AND legacy ``contacts`` by ``source``. Previously the legacy collection was only visible under "General" — meaning a person like Caroline Simm (in both Airtable tables) appeared in BOTH Legacy AND Care Home. Now she only appears in Care Home (still 2× until merged, but in one tab).
  - **General tab** now excludes legacy rows that were re-categorised — only shows rows with ``source IN [legacy_general_enquiry, general_enquiry, null]``. Dropped from 6,128 → 4,699 records.
  - **Counts endpoint** updated to sum web + legacy per source. New totals: Pipeline 605 · Franchise 2,698 · Licence 41 · Care Home 369 · Art Kit 232 · General 4,699 = **8,039 total contacts** (within ~1% of the 7,638 Airtable + ~1,000 recent GF intake).
  - **List view pagination**: Replaced hard "Showing first 500 of N" truncation with a working pager. New "Show 500 more" and "Show all N" buttons (``data-testid="list-show-more"`` / ``list-show-all"``) — admins can now walk through all 4,699 General contacts (or the full Franchise 2,698) instead of being capped at 500. Resets per tab/search change to avoid DOM bloat.
  - Bug fix: an unreachable duplicated ``elif tab == "general"`` block was overriding the new filter with ``q_legacy = {}`` — removed.

  - **`FranchiseeFilesPanel`**: tab strip becomes horizontally scrollable on phones with shortened labels ("My documents", "Shared files"), search input full-width on mobile + 16px font, view-toggle + ZIP button touch-target sized. File rows: filesize moves below filename on mobile, download button always 44px tall, label "Save" hidden on phone showing just the icon.
  - **`PortalEventsPanel`**: header toggle + content padding scales `px-4 sm:px-6`, "Join meeting" button becomes full-width below event details on mobile, next-event teaser hidden when collapsed on phone (keeps header compact).

- **Hot badge removed + Cross-tab search** ✅ (May 20 2026)
  - "Hot Lead" badge (driven by Airtable's legacy ``potential`` field) was a stale stamp on 9 web-form contacts — removed from both the kanban card and the contact-drawer header so it no longer creates noise.
  - **Cross-tab search**: ``/api/contacts`` now ignores the ``tab`` filter when ``search`` is non-empty and queries BOTH ``web_form_contacts`` + legacy ``contacts`` collections regardless of source / pipeline membership. Bug context: Ali Imperiale (``aliimperiale@btinternet.com``) was in the legacy collection with ``source=legacy_general_enquiry``; default Pipeline-tab search couldn't see her even though she existed.
  - **Cross-tab banner** (``data-testid="cross-tab-search-banner"``) appears whenever the search box is non-empty, telling the user results may come from any tab and showing each contact's source pill so it's obvious which tab they belong to.
  - Regression tests: ``/app/backend/tests/test_cross_tab_search.py`` — 3 tests covering (a) Ali Imperiale findable from Pipeline tab, (b) a seeded contact findable from every tab, (c) defensively, Pipeline tab WITHOUT search still scopes to ``in_pipeline=True``.

  - **`FilePreviewModal`**: modal goes full-screen on mobile (`items-stretch sm:items-center`, `p-0 sm:p-6`, `h-full sm:h-auto`, no rounded corners on phone), `playsInline` on video to avoid forced fullscreen on iOS, key path hidden on small screens, close-button enlarged to touch-target.

- **Phase 2 Stage A — Orders module (WooCommerce read-only mirror)** ✅ (May 20 2026)
  - New ``/app/backend/woocommerce_integration.py`` — async ``httpx`` client over WooCommerce REST API v3 with HTTP Basic Auth, paginated backfill honouring ``X-WP-TotalPages``, HMAC-SHA256 webhook signature verification (``X-WC-Webhook-Signature``), production-status mapping (Woo ``processing`` → "Ready To Ship", ``pending``/``on-hold`` → "Awaiting Assembly", terminal → "Completed"), and hourly safety re-sync over a 2h sliding window.
  - **New endpoints**: ``GET /api/orders`` (tabs: active/completed/all/draft + search), ``GET /api/orders/counts``, ``GET /api/orders/{id}``, ``GET /api/woo/products/autocomplete``, ``POST /api/admin/woo/backfill-orders`` (background task), ``POST /api/admin/woo/sync-products``, ``POST /api/intake/woocommerce`` (HMAC-verified webhook).
  - **New Mongo collections**: ``woo_orders`` (keyed by Woo ID, full raw payload + derived fields ``production_status``, ``payment_status``, ``channel_label``, ``invoiced``, ``status``), ``woo_products`` (autocomplete source).
  - **New frontend page** ``/app/frontend/src/pages/OrdersPage.jsx`` at route ``/orders`` — mirrors the legacy admin's "Active Orders" page pixel-by-pixel: ACTIVE/COMPLETED/ALL/DRAFT tab pills with count badges, Show Products toggle (lime ``#D4FF00`` switch), table with channel pills (``Direct`` / ``Woo#NNNN``), navy "Ready To Ship" + rose "Awaiting Assembly" production pills, green/grey payment pills, relative due-date labels (``in 10 days`` / ``in 1 day``). Sidebar nav: new "Orders" entry above the existing "Mojo Orders (Legacy)" iframe page.
  - **Stage-A demo banner** renders only while seed data is present — auto-hides once real Woo credentials are wired and the backfill replaces seed records.
  - **Demo seed** at ``/app/backend/seed_woo_demo.py`` — 12 orders + 20 products mirroring the user's reference screenshots. Idempotent (re-run replaces); cleared automatically once live Woo data arrives.
  - **Env additions** (placeholders pre-added in ``backend/.env``): ``WOO_BASE_URL``, ``WOO_CONSUMER_KEY``, ``WOO_CONSUMER_SECRET``, ``WOO_WEBHOOK_SECRET``.
  - Regression suite: ``/app/backend/tests/test_orders_stage_a.py`` — 6 tests (counts, active tab, completed tab, search, webhook 401-on-unsigned, autocomplete). Total project pytest count now 15/15 passing.
  - **Stage B + C scope** (not yet built): manual order create, order detail edit with product autocomplete + shipping field + Actions menu (Mark Completed / Complete & Invoice / Create Invoice / Mark Paid / Change Customer), bulk-actions row, Xero integration (customer pull, invoice creation, payment status sync).

  - **Tested at 390×844 (iPhone 12 Pro)** — `window.matchMedia(min-width:768px) = false`, bottom nav `display: block`, all 4 tabs scroll-to-section correctly with active-state highlight, no horizontal scroll. Admin pages untouched.

- **Pipeline kanban — shift-select bug fix** ✅ (May 20 2026)
  - Bug: shift-clicking checkboxes in the NEW column also selected unrelated cards in INTERESTED / TERRITORY MAP / etc. Root cause: `toggleSelect` walked the range through `visibleItems` (all stages interleaved) rather than the column-specific list.
  - Fix: when in pipeline view, the shift-range is now scoped to `grouped[anchorStage]`. If the anchor and target are in DIFFERENT stages, the shift modifier is ignored and only the single target is toggled.

- **Sales Pipeline — Form 1 ("Contact Form") now ingested + Lucy Cook mandate linked** ✅ (May 20 2026)
  - **Bug 1**: Clare Shannon (and Paul Caldeira-Dunkerley etc.) were submitted via the general /contact/ form (`form_id=1`) and selected "Franchise enquiry" in the dropdown. We never ingested form 1 — only forms 17/32 — so 21 franchise enquiries were silently lost.
    - Fix: added form 1 to `GF_BACKFILL_FORM_IDS=1,17,32`, extended `FIELD_LABELS_BY_FORM` to map its layout (field 9/12/4/5/13/14/15/16/21/20/6), added `FORM1_REASON_TO_SOURCE` so the "Reason for contacting" dropdown (field 20) drives source assignment: "Franchise enquiry" → `franchise_enquiry`, "Licence enquiry" → `licence_enquiry`, anything else (care-home, art-kit, other) → `general_enquiry` (ingested into CRM but stays OUT of pipeline kanban). Field 21 → `establishment_name`. `pipeline_status="new"` only set when reason is franchise/licence.
    - One-off run: `{inserted: 179, updated: 0, errors: []}` — recovered 21 missed franchise enquiries (now in pipeline) + 108 general enquiries (CRM only).

- **Phase 2 Stage B — Orders editing + manual create + Actions menu + bulk** ✅ (May 21 2026)
  - **New backend endpoints**: ``POST /api/orders`` (create manual draft, channel=direct, lands in Draft tab), ``PATCH /api/orders/{id}`` (whitelist edit: line_items full-replace, shipping_total, due_date, customer_label, customer_email, production_status, payment_status, status, is_draft, invoiced, admin_notes; auto-recomputes order total), ``POST /api/orders/{id}/action`` (5 live actions: mark_completed, complete_and_invoice, create_invoice, mark_paid, change_customer + 1 draft action: mark_active), ``POST /api/orders/bulk-action`` (mark_completed / mark_paid / delete across many ids), ``DELETE /api/orders/{id}`` (manual drafts only — refuses to delete Woo-sourced orders).
  - **HTML strip** on Woo product names — fixes the ``<strong>FREE</strong> Queen Camilla Colouring-In Sheet`` rendering issue. 13 historic orders cleaned up in-place.
  - **New frontend page** ``/app/frontend/src/pages/OrderDetailPage.jsx`` at route ``/orders/:orderId`` — full editable workspace mirroring "3 Order Detail View MAIN.png": product autocomplete (live search against synced 325-product Woo catalogue), inline line item Qty/Price/Remove, shipping field, due-date picker, production dropdown, Save Order, Actions menu (different option set for live vs draft orders), Change Customer modal.
  - **OrdersPage upgrades**: Edit button + row click now navigate to detail; bulk-select checkboxes per row; floating bulk-action bar (Mark Completed / Mark Paid / Select all / Clear) — lets admin clear the 220+ stale "active" Woo orders in seconds; Create Order modal wires up the manual draft flow.
  - **Pytest invoice placeholder**: ``create_invoice`` and ``complete_and_invoice`` actions write ``invoiced=True`` + ``invoice_pending_xero=True`` — Stage C's Xero integration will pick those up and generate the actual invoice.
  - End-to-end manual + API testing confirmed: CREATE → PATCH (add line items) → MARK_ACTIVE → COMPLETE_AND_INVOICE → DELETE all working. Lint clean.
  - **Stage C scope** (not yet built): Xero OAuth, customer pull/match, invoice creation from ``invoice_pending_xero`` queue, payment status sync back to ``payment_status``.

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
