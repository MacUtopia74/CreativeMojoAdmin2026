// Portal — Subscriptions.
//
// Live bolt-on selection + checkout. Franchisee ticks a card →
// confirmation modal explains the DD-mandate / invoice-line payment
// mechanism → POST to /portal/subscriptions/request → HQ sees it in the
// admin queue and approves; the matching ``portal_modules.<key>`` flag
// then flips automatically on the franchisee record.
import { useState, useEffect, useCallback, useMemo } from "react";
import { useOutletContext } from "react-router-dom";
import {
  Sparkles, MapPin, Megaphone, Receipt, CalendarClock,
  CheckCircle2, Check, ArrowRight, Package, X, Loader2,
  AlertCircle, Clock,
} from "lucide-react";
import api from "@/lib/api";
import PortalPageHeading from "@/components/portal/PortalPageHeading";

// PRICING — confirmed by Paul:
//   Every bolt-on is £9 / month INC VAT. Tiered bundles kick in
//   automatically when multiple are selected:
//     • Any 1  →  £9  / month  (single bolt-on, no bundle saving)
//     • Any 2  →  £16 / month  (saves £2)
//     • Any 3  →  £22 / month  (saves £5)
//     • All 4  →  £27 / month  (saves £9)
// Billed monthly via the franchisee's existing GoCardless mandate
// (added as recurring lines to their Xero invoice on admin approval).
const BOLT_ONS = [
  {
    key: "territory_plus",
    title: "My Territory+",
    icon: MapPin,
    price: 9,
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
    key: "invoicing",
    title: "Invoicing+",
    icon: Receipt,
    price: 9,
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
    key: "marketing",
    title: "Marketing+",
    icon: Megaphone,
    price: 9,
    accent: "#f97316",
    blurb: "Send branded e-shots to your own customers from inside the portal.",
    features: [
      "Build basic e-shots with our drag-in templates",
      "Drop in images, headlines and your own copy",
      "Or link straight to your Bookings+ booking page (Bookings+ required)",
      "Auto-co-branded with your franchise details",
    ],
  },
  {
    key: "bookings",
    title: "Bookings+",
    icon: CalendarClock,
    price: 9,
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
// bolt-ons the franchisee ticks. Index = count selected. Bundles
// increment by £5 each step so the perceived value of "add another
// bolt-on" stays consistent across tiers.
//   • 1 bolt-on  → £9/mo  (single, no bundle saving)
//   • 2 bolt-ons → £16/mo (saves £2 vs. 2×£9)
//   • 3 bolt-ons → £22/mo (saves £5 vs. 3×£9)
//   • 4 bolt-ons → £27/mo (saves £9 vs. 4×£9) — "All four" bundle
const BUNDLE_PRICES = {
  0: 0,
  1: 9,
  2: 16,
  3: 22,
  4: 27,
};
const SINGLE_PRICE = 9;

export default function PortalSubscriptionsPage() {
  const ctx = useOutletContext() || {};
  const profile = ctx.profile || {};
  const tags = profile?.profile?.tags || [];
  const isDemo = tags.some((t) => String(t).trim().toLowerCase() === "demo");
  // Real franchisees: render the bolt-ons they actually own as ACTIVE
  // (so the page shows their current plan). Demo: pretend nothing is
  // enabled so visitors can click each bolt-on and see the "Build
  // your bundle" total tick up from £9 → £16 → £22 → £27 live.
  const realModules = profile?.profile?.portal_modules || {};
  const modules = isDemo ? {} : realModules;
  // Visual-only selection state. Resets on each visit; not persisted.
  const [selected, setSelected] = useState(() => new Set());

  // Pending requests already in flight — render a Clock pill on the
  // card and disable the upgrade button so the franchisee can't fire
  // off duplicates while HQ is processing.
  const [pendingKeys, setPendingKeys] = useState(() => new Set());
  const [pendingLoaded, setPendingLoaded] = useState(false);

  // Confirmation modal state. ``payload`` may be a single addon key or
  // an array of keys when the franchisee uses the bulk "Confirm
  // upgrade" footer button.
  const [confirmFor, setConfirmFor] = useState(null);   // string | string[] | null
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState("");
  const [toast, setToast] = useState("");

  const loadPending = useCallback(async () => {
    try {
      const { data } = await api.get("/portal/subscriptions/requests");
      const keys = new Set(
        (data.requests || [])
          .filter((r) => r.status === "pending" && r.action === "enable")
          .map((r) => r.addon),
      );
      setPendingKeys(keys);
    } catch (err) {
      // Empty pending state is the safe fallback — but log so dev
      // tooling surfaces the network error rather than burying it.
      console.error("Failed to load pending subscription requests:", err);
    }
    finally { setPendingLoaded(true); }
  }, []);
  useEffect(() => { loadPending(); }, [loadPending]);

  // When a franchisee tries to add Invoicing+, Marketing+ or
  // Bookings+ without Territory+ already selected (or already
  // active), we surface a popup explaining the dependency. They can
  // then confirm and we'll auto-add Territory+ alongside their
  // requested module so the bundle is internally consistent.
  const [dependencyPrompt, setDependencyPrompt] = useState(null); // { addonKey, addonTitle }

  const toggle = (key) => {
    if (pendingKeys.has(key) || modules[key]) return; // can't reselect
    // Deselecting is always allowed.
    if (selected.has(key)) {
      setSelected((prev) => {
        const next = new Set(prev);
        next.delete(key);
        // Cascade: if Territory+ is being removed, drop any dependent
        // bolt-ons too so the selection stays internally consistent.
        if (key === "territory_plus") {
          ["invoicing", "marketing", "bookings"].forEach((k) => next.delete(k));
        }
        return next;
      });
      return;
    }
    // Adding a "needs Territory+" module without Territory+? Prompt.
    const NEEDS_TERRITORY = new Set(["invoicing", "marketing", "bookings"]);
    if (NEEDS_TERRITORY.has(key) && !selected.has("territory_plus") && !modules.territory_plus) {
      const meta = BOLT_ONS.find((b) => b.key === key);
      setDependencyPrompt({ addonKey: key, addonTitle: meta?.title || key });
      return;
    }
    setSelected((prev) => {
      const next = new Set(prev);
      next.add(key);
      return next;
    });
  };

  // Called from the popup's "Add both" button — bundles Territory+
  // with the originally-requested addon in one go.
  const acceptDependencyPrompt = () => {
    if (!dependencyPrompt) return;
    setSelected((prev) => {
      const next = new Set(prev);
      next.add("territory_plus");
      next.add(dependencyPrompt.addonKey);
      return next;
    });
    setDependencyPrompt(null);
  };

  const selectedCount = selected.size;
  const totalMonthly = BUNDLE_PRICES[selectedCount] || 0;
  // Saving = single-price total vs the bundle tier we're charging.
  const savingThisTier = Math.max(0, selectedCount * SINGLE_PRICE - totalMonthly);

  const submitRequests = async (addons) => {
    setConfirming(true); setConfirmError("");
    try {
      // POST one request per addon — sequential is fine, the endpoint
      // is cheap and the franchisee only ever picks at most four.
      const results = await Promise.all(
        addons.map((addon) =>
          api.post("/portal/subscriptions/request", { addon, action: "enable" }),
        ),
      );
      const ok = results.every((r) => r.data?.ok);
      if (!ok) throw new Error("Some requests failed.");
      setPendingKeys((s) => {
        const n = new Set(s);
        addons.forEach((a) => n.add(a));
        return n;
      });
      setSelected(new Set());
      setConfirmFor(null);
      setToast(
        addons.length === 1
          ? `${BOLT_ONS.find((b) => b.key === addons[0])?.title} request sent — HQ will activate it within 1 working day.`
          : `Request sent for ${addons.length} bolt-ons — HQ will activate them within 1 working day.`,
      );
      setTimeout(() => setToast(""), 6000);
    } catch (e) {
      setConfirmError(e?.response?.data?.detail || "Couldn't send your request — please try again or email HQ.");
    } finally { setConfirming(false); }
  };

  // ``confirmFor`` is normalised to an array for the modal renderer.
  const confirmAddons = useMemo(
    () => (Array.isArray(confirmFor) ? confirmFor : confirmFor ? [confirmFor] : []),
    [confirmFor],
  );
  const confirmTotal = confirmAddons.length
    ? (BUNDLE_PRICES[confirmAddons.length] || confirmAddons.length * SINGLE_PRICE)
    : 0;

  return (
    <div className="space-y-8 relative" data-testid="portal-subscriptions-page">
      <PortalPageHeading
        eyebrow="Account"
        icon={Sparkles}
        title="Subscriptions"
        subtitle="Add optional bolt-ons to your monthly subscription — billed via your existing GoCardless mandate."
      />

      {/* Promo roundel — pinned to the top-right of the whole page and
          pulled upward so it visually overlaps the yellow divider under
          the page heading, closing the dead space above the intro card.
          On narrow screens it drops into the intro card below.       */}
      <div className="hidden lg:block absolute top-0 right-0 -translate-y-10 z-20 pointer-events-none">
        <div className="pointer-events-auto">
          <PromoRoundel />
        </div>
      </div>

      {/* Intro */}
      <div className="bg-white border border-stone-200 rounded-2xl px-6 py-6 sm:px-8 sm:py-7">
        <h2 className="font-display text-2xl sm:text-3xl font-black text-stone-950 tracking-tight">
          Supercharge your franchise with bolt-ons
        </h2>
        <p className="mt-3 text-stone-600 text-sm sm:text-base leading-relaxed lg:max-w-[68%]">
          Add any of the optional modules below to your monthly Creative Mojo subscription. Each bolt-on is just £9 a
          month — pick any two for £16, any three for £22, or grab all four for £27. Billed via your existing
          GoCardless mandate and appears as a separate line on your Xero invoice. Cancel any time, no minimum term.
          All prices include VAT.
        </p>
        {/* Narrow-screen fallback — roundel stacks under the paragraph
            since the absolute-positioned version above is lg:block. */}
        <div className="mt-5 flex justify-center lg:hidden">
          <PromoRoundel />
        </div>
        {/* Bundle ladder — shows the franchisee the tier discounts at
            a glance. Wrapped in a heavier, Mojo-lime-tinted panel with
            its own header so it can't be mistaken for the page intro;
            the tiles inside step up in scale + intensity so the eye
            naturally lands on "All 4 — best saving". */}
        <div
          className="mt-6 p-4 sm:p-5 rounded-2xl border-2 border-[#dddd16] bg-[#dddd16]/10 shadow-sm"
          data-testid="subs-bundle-ladder-wrap"
        >
          <div className="flex items-baseline justify-between gap-3 flex-wrap mb-3">
            <div>
              <div className="text-[10px] uppercase tracking-[0.25em] font-bold text-stone-600">
                Bundle pricing
              </div>
              <div className="font-display text-xl sm:text-2xl font-black text-stone-950 leading-tight">
                The more you add, the more you save
              </div>
            </div>
            <div className="text-xs font-bold text-stone-700 px-2.5 py-1 bg-white border border-stone-300 rounded-full">
              All prices /month, inc VAT
            </div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-3" data-testid="subs-bundle-ladder">
            <TierBadge label="Any 1"             price="£9"  active={selectedCount === 1} />
            <TierBadge label="Any 2 — save £2"   price="£16" active={selectedCount === 2} highlight />
            <TierBadge label="Any 3 — save £5"   price="£22" active={selectedCount === 3} highlight />
            <TierBadge label="All 4 — save £9"   price="£27" active={selectedCount === 4} highlight bestValue />
          </div>
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
              {b.recommended && !active && !pendingKeys.has(b.key) && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-1 bg-[#dedd0a] text-stone-950 text-[10px] font-black uppercase tracking-widest rounded-full">
                  Most popular
                </div>
              )}
              {active && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-1 bg-emerald-500 text-white text-[10px] font-black uppercase tracking-widest rounded-full inline-flex items-center gap-1">
                  <CheckCircle2 className="w-3 h-3" /> Active
                </div>
              )}
              {!active && pendingKeys.has(b.key) && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-1 bg-amber-500 text-white text-[10px] font-black uppercase tracking-widest rounded-full inline-flex items-center gap-1" data-testid={`bolt-on-pending-${b.key}`}>
                  <Clock className="w-3 h-3" /> Pending activation
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

              {/* Price — £10 sits dead-centre in the card with the
                  "PER MONTH / INC VAT" caption directly underneath.
                  The previous side-by-side layout was pushing the £10
                  off-centre because the caption took horizontal space
                  to the right; stacking solves it without making the
                  card any taller (the caption text is tiny). */}
              <div className="px-5 py-3 border-b border-stone-100 text-center">
                <div className="font-display text-4xl sm:text-5xl font-black text-stone-950 leading-none tracking-tight">
                  £{b.price}
                </div>
                <div className="text-[10px] text-stone-500 uppercase tracking-wider font-bold leading-tight mt-2">
                  Per month<br />inc VAT
                </div>
              </div>

              {/* Feature list */}
              <div className="px-5 py-5 flex-1">
                <ul className="space-y-2.5">
                  {b.features.map((f) => (
                    <li key={f} className="flex items-start gap-2.5 text-sm text-stone-700">
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
              ? "Tick any of the bolt-ons above. Pick any three for £22 a month or grab all four for £27 — discounts apply automatically."
              : selectedCount === 1
              ? "Add two more bolt-ons to unlock our £22 bundle (any 3) or all four for £27 — discounts apply automatically."
              : selectedCount === 2
              ? "Add one more to unlock the 3-bolt-on bundle at £22 a month — save £5."
              : selectedCount === 3
              ? "Nice — add the fourth bolt-on for just £5 more and we'll lock in the £27 all-four bundle."
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
            onClick={() => setConfirmFor(Array.from(selected))}
            data-testid="subs-confirm-upgrade"
            className="px-5 py-3 bg-[#dedd0a] hover:brightness-95 text-stone-950 font-bold text-xs uppercase tracking-wider rounded-lg flex items-center gap-2 disabled:opacity-30 disabled:cursor-not-allowed"
          >
            Confirm upgrade <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
      {/* Toast for "request sent" success */}
      {toast && (
        <div
          className="fixed bottom-6 right-6 z-50 max-w-sm bg-emerald-50 border border-emerald-300 text-emerald-900 px-4 py-3 rounded-xl shadow-lg flex items-start gap-2"
          data-testid="subs-toast"
        >
          <CheckCircle2 className="w-5 h-5 shrink-0 mt-0.5" />
          <div className="text-sm leading-relaxed">{toast}</div>
        </div>
      )}

      {/* Confirmation modal — single source of truth for explaining the
          DD-mandate payment mechanism so the franchisee has no
          surprises later. */}
      {/* Dependency prompt — when the franchisee tries to add
          Invoicing+ / Marketing+ / Bookings+ without Territory+ in
          the basket, this explains the dependency and offers to
          bundle Territory+ in for them. Cancel just leaves their
          selection untouched. */}
      {dependencyPrompt && (
        <div
          onClick={() => setDependencyPrompt(null)}
          className="fixed inset-0 z-[130] bg-stone-950/60 backdrop-blur-sm flex items-center justify-center p-4"
          data-testid="subs-dependency-modal"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-white rounded-2xl shadow-2xl max-w-md w-full overflow-hidden"
          >
            <div className="px-5 py-3 flex items-center justify-between border-b border-stone-200 bg-[#0ea5e9] text-white">
              <div className="font-display text-xl font-black flex items-center gap-2">
                <MapPin className="w-5 h-5" />
                My Territory+ required
              </div>
              <button
                onClick={() => setDependencyPrompt(null)}
                className="p-1.5 hover:bg-white/15 rounded-lg"
                data-testid="subs-dependency-close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="px-6 py-5 space-y-4 text-sm text-stone-700 leading-relaxed">
              <p>
                <strong>{dependencyPrompt.addonTitle}</strong> sits on top of <strong>My Territory+</strong> —
                it&apos;s the bolt-on that holds your claimed customers, your map markers and your CRM data,
                which the other modules read from.
              </p>
              <p>
                You&apos;ll need <strong>My Territory+</strong> first before adding any other module. Would
                you like to add both together? At this size, your bundle becomes <strong>£16 / month
                (Any 2)</strong> — a £2 saving versus buying them individually.
              </p>
              <div className="flex flex-col-reverse sm:flex-row gap-2 justify-end pt-2">
                <button
                  onClick={() => setDependencyPrompt(null)}
                  data-testid="subs-dependency-cancel"
                  className="px-4 py-2 text-sm font-bold uppercase tracking-wider border border-stone-300 hover:bg-stone-50 rounded-lg"
                >
                  Cancel
                </button>
                <button
                  onClick={acceptDependencyPrompt}
                  data-testid="subs-dependency-accept"
                  className="px-4 py-2 text-sm font-bold uppercase tracking-wider bg-stone-950 hover:bg-stone-800 text-[#dddd16] rounded-lg"
                >
                  Add both — £15 / month
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {confirmAddons.length > 0 && (
        <div
          onClick={() => !confirming && setConfirmFor(null)}
          className="fixed inset-0 z-[120] bg-stone-950/60 backdrop-blur-sm flex items-center justify-center p-4"
          data-testid="subs-confirm-modal"
        >
          <div onClick={(e) => e.stopPropagation()} className="bg-white rounded-2xl shadow-2xl max-w-lg w-full overflow-hidden">
            <div className="px-5 py-3 flex items-center justify-between border-b border-stone-200 bg-[#dedd0a]">
              <div className="font-display text-xl font-black text-stone-950">Confirm your upgrade</div>
              <button onClick={() => !confirming && setConfirmFor(null)} className="p-1.5 hover:bg-stone-950/10 rounded-lg" data-testid="subs-confirm-close">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="px-6 py-5 space-y-4">
              <p className="text-sm text-stone-700 leading-relaxed">
                You&apos;re adding the following bolt-on{confirmAddons.length === 1 ? "" : "s"} to your Creative Mojo subscription:
              </p>
              <ul className="space-y-2" data-testid="subs-confirm-list">
                {confirmAddons.map((k) => {
                  const b = BOLT_ONS.find((x) => x.key === k);
                  if (!b) return null;
                  const Icon = b.icon;
                  return (
                    <li key={k} className="flex items-center gap-3 px-3 py-2 rounded-lg bg-stone-50 border border-stone-200">
                      <span
                        className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
                        style={{ backgroundColor: `${b.accent}1a`, color: b.accent }}
                      >
                        <Icon className="w-4 h-4" />
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="font-semibold text-stone-900 text-sm">{b.title}</div>
                        <div className="text-xs text-stone-500">{b.blurb}</div>
                      </div>
                    </li>
                  );
                })}
              </ul>

              <div className="bg-stone-100 border border-stone-200 rounded-xl px-4 py-3 text-sm leading-relaxed text-stone-800">
                <div className="flex items-baseline justify-between gap-3 mb-1">
                  <span className="font-bold">Total added to your monthly bill</span>
                  <span className="font-display text-2xl font-black text-stone-950" data-testid="subs-confirm-total">
                    £{confirmTotal}
                    <span className="text-xs text-stone-500 font-bold ml-1">/ month inc VAT</span>
                  </span>
                </div>
                <p className="text-xs text-stone-600">
                  Payment will be taken via your <strong>existing GoCardless Direct Debit mandate</strong> as
                  a <strong>separate invoice line on your next Xero invoice</strong>. No new payment details
                  needed. Cancel any bolt-on at the end of any month — no minimum term.
                </p>
              </div>

              <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-xs text-amber-900 flex items-start gap-2">
                <Clock className="w-4 h-4 shrink-0 mt-0.5" />
                <span>
                  HQ activates new bolt-ons within <strong>1 working day</strong>. You&apos;ll get a confirmation
                  email and the module will appear in your sidebar automatically.
                </span>
              </div>

              {confirmError && (
                <div className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2 flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{confirmError}</span>
                </div>
              )}
            </div>
            <div className="px-6 py-4 bg-stone-50 border-t border-stone-200 flex items-center justify-end gap-2">
              <button
                onClick={() => setConfirmFor(null)}
                disabled={confirming}
                data-testid="subs-confirm-cancel"
                className="px-4 py-2 text-xs font-bold uppercase tracking-wider border border-stone-300 hover:bg-white text-stone-700 rounded-lg disabled:opacity-50"
              >
                Not yet
              </button>
              <button
                onClick={() => submitRequests(confirmAddons)}
                disabled={confirming}
                data-testid="subs-confirm-submit"
                className="px-5 py-2 text-xs font-bold uppercase tracking-wider bg-stone-950 hover:bg-stone-800 text-[#dedd0a] rounded-lg flex items-center gap-2 disabled:opacity-50"
              >
                {confirming ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                {confirming ? "Sending…" : `Send request${confirmAddons.length > 1 ? "s" : ""} to HQ`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
function TierBadge({ label, price, active, highlight, bestValue }) {
  return (
    <div
      data-testid={`tier-badge-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
      className={`relative px-3 py-4 rounded-xl border-2 text-center transition-all ${
        active
          ? "bg-stone-950 text-white border-stone-950 shadow-lg scale-[1.04]"
          : bestValue
          ? "bg-white border-stone-900 shadow-md"
          : highlight
          ? "bg-white border-[#dddd16] shadow-sm"
          : "bg-white border-stone-300"
      }`}
    >
      {bestValue && (
        <span
          className={`absolute -top-2.5 left-1/2 -translate-x-1/2 px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.15em] rounded-full shadow-sm ${
            active ? "bg-[#dddd16] text-stone-950" : "bg-stone-950 text-[#dddd16]"
          }`}
          data-testid="tier-badge-best-value"
        >
          Best value
        </span>
      )}
      <div className={`font-display text-2xl sm:text-3xl font-black leading-none ${active ? "text-white" : "text-stone-950"}`}>
        {price}
      </div>
      <div
        className={`text-[10px] sm:text-[11px] uppercase tracking-wider font-bold mt-2 ${
          active ? "text-stone-200" : "text-stone-700"
        }`}
      >
        {label}
      </div>
    </div>
  );
}

// 60-day launch-promo roundel pinned to the top-right of the page.
// Designed to read at a glance: brand-yellow circle, headline + body,
// with "60 days at no cost" punched out inside a dark pill so it's the
// piece the eye lands on first. Sits in the page header row, stacks
// below the heading on narrow screens.
function PromoRoundel() {
  return (
    <div
      data-testid="subs-promo-roundel"
      className="shrink-0"
      aria-label="60-day launch offer"
    >
      <div
        className="relative w-[260px] h-[260px] sm:w-[290px] sm:h-[290px] rounded-full flex items-center justify-center text-center px-7 sm:px-8 shadow-xl ring-1 ring-stone-900/10 -rotate-2 hover:rotate-0 transition-transform duration-300"
        style={{ background: "radial-gradient(circle at 30% 25%, #f5f316 0%, #dddd16 55%, #c9c811 100%)" }}
      >
        {/* subtle sparkle accent in the corner */}
        <Sparkles className="absolute top-5 right-6 w-4 h-4 text-stone-900/40" strokeWidth={2.5} />
        <Sparkles className="absolute bottom-7 left-5 w-3 h-3 text-stone-900/30" strokeWidth={2.5} />
        <div className="flex flex-col items-center gap-2">
          <div className="font-display text-[15px] sm:text-base font-black uppercase tracking-wide text-stone-950 leading-tight">
            A Little Extra<br />from Us!
          </div>
          <div className="text-[12px] sm:text-[13px] leading-snug text-stone-800 max-w-[210px]">
            To celebrate the launch of the new Franchise Portal, every franchisee gets full access to all advanced modules for
          </div>
          <div className="px-2.5 py-1 rounded-full bg-stone-950 text-[#dddd16] text-[11px] sm:text-xs font-black uppercase tracking-wider shadow">
            60 days at no cost
          </div>
          <div className="text-[12px] sm:text-[13px] leading-snug text-stone-800 max-w-[210px]">
            Explore the features, then simply keep the modules you love.
          </div>
        </div>
      </div>
    </div>
  );
}
