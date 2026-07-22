// CareHomeEnquiriesOverlay
// ---------------------------------------------------------------------------
// Toggle + date-filter bar + compact list that overlays care-home-enquiry
// pins on the *existing* Territory Map (no second map instance — saves
// Mapbox credits). Used in two places:
//
//   • Admin  → FranchiseeDetailPage territory panel (mode="admin")
//              Endpoint: /api/contacts/map?source=care_home_enquiry&franchisee_id=<fid>
//   • Portal → PortalTerritoryPage (Territory+) (mode="portal")
//              Endpoint: /api/portal/territory-plus/care-home-enquiries
//              (server-scopes to the current franchisee via auth token)
//
// The overlay itself does not render the map. It's a wrapper that fetches
// pins based on toggle + date-preset state and hands them back to a
// render-prop child so the caller can pass ``extraPins`` down to whichever
// TerritoryMap instance sits inside their layout.
// ---------------------------------------------------------------------------
import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Home, Mail, Phone } from "lucide-react";
import api from "@/lib/api";
import { formatDate } from "@/lib/date";

export default function CareHomeEnquiriesOverlay({
  mode = "admin",
  franchiseeId = null, // required when mode==="admin"
  labelOn = "Hide Care Home Enquiries",
  labelOff = "Show Care Home Enquiries in this area",
  emptyLabel = "No care home enquiries in this territory for the selected date range.",
  children,
}) {
  const [enabled, setEnabled] = useState(false);
  const [preset, setPreset] = useState("12m");
  const [custom, setCustom] = useState({ from: "", to: "" });
  const [pins, setPins] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [hoverId, setHoverId] = useState(null);

  const range = useMemo(() => {
    if (preset === "all") return { from: "", to: "" };
    if (preset === "custom") return { from: custom.from || "", to: custom.to || "" };
    const today = new Date();
    const iso = (d) => d.toISOString().slice(0, 10);
    const back = preset === "12m" ? 365 : 30;
    const from = new Date(today);
    from.setDate(from.getDate() - back);
    return { from: iso(from), to: iso(today) };
  }, [preset, custom]);

  useEffect(() => {
    if (!enabled) { setPins([]); return; }
    if (mode === "admin" && !franchiseeId) return;
    let alive = true;
    setLoading(true); setError("");
    (async () => {
      try {
        const params = {};
        if (range.from) params.date_from = range.from;
        if (range.to) params.date_to = range.to;
        let url;
        if (mode === "portal") {
          url = "/portal/territory-plus/care-home-enquiries";
        } else {
          url = "/contacts/map";
          params.source = "care_home_enquiry";
          params.franchisee_id = franchiseeId;
        }
        const { data } = await api.get(url, { params });
        if (!alive) return;
        setPins(data.pins || []);
      } catch (e) {
        if (alive) setError(e?.response?.data?.detail || "Could not load care home enquiries.");
      } finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
  }, [enabled, mode, franchiseeId, range.from, range.to]);

  const extraPins = useMemo(
    () => pins.map((p) => ({
      id: p.id,
      lat: p.lat,
      lng: p.lng,
      color: "#0d9488",
      label: p.establishment_name || p.name || "Care home enquiry",
    })),
    [pins],
  );

  return (
    <div className="space-y-4">
      {/* Toggle + date filter bar */}
      <div className="border border-stone-200 bg-stone-50/60 rounded-xl p-3 space-y-2">
        <div className="flex flex-wrap items-center gap-2 justify-between">
          <button
            onClick={() => setEnabled((v) => !v)}
            data-testid="care-home-overlay-toggle"
            className={`px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider rounded-lg border flex items-center gap-1.5 transition ${
              enabled
                ? "bg-teal-600 text-white border-teal-700 hover:bg-teal-700"
                : "bg-white text-stone-700 border-stone-300 hover:bg-stone-50"
            }`}>
            <Home className="w-3.5 h-3.5" />
            {enabled ? labelOn : labelOff}
          </button>
          {enabled && (
            <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 tabular-nums" data-testid="care-home-overlay-count">
              {loading ? "Loading…" : `${pins.length} enquir${pins.length === 1 ? "y" : "ies"} plotted`}
            </div>
          )}
        </div>
        {enabled && (
          <>
            <div className="flex items-center gap-1.5 flex-wrap">
              {[
                { p: "30d", label: "Last 30d" },
                { p: "12m", label: "Last 12m" },
                { p: "custom", label: "Custom…" },
                { p: "all", label: "All time" },
              ].map((o) => (
                <button
                  key={o.p}
                  onClick={() => setPreset(o.p)}
                  data-testid={`care-home-overlay-preset-${o.p}`}
                  className={`px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider rounded-md border ${
                    preset === o.p
                      ? "bg-stone-950 text-white border-stone-950"
                      : "bg-white text-stone-700 border-stone-300 hover:bg-stone-50"
                  }`}>
                  {o.label}
                </button>
              ))}
            </div>
            {preset === "custom" && (
              <div className="flex items-center gap-2 flex-wrap text-xs" data-testid="care-home-overlay-custom">
                <label className="flex items-center gap-1 text-stone-600">
                  From
                  <input type="date" value={custom.from} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))}
                    data-testid="care-home-overlay-from"
                    className="px-2 py-1 border border-stone-300 rounded text-xs" />
                </label>
                <label className="flex items-center gap-1 text-stone-600">
                  To
                  <input type="date" value={custom.to} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))}
                    data-testid="care-home-overlay-to"
                    className="px-2 py-1 border border-stone-300 rounded text-xs" />
                </label>
              </div>
            )}
          </>
        )}
      </div>

      {/* Consumer renders the map (and passes extraPins + hover state through). */}
      {typeof children === "function"
        ? children({ extraPins: enabled ? extraPins : null, hoverId, setHoverId, enabled })
        : children}

      {/* Enquiry list */}
      {enabled && (
        <div className="border border-stone-200 rounded-xl overflow-hidden bg-white" data-testid="care-home-overlay-list">
          {error ? (
            <div className="text-xs text-red-700 bg-red-50 border-b border-red-200 px-3 py-2 flex items-center gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5" /> {error}
            </div>
          ) : pins.length === 0 ? (
            <div className="text-xs text-stone-500 text-center py-6">
              {loading ? "Loading enquiries…" : (
                <>
                  {emptyLabel}
                  {preset !== "all" && (
                    <div className="mt-1.5">
                      <button
                        onClick={() => setPreset("all")}
                        data-testid="care-home-overlay-try-all-time"
                        className="underline text-stone-700 hover:text-stone-950 font-semibold">
                        Try &ldquo;All time&rdquo; →
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          ) : (
            <table className="w-full">
              <thead className="bg-stone-50 border-b border-stone-200">
                <tr>
                  <th className="text-left px-3 py-2 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600">Date</th>
                  <th className="text-left px-3 py-2 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600">Care Home</th>
                  <th className="text-left px-3 py-2 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600">Contact</th>
                  <th className="text-left px-3 py-2 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600">Postcode</th>
                </tr>
              </thead>
              <tbody>
                {pins.slice(0, 50).map((p) => (
                  <tr key={p.id}
                    onMouseEnter={() => setHoverId(p.id)}
                    onMouseLeave={() => setHoverId(null)}
                    data-testid={`care-home-overlay-row-${p.id}`}
                    className={`border-b border-stone-100 last:border-0 hover:bg-teal-50 ${hoverId === p.id ? "bg-teal-50" : ""}`}>
                    <td className="px-3 py-2 text-xs text-stone-700 tabular-nums whitespace-nowrap">{p.date_added ? formatDate(p.date_added) : "—"}</td>
                    <td className="px-3 py-2 text-xs text-stone-900">
                      <div className="font-semibold">{p.establishment_name || "—"}</div>
                      {p.city && <div className="text-[11px] text-stone-500">{p.city}</div>}
                    </td>
                    <td className="px-3 py-2 text-xs text-stone-700">
                      {p.name && <div>{p.name}</div>}
                      <div className="flex flex-wrap gap-2 mt-0.5 text-[11px]">
                        {p.email && <a href={`mailto:${p.email}`} className="text-stone-600 hover:text-stone-950 flex items-center gap-1"><Mail className="w-3 h-3" />{p.email}</a>}
                        {p.telephone && <a href={`tel:${p.telephone}`} className="text-stone-600 hover:text-stone-950 flex items-center gap-1"><Phone className="w-3 h-3" />{p.telephone}</a>}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-xs text-stone-700 tabular-nums whitespace-nowrap">{p.postcode || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {pins.length > 50 && (
            <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 text-center py-2 bg-stone-50 border-t border-stone-100">
              Showing 50 of {pins.length} — narrow the date range to see fewer
            </div>
          )}
        </div>
      )}
    </div>
  );
}
