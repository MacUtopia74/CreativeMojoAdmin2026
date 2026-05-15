import { useEffect, useState, useMemo } from "react";
import { useParams, Link } from "react-router-dom";
import api from "@/lib/api";
import { formatDate, daysFromToday } from "@/lib/date";
import { ArrowLeft, MapPin, AlertCircle, User, FileText, Map, MessageSquare, Pencil, Check, X as XIcon, Clock, ShieldCheck, ShieldAlert, Globe, Facebook, CreditCard, RefreshCw, AlertTriangle, Power, PowerOff, BellRing } from "lucide-react";

// Live GoCardless mandate status pill (read from cached franchisee fields)
const MANDATE_STYLES = {
  active: "bg-emerald-100 text-emerald-800 border-emerald-300",
  pending_submission: "bg-blue-100 text-blue-800 border-blue-300",
  submitted: "bg-blue-100 text-blue-800 border-blue-300",
  pending_customer_approval: "bg-amber-100 text-amber-800 border-amber-300",
  cancelled: "bg-red-100 text-red-800 border-red-300",
  failed: "bg-red-100 text-red-800 border-red-300",
  expired: "bg-stone-200 text-stone-700 border-stone-300",
  consumed: "bg-stone-200 text-stone-700 border-stone-300",
  unknown: "bg-stone-100 text-stone-500 border-stone-200",
};
const MANDATE_LABELS = {
  active: "Active",
  pending_submission: "Pending",
  submitted: "Submitted",
  pending_customer_approval: "Awaiting Customer",
  cancelled: "Cancelled",
  failed: "Failed",
  expired: "Expired",
  consumed: "Consumed",
  unknown: "Unknown",
};
function MandatePill({ franchisee }) {
  const s = franchisee.gocardless_mandate_status;
  if (!franchisee.gocardless_mandate_id && !s) {
    return (
      <>
        <div className="font-display text-base text-stone-400 mt-1">Not linked</div>
        <div className="text-[10px] text-stone-400 mt-0.5">Run GoCardless sync</div>
      </>
    );
  }
  const style = MANDATE_STYLES[s] || MANDATE_STYLES.unknown;
  return (
    <>
      <span data-testid="mandate-pill"
        className={`inline-block mt-1 px-2.5 py-0.5 text-xs font-bold uppercase tracking-wider border rounded-md ${style}`}>
        {MANDATE_LABELS[s] || s || "Unknown"}
      </span>
      {franchisee.gocardless_mandate_reference && (
        <div className="text-[10px] text-stone-500 mt-0.5 tabular-nums truncate">{franchisee.gocardless_mandate_reference}</div>
      )}
    </>
  );
}

function Panel({ icon: Icon, title, action, children, testid }) {
  return (
    <div className="bg-white border border-stone-200 rounded-2xl overflow-hidden" data-testid={testid}>
      <div className="px-5 py-3 border-b border-stone-200 flex items-center justify-between">
        <div className="flex items-center gap-2">
          {Icon && <Icon className="w-3.5 h-3.5 text-stone-500" />}
          <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600">{title}</div>
        </div>
        {action}
      </div>
      <div className="p-5">{children}</div>
    </div>
  );
}

// In-place editable text field
function EditField({ field, value, label, type = "text", editing, draft, setDraft, mono }) {
  if (!editing) {
    return (
      <div>
        <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">{label}</div>
        <div className={`text-sm text-stone-900 mt-1 ${mono ? "tabular-nums" : ""}`}>
          {value || <span className="text-stone-300">—</span>}
        </div>
      </div>
    );
  }
  return (
    <div>
      <label className="block text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 mb-1">{label}</label>
      <input
        type={type} value={draft[field] ?? ""}
        onChange={(e) => setDraft((d) => ({ ...d, [field]: e.target.value }))}
        data-testid={`edit-${field}`}
        className="w-full px-3 py-2 text-sm border border-stone-300 rounded-lg bg-white focus:outline-none focus:border-stone-900" />
    </div>
  );
}

