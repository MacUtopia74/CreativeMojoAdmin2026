import { useEffect, useState, useMemo } from "react";
import api from "@/lib/api";
import { Search, AlertCircle, LayoutList, Kanban, X, Mail, Phone, MapPin, Calendar, Trash2, ArrowUpCircle, ArrowDownCircle, Loader2 } from "lucide-react";

const STAGES = [
  { key: "new", label: "New", color: "bg-stone-100 text-stone-700 border-stone-300", barColor: "bg-stone-400" },
  { key: "contacted", label: "Contacted", color: "bg-blue-50 text-blue-700 border-blue-200", barColor: "bg-blue-400" },
  { key: "qualified", label: "Qualified", color: "bg-amber-50 text-amber-800 border-amber-200", barColor: "bg-amber-400" },
  { key: "demo_booked", label: "Demo Booked", color: "bg-purple-50 text-purple-700 border-purple-200", barColor: "bg-purple-400" },
  { key: "converted", label: "Converted", color: "bg-emerald-50 text-emerald-700 border-emerald-200", barColor: "bg-emerald-500" },
  { key: "lost", label: "Lost", color: "bg-red-50 text-red-700 border-red-200", barColor: "bg-red-400" },
];

const STAGE_MAP = Object.fromEntries(STAGES.map((s) => [s.key, s]));

function daysSince(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d)) return null;
  return Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24));
}
function daysLabel(d) {
  if (d == null) return "—";
  if (d === 0) return "today";
  if (d === 1) return "1d";
  if (d < 30) return `${d}d`;
  if (d < 365) return `${Math.floor(d / 30)}mo`;
  return `${Math.floor(d / 365)}y`;
}
function StageBadge({ status }) {
  const s = STAGE_MAP[status];
  if (!s) return <span className="px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider bg-stone-100 text-stone-500 border border-stone-200">{status || "—"}</span>;
  return <span className={`px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider border ${s.color}`}>{s.label}</span>;
}

function sourceLabel(s) {
  return ({
    franchise_enquiry: "Franchise",
    licence_enquiry: "Licence",
    general_enquiry: "General",
    legacy_general_enquiry: "Legacy",
  }[s] || s || "Other");
}

