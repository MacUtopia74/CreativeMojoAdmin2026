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
import TerritoryCareGroupsCard from "@/components/territory/TerritoryCareGroupsCard";
import MyClientsPanel from "@/components/territory/MyClientsPanel";
import {
  Loader2, Map as MapIcon, Search, CheckCircle2, XCircle, AlertCircle,
  Route, Maximize2, Minimize2, MapPin, Phone, Mail, Globe, ExternalLink,
  User, Calendar, Building2, Star, BedDouble,
} from "lucide-react";

export default function FranchiseeTerritoryWidget({
  franchiseeId,
  mapHeight = 560,
  forceBasic = false,
  marketingEnabled = false,
  // Admin-only: care-home-enquiry pins overlaid on the territory map
  // (see /pages/FranchiseeDetailPage.js). Rendered by TerritoryMap
  // via its ``pins`` layer, sitting on top of the CQC home markers.
  extraPins = null,
  hoveredExtraPinId = null,
  onExtraPinClick = null,
  // When true, hides the numbered CQC-home markers on the map AND the
  // "Homes in your territory" list beneath it. Used by the Care Home
  // Enquiries overlay so the teal enquiry pins aren't obscured by the
  // ~100+ green home pins in a densely-populated territory.
  hideHomeMarkers = false,
  // Admin-mode toggle (Feb 2026). When true:
  //   * Care Groups panel + Territory+ layout render regardless of the
  //     franchisee's actual Plus status — HQ always sees the full view.
  //   * HQ Note field is editable inside TerritoryClientModal, backed by
  //     /api/admin/franchisees/{id}/hq-home-notes.
  //   * Row/marker click on any CQC home opens the modal in "note-only"
  //     mode so HQ can annotate homes without promoting them to a
  //     franchisee_clients doc.
  adminMode = false,
}) {
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [sectors, setSectors] = useState([]);
  const [homes, setHomes] = useState([]);
  const [homesLoading, setHomesLoading] = useState(false);
  const [openHome, setOpenHome] = useState(null);
  const [homesListExpanded, setHomesListExpanded] = useState(true);
  // Top-row layout focus toggle. ``false`` = balanced (map dominant 60/40).
  // ``true`` = clients-focused (60/40 in favour of My Clients, map narrower).
  // Toggled by the maximize button in either panel header.
  const [clientsFocus, setClientsFocus] = useState(false);
  // Full-page width "list only" mode — hides the map so the franchisee
  // can see twice as many client rows at a glance (rendered in a
  // two-column grid). Exits back to balanced layout via the SHOW MAP
  // button surfaced inside the panel header.
  const [clientsFullWidth, setClientsFullWidth] = useState(false);
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
  // Single source of truth for the lead-status filter — drives BOTH the
  // Client Pool list (in MyClientsPanel) AND the map markers. Empty
  // string means "all statuses, no filter applied".
  const [statusFilter, setStatusFilter] = useState("");
  // Sales-flow leads (per-franchisee personal CRM bookmark per home).
  // Keyed by "${source}:${home_id}" for O(1) lookup from list/map.
  const [leads, setLeads] = useState([]);
  // HQ notes on CQC entries. Keyed by "${source}:${home_id}" so a
  // marker/row click can pull the current note in one lookup.
  //   adminMode      → loads from /admin/franchisees/{id}/hq-home-notes
  //   franchisee/Plus → loads from /portal/hq-home-notes (read-only)
  const [hqNotesMap, setHqNotesMap] = useState({});
  // When HQ clicks a home that isn't already a franchisee_clients doc,
  // we open the modal in "note-only" mode with a lightweight seed so
  // the amber HQ Note panel is the only actionable field.
  const [hqNoteOnly, setHqNoteOnly] = useState(null);

  useEffect(() => {
    try { localStorage.setItem("cm.portal.basemap", basemap); } catch {/* noop */}
  }, [basemap]);

  // Probe access once on mount — silent failure → no Territory+ UI.
  // ``forceBasic`` short-circuits the probe so the demo can show the
  // vanilla "My Territory" view side-by-side with "My Territory+".
  // ``adminMode`` forces the Territory+ layout on regardless of the
  // franchisee's actual Plus status — HQ always sees the full picture.
  useEffect(() => {
    if (forceBasic) {
      setPlusAccess({ allowed: false, is_demo: false });
      return;
    }
    if (adminMode) {
      // Skip the /portal/territory-plus/access probe (it uses the
      // logged-in HQ session, which isn't tied to the target
      // franchisee). Load the franchisee's clients + leads directly
      // via the same portal endpoints — those routes accept an
      // optional franchisee_id override for admins.
      setPlusAccess({ allowed: true, is_admin_view: true });
      (async () => {
        try {
          const params = franchiseeId ? { franchisee_id: franchiseeId } : {};
          const [clientsRes, leadsRes, notesRes] = await Promise.all([
            api.get("/portal/territory-plus/clients", { params }).catch(() => ({ data: { items: [] } })),
            api.get("/portal/territory-plus/leads", { params }).catch(() => ({ data: { items: [] } })),
            franchiseeId
              ? api.get(`/admin/franchisees/${franchiseeId}/hq-home-notes`)
              : Promise.resolve({ data: { map: {} } }),
          ]);
          setMyClients(clientsRes.data.items || []);
          setLeads(leadsRes.data.items || []);
          setHqNotesMap(notesRes.data?.map || {});
        } catch (e) { /* noop */ }
      })();
      return;
    }
    (async () => {
      try {
        const { data } = await api.get("/portal/territory-plus/access");
        setPlusAccess(data);
        if (data?.allowed) {
          const [clientsRes, leadsRes, hqNotesRes] = await Promise.all([
            api.get("/portal/territory-plus/clients"),
            api.get("/portal/territory-plus/leads"),
            // Franchisee's own read-only view of HQ notes.
            api.get("/portal/hq-home-notes").catch(() => ({ data: { map: {} } })),
          ]);
          setMyClients(clientsRes.data.items || []);
          setLeads(leadsRes.data.items || []);
          setHqNotesMap(hqNotesRes.data?.map || {});
        }
      } catch (e) {
        setPlusAccess({ allowed: false });
      }
    })();
  }, [forceBasic, adminMode, franchiseeId]);

  // Append a new HQ note entry to the audit trail for this
  // (franchisee, home) pair. Never overwrites — the backend inserts a
  // fresh row every time. Returns the new entry so the caller can
  // slot it into local state immediately (avoiding a full reload).
  // Errors bubble up so the modal can surface them.
  const saveHqNote = async (source, homeId, note) => {
    if (!adminMode || !franchiseeId) {
      throw new Error("Admin session required to save HQ notes.");
    }
    const { data } = await api.post(
      `/admin/franchisees/${franchiseeId}/hq-home-notes/${source}/${homeId}`,
      { note },
    );
    // Refresh the local map so both the modal (that just saved) and
    // any other visible chrome (row badges, counters) update
    // immediately without waiting for a full remount.
    try {
      const { data: refreshed } = await api.get(
        `/admin/franchisees/${franchiseeId}/hq-home-notes`,
      );
      setHqNotesMap(refreshed?.map || {});
    } catch {
      /* silent — the modal will keep the entry it received from the POST */
    }
    return data?.entry || null;
  };

  // Admin-only: remove a specific entry from the history (typo fix).
  const deleteHqEntry = async (entryId) => {
    if (!adminMode || !franchiseeId) return;
    await api.delete(
      `/admin/franchisees/${franchiseeId}/hq-home-notes/entry/${entryId}`,
    );
    try {
      const { data: refreshed } = await api.get(
        `/admin/franchisees/${franchiseeId}/hq-home-notes`,
      );
      setHqNotesMap(refreshed?.map || {});
    } catch { /* silent */ }
  };

  const reloadClients = async () => {
    try {
      const params = adminMode && franchiseeId ? { franchisee_id: franchiseeId } : {};
      const { data } = await api.get("/portal/territory-plus/clients", { params });
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
      // Detect regulator from the home's country tag so leads tracked
      // against NI/Wales records don't collide with English CQC ids.
      const country = String(home.country || "").toLowerCase();
      const source = country.includes("scot") ? "scotland"
                   : country.includes("wales") ? "wales"
                   : (country.includes("northern") || country.includes("ireland")) ? "ni"
                   : "cqc";
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
  // and rendering rows. Only TRUE clients (lead_status === "regular_client")
  // count — prospects in earlier pipeline stages stay un-starred so the
  // gold ★ on the map + the list strictly denotes a converted client.
  // Custom clients (no home_id) are tracked separately by the row UI.
  const clientHomeKeys = useMemo(() => {
    const s = new Set();
    myClients.forEach((c) => {
      if (c.source !== "custom" && c.home_id && c.lead_status === "regular_client") {
        s.add(`${c.source}:${c.home_id}`);
      }
    });
    return s;
  }, [myClients]);

  // CQC home → existing client doc lookup is computed below (see
  // ``clientByHomeKey``). When a row in the CQC panel is clicked AND
  // it's already a saved client, open the rich edit modal instead of
  // the inline concertina so the CQC panel mirrors the My Clients UX.
  const openClientForHome = (home) => {
    const key = home.id || home.locationId || home._id;
    if (!key) return;
    const client = clientByHomeKey.get(`cqc:${key}`) || clientByHomeKey.get(`scotland:${key}`);
    if (client) {
      // Already a saved client — open its existing record for editing.
      // The HQ Note is passed as a separate ``hqNote`` prop so it renders
      // in its own amber panel WITHOUT touching franchisee-owned fields
      // (notes textarea, marketing status, contacts). Nothing in the
      // "Save" pipeline sees the HQ note; the amber panel has its own
      // save button hitting /admin/franchisees/{id}/hq-home-notes.
      setEditingClient(client);
      return;
    }
    // Seed the full client modal from the CQC snapshot so both admin AND
    // franchisee land on the same UX. In admin mode we ALSO expose the
    // editable HQ Note panel (Feb 2026 spec — HQ wants Marketing controls
    // alongside their note without overwriting the franchisee's own
    // pipeline data). Saving marketing status auto-creates the client
    // doc — HQ Note stays in ``hq_home_notes`` and is never merged into
    // the franchisee_clients row.
    const fullAddress = home.fullAddress
      || [home.postalAddressLine1, home.postalAddressLine2, home.postalAddressTownCity, home.postalAddressCounty, home.postalCode]
          .filter(Boolean).join(", ");
    const source = String(home.country || "").toLowerCase().includes("scot") ? "scotland" : "cqc";
    setEditingClient({
      __seededFromHome: true,
      __hq_source: source,
      __hq_home_id: key,
      name: home.name || "",
      address: fullAddress,
      postcode: home.postalCode || home.postcode || "",
      phone: home.mainPhoneNumber || "",
      email: home.email || "",
      website: home.website || "",
      manager: home.registrationManagerName || "",
      provider: home.providerName || "",
      cqc_rating: home.currentRatings?.overall?.rating || "",
      latest_inspection: home.lastInspection?.date || home.currentRatings?.overall?.reportDate || "",
      source,
      home_id: key,
      lat: home.latitude || null,
      lng: home.longitude || null,
      contacts: [],
      notes: "",
    });
  };

  // Custom clients shown as markers on the map. Tinted by lead status
  // (gold ★ only when lead_status === "regular_client"). The map's
  // status-filter visibility is applied inside <TerritoryMap>, so we
  // pass every custom entry through and let the map decide.
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

  // Provider buckets — drive the "Care groups" filter buttons + the
  // breakdown card. Show every provider with one or more homes; the
  // card decides how many to show by default. The filter pills in
  // TerritoryHomesList still cap to 12 for visual sanity.
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
      .map(([name, count]) => ({ name, count }));
  }, [homes, plusOn]);

  // Top 12 only for the filter pill row in the list toolbar.
  const topProviders = useMemo(() => providers.slice(0, 12), [providers]);

  const providersTotalHomes = useMemo(
    () => providers.reduce((a, p) => a + p.count, 0),
    [providers],
  );

  // Set of "source:home_id" keys for ALL franchisee-tracked entries
  // (clients + prospects). Used by the Territory Pool list to hide the
  // "Add to pool" button on rows that already have a tracked record,
  // avoiding accidental duplicates. Distinct from ``clientHomeKeys``
  // above, which is the strict "is a regular client" set.
  const trackedHomeKeys = useMemo(() => {
    const s = new Set();
    myClients.forEach((c) => {
      if (c.source !== "custom" && c.home_id) s.add(`${c.source}:${c.home_id}`);
    });
    return s;
  }, [myClients]);

  // "${source}:${home_id}" → lead_status string for every tracked CQC
  // home. Drives the per-marker tint on the map (orange for "Not
  // Contacted" rows, purple for "Interested", etc.) and the status-
  // filter visibility check.
  const homeStatusByKey = useMemo(() => {
    const m = new Map();
    myClients.forEach((c) => {
      if (c.source !== "custom" && c.home_id) {
        m.set(`${c.source}:${c.home_id}`, c.lead_status || "not_contacted");
      }
    });
    return m;
  }, [myClients]);

  // Map of "${source}:${home_id}" → franchisee_clients doc for marked
  // regulated homes — lets a marker click jump straight to the edit
  // modal instead of just expanding the row in the list below.
  const clientByHomeKey = useMemo(() => {
    const m = new Map();
    myClients.forEach((c) => {
      if (c.source !== "custom" && c.home_id) {
        m.set(`${c.source}:${c.home_id}`, c);
      }
    });
    return m;
  }, [myClients]);

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

  // Map element — reused in both layouts so the existing marker/flyTo
  // logic stays in one place. ``height`` is sized to match the My Clients
  // panel (header + ~10 rows + pagination footer) so the two columns line
  // up at the bottom; ``rounded-none`` because the wrapper panel already
  // provides the rounded corners.
  const mapEl = hasTerritory ? (
    <TerritoryMap
      sectors={sectors}
      selected={summary.sectors}
      centre={summary.centre}
      centreLabel={summary.franchisee?.organisation || summary.franchisee?.postcode || ""}
      height={plusOn ? 760 : mapHeight}
      interactive={false}
      homes={hideHomeMarkers ? [] : homes}
      activeHomeIndex={openHome}
      onMarkerClick={(i, home) => {
        setOpenHome(i);
        setHomesListExpanded(true);
        // Match the row-click behaviour on the Plus/admin layout —
        // open the same detail modal (client edit / HQ-note /
        // seeded mark-home) that clicking the corresponding row
        // opens on the CQC panel. Previously the marker only
        // highlighted the circle + scrolled the list, which felt
        // unresponsive on MyTerritory+ where the tall map hides
        // the list below the fold. Basic (non-Plus) franchisees
        // keep the old highlight-only behaviour so an accidental
        // marker click doesn't pop the mark-as-client seeded modal.
        if (plusOn) {
          const target = home || homes[i];
          if (target) openClientForHome(target);
        }
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
      homeStatusByKey={plusOn ? homeStatusByKey : null}
      statusFilter={plusOn ? statusFilter : ""}
      customClients={plusOn ? customClients : []}
      onCustomClientClick={plusOn ? (c) => setEditingClient(c) : null}
      onClientMarkerClick={plusOn ? (home) => {
        // Clicked a gold ★ marker — find the matching franchisee_clients
        // doc and open the edit modal. The marker won't render as gold
        // unless this doc exists, so the lookup should always hit.
        const key = `cqc:${home.id || home.locationId || ""}`;
        const altKey = `scotland:${home.id || home.locationId || ""}`;
        const client = clientByHomeKey.get(key) || clientByHomeKey.get(altKey);
        if (client) setEditingClient(client);
      } : null}
      providerFilter={plusOn ? providerFilter : null}
      dimNonClients={plusOn && myClientsOnly}
      pins={extraPins && extraPins.length ? extraPins.map((p) => ({
        ...p,
        color: p.color || "#0d9488",
        hovered: hoveredExtraPinId === p.id,
      })) : null}
      onPinClick={onExtraPinClick}
    />
  ) : (
    <div className="text-sm text-stone-500 bg-stone-50 border border-dashed border-stone-300 rounded-xl px-4 py-6 text-center">
      Once HQ saves your territory it'll appear here as a map. You'll also be able to type any UK postcode to check whether it falls inside your area.
    </div>
  );

  // Postcode check + roads toggle — shared across both layouts. Lives
  // in the map card's header strip on the new Territory+ layout, and
  // inline above the map on the basic layout.
  const mapControls = hasTerritory && (
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
  );

  const postcodeBanner = checkResult && (
    <div className={`px-4 py-2.5 rounded-xl flex items-center gap-2 text-sm ${
      checkResult.error ? "bg-amber-50 border border-amber-300 text-amber-900"
      : checkResult.ok ? "bg-emerald-50 border border-emerald-300 text-emerald-900"
      : "bg-stone-100 border border-stone-300 text-stone-800"
    }`}>
      {checkResult.error ? <><AlertCircle className="w-4 h-4" /> {checkResult.error}</>
      : checkResult.ok ? <><CheckCircle2 className="w-4 h-4" /> <strong>{checkResult.sector}</strong> sits inside your territory</>
      : <><XCircle className="w-4 h-4" /> <strong>{checkResult.sector}</strong> is outside your territory ({checkResult.admin_district})</>}
    </div>
  );

  // --------------------------- Territory+ layout ---------------------------
  // Per wireframe: top row = (action cards + My Clients table) | map.
  // Bottom row = CQC Homes | Care Groups. Stacks vertically on mobile.
  if (plusOn) {
    return (
      <div className="space-y-4" data-testid="portal-territory">
        {postcodeBanner}

        <div className="grid grid-cols-1 lg:grid-cols-5 gap-4 items-stretch">
          {/* LEFT COLUMN — My Clients table.
              Width has three states:
                • balanced   → col-span-2 (map dominant)
                • clientsFocus → col-span-3 (clients dominant, map narrow)
                • clientsFullWidth → col-span-5 (map hidden, two-column grid)
          */}
          <div className={`flex flex-col ${
            clientsFullWidth ? "lg:col-span-5"
              : clientsFocus ? "lg:col-span-3"
              : "lg:col-span-2"
          }`}>
            <MyClientsPanel
              clients={myClients}
              homeById={homeById}
              onAddClient={() => setEditingClient({ __new: true })}
              onEditClient={(c) => setEditingClient(c)}
              expanded={clientsFocus || clientsFullWidth}
              onExpandedChange={setClientsFocus}
              fullWidth={clientsFullWidth}
              onFullWidthChange={setClientsFullWidth}
              myClientsOnly={myClientsOnly}
              onMyClientsOnlyChange={setMyClientsOnly}
              marketingEnabled={marketingEnabled}
              statusFilter={statusFilter}
              onStatusFilterChange={setStatusFilter}
            />
          </div>

          {/* RIGHT COLUMN — Map. Width follows the inverse of clientsFocus.
              Hidden entirely in full-width client mode. */}
          {!clientsFullWidth && (
          <div className={`flex ${clientsFocus ? "lg:col-span-2" : "lg:col-span-3"}`}>
            <div className="bg-white border border-stone-200 rounded-2xl overflow-hidden h-full w-full flex flex-col">
              <div className="px-4 py-3 border-b border-stone-200 flex items-center justify-between gap-3" style={{ backgroundColor: "#eeee84" }}>
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  <span className="w-9 h-9 rounded-full bg-stone-950 text-[#dedd0a] flex items-center justify-center shrink-0">
                    <MapIcon className="w-4 h-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-950/70 truncate">My Territory</div>
                    {hasTerritory && (
                      <div className="text-sm text-stone-950 mt-0.5 truncate">
                        <strong>{homes.length}</strong> homes · <strong>{summary.sectors.length}</strong> sectors
                        {homesLoading && <Loader2 className="inline-block w-3 h-3 ml-1 animate-spin text-stone-600" />}
                      </div>
                    )}
                  </div>
                </div>
                <button
                  onClick={() => setClientsFocus((v) => !v)}
                  data-testid="t-plus-map-width-toggle"
                  title={clientsFocus ? "Expand map (narrow My Clients)" : "Narrow map (expand My Clients)"}
                  className="shrink-0 w-7 h-7 rounded-full border border-stone-950 bg-white text-stone-950 hover:bg-stone-100 flex items-center justify-center"
                  aria-label={clientsFocus ? "Expand map" : "Shrink map"}
                >
                  {clientsFocus ? <Maximize2 className="w-3.5 h-3.5" /> : <Minimize2 className="w-3.5 h-3.5" />}
                </button>
              </div>
              {hasTerritory && (
                <div className="px-3 py-2 border-b border-stone-100 flex items-center gap-2 flex-wrap bg-stone-50">
                  {mapControls}
                </div>
              )}
              <div className="flex-1">{mapEl}</div>
            </div>
          </div>
          )}
        </div>

        {/* BOTTOM ROW — CQC Homes + Care Groups. Hidden entirely while
            the Care Home Enquiries overlay is on so the teal enquiry
            list below the map has room to breathe. */}
        {!hideHomeMarkers && (
        <div className={`grid grid-cols-1 gap-4 ${providers.length > 0 ? "lg:grid-cols-5" : ""} items-stretch`}>
          <div className={`flex ${providers.length > 0 ? "lg:col-span-3" : ""}`}>
            <TerritoryHomesList
              homes={homes}
              openIndex={openHome}
              onOpenChange={setOpenHome}
              expanded={homesListExpanded}
              onExpandedChange={setHomesListExpanded}
              onZoomHome={(h) => setFlyTo({ lat: h.latitude, lng: h.longitude, _t: Date.now() })}
              plus={plusOn}
              clientHomeKeys={clientHomeKeys}
              trackedHomeKeys={trackedHomeKeys}
              customClients={[]}
              onMarkHomeClient={handleMarkHomeClient}
              onUnmarkHomeClient={handleUnmarkHomeClient}
              onOpenDetail={openClientForHome}
              onAddClient={() => setEditingClient({ __new: true })}
              onEditClient={(c) => setEditingClient(c)}
              providers={topProviders}
              providerFilter={providerFilter}
              onProviderFilter={setProviderFilter}
              leadsByKey={leadsByKey}
              onSetLeadStatus={handleSetLeadStatus}
              myClientsOnly={false}
              onMyClientsOnlyChange={() => {}}
            />
          </div>
          {providers.length > 0 && (
            <div className="lg:col-span-2 flex">
              <TerritoryCareGroupsCard
                providers={providers}
                totalHomes={providersTotalHomes}
                totalAllHomes={homes.length}
                activeProvider={providerFilter}
                onSelectProvider={(next) => {
                  // "Only Mine" silently filters out every non-client
                  // marker — so as soon as a care group is selected we
                  // need to clear it, otherwise the user picks (say)
                  // Barchester and sees zero pins because none of those
                  // homes happen to be in their client list. Selecting
                  // any care group / "all" pill clears the toggle.
                  setMyClientsOnly(false);
                  setProviderFilter(next);
                }}
              />
            </div>
          )}
        </div>
        )}

        {editingClient && (() => {
          // Resolve ONE canonical (source, home_id) reference for HQ
          // notes so admin and portal always agree. Priority:
          //   1. A CQC/regulator seed carries __hq_source + __hq_home_id
          //      (set when opening a home directly off the map).
          //   2. A saved franchisee_clients doc with a real regulator
          //      link (source in {cqc,scotland,wales,ni}) uses its
          //      stored (source, home_id).
          //   3. A manually-created custom client (source="custom",
          //      home_id is null) uses ("custom", client.id) so it
          //      still has a canonical, franchisee-scoped key.
          //   4. Anything else (legacy row with no source at all)
          //      falls back to ("custom", client.id) as long as the
          //      row has an id — otherwise HQ Notes are suppressed
          //      until the record is saved.
          const REGULATOR_SOURCES = new Set(["cqc", "scotland", "wales", "ni"]);
          let hqSource = null;
          let hqHomeId = null;
          if (editingClient.__hq_source && editingClient.__hq_home_id) {
            hqSource = editingClient.__hq_source;
            hqHomeId = editingClient.__hq_home_id;
          } else if (REGULATOR_SOURCES.has(editingClient.source) && editingClient.home_id) {
            hqSource = editingClient.source;
            hqHomeId = editingClient.home_id;
          } else if (editingClient.id) {
            hqSource = "custom";
            hqHomeId = editingClient.id;
          }
          const canShowHq = Boolean(hqSource && hqHomeId);
          const entryKey = canShowHq ? `${hqSource}:${hqHomeId}` : null;
          return (
            <TerritoryClientModal
              initial={editingClient.__new ? null : editingClient}
              cqcSnapshot={!editingClient.__new && editingClient.source !== "custom"
                ? homeById.get(editingClient.home_id) || null
                : null}
              marketingEnabled={marketingEnabled}
              hqEntries={canShowHq ? (hqNotesMap[entryKey] || []) : []}
              hqNoteEditable={adminMode && canShowHq}
              onHqNoteSave={saveHqNote}
              onHqEntryDelete={adminMode ? deleteHqEntry : null}
              hqSource={hqSource}
              hqHomeId={hqHomeId}
              adminFranchiseeId={adminMode ? franchiseeId : null}
              onClose={() => setEditingClient(null)}
              onSaved={() => { reloadClients(); }}
              onDeleted={() => { reloadClients(); }}
            />
          );
        })()}

        {/* Admin note-only modal — HQ is annotating a CQC entry without
            creating a franchisee_clients doc. The rest of the form is
            hidden by ``noteOnly``, leaving just the amber HQ Note panel. */}
        {hqNoteOnly && (
          <HqNoteOnlyModal
            entry={hqNoteOnly}
            hqEntries={hqNotesMap[`${hqNoteOnly.source}:${hqNoteOnly.home_id}`] || []}
            onSave={saveHqNote}
            onDelete={deleteHqEntry}
            onClose={() => setHqNoteOnly(null)}
          />
        )}
      </div>
    );
  }

  // --------------------------- Basic layout (legacy) -----------------------
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
          {mapControls}
        </div>

        {postcodeBanner}
        {mapEl}
      </div>

      {hasTerritory && !hideHomeMarkers && (
        <TerritoryHomesList
          homes={homes}
          openIndex={openHome}
          onOpenChange={setOpenHome}
          expanded={homesListExpanded}
          onExpandedChange={setHomesListExpanded}
          onZoomHome={(h) => setFlyTo({ lat: h.latitude, lng: h.longitude, _t: Date.now() })}
        />
      )}
    </div>
  );
}


// ---------------------------------------------------------------------------
// HqNoteOnlyModal — admin-only. HQ clicks a CQC home in the territory
// list, no franchisee_clients doc exists for it yet, and HQ just wants
// to annotate the CQC entry (see design decision #2 in the Feb 2026
// spec). Lightweight modal — no client fields, just the amber HQ Note
// panel + home context header.
// ---------------------------------------------------------------------------
function HqNoteOnlyModal({ entry, hqEntries = [], onSave, onDelete, onClose }) {
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const [flash, setFlash] = useState("");

  const home = entry.home || {};
  const address = home.fullAddress
    || [home.postalAddressLine1, home.postalAddressLine2, home.postalAddressTownCity, home.postalAddressCounty, home.postalCode].filter(Boolean).join(", ")
    || entry.address;
  const services = (home.gacServiceTypes || []).map((s) => s.name).filter(Boolean).join(" · ");
  const specialisms = (home.specialisms || []).map((s) => s.name).filter(Boolean);
  const ratingDate = home.currentRatings?.overall?.reportDate;
  const beds = Number(home.numberOfBeds) || 0;
  const phone = home.mainPhoneNumber;
  const phoneHref = phone ? `tel:${String(phone).replace(/\s+/g, "")}` : null;
  const webHref = home.website ? (home.website.startsWith("http") ? home.website : `https://${home.website}`) : null;
  const formatDate = (iso) => {
    if (!iso) return null;
    try { return new Date(iso).toLocaleDateString("en-GB"); } catch { return iso; }
  };

  const save = async () => {
    const trimmed = draft.trim();
    if (!trimmed) {
      setErr("Type a note before saving.");
      return;
    }
    setSaving(true); setErr(""); setFlash("");
    try {
      await onSave(entry.source, entry.home_id, trimmed);
      setDraft("");
      setFlash("HQ note saved.");
      window.setTimeout(() => setFlash(""), 2500);
    } catch (e) {
      setErr(e?.response?.data?.detail || e?.message || "Could not save HQ note.");
    } finally { setSaving(false); }
  };

  const deleteEntry = async (id) => {
    if (!onDelete) return;
    if (!window.confirm("Delete this HQ note entry? This can't be undone.")) return;
    try { await onDelete(id); } catch (e) {
      setErr(e?.response?.data?.detail || e?.message || "Could not delete entry.");
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
      onClick={onClose}
      data-testid="hq-note-only-modal"
    >
      <div
        className="bg-white rounded-2xl shadow-xl w-full max-w-3xl max-h-[92vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-stone-200 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-amber-700 mb-0.5">CQC entry · HQ view</div>
            <div className="text-lg font-bold text-stone-950 truncate">{entry.name || home.name || "Care home"}</div>
            <div className="text-xs text-stone-500 truncate mt-0.5">
              {(home.postalAddressTownCity || entry.postcode) && <span>{home.postalAddressTownCity || entry.postcode}</span>}
              {services && <span> · {services}</span>}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            data-testid="hq-note-only-close"
            className="shrink-0 w-8 h-8 rounded-full border border-stone-300 text-stone-600 hover:bg-stone-50 flex items-center justify-center"
            aria-label="Close"
          >×</button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {/* Home details section — mirrors the concertina row layout */}
          <div className="px-5 py-4 bg-stone-50 border-b border-stone-200">
            <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 mb-3 flex items-center gap-2">
              Home details
              {beds > 0 && (
                <span className="text-[10px] uppercase tracking-wider font-bold px-2 py-0.5 rounded-md bg-stone-100 text-stone-800 border border-stone-200">
                  <BedDouble className="w-3 h-3 inline-block mr-0.5 -mt-0.5" /> {beds} beds
                </span>
              )}
              {home.currentRatings?.overall?.rating && (
                <span className="text-[10px] uppercase tracking-wider font-bold px-2 py-0.5 rounded-md bg-white text-stone-800 border border-stone-200">
                  <Star className="w-3 h-3 inline-block mr-0.5 -mt-0.5" /> {home.currentRatings.overall.rating}
                </span>
              )}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2.5 text-sm">
              <DetailRow icon={MapPin} label="Address">{address || <span className="text-stone-400">—</span>}</DetailRow>
              <DetailRow icon={User} label="Manager">{home.registrationManagerName || <span className="text-stone-400">Not on file</span>}</DetailRow>
              <DetailRow icon={Phone} label="Phone">
                {phoneHref ? <a href={phoneHref} className="text-stone-900 hover:underline">{phone}</a> : <span className="text-stone-400">Not on file</span>}
              </DetailRow>
              <DetailRow icon={Mail} label="Email">
                <span className="text-stone-400">Not published on CQC</span>
              </DetailRow>
              <DetailRow icon={Globe} label="Website">
                {webHref ? <a href={webHref} target="_blank" rel="noreferrer" className="text-stone-900 hover:underline inline-flex items-center gap-1">{home.website} <ExternalLink className="w-3 h-3" /></a> : <span className="text-stone-400">Not on file</span>}
              </DetailRow>
              <DetailRow icon={Calendar} label="Latest inspection">{formatDate(home.lastInspection?.date) || formatDate(ratingDate) || <span className="text-stone-400">No inspection on record</span>}</DetailRow>
              <DetailRow icon={Building2} label="Provider">{home.providerName || entry.provider || <span className="text-stone-400">—</span>}</DetailRow>
              <DetailRow icon={Star} label="CQC rating">{home.currentRatings?.overall?.rating || <span className="text-stone-400">No rating yet</span>}</DetailRow>
              {specialisms.length > 0 && (
                <div className="sm:col-span-2 flex items-start gap-2 pt-1">
                  <span className="text-[10px] uppercase tracking-wider text-stone-500 font-bold mt-1 shrink-0">Specialisms</span>
                  <div className="flex flex-wrap gap-1">
                    {specialisms.map((s) => (
                      <span key={s} className="px-2 py-0.5 bg-stone-200/60 text-stone-800 text-[11px] rounded-md">{s}</span>
                    ))}
                  </div>
                </div>
              )}
            </div>
            {home.locationURL && (
              <div className="mt-3">
                <a href={home.locationURL} target="_blank" rel="noreferrer"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider border border-stone-300 bg-white hover:bg-stone-100 rounded-md text-stone-900">
                  <ExternalLink className="w-3 h-3" /> Open CQC page
                </a>
              </div>
            )}
          </div>

          {/* HQ Note editor + history */}
          <div className="p-5 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-amber-700">
                HQ Note history
                <span className="ml-1.5 text-stone-500">({hqEntries.length})</span>
              </div>
            </div>
            <div className="text-xs text-stone-600 bg-stone-50 border border-stone-200 rounded-md p-2.5 leading-relaxed">
              Each save appends a new entry to the audit trail — the franchisee sees the same history as a read-only panel on their MyTerritory+ client card.
            </div>
            <textarea
              value={draft}
              onChange={(e) => { setDraft(e.target.value); setErr(""); }}
              rows={4}
              placeholder="e.g. Spoke to Kate, revisit April. Manager currently away."
              data-testid="hq-note-only-textarea"
              className="w-full px-3 py-2 text-sm bg-amber-50 border border-amber-300 rounded-lg focus:outline-none focus:border-amber-500 text-stone-950"
            />
            {err && (
              <div data-testid="hq-note-only-error" className="text-xs bg-red-50 border border-red-200 text-red-700 rounded-md px-3 py-2">
                {err}
              </div>
            )}
            {flash && !err && (
              <div data-testid="hq-note-only-flash" className="text-xs bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-md px-3 py-2">
                {flash}
              </div>
            )}
            <div className="flex items-center justify-end">
              <button
                type="button"
                onClick={save}
                disabled={saving || !draft.trim()}
                data-testid="hq-note-only-save"
                className="px-3 py-2 text-xs uppercase tracking-wider font-bold rounded bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-40"
              >
                {saving ? "Saving…" : "Save HQ note"}
              </button>
            </div>

            {/* Persistent history — newest first. Each entry shows who
                added it and when. Admin gets a small delete button per
                entry for typo cleanup; not exposed to franchisees. */}
            <div className="mt-3 space-y-2" data-testid="hq-note-only-history">
              {hqEntries.length === 0 ? (
                <div className="text-xs italic text-stone-500 border border-dashed border-stone-200 rounded-md px-3 py-4 text-center">
                  No HQ notes on file yet.
                </div>
              ) : hqEntries.map((e) => (
                <div key={e.id}
                     data-testid={`hq-note-only-entry-${e.id}`}
                     className="border border-amber-200 bg-amber-50/60 rounded-md px-3 py-2.5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="text-[11px] font-bold text-amber-900">
                      {e.updated_by_name || e.updated_by || "HQ"}
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="text-[10px] text-amber-700 tabular-nums">
                        {e.updated_at ? new Date(e.updated_at).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/London" }) : ""}
                      </div>
                      {onDelete && (
                        <button
                          type="button"
                          onClick={() => deleteEntry(e.id)}
                          className="text-[10px] uppercase tracking-wider text-red-600 hover:text-red-800"
                          data-testid={`hq-note-only-entry-delete-${e.id}`}
                        >Delete</button>
                      )}
                    </div>
                  </div>
                  <div className="text-sm text-stone-950 whitespace-pre-wrap mt-1 leading-relaxed">{e.note}</div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="px-5 py-3 border-t border-stone-200 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-2 text-xs uppercase tracking-wider font-bold rounded bg-white border border-stone-300 text-stone-700 hover:bg-stone-50"
          >Close</button>
        </div>
      </div>
    </div>
  );
}

function DetailRow({ icon: Icon, label, children }) {
  return (
    <div className="flex items-start gap-2">
      <Icon className="w-3.5 h-3.5 text-stone-400 mt-1 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="text-[10px] uppercase tracking-wider font-bold text-stone-500">{label}</div>
        <div className="text-stone-900 text-sm break-words">{children}</div>
      </div>
    </div>
  );
}
