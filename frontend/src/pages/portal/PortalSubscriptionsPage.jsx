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
//   Every bolt-on is £10 / month INC VAT. Two automatic bundle tiers
//   kick in when the franchisee selects multiple:
//     • Any 3 bolt-ons  →  £25 / month inc VAT  (saves £5)
//     • All 4 bolt-ons  →  £35 / month inc VAT  (saves £5)
// Billed monthly via the franchisee's existing GoCardless mandate
// (added as recurring lines to their Xero invoice on admin approval).
const BOLT_ONS = [
  {
    key: "invoicing",
    title: "Invoicing",
    icon: Receipt,
    price: 10,
    accent: "#10b981",
    blurb: "Issue, send and reconcile your own customer invoices — linked to your contacts list.",
    features: [
      "Create, save and send invoices from inside the portal",
      "Linked to your customer contacts",
      "Branded invoice PDFs with your franchise details",
      "Add tax rates and discount rates",
      "Save / download as PDF in one click",
    ],
  },
  {
    key: "territory_plus",
    title: "My Territory+",
    icon: MapPin,
    price: 10,
    accent: "#0ea5e9",
    recommended: true,
    blurb: "Claim customers as yours, plot them on the map, and run a light CRM on top.",
    features: [
      "“Claim” a client as yours and drop a marker on the map",
      "Add unlimited contacts of your own to your territory",
      "Basic CRM — notes, statuses, follow-up reminders",
      "Edit existing CQC database client info",
      "Group by care home group within your territory",
    ],
  },
  {
    key: "marketing",
    title: "Marketing",
    icon: Megaphone,
    price: 10,
    accent: "#f97316",
    blurb: "Send branded e-shots to your own customers from inside the portal.",
    features: [
      "Build basic e-shots with our drag-in templates",
      "Drop in images, headlines and your own copy",
      "Or link straight to your Bookings booking page (bookings bolt-on required)",
      "Auto-co-branded with your franchise details",
    ],
  },
  {
    key: "bookings",
    title: "Bookings",
    icon: CalendarClock,
    price: 10,
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

// Tiered bundle pricing — automatically applied based on how many
// bolt-ons the franchisee ticks. Index = count selected.
const BUNDLE_PRICES = {
  0: 0,
  1: 10,
  2: 20,  // no bundle discount yet
  3: 25,  // "Pick any 3" bundle — saves £5
  4: 35,  // "All four" bundle — saves £5
};
const SINGLE_PRICE = 10;

export default function PortalSubscriptionsPage() {
  const ctx = useOutletContext() || {};
  const profile = ctx.profile || {};
  const modules = profile?.profile?.portal_modules || {};
  // Visual-only selection state. Resets on each visit; not persisted.
  const [selected, setSelected] = useState(() => new Set());

  const toggle = (key) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });

  const selectedCount = selected.size;
  const totalMonthly = BUNDLE_PRICES[selectedCount] || 0;
  // Saving = what they'd pay at the single-price rate (£10 each)
  // minus what the bundle tier actually charges. Only meaningful for
  // counts >= 3 (where the bundle discount actually kicks in).
  const savingThisTier = Math.max(0, selectedCount * SINGLE_PRICE - totalMonthly);

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
          Add any of the optional modules below to your monthly Creative Mojo subscription. Each bolt-on is just £10 a
          month — pick any three for £25 or grab all four for £35. Billed via your existing GoCardless mandate and
          appears as a separate line on your Xero invoice. Cancel any time, no minimum term. All prices include VAT.
        </p>
        {/* Bundle ladder — shows the franchisee the tier discounts at a glance. */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-5" data-testid="subs-bundle-ladder">
          <TierBadge label="1 bolt-on"    price="£10" active={selectedCount === 1} />
          <TierBadge label="2 bolt-ons"   price="£20" active={selectedCount === 2} />
          <TierBadge label="Any 3 (save £5)" price="£25" active={selectedCount === 3} highlight />
          <TierBadge label="All 4 (save £5)" price="£35" active={selectedCount === 4} highlight />
        </div>
      </div>

      {/* Pricing cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-5" data-testid="bolt-ons-grid">
        {BOLT_ONS.map((b) => {
          const active = !!modules[b.key];
          const isSelected = selected.has(b.key);
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
                <div className="flex items-start justify-center gap-0.5">
                  <span className="text-2xl font-black text-stone-950 mt-2">£</span>
                  <span className="font-display text-6xl font-black text-stone-950 leading-none tracking-tight">{b.price}</span>
                </div>
                <div className="text-xs text-stone-500 mt-2 uppercase tracking-wider font-bold">
                  per month <span className="text-stone-400">inc VAT</span>
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
                      : isSelected
                      ? "bg-stone-950 text-white border-stone-950"
                      : "bg-stone-50 border-stone-200 text-stone-700 hover:bg-stone-100"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={active || isSelected}
                    disabled={active}
                    onChange={() => toggle(b.key)}
                    data-testid={`bolt-on-check-${b.key}`}
                    className="w-4 h-4 rounded accent-stone-950"
                  />
                  <span className="select-none">
                    {active ? "Included in your plan"
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

      {/* Dynamic pricing summary — bundle discounts kick in automatically
          as soon as the franchisee ticks 3 or 4 bolt-ons. */}
      <div
        data-testid="bolt-on-bundle"
        className="relative rounded-2xl p-6 sm:p-8 flex flex-col lg:flex-row items-start lg:items-center gap-6 bg-gradient-to-br from-stone-950 to-stone-800 text-white border-2 border-stone-800"
      >
        {selectedCount >= 3 && (
          <div className="absolute -top-3 left-6 sm:left-8 px-3 py-1 bg-[#dedd0a] text-stone-950 text-[10px] font-black uppercase tracking-widest rounded-full inline-flex items-center gap-1">
            <Package className="w-3 h-3" /> Bundle applied · Save £{savingThisTier}/mo
          </div>
        )}

        <div className="flex-1 min-w-0">
          <h3 className="font-display text-2xl sm:text-3xl font-black tracking-tight">
            {selectedCount === 0 ? "Build your bundle" :
              selectedCount === 4 ? "All four bolt-ons unlocked" :
              selectedCount === 3 ? "3-bolt-on bundle unlocked" :
              `${selectedCount} bolt-on${selectedCount > 1 ? "s" : ""} selected`}
          </h3>
          <p className="text-stone-300 mt-1.5 text-sm sm:text-base leading-relaxed max-w-2xl">
            {selectedCount === 0
              ? "Tick any of the bolt-ons above. Pick any three for £25 a month or grab all four for £35 — discounts apply automatically."
              : selectedCount === 1
              ? "Add two more bolt-ons to unlock our £25 bundle (any 3) or all four for £35 — discounts apply automatically."
              : selectedCount === 2
              ? "Add one more to unlock the 3-bolt-on bundle at £25 a month — save £5."
              : selectedCount === 3
              ? "Nice — add the fourth bolt-on for just £10 more and we'll lock in the £35 all-four bundle."
              : "You've selected the full Creative Mojo toolkit at the best price we offer."}
          </p>
          <div className="flex flex-wrap gap-2 mt-4">
            {BOLT_ONS.map((b) => {
              const Icon = b.icon;
              const on = selected.has(b.key) || !!modules[b.key];
              return (
                <span
                  key={b.key}
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1 border rounded-full text-[11px] font-bold uppercase tracking-wider ${
                    on
                      ? "bg-[#dedd0a] border-[#dedd0a] text-stone-950"
                      : "bg-white/10 border-white/15 text-white/70"
                  }`}
                >
                  <Icon className="w-3 h-3" /> {b.title}
                </span>
              );
            })}
          </div>
        </div>

        <div className="shrink-0 lg:text-right">
          <div className="flex items-baseline gap-2 lg:justify-end">
            {savingThisTier > 0 && (
              <span className="text-sm font-bold text-stone-400 line-through">£{selectedCount * SINGLE_PRICE}</span>
            )}
            <div className="flex items-start gap-0.5">
              <span className="text-xl font-black mt-1">£</span>
              <span className="font-display text-5xl sm:text-6xl font-black leading-none tracking-tight">{totalMonthly}</span>
            </div>
          </div>
          <div className="text-[11px] text-stone-400 mt-1.5 uppercase tracking-wider font-bold lg:text-right">
            per month inc VAT
          </div>
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
              £{totalMonthly} <span className="text-sm text-stone-500 font-bold">/ month inc VAT</span>
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

// Small tier-badge for the bundle ladder. Glows when its row matches
// the franchisee's current selection count.
function TierBadge({ label, price, active, highlight }) {
  return (
    <div
      data-testid={`tier-badge-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
      className={`px-3 py-2 rounded-lg border text-center transition-all ${
        active
          ? "bg-stone-950 text-white border-stone-950 shadow-md"
          : highlight
          ? "bg-[#dedd0a]/15 border-[#dedd0a]/60 text-stone-800"
          : "bg-stone-50 border-stone-200 text-stone-700"
      }`}
    >
      <div className="font-display text-lg font-black leading-none">{price}</div>
      <div className={`text-[10px] uppercase tracking-wider font-bold mt-1 ${active ? "text-stone-300" : "text-stone-500"}`}>{label}</div>
    </div>
  );
}
