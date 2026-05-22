// Admin-side controls for a single franchisee's portal access. Lives
// on FranchiseeDetailPage. Lets you:
//   - One-click create a portal login (mints user + ensures R2 folders +
//     hands back a one-time temporary password)
//   - Enable/disable login
//   - Reset their password
import { useState } from "react";
import api from "@/lib/api";
import {
  Power, PowerOff, RotateCcw, ShieldCheck, Loader2, Copy, CheckCircle2,
  UserPlus, KeyRound, Eye, EyeOff,
} from "lucide-react";

export default function FranchiseePortalControls({ franchisee, onChanged }) {
  const enabled = !!franchisee?.portal_enabled;
  const email = franchisee?.email || franchisee?.mojo_email;
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  // Result of a create-portal-login call, so we can show the temp password
  // in a copy-friendly card until the admin closes it.
  const [createdLogin, setCreatedLogin] = useState(null);
  const [showPassword, setShowPassword] = useState(false);

  const createPortalLogin = async () => {
    if (!email) { alert("This franchisee has no email on file — set their primary email first."); return; }
    if (!window.confirm(`Create a portal login for ${email}?\n\nThis will mint a user account linked to this franchisee, ensure their R2 folders exist, and generate a one-time temporary password.`)) return;
    setBusy(true);
    try {
      const { data } = await api.post(`/franchisees/${franchisee.id}/create-portal-login`);
      setCreatedLogin(data);
      onChanged?.();
    } catch (e) {
      alert(e?.response?.data?.detail || "Could not create portal login.");
    } finally { setBusy(false); }
  };

  const toggle = async () => {
    if (!email) { alert("This franchisee has no email on file — set their primary email first."); return; }
    if (enabled && !window.confirm(`Disable portal access for ${email}?\n\nThey will not be able to sign in until you re-enable it.`)) return;
    setBusy(true);
    try {
      await api.post(`/franchisees/${franchisee.id}/portal-toggle`, { enabled: !enabled });
      onChanged?.();
    } catch (e) { alert(e?.response?.data?.detail || "Toggle failed."); }
    finally { setBusy(false); }
  };

  const reset = async () => {
    if (!window.confirm(`Reset portal password for ${email}?\n\nTheir current password will be erased. The next time they sign in they will be asked to create a new password.`)) return;
    setBusy(true);
    try {
      await api.post(`/franchisees/${franchisee.id}/portal-reset`);
      alert("Password reset. Tell the franchisee to sign in again — they'll be prompted to set a new password.");
    } catch (e) { alert(e?.response?.data?.detail || "Reset failed."); }
    finally { setBusy(false); }
  };

  const portalUrl = `${window.location.origin}/portal/login`;
  const copyUrl = async () => {
    try { await navigator.clipboard.writeText(portalUrl); setCopied(true); setTimeout(() => setCopied(false), 1800); }
    catch { /* ignore */ }
  };
  const copyTempPw = async () => {
    if (!createdLogin?.temporary_password) return;
    try { await navigator.clipboard.writeText(createdLogin.temporary_password); }
    catch { /* ignore */ }
  };

  return (
    <div className="space-y-4" data-testid="portal-controls">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2.5">
          <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${enabled ? "bg-emerald-100 text-emerald-700" : "bg-stone-100 text-stone-400"}`}>
            <ShieldCheck className="w-4 h-4" />
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">Portal access</div>
            <div className="text-sm font-bold text-stone-950">{enabled ? "Enabled" : "Disabled"}</div>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={createPortalLogin}
            disabled={busy || !email}
            data-testid="create-portal-login-btn"
            title="Create or relink the franchisee's user account + R2 folders"
            className="px-3 py-2 text-[10px] font-bold uppercase tracking-wider rounded-lg flex items-center gap-1.5 disabled:opacity-50 bg-stone-950 text-white hover:bg-stone-800"
          >
            {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <UserPlus className="w-3 h-3" />}
            Create portal login
          </button>
          <button onClick={toggle} disabled={busy} data-testid="portal-toggle-btn"
            className={`px-3 py-2 text-[10px] font-bold uppercase tracking-wider rounded-lg flex items-center gap-1.5 disabled:opacity-50 ${enabled ? "bg-white border border-red-300 text-red-700 hover:bg-red-50" : "bg-[#DEDD0C] text-stone-950 hover:brightness-95"}`}>
            {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : enabled ? <PowerOff className="w-3 h-3" /> : <Power className="w-3 h-3" />}
            {enabled ? "Disable" : "Enable portal"}
          </button>
        </div>
      </div>

      {/* One-time temp-password card — shown only directly after a
          successful create-portal-login. Hides as soon as the admin
          closes it; the password isn't stored anywhere admin-visible
          (only hashed in the users table). */}
      {createdLogin && (
        <div className="rounded-xl border-2 border-emerald-200 bg-emerald-50 p-4" data-testid="created-login-card">
          <div className="flex items-start gap-3">
            <div className="w-9 h-9 rounded-lg flex items-center justify-center bg-emerald-600 text-white shrink-0">
              {createdLogin.already_existed ? <KeyRound className="w-4 h-4" /> : <UserPlus className="w-4 h-4" />}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-bold text-emerald-900">
                {createdLogin.already_existed ? "Existing user linked" : "Portal login created"}
              </div>
              <div className="text-xs text-emerald-800 mt-1">{createdLogin.message}</div>
              <div className="mt-3 grid grid-cols-1 sm:grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-xs">
                <span className="text-stone-600 uppercase tracking-wider font-bold">Email</span>
                <span className="font-mono text-stone-900 truncate">{createdLogin.email}</span>
                {createdLogin.temporary_password && (
                  <>
                    <span className="text-stone-600 uppercase tracking-wider font-bold">Temp password</span>
                    <span className="flex items-center gap-2 flex-wrap">
                      {/* createdLogin.temporary_password is a one-time
                          runtime value just returned by the backend so
                          the admin can copy it to the franchisee — NOT a
                          hardcoded credential. Stored only in component
                          state and dropped on next render. */}
                      <code className="px-2 py-1 bg-white border border-emerald-300 rounded text-stone-900 font-mono">
                        {showPassword ? createdLogin.temporary_password : "••••••••••••••"}
                      </code>
                      <button type="button" onClick={() => setShowPassword((v) => !v)}
                        className="text-stone-500 hover:text-stone-900" title={showPassword ? "Hide" : "Show"}>
                        {showPassword ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                      </button>
                      <button type="button" onClick={copyTempPw}
                        className="px-2 py-1 text-[10px] font-bold uppercase tracking-wider bg-stone-950 text-white rounded hover:bg-stone-800 flex items-center gap-1">
                        <Copy className="w-3 h-3" /> Copy
                      </button>
                    </span>
                  </>
                )}
              </div>
              <button onClick={() => setCreatedLogin(null)}
                data-testid="dismiss-created-login"
                className="mt-3 text-[11px] font-bold uppercase tracking-wider text-emerald-900 hover:text-emerald-700">
                I've saved it — dismiss
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="text-xs text-stone-600 leading-relaxed">
        When enabled, they can sign in at the portal URL below using their email
        {email ? <> (<span className="font-mono text-stone-900">{email}</span>)</> : <span className="text-red-700"> — no email on file, please set primary email first</span>}.
        On first sign-in they're prompted to choose their own password.
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <input readOnly value={portalUrl} data-testid="portal-url"
          className="flex-1 min-w-[200px] px-3 py-2 text-xs bg-stone-50 border border-stone-300 rounded-lg font-mono text-stone-700" />
        <button onClick={copyUrl} data-testid="portal-url-copy"
          className="px-3 py-2 text-xs font-bold uppercase tracking-wider bg-stone-950 text-white hover:bg-stone-800 rounded-lg flex items-center gap-1.5">
          {copied ? <><CheckCircle2 className="w-3.5 h-3.5" /> Copied</> : <><Copy className="w-3.5 h-3.5" /> Copy URL</>}
        </button>
        <button onClick={reset} disabled={busy || !enabled} data-testid="portal-reset-btn"
          className="px-3 py-2 text-xs font-bold uppercase tracking-wider bg-white border border-stone-300 text-stone-700 hover:bg-stone-50 rounded-lg flex items-center gap-1.5 disabled:opacity-40">
          <RotateCcw className="w-3.5 h-3.5" /> Reset password
        </button>
      </div>
    </div>
  );
}
