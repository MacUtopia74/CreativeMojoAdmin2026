import { useEffect, useState, useMemo } from "react";
import { Link } from "react-router-dom";
import api from "@/lib/api";
import { Search, AlertCircle } from "lucide-react";

const SEGMENTS = [
  { key: "active", label: "Active", tag: "Franchisee" },
  { key: "ex", label: "Ex-Franchisees", tag: "EX-Franchisee" },
  { key: "licencee", label: "Worldwide Licencees", tag: "Worldwide Licencee" },
  { key: "all", label: "All", tag: null },
];

function hasTag(franchisee, tag) {
  const tags = franchisee.tags || [];
  return Array.isArray(tags) ? tags.includes(tag) : tags === tag;
}

export default function FranchiseesPage() {
  const [all, setAll] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [segment, setSegment] = useState("active");
  const [sortBy, setSortBy] = useState("franchise_number");
  const [sortDir, setSortDir] = useState(1);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const { data } = await api.get("/franchisees", { params: { limit: 500, sort_by: "franchise_number", sort_dir: 1 } });
        setAll(data.items || []);
      } catch (e) {
        setError("Could not load franchisees.");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Segment counts
  const counts = useMemo(() => {
    const c = { active: 0, ex: 0, licencee: 0, all: all.length };
    for (const f of all) {
      if (hasTag(f, "Franchisee")) c.active += 1;
      if (hasTag(f, "EX-Franchisee")) c.ex += 1;
      if (hasTag(f, "Worldwide Licencee")) c.licencee += 1;
    }
    return c;
  }, [all]);

  const filtered = useMemo(() => {
    const seg = SEGMENTS.find((s) => s.key === segment);
    let items = seg && seg.tag ? all.filter((f) => hasTag(f, seg.tag)) : [...all];
    if (search) {
      const q = search.toLowerCase();
      items = items.filter((f) =>
        [f.organisation, f.first_name, f.last_name, f.mojo_email, f.franchise_number, f.city, f.postcode]
          .filter(Boolean).some((v) => String(v).toLowerCase().includes(q))
      );
    }
    items.sort((a, b) => {
      const va = a[sortBy] ?? "";
      const vb = b[sortBy] ?? "";
      if (va < vb) return -1 * sortDir;
      if (va > vb) return 1 * sortDir;
      return 0;
    });
    return items;
  }, [all, segment, search, sortBy, sortDir]);

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
          <h1 className="font-display text-xl text-stone-950">Franchisees</h1>
          <span className="text-xs text-stone-500">{filtered.length} of {all.length} records</span>
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

      {/* Segment tabs */}
      <div className="px-8 pt-6">
        <div className="flex border-b border-stone-200 -mb-px" data-testid="segment-tabs">
          {SEGMENTS.map((s) => {
            const active = segment === s.key;
            const count = counts[s.key];
            return (
              <button
                key={s.key}
                onClick={() => setSegment(s.key)}
                data-testid={`segment-${s.key}`}
                className={`px-5 py-3 text-sm font-bold transition-colors border-b-2 ${
                  active
                    ? "border-stone-950 text-stone-950"
                    : "border-transparent text-stone-500 hover:text-stone-900"
                }`}
              >
                {s.label}
                <span className={`ml-2 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
                  active ? "bg-[#D4FF00] text-stone-950" : "bg-stone-100 text-stone-600"
                }`}>{count}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="p-8 pt-6">
        {error && (
          <div className="mb-4 border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 flex items-center gap-2">
            <AlertCircle className="w-4 h-4" /> {error}
          </div>
        )}
        {loading ? (
          <div className="text-center text-stone-500 text-sm uppercase tracking-widest p-12" data-testid="franchisees-loading">Loading…</div>
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
                {filtered.length === 0 ? (
                  <tr><td colSpan={8} className="px-3 py-10 text-center text-sm text-stone-500">No franchisees in this view.</td></tr>
                ) : filtered.map((f) => {
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
                      <td className="px-3 py-2 text-xs text-stone-500">{f.franchise_number || "—"}</td>
                      <td className="px-3 py-2">
                        <Link to={`/franchisees/${f.id}`} className="text-sm font-semibold text-stone-950 hover:text-stone-700" data-testid={`franchisee-link-${f.id}`}>
                          {f.organisation || "(no organisation)"}
                        </Link>
                      </td>
                      <td className="px-3 py-2 text-sm text-stone-700">{[f.first_name, f.last_name].filter(Boolean).join(" ") || "—"}</td>
                      <td className="px-3 py-2 text-xs text-stone-600">{f.mojo_email || "—"}</td>
                      <td className="px-3 py-2 text-xs text-stone-700">{f.postcode || "—"}</td>
                      <td className="px-3 py-2 text-xs text-stone-500">{f.date_added ? String(f.date_added).slice(0, 10) : "—"}</td>
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
