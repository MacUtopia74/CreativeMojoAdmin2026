import { useEffect, useState, useMemo } from "react";
import api from "@/lib/api";
import { Search, AlertCircle, LayoutList, Kanban, X, Mail, Phone, MapPin, Calendar, Trash2, ArrowUpCircle, ArrowDownCircle, Loader2, Users, Briefcase, ArrowRightLeft, ChevronDown, CheckSquare, Square } from "lucide-react";

const STAGES = [
  { key: "new", label: "New", color: "bg-stone-100 text-stone-700 border-stone-300", barColor: "bg-stone-400" },
  { key: "contacted", label: "Contacted", color: "bg-blue-50 text-blue-700 border-blue-200", barColor: "bg-blue-400" },
  { key: "qualified", label: "Qualified", color: "bg-amber-50 text-amber-800 border-amber-200", barColor: "bg-amber-400" },
  { key: "demo_booked", label: "Demo Booked", color: "bg-purple-50 text-purple-700 border-purple-200", barColor: "bg-purple-400" },
  { key: "converted", label: "Converted", color: "bg-emerald-50 text-emerald-700 border-emerald-200", barColor: "bg-emerald-500" },
  { key: "lost", label: "Lost", color: "bg-red-50 text-red-700 border-red-200", barColor: "bg-red-400" },
];

const STAGE_MAP = Object.fromEntries(STAGES.map((s) => [s.key, s]));

const TABS = [
  { key: "pipeline", label: "Sales Pipeline", hint: "Potential franchisees being actively worked", icon: Briefcase },
  { key: "franchise", label: "Franchise Contacts", hint: "Franchise & licence enquiries not in the pipeline", icon: Users },
  { key: "general", label: "General Contacts", hint: "General enquiries & legacy contacts", icon: Users },
];

function daysSince(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr); if (isNaN(d)) return null;
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
  if (!s) return <span className="px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider bg-stone-100 text-stone-500 border border-stone-200 rounded-full">{status || "—"}</span>;
  return <span className={`px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider border rounded-full ${s.color}`}>{s.label}</span>;
}
function sourceLabel(s) {
  return ({ franchise_enquiry: "Franchise", licence_enquiry: "Licence", general_enquiry: "General", legacy_general_enquiry: "Legacy" }[s] || s || "Other");
}