// A big current-contract card with date countdown — used at top of Contracts panel
function CurrentContractCard({ contract }) {
  const renewal = contract.renewal_date;
  const daysLeft = daysFromToday(renewal);
  const tier = daysLeft == null ? null
             : daysLeft < 0 ? "expired"
             : daysLeft <= 30 ? "expiring"
             : daysLeft <= 90 ? "soon"
             : "active";
  const accent = tier === "expired"  ? "border-red-300 bg-red-50"
               : tier === "expiring" ? "border-amber-300 bg-amber-50"
               : tier === "soon"     ? "border-blue-200 bg-blue-50"
               : "border-emerald-200 bg-emerald-50";
  const Icon = tier === "expired" ? ShieldAlert : tier === "expiring" ? Clock : ShieldCheck;
  const accentText = tier === "expired" ? "text-red-700" : tier === "expiring" ? "text-amber-800" : tier === "soon" ? "text-blue-800" : "text-emerald-800";
  return (
    <div className={`border-2 rounded-2xl p-5 ${accent}`} data-testid="current-contract">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-2">
          <Icon className={`w-4 h-4 ${accentText}`} />
          <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-700">Current Contract · {contract.ref ? `#${contract.ref}` : "Active"}</div>
        </div>
        <div className={`px-2.5 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-wider ${
          tier === "expired" ? "bg-red-200 text-red-900"
          : tier === "expiring" ? "bg-amber-200 text-amber-900"
          : tier === "soon" ? "bg-blue-200 text-blue-900"
          : "bg-emerald-200 text-emerald-900"
        }`}>
          {tier === "expired" ? `Expired ${Math.abs(daysLeft)}d ago` : daysLeft != null ? `${daysLeft} days remaining` : "Active"}
        </div>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-5">
        <div>
          <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">Started</div>
          <div className="font-display text-2xl text-stone-950 tabular-nums mt-0.5">{formatDate(contract.commencement_date)}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">Renews / Expires</div>
          <div className="font-display text-2xl text-stone-950 tabular-nums mt-0.5">{formatDate(contract.renewal_date)}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">Term</div>
          <div className="font-display text-2xl text-stone-950 mt-0.5">{contract.contract_term_years ? `${contract.contract_term_years} yrs` : "—"}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">Monthly Fee</div>
          <div className="font-display text-2xl text-stone-950 mt-0.5">{contract.monthly_fee != null ? `£${contract.monthly_fee}` : "—"}</div>
        </div>
      </div>
    </div>
  );
}

