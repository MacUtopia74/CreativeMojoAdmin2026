// MergeContactsModal — side-by-side confirmation modal for combining two
// contacts (e.g. when someone submits the enquiry form twice). The modal
// uses the auto-merged values from the preview endpoint as a starting
// point, lets the admin tweak any field individually, then commits the
// merge.
//
// Trigger paths:
//   - Bulk-select 2 cards on the kanban → "Merge selected" button
//   - From inside a contact drawer → "Merge with…" button → picker
//
// The loser is archived (not deleted) and the survivor inherits the
// most-advanced pipeline stage. See the backend `/contacts/merge` route
// for the full merge contract.
import { useEffect, useMemo, useState } from "react";
import { X, ArrowLeftRight, AlertCircle, CheckCircle2, Loader2, GitMerge } from "lucide-react";
import api from "@/lib/api";

const FIELD_LABELS = {
  first_name: "First name",
  last_name: "Last name",
  email: "Email",
  telephone: "Telephone",
  mobile: "Mobile",
  phone: "Phone",
  address_line_1: "Address line 1",
  address_line_2: "Address line 2",
  town_city: "Town / City",
  city: "City",
  county: "County",
  postcode: "Postcode",
  country: "Country",
  establishment_name: "Establishment",
  organisation: "Organisation",
  website: "Website",
  potential: "Potential",
  heard_about_us: "Heard about us",
  referral_source: "Referral source",
  comments: "Comments",
  message: "Original message",
  why_contacting: "Why contacting",
  facebook: "Facebook",
  google: "Google",
  instagram: "Instagram",
  twitter: "Twitter",
};

const fmtVal = (v) => {
  if (v === null || v === undefined || v === "") return "—";
  return String(v);
};

