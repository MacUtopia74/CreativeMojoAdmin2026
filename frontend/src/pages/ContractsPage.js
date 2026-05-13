import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import api from "@/lib/api";
import { Search, AlertCircle } from "lucide-react";

export default function ContractsPage() {
  const [data, setData] = useState({ items: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const { data } = await api.get("/contracts", { params: { search: search || undefined, limit: 500 } });
        setData(data);
      } catch (e) { setError("Could not load contracts."); }
      finally { setLoading(false); }
    }, search ? 250 : 0);
    return () => clearTimeout(t);
  }, [search]);

  return (
    <div className="min-h-screen">
      <div className="h-16 border-b border-stone-200 bg-white flex items-center px-8 sticky top-0 z-10" data-testid="topbar">
        <div className="flex items-baseline gap-3 flex-1">
          <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-500">CRM</div>
          <h1 className="font-display font-black text-xl text-stone-950 tracking-tight">Contracts</h1>
          <span className="text-xs text-stone-500 font-mono">{data.total} records</span>
        </div>
        <div className="relative">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-stone-400" />
          <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} data-testid="contract-search"
            placeholder="Search name or email…"
            className="pl-10 pr-4 py-2 w-72 bg-stone-50 border border-stone-300 text-sm focus:outline-none focus:border-stone-900 rounded-lg" />
        </div>
      </div>

      <div className="p-8">
        {error && <div className="mb-4 border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 flex items-center gap-2 rounded-xl"><AlertCircle className="w-4 h-4" />{error}</div>}
        {loading ? (
          <div className="text-center text-stone-500 text-sm font-mono uppercase tracking-widest p-12">Loading…</div>
        ) : (
          <div className="bg-white border border-stone-200 overflow-hidden rounded-2xl" data-testid="contracts-table">
            <table className="w-full">
              <thead className="bg-[#F2F2F0] border-b border-stone-200">
                <tr>
                  <th className="text-left px-3 py-3 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 w-16">Ref</th>
                  <th className="text-left px-3 py-3 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600">Franchisee</th>
                  <th className="text-left px-3 py-3 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 w-32">Commencement</th>
                  <th className="text-left px-3 py-3 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 w-28">Renewal</th>
                  <th className="text-left px-3 py-3 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 w-20">Term</th>
                  <th className="text-left px-3 py-3 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 w-28">Monthly</th>
                  <th className="text-left px-3 py-3 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 w-24">Renewal Fee</th>
                  <th className="text-left px-3 py-3 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 w-32">Status</th>
                </tr>
              </thead>
              <tbody>
                {data.items.length === 0 ? (
                  <tr><td colSpan={8} className="px-3 py-10 text-center text-sm text-stone-500">No contracts.</td></tr>
                ) : data.items.map((c) => (
                  <tr key={c.id} className="border-b border-stone-100 hover:bg-stone-50" data-testid={`contract-row-${c.id}`}>
                    <td className="px-3 py-2 font-mono text-xs text-stone-700">#{c.ref}</td>
                    <td className="px-3 py-2">
                      {c.franchisee ? (
                        <Link to={`/franchisees/${c.franchisee.id}`} className="text-sm font-semibold text-stone-950 hover:underline">
                          {c.franchisee.organisation}
                        </Link>
                      ) : <span className="text-stone-400 text-sm">(unlinked)</span>}
                    </td>
                    <td className="px-3 py-2 text-xs text-stone-700 font-mono">{c.commencement_date ? String(c.commencement_date).slice(0,10) : "—"}</td>
                    <td className="px-3 py-2 text-xs text-stone-700 font-mono">{c.renewal_date ? String(c.renewal_date).slice(0,10) : "—"}</td>
                    <td className="px-3 py-2 text-xs text-stone-700">{c.contract_term_years ? `${c.contract_term_years} yrs` : "—"}</td>
                    <td className="px-3 py-2 text-xs text-stone-700">{c.monthly_fee != null ? `£${c.monthly_fee}` : "—"}</td>
                    <td className="px-3 py-2 text-xs text-stone-700">
                      {c.renewal_fee != null ? `£${c.renewal_fee}` : "—"}
                      {c.renewal_fee_paid && <span className="ml-1 text-emerald-700 font-bold">✓</span>}
                    </td>
                    <td className="px-3 py-2">
                      {c.cancelled_early
                        ? <span className="px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider bg-red-50 text-red-700 border border-red-200 rounded-md">Cancelled</span>
                        : <span className="px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider bg-emerald-50 text-emerald-700 border border-emerald-200 rounded-md">{c.staying_leaving || "Active"}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
