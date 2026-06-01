// Portal — Subscriptions.
//
// VISUAL MOCK ONLY — nothing is wired up. Each bolt-on is rendered as a
// tall pricing card (à la OptiSigns / Stripe pricing pages) with a tick
// checklist of what the franchisee gets and a checkbox + "Upgrade now"
// button. The "All bolt-ons" bundle below offers all four for £30/mo
// (saves £7/mo vs buying them individually).
import { useState } from "react";
import { useOutletContext } from "react-router-dom";
import {
  Sparkles, MapPin, Megaphone, Receipt, CalendarClock,
  CheckCircle2, Check, ArrowRight, Package,
} from "lucide-react";
import PortalPageHeading from "@/components/portal/PortalPageHeading";

// PRICING — confirmed by Paul:
//   Every bolt-on is £9.95 / month + VAT, bundle of all four is £34.99
//   / month + VAT (saves £4.81 vs buying them individually).
// All exclusive of VAT, billed monthly via the franchisee's existing
// GoCardless mandate (added as a recurring line to their Xero invoice
// on admin approval).
const BOLT_ONS = [
  {
    key: "invoicing",
    title: "Invoicing",
    icon: Receipt,
    price: 9.95,
    accent: "#10b981",
    blurb: "Issue, send and reconcile your own customer invoices — linked to your contacts list.",
    features: [
      "Create, save and send invoices from inside the portal",
      "Linked to your customer contacts",
      "Branded invoice PDFs with your franchise details",
      "Automatic VAT calculation and tax-period reports",
      "Send by email or download as PDF in one click",
    ],
  },
  {
    key: "territory_plus",
    title: "My Territory+",
    icon: MapPin,
    price: 9.95,
    accent: "#0ea5e9",
    recommended: true,
    blurb: "Claim customers as yours, plot them on the map, and run a light CRM on top.",
    features: [
      "“Claim” a client as yours and drop a marker on the map",
      "Add unlimited contacts of your own to your territory",
      "Basic CRM — notes, statuses, follow-up reminders",
      "Care-home, school and nursery overlays for prospecting",
      "Shareable territory snapshot link",
    ],
  },
  {
    key: "marketing",
    title: "Marketing",
    icon: Megaphone,
    price: 9.95,
    accent: "#f97316",
    blurb: "Send branded e-shots to your own customers from inside the portal.",
    features: [
      "Build basic e-shots with our drag-in templates",
      "Drop in images, headlines and your own copy",
      "Link to a “Get in touch” reply box on each send",
      "Or link straight to your Bookings booking page",
      "Auto-co-branded with your franchise details",
    ],
  },
  {
    key: "bookings",
    title: "Bookings",
    icon: CalendarClock,
    price: 9.95,
    accent: "#dedd0a",
    comingSoon: true,
    blurb: "Log and manage bookings inside your own calendar — and let customers self-book.",
    features: [
      "Log and manage your own classes + one-off bookings",
      "Linked to your My Territory+ map and contacts",
      "Share a booking calendar with customers — they pick a slot",
      "Automatic confirmation + reminder emails",
      "Syncs alongside the main Creative Mojo Calendar",
    ],
  },
];

const BUNDLE_PRICE = 34.99;
const INDIVIDUAL_TOTAL = BOLT_ONS.reduce((s, b) => s + b.price, 0); // £39.80
const BUNDLE_SAVING = Math.round((INDIVIDUAL_TOTAL - BUNDLE_PRICE) * 100) / 100; // £4.81

// Format a GBP price as "9" + "95p" superscript suffix so the
// £9.95 reads as a single, large price block (matches the pattern
// you see on Stripe / OptiSigns pricing pages).
function splitPrice(value) {
  const fixed = value.toFixed(2);
  const [pounds, pence] = fixed.split(".");
  return { pounds, pence };
}

