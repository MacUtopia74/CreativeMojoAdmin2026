// Public franchisee portal login. Two-step flow:
//   1. Enter email → backend tells us if password is set yet.
//   2a. If not set → "Create your password" form (first-time activation)
//   2b. If set → "Enter your password" form
// On success the JWT cookie lands and we redirect to /portal.
import { useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import api, { formatError } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import Logo from "@/components/Logo";
import { ArrowRight, Loader2, Eye, EyeOff } from "lucide-react";
import ForgotPasswordModal from "@/components/auth/ForgotPasswordModal";

export default function PortalLoginPage() {
  const { user, refresh } = useAuth();
  const navigate = useNavigate();

  const [step, setStep] = useState("email"); // email | setup | login
  const [isReset, setIsReset] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [showForgot, setShowForgot] = useState(false);

  // Already signed in? Bounce by role. (Hooks above MUST run first.)
  if (user && user.role === "franchisee") return <Navigate to="/portal" replace />;
  if (user && user.role === "admin") return <Navigate to="/" replace />;

  const submitEmail = async (e) => {
    e.preventDefault(); setErr(""); setBusy(true);
    try {
      const { data } = await api.post("/portal/login-check", { email });
      if (!data.exists) {
        setErr("We couldn't find a portal account for that email. Please check the address or contact your administrator.");
      } else if (data.needs_password_setup) {
        setIsReset(!!data.is_reset);
        setStep("setup");
      } else {
        setStep("login");
      }
    } catch (e) { setErr(formatError(e)); }
    finally { setBusy(false); }
  };

  const submitPassword = async (e) => {
    e.preventDefault(); setErr(""); setBusy(true);
    try {
      const endpoint = step === "setup" ? "/portal/set-password" : "/portal/login";
      if (step === "setup" && password !== confirm) {
        setErr("Passwords don't match."); setBusy(false); return;
      }
      await api.post(endpoint, { email, password });
      await refresh();
      navigate("/portal", { replace: true });
    } catch (e) { setErr(formatError(e)); }
    finally { setBusy(false); }
  };

  return (
    <div className="min-h-screen grid lg:grid-cols-2 bg-[#FBFAF8]" data-testid="portal-login-page">
      {/* Hero side */}
      <div className="hidden lg:flex relative bg-stone-950 overflow-hidden">
        <div className="absolute inset-0 opacity-30"
          style={{ backgroundImage: "radial-gradient(circle at 20% 30%, #DEDD0C 0%, transparent 50%), radial-gradient(circle at 80% 70%, #DEDD0C 0%, transparent 50%)" }} />
        <div className="relative h-full flex flex-col justify-between p-12 text-white">
          <div className="bg-white rounded-2xl p-5 inline-block">
            <Logo className="h-14" />
          </div>
          <div className="space-y-5">
            <div className="text-[11px] uppercase tracking-[0.3em] text-[#DEDD0C] font-bold">
              Franchisee Portal
            </div>
            <h1 className="font-display text-4xl xl:text-5xl leading-tight tracking-tight">
              Your files, contracts, and territory — all in one place.
            </h1>
            <p className="text-stone-300 max-w-md text-sm leading-relaxed">
              Sign in with your Creative Mojo email to access your shared brand library, your own folder of artwork and agreements, and your franchise details.
            </p>
          </div>
          <div className="text-[11px] text-stone-500 font-mono uppercase tracking-widest">© Creative Mojo · {new Date().getFullYear()}</div>
        </div>
      </div>

      {/* Form side */}
      <div className="flex flex-col justify-center px-6 sm:px-12 lg:px-20 py-10">
        <div className="w-full max-w-sm mx-auto">
          <div className="lg:hidden mb-10">
            <Logo className="h-12" />
          </div>

          <div className="text-[11px] uppercase tracking-[0.3em] font-bold text-stone-500 mb-2">Franchisee Portal</div>
          <h2 className="font-display text-3xl text-stone-950 mb-1">
            {step === "email" && "Welcome"}
            {step === "setup" && (isReset ? "Set a new password" : "Create your password")}
            {step === "login" && "Welcome back"}
          </h2>
          <p className="text-sm text-stone-500 mb-8">
            {step === "email" && "Enter your Creative Mojo email to begin."}
            {step === "setup" && (isReset
              ? `Your administrator has reset your password. Choose a new one for ${email}.`
              : `First time signing in. Choose a password for ${email}.`)}
            {step === "login" && `Signed in as ${email}.`}
          </p>

          {err && (
            <div className="mb-5 text-xs px-3 py-2 bg-red-50 text-red-700 border border-red-200 rounded-lg" data-testid="portal-error">
              {err}
            </div>
          )}

          {step === "email" && (
            <form onSubmit={submitEmail} className="space-y-4">
              <div>
                <label className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 mb-1.5 block">Email</label>
                <input type="email" required autoFocus value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  data-testid="portal-email"
                  className="w-full px-3.5 py-2.5 bg-white border border-stone-300 rounded-lg text-sm focus:outline-none focus:border-stone-950" />
              </div>
              <button type="submit" disabled={busy || !email} data-testid="portal-email-submit"
                className="w-full px-4 py-2.5 bg-stone-950 text-white text-xs font-bold uppercase tracking-wider rounded-lg flex items-center justify-center gap-2 hover:bg-stone-800 disabled:opacity-50">
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <>Continue <ArrowRight className="w-3.5 h-3.5" /></>}
              </button>
            </form>
          )}

          {(step === "setup" || step === "login") && (
            <form onSubmit={submitPassword} className="space-y-4">
              <div>
                <label className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 mb-1.5 block">
                  {step === "setup" ? "New Password" : "Password"}
                </label>
                <div className="relative">
                  <input type={showPw ? "text" : "password"} required autoFocus minLength={8} value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    data-testid="portal-password"
                    className="w-full pr-10 px-3.5 py-2.5 bg-white border border-stone-300 rounded-lg text-sm focus:outline-none focus:border-stone-950" />
                  <button type="button" onClick={() => setShowPw((s) => !s)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-stone-400 hover:text-stone-700">
                    {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
                {step === "setup" && (
                  <div className="text-[11px] text-stone-500 mt-1.5">At least 8 characters.</div>
                )}
              </div>
              {step === "setup" && (
                <div>
                  <label className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 mb-1.5 block">Confirm Password</label>
                  <input type={showPw ? "text" : "password"} required minLength={8} value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    data-testid="portal-confirm"
                    className="w-full px-3.5 py-2.5 bg-white border border-stone-300 rounded-lg text-sm focus:outline-none focus:border-stone-950" />
                </div>
              )}
              <button type="submit" disabled={busy || !password} data-testid="portal-pw-submit"
                className="w-full px-4 py-2.5 bg-stone-950 text-white text-xs font-bold uppercase tracking-wider rounded-lg flex items-center justify-center gap-2 hover:bg-stone-800 disabled:opacity-50">
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : (
                  step === "setup"
                    ? (isReset ? "Submit new password" : "Create account")
                    : "Sign in"
                )}
                {!busy && <ArrowRight className="w-3.5 h-3.5" />}
              </button>
              {step === "login" && (
                <div className="text-center text-[11px] text-stone-500 pt-2">
                  <button
                    type="button"
                    onClick={() => setShowForgot(true)}
                    data-testid="portal-forgot-password-link"
                    className="text-stone-700 font-bold hover:underline underline-offset-2"
                  >
                    Forgot your password?
                  </button>
                </div>
              )}
              <button type="button" onClick={() => { setStep("email"); setPassword(""); setConfirm(""); setErr(""); }}
                className="w-full text-[11px] text-stone-500 hover:text-stone-900 mt-2">
                ← Use a different email
              </button>
            </form>
          )}
        </div>
      </div>
      <ForgotPasswordModal
        open={showForgot}
        onClose={() => setShowForgot(false)}
        defaultEmail={email}
      />
    </div>
  );
}
