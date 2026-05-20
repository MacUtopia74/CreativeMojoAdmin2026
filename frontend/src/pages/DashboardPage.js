import { useEffect, useState, useMemo } from "react";
import { Link } from "react-router-dom";
import api from "@/lib/api";
import { RefreshCw, AlertCircle, Calendar, ArrowRight, Activity, TrendingUp, Users, FileText, Contact, MapPin, CreditCard, AlertTriangle, CheckCircle2, BellRing, Mail, CalendarDays, Cake, Video, Clock } from "lucide-react";

const PIPELINE_STAGES = [
  { key: "new", label: "New", color: "bg-stone-400" },
  { key: "contacted", label: "Contacted", color: "bg-blue-400" },
  { key: "qualified", label: "Interested", color: "bg-amber-400" },
  { key: "demo_booked", label: "Shadow Day Booked", color: "bg-purple-400" },
  { key: "converted", label: "Territory Map", color: "bg-emerald-500" },
  { key: "dormant", label: "Dormant", color: "bg-orange-400" },
  { key: "lost", label: "Lost", color: "bg-red-400" },
];

function KPI({ label, value, hint, to, testid }) {
  const inner = (
    <>
      <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">{label}</div>
      <div className="mt-3 font-display text-4xl text-stone-950 tabular-nums">
        {value === null || value === undefined ? "—" : Number(value).toLocaleString()}
      </div>
      {hint && <div className="mt-2 text-xs text-stone-500">{hint}</div>}
    </>
  );
  return to ? (
    <Link to={to} className="bg-white border border-stone-200 p-6 block hover:bg-stone-50 transition-colors rounded-2xl" data-testid={testid}>{inner}</Link>
  ) : (
    <div className="bg-white border border-stone-200 p-6 rounded-2xl" data-testid={testid}>{inner}</div>
  );
}

function Panel({ icon: Icon, title, action, children, testid }) {
  return (
    <div className="bg-white border border-stone-200 rounded-2xl overflow-hidden" data-testid={testid}>
      <div className="px-5 py-3 border-b border-stone-200 flex items-center justify-between">
        <div className="flex items-center gap-2">
          {Icon && <Icon className="w-3.5 h-3.5 text-stone-500" />}
          <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600">{title}</div>
        </div>
        {action}
      </div>
      <div className="p-5">{children}</div>
    </div>
  );
}

