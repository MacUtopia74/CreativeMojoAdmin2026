// Phase 5 — admin-only Google Calendar page.
//
// Drives the shared Creative Mojo calendar via the FastAPI proxy. Three
// states:
//   1. Backend not configured (env vars missing) → setup hints
//   2. Configured but disconnected → Connect button (opens Google's consent
//      screen; on return the page re-loads with ?connected=1 and we refresh)
//   3. Connected → list view + create/edit modal
//
// Events optionally carry a `meeting_url` (typically an MS Teams join link).
// We render it as a "Join meeting" button on each row.
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import api from "@/lib/api";
import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/daygrid";
import timeGridPlugin from "@fullcalendar/timegrid";
import interactionPlugin from "@fullcalendar/interaction";
import { CalendarDays, ExternalLink, Loader2, Plus, RefreshCw, Trash2, AlertCircle, CheckCircle2, X, Save, Link as LinkIcon, MapPin, Clock, Pencil, PowerOff, Video, LayoutGrid, LayoutList, Users, Sparkles, Search } from "lucide-react";
import YearlyEventsModal from "@/components/calendar/YearlyEventsModal";

function formatDateRange(start, end, allDay) {
  if (!start) return "";
  const s = new Date(start);
  const e = end ? new Date(end) : s;
  const sameDay = s.toDateString() === e.toDateString();
  const opts = allDay
    ? { weekday: "short", day: "2-digit", month: "short", year: "numeric" }
    : { weekday: "short", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" };
  if (allDay) return sameDay ? s.toLocaleDateString("en-GB", opts) : `${s.toLocaleDateString("en-GB", opts)} → ${e.toLocaleDateString("en-GB", opts)}`;
  if (sameDay) {
    const dayPart = s.toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short" });
    const timePart = `${s.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })} – ${e.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;
    return `${dayPart} · ${timePart}`;
  }
  return `${s.toLocaleString("en-GB", opts)} → ${e.toLocaleString("en-GB", opts)}`;
}

function todayLocal(offsetMinutes = 0) {
  const d = new Date(Date.now() + offsetMinutes * 60 * 1000);
  // datetime-local needs YYYY-MM-DDTHH:MM, no seconds, no zone
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function CalendarPage() {
  const [search, setSearch] = useSearchParams();
  const [status, setStatus] = useState(null);
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [err, setErr] = useState("");
  const [modal, setModal] = useState(null); // null | { event? }
  const [refreshTick, setRefreshTick] = useState(0);
  const [yearlyOpen, setYearlyOpen] = useState(false);
  // HQ-managed yearly events (CSV-uploaded). Rendered on the admin
  // grid alongside Google events in the same light-blue swatch the
  // franchisee portal uses so admins see exactly what franchisees see.
  const [yearlyEvents, setYearlyEvents] = useState([]);
  // Search query — filters which events render in the grid + list view.
  // Matches event title / location / description / summary
  // (case-insensitive substring) so admins can find any HQ training or
  // yearly fixture in seconds without scrolling 12 months of calendar.
  const [query, setQuery] = useState("");
  // View mode persists across visits so each admin lands back where they left.
  const [view, setView] = useState(() => {
    try { return localStorage.getItem("calendar.view") || "grid"; }
    catch { return "grid"; }
  });
  useEffect(() => { try { localStorage.setItem("calendar.view", view); } catch (_) { /* noop */ } }, [view]);
  const fcRef = useRef(null);

  const loadStatus = async () => {
    try {
      const { data } = await api.get("/calendar/status");
      setStatus(data);
      return data;
    } catch (e) {
      setErr(e?.response?.data?.detail || "Could not load calendar status");
      return null;
    }
  };

  const loadEvents = async (range = null) => {
    // First load = blocking spinner; subsequent navigations = silent refresh
    // so the FullCalendar grid doesn't disappear every time the admin clicks
    // prev / next.
    setEvents((prev) => prev); // no-op to keep dep tidy
    if (events.length === 0) setLoading(true);
    else setRefreshing(true);
    setErr("");
    try {
      const params = range
        ? { time_min: range.start.toISOString(), time_max: range.end.toISOString() }
        : { days_back: 365, days_ahead: 365 };
      const { data } = await api.get("/calendar/events", { params });
      setEvents(data.events || []);
    } catch (e) {
      const detail = e?.response?.data?.detail || "Could not load events";
      setEvents([]); setErr(detail);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    (async () => {
      const s = await loadStatus();
      if (s?.connected) await loadEvents();
      else setLoading(false);
      // Yearly events are admin-managed but live in Mongo, so we can
      // load them regardless of the Google connection state.
      try {
        const { data } = await api.get("/admin/calendar/yearly-events");
        setYearlyEvents(data.items || []);
      } catch { /* swallow — calendar still works without them */ }
    })();
  }, [refreshTick]);

  // After OAuth redirect: clear the ?connected=1 query param + refresh
  useEffect(() => {
    if (search.get("connected") === "1") {
      search.delete("connected");
      setSearch(search, { replace: true });
      setRefreshTick((t) => t + 1);
    }
    if (search.get("error")) {
      setErr(`Google OAuth failed: ${search.get("error")}`);
      search.delete("error");
      setSearch(search, { replace: true });
    }
  }, [search, setSearch]);

  const connect = async () => {
    try {
      const { data } = await api.get("/calendar/auth-url");
      window.location.href = data.url;
    } catch (e) { setErr(e?.response?.data?.detail || "Could not start OAuth"); }
  };

  const disconnect = async () => {
    if (!window.confirm("Disconnect Google Calendar? Existing events stay in Google; we just stop accessing them.")) return;
    await api.post("/calendar/disconnect");
    setRefreshTick((t) => t + 1);
  };

  const deleteEvent = async (id) => {
    if (!window.confirm("Delete this event from the calendar?")) return;
    try {
      await api.delete(`/calendar/events/${id}`);
      setEvents((es) => es.filter((e) => e.id !== id));
    } catch (e) { alert(e?.response?.data?.detail || "Delete failed"); }
  };

  // Search query needle — shared by `grouped` (list view) and
  // `fcEvents` (grid view). Declared once up here so both memos can
  // reference it without tripping over temporal-dead-zone.
  const queryNeedle = (query || "").trim().toLowerCase();
  const matchesQuery = (e) => {
    if (!queryNeedle) return true;
    const hay = [e.title, e.location, e.description, e.summary, e.notes]
      .filter(Boolean).join(" ").toLowerCase();
    return hay.includes(queryNeedle);
  };

  const grouped = useMemo(() => {
    // Bucket events by their day label. Two-tier sort: upcoming days
    // (today + future) come first in chronological order, then past
    // days afterwards in reverse-chronological (newest-first) order. This
    // means when Sandra opens the list, the next thing she has to do is
    // at the very top — not buried under last year's recurring meetings.
    //
    // Search-aware: when a query is active we narrow the input to
    // events that hit the substring so the listed view shrinks to
    // matches only, matching the grid behaviour.
    const buckets = new Map();
    const dayKeys = new Map(); // label → timestamp for sorting
    const visible = events.filter(matchesQuery);
    visible.forEach((e) => {
      if (!e.start) return;
      const d = new Date(e.start);
      const label = d.toLocaleDateString("en-GB", {
        weekday: "long", day: "2-digit", month: "long", year: "numeric",
      });
      // Day-only timestamp (midnight) for stable sorting regardless of
      // intra-day order.
      const dayTs = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
      if (!buckets.has(label)) {
        buckets.set(label, []);
        dayKeys.set(label, dayTs);
      }
      buckets.get(label).push(e);
    });
    // Within each day, sort events by start time ascending so 09:00 is
    // above 14:00.
    for (const list of buckets.values()) {
      list.sort((a, b) => new Date(a.start) - new Date(b.start));
    }
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const todayTs = today.getTime();
    const entries = [...buckets.entries()];
    entries.sort((a, b) => {
      const aTs = dayKeys.get(a[0]); const bTs = dayKeys.get(b[0]);
      const aFuture = aTs >= todayTs;
      const bFuture = bTs >= todayTs;
      if (aFuture !== bFuture) return aFuture ? -1 : 1;
      return aFuture ? aTs - bTs : bTs - aTs;
    });
    return entries;
  }, [events, queryNeedle]);

  // FullCalendar event shape — translates our normalised event list.
  // For all-day events Google returns YYYY-MM-DD which FC handles natively;
  // timed events come back as ISO 8601 with tz offset, also fine.
  //
  // Search-aware: when the admin types into the search box we filter
  // both Google events and yearly events by title / location /
  // description / summary substring so the grid + list view shrink
  // to just matches. The needle + match helper are declared once at
  // the top of the component body (see above) so this memo just
  // applies the filter.
  const fcEvents = useMemo(() => {
    const out = events.filter(matchesQuery).map((e) => ({
      id: e.id,
      title: e.title,
      start: e.start,
      end: e.end,
      allDay: !!e.all_day,
      extendedProps: { ...e, _kind: "hq" },
      // Brand-friendly colouring — translucent lime fill, dark green border
      backgroundColor: "rgba(212, 255, 0, 0.35)",
      borderColor: "#14532D",
      textColor: "#14532D",
    }));
    // Yearly events get the same light-blue solid block the franchisee
    // portal uses (so admins can verify visual parity at a glance).
    yearlyEvents.forEach((y) => {
      if (!matchesQuery(y)) return;
      out.push({
        id: `yr-${y.id}`,
        title: y.title,
        start: y.date_iso,
        allDay: true,
        extendedProps: { ...y, _kind: "yearly" },
        backgroundColor: "#3B82F6",
        borderColor: "#1D4ED8",
        textColor: "#FFFFFF",
        display: "block",
      });
    });
    return out;
  }, [events, yearlyEvents, queryNeedle]);

  return (
    <div className="px-8 py-7 max-w-7xl mx-auto" data-testid="calendar-page">
      <div className="flex items-center justify-between gap-3 mb-7 flex-wrap">
        <div>
          <h1 className="font-display text-4xl text-stone-950 flex items-center gap-3">
            <CalendarDays className="w-7 h-7" /> Calendar
          </h1>
          <p className="text-sm text-stone-600 mt-1">Live view of the shared Creative Mojo Google Calendar.</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {/* Yearly events manager is always available — they live in
              Mongo and are independent of the Google connection. */}
          <button onClick={() => setYearlyOpen(true)} data-testid="cal-yearly-events-btn"
            title="Manage the yearly events that appear on every franchisee portal calendar"
            className="px-3 py-2 text-xs font-bold uppercase tracking-wider border border-blue-300 bg-blue-50 text-blue-800 hover:bg-blue-100 rounded-lg flex items-center gap-1.5">
            <Sparkles className="w-3.5 h-3.5" /> Yearly events
          </button>
          {status?.connected && (
            <>
              <div className="flex items-center gap-2 px-3 py-2 bg-emerald-50 border border-emerald-200 rounded-lg text-xs text-emerald-900" data-testid="cal-connected-pill">
                <CheckCircle2 className="w-3.5 h-3.5" />
                <span className="font-mono text-[11px]">{status.calendar_id}</span>
                <button onClick={disconnect} title="Disconnect Google Calendar"
                  data-testid="cal-disconnect" className="ml-1 text-stone-500 hover:text-red-700">
                  <PowerOff className="w-3 h-3" />
                </button>
              </div>
              <div className="inline-flex border border-stone-300 rounded-lg overflow-hidden" data-testid="cal-view-toggle">
                <button onClick={() => setView("grid")} data-testid="cal-view-grid"
                  className={`px-3 py-2 text-xs font-bold uppercase tracking-wider flex items-center gap-1.5 ${view === "grid" ? "bg-stone-950 text-white" : "bg-white text-stone-700 hover:bg-stone-50"}`}>
                  <LayoutGrid className="w-3.5 h-3.5" /> Calendar
                </button>
                <button onClick={() => setView("list")} data-testid="cal-view-list"
                  className={`px-3 py-2 text-xs font-bold uppercase tracking-wider flex items-center gap-1.5 ${view === "list" ? "bg-stone-950 text-white" : "bg-white text-stone-700 hover:bg-stone-50"}`}>
                  <LayoutList className="w-3.5 h-3.5" /> List
                </button>
              </div>
              <button
                onClick={() => {
                  // Refresh the currently visible window (grid view) — pull
                  // exactly the month/week/day FullCalendar is showing so the
                  // user immediately sees fresh data for the dates in front
                  // of them, not just "around today".
                  const fcApi = fcRef.current?.getApi?.();
                  if (view === "grid" && fcApi) {
                    const v = fcApi.view;
                    const start = new Date(v.activeStart);
                    start.setDate(start.getDate() - 7);
                    const end = new Date(v.activeEnd);
                    end.setDate(end.getDate() + 7);
                    loadEvents({ start, end });
                  } else {
                    loadEvents();
                  }
                }}
                disabled={refreshing || loading}
                className="px-3 py-2 text-xs font-bold uppercase tracking-wider border border-stone-300 bg-white hover:bg-stone-50 rounded-lg flex items-center gap-1.5 disabled:opacity-60 disabled:cursor-not-allowed"
                data-testid="cal-refresh"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? "animate-spin" : ""}`} />
                {refreshing ? "Refreshing…" : "Refresh"}
              </button>
              <button onClick={() => setModal({ event: null })} data-testid="cal-new-event"
                className="px-3 py-2 text-xs font-bold uppercase tracking-wider bg-stone-950 text-white hover:bg-stone-800 rounded-lg flex items-center gap-1.5">
                <Plus className="w-3.5 h-3.5" /> New event
              </button>
            </>
          )}
        </div>
      </div>

      {/* Search panel — filters events on title, location, description
          across the grid + list views + the yearly-only fallback below.
          Sits below the page header so it's always visible regardless
          of Google connection state. */}
      {(status?.connected || yearlyEvents.length > 0) && (
        <div className="mb-5 flex items-stretch gap-2" data-testid="cal-search">
          <div className="relative flex-1 max-w-xl">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-stone-400" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search events by name, location, or description…"
              data-testid="cal-search-input"
              className="w-full pl-10 pr-10 py-2.5 border border-stone-300 rounded-xl text-sm focus:outline-none focus:border-stone-950 bg-white"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                data-testid="cal-search-clear"
                title="Clear search"
                className="absolute right-2 top-1/2 -translate-y-1/2 w-7 h-7 inline-flex items-center justify-center rounded-md hover:bg-stone-100 text-stone-500"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          {query && (
            <div
              className="px-3 py-2.5 rounded-xl text-[11px] font-bold uppercase tracking-wider bg-stone-100 text-stone-700 flex items-center"
              data-testid="cal-search-count"
            >
              {fcEvents.length} match{fcEvents.length === 1 ? "" : "es"}
            </div>
          )}
        </div>
      )}

      {/* Not configured (no env vars) */}
      {status && !status.configured && (
        <SetupPanel status={status} />
      )}

      {/* Configured but disconnected */}
      {status?.configured && !status.connected && (
        <>
          <div className="bg-white border border-stone-200 rounded-2xl p-8 text-center max-w-xl mx-auto" data-testid="cal-connect">
            <CalendarDays className="w-12 h-12 mx-auto text-stone-300" />
            <h2 className="font-display text-2xl text-stone-950 mt-3">Connect Google Calendar</h2>
            <p className="text-sm text-stone-600 mt-2">
              Click below to authorise this admin console to read and write events on{" "}
              <strong className="text-stone-900">{status.calendar_id || "your shared calendar"}</strong>. You'll be redirected to Google to grant access, then sent back here.
            </p>
            <button onClick={connect} data-testid="cal-connect-btn"
              className="mt-5 px-5 py-3 text-sm font-bold uppercase tracking-wider bg-[#dddd16] text-stone-950 hover:bg-[#aaaa11] rounded-lg inline-flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4" /> Connect Google Calendar
            </button>
            {err && <div className="mt-3 text-xs text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{err}</div>}
          </div>
          {/* Even when Google is disconnected we still surface the
              yearly events on a standalone grid so admins can preview
              what franchisees will see on their portal calendars. */}
          {yearlyEvents.length > 0 && (
            <div className="mt-8 bg-white border border-stone-200 rounded-2xl p-4" data-testid="cal-yearly-only-grid">
              <div className="flex items-center gap-2 mb-3 text-[11px] text-stone-600">
                <span className="w-3 h-3 rounded-sm" style={{ background: "#3B82F6" }} />
                <span>Yearly events ({yearlyEvents.length}) — visible to every franchisee on the portal</span>
              </div>
              <FullCalendar
                plugins={[dayGridPlugin, interactionPlugin]}
                initialView="dayGridMonth"
                headerToolbar={{ left: "prev,next today", center: "title", right: "dayGridMonth" }}
                events={fcEvents}
                height={680}
                contentHeight={680}
                firstDay={1}
                weekNumbers={false}
                dayMaxEventRows={4}
                buttonText={{ today: "Today", month: "Month" }}
                eventClick={(info) => { info.jsEvent.preventDefault(); setYearlyOpen(true); }}
              />
            </div>
          )}
        </>
      )}

      {/* Connected — events list */}
      {status?.connected && (
        <>
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-stone-500"><Loader2 className="w-4 h-4 animate-spin" /> Loading events…</div>
          ) : err ? (
            <div className="px-4 py-3 bg-red-50 border border-red-200 text-red-700 text-sm rounded-2xl flex items-center gap-2">
              <AlertCircle className="w-4 h-4" /> {err}
            </div>
          ) : view === "grid" ? (
            <div className="bg-white border border-stone-200 rounded-2xl p-4" data-testid="cal-grid">
              {/* Legend — mirrors the franchisee portal so admins see at
                  a glance which colours map to which event source. */}
              <div className="flex items-center gap-4 mb-3 text-[11px] text-stone-600 flex-wrap" data-testid="cal-legend">
                <span className="inline-flex items-center gap-1.5">
                  <span className="w-3 h-3 rounded-sm" style={{ background: "rgba(212, 255, 0, 0.6)", border: "1px solid #14532D" }} />
                  Google Calendar events
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="w-3 h-3 rounded-sm" style={{ background: "#3B82F6" }} />
                  Yearly events
                </span>
              </div>
              <FullCalendar
                ref={fcRef}
                plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin]}
                initialView="dayGridMonth"
                headerToolbar={{
                  left: "prev,next today",
                  center: "title",
                  right: "dayGridMonth,timeGridWeek,timeGridDay",
                }}
                events={fcEvents}
                height={780}
                contentHeight={780}
                firstDay={1}                 // Monday-first for UK
                weekNumbers={false}
                dayMaxEventRows={4}
                nowIndicator
                buttonText={{ today: "Today", month: "Month", week: "Week", day: "Day" }}
                eventTimeFormat={{ hour: "2-digit", minute: "2-digit", meridiem: false }}
                slotLabelFormat={{ hour: "2-digit", minute: "2-digit", meridiem: false }}
                eventClick={(info) => {
                  info.jsEvent.preventDefault();
                  // Yearly events are HQ-managed in their own modal —
                  // open it instead of the Google event editor.
                  if (info.event.extendedProps?._kind === "yearly") {
                    setYearlyOpen(true);
                    return;
                  }
                  // FullCalendar puts the id on the event itself, but our
                  // modal expects a flat object — merge them so the
                  // delete button can see event.id.
                  setModal({ event: { id: info.event.id, ...info.event.extendedProps } });
                }}
                datesSet={(info) => {
                  // Whenever the user clicks prev/next or switches view we
                  // refetch the visible window plus a 7-day buffer so events
                  // that start just before / after the boundary still show.
                  const start = new Date(info.start);
                  start.setDate(start.getDate() - 7);
                  const end = new Date(info.end);
                  end.setDate(end.getDate() + 7);
                  loadEvents({ start, end });
                }}
                dateClick={(info) => {
                  // Click a day cell → open new-event modal pre-filled to that
                  // date at 09:00–10:00 local
                  const d = new Date(info.dateStr);
                  const pad = (n) => String(n).padStart(2, "0");
                  const dateBase = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
                  setModal({ event: null, defaults: { start: `${dateBase}T09:00`, end: `${dateBase}T10:00` } });
                }}
              />
            </div>
          ) : events.length === 0 ? (
            <div className="bg-white border border-dashed border-stone-300 rounded-2xl px-6 py-12 text-center">
              <CalendarDays className="w-10 h-10 mx-auto text-stone-300" />
              <p className="text-sm text-stone-600 mt-3">No upcoming events. Click <strong>New event</strong> above to create one.</p>
            </div>
          ) : (
            <div className="space-y-6" data-testid="cal-events">
              {(() => {
                // Detect the index where past starts so we can drop a
                // visual divider between "upcoming" and "past" rows.
                const today = new Date(); today.setHours(0, 0, 0, 0);
                const todayLabel = today.toLocaleDateString("en-GB", { weekday: "long", day: "2-digit", month: "long", year: "numeric" });
                const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
                const tomorrowLabel = tomorrow.toLocaleDateString("en-GB", { weekday: "long", day: "2-digit", month: "long", year: "numeric" });
                let pastShown = false;
                return grouped.map(([dayLabel, list], idx) => {
                  const sample = list[0]?.start ? new Date(list[0].start) : null;
                  const isPast = sample && new Date(sample.getFullYear(), sample.getMonth(), sample.getDate()).getTime() < today.getTime();
                  const showPastDivider = isPast && !pastShown;
                  if (isPast) pastShown = true;
                  return (
                    <div key={dayLabel}>
                      {showPastDivider && (
                        <div className="mb-3 flex items-center gap-3" data-testid="cal-past-divider">
                          <div className="flex-1 h-px bg-stone-200"></div>
                          <span className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-500">Past events</span>
                          <div className="flex-1 h-px bg-stone-200"></div>
                        </div>
                      )}
                      <div className={`text-[11px] uppercase tracking-[0.25em] font-bold mb-2 flex items-center gap-2 ${
                        dayLabel === todayLabel ? "text-blue-700" :
                        dayLabel === tomorrowLabel ? "text-emerald-700" :
                        isPast ? "text-stone-400" : "text-stone-500"
                      }`}>
                        {dayLabel}
                        {dayLabel === todayLabel && <span className="px-1.5 py-0.5 text-[9px] bg-blue-100 text-blue-800 rounded">Today</span>}
                        {dayLabel === tomorrowLabel && <span className="px-1.5 py-0.5 text-[9px] bg-emerald-100 text-emerald-800 rounded">Tomorrow</span>}
                      </div>
                      <div className="bg-white border border-stone-200 rounded-2xl divide-y divide-stone-100 overflow-hidden">
                        {list.map((e) => (
                          <EventRow key={e.id} event={e} onEdit={() => setModal({ event: e })} onDelete={() => deleteEvent(e.id)} />
                        ))}
                      </div>
                    </div>
                  );
                });
              })()}
            </div>
          )}
        </>
      )}

      {modal && (
        <EventModal
          event={modal.event}
          defaults={modal.defaults}
          onClose={() => setModal(null)}
          onSaved={() => { setModal(null); setRefreshTick((t) => t + 1); }}
          onDelete={async (id) => { await deleteEvent(id); setModal(null); }}
        />
      )}
      {yearlyOpen && <YearlyEventsModal onClose={() => { setYearlyOpen(false); setRefreshTick((t) => t + 1); }} />}
    </div>
  );
}