export default function PortalSubscriptionsPage() {
  const ctx = useOutletContext() || {};
  const profile = ctx.profile || {};
  const modules = profile?.profile?.portal_modules || {};
  // Visual-only selection state. Resets on each visit; not persisted.
  const [selected, setSelected] = useState(() => new Set());
  const [bundleSelected, setBundleSelected] = useState(false);

  const toggle = (key) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });

  const totalMonthly = bundleSelected
    ? BUNDLE_PRICE
    : BOLT_ONS.filter((b) => selected.has(b.key)).reduce((s, b) => s + b.price, 0);

  return (
    <div className="space-y-8" data-testid="portal-subscriptions-page">
      <PortalPageHeading
        eyebrow="Account"
        icon={Sparkles}
        title="Subscriptions"
        subtitle="Add optional bolt-ons to your monthly subscription — billed via your existing GoCardless mandate."
      />

      {/* Intro */}
      <div className="bg-white border border-stone-200 rounded-2xl px-6 py-6 sm:px-8 sm:py-7">
        <h2 className="font-display text-2xl sm:text-3xl font-black text-stone-950 tracking-tight">
          Supercharge your franchise with bolt-ons
        </h2>
        <p className="text-stone-600 mt-2 text-sm sm:text-base leading-relaxed max-w-3xl">
          Add any of the optional modules below to your monthly Creative Mojo subscription. Each bolt-on is billed
          monthly via your existing GoCardless mandate and shows up as a separate line on your Xero invoice — cancel any
          time, no minimum term. All prices exclude VAT.
        </p>
      </div>

      {/* Pricing cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-5" data-testid="bolt-ons-grid">
        {BOLT_ONS.map((b) => {
          const active = !!modules[b.key];
          const isSelected = selected.has(b.key) || bundleSelected;
          const Icon = b.icon;
          return (
            <div
              key={b.key}
              data-testid={`bolt-on-${b.key}`}
              className={`relative bg-white border-2 rounded-2xl flex flex-col transition-all ${
                active
                  ? "border-emerald-400 ring-2 ring-emerald-200"
                  : isSelected
                  ? "border-stone-950 shadow-lg"
                  : b.recommended
                  ? "border-stone-300 shadow-md"
                  : "border-stone-200"
              }`}
            >
              {b.recommended && !active && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-1 bg-[#dedd0a] text-stone-950 text-[10px] font-black uppercase tracking-widest rounded-full">
                  Most popular
                </div>
              )}
              {active && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-1 bg-emerald-500 text-white text-[10px] font-black uppercase tracking-widest rounded-full inline-flex items-center gap-1">
                  <CheckCircle2 className="w-3 h-3" /> Active
                </div>
              )}

              {/* Card header — title + icon */}
              <div className="px-5 pt-7 pb-5 flex flex-col items-center text-center border-b border-stone-100">
                <div
                  className="w-14 h-14 rounded-2xl flex items-center justify-center mb-3"
                  style={{ backgroundColor: `${b.accent}1a`, color: b.accent }}
                >
                  <Icon className="w-7 h-7" strokeWidth={2.2} />
                </div>
                <h3 className="font-display text-xl font-black text-stone-950 tracking-tight">{b.title}</h3>
                {b.comingSoon && (
                  <span className="mt-2 inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded-full bg-stone-950 text-[#dedd0a]">
                    <Sparkles className="w-3 h-3" /> Coming soon
                  </span>
                )}
              </div>

              {/* Price */}
              <div className="px-5 py-6 text-center border-b border-stone-100">
                {(() => {
                  const p = splitPrice(b.price);
                  return (
                    <div className="flex items-start justify-center gap-0.5">
                      <span className="text-2xl font-black text-stone-950 mt-2">£</span>
                      <span className="font-display text-6xl font-black text-stone-950 leading-none tracking-tight">{p.pounds}</span>
                      <span className="text-xl font-black text-stone-600 mt-2">.{p.pence}</span>
                    </div>
                  );
                })()}
                <div className="text-xs text-stone-500 mt-2 uppercase tracking-wider font-bold">
                  per month <span className="text-stone-400">+ VAT</span>
                </div>
                <div className="mt-3 text-[11px] text-stone-500 leading-relaxed">{b.blurb}</div>
              </div>

              {/* Feature list */}
              <div className="px-5 py-5 flex-1">
                <ul className="space-y-2.5">
                  {b.features.map((f, i) => (
                    <li key={i} className="flex items-start gap-2.5 text-sm text-stone-700">
                      <span
                        className="w-4 h-4 rounded-full flex items-center justify-center shrink-0 mt-0.5"
                        style={{ backgroundColor: `${b.accent}26`, color: b.accent }}
                      >
                        <Check className="w-3 h-3" strokeWidth={3} />
                      </span>
                      <span className="leading-snug">{f}</span>
                    </li>
                  ))}
                </ul>
              </div>

              {/* Checkbox + Upgrade button */}
              <div className="px-5 pb-5 pt-1 space-y-3">
                <label
                  className={`flex items-center gap-2.5 px-3 py-2.5 border rounded-lg cursor-pointer transition-colors text-sm font-medium ${
                    active
                      ? "bg-emerald-50 border-emerald-200 text-emerald-900 cursor-not-allowed"
                      : bundleSelected
                      ? "bg-stone-100 border-stone-200 text-stone-500 cursor-not-allowed"
                      : isSelected
                      ? "bg-stone-950 text-white border-stone-950"
                      : "bg-stone-50 border-stone-200 text-stone-700 hover:bg-stone-100"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={active || isSelected}
                    disabled={active || bundleSelected}
                    onChange={() => toggle(b.key)}
                    data-testid={`bolt-on-check-${b.key}`}
                    className="w-4 h-4 rounded accent-stone-950"
                  />
                  <span className="select-none">
                    {active ? "Included in your plan"
                      : bundleSelected ? "In bundle"
                      : isSelected ? "Selected"
                      : "Select"}
                  </span>
                </label>
                <button
                  type="button"
                  disabled={active || b.comingSoon}
                  data-testid={`bolt-on-upgrade-${b.key}`}
                  className={`w-full px-4 py-2.5 text-xs font-bold uppercase tracking-wider rounded-lg flex items-center justify-center gap-2 transition-colors ${
                    active
                      ? "bg-stone-100 text-stone-400 cursor-not-allowed"
                      : b.comingSoon
                      ? "bg-stone-100 text-stone-400 cursor-not-allowed"
                      : "bg-[#dedd0a] hover:brightness-95 text-stone-950"
                  }`}
                >
                  {active ? "Already active" : b.comingSoon ? "Notify me" : (
                    <>Upgrade now <ArrowRight className="w-3.5 h-3.5" /></>
                  )}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Bundle deal */}
      <div
        data-testid="bolt-on-bundle"
        className={`relative rounded-2xl p-6 sm:p-8 flex flex-col lg:flex-row items-start lg:items-center gap-6 transition-all ${
          bundleSelected
            ? "bg-stone-950 text-white border-2 border-[#dedd0a] shadow-xl"
            : "bg-gradient-to-br from-stone-950 to-stone-800 text-white border-2 border-stone-800"
        }`}
      >
        <div className="absolute -top-3 left-6 sm:left-8 px-3 py-1 bg-[#dedd0a] text-stone-950 text-[10px] font-black uppercase tracking-widest rounded-full inline-flex items-center gap-1">
          <Package className="w-3 h-3" /> Best value · Save £{BUNDLE_SAVING.toFixed(2)}/mo
        </div>

        <div className="flex-1 min-w-0">
          <h3 className="font-display text-2xl sm:text-3xl font-black tracking-tight">All four bolt-ons</h3>
          <p className="text-stone-300 mt-1.5 text-sm sm:text-base leading-relaxed max-w-2xl">
            Get the full Creative Mojo toolkit — Invoicing, My Territory+, Marketing, and Bookings — bundled together
            and save £{BUNDLE_SAVING.toFixed(2)} every month vs buying them individually.
          </p>
          <div className="flex flex-wrap gap-2 mt-4">
            {BOLT_ONS.map((b) => {
              const Icon = b.icon;
              return (
                <span
                  key={b.key}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-white/10 border border-white/15 rounded-full text-[11px] font-bold uppercase tracking-wider"
                >
                  <Icon className="w-3 h-3" /> {b.title}
                </span>
              );
            })}
          </div>
        </div>

        <div className="shrink-0 lg:text-right">
          <div className="flex items-baseline gap-2 lg:justify-end">
            <span className="text-sm font-bold text-stone-400 line-through">£{INDIVIDUAL_TOTAL.toFixed(2)}</span>
            {(() => {
              const p = splitPrice(BUNDLE_PRICE);
              return (
                <div className="flex items-start gap-0.5">
                  <span className="text-xl font-black mt-1">£</span>
                  <span className="font-display text-5xl sm:text-6xl font-black leading-none tracking-tight">{p.pounds}</span>
                  <span className="text-base font-black text-stone-300 mt-2">.{p.pence}</span>
                </div>
              );
            })()}
          </div>
          <div className="text-[11px] text-stone-400 mt-1.5 uppercase tracking-wider font-bold lg:text-right">
            per month + VAT
          </div>

          <label
            className={`mt-4 flex items-center gap-2.5 px-4 py-3 border rounded-lg cursor-pointer transition-colors text-sm font-medium ${
              bundleSelected
                ? "bg-[#dedd0a] text-stone-950 border-[#dedd0a]"
                : "bg-white/10 text-white border-white/20 hover:bg-white/15"
            }`}
          >
            <input
              type="checkbox"
              checked={bundleSelected}
              onChange={() => {
                setBundleSelected((v) => !v);
                if (!bundleSelected) setSelected(new Set());
              }}
              data-testid="bolt-on-bundle-check"
              className="w-4 h-4 rounded accent-stone-950"
            />
            <span className="select-none">
              {bundleSelected ? "Bundle selected" : "Select the full bundle"}
            </span>
          </label>
        </div>
      </div>

      {/* Footer / summary bar */}
      <div className="bg-stone-100 border border-stone-200 rounded-2xl px-5 sm:px-7 py-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4" data-testid="subs-summary-bar">
        <div className="text-sm text-stone-600 leading-relaxed max-w-2xl">
          Charged via your existing GoCardless mandate. Each bolt-on appears as a separate line on your next Xero invoice.
          Cancel any bolt-on at the end of any month, no minimum term.
        </div>
        <div className="flex items-center gap-4 shrink-0">
          <div className="text-right">
            <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">Selected total</div>
            <div className="font-display text-3xl font-black tracking-tight text-stone-950" data-testid="subs-total">
              £{totalMonthly.toFixed(2)} <span className="text-sm text-stone-500 font-bold">/ month + VAT</span>
            </div>
          </div>
          <button
            type="button"
            disabled={totalMonthly === 0}
            data-testid="subs-confirm-upgrade"
            className="px-5 py-3 bg-[#dedd0a] hover:brightness-95 text-stone-950 font-bold text-xs uppercase tracking-wider rounded-lg flex items-center gap-2 disabled:opacity-30 disabled:cursor-not-allowed"
          >
            Confirm upgrade <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}
