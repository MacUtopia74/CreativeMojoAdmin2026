import { useEffect, useMemo, useState } from "react";
import { X, Search, Star, Link2, Loader2, AlertCircle, CheckCircle2 } from "lucide-react";
import api from "@/lib/api";

/**
 * LinkExistingFranchiseeModal
 * --------------------------------------------------------------------------
 * Lets an admin link an enquiry contact to an EXISTING franchisee record
 * (no new franchisees row created) — useful when a lead in the pipeline is
 * actually already in the franchisees collection from the historic migration.
 *
 * Props:
 *   open: bool
 *   contact: the contact being linked (must have an `id`)
 *   onClose: () => void
 *   onLinked: (franchiseeId) => void   // called after a successful link
 */
export default function LinkExistingFranchiseeModal({ open, contact, onClose, onLinked }) {
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState([]);
  const [filter, setFilter] = useState("");
  const [picked, setPicked] = useState(null);
  const [appendNotes, setAppendNotes] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!open || !contact?.id) return;
    setLoading(true);
    setError("");
    setPicked(null);
    setFilter("");
    setDone(false);
    api
      .get(`/contacts/${contact.id}/franchisee-matches`)
      .then(({ data }) => setItems(data.items || []))
      .catch(() => setError("Could not load franchisees. Please retry."))
      .finally(() => setLoading(false));
  }, [open, contact?.id]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return items;
    return items.filter((f) => {
      const blob = `${f.first_name || ""} ${f.last_name || ""} ${f.organisation || ""} ${f.email || ""} ${f.postcode || ""} ${f.franchise_number || ""}`.toLowerCase();
      return blob.includes(q);
    });
  }, [items, filter]);

  const suggested = useMemo(() => filtered.filter((f) => f.suggested), [filtered]);
  const rest = useMemo(() => filtered.filter((f) => !f.suggested), [filtered]);

  const submit = async () => {
    if (!picked) return;
    setSubmitting(true);
    setError("");
    try {
      await api.post(`/contacts/${contact.id}/link-to-franchisee`, {
        franchisee_id: picked.id,
        append_to_notes: appendNotes,
      });
      setDone(true);
      // Brief success state then bubble up + close.
      setTimeout(() => {
        onLinked && onLinked(picked.id);
      }, 600);
    } catch (e) {
      setError(e?.response?.data?.detail || "Could not link contact.");
    } finally {
      setSubmitting(false);
    }
  };

  if (!open) return null;
  const contactName = [contact?.first_name, contact?.last_name].filter(Boolean).join(" ") || "this contact";

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-[60] bg-stone-950/40 backdrop-blur-sm flex items-start justify-center p-6 overflow-y-auto"
      data-testid="link-franchisee-modal"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-2xl bg-white border border-stone-200 rounded-2xl shadow-2xl my-10"
      >
        <div className="px-6 py-4 border-b border-stone-200 flex items-center justify-between sticky top-0 bg-white z-10 rounded-t-2xl">
          <div>
            <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-500">CRM</div>
            <h2 className="text-xl font-display font-black text-stone-950 mt-1 flex items-center gap-2">
              <Link2 className="w-5 h-5 text-stone-700" /> Link to existing franchisee
            </h2>
            <p className="text-xs text-stone-600 mt-1">
              Linking <strong>{contactName}</strong> — they&rsquo;ll be marked as already converted and removed from the pipeline.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            data-testid="link-close"
            className="w-9 h-9 flex items-center justify-center hover:bg-stone-100 rounded-lg"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-6 space-y-4">
          {/* Filter */}
          <div className="relative">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-stone-400" />
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Search by name, organisation, email, postcode, franchise #"
              data-testid="link-filter"
              className="w-full pl-9 pr-3 py-2 bg-white border border-stone-300 rounded-lg text-sm focus:outline-none focus:border-stone-900"
            />
          </div>

          {error && (
            <div className="border border-red-200 bg-red-50 px-3 py-2 rounded-lg text-sm text-red-800 flex items-center gap-2">
              <AlertCircle className="w-4 h-4" /> {error}
            </div>
          )}

          {loading ? (
            <div className="py-10 flex items-center justify-center text-stone-500 text-sm">
              <Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading franchisees&hellip;
            </div>
          ) : done ? (
            <div className="py-10 flex flex-col items-center justify-center text-emerald-700 text-sm">
              <CheckCircle2 className="w-8 h-8 mb-2" />
              <div className="font-bold">Linked successfully</div>
            </div>
          ) : (
            <>
              {/* Suggested matches */}
              {suggested.length > 0 && (
                <div data-testid="link-suggested">
                  <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 mb-2 flex items-center gap-1.5">
                    <Star className="w-3 h-3 text-amber-500 fill-amber-500" /> Suggested matches
                  </div>
                  <div className="space-y-1.5">
                    {suggested.map((f) => (
                      <FranchiseeRow key={f.id} f={f} picked={picked} setPicked={setPicked} suggested />
                    ))}
                  </div>
                </div>
              )}

              {/* All / filtered list */}
              <div>
                <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 mb-2 flex items-center justify-between">
                  <span>{filter ? "All matches" : "Browse all franchisees"}</span>
                  <span className="text-stone-400">{rest.length}</span>
                </div>
                <div className="border border-stone-200 rounded-xl overflow-y-auto max-h-[40vh]">
                  {rest.length === 0 ? (
                    <div className="py-8 text-center text-stone-500 text-sm">No franchisees match this search.</div>
                  ) : (
                    <div className="divide-y divide-stone-100">
                      {rest.map((f) => (
                        <FranchiseeRow key={f.id} f={f} picked={picked} setPicked={setPicked} />
                      ))}
                    </div>
                  )}
                </div>
              </div>

              <label className="flex items-start gap-2 text-sm text-stone-700 select-none">
                <input
                  type="checkbox"
                  checked={appendNotes}
                  onChange={(e) => setAppendNotes(e.target.checked)}
                  className="mt-0.5"
                  data-testid="link-append-notes"
                />
                <span>Append original enquiry (date, source, referral, message) to the franchisee&rsquo;s notes for audit.</span>
              </label>
            </>
          )}
        </div>

        {!done && (
          <div className="px-6 py-4 border-t border-stone-200 flex items-center justify-between gap-3 sticky bottom-0 bg-white rounded-b-2xl">
            <button
              type="button"
              onClick={onClose}
              data-testid="link-cancel"
              className="px-4 py-2 text-xs font-bold uppercase tracking-wider border border-stone-300 bg-white text-stone-700 hover:bg-stone-50 rounded-lg"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={!picked || submitting}
              data-testid="link-confirm"
              className="px-5 py-2 text-xs font-bold uppercase tracking-wider bg-stone-950 text-white hover:bg-stone-800 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg flex items-center gap-1.5"
            >
              <Link2 className="w-3.5 h-3.5" />
              {submitting
                ? "Linking…"
                : picked
                  ? `Link to ${picked.first_name || ""} ${picked.last_name || ""}`.trim()
                  : "Pick a franchisee"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function FranchiseeRow({ f, picked, setPicked, suggested = false }) {
  const isPicked = picked?.id === f.id;
  const name = [f.first_name, f.last_name].filter(Boolean).join(" ") || "(no name)";
  return (
    <button
      type="button"
      onClick={() => setPicked(f)}
      data-testid={`link-row-${f.id}`}
      className={`w-full text-left px-3 py-2.5 flex items-center gap-3 transition-colors ${
        isPicked
          ? "bg-[#dddd16]/20 border border-stone-950 rounded-lg"
          : suggested
            ? "bg-amber-50/60 hover:bg-amber-50 border border-amber-200 rounded-lg"
            : "hover:bg-stone-50"
      }`}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-semibold text-stone-950 text-sm">{name}</span>
          {f.franchise_number && (
            <span className="text-[10px] font-bold text-stone-500 tabular-nums">#{f.franchise_number}</span>
          )}
          {f.record_type === "licencee" && (
            <span className="text-[9px] font-bold uppercase tracking-wider bg-indigo-50 text-indigo-700 border border-indigo-200 px-1.5 py-0.5 rounded">
              Licencee
            </span>
          )}
        </div>
        {(f.organisation || f.email || f.postcode) && (
          <div className="text-xs text-stone-600 truncate mt-0.5">
            {[f.organisation, f.email, f.postcode].filter(Boolean).join(" · ")}
          </div>
        )}
        {suggested && f.match_reasons?.length > 0 && (
          <div className="text-[10px] text-amber-800 mt-1 flex items-center gap-1 flex-wrap">
            <Star className="w-2.5 h-2.5 fill-amber-500 text-amber-500" />
            {f.match_reasons.join(" · ")}
          </div>
        )}
      </div>
      <span
        className={`shrink-0 w-4 h-4 rounded-full border-2 ${
          isPicked ? "bg-stone-950 border-stone-950" : "border-stone-300"
        }`}
      />
    </button>
  );
}
