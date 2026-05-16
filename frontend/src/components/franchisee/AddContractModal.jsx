// Admin-only modal for creating (or renewing) a contract for a franchisee.
//
// Lives on FranchiseeDetailPage. Two states:
//   • "new"     — first contract for a fresh franchisee
//   • "renew"   — generate the next term for an existing franchisee. Pre-
//                 fills commencement_date as the previous contract's
//                 renewal_date so the new term seamlessly follows on.
import { useEffect, useState } from "react";
import api from "@/lib/api";
import { Loader2, X, Save, Calendar, PoundSterling, FileText, AlertCircle } from "lucide-react";

const TERM_OPTIONS = [1, 2, 3, 4];

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

export default function AddContractModal({ franchisee, previous = null, onClose, onSaved }) {
  const [term, setTerm] = useState(previous?.contract_term_years || 3);
  const [start, setStart] = useState(previous?.renewal_date || todayISO());
  const [startingFee, setStartingFee] = useState("");
  const [monthlyFee, setMonthlyFee] = useState(previous?.monthly_fee ? String(previous.monthly_fee) : "");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  // Re-derive renewal-date preview
  const [previewRenewal, setPreviewRenewal] = useState("");
  useEffect(() => {
    if (!start || !term) { setPreviewRenewal(""); return; }
    const d = new Date(start);
    if (Number.isNaN(d.getTime())) { setPreviewRenewal(""); return; }
    d.setFullYear(d.getFullYear() + Number(term));
    setPreviewRenewal(d.toISOString().slice(0, 10));
  }, [start, term]);

  const save = async () => {
    setErr("");
    if (!start) { setErr("Pick a commencement date."); return; }
    setSaving(true);
    try {
      const body = {
        franchisee_id: franchisee.id,
        contract_term_years: Number(term),
        commencement_date: start,
        initial_starting_fee: startingFee ? Number(startingFee) : null,
        monthly_fee: monthlyFee ? Number(monthlyFee) : null,
        notes: notes || null,
      };
      const { data } = await api.post("/contracts", body);
      onSaved?.(data.contract);
    } catch (e) {
      setErr(e?.response?.data?.detail || "Could not create contract.");
    } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-[60] bg-stone-950/70 backdrop-blur-sm flex items-center justify-center p-6" onClick={onClose} data-testid="add-contract-modal">
      <div onClick={(e) => e.stopPropagation()} className="bg-white rounded-2xl shadow-2xl w-full max-w-xl">
        <div className="px-5 py-4 border-b border-stone-200 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FileText className="w-4 h-4 text-stone-700" />
            <span className="font-bold text-stone-950">
              {previous ? "Renew contract" : "Add first contract"}
            </span>
          </div>
          <button onClick={onClose} data-testid="add-contract-close" className="w-8 h-8 hover:bg-stone-100 rounded-md flex items-center justify-center">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <div className="text-xs text-stone-600">
            For <strong className="text-stone-900">{franchisee.first_name} {franchisee.last_name}</strong>
            {franchisee.organisation && <> · {franchisee.organisation}</>}
          </div>

          {/* Term selector */}
          <div>
            <label className="block text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 mb-2">
              Length of term
            </label>
            <div className="flex gap-2">
              {TERM_OPTIONS.map((n) => (
                <button key={n} onClick={() => setTerm(n)} data-testid={`term-${n}`}
                  className={`flex-1 px-3 py-2.5 text-sm font-bold rounded-lg border transition-all ${
                    term === n ? "bg-stone-950 text-white border-stone-950"
                               : "bg-white text-stone-700 border-stone-300 hover:bg-stone-50"
                  }`}>
                  {n} year{n === 1 ? "" : "s"}
                </button>
              ))}
            </div>
          </div>

          {/* Dates */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 mb-1">
                Commencement date
              </label>
              <div className="relative">
                <Calendar className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-stone-400" />
                <input type="date" value={start} onChange={(e) => setStart(e.target.value)}
                  data-testid="contract-start"
                  className="w-full pl-9 pr-3 py-2 text-sm border border-stone-300 rounded-lg" />
              </div>
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 mb-1">
                Renews on
              </label>
              <div className="w-full px-3 py-2 text-sm border border-stone-200 bg-stone-50 rounded-lg text-stone-700 tabular-nums" data-testid="contract-renewal-preview">
                {previewRenewal || "—"}
              </div>
            </div>
          </div>

          {/* Fees */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 mb-1">
                Initial starting fee
              </label>
              <div className="relative">
                <PoundSterling className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-stone-400" />
                <input type="number" min="0" step="any" inputMode="decimal"
                  value={startingFee} onChange={(e) => setStartingFee(e.target.value)}
                  placeholder="e.g. 12500"
                  data-testid="contract-starting-fee"
                  className="w-full pl-9 pr-3 py-2 text-sm border border-stone-300 rounded-lg tabular-nums" />
              </div>
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 mb-1">
                Monthly fee (optional)
              </label>
              <div className="relative">
                <PoundSterling className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-stone-400" />
                <input type="number" min="0" step="any" inputMode="decimal"
                  value={monthlyFee} onChange={(e) => setMonthlyFee(e.target.value)}
                  placeholder="e.g. 200"
                  data-testid="contract-monthly-fee"
                  className="w-full pl-9 pr-3 py-2 text-sm border border-stone-300 rounded-lg tabular-nums" />
              </div>
            </div>
          </div>

          {/* Notes */}
          <div>
            <label className="block text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 mb-1">
              Notes (optional)
            </label>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3}
              data-testid="contract-notes"
              placeholder="Any contract-specific notes — discount applied, exit clauses, etc."
              className="w-full px-3 py-2 text-sm border border-stone-300 rounded-lg" />
          </div>

          {err && (
            <div className="text-xs text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg flex items-center gap-1.5">
              <AlertCircle className="w-3.5 h-3.5" /> {err}
            </div>
          )}
        </div>

        <div className="px-5 py-4 border-t border-stone-200 flex items-center justify-end gap-2 bg-stone-50">
          <button onClick={onClose} data-testid="add-contract-cancel"
            className="px-3 py-2 text-xs font-bold rounded-lg border border-stone-300 bg-white hover:bg-stone-50">
            Cancel
          </button>
          <button onClick={save} disabled={saving || !start} data-testid="add-contract-save"
            className="px-4 py-2 text-xs font-bold uppercase tracking-wider bg-[#D4FF00] text-stone-950 hover:bg-[#BDE600] rounded-lg disabled:opacity-50 flex items-center gap-1.5">
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
            {previous ? "Save renewal" : "Save contract"}
          </button>
        </div>
      </div>
    </div>
  );
}
