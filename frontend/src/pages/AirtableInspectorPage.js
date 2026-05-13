import { useEffect, useState, useMemo } from "react";
import api from "@/lib/api";
import { Database, AlertCircle, ChevronRight, RefreshCw } from "lucide-react";

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

export default function AirtableInspectorPage() {
  const [tables, setTables] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState(null);
  const [records, setRecords] = useState([]);
  const [recordsLoading, setRecordsLoading] = useState(false);
  const [count, setCount] = useState(null);
  const [countLoading, setCountLoading] = useState(false);

  useEffect(() => {
    (async () => {
      setLoading(true);
      setError("");
      try {
        const { data } = await api.get("/airtable/tables");
        setTables(data.tables || []);
        if (data.tables?.length) setSelectedId(data.tables[0].id);
      } catch (e) {
        setError("Could not load Airtable schema. Check the PAT in backend/.env.");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

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

  return (
    <div className="min-h-screen">
      <PageHeader
        subtitle="Phase 1 — Schema"
        title="Airtable Inspector"
        right={
          <div className="flex items-center gap-2">
            <div className="text-xs text-stone-500 font-mono">base · {tables.length} tables</div>
          </div>
        }
      />

      {loading ? (
        <div className="p-12 text-center text-stone-500 text-sm font-mono uppercase tracking-widest" data-testid="inspector-loading">
          Loading schema…
        </div>
      ) : error ? (
        <div className="m-8 border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 flex items-center gap-2" data-testid="inspector-error">
          <AlertCircle className="w-4 h-4" /> {error}
        </div>
      ) : (
        <div className="flex h-[calc(100vh-4rem)]">
          {/* Tables list */}
          <div className="w-[300px] border-r border-stone-200 bg-white overflow-y-auto" data-testid="tables-list">
            <div className="px-5 py-4 border-b border-stone-200">
              <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">Tables</div>
            </div>
            {tables.map((t) => (
              <button
                key={t.id}
                onClick={() => setSelectedId(t.id)}
                data-testid={`table-item-${t.id}`}
                className={`w-full text-left px-5 py-3 border-b border-stone-100 transition-colors flex items-center gap-2 ${
                  selectedId === t.id ? "bg-[#D4FF00]/15 border-l-2 border-l-[#D4FF00]" : "hover:bg-stone-50 border-l-2 border-l-transparent"
                }`}
              >
                <Database className="w-3.5 h-3.5 text-stone-500 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold text-stone-950 truncate">{t.name}</div>
                  <div className="text-[11px] text-stone-500 font-mono">
                    {t.field_count} fields · {t.view_count} views
                  </div>
                </div>
                <ChevronRight className={`w-3.5 h-3.5 text-stone-400 transition-transform ${selectedId === t.id ? "translate-x-0.5 text-stone-700" : ""}`} />
              </button>
            ))}
          </div>

          {/* Detail */}
          <div className="flex-1 overflow-y-auto bg-[#F9F9F8]">
            {selected ? (
              <div className="p-8 space-y-8">
                <div>
                  <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">Table</div>
                  <div className="flex items-baseline gap-4 mt-1">
                    <h2 className="font-display font-black text-3xl text-stone-950 tracking-tight" data-testid="selected-table-name">
                      {selected.name}
                    </h2>
                    <span className="font-mono text-xs text-stone-500">{selected.id}</span>
                  </div>
                  <div className="flex items-center gap-4 mt-3 text-sm">
                    <span className="text-stone-700"><strong>{selected.field_count}</strong> fields</span>
                    <span className="text-stone-700"><strong>{selected.view_count}</strong> views</span>
                    <button
                      onClick={fetchCount}
                      disabled={countLoading}
                      data-testid="fetch-count-button"
                      className="px-3 py-1 border border-stone-300 bg-white text-xs font-bold uppercase tracking-wider hover:bg-stone-50 disabled:opacity-50 flex items-center gap-1.5"
                    >
                      <RefreshCw className={`w-3 h-3 ${countLoading ? "animate-spin" : ""}`} />
                      {countLoading ? "Counting…" : count != null ? `${count.toLocaleString()} records` : "Count records"}
                    </button>
                  </div>
                </div>

                {/* Fields */}
                <div>
                  <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 mb-3">
                    All Fields ({selected.fields.length})
                  </div>
                  <div className="bg-white border border-stone-200 overflow-hidden" data-testid="fields-table">
                    <table className="w-full">
                      <thead className="bg-[#F2F2F0] border-b border-stone-200">
                        <tr>
                          <th className="text-left px-4 py-2.5 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 w-10">#</th>
                          <th className="text-left px-4 py-2.5 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600">Field Name</th>
                          <th className="text-left px-4 py-2.5 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 w-44">Type</th>
                          <th className="text-left px-4 py-2.5 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 w-40">Field ID</th>
                        </tr>
                      </thead>
                      <tbody>
                        {selected.fields.map((f, i) => (
                          <tr key={f.id} className="border-b border-stone-100 hover:bg-stone-50 transition-colors">
                            <td className="px-4 py-2.5 text-xs text-stone-400 font-mono">{i + 1}</td>
                            <td className="px-4 py-2.5 text-sm font-semibold text-stone-950">{f.name}</td>
                            <td className="px-4 py-2.5">
                              <span className={`inline-block px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${fieldTypeColor(f.type)}`}>
                                {f.type}
                              </span>
                            </td>
                            <td className="px-4 py-2.5 text-xs font-mono text-stone-500">{f.id}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Sample records */}
                <div>
                  <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 mb-3">
                    Sample Records (first 10)
                  </div>
                  {recordsLoading ? (
                    <div className="bg-white border border-stone-200 p-8 text-center text-stone-500 text-sm font-mono uppercase tracking-widest">
                      Loading records…
                    </div>
                  ) : records.length === 0 ? (
                    <div className="bg-white border border-stone-200 p-8 text-center text-stone-500 text-sm">No records</div>
                  ) : (
                    <div className="bg-white border border-stone-200 overflow-x-auto" data-testid="sample-records-table">
                      <table className="w-full">
                        <thead className="bg-[#F2F2F0] border-b border-stone-200">
                          <tr>
                            <th className="text-left px-3 py-2 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 sticky left-0 bg-[#F2F2F0]">Record ID</th>
                            {selected.fields.slice(0, 8).map((f) => (
                              <th key={f.id} className="text-left px-3 py-2 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 whitespace-nowrap">
                                {f.name}
                              </th>
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
