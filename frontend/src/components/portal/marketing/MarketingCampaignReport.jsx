// Per-campaign report modal — pulls the full campaign doc and shows
// each recipient's open/click timeline plus rolled-up totals.
import { useEffect, useState } from "react";
import api from "@/lib/api";
import {
  X, Loader2, Mail, MailOpen, MousePointerClick, AlertCircle, Clock,
  CheckCircle2,
} from "lucide-react";

function fmtRel(iso) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    const diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return "just now";
    if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
    return d.toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  } catch { return iso; }
}

export default function MarketingCampaignReport({ campaignId, onClose }) {
  const [campaign, setCampaign] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!campaignId) { setCampaign(null); return; }
    setLoading(true);
    api.get(`/portal/marketing/campaigns/${campaignId}`)
      .then(({ data }) => setCampaign(data))
      .catch(() => setCampaign(null))
      .finally(() => setLoading(false));
  }, [campaignId]);

  if (!campaignId) return null;

  const totalSent = (campaign?.recipients || []).filter((r) => r.status !== "failed").length;
  const totalOpened = (campaign?.recipients || []).filter(
    (r) => (r.events || []).some((e) => e.type === "opened" || e.type === "open"),
  ).length;
  const totalClicked = (campaign?.recipients || []).filter(
    (r) => (r.events || []).some((e) => e.type === "clicked" || e.type === "click"),
  ).length;

  return (
    <div
      className="fixed inset-0 z-[70] bg-stone-950/50 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
      data-testid="marketing-report-modal"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-white rounded-2xl shadow-2xl max-w-2xl w-full overflow-hidden flex flex-col max-h-[92vh]"
      >
        <div className="px-5 py-3 border-b border-stone-200 flex items-center justify-between">
          <div>
            <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-700">Campaign Report</div>
            <div className="text-sm font-semibold text-stone-900 mt-0.5 truncate">
              {campaign?.title || "—"}
            </div>
          </div>
          <button onClick={onClose} data-testid="marketing-report-close" className="w-9 h-9 flex items-center justify-center hover:bg-stone-100 rounded-lg">
            <X className="w-4 h-4" />
          </button>
        </div>

        {loading || !campaign ? (
          <div className="flex items-center justify-center min-h-[200px] text-stone-500">
            <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading…
          </div>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-3 p-5">
              <StatTile icon={Mail} label="Sent" value={totalSent} color="stone" />
              <StatTile icon={MailOpen} label="Opened" value={totalOpened} color="emerald" />
              <StatTile icon={MousePointerClick} label="Clicked" value={totalClicked} color="blue" />
            </div>
            <div className="px-5 pb-4 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-700 flex items-center gap-1.5">
              Per recipient
            </div>
            <ul className="divide-y divide-stone-100 px-5 pb-5 overflow-y-auto" data-testid="marketing-report-recipients">
              {(campaign.recipients || []).map((r, i) => {
                const opened = (r.events || []).find((e) => e.type === "opened" || e.type === "open");
                const clicked = (r.events || []).find((e) => e.type === "clicked" || e.type === "click");
                const bounced = (r.events || []).find((e) => e.type === "bounced" || e.type === "complained");
                return (
                  <li key={`${r.send_id || i}`} className="py-3" data-testid={`marketing-report-row-${i}`}>
                    <div className="flex items-center justify-between gap-3 flex-wrap">
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-stone-900 truncate">
                          {r.first_name || r.name} <span className="text-stone-400 font-normal">— {r.email}</span>
                        </div>
                        <div className="text-[11px] text-stone-500 truncate">
                          {r.name} · {r.role}
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        {r.status === "failed" ? (
                          <Badge tone="red" icon={AlertCircle}>Failed</Badge>
                        ) : bounced ? (
                          <Badge tone="red" icon={AlertCircle}>{bounced.type}</Badge>
                        ) : (
                          <>
                            <Badge tone="stone" icon={CheckCircle2}>Sent {fmtRel(r.sent_at)}</Badge>
                            {opened && <Badge tone="emerald" icon={MailOpen}>Opened {fmtRel(opened.at)}</Badge>}
                            {clicked && <Badge tone="blue" icon={MousePointerClick}>Clicked {fmtRel(clicked.at)}</Badge>}
                            {!opened && !clicked && !bounced && (
                              <Badge tone="amber" icon={Clock}>No opens yet</Badge>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
              {(campaign.recipients || []).length === 0 && (
                <li className="py-6 text-center text-sm text-stone-500">No recipients on this campaign.</li>
              )}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}

function StatTile({ icon: Icon, label, value, color }) {
  const palette = {
    stone:   "bg-stone-50 text-stone-700 border-stone-200",
    emerald: "bg-emerald-50 text-emerald-800 border-emerald-200",
    blue:    "bg-blue-50 text-blue-800 border-blue-200",
  };
  return (
    <div className={`rounded-xl border px-4 py-3 ${palette[color] || palette.stone}`}>
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.2em] font-bold opacity-70">
        <Icon className="w-3 h-3" /> {label}
      </div>
      <div className="text-2xl font-display font-black mt-1">{value}</div>
    </div>
  );
}

function Badge({ tone, icon: Icon, children }) {
  const palette = {
    stone:   "bg-stone-100 text-stone-700 border-stone-200",
    emerald: "bg-emerald-100 text-emerald-900 border-emerald-300",
    blue:    "bg-blue-100 text-blue-900 border-blue-300",
    amber:   "bg-amber-100 text-amber-900 border-amber-300",
    red:     "bg-red-100 text-red-900 border-red-300",
  };
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded border ${palette[tone] || palette.stone}`}>
      <Icon className="w-3 h-3" /> {children}
    </span>
  );
}
