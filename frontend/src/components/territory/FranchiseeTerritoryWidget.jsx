// Read-only territory map for the franchisee portal dashboard.
//
// Fetches the franchisee's saved sectors via /api/territory/franchisee-summary
// and renders them coloured-in. Each CQC home that matches the current
// admin-saved definition is drawn as a numbered marker (1, 2, 3…) and the
// matching collapsible list sits underneath, so the franchisee can pick a
// home off the map and see name / manager / phone / CQC link.
//
// Also exposes a "Check a postcode" input — type any UK postcode and we
// tell them whether it sits inside their territory.
import { useEffect, useState } from "react";
import api from "@/lib/api";
import TerritoryMap from "@/components/territory/TerritoryMap";
import TerritoryHomesList from "@/components/territory/TerritoryHomesList";
import {
  Loader2, Map as MapIcon, Search, CheckCircle2, XCircle, AlertCircle,
} from "lucide-react";

export default function FranchiseeTerritoryWidget({ franchiseeId }) {
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [sectors, setSectors] = useState([]);
  const [homes, setHomes] = useState([]);
  const [homesLoading, setHomesLoading] = useState(false);
  const [openHome, setOpenHome] = useState(null);
  const [flyTo, setFlyTo] = useState(null);
  const [check, setCheck] = useState("");
  const [checkResult, setCheckResult] = useState(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    (async () => {
      setLoading(true); setErr("");
      try {
        const params = franchiseeId ? { franchisee_id: franchiseeId } : {};
        const { data } = await api.get("/territory/franchisee-summary", { params });
        setSummary(data);
        const list = data.sectors || [];
        if (list.length) {
          const [geomsRes, homesRes] = await Promise.all([
            api.get("/territory/sector-polygons", { params: { sectors: list.join(",") } }),
            api.get("/territory/homes", { params: { sectors: list.join(","), limit: 2000 } }),
          ]);
          setSectors(geomsRes.data.sectors || []);
          // Sort homes by town, then name — predictable numbering on the map.
          const sortedHomes = (homesRes.data.homes || []).slice().sort((a, b) => {
            const ta = (a.postalAddressTownCity || "").toLowerCase();
            const tb = (b.postalAddressTownCity || "").toLowerCase();
            if (ta !== tb) return ta.localeCompare(tb);
            return (a.name || "").localeCompare(b.name || "");
          });
          setHomes(sortedHomes);
        } else {
          setSectors([]); setHomes([]);
        }
      } catch (e) {
        setErr(e?.response?.data?.detail || "Could not load territory.");
      } finally { setLoading(false); }
    })();
  }, [franchiseeId]);

  const runCheck = async () => {
    if (!check.trim()) return;
    setChecking(true); setCheckResult(null);
    try {
      const { data } = await api.get("/territory/postcode-lookup", { params: { postcode: check.trim() } });
      const inside = (summary?.sectors || []).includes(data.sector);
      setCheckResult({
        ok: inside,
        sector: data.sector,
        district: data.district,
        admin_district: data.admin_district,
      });
    } catch (e) {
      setCheckResult({ error: e?.response?.data?.detail || "Could not look up" });
    } finally { setChecking(false); }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[200px] bg-white border border-stone-200 rounded-2xl">
        <Loader2 className="w-5 h-5 animate-spin text-stone-400" />
      </div>
    );
  }
  if (err) {
    return (
      <div className="bg-red-50 border border-red-200 px-4 py-3 rounded-2xl text-sm text-red-700 flex items-center gap-2">
        <AlertCircle className="w-4 h-4" /> {err}
      </div>
    );
  }

  const hasTerritory = (summary?.sectors || []).length > 0;
  return (
    <div className="space-y-4" data-testid="portal-territory">
      <div className="bg-white border border-stone-200 rounded-2xl p-6 space-y-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <div className="flex items-center gap-2 text-xs uppercase tracking-[0.3em] font-bold text-stone-500 mb-1">
              <MapIcon className="w-3.5 h-3.5" /> Your territory
            </div>
            {hasTerritory ? (
              <h2 className="font-display text-2xl text-stone-950">
                {homes.length} care home{homes.length === 1 ? "" : "s"} across {summary.sectors.length} sector{summary.sectors.length === 1 ? "" : "s"}
                {homesLoading && <Loader2 className="inline-block w-4 h-4 ml-2 animate-spin text-stone-400" />}
              </h2>
            ) : (
              <h2 className="font-display text-2xl text-stone-950">Your territory hasn't been set yet</h2>
            )}
          </div>
          {hasTerritory && (
            <div className="flex items-center gap-2 flex-wrap">
              <input value={check} onChange={(e) => setCheck(e.target.value)} data-testid="portal-postcode-check"
                onKeyDown={(e) => { if (e.key === "Enter") runCheck(); }}
                placeholder="Check a postcode (e.g. EX12 3AB)"
                className="px-3 py-2 text-sm bg-stone-50 border border-stone-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-stone-900/10 focus:border-stone-400" />
              <button onClick={runCheck} disabled={checking || !check.trim()} data-testid="portal-postcode-check-go"
                className="px-3 py-2 text-xs font-bold uppercase tracking-wider bg-stone-950 text-white hover:bg-stone-800 rounded-lg disabled:opacity-50 flex items-center gap-1.5">
                {checking ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />} Check
              </button>
            </div>
          )}
        </div>

        {checkResult && (
          <div className={`px-4 py-2.5 rounded-xl flex items-center gap-2 text-sm ${
            checkResult.error ? "bg-amber-50 border border-amber-300 text-amber-900"
            : checkResult.ok ? "bg-emerald-50 border border-emerald-300 text-emerald-900"
            : "bg-stone-100 border border-stone-300 text-stone-800"
          }`}>
            {checkResult.error ? <><AlertCircle className="w-4 h-4" /> {checkResult.error}</>
            : checkResult.ok ? <><CheckCircle2 className="w-4 h-4" /> <strong>{checkResult.sector}</strong> sits inside your territory</>
            : <><XCircle className="w-4 h-4" /> <strong>{checkResult.sector}</strong> is outside your territory ({checkResult.admin_district})</>}
          </div>
        )}

        {hasTerritory ? (
          <TerritoryMap
            sectors={sectors}
            selected={summary.sectors}
            centre={summary.centre}
            centreLabel={summary.franchisee?.organisation || summary.franchisee?.postcode || ""}
            height={460}
            interactive={false}
            homes={homes}
            onMarkerClick={(i) => {
              setOpenHome(i);
              // Scroll the list row into view
              const row = document.querySelector(`[data-testid="home-row-${i + 1}"]`);
              if (row) row.scrollIntoView({ behavior: "smooth", block: "center" });
            }}
            flyTo={flyTo}
          />
        ) : (
          <div className="text-sm text-stone-500 bg-stone-50 border border-dashed border-stone-300 rounded-xl px-4 py-6 text-center">
            Once HQ saves your territory it'll appear here as a map. You'll also be able to type any UK postcode to check whether it falls inside your area.
          </div>
        )}
      </div>

      {hasTerritory && (
        <TerritoryHomesList
          homes={homes}
          openIndex={openHome}
          onOpenChange={setOpenHome}
          onZoomHome={(h) => setFlyTo({ lat: h.latitude, lng: h.longitude, _t: Date.now() })}
        />
      )}
    </div>
  );
}
