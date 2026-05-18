// Events panel — collapsible widget on the franchisee portal that lists
// upcoming events from the shared Google Calendar. The big draw is a
// one-click "Join Teams meeting" button on any event the admin has
// attached a meeting URL to, so franchisees don't have to dig through
// emails for the link.
import { useCallback, useEffect, useState } from "react";
import api from "@/lib/api";
import {
  CalendarDays, Video, MapPin, Clock, ChevronDown, ChevronUp,
  Loader2, ExternalLink, RefreshCw,
} from "lucide-react";

const UK = "en-GB";

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

export default function PortalEventsPanel({ open, onToggle }) {
  const [events, setEvents] = useState(null);
  const [connected, setConnected] = useState(true);
  const [busy, setBusy] = useState(false);
  const [showPast, setShowPast] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const { data } = await api.get("/calendar/portal-events", {
        params: { days_ahead: 90, days_back: showPast ? 30 : 0 },
      });
      setEvents(data.events || []);
      setConnected(data.connected !== false);
    } catch {
      setEvents([]);
    } finally { setBusy(false); }
  }, [showPast]);

  useEffect(() => { load(); }, [load]);

  // Pre-compute the next event for the collapsed-state preview line so
  // the franchisee can see what's coming without expanding.
  const nextEvent = events && events.length > 0 ? events.find((e) => {
    const start = new Date(e.start);
    return start.getTime() >= Date.now();
  }) : null;

  return (
    <div
      className={`${open ? "bg-white" : "bg-stone-100"} border border-stone-200 rounded-2xl overflow-hidden transition-colors`}
      data-testid="portal-events"
    >
      <button
        onClick={onToggle}
        data-testid="toggle-events"
        className={`w-full flex items-center justify-between gap-3 ${open ? "hover:bg-stone-50" : "hover:bg-stone-200"} transition-colors px-6 py-4`}
      >
        <div className="flex items-center gap-2 min-w-0">
          <CalendarDays className="w-4 h-4 text-stone-700 shrink-0" />
          <span className="text-xs uppercase tracking-[0.3em] font-bold text-stone-700">
            Events
          </span>
          {!open && nextEvent && (
            <span className="text-xs text-stone-500 truncate ml-1">
              · Next: <strong className="text-stone-800">{nextEvent.title}</strong> · {ukDate(nextEvent.start)}{!nextEvent.all_day && ` at ${ukTime(nextEvent.start)}`}
            </span>
          )}
          {!open && nextEvent?.meeting_url && (
            <span className="ml-2 inline-flex items-center gap-1 text-[10px] uppercase tracking-wider font-bold bg-blue-100 text-blue-800 px-2 py-0.5 rounded">
              <Video className="w-3 h-3" /> Teams link
            </span>
          )}
        </div>
        <span className={`w-7 h-7 rounded-full border flex items-center justify-center transition-colors ${open ? "border-stone-300 bg-white" : "border-stone-950 bg-stone-950 text-white"}`}>
          {open ? <ChevronUp className="w-3.5 h-3.5 text-stone-600" /> : <ChevronDown className="w-3.5 h-3.5" />}
        </span>
      </button>
      {open && (
        <div className="px-6 pb-6 space-y-4">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <p className="text-sm text-stone-600">
              Upcoming events from HQ. Click <strong>Join meeting</strong> on any session to open the Teams link.
            </p>
            <div className="flex items-center gap-2">
              <label className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-wider font-bold text-stone-600 select-none">
                <input
                  type="checkbox"
                  checked={showPast}
                  onChange={(e) => setShowPast(e.target.checked)}
                  data-testid="events-show-past"
                  className="accent-stone-950"
                />
                Show recent past
              </label>
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

          {events === null ? (
            <div className="text-sm text-stone-500 inline-flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading…
            </div>
          ) : !connected ? (
            <div className="px-4 py-6 text-sm text-stone-500 bg-stone-50 border border-stone-200 rounded-xl text-center">
              HQ hasn't linked a calendar yet. Events will appear here once it's set up.
            </div>
          ) : events.length === 0 ? (
            <div className="px-4 py-6 text-sm text-stone-500 bg-stone-50 border border-stone-200 rounded-xl text-center">
              No events in the {showPast ? "next 90 days or recent past" : "next 90 days"}.
            </div>
          ) : (
            <ul className="divide-y divide-stone-100 border border-stone-200 rounded-xl overflow-hidden">
              {events.map((ev) => {
                const start = new Date(ev.start);
                const past = start.getTime() < Date.now() - 30 * 60 * 1000;
                const isTeamsLink = ev.meeting_url && /teams\.(microsoft|live)\.com/i.test(ev.meeting_url);
                return (
                  <li
                    key={ev.id}
                    className={`px-4 py-3 flex items-start gap-3 ${past ? "bg-stone-50/60" : ""}`}
                    data-testid={`portal-event-${ev.id}`}
                  >
                    <div className="shrink-0 w-16 text-center pt-0.5">
                      <div className="text-[10px] uppercase tracking-wider font-bold text-stone-500">
                        {new Date(ev.start).toLocaleDateString(UK, { month: "short" })}
                      </div>
                      <div className="text-2xl font-display tabular-nums text-stone-950">
                        {new Date(ev.start).getDate()}
                      </div>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="font-semibold text-stone-900 truncate">{ev.title}</div>
                      <div className="text-xs text-stone-500 mt-0.5 flex items-center gap-3 flex-wrap">
                        <span className="inline-flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          {ev.all_day ? "All day" : `${ukTime(ev.start)}${ev.end ? ` – ${ukTime(ev.end)}` : ""}`}
                        </span>
                        {ev.location && (
                          <span className="inline-flex items-center gap-1 truncate">
                            <MapPin className="w-3 h-3" /> {ev.location}
                          </span>
                        )}
                        {past && (
                          <span className="text-[10px] uppercase tracking-wider font-bold text-stone-500">Past</span>
                        )}
                      </div>
                      {ev.description && !ev.description.startsWith("Join: ") && (
                        <div className="text-xs text-stone-600 mt-1.5 line-clamp-2 whitespace-pre-wrap">
                          {ev.description.split("\n\nJoin:")[0]}
                        </div>
                      )}
                    </div>
                    {ev.meeting_url ? (
                      <a
                        href={ev.meeting_url}
                        target="_blank"
                        rel="noreferrer"
                        data-testid={`portal-event-join-${ev.id}`}
                        className={`shrink-0 inline-flex items-center gap-1.5 px-3 py-2 text-[11px] font-bold uppercase tracking-wider rounded-lg transition ${
                          isTeamsLink
                            ? "bg-blue-600 hover:bg-blue-700 text-white"
                            : "bg-stone-950 hover:bg-stone-800 text-white"
                        }`}
                        title={ev.meeting_url}
                      >
                        <Video className="w-3.5 h-3.5" />
                        Join meeting
                        <ExternalLink className="w-3 h-3 opacity-70" />
                      </a>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
