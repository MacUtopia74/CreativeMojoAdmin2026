// Lead Temperature auto-badge — sits on the contact drawer next to
// the manual Flame picker. Calls /contacts/:id/temperature and shows
// a colored chip with the computed score + band + breakdown tooltip.
//
// Intentionally read-only — the manual TemperaturePicker stays in
// charge of Sandra's gut-feel grading. This auto-score is the data
// signal she can cross-reference against her own intuition.
import { useEffect, useState } from "react";
import { Flame, Snowflake, Sun, Loader2 } from "lucide-react";
import api from "@/lib/api";

const BANDS = {
  hot:  { label: "Hot",  icon: Flame,     ring: "border-orange-300", bg: "bg-orange-50",  text: "text-orange-700" },
  warm: { label: "Warm", icon: Sun,       ring: "border-amber-300",  bg: "bg-amber-50",   text: "text-amber-700"  },
  cold: { label: "Cold", icon: Snowflake, ring: "border-sky-300",    bg: "bg-sky-50",     text: "text-sky-700"    },
};

export default function LeadTemperatureBadge({ contactId, refreshSignal = 0 }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!contactId) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const { data } = await api.get(`/contacts/${contactId}/temperature`);
        if (!cancelled) setData(data);
      } catch {
        // Silent — the manual flame picker is the user's primary grading
        // signal; the auto-score is supplementary.
      } finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [contactId, refreshSignal]);

  if (loading && !data) {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-white border border-stone-200 text-stone-500 text-[10px]" data-testid="lead-temp-loading">
        <Loader2 className="w-3 h-3 animate-spin" /> AUTO
      </span>
    );
  }
  if (!data) return null;

  const band = BANDS[data.band] || BANDS.cold;
  const Ic = band.icon;
  const tooltip = (data.details || [])
    .map((d) => `${d.label}: ${d.count} × ${d.weight} (cap ${d.max})`)
    .concat([`Score: ${data.score} → ${band.label}`])
    .join("\n");

  return (
    <span
      title={tooltip}
      data-testid={`lead-temp-badge-${data.band}`}
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md border ${band.ring} ${band.bg}`}
    >
      <Ic className={`w-3.5 h-3.5 ${band.text}`} strokeWidth={2} />
      <span className={`text-[10px] font-bold uppercase tracking-wider ${band.text}`}>
        {band.label} · {data.score}
      </span>
      <span className="text-[8px] uppercase tracking-wider text-stone-400 ml-0.5">AUTO</span>
    </span>
  );
}
