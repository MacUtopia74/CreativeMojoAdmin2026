// "My Clients" panel — focused list of just the franchisee's marked +
// custom clients. Sits at the top of My Territory+ alongside the
// action cards and the map.
//
// Layout: stacked list rows (not a table). Each row carries the client
// name, address line, type chip and beds. Designed to read cleanly in a
// narrow column so we don't have to make the My Clients column wider
// just to fit a wide table.
//
// Wired with a sort dropdown (name / location / type / beds × asc/desc)
// and a search input. Whole-row click opens the existing edit modal.
//
// The optional ``expanded`` prop + ``onExpandedChange`` callback drive
// the top-row column-width toggle that lets the franchisee flip the
// Map and My Clients columns between balanced and clients-focused
// proportions. The button lives in the panel header.
import { useMemo, useState } from "react";
import {
  Users, Plus, ChevronRight, Search, Star, BedDouble,
  Maximize2, Minimize2, Eye,
} from "lucide-react";

const PAGE_SIZE = 10;
const TYPE_FROM_HOME = (h) => {
  if (!h) return "";
  const services = (h.gacServiceTypes || []).map((s) => s?.name || "").filter(Boolean);
  if (services.find((s) => /nursing/i.test(s))) return "Nursing";
  if (services.find((s) => /hospice/i.test(s))) return "Hospice";
  if (services.find((s) => /domiciliary|home care/i.test(s))) return "Domiciliary";
  return "Residential";
};
const SORT_OPTIONS = [
  { value: "name-asc",     label: "Name A → Z",        key: "name", dir: "asc"  },
  { value: "name-desc",    label: "Name Z → A",        key: "name", dir: "desc" },
  { value: "location-asc", label: "Location A → Z",    key: "location", dir: "asc"  },
  { value: "type-asc",     label: "Type",              key: "type", dir: "asc"  },
  { value: "beds-desc",    label: "Beds (high → low)", key: "beds", dir: "desc" },
  { value: "beds-asc",     label: "Beds (low → high)", key: "beds", dir: "asc"  },
];

