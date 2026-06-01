// Edit-or-create modal for a Territory+ "my client" entry. Form fields
// mirror the schema in territory_plus_routes.py. The same modal is used
// for both freshly-added clients (no ``initial``) and edits.
import { useEffect, useState } from "react";
import { X, Loader2, Trash2 } from "lucide-react";
import api from "@/lib/api";

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

export default function TerritoryClientModal({ initial, onClose, onSaved, onDeleted }) {
  const [form, setForm] = useState(() => {
    const empty = Object.fromEntries(FIELDS.map((f) => [f.key, ""]));
    if (!initial) return { ...empty, notes: "" };
    return { ...empty, ...Object.fromEntries(Object.entries(initial).map(([k, v]) => [k, v ?? ""])), notes: initial.notes || "" };
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const editing = !!initial?.id;
  const isCustom = !initial || initial.source === "custom";

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const save = async (e) => {
    e?.preventDefault?.();
    setErr("");
    if (!form.name.trim()) { setErr("Name is required."); return; }
    setBusy(true);
    try {
      // Strip empty strings so the backend doesn't store "" instead of null.
      const body = Object.fromEntries(
        Object.entries(form).map(([k, v]) => [k, typeof v === "string" ? (v.trim() || null) : v])
      );
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
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 bg-stone-950/60 backdrop-blur-sm" data-testid="t-plus-client-modal">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col">
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
          {!isCustom && (
            <div className="px-3 py-2.5 bg-amber-50 border border-amber-200 text-amber-900 text-xs rounded-lg">
              This client is linked to a regulated care home. Editing here only changes
              your private notes &amp; flags — the home's main record (address, manager,
              CQC details) is sourced live from CQC / Care Inspectorate Scotland.
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
                    disabled={!isCustom && f.key !== "notes"}
                    rows={2}
                    data-testid={`t-plus-field-${f.key}`}
                    className="w-full px-3 py-2 text-sm bg-stone-50 border border-stone-300 rounded-lg focus:outline-none focus:border-stone-950 disabled:bg-stone-100 disabled:text-stone-500"
                  />
                ) : (
                  <input
                    type="text"
                    value={form[f.key] ?? ""}
                    onChange={(e) => set(f.key, e.target.value)}
                    disabled={!isCustom}
                    required={f.required}
                    data-testid={`t-plus-field-${f.key}`}
                    className="w-full px-3 py-2 text-sm bg-stone-50 border border-stone-300 rounded-lg focus:outline-none focus:border-stone-950 disabled:bg-stone-100 disabled:text-stone-500"
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
    </div>
  );
}
