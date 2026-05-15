import { useState } from "react";
import { useNavigate, Navigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import Logo from "@/components/Logo";
import { ArrowRight } from "lucide-react";

const LOGIN_IMAGE =
  "https://images.unsplash.com/photo-1703301287688-c9a306ebed99?crop=entropy&cs=srgb&fm=jpg&ixid=M3w4NTYxOTB8MHwxfHNlYXJjaHwyfHxzZW5pb3IlMjBwYWludGluZyUyMGNsYXNzfGVufDB8fHx8MTc3ODY3NzMwNnww&ixlib=rb-4.1.0&q=85";

export default function LoginPage() {
  const { user, login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  if (user) return <Navigate to="/" replace />;

  const onSubmit = async (e) => {
    e.preventDefault();
    setError("");
    setSubmitting(true);
    const result = await login(email, password);
    setSubmitting(false);
    if (result.ok) {
      navigate("/");
    } else {
      setError(result.error);
    }
  };

  return (
    <div className="min-h-screen flex" data-testid="login-page">
      {/* Left image */}
      <div className="hidden lg:block relative w-1/2 bg-stone-900">
        <img src={LOGIN_IMAGE} alt="" className="absolute inset-0 w-full h-full object-cover opacity-80" />
        <div className="absolute inset-0 bg-gradient-to-br from-stone-950/70 via-stone-900/40 to-stone-900/70" />
        <div className="relative h-full flex flex-col justify-between p-12 text-white">
          <div>
            <Logo className="h-14" />
          </div>
          <div className="space-y-4">
            <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-[#D4FF00]">Admin Console</div>
            <h1 className="font-display font-black text-5xl leading-[0.95] tracking-tight max-w-md">
              Bringing craft<br />to care.
            </h1>
            <p className="text-sm text-stone-300 max-w-sm leading-relaxed">
              Unified administration for franchises, contracts, files, orders and territory.
            </p>
          </div>
        </div>
      </div>

      {/* Right form */}
      <div className="flex-1 flex items-center justify-center p-8 bg-[#F9F9F8]">
        <div className="w-full max-w-md">
          <div className="lg:hidden mb-10">
            <Logo className="h-12" />
          </div>

          <div className="space-y-2 mb-10">
            <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-500">Sign In</div>
            <h2 className="font-display font-black text-4xl leading-none tracking-tight text-stone-950">
              Welcome back.
            </h2>
            <p className="text-sm text-stone-600 pt-1">Enter your credentials to access the console.</p>
          </div>

          <form onSubmit={onSubmit} className="space-y-5" data-testid="login-form">
            <div className="space-y-1.5">
              <label htmlFor="email" className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600">
                Email Address
              </label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                data-testid="login-email-input"
                required
                autoFocus
                className="w-full px-4 py-3 bg-white border border-stone-300 text-stone-950 text-sm font-medium focus:outline-none focus:border-stone-950 focus:ring-1 focus:ring-stone-950 transition-colors rounded-xl"
                placeholder="you@creativemojo.co.uk"
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="password" className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600">
                Password
              </label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                data-testid="login-password-input"
                required
                className="w-full px-4 py-3 bg-white border border-stone-300 text-stone-950 text-sm font-medium focus:outline-none focus:border-stone-950 focus:ring-1 focus:ring-stone-950 transition-colors rounded-xl"
                placeholder="••••••••"
              />
            </div>

            {error && (
              <div data-testid="login-error" className="px-4 py-3 border border-red-200 bg-red-50 text-sm text-red-800 rounded-xl">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={submitting}
              data-testid="login-submit-button"
              className="w-full flex items-center justify-center gap-2 px-6 py-3.5 bg-[#D4FF00] hover:bg-[#BDE600] text-stone-950 font-bold text-sm uppercase tracking-wider transition-colors disabled:opacity-50 rounded-xl"
            >
              {submitting ? "Signing in…" : "Sign in"}
              {!submitting && <ArrowRight className="w-4 h-4" />}
            </button>
          </form>

          <div className="mt-12 pt-6 border-t border-stone-200">
            <p className="text-xs text-stone-500 leading-relaxed">
              Restricted to authorised Creative Mojo staff and partners. All access is logged.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
