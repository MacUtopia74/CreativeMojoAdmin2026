import { useEffect, useState, useMemo, useCallback, useRef } from "react";
import api from "@/lib/api";
import { Database, AlertCircle, ChevronRight, RefreshCw, Check, X, Edit3, Combine, HelpCircle, Save } from "lucide-react";

function PageHeader({ subtitle, title, right }) {
  return (
    <div className="h-16 border-b border-stone-200 bg-white flex items-center px-8 sticky top-0 z-10" data-testid="topbar">
      <div className="flex items-baseline gap-3 flex-1">
        <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-500">{subtitle}</div>
        <h1 className="font-display font-black text-xl text-stone-950 tracking-tight">{title}</h1>
      </div>
      {right}
    </div>
  );
}

function fieldTypeColor(type) {
  const t = (type || "").toLowerCase();
  if (t.includes("text") || t.includes("rich")) return "bg-stone-100 text-stone-700";
  if (t.includes("email") || t.includes("url") || t.includes("phone")) return "bg-blue-50 text-blue-700";
  if (t.includes("number") || t.includes("currency") || t.includes("percent") || t.includes("count")) return "bg-amber-50 text-amber-800";
  if (t.includes("date")) return "bg-purple-50 text-purple-700";
  if (t.includes("checkbox") || t.includes("rating") || t.includes("select")) return "bg-emerald-50 text-emerald-700";
  if (t.includes("attachment") || t.includes("image")) return "bg-pink-50 text-pink-700";
  if (t.includes("link") || t.includes("lookup") || t.includes("rollup") || t.includes("formula")) return "bg-stone-200 text-stone-800";
  return "bg-stone-100 text-stone-700";
}

const DECISION_OPTS = [
  { value: "undecided", label: "Undecided", icon: HelpCircle, color: "text-stone-500", bg: "bg-stone-50" },
  { value: "keep", label: "Keep", icon: Check, color: "text-emerald-700", bg: "bg-emerald-50" },
  { value: "rename", label: "Rename", icon: Edit3, color: "text-blue-700", bg: "bg-blue-50" },
  { value: "merge", label: "Merge", icon: Combine, color: "text-purple-700", bg: "bg-purple-50" },
  { value: "drop", label: "Drop", icon: X, color: "text-red-700", bg: "bg-red-50" },
];

const DECISION_MAP = Object.fromEntries(DECISION_OPTS.map((d) => [d.value, d]));

function renderFieldValue(value) {
  if (value === null || value === undefined) return <span className="text-stone-400">—</span>;
  if (typeof value === "string") return value.length > 80 ? value.slice(0, 80) + "…" : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-stone-400">[]</span>;
    if (typeof value[0] === "object" && value[0]?.url) {
      return <span className="text-pink-700 font-mono text-xs">{value.length} attachment{value.length > 1 ? "s" : ""}</span>;
    }
    if (typeof value[0] === "string" && value[0].startsWith("rec")) {
      return <span className="text-stone-600 font-mono text-xs">{value.length} linked record{value.length > 1 ? "s" : ""}</span>;
    }
    return <span className="font-mono text-xs">{value.slice(0, 3).join(", ")}{value.length > 3 ? "…" : ""}</span>;
  }
  if (typeof value === "object") return <span className="font-mono text-xs text-stone-500">{JSON.stringify(value).slice(0, 60)}</span>;
  return String(value);
}

// ---- Inline editors ----
function DecisionSelect({ value, onChange, testid }) {
  const opt = DECISION_MAP[value] || DECISION_MAP.undecided;
  const Icon = opt.icon;
  return (
    <div className={`inline-flex items-center gap-1.5 px-1 rounded-md ${opt.bg}`}>
      <Icon className={`w-3 h-3 ${opt.color} shrink-0`} />
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        data-testid={testid}
        className={`bg-transparent text-xs font-bold uppercase tracking-wider ${opt.color} border-0 focus:outline-none focus:ring-0 py-1.5 pr-1 cursor-pointer`}
      >
        {DECISION_OPTS.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  );
}

function TextField({ value, onChange, placeholder, testid }) {
  const [v, setV] = useState(value || "");
  const ref = useRef(null);
  useEffect(() => setV(value || ""), [value]);
  return (
    <input
      ref={ref}
      type="text"
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => v !== (value || "") && onChange(v)}
      placeholder={placeholder}
      data-testid={testid}
      className="w-full px-2 py-1 text-xs font-mono bg-white border border-stone-200 focus:outline-none focus:border-stone-900 rounded-md"
    />
  );
}

