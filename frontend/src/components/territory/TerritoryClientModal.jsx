// Edit-or-create modal for a Territory+ "my client" entry. Form fields
// mirror the schema in territory_plus_routes.py. The same modal is used
// for both freshly-added clients (no ``initial``) and edits.
//
// For CQC/Scotland-linked clients: the franchisee can override ANY field
// (the doc is a private snapshot, never written back to the public CQC
// dataset). The "View live CQC data" button opens a side-by-side popup
// of the current live values so they can compare/reset to source.
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { X, Loader2, Trash2, UserPlus, ExternalLink, Database, MailX, Mail, Megaphone, Check } from "lucide-react";
import api from "@/lib/api";
import MiniClientMap from "@/components/territory/MiniClientMap";
import { LEAD_STATUS_OPTIONS, TONE_STYLES, getLeadStatusMeta } from "@/lib/leadStatus";

const FIELDS = [
  { key: "name",              label: "Name *",            type: "text", required: true },
  { key: "address",           label: "Address",           type: "textarea" },
  { key: "postcode",          label: "Postcode",          type: "text", hint: "We'll drop a marker on the map automatically." },
  { key: "phone",             label: "Phone",             type: "text" },
  { key: "website",           label: "Website",           type: "text" },
  { key: "provider",          label: "Provider (if applicable)", type: "text" },
  { key: "manager",           label: "Manager",           type: "text" },
  { key: "email",             label: "Email",             type: "text" },
  { key: "latest_inspection", label: "Latest inspection", type: "text" },
  { key: "cqc_rating",        label: "CQC rating",        type: "text" },
];

const CONTACT_METHOD_OPTIONS = [
  { value: "phone",           label: "Phone" },
  { value: "email",           label: "Email" },
  { value: "in_person",       label: "In Person" },
  { value: "facebook",        label: "Facebook" },
  { value: "linkedin",        label: "LinkedIn" },
  { value: "website_enquiry", label: "Website Enquiry" },
  { value: "other",           label: "Other" },
];

