// DuplicatesModal — surfaces every group of contacts that share the same
// (case-insensitive) email address so an admin can route them out via the
// existing two-way merge flow.
//
// Trigger: "Find Duplicates" button in the Contacts toolbar.
// Backend: GET /api/contacts/duplicates → { groups[], total_groups, total_contacts }.
//
// UX:
//   - Search box filters groups by email substring.
//   - Each group is collapsible and lists its members in a compact table.
//   - Admin clicks two rows → "Merge selected" button enables.
//   - That hands the two contacts back to the parent, which opens the existing
//     <MergeContactsModal>. On successful merge we refetch so the loser row
//     drops off (or the whole group disappears once count falls to 1).
import { useEffect, useMemo, useState } from "react";
import {
  X, Loader2, GitMerge, Search, ChevronDown, ChevronRight,
  AlertCircle, RefreshCw, Mail,
} from "lucide-react";
import api from "@/lib/api";

const SOURCE_PILL = {
  franchise_enquiry: { label: "Franchise", cls: "bg-stone-100 text-stone-800 border-stone-300" },
  licence_enquiry:   { label: "Licence",   cls: "bg-indigo-50 text-indigo-800 border-indigo-300" },
  general_enquiry:   { label: "General",   cls: "bg-stone-100 text-stone-700 border-stone-200" },
  legacy_general_enquiry: { label: "Legacy", cls: "bg-stone-100 text-stone-500 border-stone-200" },
};

const STAGE_LABEL = {
  new: "New", contacted: "Contacted", qualified: "Interested",
  demo_booked: "Shadow Day", converted: "Territory Map",
  dormant: "Dormant", lost: "Lost",
};

const fmtName = (c) => {
  const n = `${c.first_name || ""} ${c.last_name || ""}`.trim();
  return n || "—";
};

const fmtDate = (s) => {
  if (!s) return "";
  try {
    const d = new Date(s);
    return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "2-digit" });
  } catch { return ""; }
};