function EventRow({ event, onEdit, onDelete }) {
  return (
    <div className="px-5 py-4 flex items-start justify-between gap-4 hover:bg-stone-50" data-testid={`cal-event-${event.id}`}>
      <div className="min-w-0 flex-1">
        <div className="text-base font-semibold text-stone-950 truncate flex items-center gap-2">
          <span className="truncate">{event.title}</span>
          {event.show_in_portal && (
            <span
              data-testid={`cal-portal-badge-${event.id}`}
              title="Visible on the franchisee portal"
              className="inline-flex items-center gap-1 text-[9px] uppercase tracking-wider font-bold bg-emerald-100 text-emerald-900 border border-emerald-300 px-1.5 py-0.5 rounded shrink-0"
            >
              <Users className="w-2.5 h-2.5" /> Portal
            </span>
          )}
        </div>
        <div className="text-xs text-stone-600 mt-0.5 flex items-center gap-1.5 flex-wrap">
          <Clock className="w-3 h-3" /> {formatDateRange(event.start, event.end, event.all_day)}
          {event.location && (<><span className="text-stone-300">·</span><MapPin className="w-3 h-3" /> <span className="truncate">{event.location}</span></>)}
        </div>
        {event.description && <div className="text-xs text-stone-600 mt-2 line-clamp-2 whitespace-pre-wrap">{event.description}</div>}
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        {event.meeting_url && (
          <a href={event.meeting_url} target="_blank" rel="noreferrer" data-testid={`cal-join-${event.id}`}
            className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider bg-stone-950 text-white hover:bg-stone-800 rounded-md inline-flex items-center gap-1.5">
            <Video className="w-3 h-3" /> Join
          </a>
        )}
        {event.html_link && (
          <a href={event.html_link} target="_blank" rel="noreferrer" title="Open in Google Calendar"
            className="w-7 h-7 rounded-md border border-stone-300 hover:bg-stone-100 flex items-center justify-center">
            <ExternalLink className="w-3.5 h-3.5 text-stone-700" />
          </a>
        )}
        <button onClick={onEdit} data-testid={`cal-edit-${event.id}`} className="w-7 h-7 rounded-md border border-stone-300 hover:bg-stone-100 flex items-center justify-center" title="Edit">
          <Pencil className="w-3.5 h-3.5 text-stone-700" />
        </button>
        <button onClick={onDelete} data-testid={`cal-delete-${event.id}`} className="w-7 h-7 rounded-md border border-stone-300 hover:bg-red-50 hover:border-red-300 flex items-center justify-center" title="Delete">
          <Trash2 className="w-3.5 h-3.5 text-stone-700" />
        </button>
      </div>
    </div>
  );
}