// GoCardless live status + last/next payment panel
function GoCardlessPanel({ franchisee, onRefreshed }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const f = franchisee;
  const last = f.gocardless_last_payment;
  const next = f.gocardless_next_payment;
  const linked = !!f.gocardless_mandate_id;

  const handleRefresh = async () => {
    setBusy(true); setErr("");
    try {
      const { data } = await api.post(`/gocardless/franchisees/${f.id}/refresh`);
      if (data.linked === false) {
        setErr(data.reason || "No matching GoCardless customer.");
      }
      if (data.franchisee) onRefreshed(data.franchisee);
    } catch (e) {
      setErr(e?.response?.data?.detail || "Could not refresh.");
    } finally { setBusy(false); }
  };

  return (
    <Panel
      icon={CreditCard}
      title="GoCardless · Direct Debit"
      testid="panel-gocardless"
      action={
        <button onClick={handleRefresh} disabled={busy} data-testid="gc-refresh"
          className="text-[10px] uppercase tracking-widest font-bold text-stone-500 hover:text-stone-950 flex items-center gap-1 disabled:opacity-50">
          <RefreshCw className={`w-3 h-3 ${busy ? "animate-spin" : ""}`} /> {busy ? "Refreshing…" : "Refresh from GoCardless"}
        </button>
      }>
      {!linked ? (
        <div className="text-sm text-stone-500 text-center py-6" data-testid="gc-not-linked">
          Not linked to GoCardless. Run the Sync from the Franchisees page (or click Refresh) to match by email.
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-5">
            <div>
              <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">Status</div>
              <div className="mt-1"><MandatePill franchisee={f} /></div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">Scheme</div>
              <div className="font-display text-base text-stone-900 mt-1 uppercase">{f.gocardless_mandate_scheme || "—"}</div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">Last Payment</div>
              <div className="font-display text-base text-stone-900 mt-1 tabular-nums">
                {last?.amount_str || (last?.amount != null ? `£${(last.amount / 100).toFixed(2)}` : "—")}
              </div>
              <div className="text-[10px] text-stone-500 tabular-nums">{last?.charge_date ? formatDate(last.charge_date) : ""}</div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">Next Payment</div>
              <div className="font-display text-base text-stone-900 mt-1 tabular-nums">
                {next?.amount_str || (next?.amount != null ? `£${(next.amount / 100).toFixed(2)}` : "—")}
              </div>
              <div className="text-[10px] text-stone-500 tabular-nums">{next?.charge_date ? formatDate(next.charge_date) : ""}</div>
            </div>
          </div>
          <div className="text-[10px] text-stone-400 tabular-nums">
            GC Customer: {f.gocardless_customer_id || "—"} · Mandate: {f.gocardless_mandate_id || "—"}
            {f.gocardless_synced_at && <> · Synced {formatDate(f.gocardless_synced_at)}</>}
          </div>
          {err && (
            <div className="text-xs text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg flex items-center gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5" /> {err}
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}

export default function FranchiseeDetailPage() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({});
  const [saving, setSaving] = useState(false);
  const [lifecycleBusy, setLifecycleBusy] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const { data } = await api.get(`/franchisees/${id}`);
        setData(data);
      } catch (e) { setError("Franchisee not found."); }
      finally { setLoading(false); }
    })();
  }, [id]);

  const setFranchisee = (fresh) => setData((d) => ({ ...d, franchisee: fresh }));

  const toggleLifecycle = async (target) => {
    const isDeactivate = target === "ex_franchisee";
    const prompt = isDeactivate
      ? `Deactivate ${data.franchisee.first_name || "this franchisee"}? They'll be tagged EX-Franchisee and excluded from active operations.`
      : `Reactivate ${data.franchisee.first_name || "this franchisee"}? They'll be tagged Franchisee again and you'll be reminded to set up their Direct Debit mandate.`;
    if (!window.confirm(prompt)) return;
    const reason = isDeactivate
      ? (window.prompt("Optional — note the reason for deactivation (visible in audit log):", "") || "").trim()
      : (window.prompt("Optional — note the reason for reactivation:", "") || "").trim();
    setLifecycleBusy(true);
    try {
      const { data: res } = await api.patch(`/franchisees/${id}/lifecycle`, { status: target, reason });
      setFranchisee(res.franchisee);
    } catch (e) {
      alert(e?.response?.data?.detail || "Could not change status.");
    } finally { setLifecycleBusy(false); }
  };

  const clearMandateReminder = async () => {
    try {
      await api.post(`/franchisees/${id}/clear-mandate-reminder`);
      setFranchisee({ ...data.franchisee, needs_mandate_setup: false });
    } catch (e) { /* noop */ }
  };

  const startEdit = () => {
    const f = data.franchisee;
    setDraft({
      first_name: f.first_name || "", last_name: f.last_name || "",
      organisation: f.organisation || "", email: f.email || "",
      mojo_email: f.mojo_email || "", secondary_email: f.secondary_email || "",
      telephone: f.telephone || "", mobile_phone: f.mobile_phone || "",
      address: f.address || f.address_street || "", city: f.city || "", county: f.county || "", postcode: f.postcode || "",
      country: f.country || "", notes: f.notes || "",
    });
    setEditing(true);
  };
  const cancelEdit = () => { setEditing(false); setDraft({}); };
  const saveEdit = async () => {
    setSaving(true);
    try {
      const r = await api.patch(`/franchisees/${id}`, draft);
      setData((d) => ({ ...d, franchisee: r.data.franchisee }));
      setEditing(false);
    } catch (e) { setError("Could not save changes."); }
    finally { setSaving(false); }
  };

  const { current, history } = useMemo(() => {
    if (!data) return { current: null, history: [] };
    // "Current" = the active contract with the latest renewal date that isn't cancelled
    const sorted = [...(data.contracts || [])].sort((a, b) =>
      String(b.renewal_date || "").localeCompare(String(a.renewal_date || "")));
    const cur = sorted.find((c) => !c.cancelled_early) || null;
    return { current: cur, history: sorted.filter((c) => c.id !== cur?.id) };
  }, [data]);

  if (loading) return <div className="min-h-screen flex items-center justify-center text-stone-500 text-sm uppercase tracking-widest">Loading…</div>;
  if (error || !data) return (
    <div className="p-12">
      <Link to="/franchisees" className="text-xs uppercase tracking-widest font-bold text-stone-500 hover:text-stone-950">← Back to list</Link>
      <div className="border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 flex items-center gap-2 max-w-lg rounded-xl mt-6">
        <AlertCircle className="w-4 h-4" /> {error}
      </div>
    </div>
  );

  const f = data.franchisee;
  const contracts = data.contracts || [];
  const territories = data.territories || [];
  const enquiries = data.enquiries || [];
  const photo = f.photos?.[0]?.url;
  const fullName = `${f.first_name || ""} ${f.last_name || ""}`.trim();
  const tags = Array.isArray(f.tags) ? f.tags : f.tags ? [f.tags] : [];
  const statusTag = tags.find((t) => /Franchisee|Licencee|Worldwide|Ex-/i.test(t));
  const feeTag = tags.find((t) => /Mojo Fee|Mojo Live/i.test(t));
  const otherTags = tags.filter((t) => t !== statusTag && t !== feeTag);
  const statusColor = statusTag === "Franchisee" ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                    : statusTag === "Worldwide Licencee" ? "bg-indigo-50 text-indigo-700 border-indigo-200"
                    : statusTag === "EX-Franchisee" ? "bg-stone-100 text-stone-500 border-stone-200"
                    : "bg-stone-50 text-stone-700 border-stone-200";

  return (
    <div className="bg-stone-50 min-h-screen">
      <div className="h-16 border-b border-stone-200 bg-white flex items-center justify-between px-6">
        <div className="flex items-center gap-4">
          <Link to="/franchisees" className="text-xs uppercase tracking-widest font-bold text-stone-500 hover:text-stone-950 flex items-center gap-1.5" data-testid="back-to-list">
            <ArrowLeft className="w-3.5 h-3.5" /> Franchisees
          </Link>
          <span className="text-stone-300">·</span>
          <h1 className="font-display text-xl text-stone-950" data-testid="franchisee-detail-name">{fullName || f.organisation || "—"}</h1>
        </div>
        <div className="flex items-center gap-2">
          {!editing && (
            (() => {
              const isEx = (f.lifecycle_status === "ex_franchisee") || (f.tags || []).includes("EX-Franchisee");
              return isEx ? (
                <button onClick={() => toggleLifecycle("active")} disabled={lifecycleBusy} data-testid="reactivate-franchisee"
                  className="px-3 py-1.5 text-xs font-bold uppercase tracking-wider border border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100 rounded-lg flex items-center gap-1.5 disabled:opacity-50">
                  <Power className="w-3.5 h-3.5" /> {lifecycleBusy ? "Working…" : "Reactivate"}
                </button>
              ) : (
                <button onClick={() => toggleLifecycle("ex_franchisee")} disabled={lifecycleBusy} data-testid="deactivate-franchisee"
                  className="px-3 py-1.5 text-xs font-bold uppercase tracking-wider border border-stone-300 bg-white text-stone-700 hover:bg-red-50 hover:text-red-700 hover:border-red-200 rounded-lg flex items-center gap-1.5 disabled:opacity-50">
                  <PowerOff className="w-3.5 h-3.5" /> {lifecycleBusy ? "Working…" : "Make Ex-Franchisee"}
                </button>
              );
            })()
          )}
          {!editing ? (
            <button onClick={startEdit} data-testid="edit-franchisee"
              className="px-3 py-1.5 text-xs font-bold uppercase tracking-wider border border-stone-300 bg-white text-stone-900 hover:bg-stone-50 rounded-lg flex items-center gap-1.5">
              <Pencil className="w-3.5 h-3.5" /> Edit
            </button>
          ) : (
            <>
              <button onClick={cancelEdit} data-testid="cancel-edit"
                className="px-3 py-1.5 text-xs font-bold uppercase tracking-wider border border-stone-300 bg-white text-stone-700 hover:bg-stone-50 rounded-lg flex items-center gap-1.5">
                <XIcon className="w-3.5 h-3.5" /> Cancel
              </button>
              <button onClick={saveEdit} disabled={saving} data-testid="save-edit"
                className="px-3 py-1.5 text-xs font-bold uppercase tracking-wider bg-[#D4FF00] hover:bg-[#BDE600] text-stone-950 rounded-lg flex items-center gap-1.5 disabled:opacity-50">
                <Check className="w-3.5 h-3.5" /> {saving ? "Saving…" : "Save"}
              </button>
            </>
          )}
        </div>
      </div>

      <div className="p-8 max-w-[1400px] space-y-6">
        {/* Reactivation reminder — appears when a franchisee was reactivated and their mandate isn't active */}
        {f.needs_mandate_setup && (
          <div className="bg-amber-50 border border-amber-300 rounded-2xl p-4 flex items-start gap-3" data-testid="mandate-reminder">
            <BellRing className="w-5 h-5 text-amber-700 shrink-0 mt-0.5" />
            <div className="flex-1">
              <div className="text-sm font-bold text-amber-900">Set up Direct Debit mandate</div>
              <div className="text-xs text-amber-800 mt-0.5">
                {f.first_name || "This franchisee"} was reactivated{f.reactivated_at ? ` on ${formatDate(f.reactivated_at)}` : ""}. Their previous GoCardless mandate is no longer active. Once you've set up a new mandate at <a className="underline" href="https://manage.gocardless.com" target="_blank" rel="noreferrer">gocardless.com</a>, run the bulk sync from the Franchisees page (or click "Refresh from GoCardless" below) and this reminder will clear automatically.
              </div>
            </div>
            <button onClick={clearMandateReminder} data-testid="dismiss-mandate-reminder"
              className="shrink-0 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider border border-amber-300 bg-white text-amber-900 hover:bg-amber-100 rounded-md">
              Dismiss
            </button>
          </div>
        )}

        {/* HERO */}
        <div className="grid grid-cols-1 lg:grid-cols-[220px_1fr_auto] gap-6 items-start">
          <div>
            {photo ? (
              <img src={photo} alt={fullName} className="w-full aspect-square object-cover border border-stone-200 rounded-2xl" />
            ) : (
              <div className="w-full aspect-square bg-stone-100 border border-stone-200 flex items-center justify-center text-5xl font-display text-stone-400 rounded-2xl">
                {(f.first_name?.[0] || "?") + (f.last_name?.[0] || "")}
              </div>
            )}
          </div>
          <div className="space-y-3">
            <div className="flex items-center gap-2 flex-wrap">
              {statusTag && <span className={`px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider border rounded-md ${statusColor}`}>{statusTag}</span>}
              {feeTag && <span className="px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider bg-[#D4FF00]/15 border border-[#D4FF00]/60 text-stone-900 rounded-md">{feeTag}</span>}
              {f.franchise_number && <span className="text-xs text-stone-500">Franchise #{f.franchise_number}</span>}
            </div>
            <div>
              <h2 className="font-display text-4xl text-stone-950">{fullName || f.organisation}</h2>
              {f.organisation && fullName && <div className="text-base text-stone-600 mt-1">{f.organisation}</div>}
            </div>
            <div className="text-sm text-stone-700 flex items-center gap-1.5">
              <MapPin className="w-3.5 h-3.5 text-stone-400" />
              {[f.city, f.county, f.postcode].filter(Boolean).join(" · ") || "—"}
            </div>
            {otherTags.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {otherTags.map((t) => <span key={t} className="px-2 py-0.5 bg-stone-100 text-xs text-stone-700 rounded-md">{t}</span>)}
              </div>
            )}
          </div>
          <div className="grid grid-cols-3 gap-px bg-stone-200 border border-stone-200 lg:min-w-[420px] rounded-2xl overflow-hidden">
            <div className="bg-white p-4">
              <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">Contracts</div>
              <div className="font-display text-2xl text-stone-950 mt-1">{contracts.length}</div>
              <div className="text-xs text-stone-500 mt-0.5">{contracts.filter(c => !c.cancelled_early).length} active</div>
            </div>
            <div className="bg-white p-4">
              <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">Territory</div>
              <div className="font-display text-2xl text-stone-950 mt-1">{territories.length}</div>
              <div className="text-xs text-stone-500 mt-0.5">postcode sectors</div>
            </div>
            <div className="bg-white p-4" data-testid="kpi-mandate">
              <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">Mandate</div>
              <MandatePill franchisee={f} />
            </div>
          </div>
        </div>

        {/* CONTRACTS — full-width prominent */}
        <Panel icon={FileText} title={`Contracts (${contracts.length})`} testid="panel-contracts">
          {contracts.length === 0 ? (
            <div className="text-sm text-stone-500 text-center py-6">No contracts on file.</div>
          ) : (
            <div className="space-y-5">
              {current && <CurrentContractCard contract={current} />}
              {history.length > 0 && (
                <div>
                  <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 mb-3">Previous Contracts ({history.length})</div>
                  <div className="border border-stone-200 rounded-xl overflow-hidden">
                    <table className="w-full" data-testid="contracts-history">
                      <thead className="bg-stone-50 border-b border-stone-200">
                        <tr>
                          <th className="text-left px-3 py-2 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600">Ref</th>
                          <th className="text-left px-3 py-2 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600">Started</th>
                          <th className="text-left px-3 py-2 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600">Ended</th>
                          <th className="text-left px-3 py-2 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600">Term</th>
                          <th className="text-left px-3 py-2 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600">Fee</th>
                          <th className="text-left px-3 py-2 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {history.map((c) => (
                          <tr key={c.id} className="border-b border-stone-100 last:border-0 hover:bg-stone-50">
                            <td className="px-3 py-2 text-sm font-semibold text-stone-700">{c.ref ? `#${c.ref}` : "—"}</td>
                            <td className="px-3 py-2 text-xs text-stone-700 tabular-nums">{formatDate(c.commencement_date)}</td>
                            <td className="px-3 py-2 text-xs text-stone-700 tabular-nums">{formatDate(c.renewal_date)}</td>
                            <td className="px-3 py-2 text-xs text-stone-700">{c.contract_term_years ? `${c.contract_term_years} yrs` : "—"}</td>
                            <td className="px-3 py-2 text-xs text-stone-700">{c.monthly_fee != null ? `£${c.monthly_fee}` : "—"}</td>
                            <td className="px-3 py-2">
                              {c.cancelled_early
                                ? <span className="px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider bg-red-50 text-red-700 border border-red-200 rounded-md">Cancelled</span>
                                : <span className="px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider bg-stone-100 text-stone-600 border border-stone-200 rounded-md">Ended</span>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}
        </Panel>

        {/* GoCardless live mandate + payment summary */}
        <GoCardlessPanel franchisee={f} onRefreshed={(fresh) => setData((d) => ({ ...d, franchisee: fresh }))} />

        {/* Side-by-side details + map placeholder */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Panel icon={User} title="Contact Details" testid="panel-contact"
            action={!editing && (
              <button onClick={startEdit} className="text-[10px] uppercase tracking-widest font-bold text-stone-500 hover:text-stone-950 flex items-center gap-1">
                <Pencil className="w-3 h-3" /> Edit
              </button>
            )}>
            <div className="grid grid-cols-2 gap-5">
              <EditField field="first_name" label="First Name" value={f.first_name} editing={editing} draft={draft} setDraft={setDraft} />
              <EditField field="last_name" label="Last Name" value={f.last_name} editing={editing} draft={draft} setDraft={setDraft} />
              <EditField field="organisation" label="Organisation" value={f.organisation} editing={editing} draft={draft} setDraft={setDraft} />
              <EditField field="email" label="Email" value={f.email} type="email" editing={editing} draft={draft} setDraft={setDraft} mono />
              <EditField field="mojo_email" label="Mojo Email" value={f.mojo_email} type="email" editing={editing} draft={draft} setDraft={setDraft} mono />
              <EditField field="secondary_email" label="Secondary Email" value={f.secondary_email} type="email" editing={editing} draft={draft} setDraft={setDraft} mono />
              <EditField field="telephone" label="Telephone" value={f.telephone} editing={editing} draft={draft} setDraft={setDraft} mono />
              <EditField field="mobile_phone" label="Mobile" value={f.mobile_phone} editing={editing} draft={draft} setDraft={setDraft} mono />
            </div>
            {!editing && (f.website || f.facebook) && (
              <div className="flex flex-wrap gap-4 pt-4 mt-4 border-t border-stone-100 text-xs">
                {f.website && <a href={f.website.startsWith("http") ? f.website : `https://${f.website}`} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 text-stone-700 hover:text-stone-950"><Globe className="w-3 h-3" /> {f.website}</a>}
                {f.facebook && <a href={f.facebook.startsWith("http") ? f.facebook : `https://facebook.com/${f.facebook}`} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 text-stone-700 hover:text-stone-950"><Facebook className="w-3 h-3" /> {f.facebook}</a>}
              </div>
            )}
          </Panel>

          <Panel icon={MapPin} title="Address" testid="panel-address">
            <div className="grid grid-cols-2 gap-5">
              <EditField field="address" label="Street" value={f.address || f.address_street} editing={editing} draft={draft} setDraft={setDraft} />
              <EditField field="city" label="City" value={f.city} editing={editing} draft={draft} setDraft={setDraft} />
              <EditField field="county" label="County" value={f.county} editing={editing} draft={draft} setDraft={setDraft} />
              <EditField field="postcode" label="Postcode" value={f.postcode} editing={editing} draft={draft} setDraft={setDraft} mono />
              <EditField field="country" label="Country" value={f.country} editing={editing} draft={draft} setDraft={setDraft} />
              <div>
                <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">Date Added</div>
                <div className="text-sm text-stone-900 mt-1 tabular-nums">{(f.date_added || f.created_at) ? formatDate(f.date_added || f.created_at) : <span className="text-stone-300">—</span>}</div>
              </div>
            </div>
          </Panel>

          {/* Territory map placeholder — actual Mapbox map arrives in Phase 4 */}
          <Panel icon={Map} title={`Territory Map (${territories.length} postcode sectors)`} testid="panel-map">
            <div className="aspect-[16/9] bg-stone-100 border border-stone-200 rounded-xl flex flex-col items-center justify-center gap-2 relative overflow-hidden">
              {/* faint dot grid to suggest 'map' */}
              <div className="absolute inset-0 opacity-30" style={{
                backgroundImage: "radial-gradient(#a8a29e 1px, transparent 1px)",
                backgroundSize: "16px 16px",
              }} />
              <Map className="w-8 h-8 text-stone-400 relative" />
              <div className="text-xs text-stone-600 text-center relative max-w-xs">
                Live Mapbox territory map arrives in <strong>Phase 4</strong>.
                Will support postcode lookup and embed on the public site.
              </div>
            </div>
            {territories.length > 0 && (
              <div className="mt-4">
                <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 mb-2">All postcode sectors</div>
                <div className="flex flex-wrap gap-1.5 max-h-48 overflow-y-auto">
                  {territories.map((t) => (
                    <span key={t.id} className="px-2 py-0.5 bg-stone-100 text-xs text-stone-800 tabular-nums rounded-md">{t.postcode}</span>
                  ))}
                </div>
              </div>
            )}
          </Panel>

          <Panel icon={MessageSquare} title="Notes" testid="panel-notes">
            {editing ? (
              <textarea value={draft.notes ?? ""} onChange={(e) => setDraft((d) => ({ ...d, notes: e.target.value }))}
                rows={6} data-testid="edit-notes"
                className="w-full px-3 py-2 text-sm border border-stone-300 rounded-lg bg-white focus:outline-none focus:border-stone-900" />
            ) : (
              <div className="text-sm text-stone-700 whitespace-pre-wrap leading-relaxed min-h-[60px]">
                {f.notes || <span className="text-stone-300">No notes</span>}
              </div>
            )}
          </Panel>
        </div>

        {enquiries.length > 0 && (
          <Panel icon={MessageSquare} title={`Original Enquiry (${enquiries.length})`} testid="panel-enquiries">
            <div className="space-y-3">
              {enquiries.slice(0, 5).map((e) => (
                <div key={e.id} className="text-sm border-l-2 border-stone-200 pl-3">
                  <div className="text-xs text-stone-500 tabular-nums">{formatDate(e.date)}</div>
                  <div className="text-stone-900 mt-1">{e.why_contacting || e.message || "—"}</div>
                </div>
              ))}
            </div>
          </Panel>
        )}
      </div>
    </div>
  );
}
