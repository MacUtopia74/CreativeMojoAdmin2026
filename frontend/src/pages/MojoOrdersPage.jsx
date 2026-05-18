// Mojo Orders — embeds the legacy admin (admin.creativemojo.co.uk) that
// takes WooCommerce orders and pushes them into the bespoke order tool.
// Lives inside our sidebar shell as an iframe so the user doesn't have
// to context-switch between two browser tabs.
//
// Sign-in is independent — the user logs into the legacy admin once per
// session inside the iframe (it has its own auth). No SSO bridge.
import { useRef, useState } from "react";
import {
  ShoppingBag, ExternalLink, RefreshCw, AlertCircle, Maximize2, Minimize2,
} from "lucide-react";

const LEGACY_URL = "https://admin.creativemojo.co.uk/";

export default function MojoOrdersPage() {
  const iframeRef = useRef(null);
  const [reloading, setReloading] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  // Used to force a full iframe remount (cheap reload that drops any
  // accumulated cookies/state inside the legacy admin).
  const [key, setKey] = useState(0);

  const reload = () => {
    setReloading(true);
    setKey((k) => k + 1);
    // The new iframe instance fires its onLoad in a moment; this is just
    // a UI breadcrumb to show the user we're doing something.
    setTimeout(() => setReloading(false), 1500);
  };

  return (
    <div
      className={`flex flex-col ${fullscreen ? "fixed inset-0 z-50 bg-white" : "min-h-screen"} bg-stone-50`}
      data-testid="mojo-orders-page"
    >
      {/* Topbar — keeps us oriented inside the wrapper, gives the user a
          quick path back to the real legacy admin in case the iframe
          misbehaves (popups, downloads, file pickers). */}
      <div className={`bg-white border-b border-stone-200 ${fullscreen ? "px-6" : "px-8"} py-4 flex items-center justify-between gap-4 flex-wrap`}>
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-10 h-10 rounded-lg bg-stone-950 flex items-center justify-center shrink-0">
            <ShoppingBag className="w-5 h-5 text-[#D4FF00]" />
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
            title="Reload"
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
          <a
            href={LEGACY_URL}
            target="_blank"
            rel="noreferrer"
            data-testid="mojo-orders-open-new"
            className="px-3 py-2 text-xs font-bold uppercase tracking-wider bg-stone-950 hover:bg-stone-800 text-white rounded-lg flex items-center gap-1.5"
          >
            <ExternalLink className="w-3.5 h-3.5" />
            Open in new tab
          </a>
        </div>
      </div>

      {/* Friendly hint above the iframe — set expectations about it
          being a separate sign-in. Quiet enough to disappear once the
          user has signed in. */}
      <div className={`px-${fullscreen ? "6" : "8"} pt-3`} style={{ paddingLeft: fullscreen ? 24 : 32, paddingRight: fullscreen ? 24 : 32 }}>
        <div className="text-[11px] text-stone-500 inline-flex items-center gap-1.5 px-3 py-1.5 bg-amber-50 border border-amber-200 rounded-lg">
          <AlertCircle className="w-3 h-3 text-amber-700" />
          You'll need to sign in separately the first time — this is the legacy WooCommerce bridge with its own credentials.
        </div>
      </div>

      {/* The iframe itself. allow="..." needs to be permissive enough for
          downloads (CSV exports), camera/mic NOT needed, clipboard for
          copy-paste of order IDs. */}
      <div className={`flex-1 ${fullscreen ? "p-4" : "p-6"} pt-3`}>
        <div className="w-full h-full bg-white border border-stone-300 rounded-2xl overflow-hidden shadow-sm">
          <iframe
            key={key}
            ref={iframeRef}
            src={LEGACY_URL}
            title="Mojo Orders — Legacy Admin"
            data-testid="mojo-orders-iframe"
            className="w-full h-full block"
            style={{ minHeight: fullscreen ? "calc(100vh - 160px)" : "calc(100vh - 240px)" }}
            // Sandbox kept loose because the legacy admin is our own
            // first-party site; we trust it. Removing sandbox entirely
            // also avoids breaking any same-origin cookies the legacy app
            // sets for sign-in persistence.
            allow="clipboard-write; clipboard-read; downloads"
            referrerPolicy="no-referrer-when-downgrade"
          />
        </div>
      </div>
    </div>
  );
}
