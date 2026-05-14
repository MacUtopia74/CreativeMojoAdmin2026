// Phase 1.8 — Contract Renewals
// Full list of all franchisee contracts sorted soonest-to-renew first, bucketed
// (overdue / ≤30d / ≤90d 'reminder zone' / ≤180d / later). Each row offers a
// one-click "Email Reminder" mailto: button with prefilled subject + body.
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import api from "@/lib/api";
import { formatDate } from "@/lib/date";
import { AlertCircle, BellRing, Mail, ChevronDown, ChevronUp, CalendarDays, Search } from "lucide-react";

const BUCKETS = [
  { key: "overdue",  label: "Already Expired",        chip: "bg-red-100 text-red-800 border-red-300" },
  { key: "lt_30",    label: "≤ 30 days",              chip: "bg-red-100 text-red-800 border-red-300" },
  { key: "lt_90",    label: "31 — 90 days · REMIND",  chip: "bg-amber-100 text-amber-900 border-amber-300" },
  { key: "lt_180",   label: "91 — 180 days",          chip: "bg-blue-100 text-blue-800 border-blue-300" },
  { key: "later",    label: "180+ days",              chip: "bg-stone-100 text-stone-700 border-stone-300" },
];
const MANDATE_BADGE = {
  active: "bg-emerald-100 text-emerald-800 border-emerald-300",
  cancelled: "bg-red-100 text-red-800 border-red-300",
  failed: "bg-red-100 text-red-800 border-red-300",
  expired: "bg-stone-200 text-stone-700 border-stone-300",
};