// Compact "Move to…" dropdown used both on rows (compact) and the bulk action bar
function MoveMenu({ onMove, label = "Move", testid, currentTab, count }) {
  const [open, setOpen] = useState(false);
  const [showStages, setShowStages] = useState(false);
  const close = () => { setOpen(false); setShowStages(false); };
  return (
    <div className="relative inline-block" onMouseLeave={close} data-testid={testid}>
      <button onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); setShowStages(false); }}
        className="px-2.5 py-1 text-xs font-bold uppercase tracking-wider bg-white border border-stone-300 text-stone-800 hover:bg-stone-50 rounded-lg flex items-center gap-1"
        data-testid={`${testid}-trigger`}>
        <ArrowRightLeft className="w-3 h-3" /> {label}{count != null && count > 0 ? ` (${count})` : ""}
        <ChevronDown className="w-3 h-3" />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 w-60 bg-white border border-stone-200 rounded-xl shadow-lg overflow-hidden text-sm text-stone-900">
          {!showStages ? (
            <>
              <button onClick={(e) => { e.stopPropagation(); setShowStages(true); }} data-testid={`${testid}-pipeline`}
                disabled={currentTab === "pipeline"}
                className="w-full text-left px-3 py-2 hover:bg-stone-50 disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-between">
                <span className="flex items-center gap-2"><Briefcase className="w-3.5 h-3.5 text-stone-500" /> Sales Pipeline</span>
                <ChevronDown className="w-3 h-3 -rotate-90 text-stone-400" />
              </button>
              <button onClick={(e) => { e.stopPropagation(); onMove("franchise"); close(); }} data-testid={`${testid}-franchise`}
                disabled={currentTab === "franchise"}
                className="w-full text-left px-3 py-2 hover:bg-stone-50 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2">
                <Users className="w-3.5 h-3.5 text-stone-500" /> Franchise Contacts
              </button>
              <button onClick={(e) => { e.stopPropagation(); onMove("general"); close(); }} data-testid={`${testid}-general`}
                disabled={currentTab === "general"}
                className="w-full text-left px-3 py-2 hover:bg-stone-50 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2">
                <Users className="w-3.5 h-3.5 text-stone-500" /> General Contacts
              </button>
            </>
          ) : (
            <>
              <div className="px-3 py-2 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 bg-stone-50 border-b border-stone-200">
                Move to pipeline stage
              </div>
              {STAGES.map((s) => (
                <button key={s.key} onClick={(e) => { e.stopPropagation(); onMove("pipeline", s.key); close(); }}
                  data-testid={`${testid}-stage-${s.key}`}
                  className="w-full text-left px-3 py-2 hover:bg-stone-50 flex items-center gap-2">
                  <span className={`w-1.5 h-1.5 rounded-full ${s.barColor}`} />
                  {s.label}
                </button>
              ))}
              <button onClick={(e) => { e.stopPropagation(); setShowStages(false); }} className="w-full text-left px-3 py-2 hover:bg-stone-50 text-stone-500 border-t border-stone-100 text-xs">
                ← Back
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function ContactDrawer({ contact, onClose, onStageChange, onPromote, onDemote, onDelete }) {
  const [busy, setBusy] = useState(false);
  if (!contact) return null;
  const isInPipeline = !!contact.in_pipeline;
  const dateAdded = contact.date || contact.date_added;
  const sinceCreated = daysSince(dateAdded);
  const isFranchiseEnq = ["franchise_enquiry", "licence_enquiry"].includes(contact.source);

  const confirmDelete = async () => {
    if (!window.confirm("Permanently delete this contact? This cannot be undone.")) return;
    setBusy(true); try { await onDelete(contact.id); } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex" data-testid="contact-drawer">
      <div className="flex-1 bg-stone-900/40 backdrop-blur-sm" onClick={onClose} />
      <aside className="w-full max-w-xl bg-white border-l border-stone-200 overflow-y-auto shadow-2xl">
        <div className="px-6 py-4 border-b border-stone-200 flex items-center justify-between sticky top-0 bg-white z-10">
          <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-500">
            {isInPipeline ? "Sales Pipeline" : isFranchiseEnq ? "Franchise Contact" : "General Contact"}
          </div>
          <div className="flex items-center gap-1">
            <button onClick={confirmDelete} disabled={busy} data-testid="drawer-delete"
              className="px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-red-700 hover:bg-red-50 rounded-lg flex items-center gap-1 disabled:opacity-50">
              <Trash2 className="w-3.5 h-3.5" /> Delete
            </button>
            <button onClick={onClose} data-testid="drawer-close" className="p-2 text-stone-500 hover:text-stone-950 rounded-lg hover:bg-stone-100">
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
              <span className="px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider bg-stone-100 text-stone-700 border border-stone-200 rounded-full">
                {sourceLabel(contact.source)}
              </span>
              {contact.potential && /yes|hot|high/i.test(String(contact.potential)) && (
                <span className="px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider bg-[#D4FF00]/20 border border-[#D4FF00]/60 text-stone-900 rounded-full">Hot Lead</span>
              )}
            </div>
          </div>

          {isInPipeline ? (
            <div>
              <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 mb-2">Move to stage</div>
              <div className="grid grid-cols-3 gap-2">
                {STAGES.map((s) => (
                  <button key={s.key} onClick={() => onStageChange(contact.id, s.key)} data-testid={`drawer-stage-${s.key}`}
                    className={`px-3 py-2 text-xs font-bold uppercase tracking-wider border rounded-lg transition-colors ${
                      contact.pipeline_status === s.key ? `${s.color} border-current` : "bg-white text-stone-700 border-stone-300 hover:bg-stone-50"
                    }`}>{s.label}</button>
                ))}
              </div>
              <button onClick={() => onDemote(contact.id)} data-testid="drawer-demote"
                className="mt-3 px-4 py-2 text-xs font-bold uppercase tracking-wider border border-stone-300 bg-white text-stone-700 hover:bg-stone-50 rounded-lg flex items-center gap-1.5">
                <ArrowDownCircle className="w-3.5 h-3.5" /> Remove from sales pipeline
              </button>
              <div className="text-xs text-stone-500 mt-1.5">
                Will return to <strong>{isFranchiseEnq ? "Franchise Contacts" : "General Contacts"}</strong> based on their source.
              </div>
            </div>
          ) : (
            <div className="p-4 bg-stone-50 border border-stone-200 rounded-xl">
              <div className="text-sm font-semibold text-stone-900 mb-1">Not in the sales pipeline</div>
              <div className="text-xs text-stone-600 mb-3">
                Currently in <strong>{isFranchiseEnq ? "Franchise Contacts" : "General Contacts"}</strong>.
                Promote them to actively work them as a potential franchisee.
              </div>
              <button onClick={() => onPromote(contact.id)} data-testid="drawer-promote"
                className="px-4 py-2 text-xs font-bold uppercase tracking-wider bg-[#D4FF00] text-stone-950 hover:bg-[#BDE600] rounded-lg flex items-center gap-1.5">
                <ArrowUpCircle className="w-3.5 h-3.5" /> Promote to sales pipeline
              </button>
            </div>
          )}

          <div className="bg-stone-50 border border-stone-200 p-4 space-y-3 text-sm rounded-xl">
            {(contact.email || contact.email_raw) && (
              <div className="flex items-start gap-2"><Mail className="w-3.5 h-3.5 text-stone-400 mt-1" />
                <a href={`mailto:${contact.email || contact.email_raw}`} className="text-stone-900 hover:underline">{contact.email || contact.email_raw}</a></div>
            )}
            {(contact.telephone || contact.mobile_phone) && (
              <div className="flex items-start gap-2"><Phone className="w-3.5 h-3.5 text-stone-400 mt-1" />
                <span className="text-stone-900">{contact.telephone || contact.mobile_phone}</span></div>
            )}
            {(contact.address_street || contact.city || contact.postcode) && (
              <div className="flex items-start gap-2"><MapPin className="w-3.5 h-3.5 text-stone-400 mt-1" />
                <span className="text-stone-900">{[contact.address_street, contact.city, contact.county, contact.postcode].filter(Boolean).join(", ")}</span></div>
            )}
            {dateAdded && (
              <div className="flex items-start gap-2"><Calendar className="w-3.5 h-3.5 text-stone-400 mt-1" />
                <span className="text-stone-900">{String(dateAdded).slice(0, 10)} <span className="text-stone-500">· {sinceCreated} days ago</span></span></div>
            )}
          </div>

          {isInPipeline && (
            <div>
              <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 mb-2">Sales Notes</div>
              <div className="bg-white border border-stone-200 divide-y divide-stone-100 text-sm rounded-xl overflow-hidden">
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
              <div className="bg-stone-50 border border-stone-200 p-4 text-sm text-stone-800 leading-relaxed whitespace-pre-wrap rounded-xl">
                {contact.why_contacting && <div className="font-semibold mb-1">{contact.why_contacting}</div>}
                {contact.message}
              </div>
            </div>
          )}

          {contact.notes && (
            <div>
              <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 mb-2">Internal Notes</div>
              <div className="bg-amber-50 border border-amber-200 p-4 text-sm text-stone-800 leading-relaxed whitespace-pre-wrap rounded-xl">{contact.notes}</div>
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}

export default function ContactsPage() {
  const [tab, setTab] = useState("pipeline");
  const [view, setView] = useState("pipeline");
  const [stageFilter, setStageFilter] = useState("");
  const [search, setSearch] = useState("");
  const [data, setData] = useState({ items: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState(null);
  const [selectedIds, setSelectedIds] = useState(() => new Set());

  const clearSelection = () => setSelectedIds(new Set());
  const toggleSelect = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const load = async () => {
    setLoading(true);
    try {
      const params = { tab, search: search || undefined, limit: 2000 };
      if (tab === "pipeline" && stageFilter) params.pipeline_status = stageFilter;
      const { data } = await api.get("/contacts", { params });
      setData(data);
    } catch (e) { setError("Could not load contacts."); }
    finally { setLoading(false); }
  };

  useEffect(() => {
    const t = setTimeout(load, search ? 250 : 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, stageFilter, search]);

  // Reset selection whenever the tab/filter changes
  useEffect(() => { clearSelection(); }, [tab, stageFilter]);

  const moveContact = async (contactId, target, pipeline_status) => {
    try {
      await api.post(`/contacts/${contactId}/move`, { target, pipeline_status });
      setSelected(null);
      setData((d) => ({ ...d, items: d.items.filter((c) => c.id !== contactId) }));
      setSelectedIds((prev) => { const n = new Set(prev); n.delete(contactId); return n; });
    } catch (e) { setError("Could not move contact."); }
  };

  const bulkMove = async (target, pipeline_status) => {
    const ids = Array.from(selectedIds);
    if (!ids.length) return;
    if (!window.confirm(`Move ${ids.length} contact${ids.length === 1 ? "" : "s"} to ${target === "pipeline" ? "Sales Pipeline" : target === "franchise" ? "Franchise Contacts" : "General Contacts"}?`)) return;
    try {
      await api.post(`/contacts/bulk-move`, { ids, target, pipeline_status });
      setData((d) => ({ ...d, items: d.items.filter((c) => !selectedIds.has(c.id)) }));
      clearSelection();
    } catch (e) { setError("Could not move contacts."); }
  };

  const updateStage = async (contactId, newStage) => {
    try {
      await api.patch(`/contacts/${contactId}/pipeline`, { pipeline_status: newStage });
      setData((d) => ({ ...d, items: d.items.map((c) => (c.id === contactId ? { ...c, pipeline_status: newStage } : c)) }));
      setSelected((sel) => sel && sel.id === contactId ? { ...sel, pipeline_status: newStage } : sel);
    } catch (e) { /* noop */ }
  };

  const promote = async (contactId) => {
    try { await api.patch(`/contacts/${contactId}/promote`); setSelected(null); load(); }
    catch (e) { setError("Could not promote contact."); }
  };

  const demote = async (contactId, target) => {
    if (!window.confirm(`Remove from sales pipeline and return to ${target === "franchise" ? "Franchise Contacts" : "General Contacts"}?`)) return;
    try { await api.patch(`/contacts/${contactId}/demote`); setSelected(null); load(); }
    catch (e) { setError("Could not demote contact."); }
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

  const currentTab = TABS.find((t) => t.key === tab);
  const isPipeline = tab === "pipeline";

  return (
    <div className="min-h-screen">
      <div className="h-16 border-b border-stone-200 bg-white flex items-center px-8 sticky top-0 z-10" data-testid="topbar">
        <div className="flex items-baseline gap-3 flex-1">
          <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-500">CRM</div>
          <h1 className="font-display text-xl text-stone-950">{currentTab?.label}</h1>
          <span className="text-xs text-stone-500">{data.total.toLocaleString()} records</span>
        </div>
        <div className="flex items-center gap-3">
          {isPipeline && (
            <div className="flex border border-stone-300 rounded-lg overflow-hidden">
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
              className="pl-9 pr-3 py-2 w-56 bg-stone-50 border border-stone-300 text-sm focus:outline-none focus:border-stone-900 rounded-lg" />
          </div>
        </div>
      </div>

      <div className="px-8 pt-6">
        <div className="flex gap-1 -mb-px" data-testid="mode-tabs">
          {TABS.map((t) => {
            const active = tab === t.key;
            const Icon = t.icon;
            return (
              <button key={t.key} onClick={() => { setTab(t.key); setStageFilter(""); }} data-testid={`mode-${t.key}`}
                className={`px-5 py-3 text-sm font-bold transition-colors rounded-t-xl flex items-start gap-2 ${
                  active ? "bg-white text-stone-950 border border-stone-200 border-b-white" : "text-stone-500 hover:text-stone-900 hover:bg-stone-100/50"
                }`}>
                <Icon className="w-4 h-4 mt-0.5" />
                <span className="text-left">
                  {t.label}
                  <div className={`text-[10px] font-normal mt-0.5 ${active ? "text-stone-600" : "text-stone-400"}`}>{t.hint}</div>
                </span>
              </button>
            );
          })}
        </div>
        <div className="border-b border-stone-200" />
      </div>

      {/* Bulk action bar — appears when one or more contacts selected */}
      {selectedIds.size > 0 && (
        <div className="px-8 pt-4">
          <div className="bg-stone-950 text-white rounded-2xl px-5 py-3 flex items-center gap-4 shadow-lg" data-testid="bulk-action-bar">
            <div className="flex items-center gap-2">
              <CheckSquare className="w-4 h-4 text-[#D4FF00]" />
              <span className="text-sm font-bold tabular-nums">{selectedIds.size} selected</span>
            </div>
            <div className="flex-1" />
            <MoveMenu onMove={bulkMove} label="Move selected" testid="bulk-move" currentTab={tab} count={selectedIds.size} />
            <button onClick={clearSelection} data-testid="bulk-clear"
              className="px-3 py-1 text-xs font-bold uppercase tracking-wider bg-white/10 hover:bg-white/20 text-white rounded-lg flex items-center gap-1">
              <X className="w-3 h-3" /> Clear
            </button>
          </div>
        </div>
      )}

      {isPipeline && !loading && data.items.length > 0 && (
        <div className="px-8 pt-6">
          <div className="grid grid-cols-2 lg:grid-cols-7 gap-3" data-testid="pipeline-summary">
            <button onClick={() => setStageFilter("")} className={`bg-white border border-stone-200 rounded-2xl p-4 text-left hover:border-stone-400 transition-colors ${stageFilter === "" ? "ring-2 ring-stone-950" : ""}`}>
              <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">Total</div>
              <div className="font-display text-2xl text-stone-950">{stats.total.toLocaleString()}</div>
            </button>
            {STAGES.map((s) => (
              <button key={s.key} onClick={() => setStageFilter(s.key === stageFilter ? "" : s.key)} data-testid={`stat-${s.key}`}
                className={`bg-white border border-stone-200 rounded-2xl p-4 text-left hover:border-stone-400 transition-colors ${stageFilter === s.key ? "ring-2 ring-stone-950" : ""}`}>
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
        {error && <div className="mb-4 border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 flex items-center gap-2 rounded-xl"><AlertCircle className="w-4 h-4" />{error}</div>}
        {loading ? (
          <div className="text-center text-stone-500 text-sm uppercase tracking-widest p-12 flex items-center justify-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>
        ) : isPipeline && view === "pipeline" ? (
          <div className="grid grid-cols-2 lg:grid-cols-6 gap-3" data-testid="pipeline-board">
            {STAGES.map((stage) => {
              const items = grouped[stage.key] || [];
              return (
                <div key={stage.key} className="bg-white border border-stone-200 rounded-2xl overflow-hidden" data-testid={`pipeline-column-${stage.key}`}>
                  <div className={`px-3 py-2.5 border-b border-stone-200 ${stage.color.split(" ")[0]}`}>
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-900">{stage.label}</span>
                      <span className="text-xs text-stone-700 font-bold">{items.length}</span>
                    </div>
                  </div>
                  <div className="p-2 space-y-1.5 max-h-[calc(100vh-22rem)] overflow-y-auto">
                    {items.slice(0, 100).map((c) => {
                      const age = daysSince(c.date || c.date_added);
                      const isHot = c.potential && /yes|hot|high/i.test(String(c.potential));
                      const checked = selectedIds.has(c.id);
                      return (
                        <div key={c.id} onClick={() => setSelected(c)}
                          className={`bg-white border rounded-xl p-2.5 hover:border-stone-500 cursor-pointer text-xs ${isHot ? "border-[#D4FF00]" : "border-stone-200"} ${checked ? "ring-2 ring-stone-950" : ""}`}
                          data-testid={`pipeline-card-${c.id}`}>
                          <div className="flex items-start justify-between gap-2">
                            <button onClick={(e) => { e.stopPropagation(); toggleSelect(c.id); }} data-testid={`card-select-${c.id}`} className="shrink-0 text-stone-400 hover:text-stone-950">
                              {checked ? <CheckSquare className="w-3.5 h-3.5 text-stone-950" /> : <Square className="w-3.5 h-3.5" />}
                            </button>
                            <div className="font-semibold text-stone-950 truncate flex-1">{[c.first_name, c.last_name].filter(Boolean).join(" ") || "Unnamed"}</div>
                            {isHot && <span className="text-[9px] font-bold uppercase tracking-wider bg-[#D4FF00] text-stone-950 px-1 rounded">Hot</span>}
                          </div>
                          {c.establishment_name && <div className="text-stone-600 truncate mt-0.5 pl-5">{c.establishment_name}</div>}
                          <div className="flex items-center justify-between mt-1.5 text-[10px] pl-5">
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
          <div className="bg-white border border-stone-200 rounded-2xl overflow-hidden" data-testid="contacts-table">
            <table className="w-full">
              <thead className="bg-[#F2F2F0] border-b border-stone-200">
                <tr>
                  <th className="px-3 py-3 w-10">
                    <button onClick={(e) => {
                      e.stopPropagation();
                      const visibleIds = data.items.slice(0, 500).map((c) => c.id);
                      const allSelected = visibleIds.every((id) => selectedIds.has(id));
                      setSelectedIds(allSelected ? new Set() : new Set(visibleIds));
                    }} data-testid="select-all" className="text-stone-500 hover:text-stone-900">
                      {data.items.length > 0 && data.items.slice(0, 500).every((c) => selectedIds.has(c.id)) ?
                        <CheckSquare className="w-4 h-4" /> : <Square className="w-4 h-4" />}
                    </button>
                  </th>
                  <th className="text-left px-3 py-3 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 w-24">Date</th>
                  <th className="text-left px-3 py-3 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600">Name / Establishment</th>
                  <th className="text-left px-3 py-3 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600">Contact</th>
                  <th className="text-left px-3 py-3 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 w-32">Location</th>
                  <th className="text-left px-3 py-3 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 w-28">Source</th>
                  {isPipeline && <th className="text-left px-3 py-3 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 w-32">Stage</th>}
                  <th className="text-right px-3 py-3 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 w-32">Move</th>
                </tr>
              </thead>
              <tbody>
                {data.items.length === 0 ? (
                  <tr><td colSpan={isPipeline ? 8 : 7} className="px-3 py-10 text-center text-sm text-stone-500">No records.</td></tr>
                ) : data.items.slice(0, 500).map((c) => {
                  const checked = selectedIds.has(c.id);
                  return (
                  <tr key={c.id} onClick={() => setSelected(c)} className={`border-b border-stone-100 last:border-0 hover:bg-stone-50 cursor-pointer ${checked ? "bg-[#D4FF00]/5" : ""}`} data-testid={`contact-row-${c.id}`}>
                    <td className="px-3 py-2" onClick={(e) => { e.stopPropagation(); toggleSelect(c.id); }}>
                      <button data-testid={`select-${c.id}`} className="text-stone-500 hover:text-stone-900">
                        {checked ? <CheckSquare className="w-4 h-4 text-stone-950" /> : <Square className="w-4 h-4" />}
                      </button>
                    </td>
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
                    {isPipeline && <td className="px-3 py-2"><StageBadge status={c.pipeline_status} /></td>}
                    <td className="px-3 py-2 text-right" onClick={(e) => e.stopPropagation()}>
                      <MoveMenu onMove={(target, stage) => moveContact(c.id, target, stage)} label="Move" testid={`row-move-${c.id}`} currentTab={tab} />
                    </td>
                  </tr>
                );
                })}
              </tbody>
            </table>
            {data.items.length > 500 && (
              <div className="px-3 py-2 text-xs text-stone-500 border-t border-stone-100">Showing first 500 of {data.items.length.toLocaleString()}.</div>
            )}
          </div>
        )}
      </div>

      <ContactDrawer contact={selected} onClose={() => setSelected(null)}
        onStageChange={updateStage} onPromote={promote}
        onDemote={(id) => demote(id, selected?.source?.includes("franchise") || selected?.source?.includes("licence") ? "franchise" : "general")}
        onDelete={remove} />
    </div>
  );
}
