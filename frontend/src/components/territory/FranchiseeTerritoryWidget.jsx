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
import { useEffect, useMemo, useState } from "react";
import api from "@/lib/api";
import TerritoryMap from "@/components/territory/TerritoryMap";
import TerritoryHomesList from "@/components/territory/TerritoryHomesList";
import TerritoryClientModal from "@/components/territory/TerritoryClientModal";
import {
  Loader2, Map as MapIcon, Search, CheckCircle2, XCircle, AlertCircle,
  Route,
} from "lucide-react";

export default function FranchiseeTerritoryWidget({ franchiseeId, mapHeight = 560, forceBasic = false }) {
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [sectors, setSectors] = useState([]);
  const [homes, setHomes] = useState([]);
  const [homesLoading, setHomesLoading] = useState(false);
  const [openHome, setOpenHome] = useState(null);
  const [homesListExpanded, setHomesListExpanded] = useState(false);
  const [flyTo, setFlyTo] = useState(null);
  const [check, setCheck] = useState("");
  const [checkResult, setCheckResult] = useState(null);
  const [checking, setChecking] = useState(false);
  const [pinnedPostcode, setPinnedPostcode] = useState(null);
  const [basemap, setBasemap] = useState(() => {
    try { return localStorage.getItem("cm.portal.basemap") || "light"; }
    catch { return "light"; }
  });
  // Territory+ state -------------------------------------------------------
  // ``plusAccess`` is null until we've checked /portal/territory-plus/access.
  // ``myClients`` is the franchisee's private client list (both custom and
  // mark-home links). ``providerFilter`` filters home rows + map markers.
  const [plusAccess, setPlusAccess] = useState(null);
  const [myClients, setMyClients] = useState([]);
  const [editingClient, setEditingClient] = useState(null); // {} = "new", obj = edit
  const [providerFilter, setProviderFilter] = useState(null);
  const [myClientsOnly, setMyClientsOnly] = useState(false);
  // Sales-flow leads (per-franchisee personal CRM bookmark per home).
  // Keyed by "${source}:${home_id}" for O(1) lookup from list/map.
  const [leads, setLeads] = useState([]);

  useEffect(() => {
    try { localStorage.setItem("cm.portal.basemap", basemap); } catch {/* noop */}
  }, [basemap]);

  // Probe access once on mount — silent failure → no Territory+ UI.
  // ``forceBasic`` short-circuits the probe so the demo can show the
  // vanilla "My Territory" view side-by-side with "My Territory+".
  useEffect(() => {
    if (forceBasic) {
      setPlusAccess({ allowed: false, is_demo: false });
      return;
    }
    (async () => {
      try {
        const { data } = await api.get("/portal/territory-plus/access");
        setPlusAccess(data);
        if (data?.allowed) {
          const [clientsRes, leadsRes] = await Promise.all([
            api.get("/portal/territory-plus/clients"),
            api.get("/portal/territory-plus/leads"),
          ]);
          setMyClients(clientsRes.data.items || []);
          setLeads(leadsRes.data.items || []);
        }
      } catch (e) {
        setPlusAccess({ allowed: false });
      }
    })();
  }, [forceBasic]);

  const reloadClients = async () => {
    try {
      const { data } = await api.get("/portal/territory-plus/clients");
      setMyClients(data.items || []);
    } catch (e) { /* noop */ }
  };

  const reloadLeads = async () => {
    try {
      const { data } = await api.get("/portal/territory-plus/leads");
      setLeads(data.items || []);
    } catch (e) { /* noop */ }
  };

  const handleSetLeadStatus = async (home, status, follow_up_at) => {
    try {
      const homeKey = home.id || home.locationId;
      if (!homeKey) return;
      const isScotland = String(home.source || "").includes("scot");
      const source = isScotland ? "scotland" : "cqc";
      if (status === "not_contacted") {
        await api.delete("/portal/territory-plus/leads", {
          data: { source, home_id: homeKey },
        });
      } else {
        await api.put("/portal/territory-plus/leads", {
          source, home_id: homeKey, status,
          follow_up_at: follow_up_at || null,
        });
      }
      await reloadLeads();
    } catch (e) { /* noop */ }
  };

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
      // Drop a distinct marker on the map for this postcode (lat/lng come
      // from postcodes.io). The map auto-pans to it.
      if (data.latitude != null && data.longitude != null) {
        setPinnedPostcode({
          postcode: data.postcode || check.trim().toUpperCase(),
          lat: data.latitude,
          lng: data.longitude,
          inside,
          _t: Date.now(),
        });
      }
    } catch (e) {
      setCheckResult({ error: e?.response?.data?.detail || "Could not look up" });
      setPinnedPostcode(null);
    } finally { setChecking(false); }
  };

  const hasTerritory = (summary?.sectors || []).length > 0;
  const plusOn = !!plusAccess?.allowed;

  // Set of "source:home_id" keys for quick lookup when drawing markers
  // and rendering rows. Custom clients (no home_id) are tracked separately.
  const clientHomeKeys = useMemo(() => {
    const s = new Set();
    myClients.forEach((c) => {
      if (c.source !== "custom" && c.home_id) s.add(`${c.source}:${c.home_id}`);
    });
    return s;
  }, [myClients]);

  const customClients = useMemo(
    () => myClients.filter((c) => c.source === "custom"),
    [myClients],
  );

  // Map "${source}:${home_id}" → lead doc for O(1) lookup from rows.
  const leadsByKey = useMemo(() => {
    const m = new Map();
    leads.forEach((l) => { if (l.source && l.home_id) m.set(`${l.source}:${l.home_id}`, l); });
    return m;
  }, [leads]);

  // Lookup of regulated home docs keyed by their id — used to feed the
  // modal's "View live CQC data" popup when editing a marked client.
  const homeById = useMemo(() => {
    const m = new Map();
    homes.forEach((h) => {
      const k = h.id || h.locationId;
      if (k) m.set(k, h);
    });
    return m;
  }, [homes]);

  // Provider buckets — drive the "Care groups" filter buttons. Show
  // every provider with one or more homes (top 12 sorted by count).
  // Even when no group has multiples, exposing all of them lets the
  // franchisee click any single home's care group as a filter.
  const providers = useMemo(() => {
    if (!plusOn) return [];
    const counts = new Map();
    homes.forEach((h) => {
      const name = (h.providerName || "").trim();
      if (!name) return;
      counts.set(name, (counts.get(name) || 0) + 1);
    });
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 12)
      .map(([name, count]) => ({ name, count }));
  }, [homes, plusOn]);

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

  const handleMarkHomeClient = async (home) => {
    try {
      const sourceKey = home.id || home.locationId;
      if (!sourceKey) return;
      const isScotland = String(home.source || home.locationId || "").startsWith("scot:")
        || String(home.providerName || "").toLowerCase().includes("scotland");
      const source = home.source === "scotland" || isScotland ? "scotland" : "cqc";
      await api.post("/portal/territory-plus/clients/mark-home", {
        source,
        home_id: sourceKey,
        name: home.name,
        address: home.fullAddress
          || [home.postalAddressLine1, home.postalAddressTownCity, home.postcode || home.postalCode]
              .filter(Boolean).join(", "),
        phone: home.mainPhoneNumber,
        website: home.website,
        provider: home.providerName,
        manager: home.registrationManagerName,
        postcode: home.postcode || home.postalCode,
        lat: home.latitude,
        lng: home.longitude,
      });
      await reloadClients();
    } catch (e) { /* noop */ }
  };

  const handleUnmarkHomeClient = async (home) => {
    try {
      const homeKey = home.id || home.locationId;
      const source = clientHomeKeys.has(`scotland:${homeKey}`) ? "scotland" : "cqc";
      await api.delete("/portal/territory-plus/clients/mark-home", {
        data: { source, home_id: homeKey },
      });
      await reloadClients();
    } catch (e) { /* noop */ }
  };

  return (
    <div className="space-y-4" data-testid="portal-territory">
      <div className="bg-white border border-stone-200 rounded-2xl p-6 space-y-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <div className="flex items-center gap-2 text-xs uppercase tracking-[0.3em] font-bold text-stone-500 mb-1">
              <MapIcon className="w-3.5 h-3.5" /> Your territory map
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
              <button
                onClick={() => setBasemap((b) => (b === "streets" ? "light" : "streets"))}
                data-testid="portal-basemap-toggle"
                title={basemap === "streets" ? "Hide road layer" : "Show road layer"}
                className={`px-3 py-2 text-xs font-bold uppercase tracking-wider rounded-lg border flex items-center gap-1.5 transition ${basemap === "streets" ? "bg-stone-950 text-white border-stone-950" : "bg-white text-stone-700 border-stone-300 hover:bg-stone-50"}`}
              >
                <Route className="w-3.5 h-3.5" />
                {basemap === "streets" ? "Roads on" : "Show roads"}
              </button>
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
            height={mapHeight}
            interactive={false}
            homes={homes}
            activeHomeIndex={openHome}
            onMarkerClick={(i) => {
              setOpenHome(i);
              setHomesListExpanded(true);
              const scrollToRow = () => {
                const row = document.querySelector(`[data-testid="home-row-${i + 1}"]`);
                if (row) row.scrollIntoView({ behavior: "smooth", block: "center" });
              };
              requestAnimationFrame(() => requestAnimationFrame(scrollToRow));
            }}
            flyTo={flyTo}
            pinnedPostcode={pinnedPostcode}
            basemap={basemap}
            clientHomeKeys={plusOn ? clientHomeKeys : null}
            customClients={plusOn ? customClients : []}
            onCustomClientClick={plusOn ? (c) => setEditingClient(c) : null}
            providerFilter={plusOn ? providerFilter : null}
            dimNonClients={plusOn && myClientsOnly}
          />
        ) : (
          <div className="text-sm text-stone-500 bg-stone-50 border border-dashed border-stone-300 rounded-xl px-4 py-6 text-center">
            Once HQ saves your territory it'll appear here as a map. You'll also be able to type any UK postcode to check whether it falls inside your area.
          </div>
        )}
      </div>

      {(hasTerritory || plusOn) && (
        <TerritoryHomesList
          homes={homes}
          openIndex={openHome}
          onOpenChange={setOpenHome}
          expanded={homesListExpanded}
          onExpandedChange={setHomesListExpanded}
          onZoomHome={(h) => setFlyTo({ lat: h.latitude, lng: h.longitude, _t: Date.now() })}
          plus={plusOn}
          clientHomeKeys={clientHomeKeys}
          customClients={customClients}
          onMarkHomeClient={handleMarkHomeClient}
          onUnmarkHomeClient={handleUnmarkHomeClient}
          onAddClient={() => setEditingClient({ __new: true })}
          onEditClient={(c) => setEditingClient(c)}
          providers={providers}
          providerFilter={providerFilter}
          onProviderFilter={setProviderFilter}
          leadsByKey={leadsByKey}
          onSetLeadStatus={handleSetLeadStatus}
          myClientsOnly={myClientsOnly}
          onMyClientsOnlyChange={setMyClientsOnly}
        />
      )}

      {editingClient && (
        <TerritoryClientModal
          initial={editingClient.__new ? null : editingClient}
          cqcSnapshot={!editingClient.__new && editingClient.source !== "custom"
            ? homeById.get(editingClient.home_id) || null
            : null}
          onClose={() => setEditingClient(null)}
          onSaved={() => { reloadClients(); }}
          onDeleted={() => { reloadClients(); }}
        />
      )}
    </div>
  );
}