export default function AirtableInspectorPage() {
  const [tables, setTables] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState(null);
  const [records, setRecords] = useState([]);
  const [recordsLoading, setRecordsLoading] = useState(false);
  const [count, setCount] = useState(null);
  const [countLoading, setCountLoading] = useState(false);

  // Decisions state: { tableDecisions: {table_id: {migrate, notes}}, fieldDecisions: {table_id: {field_id: {...}}} }
  const [tableDecisions, setTableDecisions] = useState({});
  const [fieldDecisions, setFieldDecisions] = useState({});
  const [savingFlash, setSavingFlash] = useState(false);

  const loadDecisions = useCallback(async () => {
    try {
      const { data } = await api.get("/migration/decisions");
      const td = {};
      (data.tables || []).forEach((t) => (td[t.table_id] = t));
      setTableDecisions(td);
      const fd = {};
      (data.fields || []).forEach((f) => {
        fd[f.table_id] = fd[f.table_id] || {};
        fd[f.table_id][f.field_id] = f;
      });
      setFieldDecisions(fd);
    } catch (e) {
      /* noop */
    }
  }, []);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const [schemaRes] = await Promise.all([api.get("/airtable/tables"), loadDecisions()]);
        setTables(schemaRes.data.tables || []);
        if (schemaRes.data.tables?.length) setSelectedId(schemaRes.data.tables[0].id);
      } catch (e) {
        setError("Could not load Airtable schema. Check the PAT in backend/.env.");
      } finally {
        setLoading(false);
      }
    })();
  }, [loadDecisions]);

  const selected = useMemo(() => tables.find((t) => t.id === selectedId), [tables, selectedId]);

  useEffect(() => {
    if (!selectedId) return;
    setRecords([]);
    setCount(null);
    setRecordsLoading(true);
    (async () => {
      try {
        const { data } = await api.get(`/airtable/tables/${selectedId}/records`, { params: { limit: 10 } });
        setRecords(data.records || []);
      } catch (e) {
        setRecords([]);
      } finally {
        setRecordsLoading(false);
      }
    })();
  }, [selectedId]);

  const fetchCount = async () => {
    if (!selectedId) return;
    setCountLoading(true);
    try {
      const { data } = await api.get(`/airtable/tables/${selectedId}/count`);
      setCount(data.count);
    } catch (e) {
      setCount(null);
    } finally {
      setCountLoading(false);
    }
  };

  const flashSaved = () => {
    setSavingFlash(true);
    setTimeout(() => setSavingFlash(false), 800);
  };

  const updateTableDecision = async (patch) => {
    if (!selected) return;
    const prev = tableDecisions[selected.id] || {};
    const next = { ...prev, ...patch };
    setTableDecisions({ ...tableDecisions, [selected.id]: next });
    try {
      await api.post("/migration/decisions/table", {
        table_id: selected.id,
        table_name: selected.name,
        ...patch,
      });
      flashSaved();
    } catch (e) {
      /* noop - keep optimistic update */
    }
  };

  const updateFieldDecision = async (field, patch) => {
    if (!selected) return;
    const existing = fieldDecisions[selected.id]?.[field.id] || {};
    const next = { ...existing, ...patch, field_name: field.name };
    setFieldDecisions({
      ...fieldDecisions,
      [selected.id]: { ...(fieldDecisions[selected.id] || {}), [field.id]: next },
    });
    try {
      await api.post("/migration/decisions/field", {
        table_id: selected.id,
        field_id: field.id,
        field_name: field.name,
        decision: next.decision || "undecided",
        rename_to: next.rename_to ?? null,
        merge_with: next.merge_with ?? null,
        notes: next.notes ?? null,
      });
      flashSaved();
    } catch (e) {
      /* noop */
    }
  };

  // Summary counts for the selected table
  const summary = useMemo(() => {
    if (!selected) return null;
    const counts = { keep: 0, rename: 0, drop: 0, merge: 0, undecided: 0 };
    selected.fields.forEach((f) => {
      const d = fieldDecisions[selected.id]?.[f.id]?.decision || "undecided";
      counts[d] = (counts[d] || 0) + 1;
    });
    return counts;
  }, [selected, fieldDecisions]);

  const currentTableDecision = selected ? (tableDecisions[selected.id] || {}) : {};

  return (
    <div className="min-h-screen">
      <PageHeader
        subtitle="Phase 1 — Schema"
        title="Airtable Inspector"
        right={
          <div className="flex items-center gap-3">
            {savingFlash && (
              <div className="flex items-center gap-1.5 text-xs text-emerald-700 font-bold uppercase tracking-wider">
                <Save className="w-3 h-3" /> Saved
              </div>
            )}
            <a href="/migration-plan" data-testid="goto-plan" className="text-xs font-bold uppercase tracking-wider text-stone-700 hover:text-stone-950">
              View Migration Plan →
            </a>
          </div>
        }
      />

      {loading ? (
        <div className="p-12 text-center text-stone-500 text-sm font-mono uppercase tracking-widest" data-testid="inspector-loading">
          Loading schema…
        </div>
      ) : error ? (
        <div className="m-8 border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 flex items-center gap-2 rounded-xl" data-testid="inspector-error">
          <AlertCircle className="w-4 h-4" /> {error}
        </div>
      ) : (
        <div className="flex h-[calc(100vh-4rem)]">
          {/* Tables list */}
          <div className="w-[300px] border-r border-stone-200 bg-white overflow-y-auto" data-testid="tables-list">
            <div className="px-5 py-4 border-b border-stone-200">
              <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">Tables</div>
            </div>
            {tables.map((t) => {
              const td = tableDecisions[t.id];
              const indicator = td?.migrate === true ? "bg-emerald-500" : td?.migrate === false ? "bg-red-400" : "bg-stone-300";
              return (
                <button
                  key={t.id}
                  onClick={() => setSelectedId(t.id)}
                  data-testid={`table-item-${t.id}`}
                  className={`w-full text-left px-5 py-3 border-b border-stone-100 transition-colors flex items-center gap-2 ${
                    selectedId === t.id ? "bg-[#D4FF00]/15 border-l-2 border-l-[#D4FF00]" : "hover:bg-stone-50 border-l-2 border-l-transparent"
                  }`}
                >
                  <span className={`w-1.5 h-1.5 rounded-full ${indicator} shrink-0`} title={td?.migrate === true ? "Migrate" : td?.migrate === false ? "Skip" : "Undecided"} />
                  <Database className="w-3.5 h-3.5 text-stone-500 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold text-stone-950 truncate">{t.name}</div>
                    <div className="text-[11px] text-stone-500 font-mono">
                      {t.field_count} fields · {t.view_count} views
                    </div>
                  </div>
                  <ChevronRight className={`w-3.5 h-3.5 text-stone-400 ${selectedId === t.id ? "translate-x-0.5 text-stone-700" : ""}`} />
                </button>
              );
            })}
          </div>

          {/* Detail */}
          <div className="flex-1 overflow-y-auto bg-[#F9F9F8]">
            {selected ? (
              <div className="p-8 space-y-8">
                <div>
                  <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">Table</div>
                  <div className="flex items-baseline gap-4 mt-1 flex-wrap">
                    <h2 className="font-display font-black text-3xl text-stone-950 tracking-tight" data-testid="selected-table-name">
                      {selected.name}
                    </h2>
                    <span className="font-mono text-xs text-stone-500">{selected.id}</span>
                  </div>
                  <div className="flex items-center gap-4 mt-3 text-sm flex-wrap">
                    <span className="text-stone-700"><strong>{selected.field_count}</strong> fields</span>
                    <span className="text-stone-700"><strong>{selected.view_count}</strong> views</span>
                    <button
                      onClick={fetchCount}
                      disabled={countLoading}
                      data-testid="fetch-count-button"
                      className="px-3 py-1 border border-stone-300 bg-white text-xs font-bold uppercase tracking-wider hover:bg-stone-50 disabled:opacity-50 flex items-center gap-1.5 rounded-lg"
                    >
                      <RefreshCw className={`w-3 h-3 ${countLoading ? "animate-spin" : ""}`} />
                      {countLoading ? "Counting…" : count != null ? `${count.toLocaleString()} records` : "Count records"}
                    </button>
                  </div>
                </div>

                {/* Table-level decision */}
                <div className="bg-white border border-stone-200 rounded-2xl overflow-hidden" data-testid="table-decision-card">
                  <div className="px-5 py-3 border-b border-stone-200 flex items-center justify-between">
                    <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600">Migration Decision (Table)</div>
                  </div>
                  <div className="p-5 space-y-4">
                    <div className="flex items-center gap-3 flex-wrap">
                      <button
                        onClick={() => updateTableDecision({ migrate: true })}
                        data-testid="table-decision-migrate"
                        className={`px-4 py-2 text-xs font-bold uppercase tracking-wider border transition-colors rounded-lg ${
                          currentTableDecision.migrate === true
                            ? "bg-emerald-600 text-white border-emerald-600"
                            : "bg-white text-stone-900 border-stone-300 hover:bg-emerald-50"
                        }`}
                      >
                        <Check className="w-3.5 h-3.5 inline mr-1.5" /> Migrate this table
                      </button>
                      <button
                        onClick={() => updateTableDecision({ migrate: false })}
                        data-testid="table-decision-skip"
                        className={`px-4 py-2 text-xs font-bold uppercase tracking-wider border transition-colors rounded-lg ${
                          currentTableDecision.migrate === false
                            ? "bg-red-600 text-white border-red-600"
                            : "bg-white text-stone-900 border-stone-300 hover:bg-red-50"
                        }`}
                      >
                        <X className="w-3.5 h-3.5 inline mr-1.5" /> Skip this table
                      </button>
                      {summary && (
                        <div className="text-xs text-stone-600 ml-auto flex items-center gap-3 flex-wrap">
                          {Object.entries(summary).filter(([, v]) => v > 0).map(([k, v]) => {
                            const opt = DECISION_MAP[k];
                            return (
                              <span key={k} className={`px-2 py-0.5 ${opt.bg} ${opt.color} font-bold text-[10px] uppercase tracking-wider rounded-md`}>
                                {v} {opt.label}
                              </span>
                            );
                          })}
                        </div>
                      )}
                    </div>
                    <div>
                      <label className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">Notes (optional)</label>
                      <TextField
                        value={currentTableDecision.notes}
                        onChange={(v) => updateTableDecision({ notes: v })}
                        placeholder="e.g. 'Migrate but rename Mojo Email to work_email'"
                        testid="table-notes-input"
                      />
                    </div>
                  </div>
                </div>

                {/* Fields with decisions */}
                <div>
                  <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 mb-3">
                    Fields ({selected.fields.length}) — Decide per field
                  </div>
                  <div className="bg-white border border-stone-200 overflow-hidden rounded-2xl" data-testid="fields-table">
                    <table className="w-full">
                      <thead className="bg-[#F2F2F0] border-b border-stone-200">
                        <tr>
                          <th className="text-left px-3 py-2.5 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 w-10">#</th>
                          <th className="text-left px-3 py-2.5 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600">Field</th>
                          <th className="text-left px-3 py-2.5 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 w-32">Type</th>
                          <th className="text-left px-3 py-2.5 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 w-40">Decision</th>
                          <th className="text-left px-3 py-2.5 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 w-56">Rename to / Merge with</th>
                          <th className="text-left px-3 py-2.5 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600">Notes</th>
                        </tr>
                      </thead>
                      <tbody>
                        {selected.fields.map((f, i) => {
                          const fd = fieldDecisions[selected.id]?.[f.id] || {};
                          const decision = fd.decision || "undecided";
                          return (
                            <tr key={f.id} className="border-b border-stone-100 hover:bg-stone-50/50 transition-colors" data-testid={`field-row-${f.id}`}>
                              <td className="px-3 py-2 text-xs text-stone-400 font-mono align-middle">{i + 1}</td>
                              <td className="px-3 py-2 text-sm font-semibold text-stone-950 align-middle">
                                {f.name}
                                <div className="text-[10px] text-stone-400 font-mono mt-0.5">{f.id}</div>
                              </td>
                              <td className="px-3 py-2 align-middle">
                                <span className={`inline-block px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded-md ${fieldTypeColor(f.type)}`}>
                                  {f.type}
                                </span>
                              </td>
                              <td className="px-3 py-2 align-middle">
                                <DecisionSelect
                                  value={decision}
                                  onChange={(v) => updateFieldDecision(f, { decision: v })}
                                  testid={`field-decision-${f.id}`}
                                />
                              </td>
                              <td className="px-3 py-2 align-middle">
                                {decision === "rename" && (
                                  <TextField value={fd.rename_to} onChange={(v) => updateFieldDecision(f, { rename_to: v })} placeholder="new_field_name" testid={`field-rename-${f.id}`} />
                                )}
                                {decision === "merge" && (
                                  <TextField value={fd.merge_with} onChange={(v) => updateFieldDecision(f, { merge_with: v })} placeholder="merge into…" testid={`field-merge-${f.id}`} />
                                )}
                              </td>
                              <td className="px-3 py-2 align-middle">
                                <TextField value={fd.notes} onChange={(v) => updateFieldDecision(f, { notes: v })} placeholder="optional note" testid={`field-notes-${f.id}`} />
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Sample records */}
                <div>
                  <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 mb-3">
                    Sample Records (first 10) — for reference
                  </div>
                  {recordsLoading ? (
                    <div className="bg-white border border-stone-200 p-8 text-center text-stone-500 text-sm font-mono uppercase tracking-widest rounded-2xl">Loading records…</div>
                  ) : records.length === 0 ? (
                    <div className="bg-white border border-stone-200 p-8 text-center text-stone-500 text-sm rounded-2xl">No records</div>
                  ) : (
                    <div className="bg-white border border-stone-200 overflow-x-auto rounded-2xl" data-testid="sample-records-table">
                      <table className="w-full">
                        <thead className="bg-[#F2F2F0] border-b border-stone-200">
                          <tr>
                            <th className="text-left px-3 py-2 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 sticky left-0 bg-[#F2F2F0]">Record ID</th>
                            {selected.fields.slice(0, 8).map((f) => (
                              <th key={f.id} className="text-left px-3 py-2 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 whitespace-nowrap">{f.name}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {records.map((rec) => (
                            <tr key={rec.id} className="border-b border-stone-100 hover:bg-stone-50">
                              <td className="px-3 py-2 text-xs font-mono text-stone-500 sticky left-0 bg-white">{rec.id}</td>
                              {selected.fields.slice(0, 8).map((f) => (
                                <td key={f.id} className="px-3 py-2 text-xs text-stone-800 max-w-[200px] truncate">
                                  {renderFieldValue(rec.fields?.[f.name])}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {selected.fields.length > 8 && (
                        <div className="px-3 py-2 text-[11px] text-stone-500 font-mono border-t border-stone-100">
                          Showing first 8 of {selected.fields.length} fields. Other fields hidden for readability.
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="p-12 text-stone-500 text-sm">Select a table on the left.</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