export default function MyClientsPanel({
  clients = [],
  homeById = null,
  onAddClient,
  onEditClient,
  expanded = false,           // optional — for the column-width toggle
  onExpandedChange = null,    // (next) => void
  myClientsOnly = false,      // map-filter toggle (lives in this header now)
  onMyClientsOnlyChange = null,
}) {
  const [q, setQ] = useState("");
  const [sortValue, setSortValue] = useState("name-asc");
  const [page, setPage] = useState(0);

  // Build display rows with type/beds enrichment for CQC-linked clients.
  // ``_location`` deliberately DOES NOT fall back to postcode — postcode
  // already shows on the meta line and we want the Location column to be
  // empty (rather than duplicate) when a custom client has no real address.
  const rows = useMemo(() => {
    return clients.map((c) => {
      const linked = c.source !== "custom" && homeById ? homeById.get(c.home_id) : null;
      return {
        ...c,
        _location: (linked?.postalAddressTownCity || c.address || "").trim(),
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
    const opt = SORT_OPTIONS.find((o) => o.value === sortValue) || SORT_OPTIONS[0];
    const sorted = [...base].sort((a, b) => {
      const av = a[`_${opt.key}`] ?? a[opt.key] ?? "";
      const bv = b[`_${opt.key}`] ?? b[opt.key] ?? "";
      if (typeof av === "number" && typeof bv === "number") return opt.dir === "asc" ? av - bv : bv - av;
      return opt.dir === "asc"
        ? String(av || "").localeCompare(String(bv || ""))
        : String(bv || "").localeCompare(String(av || ""));
    });
    return sorted;
  }, [rows, q, sortValue]);

  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageRows = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  return (
    <div className="bg-white border border-stone-200 rounded-2xl overflow-hidden h-full w-full flex flex-col" data-testid="my-clients-panel">
      <div className="px-4 py-3 border-b border-stone-200 flex items-center justify-between gap-3" style={{ backgroundColor: "#eeee84" }}>
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <span className="w-9 h-9 rounded-full bg-stone-950 text-[#dedd0a] flex items-center justify-center shrink-0">
            <Users className="w-4 h-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-900/70 truncate">
              My Clients
            </div>
            <div className="text-sm text-stone-900 mt-0.5 truncate">
              <strong>{clients.length}</strong> client{clients.length === 1 ? "" : "s"}
              <span className="text-stone-900/60"> · click any row to view details</span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {onMyClientsOnlyChange && (
            <button
              onClick={() => onMyClientsOnlyChange(!myClientsOnly)}
              data-testid="my-clients-only-pill"
              title="Hide non-client markers on the map"
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider rounded-md border transition-colors ${
                myClientsOnly
                  ? "bg-stone-950 text-[#dedd0a] border-stone-950"
                  : "bg-white border-stone-950/40 text-stone-950 hover:bg-stone-100"
              }`}
            >
              <Eye className="w-3 h-3" />
              <span className="hidden sm:inline">My Clients Only</span>
              <span className="sm:hidden">Only Mine</span>
            </button>
          )}
          {onExpandedChange && (
            <button
              onClick={() => onExpandedChange(!expanded)}
              data-testid="my-clients-width-toggle"
              title={expanded ? "Restore balanced layout" : "Expand My Clients (narrow Map)"}
              className="w-7 h-7 rounded-full border border-stone-950 bg-white text-stone-950 hover:bg-stone-100 flex items-center justify-center"
              aria-label={expanded ? "Shrink panel" : "Expand panel"}
            >
              {expanded ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
            </button>
          )}
        </div>
      </div>

      {/* Search + sort + add */}
      <div className="px-4 py-3 border-b border-stone-200 flex items-center gap-2 flex-wrap">
            <div className="relative flex-1 min-w-[160px]">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-stone-400 pointer-events-none" />
              <input
                value={q}
                onChange={(e) => { setQ(e.target.value); setPage(0); }}
                placeholder="Search clients…"
                data-testid="my-clients-search"
                className="w-full pl-8 pr-3 py-2 ios-no-zoom text-sm bg-stone-50 border border-stone-200 rounded-lg focus:outline-none focus:bg-white focus:border-stone-400"
              />
            </div>
            <select
              value={sortValue}
              onChange={(e) => setSortValue(e.target.value)}
              data-testid="my-clients-sort"
              className="px-2.5 py-2 ios-no-zoom text-xs bg-stone-50 border border-stone-200 rounded-lg focus:outline-none focus:bg-white focus:border-stone-400"
            >
              {SORT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
            <button
              onClick={onAddClient}
              data-testid="my-clients-add"
              className="inline-flex items-center gap-1.5 px-3 py-2 text-[10px] font-bold uppercase tracking-wider bg-stone-950 text-[#dedd0a] hover:bg-stone-800 rounded-md"
            >
              <Plus className="w-3.5 h-3.5" /> Add
            </button>
          </div>

          {/* Optional column header strip — only when wide (expanded) so
              the spread-out row fields are scannable. Hidden in narrow
              mode where rows stack vertically. */}
          {expanded && filtered.length > 0 && (
            <div className="hidden md:flex items-center gap-3 px-4 py-2 bg-stone-50 border-b border-stone-200 text-[10px] uppercase tracking-wider font-bold text-stone-500" data-testid="my-clients-column-headers">
              <span className="w-7" />
              <span className="flex-[2] min-w-0">Client name</span>
              <span className="flex-1 min-w-0">Location</span>
              <span className="hidden lg:block w-28">Type</span>
              <span className="hidden lg:block w-20 text-right">Beds</span>
              <span className="w-4" />
            </div>
          )}

          {/* Stacked list — no table, reads cleanly in narrow column.
              Switches to a horizontal spread when ``expanded`` so the
              extra width carries the location/type/beds inline. */}
          {filtered.length === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-stone-500 flex-1 flex flex-col items-center justify-center gap-2">
              <Users className="w-8 h-8 text-stone-300" />
              {q ? "No clients match your search." : "No clients yet — mark a CQC home as 'My Client' or add a custom one."}
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto divide-y divide-stone-100">
              {pageRows.map((c) => (
                <div
                  key={c.id}
                  onClick={() => onEditClient?.(c)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onEditClient?.(c); } }}
                  role="button"
                  tabIndex={0}
                  className="px-4 py-3 hover:bg-stone-50 cursor-pointer group flex items-center gap-3"
                  data-testid={`my-clients-row-${c.id}`}
                >
                  <span className="shrink-0 w-7 h-7 rounded-full bg-[#dedd0a] text-stone-950 border border-stone-950 flex items-center justify-center">
                    <Star className="w-3.5 h-3.5 fill-current" />
                  </span>
                  {expanded ? (
                    // ---- Expanded (wide) layout: spread across the row ----
                    <>
                      <div className="min-w-0 flex-[2]">
                        <div className="font-semibold text-stone-950 text-sm leading-snug truncate">{c.name}</div>
                        <div className="text-[11px] text-stone-600 mt-0.5 truncate">
                          {c.postcode ? <span className="font-mono">{c.postcode}</span> : null}
                          {c.manager && <span>{c.postcode ? " · " : ""}{c.manager}</span>}
                        </div>
                      </div>
                      <div className="hidden md:block flex-1 min-w-0 text-sm text-stone-700 truncate">
                        {c._location || "—"}
                      </div>
                      <div className="hidden lg:flex shrink-0 w-28">
                        <span className="inline-flex px-2 py-1 text-[10px] font-bold uppercase tracking-wider rounded bg-stone-100 text-stone-700 border border-stone-200">
                          {c._type}
                        </span>
                      </div>
                      <div className="hidden lg:flex shrink-0 w-20 justify-end">
                        {c._beds != null && (
                          <span className="inline-flex items-center gap-1 px-2 py-1 text-[10px] font-bold uppercase tracking-wider rounded bg-stone-100 text-stone-700 border border-stone-200">
                            <BedDouble className="w-3 h-3" /> {c._beds}
                          </span>
                        )}
                      </div>
                      <ChevronRight className="w-4 h-4 shrink-0 text-stone-400 group-hover:text-stone-950 group-hover:translate-x-0.5 transition-transform" />
                    </>
                  ) : (
                    // ---- Narrow layout: stacked rows ----
                    <>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-start justify-between gap-2">
                          <div className="font-semibold text-stone-950 text-sm leading-snug break-words">{c.name}</div>
                          <ChevronRight className="w-4 h-4 mt-0.5 shrink-0 text-stone-400 group-hover:text-stone-950 group-hover:translate-x-0.5 transition-transform" />
                        </div>
                        <div className="text-[11px] text-stone-600 mt-1 flex flex-wrap gap-x-2 gap-y-1 items-center">
                          {c.postcode && <span className="font-mono">{c.postcode}</span>}
                          {c._location && <span>· {c._location}</span>}
                          {c.manager && <span>· {c.manager}</span>}
                        </div>
                        <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
                          <span className="inline-flex px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider rounded bg-stone-100 text-stone-700 border border-stone-200">
                            {c._type}
                          </span>
                          {c._beds != null && (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider rounded bg-stone-100 text-stone-700 border border-stone-200">
                              <BedDouble className="w-2.5 h-2.5" /> {c._beds} beds
                            </span>
                          )}
                        </div>
                      </div>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Pagination */}
          {pages > 1 && (
            <div className="px-4 py-2.5 border-t border-stone-200 flex items-center justify-between gap-2 text-[11px] text-stone-600">
              <span data-testid="my-clients-pagination-summary">
                {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, filtered.length)} of {filtered.length}
              </span>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={page === 0}
                  data-testid="my-clients-page-prev"
                  className="w-7 h-7 rounded border border-stone-300 flex items-center justify-center hover:bg-stone-50 disabled:opacity-40"
                  aria-label="Previous page"
                >
                  <ChevronRight className="w-3.5 h-3.5 rotate-180" />
                </button>
                <span className="px-2 tabular-nums font-bold text-stone-900">{page + 1} / {pages}</span>
                <button
                  onClick={() => setPage((p) => Math.min(pages - 1, p + 1))}
                  disabled={page >= pages - 1}
                  data-testid="my-clients-page-next"
                  className="w-7 h-7 rounded border border-stone-300 flex items-center justify-center hover:bg-stone-50 disabled:opacity-40"
                  aria-label="Next page"
                >
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          )}
    </div>
  );
}