function EventModal({ event, defaults, onClose, onSaved, onDelete }) {
  const [title, setTitle] = useState(event?.title || "");
  const [description, setDescription] = useState(event?.description || "");
  const [location, setLocation] = useState(event?.location || "");
  const [meetingUrl, setMeetingUrl] = useState(event?.meeting_url || "");
  const [showInPortal, setShowInPortal] = useState(!!event?.show_in_portal);
  // Audience scope — "all" (default, visible to every franchisee) or
  // "selected" (only the franchisees in selectedFranchiseeIds see it).
  const initialIds = Array.isArray(event?.portal_franchisee_ids)
    ? event.portal_franchisee_ids : [];
  const [audienceMode, setAudienceMode] = useState(initialIds.length ? "selected" : "all");
  const [selectedFranchiseeIds, setSelectedFranchiseeIds] = useState(initialIds);
  const [franchiseesList, setFranchiseesList] = useState([]);
  const [franchiseesLoading, setFranchiseesLoading] = useState(false);
  const [franchiseeSearch, setFranchiseeSearch] = useState("");
  const [allDay, setAllDay] = useState(!!event?.all_day);
  const [start, setStart] = useState(event?.start ? event.start.slice(0, 16) : (defaults?.start || todayLocal()));
  const [end, setEnd] = useState(event?.end ? event.end.slice(0, 16) : (defaults?.end || todayLocal(60)));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const [zoomModalOpen, setZoomModalOpen] = useState(false);
  const [zoomNotice, setZoomNotice] = useState("");

  // Friendly end-time keeper — when the user edits the start, we slide
  // the end forward to maintain the same gap (or default to +60 mins),
  // matching what every other calendar app does.
  const setStartSmart = (newStart) => {
    if (!allDay && newStart && end) {
      const oldS = new Date(start).getTime();
      const oldE = new Date(end).getTime();
      const newS = new Date(newStart).getTime();
      if (Number.isFinite(oldS) && Number.isFinite(oldE) && Number.isFinite(newS)) {
        const gap = oldE > oldS ? oldE - oldS : 60 * 60 * 1000;
        const projected = new Date(newS + gap);
        // ISO local-style "YYYY-MM-DDTHH:mm" — strip timezone+seconds.
        const pad = (n) => String(n).padStart(2, "0");
        const iso = `${projected.getFullYear()}-${pad(projected.getMonth() + 1)}-${pad(projected.getDate())}T${pad(projected.getHours())}:${pad(projected.getMinutes())}`;
        setEnd(iso);
      }
    }
    setStart(newStart);
  };

  // Lazy-fetch the franchisee list the first time the admin switches
  // into the "selected franchisees only" mode. Cached for the modal's
  // lifetime so the picker is snappy.
  useEffect(() => {
    if (audienceMode !== "selected" || franchiseesList.length || franchiseesLoading) return;
    setFranchiseesLoading(true);
    api.get("/franchisees", { params: { limit: 500, sort_by: "organisation", sort_dir: 1 } })
      .then(({ data }) => {
        const rows = Array.isArray(data) ? data : (data?.items || []);
        // Keep this list compact — only id + display name + organisation.
        // Drop ex-franchisees so the picker only offers live audiences.
        const slim = rows
          .filter((f) => (f.lifecycle_status || "active") !== "ex_franchisee")
          .map((f) => ({
            id: f.id,
            name: f.full_name || [f.first_name, f.last_name].filter(Boolean).join(" ") || f.organisation || f.email || f.mojo_email || "—",
            organisation: f.organisation || "",
            franchise_number: f.franchise_number || "",
            email: f.mojo_email || f.email || "",
            // Flag demo franchisees so the picker can badge them — they're
            // popular test targets but easy to miss in a long A-Z list.
            is_demo: Array.isArray(f.tags) && f.tags.some((t) => String(t).toLowerCase() === "demo"),
          }));
        // Pin demo franchisees to the top of the list so they're always
        // one click away from the admin's eye-line.
        slim.sort((a, b) => {
          if (a.is_demo && !b.is_demo) return -1;
          if (b.is_demo && !a.is_demo) return 1;
          return (a.organisation || a.name || "").localeCompare(b.organisation || b.name || "");
        });
        setFranchiseesList(slim);
      })
      .catch(() => { /* fall through — picker will show "Couldn't load" hint */ })
      .finally(() => setFranchiseesLoading(false));
  }, [audienceMode, franchiseesList.length, franchiseesLoading]);

  const toggleFranchiseeId = (id) => {
    setSelectedFranchiseeIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  const save = async () => {
    setErr("");
    if (!title.trim()) { setErr("Title is required."); return; }
    if (!start || !end) { setErr("Pick start and end."); return; }
    // End must come after start — Google rejects an empty range with a
    // cryptic "time range is empty" error otherwise. Compare on raw
    // strings for all-day (yyyy-mm-dd) and timestamps for timed.
    if (allDay) {
      if (end < start) { setErr("End date must be on or after start date."); return; }
    } else {
      const s = new Date(start).getTime();
      const e = new Date(end).getTime();
      if (Number.isFinite(s) && Number.isFinite(e) && e <= s) {
        setErr("End time must be after the start time.");
        return;
      }
    }
    setSaving(true);
    try {
      // Audience scope — empty list when "show in portal" is off OR
      // when "all" is selected. The backend treats null/empty as "all
      // franchisees" (backwards-compatible with existing events).
      const portalIds = (showInPortal && audienceMode === "selected")
        ? selectedFranchiseeIds : [];
      const body = {
        title: title.trim(),
        description: description || null,
        location: location || null,
        meeting_url: meetingUrl ? meetingUrl.trim() : null,
        show_in_portal: showInPortal,
        portal_franchisee_ids: portalIds,
        all_day: allDay,
        start: allDay ? start.slice(0, 10) : new Date(start).toISOString(),
        end: allDay ? end.slice(0, 10) : new Date(end).toISOString(),
      };
      if (event?.id) await api.patch(`/calendar/events/${event.id}`, body);
      else await api.post("/calendar/events", body);
      onSaved?.();
    } catch (e) {
      // Surface the user-friendly translation for the most common
      // Google API gotcha instead of dumping the raw HttpError.
      const raw = e?.response?.data?.detail || "Save failed";
      if (typeof raw === "string" && /timeRangeEmpty|time range is empty/i.test(raw)) {
        setErr("End time must be after the start time.");
      } else {
        setErr(raw);
      }
    } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-[60] bg-stone-950/70 backdrop-blur-sm flex items-center justify-center p-6" onClick={onClose} data-testid="cal-event-modal">
      <div onClick={(e) => e.stopPropagation()} className="bg-white rounded-2xl shadow-2xl w-full max-w-xl">
        <div className="px-5 py-4 border-b border-stone-200 flex items-center justify-between">
          <span className="font-bold text-stone-950">{event ? "Edit event" : "New event"}</span>
          <button onClick={onClose} className="w-8 h-8 hover:bg-stone-100 rounded-md flex items-center justify-center"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-5 space-y-4">
          <Input label="Title" value={title} onChange={setTitle} placeholder="Quarterly franchisee call" testid="cal-title" />
          <Input label="Location (optional)" value={location} onChange={setLocation} placeholder="Online / 12 High St, Cullompton" testid="cal-location" />
          <label className="flex items-center gap-2 text-xs text-stone-700">
            <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} data-testid="cal-all-day" />
            All-day event
          </label>
          <div className="grid grid-cols-2 gap-3">
            <DateInput label="Starts" value={start} onChange={setStartSmart} allDay={allDay} testid="cal-start" />
            <DateInput label="Ends" value={end} onChange={setEnd} allDay={allDay} testid="cal-end" />
          </div>
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="block text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">Meeting link (optional)</label>
              <button
                type="button"
                onClick={() => setZoomModalOpen(true)}
                data-testid="cal-create-zoom-btn"
                className="text-[10px] uppercase tracking-[0.15em] font-bold px-2.5 py-1 rounded-md bg-[#2D8CFF] text-white hover:bg-[#1A73D9] transition-colors flex items-center gap-1.5"
                title="Create a Zoom meeting on headoffice@creativemojo.co.uk"
              >
                <Video className="w-3 h-3" />
                {meetingUrl ? "Replace with Zoom" : "Create Zoom meeting"}
              </button>
            </div>
            <div className="relative">
              <LinkIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-stone-400" />
              <input
                value={meetingUrl}
                onChange={(e) => setMeetingUrl(e.target.value)}
                placeholder="Paste a Teams / Zoom / Meet link, or click 'Create Zoom meeting' →"
                data-testid="cal-meeting-url"
                className="w-full pl-9 pr-3 py-2 text-sm border border-stone-300 rounded-lg"
              />
            </div>
            {zoomNotice && (
              <div className="mt-1.5 text-[11px] text-emerald-700 bg-emerald-50 border border-emerald-200 px-2.5 py-1.5 rounded-md flex items-center gap-1.5" data-testid="cal-zoom-notice">
                <CheckCircle2 className="w-3 h-3" /> {zoomNotice}
              </div>
            )}
          </div>
          {/* Franchisee-portal toggle — events default to admin-only.
              Tick this to also surface the event on the franchisee
              portal's Events panel (shared join URL, time, description). */}
          <label className={`flex items-start gap-3 p-3 border-2 rounded-xl cursor-pointer transition ${showInPortal ? "border-emerald-400 bg-emerald-50/60" : "border-stone-200 hover:border-stone-300 bg-white"}`}
            data-testid="cal-portal-toggle-label">
            <input
              type="checkbox"
              checked={showInPortal}
              onChange={(e) => setShowInPortal(e.target.checked)}
              data-testid="cal-portal-toggle"
              className="mt-0.5 accent-emerald-600"
            />
            <div className="flex-1">
              <div className="text-sm font-bold text-stone-950">
                Also include in Franchisee Portal Calendar
              </div>
              <div className="text-[11px] text-stone-600 mt-0.5">
                {showInPortal
                  ? "This event will appear in the franchisee portal — see the audience options below."
                  : "Admin-only — won't appear on the franchisee portal."}
              </div>
            </div>
          </label>

          {/* Audience scope — only shown once "show in portal" is on. */}
          {showInPortal && (
            <div className="ml-3 pl-4 border-l-2 border-emerald-200 space-y-3" data-testid="cal-portal-audience">
              <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">Who can see this on the portal?</div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <label className={`flex items-start gap-2.5 p-3 border rounded-lg cursor-pointer transition text-sm ${audienceMode === "all" ? "border-stone-950 bg-stone-50 ring-1 ring-stone-950" : "border-stone-200 hover:border-stone-300 bg-white"}`}>
                  <input
                    type="radio"
                    name="cal-audience"
                    checked={audienceMode === "all"}
                    onChange={() => setAudienceMode("all")}
                    data-testid="cal-audience-all"
                    className="mt-0.5 accent-stone-950"
                  />
                  <div>
                    <div className="font-bold text-stone-950">All franchisees</div>
                    <div className="text-[11px] text-stone-600 mt-0.5">Default. Visible to every franchisee with portal access.</div>
                  </div>
                </label>
                <label className={`flex items-start gap-2.5 p-3 border rounded-lg cursor-pointer transition text-sm ${audienceMode === "selected" ? "border-stone-950 bg-stone-50 ring-1 ring-stone-950" : "border-stone-200 hover:border-stone-300 bg-white"}`}>
                  <input
                    type="radio"
                    name="cal-audience"
                    checked={audienceMode === "selected"}
                    onChange={() => setAudienceMode("selected")}
                    data-testid="cal-audience-selected"
                    className="mt-0.5 accent-stone-950"
                  />
                  <div>
                    <div className="font-bold text-stone-950">Selected franchisees only</div>
                    <div className="text-[11px] text-stone-600 mt-0.5">Tick the franchisees who should see this event.</div>
                  </div>
                </label>
              </div>

              {audienceMode === "selected" && (
                <div className="bg-white border border-stone-200 rounded-lg" data-testid="cal-franchisee-picker">
                  <div className="px-3 py-2 border-b border-stone-100 flex items-center justify-between gap-2">
                    <div className="text-[11px] font-bold text-stone-700">
                      {selectedFranchiseeIds.length === 0
                        ? "No franchisees selected yet"
                        : `${selectedFranchiseeIds.length} selected`}
                    </div>
                    {selectedFranchiseeIds.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setSelectedFranchiseeIds([])}
                        className="text-[11px] text-stone-500 hover:text-stone-900 underline"
                        data-testid="cal-franchisee-clear"
                      >
                        Clear all
                      </button>
                    )}
                  </div>
                  {/* Search bar — filters by organisation, name, franchise number, or email. */}
                  {franchiseesList.length > 0 && (
                    <div className="px-3 py-2 border-b border-stone-100">
                      <input
                        type="search"
                        value={franchiseeSearch}
                        onChange={(e) => setFranchiseeSearch(e.target.value)}
                        placeholder="Search by organisation, name, #, or email…"
                        data-testid="cal-franchisee-search"
                        className="w-full px-2.5 py-1.5 text-xs border border-stone-300 rounded focus:outline-none focus:border-stone-950"
                      />
                    </div>
                  )}
                  {franchiseesLoading ? (
                    <div className="px-3 py-6 text-center text-stone-500 text-xs"><Loader2 className="w-4 h-4 animate-spin inline" /> Loading franchisees…</div>
                  ) : franchiseesList.length === 0 ? (
                    <div className="px-3 py-6 text-center text-stone-500 text-xs">Couldn't load franchisees. Save anyway — defaults to all.</div>
                  ) : (() => {
                    const q = franchiseeSearch.trim().toLowerCase();
                    const filtered = q ? franchiseesList.filter((f) =>
                      (f.organisation || "").toLowerCase().includes(q)
                      || (f.name || "").toLowerCase().includes(q)
                      || (f.franchise_number || "").toLowerCase().includes(q)
                      || (f.email || "").toLowerCase().includes(q)
                    ) : franchiseesList;
                    if (filtered.length === 0) {
                      return <div className="px-3 py-6 text-center text-stone-500 text-xs">No franchisees match "{franchiseeSearch}".</div>;
                    }
                    return (
                      <div className="max-h-56 overflow-y-auto divide-y divide-stone-100">
                        {filtered.map((f) => {
                          const checked = selectedFranchiseeIds.includes(f.id);
                          return (
                            <label
                              key={f.id}
                              className={`flex items-center gap-2.5 px-3 py-2 cursor-pointer text-sm hover:bg-stone-50 ${checked ? "bg-emerald-50/60" : ""}`}
                              data-testid={`cal-franchisee-opt-${f.id}`}
                            >
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => toggleFranchiseeId(f.id)}
                                className="accent-emerald-600"
                              />
                              <div className="flex-1 min-w-0">
                                <div className="text-stone-950 font-medium truncate flex items-center gap-1.5">
                                  <span className="truncate">{f.organisation || f.name}</span>
                                  {f.is_demo && (
                                    <span className="shrink-0 text-[9px] font-black uppercase tracking-widest px-1.5 py-0.5 rounded bg-[#dedd0a] text-stone-950">Demo</span>
                                  )}
                                </div>
                                <div className="text-[11px] text-stone-500 truncate">
                                  {f.franchise_number ? `#${f.franchise_number}` : ""}
                                  {f.franchise_number && f.organisation ? " · " : ""}
                                  {f.organisation ? f.name : ""}
                                </div>
                              </div>
                            </label>
                          );
                        })}
                      </div>
                    );
                  })()}
                </div>
              )}
            </div>
          )}
          <div>
            <label className="block text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 mb-1">Description (optional)</label>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} data-testid="cal-description"
              placeholder="Agenda, attendee notes, links…"
              className="w-full px-3 py-2 text-sm border border-stone-300 rounded-lg" />
          </div>
          {err && <div className="text-xs text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg flex items-center gap-1.5"><AlertCircle className="w-3.5 h-3.5" /> {err}</div>}
        </div>
        <div className="px-5 py-4 border-t border-stone-200 flex justify-between items-center gap-2 bg-stone-50">
          {event?.id && onDelete ? (
            <button
              onClick={() => {
                if (window.confirm("Delete this calendar event? It will also disappear from the franchisee portal.")) {
                  onDelete(event.id);
                }
              }}
              data-testid="cal-modal-delete"
              className="px-3 py-2 text-xs font-bold uppercase tracking-wider rounded-lg border border-rose-300 bg-white text-rose-700 hover:bg-rose-50 flex items-center gap-1.5"
            >
              <Trash2 className="w-3.5 h-3.5" /> Delete
            </button>
          ) : <span />}
          <div className="flex gap-2">
            <button onClick={onClose} className="px-3 py-2 text-xs font-bold rounded-lg border border-stone-300 bg-white hover:bg-stone-50">Cancel</button>
            <button onClick={save} disabled={saving || !title.trim()} data-testid="cal-save"
              className="px-4 py-2 text-xs font-bold uppercase tracking-wider bg-[#dddd16] text-stone-950 hover:bg-[#aaaa11] rounded-lg disabled:opacity-50 flex items-center gap-1.5">
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
              {event ? "Save changes" : "Create event"}
            </button>
          </div>
        </div>
      </div>
      {zoomModalOpen && (
        <ZoomMeetingModal
          defaultTopic={title}
          defaultStart={start}
          defaultEnd={end}
          allDay={allDay}
          onClose={() => setZoomModalOpen(false)}
          onCreated={({ join_url, password, topic }) => {
            setMeetingUrl(join_url);
            if (!title.trim() && topic) setTitle(topic);
            setZoomNotice(password ? `Zoom meeting created — passcode ${password}` : "Zoom meeting created");
            setZoomModalOpen(false);
          }}
        />
      )}
    </div>
  );
}

