// Tiny "new version available" banner — appears at the top of the
// portal layout the moment the backend reports a different build
// version than the one that was live when the page was first loaded.
//
// How it works:
//   1. On mount we fetch /api/version and stash that as `seenVersion`.
//      This is the build the franchisee was loaded against.
//   2. Every 90s — and any time the tab regains focus — we re-fetch
//      /api/version. If the value differs from `seenVersion`, the
//      banner slides into view with a Reload Now button.
//   3. Clicking Reload triggers a full reload (window.location.reload)
//      so the browser pulls the fresh JS/CSS bundles instead of
//      hitting stale cached files.
//
// We deliberately swallow network errors silently — if /version is
// unreachable for a few polls (Wi-Fi blip, deploy in flight) we just
// keep showing whatever banner state we had. We DON'T flash the
// banner on first load, only when a version change is detected.
import { useEffect, useRef, useState } from "react";
import { RefreshCw, Sparkles, X } from "lucide-react";
import api from "@/lib/api";

const POLL_INTERVAL_MS = 90_000; // 90 seconds — quiet enough not to spam, quick enough to surface within ~2 min

export default function PortalNewVersionBanner() {
  // null  = haven't fetched the baseline yet
  // string = the version we were loaded against
  const seenVersionRef = useRef(null);
  const [hasUpdate, setHasUpdate] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let pollTimer = null;

    const fetchOnce = async () => {
      try {
        const { data } = await api.get("/version");
        const v = data?.version;
        if (!v || cancelled) return;
        if (seenVersionRef.current == null) {
          seenVersionRef.current = v; // baseline set — never flash on first load
        } else if (v !== seenVersionRef.current) {
          // Backend redeployed since we loaded. Tell the user.
          setHasUpdate(true);
        }
      } catch (e) {
        // Network blip / unauthenticated public endpoint should still
        // 200 — but if it doesn't, just skip this tick.
        console.debug("[NewVersionBanner] /version fetch failed", e);
      }
    };

    fetchOnce();
    pollTimer = setInterval(fetchOnce, POLL_INTERVAL_MS);
    // Also recheck whenever the tab becomes visible again — a
    // franchisee who left the tab open overnight will get the prompt
    // first thing in the morning even if their poll happened to skip.
    const onVisible = () => { if (document.visibilityState === "visible") fetchOnce(); };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      clearInterval(pollTimer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  if (!hasUpdate || dismissed) return null;

  return (
    <div
      data-testid="portal-new-version-banner"
      className="sticky top-0 z-[80] w-full bg-stone-950 text-[#dddd16] border-b-2 border-[#dddd16] shadow-md"
      role="status"
      aria-live="polite"
    >
      <div className="max-w-screen-2xl mx-auto px-4 sm:px-6 py-2 flex items-center gap-3 flex-wrap">
        <Sparkles className="w-4 h-4 shrink-0" />
        <span className="text-sm font-semibold flex-1 min-w-[12rem]">
          A new version of the Mojo Hub is ready — refresh to load the latest improvements.
        </span>
        <button
          type="button"
          onClick={() => window.location.reload()}
          data-testid="portal-new-version-reload"
          className="inline-flex items-center gap-2 px-3 py-1.5 text-xs font-bold uppercase tracking-wider bg-[#dddd16] text-stone-950 hover:bg-[#c2c213] rounded-md transition-colors"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Refresh now
        </button>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          data-testid="portal-new-version-dismiss"
          aria-label="Dismiss notification"
          className="p-1.5 hover:bg-stone-800 rounded-md text-stone-400 hover:text-stone-200"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
