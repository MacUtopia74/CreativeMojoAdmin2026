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
import { CalendarDays, ExternalLink, Loader2, Plus, RefreshCw, Trash2, AlertCircle, CheckCircle2, X, Save, Link as LinkIcon, MapPin, Clock, Pencil, PowerOff, Video, LayoutGrid, LayoutList } from "lucide-react";

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
  const [err, setErr] = useState("");
  const [modal, setModal] = useState(null); // null | { event? }
  const [refreshTick, setRefreshTick] = useState(0);
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

  const loadEvents = async () => {
    setLoading(true); setErr("");
    try {
      const { data } = await api.get("/calendar/events");
      setEvents(data.events || []);
    } catch (e) {
      const detail = e?.response?.data?.detail || "Could not load events";
      // 401 = not connected; surface gently
      setEvents([]); setErr(detail);
    } finally { setLoading(false); }
  };

  useEffect(() => {
    (async () => {
      const s = await loadStatus();
      if (s?.connected) await loadEvents();
      else setLoading(false);
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

  const grouped = useMemo(() => {
    const buckets = new Map();
    events.forEach((e) => {
      const d = e.start ? new Date(e.start).toLocaleDateString("en-GB", { weekday: "long", day: "2-digit", month: "long", year: "numeric" }) : "—";
      if (!buckets.has(d)) buckets.set(d, []);
      buckets.get(d).push(e);
    });
    return [...buckets.entries()];
  }, [events]);

  // FullCalendar event shape — translates our normalised event list.
  // For all-day events Google returns YYYY-MM-DD which FC handles natively;
  // timed events come back as ISO 8601 with tz offset, also fine.
  const fcEvents = useMemo(() => events.map((e) => ({
    id: e.id,
    title: e.title,
    start: e.start,
    end: e.end,
    allDay: !!e.all_day,
    extendedProps: e,
    // Brand-friendly colouring — translucent lime fill, dark green border
    backgroundColor: "rgba(212, 255, 0, 0.35)",
    borderColor: "#14532D",
    textColor: "#14532D",
  })), [events]);

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
              <button onClick={() => setRefreshTick((t) => t + 1)} className="px-3 py-2 text-xs font-bold uppercase tracking-wider border border-stone-300 bg-white hover:bg-stone-50 rounded-lg flex items-center gap-1.5" data-testid="cal-refresh">
                <RefreshCw className="w-3.5 h-3.5" /> Refresh
              </button>
              <button onClick={() => setModal({ event: null })} data-testid="cal-new-event"
                className="px-3 py-2 text-xs font-bold uppercase tracking-wider bg-stone-950 text-white hover:bg-stone-800 rounded-lg flex items-center gap-1.5">
                <Plus className="w-3.5 h-3.5" /> New event
              </button>
            </>
          )}
        </div>
      </div>

      {/* Not configured (no env vars) */}
      {status && !status.configured && (
        <SetupPanel status={status} />
      )}

      {/* Configured but disconnected */}
      {status?.configured && !status.connected && (
        <div className="bg-white border border-stone-200 rounded-2xl p-8 text-center max-w-xl mx-auto" data-testid="cal-connect">
          <CalendarDays className="w-12 h-12 mx-auto text-stone-300" />
          <h2 className="font-display text-2xl text-stone-950 mt-3">Connect Google Calendar</h2>
          <p className="text-sm text-stone-600 mt-2">
            Click below to authorise this admin console to read and write events on{" "}
            <strong className="text-stone-900">{status.calendar_id || "your shared calendar"}</strong>. You'll be redirected to Google to grant access, then sent back here.
          </p>
          <button onClick={connect} data-testid="cal-connect-btn"
            className="mt-5 px-5 py-3 text-sm font-bold uppercase tracking-wider bg-[#D4FF00] text-stone-950 hover:bg-[#BDE600] rounded-lg inline-flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4" /> Connect Google Calendar
          </button>
          {err && <div className="mt-3 text-xs text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{err}</div>}
        </div>
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
                  setModal({ event: info.event.extendedProps });
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
              {grouped.map(([dayLabel, list]) => (
                <div key={dayLabel}>
                  <div className="text-[11px] uppercase tracking-[0.25em] font-bold text-stone-500 mb-2">{dayLabel}</div>
                  <div className="bg-white border border-stone-200 rounded-2xl divide-y divide-stone-100 overflow-hidden">
                    {list.map((e) => (
                      <EventRow key={e.id} event={e} onEdit={() => setModal({ event: e })} onDelete={() => deleteEvent(e.id)} />
                    ))}
                  </div>
                </div>
              ))}
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
        />
      )}
    </div>
  );
}

function EventRow({ event, onEdit, onDelete }) {
  return (
    <div className="px-5 py-4 flex items-start justify-between gap-4 hover:bg-stone-50" data-testid={`cal-event-${event.id}`}>
      <div className="min-w-0 flex-1">
        <div className="text-base font-semibold text-stone-950 truncate">{event.title}</div>
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

function EventModal({ event, defaults, onClose, onSaved }) {
  const [title, setTitle] = useState(event?.title || "");
  const [description, setDescription] = useState(event?.description || "");
  const [location, setLocation] = useState(event?.location || "");
  const [meetingUrl, setMeetingUrl] = useState(event?.meeting_url || "");
  const [allDay, setAllDay] = useState(!!event?.all_day);
  const [start, setStart] = useState(event?.start ? event.start.slice(0, 16) : (defaults?.start || todayLocal()));
  const [end, setEnd] = useState(event?.end ? event.end.slice(0, 16) : (defaults?.end || todayLocal(60)));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  const save = async () => {
    setErr("");
    if (!title.trim()) { setErr("Title is required."); return; }
    if (!start || !end) { setErr("Pick start and end."); return; }
    setSaving(true);
    try {
      const body = {
        title: title.trim(),
        description: description || null,
        location: location || null,
        meeting_url: meetingUrl ? meetingUrl.trim() : null,
        all_day: allDay,
        start: allDay ? start.slice(0, 10) : new Date(start).toISOString(),
        end: allDay ? end.slice(0, 10) : new Date(end).toISOString(),
      };
      if (event?.id) await api.patch(`/calendar/events/${event.id}`, body);
      else await api.post("/calendar/events", body);
      onSaved?.();
    } catch (e) { setErr(e?.response?.data?.detail || "Save failed"); }
    finally { setSaving(false); }
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
            <DateInput label="Starts" value={start} onChange={setStart} allDay={allDay} testid="cal-start" />
            <DateInput label="Ends" value={end} onChange={setEnd} allDay={allDay} testid="cal-end" />
          </div>
          <Input
            label="Meeting link (optional)"
            value={meetingUrl}
            onChange={setMeetingUrl}
            placeholder="Paste a Microsoft Teams or Zoom join URL"
            testid="cal-meeting-url"
            icon={LinkIcon}
          />
          <div>
            <label className="block text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 mb-1">Description (optional)</label>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} data-testid="cal-description"
              placeholder="Agenda, attendee notes, links…"
              className="w-full px-3 py-2 text-sm border border-stone-300 rounded-lg" />
          </div>
          {err && <div className="text-xs text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg flex items-center gap-1.5"><AlertCircle className="w-3.5 h-3.5" /> {err}</div>}
        </div>
        <div className="px-5 py-4 border-t border-stone-200 flex justify-end gap-2 bg-stone-50">
          <button onClick={onClose} className="px-3 py-2 text-xs font-bold rounded-lg border border-stone-300 bg-white hover:bg-stone-50">Cancel</button>
          <button onClick={save} disabled={saving || !title.trim()} data-testid="cal-save"
            className="px-4 py-2 text-xs font-bold uppercase tracking-wider bg-[#D4FF00] text-stone-950 hover:bg-[#BDE600] rounded-lg disabled:opacity-50 flex items-center gap-1.5">
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
            {event ? "Save changes" : "Create event"}
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
