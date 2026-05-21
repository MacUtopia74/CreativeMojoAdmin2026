// Mojo Orders — wrapper for the legacy WooCommerce admin
// (https://admin.creativemojo.co.uk/).
//
// Honest reality: the legacy admin runs Laravel with `SameSite=Lax`
// session cookies, so signing in INSIDE this iframe fails with a 419
// (CSRF mismatch) — browsers won't send the cookie on a cross-origin
// iframe POST. That's a browser-level security policy we can't bypass
// from here.
//
// So the page is structured as a "launcher first, preview second":
//   • Big primary CTA: "Open Mojo Orders" → new tab (sign-in works there).
//   • Below it: an embedded preview iframe so users on browsers with
//     third-party cookies enabled (or after first opening in a new tab to
//     warm their session) can still browse without leaving our app.
//   • If we detect repeated iframe reloads in a short window (= user is
//     stuck on the login screen), we surface a yellow nudge toast
//     pointing them at the big button.
import { useEffect, useRef, useState } from "react";
import {
  ShoppingBag, ExternalLink, RefreshCw, AlertCircle, Maximize2, Minimize2,
  Info,
} from "lucide-react";

const LEGACY_URL = "https://admin.creativemojo.co.uk/";

export default function MojoOrdersPage() {
  const iframeRef = useRef(null);
  const loadStampsRef = useRef([]);  // recent onLoad timestamps
  const [reloading, setReloading] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [showStuckHint, setShowStuckHint] = useState(false);
  const [key, setKey] = useState(0);  // force iframe remount

  const reload = () => {
    setReloading(true);
    loadStampsRef.current = []; setShowStuckHint(false);
    setKey((k) => k + 1);
    setTimeout(() => setReloading(false), 1500);
  };

  // The iframe's onLoad fires on every navigation, even cross-origin.
  // We can't read the URL, but we CAN count how often it reloads — three
  // navigations within ~25s strongly suggests the user is bouncing
  // between login → 419 → login. That's our cue to nudge them toward
  // the "Open in new tab" button.
  const onIframeLoad = () => {
    const now = Date.now();
    loadStampsRef.current = [...loadStampsRef.current, now].filter(
      (t) => now - t < 25_000
    );
    if (loadStampsRef.current.length >= 3) {
      setShowStuckHint(true);
    }
  };

  // Auto-hide the nudge after 12s so it's not permanently in the way.
  useEffect(() => {
    if (!showStuckHint) return;
    const t = setTimeout(() => setShowStuckHint(false), 12_000);
    return () => clearTimeout(t);
  }, [showStuckHint]);

  return (
    <div
      className={`flex flex-col ${fullscreen ? "fixed inset-0 z-50 bg-white" : "min-h-screen"} bg-stone-50`}
      data-testid="mojo-orders-page"
    >
      {/* Topbar — brand strip + always-available actions */}
      <div className={`bg-white border-b border-stone-200 ${fullscreen ? "px-6" : "px-8"} py-4 flex items-center justify-between gap-4 flex-wrap`}>
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-10 h-10 rounded-lg bg-stone-950 flex items-center justify-center shrink-0">
            <ShoppingBag className="w-5 h-5 text-[#dddd16]" />
          </div>
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-500">
              Legacy · WooCommerce Bridge
            </div>
            <h1 className="font-display text-2xl text-stone-950 truncate">
              Mojo Orders
            </h1>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="hidden md:inline-flex items-center text-xs text-stone-500 font-mono px-2 py-1 bg-stone-100 rounded">
            {LEGACY_URL}
          </span>
          <button
            onClick={reload}
            disabled={reloading}
            data-testid="mojo-orders-reload"
            title="Reload preview"
            className="px-3 py-2 text-xs font-bold uppercase tracking-wider border border-stone-300 bg-white text-stone-700 hover:bg-stone-50 rounded-lg flex items-center gap-1.5 disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${reloading ? "animate-spin" : ""}`} />
            Reload
          </button>
          <button
            onClick={() => setFullscreen((v) => !v)}
            data-testid="mojo-orders-fullscreen"
            title={fullscreen ? "Exit fullscreen" : "Fullscreen"}
            className="px-3 py-2 text-xs font-bold uppercase tracking-wider border border-stone-300 bg-white text-stone-700 hover:bg-stone-50 rounded-lg flex items-center gap-1.5"
          >
            {fullscreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
            {fullscreen ? "Exit" : "Fullscreen"}
          </button>
        </div>
      </div>

      <div className={`${fullscreen ? "p-4" : "p-8 pt-6"} flex-1 flex flex-col gap-4`}>
        {/* Primary CTA — launcher card. Most reliable way to use the legacy
            admin given the cookie restrictions; sign-in works perfectly
            in a real new tab. */}
        <div className="bg-stone-950 text-white rounded-2xl p-6 flex items-center gap-5 flex-wrap shadow-sm" data-testid="mojo-orders-launcher">
          <div className="w-12 h-12 rounded-xl bg-[#dddd16] flex items-center justify-center shrink-0">
            <ShoppingBag className="w-6 h-6 text-stone-950" />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="font-display text-2xl">Open Mojo Orders in a new tab</h2>
            <p className="text-sm text-stone-300 mt-1">
              Sign-in works reliably in a real browser tab — the embedded
              preview below can hit a 419 error because the legacy admin's
              session cookies block cross-site framing.
            </p>
          </div>
          <a
            href={LEGACY_URL}
            target="_blank"
            rel="noreferrer"
            data-testid="mojo-orders-open-new"
            className="px-5 py-3 text-sm font-bold uppercase tracking-wider bg-[#dddd16] hover:bg-[#aaaa11] text-stone-950 rounded-xl flex items-center gap-2 shrink-0"
          >
            <ExternalLink className="w-4 h-4" />
            Open Mojo Orders
          </a>
        </div>

        {/* Friendly explainer + cookie info — collapses to a small chip */}
        <div className="flex items-start gap-2 text-[11px] text-stone-600 px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg">
          <Info className="w-3.5 h-3.5 text-amber-700 shrink-0 mt-0.5" />
          <span>
            <strong>Why the new tab?</strong> The legacy admin uses
            <code className="mx-1 px-1 bg-amber-100 rounded">SameSite=Lax</code> session cookies.
            Browsers refuse to send them on a cross-origin iframe POST,
            which causes the
            <code className="mx-1 px-1 bg-amber-100 rounded">419 Page Expired</code> error
            when you try to sign in inside the preview below. Use the
            <strong> Open Mojo Orders</strong> button above to sign in;
            the preview is here for read-only viewing once your session
            is warm (or on browsers with third-party cookies enabled).
          </span>
        </div>

        {/* Embedded preview iframe — secondary use case, useful for read-
            only viewing if the user has signed in via the new tab and
            their browser carries the cookie through (Chrome with 3PC,
            Firefox in strict-tracking-off mode, etc). */}
        <div className="flex-1 bg-white border border-stone-300 rounded-2xl overflow-hidden shadow-sm relative">
          {showStuckHint && (
            <div
              data-testid="mojo-orders-stuck-hint"
              className="absolute top-3 right-3 z-10 px-4 py-3 bg-amber-100 border-2 border-amber-400 rounded-xl shadow-lg max-w-sm flex items-start gap-2"
            >
              <AlertCircle className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
              <div className="text-xs text-amber-900">
                <strong>Stuck on sign-in?</strong> That's the 419 cookie
                issue.{" "}
                <a href={LEGACY_URL} target="_blank" rel="noreferrer" className="underline font-bold">
                  Open Mojo Orders in a new tab
                </a>{" "}
                instead — it'll work there.
              </div>
            </div>
          )}
          <iframe
            key={key}
            ref={iframeRef}
            src={LEGACY_URL}
            title="Mojo Orders — Legacy Admin (preview)"
            data-testid="mojo-orders-iframe"
            onLoad={onIframeLoad}
            className="w-full h-full block"
            style={{ minHeight: fullscreen ? "calc(100vh - 280px)" : "calc(100vh - 360px)" }}
            allow="clipboard-write; clipboard-read; downloads"
            referrerPolicy="no-referrer-when-downgrade"
          />
        </div>
      </div>
    </div>
  );
}
