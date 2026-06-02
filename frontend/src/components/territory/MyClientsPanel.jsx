// "My Clients" panel — a dedicated, focused list of just the
// franchisee's marked + custom clients. Sits at the top of My
// Territory+ alongside the action cards and the map.
//
// Differs from the CQC homes list below it: this panel ONLY shows
// records from franchisee_clients (no public CQC homes), uses a tight
// table-style layout, and offers per-column sorting + search +
// pagination so the franchisee can drill quickly into their book of
// business. Clicking any row opens the existing edit modal.
//
// Card layout mirrors the rest of the My Territory+ panels —
// brand-yellow #eeee84 header with dark icon circle and a small
// collapse chevron.
import { useMemo, useState } from "react";
import { Users, Plus, ChevronDown, ChevronUp, ChevronRight, Search, Star } from "lucide-react";

const PAGE_SIZE = 10;
const TYPE_FROM_HOME = (h) => {
  if (!h) return "";
  const services = (h.gacServiceTypes || []).map((s) => s?.name || "").filter(Boolean);
  if (services.find((s) => /nursing/i.test(s))) return "Nursing";
  if (services.find((s) => /hospice/i.test(s))) return "Hospice";
  if (services.find((s) => /domiciliary|home care/i.test(s))) return "Domiciliary";
  return "Residential";
};

