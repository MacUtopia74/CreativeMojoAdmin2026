// Franchisee portal calendar.
//
// Three event sources, three colour swatches:
//   - HQ events     (from Google Calendar, opt-in per event)  → lime (brand)
//   - Yearly events (CSV-uploaded by HQ, visible to all)      → solid light blue
//   - My events     (created by the franchisee themselves)    → solid purple
//
// Default view is the calendar grid (month). Week / Day buttons sit
// alongside, and a tap on any day opens a fullscreen modal listing
// every event for that day in full — primarily for mobile. Past events
// are always included (no toggle). Franchisees can add their own
// entries via the "Add Calendar Entry" button above the grid.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import api from "@/lib/api";
import {
  CalendarDays, Video, MapPin, Clock, ChevronDown, ChevronUp,
  Loader2, ExternalLink, RefreshCw, LayoutGrid, LayoutList, X, Plus,
  Pencil, Trash2, Save, AlertCircle, Sparkles, User, Search,
  BookOpen,
} from "lucide-react";
import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/daygrid";
import timeGridPlugin from "@fullcalendar/timegrid";
import interactionPlugin from "@fullcalendar/interaction";
import ProjectsThisMonthModal from "@/components/calendar/ProjectsThisMonthModal";

const UK = "en-GB";
// Mojo brand green/lime — used for the HQ swatch and dedicated to Zoom
// meetings (which are the most common HQ meeting type the brand wants
// to surface). Teams meetings keep the cooler blue-ish HQ tint and any
// in-person HQ event falls back to the lime tint too.
const COLOUR_HQ = { bg: "rgba(212, 255, 0, 0.4)", border: "#365314", text: "#1c1917" };
const COLOUR_ZOOM = { bg: "#dddd16", border: "#7a7a0c", text: "#1c1917" };
const COLOUR_YEARLY = { bg: "#3B82F6", border: "#1D4ED8", text: "#FFFFFF" };
const COLOUR_MINE = { bg: "#9333EA", border: "#6B21A8", text: "#FFFFFF" };

const isZoomUrl = (u) => !!u && /(^|\W)zoom\.(us|com)\b/i.test(u);
const isTeamsUrl = (u) => !!u && /teams\.(microsoft|live)\.com/i.test(u);

// FullCalendar `eventContent` renderer — title on top, time below,
// styled via `.portal-cal-chip*` rules in /src/index.css. Lives at
// module scope so React doesn't treat it as a new component each
// render (no remount thrash).
function renderCalChip(arg) {
  const timeText = arg.event.allDay ? "" : arg.timeText;
  return (
    <div className="portal-cal-chip">
      <div className="portal-cal-chip-title">{arg.event.title}</div>
      {timeText && <div className="portal-cal-chip-time">{timeText}</div>}
    </div>
  );
}

function ukDate(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString(UK, {
      weekday: "short", day: "2-digit", month: "short",
    });
  } catch { return iso; }
}
function ukTime(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleTimeString(UK, {
      hour: "2-digit", minute: "2-digit",
    });
  } catch { return ""; }
}