function buildReminderMailto(row) {
  const f = row.franchisee || {};
  const to = f.mojo_email || f.email || "";
  const fname = f.first_name || "there";
  const org = f.organisation || "your Creative Mojo franchise";
  const renewalDate = formatDate(row.renewal_date);
  const days = row.days_remaining;
  const subject = days < 0
    ? `Action needed: ${org} franchise agreement renewal (already lapsed)`
    : `Your Creative Mojo franchise agreement renews in ${days} days`;
  const lines = [
    `Hi ${fname},`,
    "",
    days < 0
      ? `Just a quick note — our records show your franchise agreement for ${org} expired on ${renewalDate}. We'd love to get a fresh agreement in place. Could you let me know a good time this week to chat?`
      : `Just a friendly heads-up — your franchise agreement for ${org} comes up for renewal on ${renewalDate} (${days} days from today).`,
    "",
    "Could you have a quick look over your existing terms and let me know if you'd like to renew? Happy to jump on a call to talk through anything.",
    "",
    "Best,",
    "Liz @ Creative Mojo HQ",
  ];
  const body = lines.join("\n");
  return `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

function CountdownPill({ days, bucket }) {
  const style = BUCKETS.find((b) => b.key === bucket)?.chip || "bg-stone-100 text-stone-700 border-stone-300";
  const label = days < 0 ? `Expired ${Math.abs(days)}d ago` : `${days}d left`;
  return (
    <span className={`inline-block px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider border rounded-md tabular-nums ${style}`}
      data-testid={`countdown-${bucket}`}>{label}</span>
  );
}

function MandateBadge({ status }) {
  if (!status) return <span className="text-[10px] text-stone-300">—</span>;
  const style = MANDATE_BADGE[status] || "bg-stone-100 text-stone-700 border-stone-300";
  return <span className={`inline-block px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider border rounded-md ${style}`}>{status}</span>;
}

export default function ContractRenewalsPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [windowDays, setWindowDays] = useState(365);
  const [search, setSearch] = useState("");
  const [collapsed, setCollapsed] = useState({ overdue: true });  // hide expired by default

  useEffect(() => {
    let cancel = false;
    setData(null);
    (async () => {
      try {
        const { data } = await api.get("/contracts/renewals", { params: { within_days: windowDays } });
        if (!cancel) setData(data);
      } catch (e) {
        if (!cancel) setError("Could not load contract renewals.");
      }
    })();
    return () => { cancel = true; };
  }, [windowDays]);

  const grouped = useMemo(() => {
    const out = Object.fromEntries(BUCKETS.map((b) => [b.key, []]));
    if (!data) return out;
    const q = search.trim().toLowerCase();
    for (const row of data.items) {
      if (q) {
        const f = row.franchisee || {};
        const haystack = `${f.first_name || ""} ${f.last_name || ""} ${f.organisation || ""} ${f.mojo_email || ""} ${f.postcode || ""}`.toLowerCase();
        if (!haystack.includes(q)) continue;
      }
      out[row.bucket]?.push(row);
    }
    return out;
  }, [data, search]);

  const toggleBucket = (key) => setCollapsed((c) => ({ ...c, [key]: !c[key] }));

  return (
    <div className="min-h-screen bg-[#FBFAF8]" data-testid="renewals-page">
      {/* Topbar */}
      <div className="bg-white border-b border-stone-200 px-8 py-5 flex items-center justify-between sticky top-0 z-10">
        <div>
          <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-500">CRM</div>
          <h1 className="font-display text-3xl text-stone-950 mt-1 flex items-baseline gap-3">
            Contract Renewals
            {data && (
              <span className="text-sm text-stone-500 tabular-nums font-normal">
                {data.counts.reminder_zone} due in ≤90 days · {data.counts.overdue} already expired
              </span>
            )}
          </h1>
        </div>
        <div className="flex items-center gap-3">
          <div className="relative">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-stone-400" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, org, email…"
              data-testid="renewals-search"
              className="pl-10 pr-3 py-2 w-72 bg-stone-50 border border-stone-300 text-sm focus:outline-none focus:border-stone-900 rounded-lg" />
          </div>
          <select value={windowDays} onChange={(e) => setWindowDays(Number(e.target.value))}
            data-testid="renewals-window"
            className="px-3 py-2 border border-stone-300 bg-white text-xs uppercase tracking-wider font-bold rounded-lg">
            <option value={90}>Next 90 days</option>
            <option value={180}>Next 180 days</option>
            <option value={365}>Next 12 months</option>
            <option value={730}>Next 24 months</option>
            <option value={3650}>All upcoming</option>
          </select>
        </div>
      </div>

      <div className="p-8 pt-6 space-y-6">
        {error && (
          <div className="border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 flex items-center gap-2 rounded-xl">
            <AlertCircle className="w-4 h-4" /> {error}
          </div>
        )}
        {!data ? (
          <div className="text-center text-stone-500 text-sm uppercase tracking-widest p-12">Loading…</div>
        ) : (
          BUCKETS.map((b) => {
            const rows = grouped[b.key] || [];
            if (rows.length === 0) return null;
            const isOpen = !collapsed[b.key];
            return (
              <div key={b.key} className="bg-white border border-stone-200 rounded-2xl overflow-hidden" data-testid={`bucket-${b.key}`}>
                <button onClick={() => toggleBucket(b.key)} className="w-full px-5 py-4 flex items-center justify-between hover:bg-stone-50 transition">
                  <div className="flex items-center gap-3">
                    <CalendarDays className="w-4 h-4 text-stone-600" />
                    <span className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-700">{b.label}</span>
                    <span className={`px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider border rounded-md tabular-nums ${b.chip}`}>{rows.length}</span>
                  </div>
                  {isOpen ? <ChevronUp className="w-4 h-4 text-stone-500" /> : <ChevronDown className="w-4 h-4 text-stone-500" />}
                </button>
                {isOpen && (
                  <div className="border-t border-stone-100">
                    <table className="w-full">
                      <thead className="bg-[#F2F2F0] border-b border-stone-200">
                        <tr>
                          <th className="text-left px-3 py-2 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 w-20">Photo</th>
                          <th className="text-left px-3 py-2 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600">Franchisee</th>
                          <th className="text-left px-3 py-2 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 w-28">Commenced</th>
                          <th className="text-left px-3 py-2 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 w-28">Term</th>
                          <th className="text-left px-3 py-2 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 w-28">Renews</th>
                          <th className="text-left px-3 py-2 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 w-32">Countdown</th>
                          <th className="text-left px-3 py-2 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 w-24">Mandate</th>
                          <th className="text-right px-3 py-2 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 w-40">Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((row) => {
                          const f = row.franchisee || {};
                          const photo = f.photos?.[0]?.url;
                          return (
                            <tr key={row.id} className="border-b border-stone-100 hover:bg-stone-50" data-testid={`renewal-row-${row.id}`}>
                              <td className="px-3 py-2">
                                {photo ? (
                                  <img src={photo} alt="" className="w-12 h-12 object-cover rounded-lg" />
                                ) : (
                                  <div className="w-12 h-12 bg-stone-100 rounded-lg flex items-center justify-center text-xs font-bold text-stone-400">
                                    {(f.first_name?.[0] || "?") + (f.last_name?.[0] || "")}
                                  </div>
                                )}
                              </td>
                              <td className="px-3 py-2">
                                {f.id ? (
                                  <Link to={`/franchisees/${f.id}`} className="text-sm font-semibold text-stone-950 hover:underline">
                                    {f.organisation || `${f.first_name || ""} ${f.last_name || ""}`.trim() || "—"}
                                  </Link>
                                ) : (
                                  <span className="text-sm text-stone-700">{row.first_name_rollup} {row.last_name_rollup}</span>
                                )}
                                <div className="text-[11px] text-stone-500 mt-0.5">{f.first_name} {f.last_name} · {f.mojo_email || f.email || row.email_rollup || "no email"}</div>
                              </td>
                              <td className="px-3 py-2 text-xs text-stone-700 tabular-nums">{formatDate(row.commencement_date)}</td>
                              <td className="px-3 py-2 text-xs text-stone-700 tabular-nums">{row.contract_term_years ? `${row.contract_term_years} yr` : "—"}</td>
                              <td className="px-3 py-2 text-xs text-stone-900 font-semibold tabular-nums">{formatDate(row.renewal_date)}</td>
                              <td className="px-3 py-2"><CountdownPill days={row.days_remaining} bucket={row.bucket} /></td>
                              <td className="px-3 py-2"><MandateBadge status={f.gocardless_mandate_status} /></td>
                              <td className="px-3 py-2 text-right">
                                {(f.mojo_email || f.email || row.email_rollup) ? (
                                  <a href={buildReminderMailto(row)}
                                    data-testid={`reminder-${row.id}`}
                                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider bg-red-600 hover:bg-red-700 text-white rounded-lg transition">
                                    <Mail className="w-3 h-3" /> Email Reminder
                                  </a>
                                ) : (
                                  <span className="text-[10px] text-stone-400 uppercase tracking-wider">No email on file</span>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            );
          })
        )}
        {data && data.items.length === 0 && (
          <div className="text-center text-stone-500 text-sm uppercase tracking-widest p-12">
            No contract renewals due in this window.
          </div>
        )}
      </div>
    </div>
  );
}
