// Small version pill for the sidebar footer (admin + portal). Shows
// the env label (PROD/PREV) and the pretty version string
// ``v{MAJOR}.{SEQ}.{D}.{M}.{YY}.{HH}.{MM}`` so HQ can pin down which
// deploy an issue relates to without hunting through git history.
//
// Click to expand → shows the full backend info (boot timestamp, uptime,
// build hash) which is handy when Paul needs to confirm a redeploy
// actually landed.
import { useEffect, useState } from "react";
import api from "@/lib/api";

const PRODUCTION_HOSTS = ["hub.creativemojo.co.uk"];
const isProductionHost = () => {
  if (typeof window === "undefined") return false;
  return PRODUCTION_HOSTS.includes(window.location.hostname);
};

function relTime(iso) {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const diff = Math.max(0, (Date.now() - then) / 1000);
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export default function SidebarVersionPill() {
  const [info, setInfo] = useState(null);
  const [open, setOpen] = useState(false);
  const isProd = isProductionHost();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data } = await api.get("/system/info");
        if (!cancelled) setInfo(data);
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, []);

  const label = isProd ? "PROD" : "PREV";
  const dotCls = isProd ? "bg-red-500" : "bg-emerald-500";

  return (
    <div className="px-2 pt-2 select-none" data-testid="sidebar-version">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-1.5 text-[9px] font-mono text-stone-500 hover:text-stone-900 transition-colors"
        title={info?.pretty_version || ""}
        data-testid="sidebar-version-pill"
      >
        <span className={`inline-block w-1.5 h-1.5 rounded-full ${dotCls} flex-shrink-0`} />
        <span className="tracking-tight font-bold">{label}</span>
        <span className="truncate">{info?.pretty_version || "loading…"}</span>
      </button>
      {open && info && (
        <div className="mt-1.5 p-2 rounded-md bg-stone-950 text-stone-100 text-[10px] font-mono space-y-1"
             data-testid="sidebar-version-details">
          <div className="flex justify-between"><span className="text-stone-500">Env</span><span className={isProd ? "text-red-300" : "text-emerald-300"}>{isProd ? "PRODUCTION" : "PREVIEW"}</span></div>
          <div className="flex justify-between"><span className="text-stone-500">Version</span><span>{info.pretty_version}</span></div>
          <div className="flex justify-between"><span className="text-stone-500">Deployed</span><span>{relTime(info.started_at)}</span></div>
          <div className="flex justify-between"><span className="text-stone-500">Build</span><span className="truncate ml-2">{(info.version || "").slice(0, 10)}</span></div>
        </div>
      )}
    </div>
  );
}
