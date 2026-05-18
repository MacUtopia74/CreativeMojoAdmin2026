// Admin-mediated password reset queue. Lists pending reset requests from
// /api/auth/password-reset/requests. Admin clicks "Generate temp
// password" → backend mints a memorable random password, replaces the
// user's bcrypt hash, and returns the plaintext ONCE so we can show it
// here. Admin then shares it with the user out-of-band (phone, SMS,
// Signal — never email, the whole point is the user can't access their
// email).
import { useCallback, useEffect, useState } from "react";
import api from "@/lib/api";
import { toast } from "sonner";
import {
  Loader2,
  ShieldCheck,
  KeyRound,
  Copy,
  CheckCircle2,
  X as XIcon,
  Mail,
  Clock,
  MoreHorizontal,
} from "lucide-react";

export default function PasswordResetsPage() {
  const [requests, setRequests] = useState([]);
  const [filter, setFilter] = useState("pending"); // pending | fulfilled | rejected | all
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);
  // One-time temp-password reveal — sticks until the admin closes it so
  // they have time to copy and share.
  const [reveal, setReveal] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get("/auth/password-reset/requests", {
        params: { status: filter },
      });
      setRequests(data.requests || []);
    } catch (e) {
      toast.error("Could not load reset requests");
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => { load(); }, [load]);

  const fulfill = async (req) => {
    setBusyId(req.id);
    try {
      const { data } = await api.post(
        `/auth/password-reset/requests/${req.id}/fulfill`
      );
      setReveal({
        email: data.email,
        user_name: data.user_name,
        temp_password: data.temp_password,
      });
      load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Could not fulfill request");
    } finally {
      setBusyId(null);
    }
  };

  const reject = async (req) => {
    if (!window.confirm(`Reject the reset request from ${req.email}?`)) return;
    setBusyId(req.id);
    try {
      await api.post(`/auth/password-reset/requests/${req.id}/reject`);
      toast.success("Request rejected");
      load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Could not reject");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-6 p-6 md:p-8" data-testid="password-resets-page">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-500">
            Security · User Accounts
          </div>
          <h1 className="font-display text-4xl text-stone-950 mt-1">
            Password Resets
          </h1>
          <p className="text-sm text-stone-600 mt-2 max-w-2xl">
            Users who clicked "Forgot Password" on a login page. Generate a
            temporary password — it appears once on this screen so you can
            share it directly. The user will be forced to change it on next
            login.
          </p>
        </div>
        <div className="inline-flex bg-stone-100 rounded-lg p-0.5">
          {["pending", "fulfilled", "rejected", "all"].map((s) => (
            <button
              key={s}
              onClick={() => setFilter(s)}
              data-testid={`reset-filter-${s}`}
              className={`px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider rounded-md transition ${
                filter === s
                  ? "bg-white text-stone-950 shadow-sm"
                  : "text-stone-600 hover:text-stone-900"
              }`}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center min-h-[30vh] text-stone-500">
          <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading…
        </div>
      ) : requests.length === 0 ? (
        <div className="bg-white border border-stone-200 rounded-2xl p-10 text-center">
          <ShieldCheck className="w-10 h-10 text-emerald-500 mx-auto" />
          <p className="mt-3 text-stone-700 font-bold">
            No {filter === "all" ? "" : filter} reset requests
          </p>
          <p className="text-xs text-stone-500 mt-1">
            Locked-out users will appear here after they click "Forgot
            Password" on a login page.
          </p>
        </div>
      ) : (
        <div className="bg-white border border-stone-200 rounded-2xl overflow-hidden">
          <div className="px-5 py-3 border-b border-stone-200 bg-stone-50 flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-700">
              {requests.length} request{requests.length === 1 ? "" : "s"}
            </span>
            <button
              onClick={load}
              className="text-[10px] uppercase tracking-wider font-bold text-stone-500 hover:text-stone-950"
              data-testid="reset-reload"
            >
              Reload
            </button>
          </div>
          <ul className="divide-y divide-stone-100">
            {requests.map((r) => (
              <li
                key={r.id}
                className="px-5 py-4 flex items-center gap-4 flex-wrap"
                data-testid={`reset-row-${r.id}`}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-stone-900">
                      {r.user_name || r.email}
                    </span>
                    <span className="text-xs text-stone-500 inline-flex items-center gap-1">
                      <Mail className="w-3 h-3" /> {r.email}
                    </span>
                    <StatusPill status={r.status} />
                    {r.role && (
                      <span className="text-[10px] uppercase tracking-wider font-bold text-stone-500 bg-stone-100 px-2 py-0.5 rounded">
                        {r.role}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-stone-500 mt-1 inline-flex items-center gap-1">
                    <Clock className="w-3 h-3" />
                    {new Date(r.requested_at).toLocaleString("en-GB")} · IP{" "}
                    {r.ip}
                  </div>
                  {r.fulfilled_at && (
                    <div className="text-xs text-stone-500 mt-0.5">
                      Fulfilled {new Date(r.fulfilled_at).toLocaleString("en-GB")}
                      {r.fulfilled_by_name && ` by ${r.fulfilled_by_name}`}
                    </div>
                  )}
                </div>
                {r.status === "pending" && (
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      disabled={busyId === r.id}
                      onClick={() => fulfill(r)}
                      data-testid={`reset-fulfill-${r.id}`}
                      className="px-3 py-2 text-xs font-bold uppercase tracking-wider bg-[#D4FF00] hover:bg-[#BDE600] text-stone-950 rounded-lg flex items-center gap-1.5 disabled:opacity-50"
                    >
                      {busyId === r.id ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <KeyRound className="w-3.5 h-3.5" />
                      )}
                      Generate temp password
                    </button>
                    <button
                      disabled={busyId === r.id}
                      onClick={() => reject(r)}
                      data-testid={`reset-reject-${r.id}`}
                      className="px-3 py-2 text-xs font-bold uppercase tracking-wider border border-stone-300 hover:bg-stone-50 text-stone-700 rounded-lg flex items-center gap-1.5 disabled:opacity-50"
                    >
                      <XIcon className="w-3.5 h-3.5" /> Reject
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <RevealModal data={reveal} onClose={() => setReveal(null)} />
    </div>
  );
}

function StatusPill({ status }) {
  const cfg = {
    pending: "bg-amber-100 text-amber-900 border border-amber-300",
    fulfilled: "bg-emerald-100 text-emerald-900 border border-emerald-300",
    rejected: "bg-stone-100 text-stone-700 border border-stone-300",
  };
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded ${cfg[status] || cfg.rejected}`}
    >
      {status}
    </span>
  );
}

function RevealModal({ data, onClose }) {
  const [copied, setCopied] = useState(false);
  if (!data) return null;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(data.temp_password);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* ignore */ }
  };
  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-[80] bg-stone-950/60 backdrop-blur-sm flex items-center justify-center p-6"
      data-testid="reset-reveal-modal"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-white rounded-2xl shadow-2xl max-w-md w-full overflow-hidden"
      >
        <div className="px-5 py-3 border-b border-stone-200 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <KeyRound className="w-4 h-4 text-stone-700" />
            <span className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-700">
              Temporary Password
            </span>
          </div>
          <button
            onClick={onClose}
            data-testid="reveal-close"
            className="w-9 h-9 flex items-center justify-center hover:bg-stone-100 rounded-lg"
          >
            <XIcon className="w-4 h-4" />
          </button>
        </div>
        <div className="px-6 py-5 space-y-4">
          <div className="text-sm text-stone-700">
            Share this password with{" "}
            <strong>{data.user_name || data.email}</strong> via phone, SMS or
            messenger. They will be required to set a new one on next login.
          </div>
          <div className="bg-stone-950 rounded-xl px-4 py-3 flex items-center justify-between gap-3">
            <code
              data-testid="reveal-temp-pwd"
              className="font-mono text-base text-[#D4FF00] tracking-widest select-all"
            >
              {data.temp_password}
            </code>
            <button
              onClick={copy}
              data-testid="reveal-copy"
              className="px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-wider bg-[#D4FF00] hover:bg-[#BDE600] text-stone-950 rounded-md flex items-center gap-1.5"
            >
              {copied ? (
                <><CheckCircle2 className="w-3.5 h-3.5" /> Copied</>
              ) : (
                <><Copy className="w-3.5 h-3.5" /> Copy</>
              )}
            </button>
          </div>
          <div className="text-[11px] text-amber-900 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
            <MoreHorizontal className="w-3.5 h-3.5 inline mr-1" />
            This is shown <strong>once</strong>. Close this window and it's
            gone — you'll need to issue a new reset to see it again.
          </div>
        </div>
      </div>
    </div>
  );
}