export default function MergeContactsModal({ open, contactA, contactB, onClose, onMerged }) {
  // ``primaryId`` is the SURVIVOR — its ID is kept, the other is archived.
  // Defaults to whichever contact has the most data (best heuristic so the
  // admin rarely needs to flip it).
  const [primaryId, setPrimaryId] = useState(null);
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [overrides, setOverrides] = useState({});
  const [submitting, setSubmitting] = useState(false);

  // Pick the most-complete contact as the default survivor.
  useEffect(() => {
    if (!open || !contactA || !contactB) return;
    const score = (c) => Object.keys(c).filter((k) => c[k] && c[k] !== "").length
      + (c.in_pipeline ? 5 : 0)
      + (c.admin_notes ? 5 : 0)
      + (c.pipeline_status === "qualified" ? 3 : 0)
      + (c.pipeline_status === "contacted" ? 1 : 0);
    setPrimaryId(score(contactA) >= score(contactB) ? contactA.id : contactB.id);
    setOverrides({});
    setError("");
  }, [open, contactA?.id, contactB?.id]);

  const survivor = primaryId === contactA?.id ? contactA : contactB;
  const loser = primaryId === contactA?.id ? contactB : contactA;

  // Fetch preview whenever survivor/loser changes.
  useEffect(() => {
    if (!open || !survivor || !loser) return;
    setLoading(true);
    setError("");
    api.post("/contacts/merge/preview", { survivor_id: survivor.id, loser_id: loser.id })
      .then(({ data }) => setPreview(data))
      .catch((e) => setError(e?.response?.data?.detail || "Could not load merge preview."))
      .finally(() => setLoading(false));
  }, [open, survivor?.id, loser?.id]);

  // Compute the EFFECTIVE final values: merged + any admin overrides.
  const effective = useMemo(() => {
    if (!preview) return {};
    return { ...preview.merged, ...overrides };
  }, [preview, overrides]);

  // Rows that actually have something interesting to show.
  const rows = useMemo(() => {
    if (!preview) return [];
    return (preview.fields || []).filter((f) => {
      const a = survivor?.[f];
      const b = loser?.[f];
      return (a && a !== "") || (b && b !== "");
    });
  }, [preview, survivor, loser]);

  const swap = () => setPrimaryId((id) => id === contactA?.id ? contactB?.id : contactA?.id);

  const setOverride = (f, fromLoser) => {
    setOverrides((prev) => ({ ...prev, [f]: fromLoser ? loser?.[f] : survivor?.[f] }));
  };

  const submit = async () => {
    if (!survivor || !loser) return;
    setSubmitting(true);
    setError("");
    try {
      const payload = {
        survivor_id: survivor.id,
        loser_id: loser.id,
        field_overrides: Object.keys(overrides).length > 0 ? overrides : null,
      };
      const { data } = await api.post("/contacts/merge", payload);
      onMerged && onMerged(data);
    } catch (e) {
      setError(e?.response?.data?.detail || "Could not merge contacts.");
    } finally {
      setSubmitting(false);
    }
  };

  if (!open || !contactA || !contactB) return null;

  return (
    <div
      onClick={onClose}
      data-testid="merge-modal"
      className="fixed inset-0 z-[60] bg-stone-950/50 backdrop-blur-sm flex items-start justify-center p-4 sm:p-6 overflow-y-auto">
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl my-8 max-h-[90vh] overflow-hidden flex flex-col">
        <div className="px-5 sm:px-6 py-4 border-b border-stone-200 flex items-center justify-between gap-3 sticky top-0 bg-white">
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">CRM · Merge</div>
            <h2 className="text-lg sm:text-xl font-display font-black text-stone-950 flex items-center gap-2">
              <GitMerge className="w-5 h-5" /> Combine two contacts
            </h2>
            <p className="text-xs text-stone-600 mt-0.5">
              The <strong>primary</strong> survives. The other is archived (kept in DB for audit) and its data is folded into the primary&rsquo;s notes.
            </p>
          </div>
          <button onClick={onClose} aria-label="Close" data-testid="merge-close"
            className="touch-target w-9 h-9 flex items-center justify-center hover:bg-stone-100 rounded-lg shrink-0">
            <X className="w-5 h-5" />
          </button>
        </div>

        {loading && (
          <div className="px-6 py-12 flex items-center justify-center text-stone-500 text-sm">
            <Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading preview&hellip;
          </div>
        )}

        {!loading && error && (
          <div className="px-6 py-4 text-sm text-red-700 flex items-center gap-2">
            <AlertCircle className="w-4 h-4" /> {error}
          </div>
        )}

        {!loading && preview && (
          <>
            <div className="px-5 sm:px-6 py-4 grid grid-cols-2 gap-3 border-b border-stone-200 bg-stone-50">
              <ContactCard contact={survivor} role="primary" />
              <ContactCard contact={loser} role="archive" />
              <button
                type="button"
                onClick={swap}
                data-testid="merge-swap"
                className="col-span-2 text-xs font-bold uppercase tracking-wider text-stone-700 hover:text-stone-950 inline-flex items-center justify-center gap-1.5 mt-1">
                <ArrowLeftRight className="w-3.5 h-3.5" /> Swap which is primary
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-5 sm:px-6 py-4">
              <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 mb-2">Field-by-field preview</div>
              <div className="space-y-1">
                {rows.map((f) => {
                  const sVal = survivor?.[f];
                  const lVal = loser?.[f];
                  const finalVal = effective[f];
                  const same = (sVal || "") === (lVal || "");
                  const overridden = Object.prototype.hasOwnProperty.call(overrides, f);
                  return (
                    <div key={f} className={`grid grid-cols-12 gap-3 items-start py-1.5 ${same ? "" : "border-l-2 border-amber-400 pl-2"}`}>
                      <div className="col-span-12 sm:col-span-3 text-[11px] uppercase tracking-wider font-bold text-stone-500 sm:text-right sm:pr-1 sm:pt-1.5">
                        {FIELD_LABELS[f] || f}
                      </div>
                      <button
                        type="button"
                        onClick={() => !same && setOverride(f, false)}
                        data-testid={`merge-row-${f}-primary`}
                        disabled={same}
                        title={same ? "" : "Use primary's value"}
                        className={`col-span-6 sm:col-span-4 text-left text-sm px-2 py-1.5 rounded ${
                          same
                            ? "text-stone-600 bg-stone-50"
                            : finalVal === sVal
                              ? "bg-emerald-50 text-emerald-900 ring-1 ring-emerald-300"
                              : "bg-white text-stone-600 hover:bg-stone-100"
                        }`}>
                        {fmtVal(sVal)}
                      </button>
                      <button
                        type="button"
                        onClick={() => !same && setOverride(f, true)}
                        data-testid={`merge-row-${f}-loser`}
                        disabled={same}
                        title={same ? "" : "Use archived contact's value"}
                        className={`col-span-6 sm:col-span-4 text-left text-sm px-2 py-1.5 rounded ${
                          same
                            ? "text-stone-400 bg-stone-50"
                            : finalVal === lVal
                              ? "bg-emerald-50 text-emerald-900 ring-1 ring-emerald-300"
                              : "bg-white text-stone-600 hover:bg-stone-100"
                        }`}>
                        {fmtVal(lVal)}
                      </button>
                      <div className="hidden sm:flex col-span-1 items-center justify-center pt-1">
                        {overridden && <span className="text-[10px] uppercase tracking-wider text-amber-700 font-bold">edited</span>}
                      </div>
                    </div>
                  );
                })}
                {rows.length === 0 && (
                  <div className="text-xs text-stone-500 py-4">No mergeable field data on either record.</div>
                )}
              </div>
            </div>

            <div className="px-5 sm:px-6 py-4 border-t border-stone-200 flex items-center justify-between gap-3 sticky bottom-0 bg-white">
              <div className="text-[11px] text-stone-500 leading-snug">
                Archived contact&rsquo;s message + notes will be appended to the primary&rsquo;s admin notes.
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={onClose}
                  data-testid="merge-cancel"
                  className="touch-target px-4 text-xs font-bold uppercase tracking-wider border border-stone-300 bg-white hover:bg-stone-50 rounded-lg">
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={submit}
                  disabled={submitting}
                  data-testid="merge-submit"
                  className="touch-target px-5 text-xs font-bold uppercase tracking-wider bg-stone-950 text-white hover:bg-stone-800 disabled:opacity-40 rounded-lg inline-flex items-center gap-1.5">
                  {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                  {submitting ? "Merging…" : "Merge contacts"}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function ContactCard({ contact, role }) {
  const name = [contact.first_name, contact.last_name].filter(Boolean).join(" ") || "(no name)";
  const isPrimary = role === "primary";
  return (
    <div className={`rounded-xl border-2 p-3 ${isPrimary ? "border-stone-950 bg-white" : "border-stone-300 bg-white/60"}`}>
      <div className="flex items-center justify-between mb-1">
        <span className={`text-[10px] uppercase tracking-[0.2em] font-bold ${isPrimary ? "text-stone-950" : "text-stone-500"}`}>
          {isPrimary ? "Primary · keeps ID" : "Archive · folded in"}
        </span>
        {contact.pipeline_status && (
          <span className="text-[9px] uppercase tracking-wider font-bold bg-stone-100 px-1.5 py-0.5 rounded">
            {contact.pipeline_status}
          </span>
        )}
      </div>
      <div className="font-semibold text-stone-950 truncate">{name}</div>
      <div className="text-xs text-stone-600 truncate">{contact.email || "—"}</div>
      <div className="text-[10px] text-stone-500 mt-1 truncate">
        {contact.source || "—"} · {String(contact.date || contact.created_at || "").slice(0, 10) || "—"}
      </div>
    </div>
  );
}