export default function DuplicatesModal({ open, onClose, onPickPair, reloadAt = 0 }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [data, setData] = useState(null);  // { groups, total_groups, total_contacts }
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState({}); // email -> bool
  const [selectedByGroup, setSelectedByGroup] = useState({}); // email -> [contactId, contactId]

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const { data } = await api.get("/contacts/duplicates");
      setData(data);
      // Drop any stale row selections that no longer exist post-merge.
      setSelectedByGroup({});
    } catch (e) {
      setError(e?.response?.data?.detail || "Could not load duplicates.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    load();
    setQuery("");
    setExpanded({});
    setSelectedByGroup({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // External "merge committed" pings — reload silently so the loser row
  // drops off the displayed groups.
  useEffect(() => {
    if (!open || !reloadAt) return;
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadAt]);

  const filteredGroups = useMemo(() => {
    if (!data?.groups) return [];
    const q = query.trim().toLowerCase();
    if (!q) return data.groups;
    return data.groups.filter((g) => g.match_value.includes(q));
  }, [data, query]);

  const toggleExpand = (email) => {
    setExpanded((prev) => ({ ...prev, [email]: !prev[email] }));
  };

  const toggleSelect = (email, contactId) => {
    setSelectedByGroup((prev) => {
      const cur = prev[email] || [];
      if (cur.includes(contactId)) {
        return { ...prev, [email]: cur.filter((x) => x !== contactId) };
      }
      // Cap at 2 — the merge endpoint takes exactly survivor + loser.
      if (cur.length >= 2) {
        return { ...prev, [email]: [cur[1], contactId] };
      }
      return { ...prev, [email]: [...cur, contactId] };
    });
  };

  const launchMerge = (group) => {
    const ids = selectedByGroup[group.match_value] || [];
    if (ids.length !== 2) return;
    const a = group.contacts.find((c) => c.id === ids[0]);
    const b = group.contacts.find((c) => c.id === ids[1]);
    if (!a || !b) return;
    onPickPair && onPickPair(a, b);
  };

  if (!open) return null;

  return (
    <div
      data-testid="duplicates-modal"
      onClick={onClose}
      className="fixed inset-0 z-[55] bg-stone-950/50 backdrop-blur-sm flex items-start justify-center p-4 sm:p-6 overflow-y-auto"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-white rounded-2xl shadow-2xl w-full max-w-5xl my-8 max-h-[90vh] overflow-hidden flex flex-col"
      >
        {/* Header */}
        <div className="px-5 sm:px-6 py-4 border-b border-stone-200 flex items-center justify-between gap-3 sticky top-0 bg-white z-10">
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">CRM · Duplicate Finder</div>
            <h2 className="text-lg sm:text-xl font-display font-black text-stone-950 flex items-center gap-2">
              <GitMerge className="w-5 h-5" /> Find duplicate contacts
            </h2>
            <p className="text-xs text-stone-600 mt-0.5">
              Contacts grouped by exact email match (case-insensitive). Pick two rows in a group, then merge.
            </p>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={load}
              disabled={loading}
              data-testid="duplicates-refresh"
              className="touch-target w-9 h-9 flex items-center justify-center hover:bg-stone-100 rounded-lg disabled:opacity-40"
              title="Refresh"
              aria-label="Refresh"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
            </button>
            <button
              type="button"
              onClick={onClose}
              data-testid="duplicates-close"
              className="touch-target w-9 h-9 flex items-center justify-center hover:bg-stone-100 rounded-lg"
              aria-label="Close"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Summary + Search */}
        <div className="px-5 sm:px-6 py-3 border-b border-stone-200 bg-stone-50 flex flex-col sm:flex-row sm:items-center gap-3">
          {data && (
            <div className="text-xs text-stone-700 font-medium" data-testid="duplicates-summary">
              <span className="font-bold text-stone-950">{data.total_groups.toLocaleString()}</span> duplicate groups containing{" "}
              <span className="font-bold text-stone-950">{data.total_contacts.toLocaleString()}</span> contacts
              {query && (
                <span className="ml-2 text-stone-500">· filtered to {filteredGroups.length.toLocaleString()}</span>
              )}
            </div>
          )}
          <div className="relative sm:ml-auto">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-stone-400" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              data-testid="duplicates-search"
              placeholder="Filter by email…"
              className={`pl-9 ${query ? "pr-9" : "pr-3"} py-2 w-72 bg-white border border-stone-300 text-sm focus:outline-none focus:border-stone-900 rounded-lg`}
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                data-testid="duplicates-search-clear"
                aria-label="Clear filter"
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-stone-400 hover:text-stone-900 hover:bg-stone-200 rounded-md transition-colors"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-3 sm:px-5 py-3">
          {loading && !data && (
            <div className="py-16 flex items-center justify-center text-stone-500 text-sm">
              <Loader2 className="w-4 h-4 animate-spin mr-2" /> Scanning contacts&hellip;
            </div>
          )}

          {error && (
            <div className="my-4 p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-800 flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" /> {error}
            </div>
          )}

          {!loading && data && filteredGroups.length === 0 && (
            <div className="py-16 text-center text-sm text-stone-500" data-testid="duplicates-empty">
              {data.total_groups === 0
                ? "No duplicate email addresses found. Nice and tidy."
                : "No groups match that filter."}
            </div>
          )}

          <div className="space-y-2">
            {filteredGroups.slice(0, 200).map((g) => {
              const isOpen = !!expanded[g.match_value];
              const sel = selectedByGroup[g.match_value] || [];
              return (
                <div
                  key={g.match_value}
                  data-testid="duplicate-group"
                  className="border border-stone-200 rounded-xl bg-white overflow-hidden"
                >
                  <button
                    type="button"
                    onClick={() => toggleExpand(g.match_value)}
                    className="w-full px-3 sm:px-4 py-2.5 flex items-center gap-3 hover:bg-stone-50 transition-colors text-left"
                    data-testid={`duplicate-group-toggle-${g.match_value}`}
                  >
                    {isOpen ? <ChevronDown className="w-4 h-4 text-stone-500 shrink-0" /> : <ChevronRight className="w-4 h-4 text-stone-500 shrink-0" />}
                    <Mail className="w-3.5 h-3.5 text-stone-400 shrink-0" />
                    <span className="font-mono text-sm text-stone-900 truncate">{g.match_value}</span>
                    <span className="ml-auto inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-100 text-amber-900 border border-amber-200 text-[10px] font-bold uppercase tracking-wider shrink-0">
                      {g.count} contacts
                    </span>
                  </button>
                  {isOpen && (
                    <div className="border-t border-stone-200 bg-stone-50/60">
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="text-stone-500 uppercase tracking-wider text-[10px]">
                              <th className="px-3 py-2 text-left font-bold">Select</th>
                              <th className="px-3 py-2 text-left font-bold">Name</th>
                              <th className="px-3 py-2 text-left font-bold">Source</th>
                              <th className="px-3 py-2 text-left font-bold">Stage</th>
                              <th className="px-3 py-2 text-left font-bold">Postcode</th>
                              <th className="px-3 py-2 text-left font-bold">Created</th>
                              <th className="px-3 py-2 text-left font-bold">GF Entry</th>
                            </tr>
                          </thead>
                          <tbody>
                            {g.contacts.map((c) => {
                              const checked = sel.includes(c.id);
                              const srcStyle = SOURCE_PILL[c.source] || { label: c.source || "—", cls: "bg-stone-100 text-stone-700 border-stone-200" };
                              return (
                                <tr
                                  key={c.id}
                                  className={`border-t border-stone-200 ${checked ? "bg-amber-50" : "hover:bg-white"}`}
                                  data-testid={`duplicate-row-${c.id}`}
                                >
                                  <td className="px-3 py-2">
                                    <input
                                      type="checkbox"
                                      checked={checked}
                                      onChange={() => toggleSelect(g.match_value, c.id)}
                                      data-testid={`duplicate-select-${c.id}`}
                                      className="w-4 h-4 accent-stone-900 cursor-pointer"
                                    />
                                  </td>
                                  <td className="px-3 py-2 font-medium text-stone-900">{fmtName(c)}</td>
                                  <td className="px-3 py-2">
                                    <span className={`inline-block px-2 py-0.5 rounded-full border text-[10px] font-bold uppercase tracking-wider ${srcStyle.cls}`}>
                                      {srcStyle.label}
                                    </span>
                                  </td>
                                  <td className="px-3 py-2 text-stone-700">
                                    {c.in_pipeline ? (STAGE_LABEL[c.pipeline_status] || c.pipeline_status || "—") : <span className="text-stone-400">—</span>}
                                  </td>
                                  <td className="px-3 py-2 text-stone-700 font-mono">{c.postcode || "—"}</td>
                                  <td className="px-3 py-2 text-stone-500 whitespace-nowrap">{fmtDate(c.created_at)}</td>
                                  <td className="px-3 py-2 text-stone-500 font-mono">{c.gravity_entry_id || "—"}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                      <div className="px-3 py-2 flex items-center justify-between gap-3 border-t border-stone-200 bg-white">
                        <span className="text-[11px] text-stone-500">
                          {sel.length === 0 && "Pick two rows to merge."}
                          {sel.length === 1 && "Select one more row to merge."}
                          {sel.length === 2 && "Ready to merge — click below."}
                        </span>
                        <button
                          type="button"
                          disabled={sel.length !== 2}
                          onClick={() => launchMerge(g)}
                          data-testid={`duplicate-merge-${g.match_value}`}
                          className="px-3 py-1.5 bg-stone-950 text-white text-[11px] font-bold uppercase tracking-wider hover:bg-stone-800 transition-colors rounded-lg flex items-center gap-1.5 disabled:opacity-30 disabled:cursor-not-allowed"
                        >
                          <GitMerge className="w-3.5 h-3.5" /> Merge selected
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
            {filteredGroups.length > 200 && (
              <div className="px-3 py-3 text-center text-[11px] text-stone-500">
                Showing first 200 groups — refine the email filter to see more.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
