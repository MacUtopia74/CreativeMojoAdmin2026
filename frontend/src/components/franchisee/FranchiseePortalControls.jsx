// Admin-side controls for a single franchisee's portal access. Lives
// on FranchiseeDetailPage. Lets you enable/disable login and reset
// their password (used when they forget it or you're handing the
// account to a new owner).
import { useState } from "react";
import api from "@/lib/api";
import { Power, PowerOff, RotateCcw, ShieldCheck, Loader2, Copy, CheckCircle2 } from "lucide-react";

export default function FranchiseePortalControls({ franchisee, onChanged }) {
  const enabled = !!franchisee?.portal_enabled;
  const email = franchisee?.mojo_email || franchisee?.email;
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const toggle = async () => {
    if (!email) { alert("This franchisee has no email on file — set their Creative Mojo email first."); return; }
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
    catch (e) { /* ignore */ }
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
        <button onClick={toggle} disabled={busy} data-testid="portal-toggle-btn"
          className={`px-3 py-2 text-[10px] font-bold uppercase tracking-wider rounded-lg flex items-center gap-1.5 disabled:opacity-50 ${enabled ? "bg-white border border-red-300 text-red-700 hover:bg-red-50" : "bg-[#DEDD0C] text-stone-950 hover:brightness-95"}`}>
          {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : enabled ? <PowerOff className="w-3 h-3" /> : <Power className="w-3 h-3" />}
          {enabled ? "Disable" : "Enable portal"}
        </button>
      </div>

      <div className="text-xs text-stone-600 leading-relaxed">
        When enabled, they can sign in at the portal URL below using their Creative Mojo email
        {email ? <> (<span className="font-mono text-stone-900">{email}</span>)</> : <span className="text-red-700"> — no email on file, please set Creative Mojo email first</span>}.
        First-time sign-in lets them choose their own password. Need to reset it? Use the button below — they'll set a new one on next login.
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
