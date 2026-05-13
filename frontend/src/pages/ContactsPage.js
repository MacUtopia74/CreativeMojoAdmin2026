import { useEffect, useState } from "react";
import api from "@/lib/api";
import { Search, AlertCircle, LayoutList, Kanban } from "lucide-react";

const STAGES = [
  { key: "new", label: "New", color: "bg-stone-100 text-stone-700 border-stone-300" },
  { key: "contacted", label: "Contacted", color: "bg-blue-50 text-blue-700 border-blue-200" },
  { key: "qualified", label: "Qualified", color: "bg-amber-50 text-amber-800 border-amber-200" },
  { key: "demo_booked", label: "Demo Booked", color: "bg-purple-50 text-purple-700 border-purple-200" },
  { key: "converted", label: "Converted", color: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  { key: "lost", label: "Lost", color: "bg-red-50 text-red-700 border-red-200" },
];

const STAGE_MAP = Object.fromEntries(STAGES.map((s) => [s.key, s]));

function StageBadge({ status }) {
  const s = STAGE_MAP[status];
  if (!s) return <span className="px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider bg-stone-100 text-stone-500 border border-stone-200">{status || "—"}</span>;
  return <span className={`px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider border ${s.color}`}>{s.label}</span>;
}

export default function ContactsPage() {
  const [view, setView] = useState("list"); // "list" or "pipeline"
  const [source, setSource] = useState("franchise_enquiry"); // default to the active sales pipeline
  const [search, setSearch] = useState("");
  const [data, setData] = useState({ items: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const { data } = await api.get("/contacts", {
          params: { source: source || undefined, search: search || undefined, limit: 1000 },
        });
        setData(data);
      } catch (e) { setError("Could not load contacts."); }
      finally { setLoading(false); }
    }, search ? 250 : 0);
    return () => clearTimeout(t);
  }, [source, search]);

  const updateStage = async (contactId, newStage) => {
    try {
      await api.patch(`/contacts/${contactId}/pipeline`, { pipeline_status: newStage });
      setData((d) => ({
        ...d,
        items: d.items.map((c) => (c.id === contactId ? { ...c, pipeline_status: newStage } : c)),
      }));
    } catch (e) { /* noop */ }
  };

  const grouped = STAGES.reduce((acc, s) => ({ ...acc, [s.key]: [] }), {});
  data.items.forEach((c) => {
    const stage = c.pipeline_status && grouped[c.pipeline_status] ? c.pipeline_status : "new";
    grouped[stage].push(c);
  });

  return (
    <div className="min-h-screen">
      <div className="h-16 border-b border-stone-200 bg-white flex items-center px-8 sticky top-0 z-10" data-testid="topbar">
        <div className="flex items-baseline gap-3 flex-1">
          <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-500">CRM</div>
          <h1 className="font-display font-black text-xl text-stone-950 tracking-tight">Contacts</h1>
          <span className="text-xs text-stone-500 font-mono">{data.total} records</span>
        </div>
        <div className="flex items-center gap-3">
          {/* Source filter */}
          <select
            value={source}
            onChange={(e) => setSource(e.target.value)}
            data-testid="contact-source"
            className="px-3 py-2 bg-stone-50 border border-stone-300 text-xs font-semibold focus:outline-none focus:border-stone-900"
          >
            <option value="">All sources</option>
            <option value="franchise_enquiry">Franchise enquiries</option>
            <option value="legacy_general_enquiry">Legacy general</option>
          </select>
          {/* View toggle */}
          <div className="flex border border-stone-300">
            <button onClick={() => setView("list")} data-testid="view-list" className={`px-3 py-2 text-xs font-bold uppercase tracking-wider transition-colors flex items-center gap-1.5 ${view === "list" ? "bg-stone-950 text-white" : "bg-white text-stone-700 hover:bg-stone-50"}`}>
              <LayoutList className="w-3 h-3" /> List
            </button>
            <button onClick={() => setView("pipeline")} data-testid="view-pipeline" className={`px-3 py-2 text-xs font-bold uppercase tracking-wider transition-colors flex items-center gap-1.5 ${view === "pipeline" ? "bg-stone-950 text-white" : "bg-white text-stone-700 hover:bg-stone-50"}`}>
              <Kanban className="w-3 h-3" /> Pipeline
            </button>
          </div>
          {/* Search */}
          <div className="relative">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-stone-400" />
            <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} data-testid="contact-search"
              placeholder="Search…"
              className="pl-9 pr-3 py-2 w-56 bg-stone-50 border border-stone-300 text-sm focus:outline-none focus:border-stone-900" />
          </div>
        </div>
      </div>

      <div className="p-8">
        {error && <div className="mb-4 border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 flex items-center gap-2"><AlertCircle className="w-4 h-4" />{error}</div>}
        {loading ? (
          <div className="text-center text-stone-500 text-sm font-mono uppercase tracking-widest p-12">Loading…</div>
        ) : view === "list" ? (
          <div className="bg-white border border-stone-200 overflow-hidden" data-testid="contacts-table">
            <table className="w-full">
              <thead className="bg-[#F2F2F0] border-b border-stone-200">
                <tr>
                  <th className="text-left px-3 py-3 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 w-28">Date</th>
                  <th className="text-left px-3 py-3 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600">Name</th>
                  <th className="text-left px-3 py-3 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600">Email / Phone</th>
                  <th className="text-left px-3 py-3 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600">Location</th>
                  <th className="text-left px-3 py-3 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600">Establishment</th>
                  <th className="text-left px-3 py-3 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 w-32">Source</th>
                  <th className="text-left px-3 py-3 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 w-36">Pipeline</th>
                </tr>
              </thead>
              <tbody>
                {data.items.length === 0 ? (
                  <tr><td colSpan={7} className="px-3 py-10 text-center text-sm text-stone-500">No contacts.</td></tr>
                ) : data.items.slice(0, 500).map((c) => (
                  <tr key={c.id} className="border-b border-stone-100 hover:bg-stone-50" data-testid={`contact-row-${c.id}`}>
                    <td className="px-3 py-2 text-xs text-stone-500 font-mono">{(c.date || c.date_added) ? String(c.date || c.date_added).slice(0, 10) : "—"}</td>
                    <td className="px-3 py-2 text-sm text-stone-950 font-semibold">{[c.first_name, c.last_name].filter(Boolean).join(" ") || "—"}</td>
                    <td className="px-3 py-2 text-xs text-stone-600 font-mono">
                      <div>{c.email || c.email_raw || "—"}</div>
                      <div className="text-stone-400">{c.telephone || c.mobile_phone || ""}</div>
                    </td>
                    <td className="px-3 py-2 text-xs text-stone-700">{[c.city, c.postcode].filter(Boolean).join(", ") || "—"}</td>
                    <td className="px-3 py-2 text-xs text-stone-700">{c.establishment_name || "—"}</td>
                    <td className="px-3 py-2 text-xs text-stone-700">
                      {c.source === "franchise_enquiry" ? "Franchise" : c.source === "legacy_general_enquiry" ? "Legacy" : c.source || "—"}
                    </td>
                    <td className="px-3 py-2">
                      <select
                        value={c.pipeline_status || "new"}
                        onChange={(e) => updateStage(c.id, e.target.value)}
                        data-testid={`pipeline-select-${c.id}`}
                        className="text-xs font-semibold bg-white border border-stone-200 px-1 py-0.5 focus:outline-none focus:border-stone-900"
                      >
                        {STAGES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                        <option value="archive">Archive</option>
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {data.items.length > 500 && (
              <div className="px-3 py-2 text-xs text-stone-500 font-mono border-t border-stone-100">Showing first 500 of {data.items.length}. Use search or filters to narrow.</div>
            )}
          </div>
        ) : (
          /* Pipeline / Kanban view */
          <div className="grid grid-cols-2 lg:grid-cols-6 gap-3" data-testid="pipeline-board">
            {STAGES.map((stage) => {
              const items = grouped[stage.key] || [];
              return (
                <div key={stage.key} className="bg-white border border-stone-200" data-testid={`pipeline-column-${stage.key}`}>
                  <div className={`px-3 py-2 border-b border-stone-200 ${stage.color.split(" ")[0]}`}>
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-900">{stage.label}</span>
                      <span className="text-xs text-stone-700 font-mono">{items.length}</span>
                    </div>
                  </div>
                  <div className="p-2 space-y-2 max-h-[calc(100vh-12rem)] overflow-y-auto">
                    {items.slice(0, 100).map((c) => (
                      <div key={c.id} className="bg-white border border-stone-200 p-2.5 hover:border-stone-400 transition-colors cursor-pointer text-xs" data-testid={`pipeline-card-${c.id}`}>
                        <div className="font-semibold text-stone-950">{[c.first_name, c.last_name].filter(Boolean).join(" ") || "Unnamed"}</div>
                        {c.establishment_name && <div className="text-stone-600 truncate mt-0.5">{c.establishment_name}</div>}
                        <div className="text-stone-500 font-mono mt-0.5">{c.postcode || ""}</div>
                        <div className="text-stone-400 font-mono mt-0.5 text-[10px]">{(c.date || c.date_added) ? String(c.date || c.date_added).slice(0, 10) : ""}</div>
                        <select
                          value={c.pipeline_status || "new"}
                          onChange={(e) => updateStage(c.id, e.target.value)}
                          onClick={(e) => e.stopPropagation()}
                          className="w-full mt-1.5 text-[10px] bg-stone-50 border border-stone-200 px-1 py-0.5"
                        >
                          {STAGES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                          <option value="archive">Archive</option>
                        </select>
                      </div>
                    ))}
                    {items.length > 100 && <div className="text-[10px] text-stone-500 px-1">+{items.length - 100} more</div>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