function todayLocal(offsetMinutes = 0) {
  const d = new Date(Date.now() + offsetMinutes * 60 * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// All-day yearly events come back as YYYY-MM-DD. FullCalendar treats
// an all-day event's "end" as exclusive (so a single-day event needs
// end = next day) but we render single-day events by default and don't
// expose multi-day in the CSV path, so this helper handles either:
// - if start already has a time component, keep it
// - else returns YYYY-MM-DD
function dateOnly(d) {
  if (!d) return d;
  return d.length >= 10 ? d.slice(0, 10) : d;
}

export default function PortalEventsPanel({ open, onToggle, alwaysOpen = false, isFranchisee = true }) {
  // alwaysOpen = true → render without the collapse header (used on the
  //   dedicated /portal/calendar page).
  // open / onToggle = legacy collapse behaviour (used on dashboard).
  const isOpen = alwaysOpen || open;

  const [hqEvents, setHqEvents] = useState(null);    // null = loading
  const [yearlyEvents, setYearlyEvents] = useState([]);
  const [myEvents, setMyEvents] = useState([]);
  const [connected, setConnected] = useState(true);
  const [busy, setBusy] = useState(false);

  const [viewMode, setViewMode] = useState(() => {
    // Calendar is the default. Persist per-franchisee so toggling sticks.
    try { return localStorage.getItem("portalEventsView") || "calendar"; }
    catch { return "calendar"; }
  });
  useEffect(() => {
    try { localStorage.setItem("portalEventsView", viewMode); } catch { /* noop */ }
  }, [viewMode]);

  // Calendar sub-view (Month / Week / Day). Drives FullCalendar's
  // initialView and is updated when the user clicks the toolbar
  // buttons too, so the React state stays in sync with the grid.
  const [calView, setCalView] = useState("dayGridMonth");
  // The currently-visible calendar month/year. Updated via FullCalendar's
  // ``datesSet`` callback so the "Projects this month" modal reflects
  // what the franchisee is looking at — not always today's month.
  const [visibleDate, setVisibleDate] = useState(() => new Date());
  // Projects-for-this-month modal (linked to Woo "Standard Boxed Art Kits"
  // via shared Project Code). Visible to every logged-in franchisee.
  const [projectsModalOpen, setProjectsModalOpen] = useState(false);
  const fcRef = useRef(null);

  // Day-detail modal — fired by either dayClick or "more" link.
  const [selectedDay, setSelectedDay] = useState(null); // ISO YYYY-MM-DD
  // Add / edit personal event.
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorEvent, setEditorEvent] = useState(null); // null = create

  // Search query — filters event title / location / notes across all
  // three sources. Empty string shows everything. Matched against
  // case-insensitive substring so franchisees can find an event by
  // any partial word (e.g. "wimble" → "Wimbledon training").
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const [hq, yearly, mine] = await Promise.allSettled([
        api.get("/calendar/portal-events", {
          // Always include past events going back a year (per Paul's
          // spec). Server caps days_back at 30 for the HQ events, so
          // pass 30 here — the yearly + my-events feeds don't have
          // that cap and cover the full historical window already.
          params: { days_ahead: 365, days_back: 30 },
        }),
        api.get("/portal/calendar/yearly-events"),
        // My-events endpoint is franchisee-only; admins previewing the
        // portal won't have a franchisee_id, so swallow 403 silently.
        isFranchisee
          ? api.get("/portal/calendar/my-events")
          : Promise.resolve({ data: { items: [] } }),
      ]);
      if (hq.status === "fulfilled") {
        setHqEvents(hq.value.data.events || []);
        setConnected(hq.value.data.connected !== false);
      } else {
        setHqEvents([]);
      }
      if (yearly.status === "fulfilled") {
        setYearlyEvents(yearly.value.data.items || []);
      }
      if (mine.status === "fulfilled") {
        setMyEvents(mine.value.data.items || []);
      }
    } finally {
      setBusy(false);
    }
  }, [isFranchisee]);

  useEffect(() => { load(); }, [load]); // eslint-disable-line

  // Merged FullCalendar events. Each carries `_kind` so click handlers
  // can route correctly (HQ join URL vs edit-mine vs read-only yearly).
  //
  // Search-aware: when `search` is non-empty, only events whose
  // title / location / notes contain the query (case-insensitive)
  // make it into the merged list. The query also feeds the search
  // results panel below the calendar.
  const searchNeedle = (search || "").trim().toLowerCase();
  const matchesSearch = useCallback((evt) => {
    if (!searchNeedle) return true;
    const hay = [
      evt.title, evt.location, evt.notes, evt.description, evt.summary,
    ].filter(Boolean).join(" ").toLowerCase();
    return hay.includes(searchNeedle);
  }, [searchNeedle]);

  // When the search term changes, jump the calendar grid to the
  // earliest matching event's month so the user sees results
  // immediately instead of being stranded on the current month.
  // Prefers future matches over past ones — most searches are
  // "what's coming up", not retrospective.
  useEffect(() => {
    if (!searchNeedle || !fcRef.current) return;
    const dates = [];
    (hqEvents || []).forEach((e) => { if (matchesSearch(e) && e.start) dates.push(e.start); });
    yearlyEvents.forEach((y) => { if (matchesSearch(y) && y.date_iso) dates.push(y.date_iso); });
    myEvents.forEach((e) => { if (matchesSearch(e) && e.start) dates.push(e.start); });
    if (!dates.length) return;
    const today = new Date().toISOString().slice(0, 10);
    const future = dates.filter((d) => d.slice(0, 10) >= today).sort();
    const past = dates.filter((d) => d.slice(0, 10) < today).sort().reverse();
    const target = future[0] || past[0];
    if (target) {
      try { fcRef.current.getApi().gotoDate(target); } catch { /* noop */ }
    }
  }, [searchNeedle, hqEvents, yearlyEvents, myEvents, matchesSearch]);

  const fcEvents = useMemo(() => {
    const out = [];
    (hqEvents || []).forEach((e) => {
      if (!matchesSearch(e)) return;
      const palette = isZoomUrl(e.meeting_url) ? COLOUR_ZOOM : COLOUR_HQ;
      out.push({
        id: `hq-${e.id}`,
        title: e.title,
        start: e.start,
        end: e.end,
        allDay: !!e.all_day,
        extendedProps: { ...e, _kind: "hq" },
        backgroundColor: palette.bg,
        borderColor: palette.border,
        textColor: palette.text,
        // Force a solid filled chip in Month view (FullCalendar
        // defaults to a "list-item" dot for timed events otherwise,
        // which is what made Zoom meetings look like a one-pixel
        // splat next to "04:00 Mojo Matters Meeting").
        display: "block",
      });
    });
    yearlyEvents.forEach((e) => {
      if (!matchesSearch(e)) return;
      out.push({
        id: `yr-${e.id}`,
        title: e.title,
        start: e.date_iso,
        allDay: true,
        // Ensure listed-view rendering has a `start` it can parse —
        // yearly docs only carry `date_iso`. Mirror it as `start` so
        // `new Date(event.start)` doesn't return Invalid Date / NaN.
        extendedProps: { ...e, _kind: "yearly", start: e.date_iso, all_day: true },
        backgroundColor: COLOUR_YEARLY.bg,
        borderColor: COLOUR_YEARLY.border,
        textColor: COLOUR_YEARLY.text,
        display: "block",
      });
    });
    myEvents.forEach((e) => {
      if (!matchesSearch(e)) return;
      out.push({
        id: `my-${e.id}`,
        title: e.title,
        start: e.all_day ? dateOnly(e.start) : e.start,
        end: e.all_day ? dateOnly(e.end) : e.end,
        allDay: !!e.all_day,
        extendedProps: { ...e, _kind: "mine" },
        backgroundColor: COLOUR_MINE.bg,
        borderColor: COLOUR_MINE.border,
        textColor: COLOUR_MINE.text,
        display: "block",
      });
    });
    return out;
  }, [hqEvents, yearlyEvents, myEvents, matchesSearch]);

  // Helper: every event tied to a given YYYY-MM-DD, sorted by time.
  const eventsOnDay = useCallback((dayIso) => {
    if (!dayIso) return [];
    const day = dayIso.slice(0, 10);
    const list = [];
    (hqEvents || []).forEach((e) => {
      if (!matchesSearch(e)) return;
      if ((e.start || "").slice(0, 10) === day) list.push({ ...e, _kind: "hq" });
    });
    yearlyEvents.forEach((e) => {
      if (!matchesSearch(e)) return;
      if (e.date_iso === day) list.push({ ...e, _kind: "yearly", start: e.date_iso, all_day: true });
    });
    myEvents.forEach((e) => {
      if (!matchesSearch(e)) return;
      if ((e.start || "").slice(0, 10) === day) list.push({ ...e, _kind: "mine" });
    });
    return list.sort((a, b) => {
      const aa = a.all_day ? "0" : (a.start || "");
      const bb = b.all_day ? "0" : (b.start || "");
      return aa.localeCompare(bb);
    });
  }, [hqEvents, yearlyEvents, myEvents, matchesSearch]);

  // Listed view (legacy) — keep working but no longer the default.
  const listEvents = useMemo(() => {
    return [...fcEvents]
      .map((e) => e.extendedProps)
      .sort((a, b) => (a.start || "").localeCompare(b.start || ""));
  }, [fcEvents]);

  const openEditor = (existing = null) => {
    setEditorEvent(existing);
    setEditorOpen(true);
  };

  const deleteMyEvent = async (id) => {
    if (!window.confirm("Delete this entry from your calendar?")) return;
    try {
      await api.delete(`/portal/calendar/my-events/${id}`);
      setMyEvents((arr) => arr.filter((x) => x.id !== id));
    } catch (e) {
      alert(e?.response?.data?.detail || "Delete failed");
    }
  };

  // === Header (collapse toggle) is omitted when alwaysOpen ===
  const nextEvent = useMemo(() => {
    return listEvents.find((e) => {
      const start = new Date(e.start);
      return start.getTime() >= Date.now(); // eslint-disable-line
    });
  }, [listEvents]);

  return (
    <div
      className={`${isOpen || alwaysOpen ? "bg-white" : "bg-stone-100"} border border-stone-200 rounded-2xl overflow-hidden transition-colors`}
      data-testid="portal-events"
    >
      {!alwaysOpen && (
        <button
          onClick={onToggle}
          data-testid="toggle-events"
          className={`touch-target w-full flex items-center justify-between gap-3 ${open ? "hover:bg-stone-50" : "hover:bg-stone-200"} transition-colors px-4 sm:px-6 py-3.5 sm:py-4`}
        >
          <div className="flex items-center gap-2 min-w-0">
            <CalendarDays className="w-4 h-4 text-stone-700 shrink-0" />
            <span className="text-xs uppercase tracking-[0.3em] font-bold text-stone-700">
              Events
            </span>
            {!open && nextEvent && (
              <span className="hidden sm:inline text-xs text-stone-500 truncate ml-1">
                · Next: <strong className="text-stone-800">{nextEvent.title}</strong> · {ukDate(nextEvent.start)}{!nextEvent.all_day && ` at ${ukTime(nextEvent.start)}`}
              </span>
            )}
          </div>
          <span className={`w-7 h-7 rounded-full border flex items-center justify-center transition-colors ${open ? "border-stone-300 bg-white" : "border-stone-950 bg-stone-950 text-white"}`}>
            {open ? <ChevronUp className="w-3.5 h-3.5 text-stone-600" /> : <ChevronDown className="w-3.5 h-3.5" />}
          </span>
        </button>
      )}

      {isOpen && (
        <div className={`${alwaysOpen ? "px-4 sm:px-6 py-5 sm:py-6" : "px-4 sm:px-6 pb-5 sm:pb-6"} space-y-4`}>
          {/* Search panel — filters the calendar grid + list view AND
              feeds the results count line below. Matches event title /
              location / notes (case-insensitive substring). Sits at
              the very top of the body so the franchisee always knows
              what they're looking at. */}
          <div className="flex items-stretch gap-2" data-testid="portal-events-search">
            <div className="relative flex-1">
              <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-stone-400" />
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search events by name, location, or notes…"
                data-testid="portal-events-search-input"
                className="w-full pl-9 pr-9 py-2.5 border border-stone-300 rounded-xl text-sm focus:outline-none focus:border-stone-950 bg-white"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch("")}
                  data-testid="portal-events-search-clear"
                  title="Clear search"
                  className="absolute right-2 top-1/2 -translate-y-1/2 w-6 h-6 inline-flex items-center justify-center rounded-md hover:bg-stone-100 text-stone-500"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
            {search && (
              <div
                className="px-3 py-2 rounded-xl text-[11px] font-bold uppercase tracking-wider bg-stone-100 text-stone-700 flex items-center"
                data-testid="portal-events-search-count"
              >
                {fcEvents.length} match{fcEvents.length === 1 ? "" : "es"}
              </div>
            )}
          </div>

          {/* Toolbar */}
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2 flex-wrap">
              {/* View mode (Calendar vs List) */}
              <div className="inline-flex border border-stone-300 rounded-lg overflow-hidden bg-white" role="tablist">
                <button
                  onClick={() => setViewMode("calendar")}
                  data-testid="portal-events-view-calendar"
                  role="tab"
                  aria-selected={viewMode === "calendar"}
                  className={`px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider flex items-center gap-1.5 ${viewMode === "calendar" ? "bg-stone-950 text-white" : "text-stone-700 hover:bg-stone-50"}`}
                >
                  <LayoutGrid className="w-3 h-3" /> Calendar
                </button>
                <button
                  onClick={() => setViewMode("list")}
                  data-testid="portal-events-view-list"
                  role="tab"
                  aria-selected={viewMode === "list"}
                  className={`px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider flex items-center gap-1.5 border-l border-stone-300 ${viewMode === "list" ? "bg-stone-950 text-white" : "text-stone-700 hover:bg-stone-50"}`}
                >
                  <LayoutList className="w-3 h-3" /> List
                </button>
              </div>

              {/* Month / Week / Day sub-view — only relevant when in
                  calendar mode. Drives FullCalendar's view. */}
              {viewMode === "calendar" && (
                <div className="inline-flex border border-stone-300 rounded-lg overflow-hidden bg-white" data-testid="cal-subview-toggle">
                  {[
                    { v: "dayGridMonth", label: "Month" },
                    { v: "timeGridWeek", label: "Week" },
                    { v: "timeGridDay", label: "Day" },
                  ].map((it, i) => (
                    <button
                      key={it.v}
                      onClick={() => {
                        setCalView(it.v);
                        fcRef.current?.getApi?.().changeView(it.v);
                      }}
                      data-testid={`cal-subview-${it.v}`}
                      className={`px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider ${i > 0 ? "border-l border-stone-300" : ""} ${calView === it.v ? "bg-stone-950 text-white" : "text-stone-700 hover:bg-stone-50"}`}
                    >
                      {it.label}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              <button
                onClick={() => setProjectsModalOpen(true)}
                data-testid="open-projects-this-month"
                title="See the Standard Boxed Art Kits available this month"
                className="px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider bg-stone-950 hover:bg-stone-800 text-[#dedd0a] rounded-lg flex items-center gap-1.5"
              >
                <BookOpen className="w-3.5 h-3.5" /> View projects for this month
              </button>
              {isFranchisee && (
                <button
                  onClick={() => openEditor(null)}
                  data-testid="add-calendar-entry"
                  className="px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider bg-[#9333EA] text-white hover:bg-[#7E22CE] rounded-lg flex items-center gap-1.5"
                >
                  <Plus className="w-3.5 h-3.5" /> Add Calendar Entry
                </button>
              )}
              <button
                onClick={load}
                disabled={busy}
                data-testid="events-reload"
                title="Reload"
                className="px-2 py-1.5 border border-stone-300 hover:bg-stone-50 rounded-lg text-stone-600 disabled:opacity-50"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${busy ? "animate-spin" : ""}`} />
              </button>
            </div>
          </div>

          {/* Body */}
          {hqEvents === null ? (
            <div className="text-sm text-stone-500 inline-flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading…
            </div>
          ) : viewMode === "calendar" ? (
            <>
              <div className="border border-stone-200 rounded-xl overflow-hidden bg-white portal-cal-wrap" data-testid="portal-events-grid">
                <FullCalendar
                  ref={fcRef}
                  plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin]}
                  initialView={calView}
                  events={fcEvents}
                  // Taller grid so weeks aren't squashed — gives every
                  // day a comfortable ~110px box with room for 3 chips
                  // before "+N more". FullCalendar respects this for
                  // every sub-view (Month / Week / Day).
                  height={760}
                  firstDay={1}
                  dayMaxEventRows={3}
                  fixedWeekCount={false}
                  nowIndicator
                  headerToolbar={{ left: "prev,next today", center: "title", right: "" }}
                  buttonText={{ today: "Today", month: "Month", week: "Week", day: "Day" }}
                  eventTimeFormat={{ hour: "2-digit", minute: "2-digit", meridiem: false }}
                  slotLabelFormat={{ hour: "2-digit", minute: "2-digit", meridiem: false }}
                  // Custom chip layout — title on top, time underneath
                  // so the franchisee can read the full title even when
                  // the cell is narrow. Wrapping is enabled via the
                  // portal-cal-wrap CSS rules below.
                  eventContent={renderCalChip}
                  // Track external view changes (toolbar nav doesn't fire
                  // a direct button event for us; this keeps the local
                  // "calView" state in sync if FC ever switches views).
                  viewDidMount={(arg) => setCalView(arg.view.type)}
                  // datesSet fires whenever the visible date range
                  // changes (toolbar prev/next, today, sub-view swap)
                  // — perfect hook for "the month the user is looking
                  // at". The midpoint of the visible range is the
                  // safest choice across Month/Week/Day sub-views.
                  datesSet={(arg) => {
                    const mid = new Date((arg.start.getTime() + arg.end.getTime()) / 2);
                    setVisibleDate(mid);
                  }}
                  dateClick={(info) => {
                    setSelectedDay(info.dateStr.slice(0, 10));
                  }}
                  eventClick={(info) => {
                    info.jsEvent.preventDefault();
                    // Tap on an event always opens the day modal — the
                    // franchisee expands the entry there before any
                    // meeting / location link becomes clickable. Stops
                    // accidental "I tapped a Zoom card and got pulled
                    // into the meeting" mishaps.
                    setSelectedDay(info.event.startStr.slice(0, 10));
                  }}
                  moreLinkClick={(info) => {
                    setSelectedDay(info.date.toISOString().slice(0, 10));
                    return "popover"; // we still open ours; FC popover gets dismissed by setState re-render
                  }}
                />
              </div>
              <Legend />
            </>
          ) : listEvents.length === 0 ? (
            <div className="px-4 py-6 text-sm text-stone-500 bg-stone-50 border border-stone-200 rounded-xl text-center">
              {connected ? "No events to show yet." : "HQ hasn't linked a calendar yet. Events will appear here once it's set up."}
            </div>
          ) : (
            <>
              <ul className="divide-y divide-stone-100 border border-stone-200 rounded-xl overflow-hidden">
                {listEvents.map((ev) => (
                  <ListRow
                    key={`${ev._kind}-${ev.id}`}
                    event={ev}
                    onEdit={ev._kind === "mine" ? () => openEditor(ev) : undefined}
                    onDelete={ev._kind === "mine" ? () => deleteMyEvent(ev.id) : undefined}
                  />
                ))}
              </ul>
              <Legend />
            </>
          )}
        </div>
      )}

      {selectedDay && (
        <DayDetailModal
          dayIso={selectedDay}
          events={eventsOnDay(selectedDay)}
          onClose={() => setSelectedDay(null)}
          onAdd={isFranchisee ? () => { setSelectedDay(null); openEditor({ _prefillDate: selectedDay }); } : undefined}
          onEditMine={isFranchisee ? (ev) => { setSelectedDay(null); openEditor(ev); } : undefined}
          onDeleteMine={isFranchisee ? (id) => { deleteMyEvent(id); setSelectedDay(null); } : undefined}
        />
      )}

      {editorOpen && isFranchisee && (
        <MyEventModal
          event={editorEvent && !editorEvent._prefillDate ? editorEvent : null}
          prefillDate={editorEvent?._prefillDate}
          onClose={() => { setEditorOpen(false); setEditorEvent(null); }}
          onSaved={(doc, mode) => {
            setEditorOpen(false);
            setEditorEvent(null);
            if (mode === "create-series") {
              // Repeat occurrences were created server-side; refetch
              // the whole list so they all render.
              load();
              return;
            }
            setMyEvents((arr) => {
              if (mode === "create") return [...arr, doc];
              return arr.map((x) => (x.id === doc.id ? doc : x));
            });
          }}
        />
      )}

      {projectsModalOpen && (
        <ProjectsThisMonthModal
          visibleDate={visibleDate}
          onClose={() => setProjectsModalOpen(false)}
        />
      )}
    </div>
  );
}

function Legend() {
  return (
    <div className="flex items-center gap-4 flex-wrap pt-1 text-[11px] text-stone-700" data-testid="cal-legend">
      <LegendSwatch colour={COLOUR_YEARLY.bg} border={COLOUR_YEARLY.border} label="Yearly Events" />
      <LegendSwatch colour={COLOUR_HQ.bg} border={COLOUR_HQ.border} label="HQ Events" />
      <LegendSwatch colour={COLOUR_ZOOM.bg} border={COLOUR_ZOOM.border} label="Zoom Meeting" />
      <LegendSwatch colour={COLOUR_MINE.bg} border={COLOUR_MINE.border} label="My Entries" />
    </div>
  );
}

function LegendSwatch({ colour, border, label }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className="inline-block w-3.5 h-3.5 rounded-sm"
        style={{ background: colour, border: `1px solid ${border}` }}
      />
      {label}
    </span>
  );
}

function ListRow({ event, onEdit, onDelete }) {
  const startIso = event.start;
  // `new Date(yyyy-mm-dd)` is valid; `new Date(undefined)` is not.
  // Build the chip date defensively so the list never renders NaN.
  const startDate = startIso ? new Date(startIso) : null;
  const validStart = startDate && !Number.isNaN(startDate.getTime());
  const past = validStart && startDate.getTime() < Date.now() - 30 * 60 * 1000; // eslint-disable-line
  const isTeams = isTeamsUrl(event.meeting_url);
  const isZoom = isZoomUrl(event.meeting_url);
  const tagColour = event._kind === "yearly"
    ? COLOUR_YEARLY
    : event._kind === "mine"
      ? COLOUR_MINE
      : (isZoom ? COLOUR_ZOOM : COLOUR_HQ);
  return (
    <li
      className={`px-3 sm:px-4 py-3 flex items-start gap-3 flex-wrap sm:flex-nowrap ${past ? "bg-stone-50/60" : ""}`}
      data-testid={`portal-event-${event._kind}-${event.id}`}
    >
      <div className="shrink-0 w-14 sm:w-16 text-center pt-0.5">
        <div className="text-[10px] uppercase tracking-wider font-bold text-stone-500">
          {validStart ? startDate.toLocaleDateString(UK, { month: "short" }) : "—"}
        </div>
        <div className="text-2xl font-display tabular-nums text-stone-950">
          {validStart ? startDate.getDate() : "—"}
        </div>
      </div>
      <div className="flex-1 min-w-0">
        <div className="font-semibold text-stone-900 leading-tight flex items-center gap-2 flex-wrap">
          <span
            className="inline-block w-2.5 h-2.5 rounded-sm shrink-0"
            style={{ background: tagColour.bg, border: `1px solid ${tagColour.border}` }}
            aria-hidden
          />
          <span>{event.title}</span>
          {event._kind === "yearly" && (
            <span className="text-[9px] uppercase tracking-wider font-bold bg-blue-100 text-blue-800 px-1.5 py-0.5 rounded">Yearly</span>
          )}
          {event._kind === "mine" && (
            <span className="text-[9px] uppercase tracking-wider font-bold bg-purple-100 text-purple-800 px-1.5 py-0.5 rounded">Mine</span>
          )}
        </div>
        <div className="text-xs text-stone-500 mt-0.5 flex items-center gap-3 flex-wrap">
          <span className="inline-flex items-center gap-1">
            <Clock className="w-3 h-3" />
            {event.all_day ? "All day" : `${ukTime(event.start)}${event.end ? ` – ${ukTime(event.end)}` : ""}`}
          </span>
          {event.location && (
            <span className="inline-flex items-center gap-1 truncate">
              <MapPin className="w-3 h-3" /> {event.location}
            </span>
          )}
          {past && (
            <span className="text-[10px] uppercase tracking-wider font-bold text-stone-500">Past</span>
          )}
        </div>
        {event.description && !event.description.startsWith("Join: ") && (
          <div className="text-xs text-stone-600 mt-1.5 line-clamp-2 whitespace-pre-wrap">
            {event.description.split("\n\nJoin:")[0]}
          </div>
        )}
        {event.notes && (
          <div className="text-xs text-stone-600 mt-1.5 line-clamp-2 whitespace-pre-wrap">{event.notes}</div>
        )}
      </div>
      <div className="flex items-center gap-1.5 shrink-0 ml-auto">
        {event.meeting_url && (
          <a
            href={event.meeting_url}
            target="_blank"
            rel="noreferrer"
            data-testid={`portal-event-join-${event.id}`}
            className={`touch-target inline-flex items-center gap-1.5 px-3 text-[11px] font-bold uppercase tracking-wider rounded-lg transition ${
              isTeams ? "bg-blue-600 hover:bg-blue-700 text-white"
                : isZoom ? "bg-[#dddd16] hover:bg-[#c2c213] text-stone-950"
                : "bg-stone-950 hover:bg-stone-800 text-white"
            }`}
          >
            <Video className="w-3.5 h-3.5" /> Join <ExternalLink className="w-3 h-3 opacity-70" />
          </a>
        )}
        {onEdit && (
          <button onClick={onEdit} title="Edit" data-testid={`edit-mine-${event.id}`} className="w-7 h-7 rounded-md border border-stone-300 hover:bg-stone-100 flex items-center justify-center">
            <Pencil className="w-3.5 h-3.5 text-stone-700" />
          </button>
        )}
        {onDelete && (
          <button onClick={onDelete} title="Delete" data-testid={`delete-mine-${event.id}`} className="w-7 h-7 rounded-md border border-stone-300 hover:bg-rose-50 hover:border-rose-300 flex items-center justify-center">
            <Trash2 className="w-3.5 h-3.5 text-stone-700" />
          </button>
        )}
      </div>
    </li>
  );
}

function DayDetailModal({ dayIso, events, onClose, onAdd, onEditMine, onDeleteMine }) {
  const headerDate = (() => {
    try {
      return new Date(`${dayIso}T12:00:00`).toLocaleDateString(UK, {
        weekday: "long", day: "numeric", month: "long", year: "numeric",
      });
    } catch { return dayIso; }
  })();
  return (
    <div
      className="fixed inset-0 z-[80] bg-stone-950/70 backdrop-blur-sm flex items-end sm:items-center justify-center sm:p-6"
      onClick={onClose}
      data-testid="portal-day-modal"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-white sm:rounded-2xl shadow-2xl w-full max-w-xl max-h-[92vh] sm:max-h-[80vh] flex flex-col rounded-t-2xl sm:rounded-b-2xl"
      >
        <div className="px-5 py-4 border-b border-stone-200 flex items-center justify-between">
          <div>
            <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-500">Day view</div>
            <div className="text-lg font-display font-bold text-stone-950 mt-0.5">{headerDate}</div>
          </div>
          <button onClick={onClose} className="w-9 h-9 hover:bg-stone-100 rounded-md flex items-center justify-center">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
          {events.length === 0 ? (
            <div className="text-center py-8 text-stone-500 text-sm">No events on this day.</div>
          ) : (
            events.map((ev) => {
              const isZoom = isZoomUrl(ev.meeting_url);
              const isTeams = isTeamsUrl(ev.meeting_url);
              const swatch = ev._kind === "yearly"
                ? COLOUR_YEARLY
                : ev._kind === "mine"
                  ? COLOUR_MINE
                  : (isZoom ? COLOUR_ZOOM : COLOUR_HQ);
              return (
                <div key={`${ev._kind}-${ev.id}`} className="border border-stone-200 rounded-xl p-3 sm:p-4">
                  <div className="flex items-start gap-2.5">
                    <span
                      className="inline-block w-3 h-3 rounded-sm mt-1 shrink-0"
                      style={{ background: swatch.bg, border: `1px solid ${swatch.border}` }}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="font-semibold text-stone-950 leading-tight">{ev.title}</div>
                      <div className="text-xs text-stone-500 mt-1 flex items-center gap-2 flex-wrap">
                        <span className="inline-flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          {ev.all_day ? "All day" : `${ukTime(ev.start)}${ev.end ? ` – ${ukTime(ev.end)}` : ""}`}
                        </span>
                        {ev.location && (
                          <span className="inline-flex items-center gap-1">
                            <MapPin className="w-3 h-3" /> {ev.location}
                          </span>
                        )}
                        {ev._kind === "yearly" && (
                          <span className="text-[9px] uppercase tracking-wider font-bold bg-blue-100 text-blue-800 px-1.5 py-0.5 rounded">Yearly</span>
                        )}
                        {ev._kind === "mine" && (
                          <span className="text-[9px] uppercase tracking-wider font-bold bg-purple-100 text-purple-800 px-1.5 py-0.5 rounded">Mine</span>
                        )}
                      </div>
                      {(ev.description || ev.notes) && (
                        <p className="text-sm text-stone-700 mt-2 whitespace-pre-wrap">
                          {(ev.description || ev.notes || "").split("\n\nJoin:")[0]}
                        </p>
                      )}
                      <div className="mt-3 flex items-center gap-2 flex-wrap">
                        {ev.meeting_url && (
                          <a
                            href={ev.meeting_url}
                            target="_blank"
                            rel="noreferrer"
                            className={`touch-target inline-flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider rounded-lg ${
                              isTeams ? "bg-blue-600 hover:bg-blue-700 text-white"
                                : isZoom ? "bg-[#dddd16] hover:bg-[#c2c213] text-stone-950"
                                : "bg-stone-950 hover:bg-stone-800 text-white"
                            }`}
                          >
                            <Video className="w-3.5 h-3.5" /> Join {isZoom ? "Zoom" : isTeams ? "Teams" : "meeting"}
                          </a>
                        )}
                        {ev._kind === "mine" && onEditMine && (
                          <button
                            onClick={() => onEditMine(ev)}
                            className="px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider border border-stone-300 hover:bg-stone-50 rounded-lg flex items-center gap-1.5"
                          >
                            <Pencil className="w-3 h-3" /> Edit
                          </button>
                        )}
                        {ev._kind === "mine" && onDeleteMine && (
                          <button
                            onClick={() => onDeleteMine(ev.id)}
                            className="px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider border border-rose-200 text-rose-700 hover:bg-rose-50 rounded-lg flex items-center gap-1.5"
                          >
                            <Trash2 className="w-3 h-3" /> Delete
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
        {onAdd && (
          <div className="px-5 py-3 border-t border-stone-200 bg-stone-50 sm:rounded-b-2xl flex justify-between gap-2">
            <button onClick={onClose} className="px-3 py-2 text-xs font-bold rounded-lg border border-stone-300 bg-white hover:bg-stone-50">
              Close
            </button>
            <button
              onClick={onAdd}
              data-testid="day-modal-add-entry"
              className="px-4 py-2 text-xs font-bold uppercase tracking-wider bg-[#9333EA] text-white hover:bg-[#7E22CE] rounded-lg flex items-center gap-1.5"
            >
              <Plus className="w-3.5 h-3.5" /> Add entry on this day
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function MyEventModal({ event, prefillDate, onClose, onSaved }) {
  const initialStart = event?.start
    ? (event.all_day ? `${event.start.slice(0, 10)}T09:00` : event.start.slice(0, 16))
    : (prefillDate ? `${prefillDate}T09:00` : todayLocal());
  const initialEnd = event?.end
    ? (event.all_day ? `${event.end.slice(0, 10)}T10:00` : event.end.slice(0, 16))
    : (prefillDate ? `${prefillDate}T10:00` : todayLocal(60));
  const [title, setTitle] = useState(event?.title || "");
  const [allDay, setAllDay] = useState(!!event?.all_day);
  const [start, setStart] = useState(initialStart);
  const [end, setEnd] = useState(initialEnd);
  const [location, setLocation] = useState(event?.location || "");
  const [notes, setNotes] = useState(event?.notes || "");
  // Repeat intentionally removed from the portal — the booking module
  // will own recurrence. Keeping it here would create rows the booking
  // calendar can't manage.
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  const save = async () => {
    setErr("");
    if (!title.trim()) { setErr("Title is required."); return; }
    if (!start || !end) { setErr("Pick start and end."); return; }
    if (!allDay) {
      const s = new Date(start).getTime();
      const e = new Date(end).getTime();
      if (Number.isFinite(s) && Number.isFinite(e) && e <= s) {
        setErr("End must be after start.");
        return;
      }
    } else if (end < start) {
      setErr("End date must be on or after start date.");
      return;
    }
    setSaving(true);
    try {
      const body = {
        title: title.trim(),
        all_day: allDay,
        start: allDay ? start.slice(0, 10) : new Date(start).toISOString(),
        end: allDay ? end.slice(0, 10) : new Date(end).toISOString(),
        location: location || null,
        notes: notes || null,
      };
      // Repeat fields intentionally not sent — the portal no longer
      // exposes recurrence (booking module will).
      if (event?.id) {
        const { data } = await api.patch(`/portal/calendar/my-events/${event.id}`, body);
        onSaved(data, "edit");
      } else {
        const { data } = await api.post("/portal/calendar/my-events", body);
        onSaved(data, "create");
      }
    } catch (e) {
      setErr(e?.response?.data?.detail || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[80] bg-stone-950/70 backdrop-blur-sm flex items-end sm:items-center justify-center sm:p-6"
      onClick={onClose}
      data-testid="my-event-modal"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-white sm:rounded-2xl shadow-2xl w-full max-w-md rounded-t-2xl sm:rounded-b-2xl max-h-[92vh] flex flex-col"
      >
        <div className="px-5 py-4 border-b border-stone-200 flex items-center justify-between bg-[#9333EA] text-white rounded-t-2xl">
          <div className="flex items-center gap-2">
            <User className="w-4 h-4" />
            <span className="font-bold">{event ? "Edit my entry" : "Add calendar entry"}</span>
          </div>
          <button onClick={onClose} className="w-8 h-8 hover:bg-white/20 rounded-md flex items-center justify-center">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-5 space-y-3">
          <div>
            <label className="block text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 mb-1">Title</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Class · Visit · Personal reminder"
              data-testid="my-event-title"
              className="w-full px-3 py-2 text-sm border border-stone-300 rounded-lg"
            />
          </div>
          <label className="flex items-center gap-2 text-xs text-stone-700">
            <input
              type="checkbox"
              checked={allDay}
              onChange={(e) => setAllDay(e.target.checked)}
              data-testid="my-event-all-day"
              className="accent-purple-600"
            />
            All-day
          </label>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 mb-1">Starts</label>
              <input
                type={allDay ? "date" : "datetime-local"}
                value={allDay ? start.slice(0, 10) : start}
                onChange={(e) => setStart(e.target.value)}
                data-testid="my-event-start"
                className="w-full px-3 py-2 text-sm border border-stone-300 rounded-lg tabular-nums"
              />
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 mb-1">Ends</label>
              <input
                type={allDay ? "date" : "datetime-local"}
                value={allDay ? end.slice(0, 10) : end}
                onChange={(e) => setEnd(e.target.value)}
                data-testid="my-event-end"
                className="w-full px-3 py-2 text-sm border border-stone-300 rounded-lg tabular-nums"
              />
            </div>
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 mb-1">Location (optional)</label>
            <input
              type="text"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="Care home, postcode, online…"
              data-testid="my-event-location"
              className="w-full px-3 py-2 text-sm border border-stone-300 rounded-lg"
            />
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 mb-1">Notes (optional)</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              placeholder="What's planned, who's attending…"
              data-testid="my-event-notes"
              className="w-full px-3 py-2 text-sm border border-stone-300 rounded-lg"
            />
          </div>
          {err && (
            <div className="text-xs text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg flex items-center gap-1.5">
              <AlertCircle className="w-3.5 h-3.5" /> {err}
            </div>
          )}
          <div className="text-[11px] text-stone-500 italic flex items-start gap-1.5 leading-relaxed">
            <Sparkles className="w-3 h-3 mt-0.5 shrink-0" />
            Only you can see entries you add here. HQ events and yearly events come straight from Head Office.
          </div>
        </div>
        <div className="px-5 py-3 border-t border-stone-200 bg-stone-50 rounded-b-2xl flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-2 text-xs font-bold rounded-lg border border-stone-300 bg-white hover:bg-stone-50">Cancel</button>
          <button
            onClick={save}
            disabled={saving}
            data-testid="my-event-save"
            className="px-4 py-2 text-xs font-bold uppercase tracking-wider bg-[#9333EA] text-white hover:bg-[#7E22CE] rounded-lg disabled:opacity-50 flex items-center gap-1.5"
          >
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
            {event ? "Save" : "Add entry"}
          </button>
        </div>
      </div>
    </div>
  );
}