function ContactDrawer({ contact, mode, onClose, onStageChange, onPromote, onDemote, onDelete }) {
  const [busy, setBusy] = useState(false);
  if (!contact) return null;
  const isInPipeline = !!contact.in_pipeline;
  const dateAdded = contact.date || contact.date_added;
  const sinceCreated = daysSince(dateAdded);

  const confirmDelete = async () => {
    if (!window.confirm("Permanently delete this contact? This cannot be undone.")) return;
    setBusy(true);
    try { await onDelete(contact.id); } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex" data-testid="contact-drawer">
      <div className="flex-1 bg-stone-900/40 backdrop-blur-sm" onClick={onClose} />
      <aside className="w-full max-w-xl bg-white border-l border-stone-200 overflow-y-auto shadow-2xl">
        <div className="px-6 py-4 border-b border-stone-200 flex items-center justify-between sticky top-0 bg-white z-10">
          <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-500">
            {isInPipeline ? "Enquiry · Sales Pipeline" : "Contact"}
          </div>
          <div className="flex items-center gap-1">
            <button onClick={confirmDelete} disabled={busy} data-testid="drawer-delete"
              className="px-2 py-1 text-xs font-bold uppercase tracking-wider text-red-700 hover:bg-red-50 flex items-center gap-1 disabled:opacity-50">
              <Trash2 className="w-3.5 h-3.5" /> Delete
            </button>
            <button onClick={onClose} data-testid="drawer-close" className="p-1 text-stone-500 hover:text-stone-950">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
        <div className="p-6 space-y-6">
          <div>
            <h2 className="font-display text-3xl text-stone-950">
              {[contact.first_name, contact.last_name].filter(Boolean).join(" ") || "(no name)"}
            </h2>
            {contact.establishment_name && <div className="text-base text-stone-600 mt-1">{contact.establishment_name}</div>}
            <div className="flex items-center gap-2 flex-wrap mt-3">
              {isInPipeline && <StageBadge status={contact.pipeline_status} />}
              <span className="px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider bg-stone-100 text-stone-700 border border-stone-200">
                {sourceLabel(contact.source)}
              </span>
              {contact.potential && /yes|hot|high/i.test(String(contact.potential)) && (
                <span className="px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider bg-[#D4FF00]/20 border border-[#D4FF00]/60 text-stone-900">Hot Lead</span>
              )}
            </div>
          </div>

          {/* Pipeline controls */}
          {isInPipeline ? (
            <div>
              <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 mb-2">Move to stage</div>
              <div className="grid grid-cols-3 gap-2">
                {STAGES.map((s) => (
                  <button key={s.key} onClick={() => onStageChange(contact.id, s.key)} data-testid={`drawer-stage-${s.key}`}
                    className={`px-3 py-2 text-xs font-bold uppercase tracking-wider border transition-colors ${
                      contact.pipeline_status === s.key ? `${s.color} border-current` : "bg-white text-stone-700 border-stone-300 hover:bg-stone-50"
                    }`}>{s.label}</button>
                ))}
              </div>
              <button onClick={() => onDemote(contact.id)} data-testid="drawer-demote"
                className="mt-3 px-3 py-2 text-xs font-bold uppercase tracking-wider border border-stone-300 bg-white text-stone-700 hover:bg-stone-50 flex items-center gap-1.5">
                <ArrowDownCircle className="w-3.5 h-3.5" /> Remove from sales pipeline
              </button>
            </div>
          ) : (
            <div className="p-4 bg-stone-50 border border-stone-200">
              <div className="text-sm font-semibold text-stone-900 mb-1">Not in the sales pipeline</div>
              <div className="text-xs text-stone-600 mb-3">This is a general contact. Promote them to the sales pipeline to track them as a potential franchise lead.</div>
              <button onClick={() => onPromote(contact.id)} data-testid="drawer-promote"
                className="px-4 py-2 text-xs font-bold uppercase tracking-wider bg-[#D4FF00] text-stone-950 hover:bg-[#BDE600] flex items-center gap-1.5">
                <ArrowUpCircle className="w-3.5 h-3.5" /> Promote to sales pipeline
              </button>
            </div>
          )}

          {/* Contact info */}
          <div className="bg-stone-50 border border-stone-200 p-4 space-y-3 text-sm">
            {(contact.email || contact.email_raw) && (
              <div className="flex items-start gap-2">
                <Mail className="w-3.5 h-3.5 text-stone-400 mt-1" />
                <a href={`mailto:${contact.email || contact.email_raw}`} className="text-stone-900 hover:underline">{contact.email || contact.email_raw}</a>
              </div>
            )}
            {(contact.telephone || contact.mobile_phone) && (
              <div className="flex items-start gap-2">
                <Phone className="w-3.5 h-3.5 text-stone-400 mt-1" />
                <span className="text-stone-900">{contact.telephone || contact.mobile_phone}</span>
              </div>
            )}
            {(contact.address_street || contact.city || contact.postcode) && (
              <div className="flex items-start gap-2">
                <MapPin className="w-3.5 h-3.5 text-stone-400 mt-1" />
                <span className="text-stone-900">{[contact.address_street, contact.city, contact.county, contact.postcode].filter(Boolean).join(", ")}</span>
              </div>
            )}
            {dateAdded && (
              <div className="flex items-start gap-2">
                <Calendar className="w-3.5 h-3.5 text-stone-400 mt-1" />
                <span className="text-stone-900">{String(dateAdded).slice(0, 10)} <span className="text-stone-500">· {sinceCreated} days ago</span></span>
              </div>
            )}
          </div>

          {/* Sales metadata (only for pipeline items) */}
          {isInPipeline && (
            <div>
              <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 mb-2">Sales Notes</div>
              <div className="bg-white border border-stone-200 divide-y divide-stone-100 text-sm">
                {[
                  ["Response Sent", contact.response_sent], ["Email Opened", contact.email_opened],
                  ["Potential", contact.potential], ["Price Tier", contact.price_tier],
                  ["Had a Map", contact.had_a_map], ["Shadow Booked", contact.shadow_booked],
                  ["Follow Up Needed", contact.follow_up_needed], ["Country", contact.country_tag],
                ].filter(([, v]) => v != null && v !== "").map(([k, v]) => (
                  <div key={k} className="px-3 py-2 flex justify-between gap-3">
                    <span className="text-xs uppercase tracking-wider text-stone-500 font-bold">{k}</span>
                    <span className="text-stone-900 text-right">{Array.isArray(v) ? v.join(", ") : String(v)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {(contact.why_contacting || contact.message) && (
            <div>
              <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 mb-2">Original Enquiry</div>
              <div className="bg-stone-50 border border-stone-200 p-4 text-sm text-stone-800 leading-relaxed whitespace-pre-wrap">
                {contact.why_contacting && <div className="font-semibold mb-1">{contact.why_contacting}</div>}
                {contact.message}
              </div>
            </div>
          )}

          {contact.notes && (
            <div>
              <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 mb-2">Internal Notes</div>
              <div className="bg-amber-50 border border-amber-200 p-4 text-sm text-stone-800 leading-relaxed whitespace-pre-wrap">{contact.notes}</div>
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}

export default function ContactsPage() {
  // mode = "pipeline" | "contacts"
  const [mode, setMode] = useState("pipeline");
  const [view, setView] = useState("pipeline"); // for pipeline mode: pipeline (kanban) or list
  const [stageFilter, setStageFilter] = useState("");
  const [search, setSearch] = useState("");
  const [data, setData] = useState({ items: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState(null);

  const load = async () => {
    setLoading(true);
    try {
      const params = { search: search || undefined, limit: 2000 };
      if (mode === "pipeline") {
        params.in_pipeline = true;
        if (stageFilter) params.pipeline_status = stageFilter;
      } else {
        params.in_pipeline = false;
      }
      const { data } = await api.get("/contacts", { params });
      setData(data);
    } catch (e) { setError("Could not load contacts."); }
    finally { setLoading(false); }
  };

  useEffect(() => {
    const t = setTimeout(load, search ? 250 : 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, stageFilter, search]);

  const updateStage = async (contactId, newStage) => {
    try {
      await api.patch(`/contacts/${contactId}/pipeline`, { pipeline_status: newStage });
      setData((d) => ({ ...d, items: d.items.map((c) => (c.id === contactId ? { ...c, pipeline_status: newStage } : c)) }));
      setSelected((sel) => sel && sel.id === contactId ? { ...sel, pipeline_status: newStage } : sel);
    } catch (e) { /* noop */ }
  };

  const promote = async (contactId) => {
    try {
      await api.patch(`/contacts/${contactId}/promote`);
      setSelected(null);
      load();
    } catch (e) { setError("Could not promote contact."); }
  };

  const demote = async (contactId) => {
    if (!window.confirm("Remove this contact from the sales pipeline? They'll move to General Contacts.")) return;
    try {
      await api.patch(`/contacts/${contactId}/demote`);
      setSelected(null);
      load();
    } catch (e) { setError("Could not remove from pipeline."); }
  };

  const remove = async (contactId) => {
    try {
      await api.delete(`/contacts/${contactId}`);
      setSelected(null);
      setData((d) => ({ ...d, items: d.items.filter((c) => c.id !== contactId) }));
    } catch (e) { setError("Could not delete contact."); }
  };

  const grouped = useMemo(() => {
    const g = STAGES.reduce((acc, s) => ({ ...acc, [s.key]: [] }), {});
    data.items.forEach((c) => {
      const stage = c.pipeline_status && g[c.pipeline_status] ? c.pipeline_status : "new";
      g[stage].push(c);
    });
    return g;
  }, [data.items]);

  const stats = useMemo(() => {
    const s = { total: data.items.length };
    STAGES.forEach((stg) => { s[stg.key] = (grouped[stg.key] || []).length; });
    return s;
  }, [data.items, grouped]);

  return (
    <div className="min-h-screen">
      <div className="h-16 border-b border-stone-200 bg-white flex items-center px-8 sticky top-0 z-10" data-testid="topbar">
        <div className="flex items-baseline gap-3 flex-1">
          <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-500">CRM</div>
          <h1 className="font-display text-xl text-stone-950">
            {mode === "pipeline" ? "Sales Pipeline" : "Contacts"}
          </h1>
          <span className="text-xs text-stone-500">{data.total.toLocaleString()} records</span>
        </div>
        <div className="flex items-center gap-3">
          {mode === "pipeline" && (
            <div className="flex border border-stone-300">
              <button onClick={() => setView("list")} data-testid="view-list" className={`px-3 py-2 text-xs font-bold uppercase tracking-wider transition-colors flex items-center gap-1.5 ${view === "list" ? "bg-stone-950 text-white" : "bg-white text-stone-700 hover:bg-stone-50"}`}>
                <LayoutList className="w-3 h-3" /> List
              </button>
              <button onClick={() => setView("pipeline")} data-testid="view-pipeline" className={`px-3 py-2 text-xs font-bold uppercase tracking-wider transition-colors flex items-center gap-1.5 ${view === "pipeline" ? "bg-stone-950 text-white" : "bg-white text-stone-700 hover:bg-stone-50"}`}>
                <Kanban className="w-3 h-3" /> Pipeline
              </button>
            </div>
          )}
          <div className="relative">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-stone-400" />
            <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} data-testid="contact-search"
              placeholder="Search…"
              className="pl-9 pr-3 py-2 w-56 bg-stone-50 border border-stone-300 text-sm focus:outline-none focus:border-stone-900" />
          </div>
        </div>
      </div>

      {/* Mode tabs */}
      <div className="px-8 pt-6">
        <div className="flex border-b border-stone-200 -mb-px" data-testid="mode-tabs">
          {[
            { key: "pipeline", label: "Sales Pipeline", hint: "Franchise & licence enquiries" },
            { key: "contacts", label: "Contacts", hint: "General enquiries & legacy" },
          ].map((tab) => {
            const active = mode === tab.key;
            return (
              <button key={tab.key} onClick={() => { setMode(tab.key); setStageFilter(""); }} data-testid={`mode-${tab.key}`}
                className={`px-5 py-3 text-sm font-bold transition-colors border-b-2 ${
                  active ? "border-stone-950 text-stone-950" : "border-transparent text-stone-500 hover:text-stone-900"
                }`}>
                {tab.label}
                <div className={`text-[10px] font-normal mt-0.5 ${active ? "text-stone-600" : "text-stone-400"}`}>{tab.hint}</div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Pipeline summary bar — pipeline mode only */}
      {mode === "pipeline" && !loading && data.items.length > 0 && (
        <div className="px-8 pt-6">
          <div className="grid grid-cols-2 lg:grid-cols-7 gap-px bg-stone-200 border border-stone-200" data-testid="pipeline-summary">
            <button onClick={() => setStageFilter("")} className={`bg-white p-4 text-left hover:bg-stone-50 ${stageFilter === "" ? "ring-2 ring-stone-950 ring-inset" : ""}`}>
              <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">Total</div>
              <div className="font-display text-2xl text-stone-950">{stats.total.toLocaleString()}</div>
            </button>
            {STAGES.map((s) => (
              <button key={s.key} onClick={() => setStageFilter(s.key === stageFilter ? "" : s.key)} data-testid={`stat-${s.key}`}
                className={`bg-white p-4 text-left hover:bg-stone-50 ${stageFilter === s.key ? "ring-2 ring-stone-950 ring-inset" : ""}`}>
                <div className="flex items-center gap-1.5">
                  <div className={`w-1.5 h-1.5 rounded-full ${s.barColor}`} />
                  <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">{s.label}</div>
                </div>
                <div className="font-display text-2xl text-stone-950">{(stats[s.key] || 0).toLocaleString()}</div>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="p-8 pt-6">
        {error && <div className="mb-4 border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 flex items-center gap-2"><AlertCircle className="w-4 h-4" />{error}</div>}
        {loading ? (
          <div className="text-center text-stone-500 text-sm uppercase tracking-widest p-12 flex items-center justify-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>
        ) : mode === "pipeline" && view === "pipeline" ? (
          /* Kanban */
          <div className="grid grid-cols-2 lg:grid-cols-6 gap-3" data-testid="pipeline-board">
            {STAGES.map((stage) => {
              const items = grouped[stage.key] || [];
              return (
                <div key={stage.key} className="bg-white border border-stone-200" data-testid={`pipeline-column-${stage.key}`}>
                  <div className={`px-3 py-2.5 border-b border-stone-200 ${stage.color.split(" ")[0]}`}>
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-900">{stage.label}</span>
                      <span className="text-xs text-stone-700 font-bold">{items.length}</span>
                    </div>
                  </div>
                  <div className="p-2 space-y-1.5 max-h-[calc(100vh-18rem)] overflow-y-auto">
                    {items.slice(0, 100).map((c) => {
                      const age = daysSince(c.date || c.date_added);
                      const isHot = c.potential && /yes|hot|high/i.test(String(c.potential));
                      return (
                        <div key={c.id} onClick={() => setSelected(c)}
                          className={`bg-white border p-2.5 hover:border-stone-500 cursor-pointer text-xs ${isHot ? "border-[#D4FF00]" : "border-stone-200"}`}
                          data-testid={`pipeline-card-${c.id}`}>
                          <div className="flex items-start justify-between gap-2">
                            <div className="font-semibold text-stone-950 truncate flex-1">{[c.first_name, c.last_name].filter(Boolean).join(" ") || "Unnamed"}</div>
                            {isHot && <span className="text-[9px] font-bold uppercase tracking-wider bg-[#D4FF00] text-stone-950 px-1">Hot</span>}
                          </div>
                          {c.establishment_name && <div className="text-stone-600 truncate mt-0.5">{c.establishment_name}</div>}
                          <div className="flex items-center justify-between mt-1.5 text-[10px]">
                            <div className="text-stone-500">{c.postcode || ""}</div>
                            <div className="text-stone-400">{daysLabel(age)}</div>
                          </div>
                        </div>
                      );
                    })}
                    {items.length === 0 && <div className="text-[10px] text-stone-400 px-1 py-2 text-center">No enquiries</div>}
                    {items.length > 100 && <div className="text-[10px] text-stone-500 px-1">+{items.length - 100} more</div>}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          /* List view (used by both Pipeline-list and Contacts mode) */
          <div className="bg-white border border-stone-200 overflow-hidden" data-testid="contacts-table">
            <table className="w-full">
              <thead className="bg-[#F2F2F0] border-b border-stone-200">
                <tr>
                  <th className="text-left px-3 py-3 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 w-24">Date</th>
                  <th className="text-left px-3 py-3 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600">Name / Establishment</th>
                  <th className="text-left px-3 py-3 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600">Contact</th>
                  <th className="text-left px-3 py-3 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 w-32">Location</th>
                  <th className="text-left px-3 py-3 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 w-28">Source</th>
                  {mode === "pipeline" && <th className="text-left px-3 py-3 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 w-32">Stage</th>}
                  <th className="text-right px-3 py-3 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 w-24">Actions</th>
                </tr>
              </thead>
              <tbody>
                {data.items.length === 0 ? (
                  <tr><td colSpan={mode === "pipeline" ? 7 : 6} className="px-3 py-10 text-center text-sm text-stone-500">No {mode === "pipeline" ? "enquiries" : "contacts"}.</td></tr>
                ) : data.items.slice(0, 500).map((c) => (
                  <tr key={c.id} onClick={() => setSelected(c)} className="border-b border-stone-100 hover:bg-stone-50 cursor-pointer" data-testid={`contact-row-${c.id}`}>
                    <td className="px-3 py-2 text-xs text-stone-500">{(c.date || c.date_added) ? String(c.date || c.date_added).slice(0, 10) : "—"}</td>
                    <td className="px-3 py-2">
                      <div className="text-sm text-stone-950 font-semibold">{[c.first_name, c.last_name].filter(Boolean).join(" ") || "(no name)"}</div>
                      {c.establishment_name && <div className="text-xs text-stone-600">{c.establishment_name}</div>}
                    </td>
                    <td className="px-3 py-2 text-xs text-stone-600">
                      <div>{c.email || c.email_raw || "—"}</div>
                      <div className="text-stone-400">{c.telephone || c.mobile_phone || ""}</div>
                    </td>
                    <td className="px-3 py-2 text-xs text-stone-700">{[c.city, c.postcode].filter(Boolean).join(" · ") || "—"}</td>
                    <td className="px-3 py-2 text-xs text-stone-700">{sourceLabel(c.source)}</td>
                    {mode === "pipeline" && <td className="px-3 py-2"><StageBadge status={c.pipeline_status} /></td>}
                    <td className="px-3 py-2 text-right">
                      {mode === "contacts" ? (
                        <button onClick={(e) => { e.stopPropagation(); promote(c.id); }} data-testid={`row-promote-${c.id}`}
                          className="text-xs font-bold uppercase tracking-wider text-emerald-700 hover:text-emerald-900 flex items-center gap-1 ml-auto">
                          <ArrowUpCircle className="w-3 h-3" /> Promote
                        </button>
                      ) : (
                        <span className="text-xs text-stone-400">{daysLabel(daysSince(c.date || c.date_added))}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {data.items.length > 500 && (
              <div className="px-3 py-2 text-xs text-stone-500 border-t border-stone-100">Showing first 500 of {data.items.length.toLocaleString()}.</div>
            )}
          </div>
        )}
      </div>

      <ContactDrawer contact={selected} mode={mode} onClose={() => setSelected(null)}
        onStageChange={updateStage} onPromote={promote} onDemote={demote} onDelete={remove} />
    </div>
  );
}
