// Portal — Subscriptions.
//
// Shows the franchisee which add-on modules are currently active on
// their portal, plus the ones they could enable. For now toggling is
// admin-mediated (contact HQ), but the layout is built to slot in
// self-serve Stripe checkouts in the future.
import { useState } from "react";
import { useOutletContext } from "react-router-dom";
import {
  Sparkles, MapPin, Megaphone, Receipt, CalendarClock,
  CheckCircle2, XCircle, Mail, Loader2,
} from "lucide-react";
import api from "@/lib/api";

// All bookable add-on modules. Keep this in sync with
// /app/backend/server.py → portal_modules `allowed` list.
const ADDONS = [
  {
    key: "territory_plus",
    title: "My Territory+",
    blurb: "Plot your own contacts on the map, share territory snapshots with prospects, and unlock customer-segment overlays.",
    icon: MapPin,
  },
  {
    key: "marketing",
    title: "Marketing",
    blurb: "On-brand templates, social-asset library, and HQ-curated marketing campaigns ready to download and customise.",
    icon: Megaphone,
  },
  {
    key: "invoicing",
    title: "Invoicing",
    blurb: "Issue, send and reconcile your own customer invoices — Xero & WooCommerce-aware, fully scoped to your franchise.",
    icon: Receipt,
  },
  {
    key: "bookings",
    title: "Bookings",
    blurb: "Run a calendar booking flow for your customers. Coming soon — register your interest below.",
    icon: CalendarClock,
    comingSoon: true,
  },
];

const REQUEST_TO = "paul@creativemojo.co.uk";

export default function PortalSubscriptionsPage() {
  const ctx = useOutletContext() || {};
  const profile = ctx.profile || {};
  const modules = profile?.profile?.portal_modules || {};
  const [busy, setBusy] = useState(null); // addon key currently being requested
  const [sent, setSent] = useState({});   // {addon_key: true}
  const [err, setErr] = useState("");

  const me = profile?.user || profile?.profile || {};
  const myEmail = me.email || profile?.email || "";
  const myName = me.name || me.contact_name || profile?.profile?.name || "";

  const requestChange = async (addon, action) => {
    setErr("");
    setBusy(addon.key);
    const subject = encodeURIComponent(
      `[Subscription request] ${action === "enable" ? "Enable" : "Cancel"} ${addon.title}`,
    );
    const body = encodeURIComponent(
      `Hi Paul,\n\n` +
      `Please ${action === "enable" ? "enable" : "cancel"} the "${addon.title}" add-on for my franchise.\n\n` +
      `Franchisee: ${myName || "(name not on file)"}\n` +
      `Email: ${myEmail || "(unknown)"}\n\n` +
      `Thanks!`,
    );
    // Record the click server-side so HQ has an audit trail of who
    // asked for what — falls through silently if the endpoint isn't
    // mounted yet so the mailto fallback always works.
    try {
      await api.post("/portal/subscriptions/request", {
        addon: addon.key,
        action,
      });
    } catch (e) {
      // Non-fatal — we still open the mail client below.
      console.debug("[subscriptions] log endpoint not available", e?.message);
    }
    window.location.href = `mailto:${REQUEST_TO}?subject=${subject}&body=${body}`;
    setSent((s) => ({ ...s, [addon.key]: true }));
    setBusy(null);
  };

  return (
    <div className="space-y-6" data-testid="portal-subscriptions-page">
      {/* Header */}
      <div className="bg-stone-950 text-white rounded-2xl px-5 sm:px-8 py-5 sm:py-7 flex items-center gap-4">
        <Sparkles className="w-7 h-7 sm:w-8 sm:h-8 text-[#dedd0a] shrink-0" strokeWidth={2.2} />
        <div>
          <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-400">Account</div>
          <h1 className="font-display text-2xl sm:text-3xl font-black tracking-tight">Subscriptions</h1>
        </div>
      </div>

      <p className="text-sm text-stone-600 max-w-3xl">
        Manage the add-on modules attached to your portal. Tap <em>Request enable</em> or <em>Request cancel</em> and we&rsquo;ll
        take care of the rest. We&rsquo;ll move this to a self-serve checkout soon.
      </p>

      {err && (
        <div className="px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{err}</div>
      )}

      {/* Add-on cards */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {ADDONS.map((a) => {
          const active = !!modules[a.key];
          const Icon = a.icon;
          const isBusy = busy === a.key;
          const wasSent = sent[a.key];
          return (
            <div
              key={a.key}
              data-testid={`sub-card-${a.key}`}
              className={`bg-white border rounded-2xl p-5 sm:p-6 flex flex-col gap-4 ${
                active ? "border-emerald-300 ring-1 ring-emerald-200" : "border-stone-200"
              }`}
            >
              <div className="flex items-start gap-4">
                <div className={`w-12 h-12 rounded-xl flex items-center justify-center shrink-0 ${
                  active ? "bg-emerald-100 text-emerald-700" : "bg-stone-100 text-stone-600"
                }`}>
                  <Icon className="w-6 h-6" strokeWidth={2.2} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="font-display text-lg font-black text-stone-950 tracking-tight">{a.title}</h3>
                    {active ? (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded border bg-emerald-100 text-emerald-800 border-emerald-300">
                        <CheckCircle2 className="w-3 h-3" /> Active
                      </span>
                    ) : a.comingSoon ? (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded border bg-stone-950 text-[#dedd0a] border-stone-950">
                        <Sparkles className="w-3 h-3" /> Coming soon
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded border bg-stone-100 text-stone-700 border-stone-300">
                        <XCircle className="w-3 h-3" /> Not active
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-stone-600 mt-1.5 leading-relaxed">{a.blurb}</p>
                </div>
              </div>

              <div className="flex items-center gap-2 flex-wrap">
                {active ? (
                  <button
                    onClick={() => requestChange(a, "cancel")}
                    disabled={isBusy}
                    data-testid={`sub-cancel-${a.key}`}
                    className="px-3 py-2 text-[10px] font-bold uppercase tracking-wider bg-red-50 hover:bg-red-100 text-red-700 rounded-lg flex items-center gap-1.5 disabled:opacity-50"
                  >
                    {isBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Mail className="w-3.5 h-3.5" />}
                    Request cancel
                  </button>
                ) : (
                  <button
                    onClick={() => requestChange(a, "enable")}
                    disabled={isBusy}
                    data-testid={`sub-enable-${a.key}`}
                    className="px-3 py-2 text-[10px] font-bold uppercase tracking-wider bg-stone-950 hover:bg-stone-800 text-white rounded-lg flex items-center gap-1.5 disabled:opacity-50"
                  >
                    {isBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Mail className="w-3.5 h-3.5" />}
                    {a.comingSoon ? "Register interest" : "Request enable"}
                  </button>
                )}
                {wasSent && (
                  <span className="text-[11px] text-emerald-700 inline-flex items-center gap-1">
                    <CheckCircle2 className="w-3 h-3" /> Your mail client opened — send the message to complete the request.
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <p className="text-xs text-stone-500 max-w-3xl">
        Already paying for an add-on but it&rsquo;s showing as inactive? Drop us a line at <a href={`mailto:${REQUEST_TO}`} className="underline">{REQUEST_TO}</a> and we&rsquo;ll sort it.
      </p>
    </div>
  );
}
