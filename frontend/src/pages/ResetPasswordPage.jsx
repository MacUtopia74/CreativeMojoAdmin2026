// Self-serve password reset — landing page reached from the branded
// Resend email. Reads ?token=... from the URL, lets the user set a new
// password, and POSTs to /auth/password-reset/confirm. The token is
// single-use, valid for 2 hours.
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import api from "@/lib/api";
import { toast } from "sonner";
import { Loader2, Lock, CheckCircle2 } from "lucide-react";

export default function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get("token") || "";
  const navigate = useNavigate();
  const [pwd1, setPwd1] = useState("");
  const [pwd2, setPwd2] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState(null);

  // Guard: no token in URL → bounce to forgot-password page.
  useEffect(() => {
    if (!token) navigate("/login", { replace: true });
  }, [token, navigate]);

  const submit = async (e) => {
    e.preventDefault();
    setErr(null);
    if (pwd1.length < 8) { setErr("Password must be at least 8 characters."); return; }
    if (pwd1 !== pwd2) { setErr("Passwords don't match."); return; }
    setSubmitting(true);
    try {
      await api.post("/auth/password-reset/confirm", { token, new_password: pwd1 });
      setDone(true);
      toast.success("Password updated. You can now sign in.");
      setTimeout(() => navigate("/login", { replace: true }), 2400);
    } catch (e2) {
      setErr(e2?.response?.data?.detail || "Could not reset password.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-stone-950 text-stone-100 flex items-center justify-center px-4" data-testid="reset-password-page">
      <div className="w-full max-w-md bg-stone-900/80 border border-stone-800 rounded-2xl p-8 backdrop-blur">
        <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-[#dddd16] mb-1">Creative Mojo</div>
        <h1 className="font-display text-2xl text-stone-50">Reset your password</h1>
        <p className="text-sm text-stone-400 mt-2">Choose a new password of at least 8 characters. The reset link expires 2 hours after it was sent.</p>

        {done ? (
          <div className="mt-6 flex items-start gap-3 p-4 rounded-xl bg-emerald-900/30 border border-emerald-700/40">
            <CheckCircle2 className="w-5 h-5 text-emerald-400 flex-shrink-0 mt-0.5" />
            <div>
              <div className="font-semibold text-emerald-200">Password updated.</div>
              <div className="text-sm text-emerald-300/80 mt-1">Redirecting to sign-in…</div>
            </div>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-4 mt-6">
            <div>
              <label className="block text-[10px] uppercase tracking-[0.2em] font-bold text-stone-400 mb-1.5">New password</label>
              <div className="relative">
                <Lock className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-stone-500" />
                <input
                  type="password" autoFocus value={pwd1}
                  onChange={(e) => setPwd1(e.target.value)} required minLength={8}
                  data-testid="reset-password-new"
                  className="w-full pl-9 pr-3 py-2.5 bg-stone-950 border border-stone-700 rounded-lg text-stone-100 text-sm focus:outline-none focus:border-[#dddd16]" />
              </div>
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-[0.2em] font-bold text-stone-400 mb-1.5">Confirm password</label>
              <div className="relative">
                <Lock className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-stone-500" />
                <input
                  type="password" value={pwd2}
                  onChange={(e) => setPwd2(e.target.value)} required minLength={8}
                  data-testid="reset-password-confirm"
                  className="w-full pl-9 pr-3 py-2.5 bg-stone-950 border border-stone-700 rounded-lg text-stone-100 text-sm focus:outline-none focus:border-[#dddd16]" />
              </div>
            </div>
            {err && (
              <div className="text-sm text-red-300 bg-red-900/30 border border-red-800/50 rounded-lg px-3 py-2" data-testid="reset-password-error">{err}</div>
            )}
            <button
              type="submit" disabled={submitting}
              data-testid="reset-password-submit"
              className="w-full flex items-center justify-center gap-2 bg-[#dddd16] hover:bg-[#c5c510] disabled:opacity-50 disabled:cursor-not-allowed text-stone-950 font-bold uppercase tracking-[0.15em] text-xs py-3 rounded-lg transition-colors">
              {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
              {submitting ? "Updating…" : "Update password"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
