// Portal — Change password (in-app).
//
// Same backend endpoint as the forced-reset page (POST /api/auth/change-password)
// but rendered inside the PortalShell so it sits in the franchisee's
// account sub-nav. No forced-redirect logic here — this is voluntary.
import { useState } from "react";
import { KeyRound, Eye, EyeOff, Loader2, CheckCircle2 } from "lucide-react";
import api, { formatError } from "@/lib/api";
import PortalPageHeading from "@/components/portal/PortalPageHeading";

export default function PortalChangePasswordPage() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [ok, setOk] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setErr(""); setOk(false);
    if (next !== confirm) { setErr("New passwords don't match."); return; }
    if (next.length < 8)  { setErr("Password must be at least 8 characters."); return; }
    setBusy(true);
    try {
      await api.post("/auth/change-password", {
        current_password: current,
        new_password: next,
      });
      setOk(true);
      setCurrent(""); setNext(""); setConfirm("");
    } catch (e) {
      setErr(formatError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6" data-testid="portal-change-password-page">
      <PortalPageHeading
        eyebrow="Account"
        icon={KeyRound}
        title="Change password"
        subtitle="Choose something secure that's easy for you to remember."
      />

      <div className="bg-white border border-stone-200 rounded-2xl p-6 sm:p-8 max-w-xl">
        <p className="text-sm text-stone-600 mb-6 leading-relaxed">
          Choose something secure and easy for you to remember. Your password must be at least 8 characters long.
        </p>

        {ok && (
          <div className="mb-5 px-4 py-3 bg-emerald-50 border border-emerald-200 rounded-lg text-sm text-emerald-900 flex items-center gap-2" data-testid="cp-success">
            <CheckCircle2 className="w-4 h-4 shrink-0" /> Password updated.
          </div>
        )}
        {err && (
          <div className="mb-5 px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700" data-testid="cp-error">
            {err}
          </div>
        )}

        <form onSubmit={submit} className="space-y-4">
          <PwField label="Current password"      value={current} onChange={setCurrent} show={show} onToggle={() => setShow(s => !s)} testid="cp-current" autoFocus />
          <PwField label="New password"          value={next}    onChange={setNext}    show={show} onToggle={() => setShow(s => !s)} testid="cp-new"     hint="At least 8 characters" />
          <PwField label="Confirm new password"  value={confirm} onChange={setConfirm} show={show} onToggle={() => setShow(s => !s)} testid="cp-confirm" />

          <button
            type="submit"
            disabled={busy || !current || !next || !confirm}
            data-testid="cp-submit"
            className="w-full sm:w-auto flex items-center justify-center gap-2 px-5 py-3 bg-[#dedd0a] hover:brightness-95 text-stone-950 font-bold text-sm uppercase tracking-wider rounded-xl disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : "Update password"}
          </button>
        </form>
      </div>
    </div>
  );
}

function PwField({ label, value, onChange, show, onToggle, autoFocus, hint, testid }) {
  return (
    <div>
      <label className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 mb-1.5 block">{label}</label>
      <div className="relative">
        <input
          type={show ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          required
          autoFocus={autoFocus}
          data-testid={testid}
          className="w-full pr-10 px-4 py-3 bg-white border border-stone-300 text-stone-950 text-sm focus:outline-none focus:border-stone-950 rounded-xl"
        />
        <button type="button" onClick={onToggle} className="absolute right-3 top-1/2 -translate-y-1/2 text-stone-400 hover:text-stone-700">
          {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
        </button>
      </div>
      {hint && <div className="text-[11px] text-stone-500 mt-1.5">{hint}</div>}
    </div>
  );
}