export default function DashboardPage() {
  const [stats, setStats] = useState(null);
  const [anniversaries, setAnniversaries] = useState(null);
  const [gcAlerts, setGcAlerts] = useState(null);
  const [renewals, setRenewals] = useState(null);
  const [calendarEvents, setCalendarEvents] = useState(null);
  const [error, setError] = useState("");
  const [migrating, setMigrating] = useState(false);
  const [migrateResult, setMigrateResult] = useState(null);

  const refresh = async () => {
    try {
      const { data } = await api.get("/dashboard/stats");
      setStats(data);
    } catch (e) { setError("Could not load dashboard."); }
    try {
      const { data } = await api.get("/anniversaries/today", { params: { upcoming_days: 30 } });
      setAnniversaries(data);
    } catch (e) { /* noop */ }
    try {
      const { data } = await api.get("/gocardless/alerts", { params: { hours: 24 } });
      setGcAlerts(data);
    } catch (e) { /* GoCardless optional */ }
    try {
      // Cap renewals at 365 days so the dashboard buckets can show ≤90d /
      // 91–180d / 181–365d. Anything beyond a year doesn't need to be on
      // the dashboard yet — that lives on /renewals.
      const { data } = await api.get("/contracts/renewals", { params: { within_days: 365 } });
      setRenewals(data);
    } catch (e) { /* renewals optional */ }
    try {
      // Phase 5 — only attempt if Google Calendar is connected; otherwise
      // hide the panel silently.
      const { data: st } = await api.get("/calendar/status");
      if (st?.connected) {
        const { data } = await api.get("/calendar/events", { params: { days_ahead: 5, days_back: 0 } });
        setCalendarEvents(data.events || []);
      } else {
        setCalendarEvents(null);
      }
    } catch (e) { setCalendarEvents(null); }
  };

  useEffect(() => { refresh(); }, []);

  const runMigration = async () => {
    if (!window.confirm("Re-run the Airtable migration?\n\nThis wipes and re-imports all migrated data.")) return;
    setMigrating(true);
    setMigrateResult(null);
    try {
      const { data } = await api.post("/migration/run");
      setMigrateResult({ ok: true, counts: data.counts });
      await refresh();
    } catch (e) {
      setMigrateResult({ ok: false, error: e?.response?.data?.detail || e.message });
    } finally { setMigrating(false); }
  };

  const lastMigrated = stats?.last_migration ? new Date(stats.last_migration).toLocaleString("en-GB") : null;
  const hasData = (stats?.franchisees_migrated || 0) > 0;

  // Funnel data
  const funnelMax = useMemo(() => {
    if (!stats?.pipeline_funnel) return 0;
    return Math.max(...Object.values(stats.pipeline_funnel), 1);
  }, [stats]);

  // Conversion rate
  const totalEnq = stats?.web_form_contacts || 0;
  const converted = stats?.pipeline_funnel?.converted || 0;
  const conversionRate = totalEnq > 0 ? ((converted / totalEnq) * 100).toFixed(1) : "0.0";

  return (
    <div className="min-h-screen">
      <div className="h-16 border-b border-stone-200 bg-white flex items-center px-8 sticky top-0 z-10" data-testid="topbar">
        <div className="flex items-baseline gap-3 flex-1">
          <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-500">Overview</div>
          <h1 className="font-display text-xl text-stone-950">Dashboard</h1>
        </div>
        {lastMigrated && <span className="text-xs text-stone-500 mr-3" data-testid="last-migrated-stamp" title="Airtable migration finalised — this admin console is now the live source of truth.">Migrated from Airtable · {lastMigrated}</span>}
      </div>

      <div className="p-8 space-y-6 max-w-[1500px]">
        {error && <div className="border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 flex items-center gap-2 rounded-xl"><AlertCircle className="w-4 h-4" /> {error}</div>}
        {migrateResult && (
          <div className={`border px-4 py-3 text-sm rounded-xl ${migrateResult.ok ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-red-200 bg-red-50 text-red-800"}`}>
            {migrateResult.ok ? (
              <><strong>Migration complete.</strong> <span className="ml-2">{Object.entries(migrateResult.counts).map(([k, v]) => `${k}: ${v.toLocaleString()}`).join(" · ")}</span></>
            ) : <><strong>Migration failed:</strong> {migrateResult.error}</>}
          </div>
        )}

        {/* KPIs */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4" data-testid="dashboard-kpis">
          <KPI label="Active Franchisees" value={stats?.active_franchisees} hint={`of ${stats?.franchisees_migrated || 0} total`} to="/franchisees" testid="kpi-franchisees" />
          <KPI label="Enquiries" value={stats?.web_form_contacts} hint={`${conversionRate}% converted lifetime`} to="/contacts" testid="kpi-contacts" />
          <KPI label="Territory Postcodes" value={stats?.territories_migrated} hint="DaD bridge → Phase 4" testid="kpi-territories" />
        </div>

        {/* Phase 1.8 — TO DO: Contract renewals in the reminder zone (≤90 days) */}
        <Panel icon={BellRing} title="To Do · Contract Renewals" testid="panel-todo-renewals"
          action={
            <Link to="/renewals" className="text-xs font-bold uppercase tracking-wider text-stone-700 hover:text-stone-950 flex items-center gap-1" data-testid="todo-open-renewals">
              Open Renewals <ArrowRight className="w-3 h-3" />
            </Link>
          }>
          {!renewals ? (
            <div className="text-sm text-stone-500">Loading renewals…</div>
          ) : (() => {
            // Anything already chased is hidden from the dashboard's "to do"
            // panel entirely — the whole point of marking-as-contacted on the
            // Renewals page is to make these stop nagging. The /renewals
            // page still shows them (with a toggle) for audit.
            const active = renewals.items.filter((r) => !r.last_reminded_at);
            const reminderItems = active.filter((r) => r.days_remaining >= 0 && r.days_remaining <= 90);
            const expiringSoon = active.filter((r) => r.days_remaining > 90 && r.days_remaining <= 180);
            const expiringLater = active.filter((r) => r.days_remaining > 180 && r.days_remaining <= 365);
            const contactedCount = renewals.items.filter((r) => r.last_reminded_at).length;
            if (reminderItems.length === 0 && expiringSoon.length === 0 && expiringLater.length === 0) {
              return (
                <div className="flex items-center gap-2 text-sm text-emerald-700 py-1">
                  <CheckCircle2 className="w-4 h-4" />
                  <span>Nothing to chase right now — no renewals in the next 365 days.</span>
                </div>
              );
            }
            return (
              <div className="space-y-4">
                <div className="grid grid-cols-3 gap-3">
                  <div className="bg-amber-50 border border-amber-200 rounded-lg p-3" data-testid="todo-zone-remind">
                    <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-amber-700">≤ 90 Days · Remind</div>
                    <div className="font-display text-2xl text-amber-900 mt-1 tabular-nums">{reminderItems.length}</div>
                  </div>
                  <div className="bg-blue-50 border border-blue-200 rounded-lg p-3" data-testid="todo-zone-180">
                    <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-blue-700">91 — 180 Days</div>
                    <div className="font-display text-2xl text-blue-900 mt-1 tabular-nums">{expiringSoon.length}</div>
                  </div>
                  <div className="bg-stone-100 border border-stone-200 rounded-lg p-3" data-testid="todo-zone-365">
                    <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-700">181 Days — 1 Year</div>
                    <div className="font-display text-2xl text-stone-900 mt-1 tabular-nums">{expiringLater.length}</div>
                  </div>
                </div>
                {contactedCount > 0 && (
                  <div className="text-[11px] text-emerald-700 flex items-center gap-1.5" data-testid="todo-contacted-summary">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    <strong className="tabular-nums">{contactedCount}</strong> already contacted ·
                    <Link to="/renewals" className="underline underline-offset-2 hover:text-emerald-900">view on Renewals</Link>
                  </div>
                )}
                {reminderItems.length > 0 && (
                  <div>
                    <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 mb-2">Email reminders due now</div>
                    <div className="border border-stone-200 rounded-lg divide-y divide-stone-100 overflow-hidden">
                      {reminderItems.slice(0, 6).map((r) => {
                        const f = r.franchisee || {};
                        const to = f.mojo_email || f.email || r.email_rollup || "";
                        const fname = f.first_name || "there";
                        const org = f.organisation || "your Creative Mojo franchise";
                        const renewalDate = r.renewal_date ? new Date(r.renewal_date).toLocaleDateString("en-GB") : "";
                        const subject = `Your Creative Mojo franchise agreement renews in ${r.days_remaining} days`;
                        const body = `Hi ${fname},\n\nJust a friendly heads-up — your franchise agreement for ${org} comes up for renewal on ${renewalDate} (${r.days_remaining} days from today).\n\nCould you have a quick look over your existing terms and let me know if you'd like to renew? Happy to jump on a call to talk through anything.\n\nBest,\nLiz @ Creative Mojo HQ`;
                        const mailto = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
                        return (
                          <div key={r.id} className="px-3 py-2 flex items-center gap-3 hover:bg-stone-50" data-testid={`todo-renewal-${r.id}`}>
                            <span className={`px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider border rounded-md tabular-nums ${r.days_remaining <= 30 ? "bg-red-100 text-red-800 border-red-300" : "bg-amber-100 text-amber-900 border-amber-300"}`}>{r.days_remaining} {r.days_remaining === 1 ? "Day" : "Days"} Left</span>
                            <Link to={`/franchisees/${f.id || ""}`} className="text-sm font-semibold text-stone-900 hover:underline flex-1 truncate">
                              {org}
                              <span className="text-xs text-stone-500 font-normal ml-2">· {[f.first_name, f.last_name].filter(Boolean).join(" ")}</span>
                            </Link>
                            <span className="text-[11px] text-stone-500 tabular-nums hidden md:inline">Renews {renewalDate}</span>
                            {to ? (
                              <a href={mailto} data-testid={`todo-mail-${r.id}`}
                                onClick={() => {
                                  // Fire-and-forget so the user's mailto opens
                                  // immediately. We refresh the renewals slice
                                  // afterwards so the row drops out of the
                                  // panel (it's already-contacted now).
                                  api.post(`/contracts/${r.id}/mark-contacted`, { method: "email" })
                                    .then(() => api.get("/contracts/renewals", { params: { within_days: 365 } }))
                                    .then(({ data }) => setRenewals(data))
                                    .catch(() => { /* swallow — UI stays in sync on next refresh */ });
                                }}
                                className="inline-flex items-center gap-1 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider bg-red-600 hover:bg-red-700 text-white rounded-lg transition">
                                <Mail className="w-3 h-3" /> Remind
                              </a>
                            ) : (
                              <span className="text-[10px] text-stone-400">no email</span>
                            )}
                          </div>
                        );
                      })}
                      {reminderItems.length > 6 && (
                        <Link to="/renewals" className="block px-3 py-2 text-[11px] text-stone-500 hover:text-stone-900 hover:bg-stone-50 text-center uppercase tracking-wider font-bold">
                          + {reminderItems.length - 6} more · Open Renewals
                        </Link>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })()}
        </Panel>

        {/* Upcoming franchise anniversaries — full width, sits ABOVE the
            sales funnel so it's the first thing HQ sees after their renewal
            to-dos. Today's anniversaries lead with a celebratory badge,
            followed by everything coming up in the next 30 days. */}
        <Panel icon={Cake} title="Anniversaries · Today + next 30 days" testid="panel-anniversaries">
          {!anniversaries ? (
            <div className="text-sm text-stone-500">Checking…</div>
          ) : anniversaries.upcoming_count === 0 ? (
            <div className="text-sm text-stone-500">No franchise anniversaries in the next 30 days.</div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3" data-testid="anniversaries-list">
              {anniversaries.anniversaries.slice(0, 8).map(({ contract, franchisee, anniversary_date, days_until }) => {
                const isToday = days_until === 0;
                const dateLabel = anniversary_date
                  ? new Date(anniversary_date).toLocaleDateString("en-GB", { day: "2-digit", month: "short" })
                  : "";
                const fname = [franchisee?.first_name, franchisee?.last_name].filter(Boolean).join(" ");
                return (
                  <Link key={contract.id} to={`/franchisees/${franchisee?.id || ""}`}
                    className={`block border rounded-xl p-3 hover:shadow-md transition-all ${isToday ? "bg-[#D4FF00]/10 border-[#14532D]/40" : "bg-white border-stone-200 hover:border-stone-400"}`}>
                    <div className="flex items-center gap-2 mb-1">
                      <span className={`px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded-md tabular-nums ${
                        isToday ? "bg-[#D4FF00] text-stone-950" : "bg-stone-100 text-stone-700"
                      }`}>
                        {isToday ? "Today" : `In ${days_until} ${days_until === 1 ? "Day" : "Days"}`}
                      </span>
                      <span className="text-[11px] text-stone-500 tabular-nums">{dateLabel}</span>
                    </div>
                    <div className="text-sm font-semibold text-stone-950 truncate">{franchisee?.organisation || "—"}</div>
                    {fname && <div className="text-xs text-stone-500 truncate">{fname}</div>}
                  </Link>
                );
              })}
              {anniversaries.anniversaries.length > 8 && (
                <Link to="/renewals" className="border border-dashed border-stone-300 rounded-xl p-3 flex items-center justify-center text-xs text-stone-600 hover:bg-stone-50 hover:border-stone-400">
                  + {anniversaries.anniversaries.length - 8} more
                </Link>
              )}
            </div>
          )}
        </Panel>

        {/* Phase 5 — Calendar feed: next 5 days of events from Google Calendar */}
        {calendarEvents !== null && (
          <Panel icon={CalendarDays} title="Calendar · Next 5 days"
            action={
              <Link to="/calendar" className="text-xs font-bold uppercase tracking-wider text-stone-700 hover:text-stone-950 flex items-center gap-1" data-testid="dash-open-calendar">
                Open Calendar <ArrowRight className="w-3 h-3" />
              </Link>
            } testid="panel-calendar-next">
            {calendarEvents.length === 0 ? (
              <div className="flex items-center gap-2 text-sm text-stone-500">
                <CalendarDays className="w-4 h-4" />
                <span>No events in the next 5 days. Add one from <Link to="/calendar" className="underline">Calendar</Link>.</span>
              </div>
            ) : (
              <div className="divide-y divide-stone-100" data-testid="calendar-next-list">
                {calendarEvents.slice(0, 12).map((e) => {
                  const start = e.start ? new Date(e.start) : null;
                  const end = e.end ? new Date(e.end) : null;
                  const day = start ? start.toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short" }) : "—";
                  const timeStr = e.all_day || !start
                    ? "All day"
                    : `${start.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}${end ? ` – ${end.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}` : ""}`;
                  return (
                    <div key={e.id} className="py-2.5 flex items-center gap-3" data-testid={`cal-next-${e.id}`}>
                      <div className="w-24 shrink-0">
                        <div className="text-[10px] uppercase tracking-wider font-bold text-stone-500">{day}</div>
                        <div className="text-xs text-stone-700 tabular-nums">{timeStr}</div>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-semibold text-stone-950 truncate">{e.title}</div>
                        {e.location && <div className="text-xs text-stone-500 truncate">{e.location}</div>}
                      </div>
                      {e.meeting_url && (
                        <a href={e.meeting_url} target="_blank" rel="noreferrer" data-testid={`cal-next-join-${e.id}`}
                          className="shrink-0 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider bg-stone-950 text-white hover:bg-stone-800 rounded-md inline-flex items-center gap-1">
                          <Video className="w-3 h-3" /> Join
                        </a>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </Panel>
        )}

        {/* Sales pipeline funnel - full width */}
        <Panel icon={TrendingUp} title="Sales Pipeline · Enquiry Funnel" action={
          <Link to="/contacts" className="text-xs font-bold uppercase tracking-wider text-stone-700 hover:text-stone-950 flex items-center gap-1">
            Open Pipeline <ArrowRight className="w-3 h-3" />
          </Link>
        } testid="panel-funnel">
          <div className="space-y-3" data-testid="funnel-bars">
            {PIPELINE_STAGES.map((s) => {
              const count = stats?.pipeline_funnel?.[s.key] || 0;
              const pct = funnelMax > 0 ? (count / funnelMax) * 100 : 0;
              return (
                <div key={s.key} className="flex items-center gap-3">
                  <div className="w-32 text-xs font-semibold text-stone-700">{s.label}</div>
                  <div className="flex-1 h-6 bg-stone-100 relative rounded-md overflow-hidden">
                    <div className={`h-full ${s.color} transition-all`} style={{ width: `${pct}%` }} />
                    <span className="absolute inset-0 flex items-center pl-2 text-xs font-bold text-stone-900 tabular-nums">{count.toLocaleString()}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </Panel>

        {/* Mid grid: Mandate breakdown + Recent enquiries (anniversaries moved up) */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Panel icon={Activity} title="Mandate Status · Active Franchisees" testid="panel-mandates">
            {!stats?.mandate_breakdown || stats.mandate_breakdown.length === 0 ? (
              <div className="text-sm text-stone-500">No mandate data.</div>
            ) : (
              <div className="space-y-2">
                {stats.mandate_breakdown.map((m) => {
                  const pct = stats.active_franchisees > 0 ? (m.count / stats.active_franchisees) * 100 : 0;
                  return (
                    <div key={m.value} className="flex items-center gap-3 text-sm">
                      <div className="flex-1 truncate font-semibold text-stone-900">{m.value || "(blank)"}</div>
                      <div className="w-20 h-2 bg-stone-100 rounded-full overflow-hidden">
                        <div className="h-full bg-[#D4FF00]" style={{ width: `${pct}%` }} />
                      </div>
                      <div className="w-10 text-right text-xs text-stone-700 tabular-nums font-bold">{m.count}</div>
                    </div>
                  );
                })}
                <div className="pt-2 mt-2 border-t border-stone-100" data-testid="gc-dashboard-alerts">
                  {gcAlerts ? (
                    gcAlerts.items.length === 0 ? (
                      <div className="flex items-center gap-2 text-xs text-emerald-700">
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        <span>GoCardless · no failed mandates or payments in the last 24h</span>
                      </div>
                    ) : (
                      <Link to="/franchisees" className="block">
                        <div className="flex items-center justify-between text-xs">
                          <div className="flex items-center gap-2 text-stone-700">
                            <AlertTriangle className="w-3.5 h-3.5 text-amber-600" />
                            <span className="font-semibold">GoCardless · Last 24h</span>
                          </div>
                          <div className="flex items-center gap-3 tabular-nums">
                            {gcAlerts.by_type.payment_failed > 0 && <span className="text-red-700"><strong>{gcAlerts.by_type.payment_failed}</strong> failed payments</span>}
                            {gcAlerts.by_type.mandate_cancelled > 0 && <span className="text-amber-700"><strong>{gcAlerts.by_type.mandate_cancelled}</strong> cancelled</span>}
                            {gcAlerts.by_type.mandate_failed > 0 && <span className="text-red-700"><strong>{gcAlerts.by_type.mandate_failed}</strong> mandate fails</span>}
                          </div>
                        </div>
                      </Link>
                    )
                  ) : (
                    <div className="flex items-center gap-2 text-xs text-stone-500">
                      <CreditCard className="w-3.5 h-3.5" />
                      <span>GoCardless · awaiting first sync (use the "Sync GoCardless" button on the Franchisees page)</span>
                    </div>
                  )}
                </div>
              </div>
            )}
          </Panel>

          <Panel icon={Contact} title="Recent Enquiries" action={
            <Link to="/contacts" className="text-xs font-bold uppercase tracking-wider text-stone-700 hover:text-stone-950 flex items-center gap-1">
              All <ArrowRight className="w-3 h-3" />
            </Link>
          } testid="panel-recent-enquiries">
            {!stats?.recent_enquiries || stats.recent_enquiries.length === 0 ? (
              <div className="text-sm text-stone-500">No recent enquiries.</div>
            ) : (
              <div className="space-y-3">
                {stats.recent_enquiries.map((e) => (
                  <div key={e.id} className="text-sm border-b border-stone-100 last:border-0 pb-2 last:pb-0">
                    <div className="flex items-center justify-between gap-2">
                      <div className="font-semibold text-stone-900 truncate">{[e.first_name, e.last_name].filter(Boolean).join(" ") || "Unnamed"}</div>
                      <div className="text-[10px] text-stone-500 shrink-0 tabular-nums">{e.date ? (() => { const m = String(e.date).match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]}-${m[2]}-${m[1]}` : String(e.date).slice(0,10); })() : ""}</div>
                    </div>
                    <div className="text-xs text-stone-600 truncate">{e.establishment_name || ""}</div>
                    <div className="text-xs text-stone-500 mt-0.5">{e.postcode || ""} · <span className="capitalize">{e.pipeline_status || "new"}</span></div>
                  </div>
                ))}
              </div>
            )}
          </Panel>
        </div>

        {/* Build status — minimal */}
        <Panel title="Build Roadmap" testid="panel-status">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-px bg-stone-200 -m-5 mt-0">
            {[
              { phase: "Phase 1", title: "Admin + CRM + Migration", state: "complete" },
              { phase: "Phase 1.5", title: "GoCardless live mandates", state: "next" },
              { phase: "Phase 1.6", title: "Sales pipeline (simple)", state: "complete" },
              { phase: "Phase 2", title: "WooCommerce orders + Gantt", state: "planned" },
            ].map((p) => (
              <div key={p.phase} className="bg-white p-4">
                <div className="flex items-center gap-2">
                  <div className={`w-2 h-2 rounded-full ${
                    p.state === "complete" ? "bg-emerald-500" : p.state === "next" ? "bg-[#D4FF00] animate-pulse" : "bg-stone-300"
                  }`} />
                  <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">{p.phase}</div>
                </div>
                <div className="text-sm font-semibold text-stone-900 mt-2">{p.title}</div>
                <div className="text-xs text-stone-500 mt-1 capitalize">{p.state}</div>
              </div>
            ))}
          </div>
        </Panel>
      </div>
    </div>
  );
}
