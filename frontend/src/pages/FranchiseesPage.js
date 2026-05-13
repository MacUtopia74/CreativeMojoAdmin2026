import { useEffect, useState, useMemo } from "react";
import { Link } from "react-router-dom";
import api from "@/lib/api";
import { Search, MapPin, Mail, AlertCircle } from "lucide-react";

export default function FranchiseesPage() {
  const [data, setData] = useState({ items: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState("franchise_number");
  const [sortDir, setSortDir] = useState(1);

  useEffect(() => {
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const { data } = await api.get("/franchisees", {
          params: { search: search || undefined, sort_by: sortBy, sort_dir: sortDir, limit: 200 },
        });
        setData(data);
      } catch (e) {
        setError("Could not load franchisees.");
      } finally {
        setLoading(false);
      }
    }, search ? 250 : 0);
    return () => clearTimeout(t);
  }, [search, sortBy, sortDir]);

  const headerClick = (col) => () => {
    if (sortBy === col) setSortDir(-sortDir);
    else { setSortBy(col); setSortDir(1); }
  };

  const SortArrow = ({ col }) => sortBy === col ? (
    <span className="text-stone-950 ml-1">{sortDir === 1 ? "↑" : "↓"}</span>
  ) : <span className="text-stone-300 ml-1">↕</span>;

  return (
    <div className="min-h-screen">
      <div className="h-16 border-b border-stone-200 bg-white flex items-center px-8 sticky top-0 z-10" data-testid="topbar">
        <div className="flex items-baseline gap-3 flex-1">
          <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-500">CRM</div>
          <h1 className="font-display font-black text-xl text-stone-950 tracking-tight">Franchisees</h1>
          <span className="text-xs text-stone-500 font-mono">{data.total} records</span>
        </div>
        <div className="relative">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-stone-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            data-testid="franchisee-search"
            placeholder="Search name, org, email, postcode…"
            className="pl-10 pr-4 py-2 w-80 bg-stone-50 border border-stone-300 text-sm focus:outline-none focus:border-stone-900"
          />
        </div>
      </div>

      <div className="p-8">
        {error && (
          <div className="mb-4 border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 flex items-center gap-2">
            <AlertCircle className="w-4 h-4" /> {error}
          </div>
        )}
        {loading ? (
          <div className="text-center text-stone-500 text-sm font-mono uppercase tracking-widest p-12" data-testid="franchisees-loading">Loading…</div>
        ) : (
          <div className="bg-white border border-stone-200 overflow-hidden" data-testid="franchisees-table">
            <table className="w-full">
              <thead className="bg-[#F2F2F0] border-b border-stone-200">
                <tr>
                  <th className="text-left px-3 py-3 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 w-12">Photo</th>
                  <th onClick={headerClick("franchise_number")} className="text-left px-3 py-3 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 cursor-pointer hover:bg-stone-200/50 w-24">No. <SortArrow col="franchise_number" /></th>
                  <th onClick={headerClick("organisation")} className="text-left px-3 py-3 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 cursor-pointer hover:bg-stone-200/50">Organisation <SortArrow col="organisation" /></th>
                  <th onClick={headerClick("last_name")} className="text-left px-3 py-3 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 cursor-pointer hover:bg-stone-200/50">Name <SortArrow col="last_name" /></th>
                  <th className="text-left px-3 py-3 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600">Mojo Email</th>
                  <th className="text-left px-3 py-3 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 w-28">Postcode</th>
                  <th onClick={headerClick("date_added")} className="text-left px-3 py-3 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 cursor-pointer hover:bg-stone-200/50 w-32">Added <SortArrow col="date_added" /></th>
                  <th className="text-left px-3 py-3 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 w-24">Mandate</th>
                </tr>
              </thead>
              <tbody>
                {data.items.length === 0 ? (
                  <tr><td colSpan={8} className="px-3 py-10 text-center text-sm text-stone-500">No franchisees found.</td></tr>
                ) : data.items.map((f) => {
                  const photo = f.photos?.[0]?.url;
                  return (
                    <tr key={f.id} className="border-b border-stone-100 hover:bg-stone-50 transition-colors" data-testid={`franchisee-row-${f.id}`}>
                      <td className="px-3 py-2">
                        {photo ? (
                          <img src={photo} alt="" className="w-9 h-9 object-cover" />
                        ) : (
                          <div className="w-9 h-9 bg-stone-100 flex items-center justify-center text-[10px] font-bold text-stone-400">
                            {(f.first_name?.[0] || "?") + (f.last_name?.[0] || "")}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs text-stone-500">{f.franchise_number || "—"}</td>
                      <td className="px-3 py-2">
                        <Link to={`/franchisees/${f.id}`} className="text-sm font-semibold text-stone-950 hover:text-stone-700" data-testid={`franchisee-link-${f.id}`}>
                          {f.organisation || "(no organisation)"}
                        </Link>
                      </td>
                      <td className="px-3 py-2 text-sm text-stone-700">{[f.first_name, f.last_name].filter(Boolean).join(" ") || "—"}</td>
                      <td className="px-3 py-2 text-xs text-stone-600 font-mono">{f.mojo_email || "—"}</td>
                      <td className="px-3 py-2 text-xs text-stone-700">{f.postcode || "—"}</td>
                      <td className="px-3 py-2 text-xs text-stone-500 font-mono">{f.date_added ? String(f.date_added).slice(0, 10) : "—"}</td>
                      <td className="px-3 py-2">
                        {f.mandate ? (
                          <span className="inline-block px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider bg-[#D4FF00]/20 border border-[#D4FF00]/60 text-stone-900">
                            {Array.isArray(f.mandate) ? f.mandate[0] : f.mandate}
                          </span>
                        ) : <span className="text-stone-300 text-xs">—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