export default function MyClientsPanel({
  clients = [],          // raw franchisee_clients docs (both custom + marked-CQC)
  homeById = null,       // Map of CQC homes keyed by id — for beds/type lookup on marked clients
  onAddClient,           // () — open add modal
  onEditClient,          // (client) — open edit modal
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [q, setQ] = useState("");
  const [sortKey, setSortKey] = useState("name");
  const [sortDir, setSortDir] = useState("asc");
  const [page, setPage] = useState(0);

  // Build display rows with type/beds enrichment for CQC-linked clients.
  const rows = useMemo(() => {
    return clients.map((c) => {
      const linked = c.source !== "custom" && homeById ? homeById.get(c.home_id) : null;
      return {
        ...c,
        _location: (linked?.postalAddressTownCity || c.address || c.postcode || "").trim(),
        _type: TYPE_FROM_HOME(linked) || (c.source === "custom" ? "Custom" : "—"),
        _beds: linked?.numberOfBeds ?? null,
      };
    });
  }, [clients, homeById]);

  const filtered = useMemo(() => {
    let base = rows;
    if (q.trim()) {
      const needle = q.toLowerCase().trim();
      base = base.filter((c) =>
        (c.name || "").toLowerCase().includes(needle)
        || (c._location || "").toLowerCase().includes(needle)
        || (c.manager || "").toLowerCase().includes(needle)
        || (c.postcode || "").toLowerCase().includes(needle)
        || (c.provider || "").toLowerCase().includes(needle),
      );
    }
    const sorted = [...base].sort((a, b) => {
      const av = (a[`_${sortKey}`] ?? a[sortKey] ?? "") || "";
      const bv = (b[`_${sortKey}`] ?? b[sortKey] ?? "") || "";
      if (typeof av === "number" && typeof bv === "number") return sortDir === "asc" ? av - bv : bv - av;
      return sortDir === "asc"
        ? String(av).localeCompare(String(bv))
        : String(bv).localeCompare(String(av));
    });
    return sorted;
  }, [rows, q, sortKey, sortDir]);

  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageRows = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const setSort = (k) => {
    if (sortKey === k) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(k); setSortDir("asc"); }
  };
  const SortHead = ({ k, label, align = "left" }) => (
    <button
      onClick={() => setSort(k)}
      className={`flex items-center gap-1 text-[10px] uppercase tracking-wider font-bold text-stone-600 hover:text-stone-950 ${
        align === "right" ? "ml-auto" : ""
      }`}
      data-testid={`my-clients-sort-${k}`}
    >
      {label}
      {sortKey === k
        ? (sortDir === "asc" ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />)
        : <ChevronUp className="w-3 h-3 opacity-25" />}
    </button>
  );

  return (
    <div className="bg-white border border-stone-200 rounded-2xl overflow-hidden h-full w-full flex flex-col" data-testid="my-clients-panel">
      <div className="px-4 py-3 border-b border-stone-200 flex items-center justify-between gap-3 flex-wrap" style={{ backgroundColor: "#eeee84" }}>
        <div className="flex items-center gap-3 min-w-0">
          <span className="w-9 h-9 rounded-full bg-stone-950 text-[#dedd0a] flex items-center justify-center shrink-0">
            <Users className="w-4 h-4" />
          </span>
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-900/70">
              My Clients
            </div>
            <div className="text-sm text-stone-900 mt-0.5">
              <strong>{clients.length}</strong> client{clients.length === 1 ? "" : "s"}
              <span className="text-stone-900/60"> · click any row to view details</span>
            </div>
          </div>
        </div>
        <button
          onClick={() => setCollapsed((c) => !c)}
          data-testid="my-clients-toggle"
          className="touch-target shrink-0 w-7 h-7 rounded-full border border-stone-950 bg-stone-950 text-[#dedd0a] hover:bg-stone-800 flex items-center justify-center"
          aria-label={collapsed ? "Expand" : "Collapse"}
        >
          {collapsed
            ? <ChevronDown className="w-3.5 h-3.5" />
            : <ChevronDown className="w-3.5 h-3.5 rotate-180" />}
        </button>
      </div>

      {!collapsed && (
        <>
          {/* Search + add */}
          <div className="px-4 py-3 border-b border-stone-200 flex items-center gap-2 flex-wrap">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-stone-400 pointer-events-none" />
              <input
                value={q}
                onChange={(e) => { setQ(e.target.value); setPage(0); }}
                placeholder="Search by name, town, postcode, manager…"
                data-testid="my-clients-search"
                className="w-full pl-8 pr-3 py-2 ios-no-zoom text-sm bg-stone-50 border border-stone-200 rounded-lg focus:outline-none focus:bg-white focus:border-stone-400"
              />
            </div>
            <button
              onClick={onAddClient}
              data-testid="my-clients-add"
              className="inline-flex items-center gap-1.5 px-3 py-2 text-[10px] font-bold uppercase tracking-wider bg-stone-950 text-[#dedd0a] hover:bg-stone-800 rounded-md"
            >
              <Plus className="w-3.5 h-3.5" /> Add Client
            </button>
          </div>

          {/* Table */}
          {filtered.length === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-stone-500 flex-1 flex flex-col items-center justify-center gap-2">
              <Users className="w-8 h-8 text-stone-300" />
              {q ? "No clients match your search." : "No clients yet — mark a CQC home as 'My Client' or add a custom one."}
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="bg-stone-50 sticky top-0 z-10">
                  <tr>
                    <th className="px-4 py-2 text-left w-8"></th>
                    <th className="px-3 py-2 text-left"><SortHead k="name" label="Client name" /></th>
                    <th className="px-3 py-2 text-left hidden sm:table-cell"><SortHead k="location" label="Location" /></th>
                    <th className="px-3 py-2 text-left hidden md:table-cell"><SortHead k="type" label="Type" /></th>
                    <th className="px-3 py-2 text-right hidden md:table-cell"><SortHead k="beds" label="Beds" align="right" /></th>
                    <th className="px-3 py-2 text-right w-8"></th>
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((c) => (
                    <tr
                      key={c.id}
                      onClick={() => onEditClient?.(c)}
                      className="border-t border-stone-100 hover:bg-stone-50 cursor-pointer group"
                      data-testid={`my-clients-row-${c.id}`}
                    >
                      <td className="px-4 py-2.5">
                        <span className="w-7 h-7 rounded-full bg-[#dedd0a] text-stone-950 border border-stone-950 flex items-center justify-center">
                          <Star className="w-3.5 h-3.5 fill-current" />
                        </span>
                      </td>
                      <td className="px-3 py-2.5 min-w-0">
                        <div className="font-semibold text-stone-950 truncate">{c.name}</div>
                        <div className="text-[11px] text-stone-500 truncate">
                          {c.postcode || ""}{c.manager ? ` · ${c.manager}` : ""}
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-stone-700 hidden sm:table-cell truncate max-w-[180px]">{c._location || "—"}</td>
                      <td className="px-3 py-2.5 hidden md:table-cell">
                        <span className="inline-flex px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded bg-stone-100 text-stone-700">
                          {c._type}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums font-medium text-stone-900 hidden md:table-cell">
                        {c._beds ?? "—"}
                      </td>
                      <td className="px-3 py-2.5 text-stone-400 group-hover:text-stone-900">
                        <ChevronRight className="w-4 h-4" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Pagination */}
          {pages > 1 && (
            <div className="px-4 py-3 border-t border-stone-200 flex items-center justify-between gap-2 text-[11px] text-stone-600">
              <span data-testid="my-clients-pagination-summary">
                Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, filtered.length)} of {filtered.length}
              </span>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={page === 0}
                  data-testid="my-clients-page-prev"
                  className="w-7 h-7 rounded border border-stone-300 flex items-center justify-center hover:bg-stone-50 disabled:opacity-40"
                >
                  <ChevronRight className="w-3.5 h-3.5 rotate-180" />
                </button>
                <span className="px-2 tabular-nums font-bold text-stone-900">{page + 1} / {pages}</span>
                <button
                  onClick={() => setPage((p) => Math.min(pages - 1, p + 1))}
                  disabled={page >= pages - 1}
                  data-testid="my-clients-page-next"
                  className="w-7 h-7 rounded border border-stone-300 flex items-center justify-center hover:bg-stone-50 disabled:opacity-40"
                >
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
