// "New version available" banner with AUTO-refresh countdown.
//
// Behaviour:
//   1. On mount fetch /api/version → that's the baseline build we
//      were loaded against.
//   2. Poll /api/version every 90s + on tab focus. If the value
//      changes, we know a redeploy shipped.
//   3. Show the banner. Start a 30-second countdown to auto-reload.
//      During the countdown:
//        • REFRESH NOW button → reload immediately.
//        • SNOOZE button     → cancel the auto-reload; banner stays
//          visible with a manual REFRESH NOW so the user can still
//          opt in when they're ready.
//        • If the user is actively typing in an input/textarea OR has
//          a modal/dialog open OR has touched the keyboard in the
//          last 5 seconds — the countdown PAUSES and shows "waiting
//          for you to finish…" instead of forcing a reload that would
//          discard work in progress.
//   4. At t=0 → window.location.reload() — browser pulls the fresh
//      JS/CSS bundles so the user is on the new build immediately.
//
// Originally franchisees were ignoring the manual "Refresh now" button
// for hours; the auto-countdown closes that gap without trashing
// in-flight forms.
import { useEffect, useRef, useState, useCallback } from "react";
import { RefreshCw, Sparkles, X, Pause } from "lucide-react";
import api from "@/lib/api";

const POLL_INTERVAL_MS = 90_000;          // 90s — quiet enough not to spam
const AUTO_REFRESH_SECONDS = 30;          // generous so the user can act
const IDLE_AFTER_KEYSTROKE_MS = 5_000;    // pause if they've typed recently

function isInteractingNow() {
  // Pause auto-refresh whenever a text-entry element is focused — these
  // are the cases where a reload would cost the user work.
  if (typeof document === "undefined") return false;
  const a = document.activeElement;
  if (a) {
    const tag = (a.tagName || "").toUpperCase();
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    if (a.getAttribute && a.getAttribute("contenteditable") === "true") return true;
  }
  // Pause when a modal/dialog is mounted.
  if (document.querySelector('[role="dialog"]')) return true;
  return false;
}

export default function PortalNewVersionBanner() {
  const seenVersionRef = useRef(null);
  const lastKeystrokeRef = useRef(0);
  const [hasUpdate, setHasUpdate] = useState(false);
  const [snoozed, setSnoozed] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(AUTO_REFRESH_SECONDS);
  const [paused, setPaused] = useState(false);

  // ---------- /version poller ----------
  useEffect(() => {
    let cancelled = false;
    let pollTimer = null;

    const fetchOnce = async () => {
      try {
        const { data } = await api.get("/version");
        const v = data?.version;
        if (!v || cancelled) return;
        if (seenVersionRef.current == null) {
          seenVersionRef.current = v;
        } else if (v !== seenVersionRef.current) {
          setHasUpdate(true);
        }
      } catch (e) {
        // Network blip — skip.
      }
    };

    fetchOnce();
    pollTimer = setInterval(fetchOnce, POLL_INTERVAL_MS);
    const onVisible = () => { if (document.visibilityState === "visible") fetchOnce(); };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      clearInterval(pollTimer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  // ---------- keystroke tracker for idle detection ----------
  useEffect(() => {
    const tick = () => { lastKeystrokeRef.current = Date.now(); };
    window.addEventListener("keydown", tick, { passive: true });
    return () => window.removeEventListener("keydown", tick);
  }, []);

  const reloadNow = useCallback(() => {
    if (typeof window !== "undefined") window.location.reload();
  }, []);

  // ---------- auto-refresh countdown ----------
  useEffect(() => {
    if (!hasUpdate || snoozed) return undefined;
    setSecondsLeft(AUTO_REFRESH_SECONDS);

    const id = setInterval(() => {
      const recentKeystroke = (Date.now() - lastKeystrokeRef.current) < IDLE_AFTER_KEYSTROKE_MS;
      const busy = isInteractingNow() || recentKeystroke;
      setPaused(busy);
      if (busy) return; // don't tick while user is working

      setSecondsLeft((s) => {
        if (s <= 1) {
          clearInterval(id);
          reloadNow();
          return 0;
        }
        return s - 1;
      });
    }, 1000);

    return () => clearInterval(id);
  }, [hasUpdate, snoozed, reloadNow]);

  if (!hasUpdate) return null;

  return (
    <div
      data-testid="portal-new-version-banner"
      className="sticky top-0 z-[80] w-full bg-stone-950 text-[#dddd16] border-b-2 border-[#dddd16] shadow-md"
      role="status"
      aria-live="polite"
    >
      <div className="max-w-screen-2xl mx-auto px-4 sm:px-6 py-2 flex items-center gap-3 flex-wrap">
        <Sparkles className="w-4 h-4 shrink-0" />
        <div className="flex-1 min-w-[14rem]">
          <div className="text-sm font-semibold">
            A new version of the Mojo Hub is ready.
          </div>
          {!snoozed && (
            <div className="text-[11px] text-[#dddd16]/80">
              {paused ? (
                <span className="inline-flex items-center gap-1">
                  <Pause className="w-3 h-3" /> Waiting for you to finish — refreshing automatically once you stop typing.
                </span>
              ) : (
                <>Auto-refreshing in <span data-testid="autorefresh-countdown" className="font-bold tabular-nums">{secondsLeft}s</span></>
              )}
            </div>
          )}
          {snoozed && (
            <div className="text-[11px] text-[#dddd16]/80">
              Auto-refresh paused — click Refresh now when you&apos;re ready.
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={reloadNow}
          data-testid="portal-new-version-reload"
          className="inline-flex items-center gap-2 px-3 py-1.5 text-xs font-bold uppercase tracking-wider bg-[#dddd16] text-stone-950 hover:bg-[#c2c213] rounded-md transition-colors"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Refresh now
        </button>
        {!snoozed && (
          <button
            type="button"
            onClick={() => setSnoozed(true)}
            data-testid="portal-new-version-snooze"
            title="Cancel auto-refresh — I'll refresh manually when I'm ready"
            className="px-3 py-1.5 text-xs font-bold uppercase tracking-wider border border-[#dddd16]/40 text-[#dddd16] hover:bg-stone-800 rounded-md transition-colors"
          >
            Not yet
          </button>
        )}
        <button
          type="button"
          onClick={() => setHasUpdate(false)}
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