function ZoomMeetingModal({ defaultTopic, defaultStart, defaultEnd, allDay, onClose, onCreated }) {
  // Compute a sensible default duration in minutes from start→end.
  const defaultDuration = (() => {
    if (allDay) return 60;
    const s = new Date(defaultStart).getTime();
    const e = new Date(defaultEnd).getTime();
    if (Number.isFinite(s) && Number.isFinite(e) && e > s) {
      return Math.max(5, Math.min(1440, Math.round((e - s) / 60000)));
    }
    return 60;
  })();

  const [duration, setDuration] = useState(defaultDuration);
  const [requirePasscode, setRequirePasscode] = useState(true);
  const [waitingRoom, setWaitingRoom] = useState(false);
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState("");

  const create = async () => {
    setErr("");
    if (allDay) {
      setErr("Zoom needs a specific start time — switch off 'All-day' first.");
      return;
    }
    if (!requirePasscode && !waitingRoom) {
      setErr("Zoom requires either a passcode OR a waiting room. Tick at least one.");
      return;
    }
    setCreating(true);
    try {
      const startIso = new Date(defaultStart).toISOString();
      const { data } = await api.post("/zoom/meetings", {
        topic: (defaultTopic && defaultTopic.trim()) || "Creative Mojo meeting",
        start_time: startIso,
        duration,
        timezone: "Europe/London",
        require_passcode: requirePasscode,
        enable_waiting_room: waitingRoom,
        agenda: defaultTopic || null,
      });
      onCreated(data);
    } catch (e) {
      setErr(e?.response?.data?.detail || "Zoom meeting creation failed.");
    } finally {
      setCreating(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[70] bg-stone-950/70 backdrop-blur-sm flex items-center justify-center p-6"
      onClick={onClose}
      data-testid="zoom-create-modal"
    >
      <div onClick={(e) => e.stopPropagation()} className="bg-white rounded-2xl shadow-2xl w-full max-w-md">
        <div className="px-5 py-4 border-b border-stone-200 flex items-center justify-between bg-[#2D8CFF] text-white rounded-t-2xl">
          <div className="flex items-center gap-2">
            <Video className="w-4 h-4" />
            <span className="font-bold">Create Zoom meeting</span>
          </div>
          <button onClick={onClose} className="w-8 h-8 hover:bg-white/20 rounded-md flex items-center justify-center">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-5 space-y-4">
          <div className="text-[11px] text-stone-600 bg-stone-50 border border-stone-200 rounded-lg px-3 py-2 leading-relaxed">
            Hosted on <strong>headoffice@creativemojo.co.uk</strong>. The join URL will auto-fill the meeting-link field. Daily Zoom limit: 100 meetings.
          </div>

          <div>
            <label className="block text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 mb-1">Duration (minutes)</label>
            <input
              type="number"
              min={5}
              max={1440}
              value={duration}
              onChange={(e) => setDuration(Number(e.target.value) || 0)}
              data-testid="zoom-duration"
              className="w-full px-3 py-2 text-sm border border-stone-300 rounded-lg tabular-nums"
            />
          </div>

          <label className={`flex items-start gap-3 p-3 border-2 rounded-xl cursor-pointer transition ${requirePasscode ? "border-blue-400 bg-blue-50/60" : "border-stone-200 hover:border-stone-300 bg-white"}`}>
            <input
              type="checkbox"
              checked={requirePasscode}
              onChange={(e) => setRequirePasscode(e.target.checked)}
              data-testid="zoom-passcode"
              className="mt-0.5 accent-blue-600"
            />
            <div className="flex-1">
              <div className="text-sm font-bold text-stone-950">Require passcode</div>
              <div className="text-[11px] text-stone-600 mt-0.5">
                Zoom auto-generates a 6-digit passcode and embeds it in the join link.
              </div>
            </div>
          </label>

          <label className={`flex items-start gap-3 p-3 border-2 rounded-xl cursor-pointer transition ${waitingRoom ? "border-blue-400 bg-blue-50/60" : "border-stone-200 hover:border-stone-300 bg-white"}`}>
            <input
              type="checkbox"
              checked={waitingRoom}
              onChange={(e) => setWaitingRoom(e.target.checked)}
              data-testid="zoom-waiting-room"
              className="mt-0.5 accent-blue-600"
            />
            <div className="flex-1">
              <div className="text-sm font-bold text-stone-950">Enable waiting room</div>
              <div className="text-[11px] text-stone-600 mt-0.5">
                Attendees see a holding screen until the host admits them.
              </div>
            </div>
          </label>

          {err && (
            <div className="text-xs text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg flex items-center gap-1.5">
              <AlertCircle className="w-3.5 h-3.5" /> {err}
            </div>
          )}
        </div>
        <div className="px-5 py-4 border-t border-stone-200 flex justify-end gap-2 bg-stone-50 rounded-b-2xl">
          <button onClick={onClose} className="px-3 py-2 text-xs font-bold rounded-lg border border-stone-300 bg-white hover:bg-stone-50">
            Cancel
          </button>
          <button
            onClick={create}
            disabled={creating}
            data-testid="zoom-create-confirm"
            className="px-4 py-2 text-xs font-bold uppercase tracking-wider bg-[#2D8CFF] text-white hover:bg-[#1A73D9] rounded-lg disabled:opacity-50 flex items-center gap-1.5"
          >
            {creating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
            {creating ? "Creating…" : "Create meeting"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Input({ label, value, onChange, placeholder, testid, icon: Icon }) {
  return (
    <div>
      <label className="block text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 mb-1">{label}</label>
      <div className="relative">
        {Icon && <Icon className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-stone-400" />}
        <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} data-testid={testid}
          className={`w-full ${Icon ? "pl-9" : "pl-3"} pr-3 py-2 text-sm border border-stone-300 rounded-lg`} />
      </div>
    </div>
  );
}

function DateInput({ label, value, onChange, allDay, testid }) {
  return (
    <div>
      <label className="block text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 mb-1">{label}</label>
      <input type={allDay ? "date" : "datetime-local"} value={allDay ? value.slice(0, 10) : value} onChange={(e) => onChange(e.target.value)}
        data-testid={testid}
        className="w-full px-3 py-2 text-sm border border-stone-300 rounded-lg tabular-nums" />
    </div>
  );
}

function SetupPanel({ status }) {
  return (
    <div className="bg-white border border-amber-300 bg-amber-50/60 rounded-2xl p-6" data-testid="cal-setup-required">
      <div className="flex items-start gap-3">
        <AlertCircle className="w-5 h-5 text-amber-700 mt-0.5 shrink-0" />
        <div className="text-sm text-stone-800 space-y-3 leading-relaxed">
          <div className="font-bold text-stone-950">Google Calendar not configured yet</div>
          <ol className="list-decimal pl-5 space-y-2 text-stone-700">
            <li>Open <a className="underline text-stone-950" href="https://console.cloud.google.com" target="_blank" rel="noreferrer">Google Cloud Console</a> → create or pick a project.</li>
            <li>APIs & Services → Library → enable <strong>Google Calendar API</strong>.</li>
            <li>OAuth consent screen → External → add your email as a test user. Add scope <code className="bg-stone-100 px-1 rounded">https://www.googleapis.com/auth/calendar</code>.</li>
            <li>Credentials → Create credentials → OAuth client ID → <strong>Web application</strong>. Add this redirect URI exactly: <br/><code className="bg-stone-100 px-1 rounded text-[11px]">{status?.redirect_uri}</code></li>
            <li>Copy the <strong>Client ID</strong> and <strong>Client secret</strong> + your calendar's ID (Settings → Integrate calendar) and send them over. I'll drop them into <code className="bg-stone-100 px-1 rounded">backend/.env</code> as <code>GOOGLE_CLIENT_ID</code>, <code>GOOGLE_CLIENT_SECRET</code>, <code>GOOGLE_CALENDAR_ID</code>.</li>
          </ol>
        </div>
      </div>
    </div>
  );
}
