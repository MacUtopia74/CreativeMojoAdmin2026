// Forced password-change screen — appears after a user logs in with a
// temp password issued by the admin. They cannot reach the rest of the
// app until they set a real password. (Also reachable any time from
// account menu later, for voluntary changes.)
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import api, { formatError } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import Logo from "@/components/Logo";
import { ArrowRight, Loader2, Eye, EyeOff, ShieldCheck } from "lucide-react";

export default function ChangePasswordPage() {
  const { user, refresh } = useAuth();
  const navigate = useNavigate();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const forced = !!user?.force_password_change;

  const submit = async (e) => {
    e.preventDefault();
    setErr("");
    if (next !== confirm) { setErr("New passwords don't match."); return; }
    if (next.length < 8) { setErr("Password must be at least 8 characters."); return; }
    setBusy(true);
    try {
      await api.post("/auth/change-password", {
        current_password: current,
        new_password: next,
      });
      await refresh();
      // Bounce to whichever home page matches the role
      navigate(user?.role === "franchisee" ? "/portal" : "/", { replace: true });
    } catch (e) {
      setErr(formatError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#F9F9F8] p-6" data-testid="change-password-page">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-sm border border-stone-200 p-8">
        <Logo className="h-10 mb-6" />
        {forced && (
          <div className="mb-5 px-3 py-2 text-xs bg-amber-50 border border-amber-200 rounded-lg flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-amber-700 shrink-0" />
            <span className="text-amber-900">
              You signed in with a temporary password. Set a new one to continue.
            </span>
          </div>
        )}
        <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-500">
          Account Security
        </div>
        <h1 className="font-display text-3xl text-stone-950 mt-1 mb-1">
          Change password
        </h1>
        <p className="text-sm text-stone-600 mb-6">
          Choose something secure and easy for you to remember.
        </p>
        {err && (
          <div className="mb-4 text-xs px-3 py-2 bg-red-50 text-red-700 border border-red-200 rounded-lg">
            {err}
          </div>
        )}
        <form onSubmit={submit} className="space-y-4">
          <PwField
            label={forced ? "Temporary password" : "Current password"}
            value={current}
            onChange={setCurrent}
            show={showPw}
            onToggle={() => setShowPw((s) => !s)}
            autoFocus
            testid="cp-current"
          />
          <PwField
            label="New password"
            value={next}
            onChange={setNext}
            show={showPw}
            onToggle={() => setShowPw((s) => !s)}
            hint="At least 8 characters"
            testid="cp-new"
          />
          <PwField
            label="Confirm new password"
            value={confirm}
            onChange={setConfirm}
            show={showPw}
            onToggle={() => setShowPw((s) => !s)}
            testid="cp-confirm"
          />
          <button
            type="submit"
            disabled={busy || !current || !next || !confirm}
            data-testid="cp-submit"
            className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-[#dddd16] hover:bg-[#aaaa11] text-stone-950 font-bold text-sm uppercase tracking-wider rounded-xl disabled:opacity-50"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : (
              <>Update password <ArrowRight className="w-4 h-4" /></>
            )}
          </button>
        </form>
      </div>
    </div>
  );
}

function PwField({ label, value, onChange, show, onToggle, autoFocus, hint, testid }) {
  return (
    <div>
      <label className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 mb-1.5 block">
        {label}
      </label>
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
        <button
          type="button"
          onClick={onToggle}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-stone-400 hover:text-stone-700"
        >
          {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
        </button>
      </div>
      {hint && <div className="text-[11px] text-stone-500 mt-1.5">{hint}</div>}
    </div>
  );
}
