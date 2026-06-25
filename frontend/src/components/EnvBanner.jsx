import { useEffect, useState } from "react";
import api from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";

// Production hostname is the only "live" environment. Anything else
// (preview deploys, localhost, the .preview.emergentagent.com domain)
// is dev. Keeping the rule in one place so any future custom domain
// only needs adding here.
const PRODUCTION_HOSTS = ["hub.creativemojo.co.uk"];

function isProductionHost() {
  if (typeof window === "undefined") return false;
  return PRODUCTION_HOSTS.includes(window.location.hostname);
}

function relTime(iso) {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  const diff = Math.max(0, Date.now() - then);
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function fmtAbs(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString("en-GB", {
      day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
    });
  } catch { return iso; }
}

// Bottom-right env badge. Pulsed red on production, calm green on
// preview/dev. Click to expand → shows backend started_at + version so
// you can verify a deploy actually landed.
export default function EnvBanner() {
  const [info, setInfo] = useState(null);
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(Date.now());
  const isProd = isProductionHost();
  const { user } = useAuth();

  // Admin-only badge. Franchisees should never see a "PRODUCTION
  // deployed Xh ago" pill — it leaks dev-affordances and on mobile it
  // covers Save/Cancel CTAs at the bottom of edit modals.
  const isAdmin = (user?.role === "admin");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data } = await api.get("/system/info");
        if (!cancelled) setInfo(data);
      } catch { /* ignore — banner still shows env label */ }
    })();
    // Refresh the relative-time label every minute so "2m ago" ticks
    // up on long-open sessions.
    const t = setInterval(() => setNow(Date.now()), 60000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  // Touch ``now`` so eslint doesn't flag the unused state — the timer
  // re-renders the component which recomputes ``relTime`` below.
  void now;

  if (!isAdmin) return null;

  const label = isProd ? "PRODUCTION" : "PREVIEW";
  const baseCls = isProd
    ? "bg-red-600 hover:bg-red-700 text-white shadow-red-900/30"
    : "bg-emerald-600 hover:bg-emerald-700 text-white shadow-emerald-900/30";
  const dotCls = isProd ? "bg-red-300 animate-pulse" : "bg-emerald-300";

  return (
    <div
      data-testid="env-banner"
      data-env={isProd ? "prod" : "preview"}
      // Pinned to bottom-LEFT (not right) so the banner never sits on
      // top of modal Save/Send buttons — every modal in this app puts
      // its primary action on the right side of its footer.
      className="fixed bottom-3 left-3 z-[9999] select-none"
      style={{ pointerEvents: "auto" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-[10px] font-bold uppercase tracking-[0.2em] shadow-lg transition-colors ${baseCls}`}
        data-testid="env-banner-pill">
        <span className={`inline-block w-1.5 h-1.5 rounded-full ${dotCls}`} />
        {label}
        {info?.started_at && (
          <span className="font-medium normal-case tracking-normal opacity-90 ml-1">
            · deployed {relTime(info.started_at)}
          </span>
        )}
      </button>
      {open && info && (
        <div
          className="mt-2 w-72 p-3 rounded-xl bg-stone-950 text-stone-100 text-xs shadow-2xl border border-stone-800"
          data-testid="env-banner-details">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-400">Environment</span>
            <span className={`font-bold ${isProd ? "text-red-300" : "text-emerald-300"}`}>{label}</span>
          </div>
          <div className="space-y-1.5 font-mono">
            <Row k="Host" v={typeof window !== "undefined" ? window.location.hostname : ""} />
            <Row k="Deployed" v={fmtAbs(info.started_at)} />
            <Row k="Up for" v={relTime(info.started_at)} />
            <Row k="Version" v={info.version || "—"} />
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ k, v }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-stone-500">{k}</span>
      <span className="text-stone-100 truncate text-right">{v}</span>
    </div>
  );
}
