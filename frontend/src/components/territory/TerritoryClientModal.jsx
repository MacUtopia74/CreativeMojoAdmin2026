// Edit-or-create modal for a Territory+ "my client" entry. Form fields
// mirror the schema in territory_plus_routes.py. The same modal is used
// for both freshly-added clients (no ``initial``) and edits.
//
// For CQC/Scotland-linked clients: the franchisee can override ANY field
// (the doc is a private snapshot, never written back to the public CQC
// dataset). The "View live CQC data" button opens a side-by-side popup
// of the current live values so they can compare/reset to source.
import { useEffect, useState } from "react";
import { X, Loader2, Trash2, UserPlus, ExternalLink, Database } from "lucide-react";
import api from "@/lib/api";
import MiniClientMap from "@/components/territory/MiniClientMap";

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

export default function TerritoryClientModal({ initial, onClose, onSaved, onDeleted, cqcSnapshot = null }) {
  const [form, setForm] = useState(() => {
    const empty = Object.fromEntries(FIELDS.map((f) => [f.key, ""]));
    if (!initial) return { ...empty, notes: "", contacts: [] };
    return {
      ...empty,
      ...Object.fromEntries(Object.entries(initial).map(([k, v]) => [k, v ?? ""])),
      notes: initial.notes || "",
      contacts: Array.isArray(initial.contacts) ? initial.contacts : [],
    };
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [showCqc, setShowCqc] = useState(false);

  const editing = !!initial?.id;
  const isCustom = !initial || initial.source === "custom";
  const isLinked = !!initial && initial.source !== "custom";

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

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
      className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 bg-stone-950/60 backdrop-blur-sm"
      onClick={onClose}
      data-testid="t-plus-client-modal"
    >
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[92vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 sm:px-6 py-4 border-b border-stone-200 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">
              {isCustom ? (editing ? "Edit my client" : "Add a client") : "My client"}
            </div>
            <h2 className="font-display text-xl font-black text-stone-950 truncate">
              {editing ? (form.name || "—") : "New client"}
            </h2>
          </div>
          <button onClick={onClose} data-testid="t-plus-client-close" className="p-2 -mr-1 text-stone-600 hover:bg-stone-100 rounded-lg shrink-0">
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={save} className="flex-1 overflow-y-auto px-5 sm:px-6 py-5 space-y-4">
          {editing && (() => {
            // Resolve coords for the embedded map. Marked CQC clients
            // pick up live coords from the snapshot; custom clients
            // carry their own lat/lng. Falls back gracefully if neither
            // is available (renders a "no location" placeholder).
            const lat = cqcSnapshot?.latitude ?? initial?.lat ?? null;
            const lng = cqcSnapshot?.longitude ?? initial?.lng ?? null;
            return (
              <MiniClientMap
                lat={lat}
                lng={lng}
                label={form.name}
                postcode={form.postcode || cqcSnapshot?.postalCode || ""}
              />
            );
          })()}
          {isLinked && (
            <div className="px-3 py-2.5 bg-amber-50 border border-amber-200 text-amber-900 text-xs rounded-lg flex items-start gap-3">
              <div className="flex-1">
                This client started from <strong>{initial.source === "scotland" ? "Care Inspectorate Scotland" : "CQC"}</strong>.
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

          {/* Additional contacts — sales lead, deputy manager, activities
              coordinator, etc. Each row is a mini-card with a delete button. */}
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
                    <input
                      type="text"
                      value={c.email || ""}
                      onChange={(e) => updateContact(i, "email", e.target.value)}
                      placeholder="Email"
                      data-testid={`t-plus-contact-email-${i}`}
                      className="px-2.5 py-1.5 text-sm bg-white border border-stone-300 rounded focus:outline-none focus:border-stone-950"
                    />
                  </div>
                  <textarea
                    value={c.notes || ""}
                    onChange={(e) => updateContact(i, "notes", e.target.value)}
                    placeholder="Notes about this contact (optional)"
                    rows={2}
                    data-testid={`t-plus-contact-notes-${i}`}
                    className="mt-2 w-full px-2.5 py-1.5 text-sm bg-white border border-stone-300 rounded focus:outline-none focus:border-stone-950"
                  />
                </div>
              ))}
            </div>
          </div>
        </form>

        <div className="px-5 sm:px-6 py-4 border-t border-stone-200 flex items-center justify-between gap-3">
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
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : (editing ? "Save changes" : "Add client")}
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
                  Live data from {initial?.source === "scotland" ? "Care Inspectorate Scotland" : "CQC"}
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
