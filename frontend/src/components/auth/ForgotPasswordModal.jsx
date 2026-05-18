// Lightweight modal used on both login pages. Lets a locked-out user
// request a password reset which is then mediated by an admin (no email
// integration on this project). The endpoint always returns 200 to
// prevent account enumeration — we tell the user "if an account exists,
// the admin's been notified" regardless.
import { useState } from "react";
import axios from "axios";
import { X, ArrowRight, Loader2, MailQuestion, CheckCircle2 } from "lucide-react";

const API = `${process.env.REACT_APP_BACKEND_URL}/api`;

export default function ForgotPasswordModal({ open, onClose, defaultEmail = "" }) {
  const [email, setEmail] = useState(defaultEmail);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");

  if (!open) return null;

  const submit = async (e) => {
    e.preventDefault();
    setError(""); setBusy(true);
    try {
      await axios.post(
        `${API}/auth/password-reset/request`,
        { email: email.trim() },
        { withCredentials: true }
      );
      setDone(true);
    } catch (err) {
      const detail = err?.response?.data?.detail;
      setError(typeof detail === "string" ? detail : "Could not submit request.");
    } finally {
      setBusy(false);
    }
  };

  const close = () => {
    setDone(false); setEmail(defaultEmail); setError("");
    onClose();
  };

  return (
    <div
      onClick={close}
      className="fixed inset-0 z-[80] bg-stone-950/60 backdrop-blur-sm flex items-center justify-center p-6"
      data-testid="forgot-password-modal"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-white rounded-2xl shadow-2xl max-w-md w-full overflow-hidden"
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-stone-200">
          <div className="flex items-center gap-2">
            <MailQuestion className="w-4 h-4 text-stone-700" />
            <span className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-700">
              Reset Password
            </span>
          </div>
          <button
            onClick={close}
            data-testid="forgot-close"
            className="w-9 h-9 flex items-center justify-center hover:bg-stone-100 rounded-lg"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="px-6 py-6">
          {done ? (
            <div className="text-center space-y-3" data-testid="forgot-done">
              <CheckCircle2 className="w-12 h-12 text-emerald-500 mx-auto" />
              <h3 className="font-display text-2xl text-stone-950">Request sent</h3>
              <p className="text-sm text-stone-600 leading-relaxed">
                If an account exists for <strong>{email}</strong>, an
                administrator has been notified and will be in touch with a
                temporary password.
              </p>
              <button
                onClick={close}
                data-testid="forgot-done-close"
                className="mt-2 px-5 py-2.5 text-xs font-bold uppercase tracking-wider bg-stone-950 text-white rounded-lg hover:bg-stone-800"
              >
                Close
              </button>
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-4">
              <div>
                <h3 className="font-display text-2xl text-stone-950">
                  Forgot your password?
                </h3>
                <p className="text-sm text-stone-600 mt-1 leading-relaxed">
                  Enter the email you signed in with. An administrator will
                  generate a temporary password for you and share it directly.
                </p>
              </div>
              <div className="space-y-1.5">
                <label
                  htmlFor="reset-email"
                  className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600"
                >
                  Email Address
                </label>
                <input
                  id="reset-email"
                  type="email"
                  required
                  autoFocus
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  data-testid="forgot-email-input"
                  className="w-full px-4 py-3 bg-white border border-stone-300 text-stone-950 text-sm font-medium focus:outline-none focus:border-stone-950 focus:ring-1 focus:ring-stone-950 transition-colors rounded-xl"
                  placeholder="you@example.com"
                />
              </div>
              {error && (
                <div className="px-3 py-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg">
                  {error}
                </div>
              )}
              <button
                type="submit"
                disabled={busy || !email.trim()}
                data-testid="forgot-submit"
                className="w-full flex items-center justify-center gap-2 px-5 py-3 bg-[#D4FF00] hover:bg-[#BDE600] text-stone-950 font-bold text-sm uppercase tracking-wider rounded-xl disabled:opacity-50"
              >
                {busy ? (
                  <><Loader2 className="w-4 h-4 animate-spin" /> Sending…</>
                ) : (
                  <>Request reset <ArrowRight className="w-4 h-4" /></>
                )}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