export default function TerritoryClientModal({ initial, onClose, onSaved, onDeleted, cqcSnapshot = null, marketingEnabled = false }) {
  const navigate = useNavigate();
  const [form, setForm] = useState(() => {
    const empty = Object.fromEntries(FIELDS.map((f) => [f.key, ""]));
    // Default status: rows with no ``lead_status`` set (legacy records
    // or freshly-marked prospects) are treated as "Not Contacted"
    // everywhere — the My Clients list already falls back to this, so
    // the modal must too or the dropdown reads "— select status —"
    // while the row chip shouts NOT CONTACTED.
    if (!initial) return { ...empty, notes: "", contacts: [], lead_status: "not_contacted", last_contact_date: "", last_contact_method: "", follow_up_required: false, follow_up_date: "", follow_up_notes: "" };
    return {
      ...empty,
      last_contact_date: "",
      last_contact_method: "",
      follow_up_date: "",
      follow_up_notes: "",
      ...Object.fromEntries(
        Object.entries(initial)
          .filter(([k]) => k !== "follow_up_required")
          .map(([k, v]) => [k, v ?? ""]),
      ),
      // ``initial.lead_status`` may be missing or empty (older records)
      // — coerce to the canonical default so the dropdown matches the
      // list view's fallback chip.
      lead_status: initial.lead_status || "not_contacted",
      notes: initial.notes || "",
      contacts: Array.isArray(initial.contacts) ? initial.contacts : [],
      follow_up_required: !!initial.follow_up_required,
    };
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [showCqc, setShowCqc] = useState(false);

  const editing = !!initial?.id;
  const isCustom = !initial || initial.source === "custom";
  const isLinked = !!initial && initial.source !== "custom";
  // A client only graduates from "Prospective" to "Client" once the
  // franchisee bumps Lead Status to "Regular Client" in the Marketing
  // panel. Drives the header label + the save-button copy below.
  const isRegularClient = (form.lead_status || "") === "regular_client";

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  // Toggle the per-contact marketing-unsubscribed flag. The persistence
  // is a separate single-purpose endpoint (rather than rolled into the
  // main save) so the franchisee can toggle it without first having
  // to fix any other validation errors on the form.
  const toggleUnsubscribed = async (contactIndex, currentlyUnsub) => {
    if (!editing || !initial?.id) return;
    setBusy(true); setErr("");
    try {
      await api.post(`/portal/marketing/clients/${initial.id}/unsubscribe`, {
        contact_index: contactIndex,
        unsubscribed: !currentlyUnsub,
      });
      // Mirror the change into local form state so the UI updates
      // immediately without an extra round-trip.
      if (contactIndex === -1) {
        setForm((f) => ({ ...f, primary_marketing_unsubscribed: !currentlyUnsub }));
      } else {
        setForm((f) => {
          const next = [...(f.contacts || [])];
          if (next[contactIndex]) {
            next[contactIndex] = {
              ...next[contactIndex],
              marketing_unsubscribed: !currentlyUnsub,
            };
          }
          return { ...f, contacts: next };
        });
      }
    } catch (e) {
      setErr(e?.response?.data?.detail || "Couldn't update marketing status.");
    } finally {
      setBusy(false);
    }
  };

  const updateContact = (i, k, v) => {
    setForm((f) => {
      const next = [...(f.contacts || [])];
      next[i] = { ...next[i], [k]: v };
      return { ...f, contacts: next };
    });
  };
  const addContact = () => {
    setForm((f) => ({
      ...f,
      contacts: [...(f.contacts || []), { name: "", role: "", phone: "", email: "", notes: "" }],
    }));
  };
  const removeContact = (i) => {
    setForm((f) => ({ ...f, contacts: (f.contacts || []).filter((_, idx) => idx !== i) }));
  };

  const save = async (e) => {
    e?.preventDefault?.();
    setErr("");
    if (!form.name.trim()) { setErr("Name is required."); return; }
    setBusy(true);
    try {
      // Strip empty strings so the backend doesn't store "" instead of null.
      const cleaned = Object.fromEntries(
        Object.entries(form).map(([k, v]) => {
          if (k === "contacts") return [k, v];
          return [k, typeof v === "string" ? (v.trim() || null) : v];
        })
      );
      // Drop fully-empty contact rows so we don't litter the DB.
      cleaned.contacts = (form.contacts || []).filter((c) =>
        (c.name || c.role || c.phone || c.email || c.notes || "").trim()
      ).map((c) => ({
        name: (c.name || "").trim() || null,
        role: (c.role || "").trim() || null,
        phone: (c.phone || "").trim() || null,
        email: (c.email || "").trim() || null,
        notes: (c.notes || "").trim() || null,
        include_for_marketing: c.include_for_marketing !== false,
      }));
      const body = cleaned;
      let res;
      if (editing) {
        res = await api.patch(`/portal/territory-plus/clients/${initial.id}`, body);
      } else {
        res = await api.post("/portal/territory-plus/clients", body);
      }
      onSaved?.(res.data);
      onClose?.();
    } catch (e2) {
      setErr(e2?.response?.data?.detail || "Couldn't save the client.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!editing) return;
    if (!window.confirm(`Remove ${initial.name} from your clients?`)) return;
    setBusy(true); setErr("");
    try {
      if (initial.source === "custom") {
        await api.delete(`/portal/territory-plus/clients/${initial.id}`);
      } else {
        // Regulated home → unmark via the mark-home endpoint.
        await api.delete(`/portal/territory-plus/clients/mark-home`, {
          data: { source: initial.source, home_id: initial.home_id },
        });
      }
      onDeleted?.(initial);
      onClose?.();
    } catch (e2) {
      setErr(e2?.response?.data?.detail || "Couldn't remove the client.");
    } finally {
      setBusy(false);
    }
  };

  // Esc to close.
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose?.(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-5 sm:p-6 bg-stone-950/60 backdrop-blur-sm"
      onClick={onClose}
      data-testid="t-plus-client-modal"
    >
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-5xl max-h-[92vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 sm:px-7 py-4 border-b border-stone-200 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">
              {isRegularClient
                ? (editing ? "My client" : "Add a client")
                : (editing ? "My prospective client" : "Add a prospective client")}
            </div>
            <h2 className="font-display text-xl font-black text-stone-950 truncate">
              {editing ? (form.name || "—") : (isRegularClient ? "New client" : "New prospect")}
            </h2>
          </div>
          <button onClick={onClose} data-testid="t-plus-client-close" className="p-2 -mr-1 text-stone-600 hover:bg-stone-100 rounded-lg shrink-0">
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={save} className="flex-1 overflow-y-auto px-6 sm:px-7 py-5 space-y-4">
          {isLinked && (
            <div className="px-3 py-2.5 bg-amber-50 border border-amber-200 text-amber-900 text-xs rounded-lg flex items-start gap-3">
              <div className="flex-1">
                This client started from <strong>{
                  initial.source === "scotland" ? "Care Inspectorate Scotland"
                  : initial.source === "wales" ? "Care Inspectorate Wales (CIW)"
                  : initial.source === "ni" ? "RQIA (Northern Ireland)"
                  : "CQC"
                }</strong>.
                You can edit any field — your changes are private to you and never written
                back to the public dataset.
              </div>
              {cqcSnapshot && (
                <button
                  type="button"
                  onClick={() => setShowCqc(true)}
                  data-testid="t-plus-view-cqc"
                  className="shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-wider bg-stone-950 text-white hover:bg-stone-800 rounded-md"
                >
                  <Database className="w-3 h-3" /> View live CQC data
                </button>
              )}
            </div>
          )}
          {err && (
            <div className="px-3 py-2 bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg">{err}</div>
          )}

          {/* TWO-COLUMN GRID — fields on the left, map + marketing on the right.
              Collapses to a single column under lg: so phones still get the
              same form-then-map-then-marketing flow.                              */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
            {/* LEFT COLUMN — name, address, contact details, notes, contacts */}
            <div className="lg:col-span-7 space-y-4 min-w-0">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {FIELDS.map((f) => (
                  <div key={f.key} className={f.type === "textarea" ? "sm:col-span-2" : ""}>
                    <label className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 mb-1 block">{f.label}</label>
                    {f.type === "textarea" ? (
                      <textarea
                        value={form[f.key] ?? ""}
                        onChange={(e) => set(f.key, e.target.value)}
                        rows={2}
                        data-testid={`t-plus-field-${f.key}`}
                        className="w-full px-3 py-2 text-sm bg-stone-50 border border-stone-300 rounded-lg focus:outline-none focus:border-stone-950"
                      />
                    ) : (
                      <input
                        type="text"
                        value={form[f.key] ?? ""}
                        onChange={(e) => set(f.key, e.target.value)}
                        required={f.required}
                        data-testid={`t-plus-field-${f.key}`}
                        className="w-full px-3 py-2 text-sm bg-stone-50 border border-stone-300 rounded-lg focus:outline-none focus:border-stone-950"
                      />
                    )}
                    {f.hint && <div className="text-[11px] text-stone-500 mt-1">{f.hint}</div>}
                  </div>
                ))}
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 mb-1 block">Notes</label>
                <textarea
                  value={form.notes || ""}
                  onChange={(e) => set("notes", e.target.value)}
                  rows={3}
                  data-testid="t-plus-field-notes"
                  className="w-full px-3 py-2 text-sm bg-stone-50 border border-stone-300 rounded-lg focus:outline-none focus:border-stone-950"
                />
              </div>

              {(form.email || "").trim() && (
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={form.manager_include_for_marketing !== false}
                    onChange={(e) => set("manager_include_for_marketing", e.target.checked)}
                    data-testid="t-plus-primary-marketing"
                    className="w-4 h-4 rounded border-stone-300 accent-stone-950"
                  />
                  <span className="text-stone-700">Include manager / primary contact in Marketing+ e-shots</span>
                </label>
              )}
              {editing && (form.email || "").trim() && (
                <UnsubscribeRow
                  label="Primary contact marketing"
                  email={form.email}
                  unsubscribed={!!form.primary_marketing_unsubscribed}
                  unsubscribedAt={form.primary_marketing_unsubscribed_at}
                  source={form.primary_marketing_unsubscribed_source}
                  onToggle={() => toggleUnsubscribed(-1, !!form.primary_marketing_unsubscribed)}
                  busy={busy}
                  testid="t-plus-primary-unsub"
                />
              )}

              {/* Additional contacts moved into the left column */}
              <div data-testid="t-plus-contacts-section">
                <div className="flex items-center justify-between gap-2 mb-2">
                  <div>
                    <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600">Additional contacts</div>
                    <div className="text-[11px] text-stone-500">Extra people you deal with at this client beyond the main manager.</div>
                  </div>
                  <button
                    type="button"
                    onClick={addContact}
                    data-testid="t-plus-add-contact"
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-wider bg-stone-100 hover:bg-stone-200 text-stone-900 rounded-md border border-stone-300"
                  >
                    <UserPlus className="w-3.5 h-3.5" /> Add contact
                  </button>
                </div>
                {(form.contacts || []).length === 0 && (
                  <div className="px-4 py-5 text-center text-[11px] text-stone-500 bg-stone-50 border border-dashed border-stone-300 rounded-lg">
                    No additional contacts yet.
                  </div>
                )}
                <div className="space-y-2">
                  {(form.contacts || []).map((c, i) => (
                    <div key={i} className="bg-stone-50 border border-stone-200 rounded-lg p-3" data-testid={`t-plus-contact-row-${i}`}>
                      <div className="flex items-center justify-between gap-2 mb-2">
                        <div className="text-[10px] uppercase tracking-wider font-bold text-stone-500">Contact #{i + 1}</div>
                        <button
                          type="button"
                          onClick={() => removeContact(i)}
                          data-testid={`t-plus-remove-contact-${i}`}
                          className="p-1 text-stone-500 hover:text-red-700 hover:bg-red-50 rounded"
                          aria-label="Remove contact"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        <input
                          type="text"
                          value={c.name || ""}
                          onChange={(e) => updateContact(i, "name", e.target.value)}
                          placeholder="Name"
                          data-testid={`t-plus-contact-name-${i}`}
                          className="px-2.5 py-1.5 text-sm bg-white border border-stone-300 rounded focus:outline-none focus:border-stone-950"
                        />
                        <input
                          type="text"
                          value={c.role || ""}
                          onChange={(e) => updateContact(i, "role", e.target.value)}
                          placeholder="Role (e.g. Deputy Manager)"
                          data-testid={`t-plus-contact-role-${i}`}
                          className="px-2.5 py-1.5 text-sm bg-white border border-stone-300 rounded focus:outline-none focus:border-stone-950"
                        />
                        <input
                          type="text"
                          value={c.phone || ""}
                          onChange={(e) => updateContact(i, "phone", e.target.value)}
                          placeholder="Phone"
                          data-testid={`t-plus-contact-phone-${i}`}
                          className="px-2.5 py-1.5 text-sm bg-white border border-stone-300 rounded focus:outline-none focus:border-stone-950"
                        />
                        <div className="flex flex-col gap-1">
                          <input
                            type="text"
                            value={c.email || ""}
                            onChange={(e) => updateContact(i, "email", e.target.value)}
                            placeholder="Email"
                            data-testid={`t-plus-contact-email-${i}`}
                            className="px-2.5 py-1.5 text-sm bg-white border border-stone-300 rounded focus:outline-none focus:border-stone-950"
                          />
                          {(c.email || "").trim() && (
                            <label className="flex items-center gap-1.5 text-[11px] text-stone-600 cursor-pointer">
                              <input
                                type="checkbox"
                                checked={c.include_for_marketing !== false}
                                onChange={(e) => updateContact(i, "include_for_marketing", e.target.checked)}
                                data-testid={`t-plus-contact-marketing-${i}`}
                                className="w-3.5 h-3.5 rounded border-stone-300 accent-stone-950"
                              />
                              Include contact for e-shot marketing
                            </label>
                          )}
                        </div>
                      </div>
                      <textarea
                        value={c.notes || ""}
                        onChange={(e) => updateContact(i, "notes", e.target.value)}
                        placeholder="Notes about this contact (optional)"
                        rows={2}
                        data-testid={`t-plus-contact-notes-${i}`}
                        className="mt-2 w-full px-2.5 py-1.5 text-sm bg-white border border-stone-300 rounded focus:outline-none focus:border-stone-950"
                      />
                      {editing && (c.email || "").trim() && (
                        <div className="mt-2">
                          <UnsubscribeRow
                            label="Marketing"
                            email={c.email}
                            unsubscribed={!!c.marketing_unsubscribed}
                            unsubscribedAt={c.marketing_unsubscribed_at}
                            source={c.marketing_unsubscribed_source}
                            onToggle={() => toggleUnsubscribed(i, !!c.marketing_unsubscribed)}
                            busy={busy}
                            testid={`t-plus-contact-unsub-${i}`}
                            compact
                          />
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* RIGHT COLUMN — map (taller) + Marketing CRM panel */}
            <div className="lg:col-span-5 space-y-4 min-w-0">
              {(() => {
                const lat = cqcSnapshot?.latitude ?? initial?.lat ?? null;
                const lng = cqcSnapshot?.longitude ?? initial?.lng ?? null;
                return (
                  <MiniClientMap
                    lat={lat}
                    lng={lng}
                    label={form.name}
                    postcode={form.postcode || cqcSnapshot?.postalCode || ""}
                    heightClass="h-72"
                  />
                );
              })()}

              <MarketingCrmPanel
                form={form}
                set={set}
                marketingEnabled={marketingEnabled}
                onOpenMarketingPlus={() => {
                  // Deep-link to Marketing+ with this client pre-selected.
                  // Only meaningful for saved clients (need an id).
                  if (initial?.id) {
                    navigate(`/portal/marketing?client_id=${encodeURIComponent(initial.id)}`);
                    onClose?.();
                  }
                }}
                clientSaved={!!initial?.id}
              />
            </div>
          </div>
        </form>

        <div className="px-6 sm:px-7 py-4 border-t border-stone-200 flex items-center justify-between gap-3">
          <div>
            {editing && (
              <button
                type="button"
                onClick={remove}
                disabled={busy}
                data-testid="t-plus-client-delete"
                className="px-3 py-2 text-xs font-bold uppercase tracking-wider bg-red-50 hover:bg-red-100 text-red-700 rounded-lg flex items-center gap-1.5"
              >
                <Trash2 className="w-3.5 h-3.5" /> {initial.source === "custom" ? "Delete client" : "Remove flag"}
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={onClose} className="px-3 py-2 text-xs font-bold uppercase tracking-wider text-stone-700 hover:bg-stone-100 rounded-lg">Cancel</button>
            <button
              type="button"
              onClick={save}
              disabled={busy}
              data-testid="t-plus-client-save"
              className="px-4 py-2 text-xs font-bold uppercase tracking-wider bg-stone-950 text-white hover:bg-stone-800 rounded-lg flex items-center gap-1.5 disabled:opacity-50"
            >
              {busy
                ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                : (isRegularClient
                    ? (editing ? "Update Client" : "Save Client")
                    : (editing ? "Update Prospective Client" : "Save Prospective Client"))}
            </button>
          </div>
        </div>
      </div>

      {showCqc && cqcSnapshot && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-stone-950/60 backdrop-blur-sm"
          onClick={() => setShowCqc(false)}
          data-testid="t-plus-cqc-popup"
        >
          <div
            className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[85vh] overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-4 border-b border-stone-200 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">
                  Live data from {
                    initial?.source === "scotland" ? "Care Inspectorate Scotland"
                    : initial?.source === "wales" ? "Care Inspectorate Wales (CIW)"
                    : initial?.source === "ni" ? "RQIA (Northern Ireland)"
                    : "CQC"
                  }
                </div>
                <h3 className="font-display text-lg font-black text-stone-950 truncate">{cqcSnapshot.name || "—"}</h3>
              </div>
              <button
                onClick={() => setShowCqc(false)}
                data-testid="t-plus-cqc-close"
                className="p-2 -mr-1 text-stone-600 hover:bg-stone-100 rounded-lg shrink-0"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-2.5 text-sm">
              {[
                ["Name", cqcSnapshot.name],
                ["Address", cqcSnapshot.fullAddress
                  || [cqcSnapshot.postalAddressLine1, cqcSnapshot.postalAddressLine2, cqcSnapshot.postalAddressTownCity, cqcSnapshot.postalAddressCounty, cqcSnapshot.postalCode]
                      .filter(Boolean).join(", ")],
                ["Postcode", cqcSnapshot.postalCode || cqcSnapshot.postcode],
                ["Phone", cqcSnapshot.mainPhoneNumber],
                ["Website", cqcSnapshot.website],
                ["Provider", cqcSnapshot.providerName],
                ["Manager", cqcSnapshot.registrationManagerName],
                ["CQC rating", cqcSnapshot.currentRatings?.overall?.rating],
                ["Latest inspection", cqcSnapshot.lastInspection?.date || cqcSnapshot.currentRatings?.overall?.reportDate],
                ["Number of beds", cqcSnapshot.numberOfBeds],
              ].map(([label, value]) => (
                <div key={label} className="grid grid-cols-3 gap-3 py-1.5 border-b border-stone-100 last:border-b-0">
                  <div className="text-[10px] uppercase tracking-wider font-bold text-stone-500">{label}</div>
                  <div className="col-span-2 text-stone-900 break-words">
                    {value || <span className="text-stone-400 italic">Not on file</span>}
                  </div>
                </div>
              ))}
              {cqcSnapshot.locationURL && (
                <a href={cqcSnapshot.locationURL} target="_blank" rel="noreferrer"
                  className="mt-3 inline-flex items-center gap-1.5 px-3 py-2 text-[10px] font-bold uppercase tracking-wider border border-stone-300 hover:bg-stone-50 rounded-md text-stone-900">
                  <ExternalLink className="w-3 h-3" /> Open on CQC website
                </a>
              )}
            </div>
            <div className="px-5 py-3 border-t border-stone-200 text-[11px] text-stone-500">
              This is the unedited public record. Your overrides above are private to you.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Small reusable row that shows the current marketing status for an
// email + a single button to flip it. We deliberately don't put this
// in its own file because it's only used inside the client modal and
// shares the modal's `busy` / `onToggle` plumbing.
function UnsubscribeRow({ label, email, unsubscribed, unsubscribedAt,
                          source, onToggle, busy, testid, compact = false }) {
  const dateLabel = unsubscribedAt
    ? new Date(unsubscribedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })
    : "";
  const sourceLabel = source === "recipient" ? "via one-click link"
                    : source === "franchisee" ? "by you"
                    : "";
  return (
    <div
      data-testid={testid}
      className={`flex items-center gap-3 ${compact ? "p-2 bg-stone-50" : "px-3 py-2.5 bg-amber-50/40"} border ${unsubscribed ? "border-red-200 bg-red-50/60" : "border-stone-200"} rounded-lg`}
    >
      <div className="shrink-0">
        {unsubscribed
          ? <span className="w-7 h-7 rounded-full bg-red-100 text-red-700 flex items-center justify-center"><MailX className="w-3.5 h-3.5" /></span>
          : <span className="w-7 h-7 rounded-full bg-stone-200 text-stone-700 flex items-center justify-center"><Mail className="w-3.5 h-3.5" /></span>}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[11px] font-bold uppercase tracking-wider text-stone-700">
          {label} — {unsubscribed ? "Unsubscribed" : "Subscribed"}
        </div>
        <div className="text-[11px] text-stone-500 truncate">
          {unsubscribed
            ? <>Won&apos;t receive marketing e-shots{dateLabel ? ` · since ${dateLabel}` : ""}{sourceLabel ? ` · ${sourceLabel}` : ""}</>
            : <>{email} will be included in your next campaign</>}
        </div>
      </div>
      <button
        type="button"
        onClick={onToggle}
        disabled={busy}
        data-testid={`${testid}-toggle`}
        className={`shrink-0 px-3 py-1.5 rounded-md text-[10px] font-bold uppercase tracking-wider transition ${
          unsubscribed
            ? "bg-stone-950 text-white hover:bg-stone-800"
            : "bg-red-600 text-white hover:bg-red-700"
        } disabled:opacity-50`}
      >
        {unsubscribed ? "Re-subscribe" : "Mark unsubscribed"}
      </button>
    </div>
  );
}


// ----------------------------------------------------------------------------
// MarketingCrmPanel — the right-column sales-pipeline tracker.
// Lives inside this file because every field directly mutates the modal's
// ``form`` state via the shared `set(k, v)` helper. Pure UI: persistence
// happens when the user hits "Save changes" on the parent modal.
// ----------------------------------------------------------------------------
function MarketingCrmPanel({ form, set, marketingEnabled, onOpenMarketingPlus, clientSaved }) {
  const status = form.lead_status || "";
  const selectedOption = LEAD_STATUS_OPTIONS.find((o) => o.value === status);
  const tone = selectedOption ? TONE_STYLES[selectedOption.tone] : TONE_STYLES.grey;
  const followUpOn = !!form.follow_up_required;
  return (
    <section
      className="bg-white border border-stone-200 rounded-xl overflow-hidden"
      data-testid="t-plus-marketing-panel"
    >
      <header className="px-4 py-3 bg-stone-950 text-[#dddd16] flex items-center gap-2">
        <Megaphone className="w-4 h-4" />
        <div className="text-[11px] uppercase tracking-[0.25em] font-black">Marketing</div>
      </header>
      <div className="p-4 space-y-3">
        {/* LEAD STATUS — coloured dropdown with chip */}
        <div>
          <label className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 mb-1 block">
            Lead Status
          </label>
          <div className={`relative rounded-lg border-2 ${tone.border} ${tone.fill}`}>
            <span className={`absolute left-3 top-1/2 -translate-y-1/2 w-3 h-3 rounded-full ${tone.dot} border border-stone-400`}></span>
            <select
              value={status}
              onChange={(e) => set("lead_status", e.target.value)}
              data-testid="t-plus-lead-status"
              className="w-full pl-9 pr-3 py-2 text-sm bg-transparent appearance-none focus:outline-none cursor-pointer font-medium"
            >
              <option value="">— select status —</option>
              {LEAD_STATUS_OPTIONS.map((o) => {
                const t = TONE_STYLES[o.tone];
                return (
                  <option
                    key={o.value}
                    value={o.value}
                    style={{ backgroundColor: t.optionBg, color: t.optionFg, fontWeight: 600 }}
                  >
                    {o.label}
                  </option>
                );
              })}
            </select>
          </div>
          {selectedOption && (
            <div className={`mt-1 inline-flex items-center gap-1.5 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded border ${tone.chip}`}>
              <span className={`w-2 h-2 rounded-full ${tone.dot}`}></span>
              {selectedOption.label}
            </div>
          )}
        </div>

        {/* LAST CONTACT — date + method side by side */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 mb-1 block">
              Last Contact
            </label>
            <input
              type="date"
              value={form.last_contact_date || ""}
              onChange={(e) => set("last_contact_date", e.target.value)}
              data-testid="t-plus-last-contact-date"
              className="w-full px-3 py-2 text-sm bg-stone-50 border border-stone-300 rounded-lg focus:outline-none focus:border-stone-950"
            />
          </div>
          <div>
            <label className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 mb-1 block">
              Method
            </label>
            <select
              value={form.last_contact_method || ""}
              onChange={(e) => set("last_contact_method", e.target.value)}
              data-testid="t-plus-last-contact-method"
              className="w-full px-3 py-2 text-sm bg-stone-50 border border-stone-300 rounded-lg focus:outline-none focus:border-stone-950"
            >
              <option value="">— select —</option>
              {CONTACT_METHOD_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
        </div>

        {/* FOLLOW UP — Yes/No toggle */}
        <div>
          <label className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 mb-1 block">
            Follow Up Required?
          </label>
          <div className="inline-flex rounded-lg overflow-hidden border border-stone-300">
            <button
              type="button"
              onClick={() => set("follow_up_required", true)}
              data-testid="t-plus-follow-up-yes"
              className={`px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider transition-colors ${followUpOn ? "bg-amber-400 text-stone-950" : "bg-white text-stone-700 hover:bg-stone-50"}`}
            >
              {followUpOn && <Check className="inline-block w-3 h-3 mr-1 -mt-0.5" />}Yes
            </button>
            <button
              type="button"
              onClick={() => {
                set("follow_up_required", false);
                // Clear follow-up fields when toggled off — keeps the
                // saved doc tidy and avoids ghost reminders.
                set("follow_up_date", "");
                set("follow_up_notes", "");
              }}
              data-testid="t-plus-follow-up-no"
              className={`px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider border-l border-stone-300 transition-colors ${!followUpOn ? "bg-stone-950 text-white" : "bg-white text-stone-700 hover:bg-stone-50"}`}
            >
              {!followUpOn && <Check className="inline-block w-3 h-3 mr-1 -mt-0.5" />}No
            </button>
          </div>
        </div>

        {followUpOn && (
          <>
            <div>
              <label className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 mb-1 block">
                Follow Up Date
              </label>
              <input
                type="date"
                value={form.follow_up_date || ""}
                onChange={(e) => set("follow_up_date", e.target.value)}
                data-testid="t-plus-follow-up-date"
                className="w-full px-3 py-2 text-sm bg-stone-50 border border-stone-300 rounded-lg focus:outline-none focus:border-stone-950"
              />
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 mb-1 block">
                Follow Up Notes
              </label>
              <textarea
                value={form.follow_up_notes || ""}
                onChange={(e) => set("follow_up_notes", e.target.value)}
                rows={3}
                placeholder="What's the next step? Topics to discuss, agreed next call…"
                data-testid="t-plus-follow-up-notes"
                className="w-full px-3 py-2 text-sm bg-stone-50 border border-stone-300 rounded-lg focus:outline-none focus:border-stone-950"
              />
            </div>
          </>
        )}
      </div>
    </section>
  );
}
