// Admin Territory Builder.
//
// Flow:
//   1. Search a postcode → marker dropped, surrounding sectors loaded
//   2. Adjust radius (5-30 km) → reload sectors
//   3. Click sector dots on the map (or chips below) to add/remove from
//      the territory. Live home counter at the top targets 150.
//   4. Save → either as a brand-new "Territory Plan" linked to a contact
//      or update an existing plan. Plans are editable and persisted.
import { useEffect, useMemo, useState, useCallback } from "react";
import { Link, useSearchParams } from "react-router-dom";
import api from "@/lib/api";
import TerritoryMap from "@/components/territory/TerritoryMap";
import {
  Search, Loader2, Target, Save, Trash2, MapPin, Plus, RotateCcw,
  Users, AlertCircle, CheckCircle2, Pencil, ChevronRight, ArrowLeft,
  ClipboardPaste, Layers, Eye, EyeOff, ChevronDown, ChevronUp,
  Share2, Copy, Link as LinkIcon, FolderOpen,
} from "lucide-react";

const TARGET_HOMES = 150;
const KM_PER_MI = 1.609344;

export default function TerritoryBuilderPage() {
  const [params] = useSearchParams();
  const contactId = params.get("contact_id") || null;
  const planId = params.get("plan_id") || null;
  const franchiseeId = params.get("franchisee_id") || null;

  const [postcode, setPostcode] = useState("");
  const [centre, setCentre] = useState(null);
  const [centreLabel, setCentreLabel] = useState("");
  const [radiusMi, setRadiusMi] = useState(10); // miles
  const [sectors, setSectors] = useState([]);
  const [selected, setSelected] = useState([]);
  const [loading, setLoading] = useState(false);
  const [savedPlan, setSavedPlan] = useState(null);
  const [err, setErr] = useState("");
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");
  const [contact, setContact] = useState(null);
  const [existingPlans, setExistingPlans] = useState([]);
  const [saving, setSaving] = useState(false);
  const [franchisee, setFranchisee] = useState(null);
  const [territorySavedAt, setTerritorySavedAt] = useState(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [pastePreview, setPastePreview] = useState(null);
  // Overlay: every active franchisee's locked territory. Loaded once on mount,
  // refreshed whenever the lock-target changes so the franchisee being edited
  // isn't duplicated in the background.
  const [overlay, setOverlay] = useState({ franchisees: [], geojson: null, outlines: null });
  const [showOverlay, setShowOverlay] = useState(true);
  // Legend panel is collapsible — admins who already know the colours can
  // tuck it away to give the map more vertical real estate. Persisted across
  // sessions so the preference sticks.
  const [legendOpen, setLegendOpen] = useState(() => {
    try { return localStorage.getItem("cm.tb.legendOpen") !== "0"; }
    catch { return true; }
  });
  useEffect(() => {
    try { localStorage.setItem("cm.tb.legendOpen", legendOpen ? "1" : "0"); }
    catch (e) { console.debug("[TerritoryBuilder] localStorage write blocked", e); }
  }, [legendOpen]);

  // Selected / Nearby sectors panels now collapsible below the map — defaults
  // closed so the map gets all the screen real-estate when admins land here.
  const [selectedListOpen, setSelectedListOpen] = useState(() => {
    try { return localStorage.getItem("cm.tb.selectedOpen") === "1"; }
    catch { return false; }
  });
  const [nearbyListOpen, setNearbyListOpen] = useState(() => {
    try { return localStorage.getItem("cm.tb.nearbyOpen") === "1"; }
    catch { return false; }
  });
  useEffect(() => { try { localStorage.setItem("cm.tb.selectedOpen", selectedListOpen ? "1" : "0"); } catch (e) { console.debug("[TerritoryBuilder] localStorage write blocked", e); } }, [selectedListOpen]);
  useEffect(() => { try { localStorage.setItem("cm.tb.nearbyOpen", nearbyListOpen ? "1" : "0"); } catch (e) { console.debug("[TerritoryBuilder] localStorage write blocked", e); } }, [nearbyListOpen]);

  // All saved plans — listed in the bottom-right "Saved plans" panel when
  // there's no contact/franchisee context (e.g. opened via the sidebar).
  // Lets admins re-open prior prospect plans + share/copy/delete them.
  const [allPlans, setAllPlans] = useState([]);
  const [allPlansLoading, setAllPlansLoading] = useState(false);
  const [planFilter, setPlanFilter] = useState("");

  const reloadAllPlans = useCallback(async () => {
    setAllPlansLoading(true);
    try {
      const { data } = await api.get("/territory-plans");
      setAllPlans(data.plans || []);
    } catch (e) {
      console.error("[TerritoryBuilder] Failed to load saved plans", e);
    }
    finally { setAllPlansLoading(false); }
  }, []);

  useEffect(() => {
    if (contactId || franchiseeId) return;  // panel only relevant globally
    reloadAllPlans();
  }, [contactId, franchiseeId, reloadAllPlans]);

  // Load contact details + existing plans if contact_id is provided
  useEffect(() => {
    if (!contactId) return;
    (async () => {
      try {
        const c = await api.get(`/contacts/${contactId}`);
        // Endpoint returns {contact: {...}, _source_collection: "..."} so
        // unwrap the nested object (falling back to the raw data for any
        // older code-paths that already returned a flat contact).
        setContact(c.data?.contact || c.data);
      } catch (e) {
        console.error("[TerritoryBuilder] Failed to load contact", contactId, e);
      }
      try {
        const p = await api.get("/territory-plans", { params: { contact_id: contactId } });
        setExistingPlans(p.data.plans || []);
      } catch (e) {
        console.error("[TerritoryBuilder] Failed to load existing plans for contact", contactId, e);
      }
    })();
  }, [contactId]);

  // Hydrate existing franchisee territory
  useEffect(() => {
    if (!franchiseeId) return;
    (async () => {
      try {
        const { data } = await api.get(`/franchisees/${franchiseeId}/territory`);
        setFranchisee(data);
        setSelected(data.territory_sectors || []);
        setTerritorySavedAt(data.territory_updated_at);
        if (data.postcode) {
          setPostcode(data.postcode);
          // Auto-lookup so map centres on HQ
          try {
            const r = await api.get("/territory/postcode-lookup", { params: { postcode: data.postcode } });
            if (r.data.latitude != null) {
              setCentre({ lat: r.data.latitude, lng: r.data.longitude });
              setCentreLabel(`${data.organisation || ""} · ${r.data.postcode}`);
            }
          } catch (e) {
            console.error("[TerritoryBuilder] Postcode lookup failed", e);
          }
        }
      } catch (e) {
        console.error("[TerritoryBuilder] Failed to load franchisee territory", franchiseeId, e);
      }
    })();
  }, [franchiseeId]);

  // Hydrate an existing plan
  useEffect(() => {
    if (!planId) return;
    (async () => {
      try {
        const { data } = await api.get("/territory-plans", { params: {} });
        const found = (data.plans || []).find((p) => p.id === planId);
        if (!found) return;
        setSavedPlan(found);
        setName(found.name || "");
        setNotes(found.notes || "");
        setSelected(found.sectors || []);
        if (found.centre_lat && found.centre_lng) {
          setCentre({ lat: found.centre_lat, lng: found.centre_lng });
          setCentreLabel(found.centre_postcode || "");
          setPostcode(found.centre_postcode || "");
        }
      } catch (e) {
        console.error("[TerritoryBuilder] Failed to hydrate plan", planId, e);
      }
    })();
  }, [planId]);

  // Load every active franchisee's locked territory so admins can draw
  // prospect plans against existing boundaries. Re-fetches when the lock
  // target changes so we never duplicate the franchisee being edited in
  // both the active layer and the background overlay.
  useEffect(() => {
    (async () => {
      try {
        const { data } = await api.get("/territory/all-franchisees", {
          params: franchiseeId ? { exclude_id: franchiseeId } : {},
        });
        setOverlay({
          franchisees: data.franchisees || [],
          geojson: data.geojson || null,
          outlines: data.outlines || null,
        });
      } catch (e) {
        console.warn("[TerritoryBuilder] Overlay (other franchisees) failed to load — non-critical", e);
      }
    })();
  }, [franchiseeId]);

  // Refresh sectors-near when centre or radius changes. When in
  // franchisee-lock mode, also fetch the geometry of every owned sector
  // (even those outside the search radius) so the map always shows
  // the full territory.
  const refreshSectors = useCallback(async () => {
    if (!centre && !franchiseeId) return;
    setLoading(true); setErr("");
    try {
      let near = { sectors: [] };
      if (centre) {
        const { data } = await api.get("/territory/sectors-near", {
          params: { lat: centre.lat, lon: centre.lng, radius_km: radiusMi * KM_PER_MI },
        });
        near = data;
      }
      let owned = [];
      const ownedCodes = (franchiseeId && franchisee?.territory_sectors) || [];
      if (ownedCodes.length) {
        const { data } = await api.get("/territory/sector-polygons", {
          params: { sectors: ownedCodes.join(",") },
        });
        owned = data.sectors || [];
      }
      // Merge — favouring "near" entries for distance info, but ensuring
      // every owned sector ends up in the feature list.
      const map = new Map();
      for (const s of near.sectors || []) map.set(s.sector, s);
      for (const s of owned) {
        if (!map.has(s.sector)) map.set(s.sector, { ...s, distance_km: 9999 });
      }
      setSectors(Array.from(map.values()));
    } catch (e) {
      setErr(e?.response?.data?.detail || "Could not load sectors.");
    } finally { setLoading(false); }
  }, [centre, radiusMi, franchiseeId, franchisee]);
  useEffect(() => { refreshSectors(); }, [refreshSectors]);

  const lookupPostcode = async () => {
    if (!postcode.trim()) return;
    setLoading(true); setErr("");
    try {
      const { data } = await api.get("/territory/postcode-lookup", { params: { postcode: postcode.trim() } });
      if (data.latitude == null) throw new Error("No coordinates");
      setCentre({ lat: data.latitude, lng: data.longitude });
      setCentreLabel(`${data.postcode} · ${data.admin_district || data.region || ""}`);
    } catch (e) {
      setErr(e?.response?.data?.detail || "Postcode not found");
    } finally { setLoading(false); }
  };

  const toggleSector = (sec) => {
    setSelected((cur) => cur.includes(sec) ? cur.filter((s) => s !== sec) : [...cur, sec]);
  };

  // Live home count for the selected sectors (server-side authority)
  const [homeCount, setHomeCount] = useState({ count: 0, per_sector: {} });
  useEffect(() => {
    if (!selected.length) { setHomeCount({ count: 0, per_sector: {} }); return; }
    let cancelled = false;
    (async () => {
      try {
        const { data } = await api.get("/territory/homes-count", { params: { sectors: selected.join(",") } });
        if (!cancelled) setHomeCount(data);
      } catch (e) {
        console.error("[TerritoryBuilder] homes-count failed", e);
      }
    })();
    return () => { cancelled = true; };
  }, [selected]);

  const progress = Math.min(100, Math.round((homeCount.count / TARGET_HOMES) * 100));

  const save = async () => {
    if (!selected.length || (!centre && !franchiseeId)) { setErr("Pick a postcode and at least one sector first."); return; }
    setSaving(true); setErr("");
    try {
      if (franchiseeId) {
        // Locking a franchisee's official territory
        const { data } = await api.put(`/franchisees/${franchiseeId}/territory`, { sectors: selected });
        setTerritorySavedAt(new Date().toISOString());
        setFranchisee((cur) => cur ? { ...cur, territory_sectors: data.sectors, territory_home_count: data.home_count } : cur);
      } else {
        const body = {
          contact_id: contactId,
          name: name || (centreLabel ? `Territory near ${centreLabel}` : `Territory plan`),
          centre_postcode: postcode || null,
          centre_lat: centre.lat,
          centre_lng: centre.lng,
          sectors: selected,
          home_count: homeCount.count,
          notes,
        };
        if (savedPlan?.id) {
          const { data } = await api.patch(`/territory-plans/${savedPlan.id}`, body);
          setSavedPlan(data);
        } else {
          const { data } = await api.post("/territory-plans", body);
          setSavedPlan(data);
        }
        reloadAllPlans();
      }
    } catch (e) {
      setErr(e?.response?.data?.detail || "Could not save");
    } finally { setSaving(false); }
  };

  // ---- contact-link helpers ------------------------------------------------
  // Lets admins attach a previously-drafted territory to a contact that just
  // landed (or move it to a different contact).
  const linkPlanToContact = async (plan, contactId) => {
    if (!plan?.id) return;
    try {
      const { data } = await api.post(`/territory-plans/${plan.id}/link-contact`, {
        contact_id: contactId || null,
      });
      // Reload the saved-plans list so the new contact_name attaches.
      await reloadAllPlans();
      if (savedPlan?.id === plan.id) setSavedPlan(data);
    } catch (e) {
      setErr(e?.response?.data?.detail || "Couldn't link contact.");
    }
  };

  const deletePlan = async () => {
    if (!savedPlan?.id) return;
    if (!window.confirm("Delete this territory plan?")) return;
    await api.delete(`/territory-plans/${savedPlan.id}`);
    setSavedPlan(null);
    setSelected([]);
    setName("");
    setNotes("");
    reloadAllPlans();
  };

  // ---- share link helpers -------------------------------------------------
  const [shareCopied, setShareCopied] = useState(false);

  const shareUrlFor = (token) => `${window.location.origin}/share/territory/${token}`;

  const toggleShare = async (plan) => {
    if (!plan?.id) return null;
    try {
      if (plan.is_shared && plan.share_token) {
        await api.delete(`/territory-plans/${plan.id}/share`);
        const next = { ...plan, is_shared: false, share_token: null };
        if (savedPlan?.id === plan.id) setSavedPlan(next);
        setAllPlans((cur) => cur.map((p) => p.id === plan.id ? next : p));
        return null;
      }
      const { data } = await api.post(`/territory-plans/${plan.id}/share`);
      const next = { ...plan, is_shared: true, share_token: data.share_token };
      if (savedPlan?.id === plan.id) setSavedPlan(next);
      setAllPlans((cur) => cur.map((p) => p.id === plan.id ? next : p));
      return data.share_token;
    } catch (e) {
      setErr(e?.response?.data?.detail || "Could not update sharing.");
      return null;
    }
  };

  const copyShareLink = async (plan) => {
    let token = plan?.share_token;
    if (!token) {
      token = await toggleShare(plan);
      if (!token) return;
    }
    try {
      await navigator.clipboard.writeText(shareUrlFor(token));
      setShareCopied(true);
      setTimeout(() => setShareCopied(false), 1800);
    } catch (e) {
      console.warn("[TerritoryBuilder] Clipboard copy blocked", e);
    }
  };

  const deletePlanById = async (id) => {
    if (!window.confirm("Delete this territory plan?")) return;
    try {
      await api.delete(`/territory-plans/${id}`);
      setAllPlans((cur) => cur.filter((p) => p.id !== id));
      if (savedPlan?.id === id) {
        setSavedPlan(null);
        setSelected([]);
      }
    } catch (e) {
      setErr(e?.response?.data?.detail || "Delete failed");
    }
  };

  const sortedSelected = useMemo(() => [...selected].sort(), [selected]);

  return (
    <div className="p-6 max-w-[1600px] mx-auto space-y-5" data-testid="territory-builder">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-2 text-xs uppercase tracking-[0.3em] font-bold text-stone-500 mb-1">
            <Target className="w-3.5 h-3.5" /> {franchiseeId ? "Lock franchisee territory" : "Territory Builder"}
          </div>
          <h1 className="font-display text-3xl text-stone-950">
            {franchiseeId
              ? (franchisee ? `Set territory for ${franchisee.organisation || ("#" + franchisee.franchise_number)}` : "Set franchisee territory")
              : contact ? `Plan a territory for ${contact.first_name} ${contact.last_name}` : "Build a prospect territory"}
          </h1>
          {franchiseeId && (
            <Link to={`/franchisees/${franchiseeId}`} className="text-xs text-stone-500 hover:underline inline-flex items-center gap-1 mt-1">
              <ArrowLeft className="w-3 h-3" /> Back to franchisee
            </Link>
          )}
          {contact && !franchiseeId && (
            <Link to={`/contacts/${contact.id}`} className="text-xs text-stone-500 hover:underline inline-flex items-center gap-1 mt-1">
              <ArrowLeft className="w-3 h-3" /> Back to contact
            </Link>
          )}
        </div>
        <div className="bg-white border border-stone-200 rounded-xl p-4 flex items-center gap-5">
          <div>
            <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-500">Homes</div>
            <div className="font-display text-3xl text-stone-950 tabular-nums" data-testid="home-count">{homeCount.count}{!franchiseeId && <span className="text-stone-400 text-lg"> / {TARGET_HOMES}</span>}</div>
          </div>
          <div className="w-40">
            <div className="h-2 bg-stone-100 rounded-full overflow-hidden">
              <div className="h-full transition-all bg-emerald-500" style={{ width: franchiseeId ? "100%" : `${progress}%` }} />
            </div>
            <div className="text-[10px] text-stone-500 mt-1">{selected.length} sector{selected.length === 1 ? "" : "s"} selected</div>
          </div>
        </div>
      </div>

      {/* Existing plans for this contact */}
      {existingPlans.length > 0 && !savedPlan && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm" data-testid="existing-plans">
          <div className="font-bold text-amber-900 mb-1">Existing plans for this contact</div>
          <div className="flex flex-wrap gap-2">
            {existingPlans.map((p) => (
              <Link key={p.id} to={`/territory-builder?contact_id=${contactId}&plan_id=${p.id}`}
                className="px-3 py-1.5 text-xs font-bold rounded-md bg-white border border-amber-300 hover:bg-amber-100">
                {p.name || "Untitled"} · {p.home_count || 0} homes
                <ChevronRight className="inline w-3 h-3 ml-0.5" />
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Search bar */}
      <div className="bg-white border border-stone-200 rounded-2xl p-4 flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2 flex-1 min-w-[260px]">
          <Search className="w-4 h-4 text-stone-400" />
          <input value={postcode} onChange={(e) => setPostcode(e.target.value)} data-testid="postcode-input"
            onKeyDown={(e) => { if (e.key === "Enter") lookupPostcode(); }}
            placeholder="Type the contact's postcode (e.g. EX15 1NB)"
            className="flex-1 px-2 py-1.5 text-sm bg-transparent outline-none placeholder:text-stone-400" />
          <button onClick={lookupPostcode} disabled={loading || !postcode.trim()} data-testid="lookup-postcode"
            className="px-3 py-2 text-xs font-bold uppercase tracking-wider bg-stone-950 text-white hover:bg-stone-800 rounded-lg disabled:opacity-50 flex items-center gap-1.5">
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <MapPin className="w-3.5 h-3.5" />}
            Drop marker
          </button>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span className="text-stone-500 font-bold uppercase tracking-wider">Radius</span>
          <input type="range" min="3" max="30" step="1" value={radiusMi}
            onChange={(e) => setRadiusMi(+e.target.value)} className="w-32" data-testid="radius-slider" />
          <span className="tabular-nums font-bold text-stone-900">{radiusMi} mi</span>
        </div>
        <button onClick={() => setPasteOpen(true)} data-testid="open-paste"
          className="px-3 py-2 text-xs font-bold uppercase tracking-wider bg-white border border-stone-300 text-stone-900 hover:bg-stone-50 rounded-lg flex items-center gap-1.5">
          <ClipboardPaste className="w-3.5 h-3.5" /> Paste sectors
        </button>
      </div>

      {err && (
        <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-xl flex items-center gap-1.5">
          <AlertCircle className="w-4 h-4" /> {err}
        </div>
      )}

      <div className="space-y-5">
        {/* Map — full width, taller for more breathing room */}
        <div className="space-y-3">
          {/* Overlay toggle + collapsible legend so admins can see which
              colour belongs to which franchisee. Header stays slim; the
              chip grid below collapses to give the map more room. */}
          <div className="bg-white border border-stone-200 rounded-2xl">
            <div className="p-3 flex items-center gap-3 flex-wrap">
              <button
                onClick={() => setShowOverlay((v) => !v)}
                data-testid="toggle-franchisee-overlay"
                className={`px-3 py-2 text-[11px] font-bold uppercase tracking-wider rounded-lg border flex items-center gap-1.5 shrink-0 ${showOverlay ? "bg-stone-950 text-white border-stone-950" : "bg-white text-stone-700 border-stone-300 hover:bg-stone-50"}`}
                title={showOverlay ? "Hide every franchisee's territory" : "Show every franchisee's territory"}
              >
                {showOverlay ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
                <Layers className="w-3.5 h-3.5" />
                {overlay.franchisees.length} live franchisee{overlay.franchisees.length === 1 ? "" : "s"}
              </button>
              {showOverlay && overlay.franchisees.length > 0 && (
                <button
                  onClick={() => setLegendOpen((v) => !v)}
                  data-testid="toggle-legend"
                  className="ml-auto text-[11px] font-bold uppercase tracking-wider text-stone-600 hover:text-stone-950 flex items-center gap-1.5 px-2 py-1.5 rounded-md hover:bg-stone-50"
                >
                  {legendOpen ? "Hide legend" : "Show legend"}
                  {legendOpen ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                </button>
              )}
            </div>
            {showOverlay && legendOpen && overlay.franchisees.length > 0 && (
              <div className="px-3 pb-3 grid grid-cols-2 md:grid-cols-3 gap-1.5" data-testid="franchisee-legend">
                {overlay.franchisees.map((f) => (
                  <button
                    key={f.id}
                    onClick={() => {
                      if (f.hq_lat != null && f.hq_lng != null) setCentre({ lat: f.hq_lat, lng: f.hq_lng });
                    }}
                    title={`Jump to ${f.name}${f.owner_name ? " · " + f.owner_name : ""}${f.postcode ? " · " + f.postcode : ""}`}
                    className="inline-flex items-center gap-1.5 px-2 py-1 text-[10px] font-bold rounded-md border border-stone-200 bg-stone-50 hover:bg-stone-100 min-w-0"
                    data-testid={`legend-${f.id}`}
                  >
                    <span className="w-2.5 h-2.5 rounded-full border border-white shadow-sm shrink-0" style={{ background: f.color }} />
                    <span className="truncate">{f.franchise_number ? `#${f.franchise_number} ` : ""}{f.name}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <TerritoryMap
            sectors={sectors}
            selected={selected}
            centre={centre}
            centreLabel={centreLabel}
            onToggleSector={toggleSector}
            height={820}
            franchiseeOverlay={showOverlay ? overlay : null}
          />
          {/* Live homes-count bar — sits directly below the map so the
              number is in the user's eyeline as they click sectors. Sticky
              to the bottom of the viewport so it stays visible even while
              scrolling through nearby-sectors lists. */}
          <div
            data-testid="live-homes-bar"
            className="sticky bottom-3 z-20 mt-2 bg-white border-2 border-stone-950 rounded-xl shadow-lg px-4 py-2.5 flex items-center gap-4 flex-wrap"
          >
            <div className="flex items-baseline gap-2">
              <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-500">Homes</div>
              <div className="font-display text-2xl text-stone-950 tabular-nums leading-none" data-testid="home-count-live">
                {homeCount.count}
                {!franchiseeId && <span className="text-stone-400 text-base"> / {TARGET_HOMES}</span>}
              </div>
            </div>
            <div className="flex-1 min-w-[140px] max-w-xs">
              <div className="h-2 bg-stone-100 rounded-full overflow-hidden">
                <div
                  className={`h-full transition-all ${
                    franchiseeId ? "bg-emerald-500"
                    : homeCount.count >= TARGET_HOMES ? "bg-emerald-500"
                    : homeCount.count >= TARGET_HOMES * 0.8 ? "bg-amber-400"
                    : "bg-stone-400"
                  }`}
                  style={{ width: franchiseeId ? "100%" : `${progress}%` }}
                />
              </div>
              <div className="text-[10px] text-stone-500 mt-1 tabular-nums">
                {selected.length} sector{selected.length === 1 ? "" : "s"} selected
                {!franchiseeId && homeCount.count > 0 && (
                  <> · {homeCount.count >= TARGET_HOMES
                    ? <span className="text-emerald-700 font-bold">target met</span>
                    : <span>{TARGET_HOMES - homeCount.count} to go</span>}</>
                )}
              </div>
            </div>
          </div>
          <div className="text-[11px] text-stone-500 mt-2 flex items-center gap-3 flex-wrap">
            <span className="inline-flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm bg-[#dddd16] border border-[#14532D]" /> Selected sector</span>
            <span className="inline-flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm bg-stone-200 border border-stone-400" /> Available sector</span>
            <span className="inline-flex items-center gap-1.5"><span className="w-3 h-3 rounded-full bg-red-500 border-2 border-white shadow" /> Contact's postcode</span>
            <span className="inline-flex items-center gap-1.5"><span className="w-3 h-3 rounded-full bg-indigo-500 border-2 border-white shadow" /> Existing franchisee HQ</span>
            <span className="text-stone-400">·</span>
            <span>Click a coloured area or pin to identify the franchisee</span>
          </div>
        </div>

        {/* Below-map panels — Plan Details stays expanded (primary actions),
            Selected + Nearby sectors collapse so they don't crowd the map.
            `items-start` keeps each card sized to its own content; without
            it the grid stretches the two collapsibles to match Plan Details'
            height, making them *look* expanded when they're actually shut. */}
        <div className="grid lg:grid-cols-3 gap-4 items-start">
          <div className="bg-white border border-stone-200 rounded-2xl p-4">
            <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-500 mb-2">{franchiseeId ? "Franchisee territory" : "Plan details"}</div>
            {!franchiseeId && (
              <>
                <input value={name} onChange={(e) => setName(e.target.value)} data-testid="plan-name"
                  placeholder="Plan name (e.g. Exeter & Mid Devon proposal)"
                  className="w-full px-3 py-2 text-sm bg-stone-50 border border-stone-200 rounded-lg mb-2" />
                <textarea value={notes} onChange={(e) => setNotes(e.target.value)} data-testid="plan-notes"
                  rows={3} placeholder="Notes (optional)"
                  className="w-full px-3 py-2 text-sm bg-stone-50 border border-stone-200 rounded-lg" />
              </>
            )}
            {franchiseeId && (
              <div className="text-xs text-stone-600 leading-relaxed">
                Pick every postcode sector that belongs to this franchisee. Saving overwrites their official territory — they'll see it on their portal map immediately, and the public website lookup will route those postcodes here.
              </div>
            )}
            <div className="flex items-center gap-2 mt-3">
              <button onClick={save} disabled={saving || !selected.length} data-testid="save-plan"
                className="flex-1 px-3 py-2 text-xs font-bold uppercase tracking-wider bg-[#dddd16] text-stone-950 hover:bg-[#aaaa11] rounded-lg disabled:opacity-50 flex items-center justify-center gap-1.5">
                {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                {franchiseeId ? "Lock territory" : (savedPlan ? "Update plan" : "Save plan")}
              </button>
              {savedPlan && !franchiseeId && (
                <button onClick={deletePlan} className="px-3 py-2 text-xs font-bold rounded-lg border border-red-300 text-red-700 hover:bg-red-50" data-testid="delete-plan">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              )}
              <button onClick={() => { setSelected([]); }} className="px-3 py-2 text-xs font-bold rounded-lg border border-stone-300 hover:bg-stone-50" title="Clear all sectors">
                <RotateCcw className="w-3.5 h-3.5" />
              </button>
            </div>
            {savedPlan && !franchiseeId && (
              <div className="mt-3 px-3 py-2 text-[11px] bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-lg flex items-center gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5" /> Saved · last update {new Date(savedPlan.updated_at || savedPlan.created_at).toLocaleString()}
              </div>
            )}
            {/* Share link controls — only when a plan is saved. The admin
                toggles sharing on/off; while on, "Copy link" places a
                /share/territory/<token> URL on the clipboard for prospects. */}
            {savedPlan && !franchiseeId && (
              <div className="mt-2 px-3 py-2 border border-stone-200 bg-stone-50 rounded-lg space-y-2" data-testid="share-controls">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 text-[11px] font-bold text-stone-700">
                    <Share2 className="w-3.5 h-3.5" />
                    Share with prospect
                  </div>
                  <button
                    onClick={() => toggleShare(savedPlan)}
                    data-testid="share-toggle"
                    className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full transition-colors ${
                      savedPlan.is_shared
                        ? "bg-emerald-600 text-white hover:bg-emerald-700"
                        : "bg-stone-200 text-stone-700 hover:bg-stone-300"
                    }`}
                  >
                    {savedPlan.is_shared ? "On" : "Off"}
                  </button>
                </div>
                {savedPlan.is_shared && savedPlan.share_token && (
                  <>
                    <div className="flex items-center gap-1.5">
                      <input
                        readOnly
                        value={shareUrlFor(savedPlan.share_token)}
                        data-testid="share-url"
                        onFocus={(e) => e.target.select()}
                        className="flex-1 px-2 py-1 text-[11px] font-mono bg-white border border-stone-300 rounded text-stone-700"
                      />
                      <button
                        onClick={() => copyShareLink(savedPlan)}
                        data-testid="share-copy"
                        className="px-2 py-1 text-[10px] font-bold rounded border border-stone-300 bg-white hover:bg-stone-50 flex items-center gap-1"
                        title="Copy link"
                      >
                        <Copy className="w-3 h-3" />
                        {shareCopied ? "Copied" : "Copy"}
                      </button>
                    </div>
                    <div className="text-[10px] text-stone-500">
                      Anyone with this link can view the territory (no login).
                      {savedPlan.view_count ? ` · Opened ${savedPlan.view_count}×` : ""}
                    </div>
                  </>
                )}
                {!savedPlan.is_shared && (
                  <div className="text-[10px] text-stone-500">
                    Turn on to generate a public read-only link.
                  </div>
                )}
              </div>
            )}
            {franchiseeId && territorySavedAt && (
              <div className="mt-3 px-3 py-2 text-[11px] bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-lg flex items-center gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5" /> Locked · {new Date(territorySavedAt).toLocaleString()}
              </div>
            )}
          </div>

          {/* Selected sectors list — collapsible */}
          <div className="bg-white border border-stone-200 rounded-2xl">
            <button
              type="button"
              onClick={() => setSelectedListOpen((v) => !v)}
              data-testid="toggle-selected-sectors"
              className="w-full flex items-center justify-between gap-3 p-4 hover:bg-stone-50 rounded-2xl"
            >
              <span className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-500">Selected sectors ({sortedSelected.length})</span>
              {selectedListOpen ? <ChevronUp className="w-4 h-4 text-stone-500" /> : <ChevronDown className="w-4 h-4 text-stone-500" />}
            </button>
            {selectedListOpen && (
              <div className="px-4 pb-4">
                {!sortedSelected.length && <div className="text-xs text-stone-500">Click sectors on the map to add them here.</div>}
                <div className="flex flex-wrap gap-1.5 max-h-72 overflow-auto">
                  {sortedSelected.map((s) => (
                    <button key={s} onClick={() => toggleSector(s)} data-testid={`chip-selected-${s}`}
                      className="group inline-flex items-center gap-1 px-2 py-1 text-[10px] font-bold uppercase tracking-wider bg-stone-950 text-white hover:bg-red-700 rounded-md">
                      {s} · {homeCount.per_sector?.[s] || 0}
                      <Trash2 className="w-3 h-3 opacity-0 group-hover:opacity-100 transition-opacity" />
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Sectors in radius — collapsible */}
          <div className="bg-white border border-stone-200 rounded-2xl">
            <button
              type="button"
              onClick={() => setNearbyListOpen((v) => !v)}
              data-testid="toggle-nearby-sectors"
              className="w-full flex items-center justify-between gap-3 p-4 hover:bg-stone-50 rounded-2xl"
            >
              <span className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-500 flex items-center gap-2">
                Nearby sectors ({sectors.length})
                {loading && <Loader2 className="w-3.5 h-3.5 animate-spin text-stone-400" />}
              </span>
              {nearbyListOpen ? <ChevronUp className="w-4 h-4 text-stone-500" /> : <ChevronDown className="w-4 h-4 text-stone-500" />}
            </button>
            {nearbyListOpen && (
              <div className="px-4 pb-4 max-h-72 overflow-auto space-y-1">
                {sectors.map((s) => {
                  const isSel = selected.includes(s.sector);
                  return (
                    <button key={s.sector} onClick={() => toggleSector(s.sector)} data-testid={`chip-near-${s.sector}`}
                      className={`w-full flex items-center justify-between gap-2 px-2.5 py-1.5 text-xs rounded-lg text-left ${isSel ? "bg-stone-950 text-white" : "hover:bg-stone-50 text-stone-800"}`}>
                      <span className="font-bold">{s.sector}</span>
                      <span className="tabular-nums">{s.home_count} homes · {(s.distance_km / KM_PER_MI).toFixed(1)} mi</span>
                      {isSel ? <CheckCircle2 className="w-3.5 h-3.5 text-[#dddd16] shrink-0" /> : <Plus className="w-3.5 h-3.5 text-stone-400 shrink-0" />}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Saved territory plans — only shown when there's no contact
              or franchisee context (i.e. user opened the page from the
              sidebar). Lets admins re-open a prior prospect plan and
              copy a share link without leaving the page. */}
        </div>

        {!contactId && !franchiseeId && (
          <SavedPlansPanel
            plans={allPlans}
            loading={allPlansLoading}
            filter={planFilter}
            onFilter={setPlanFilter}
            activeId={savedPlan?.id || planId}
            onCopyShare={copyShareLink}
            onToggleShare={toggleShare}
            onDelete={deletePlanById}
            onLinkContact={linkPlanToContact}
            shareUrlFor={shareUrlFor}
            shareCopied={shareCopied}
          />
        )}
      </div>

      {/* Paste-sectors modal */}
      {pasteOpen && (
        <div onClick={() => setPasteOpen(false)} className="fixed inset-0 z-50 bg-stone-950/70 backdrop-blur-sm flex items-center justify-center p-6" data-testid="paste-modal">
          <div onClick={(e) => e.stopPropagation()} className="bg-white rounded-2xl shadow-2xl max-w-2xl w-full">
            <div className="px-5 py-4 border-b border-stone-200 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <ClipboardPaste className="w-4 h-4 text-stone-700" />
                <span className="font-bold text-stone-950">Paste postcode sectors</span>
              </div>
              <button onClick={() => setPasteOpen(false)} className="w-8 h-8 hover:bg-stone-100 rounded-md flex items-center justify-center">
                <RotateCcw className="w-4 h-4" />
              </button>
            </div>
            <div className="p-5 space-y-3">
              <p className="text-xs text-stone-600">Paste a list of postcode sectors — one per line, comma- or space-separated all work. e.g. <code className="bg-stone-100 px-1 rounded">BA7 7</code>, <code className="bg-stone-100 px-1 rounded">BA20 1</code>, <code className="bg-stone-100 px-1 rounded">DT9 4</code>…</p>
              <textarea value={pasteText} onChange={(e) => setPasteText(e.target.value)} data-testid="paste-textarea"
                rows={10} placeholder="BA7 7&#10;BA20 1&#10;BA20 2&#10;DT1 1&#10;…"
                className="w-full px-3 py-2 text-sm font-mono bg-stone-50 border border-stone-200 rounded-lg" />
              {pastePreview && (
                <div className="text-xs space-y-1">
                  <div className="text-emerald-700">
                    <strong>{pastePreview.sectors.length}</strong> sectors recognised · <strong>{pastePreview.home_count}</strong> homes
                  </div>
                  {pastePreview.unrecognised.length > 0 && (
                    <div className="text-amber-700">
                      <strong>{pastePreview.unrecognised.length}</strong> not recognised: {pastePreview.unrecognised.slice(0, 6).join(", ")}{pastePreview.unrecognised.length > 6 ? "…" : ""}
                    </div>
                  )}
                </div>
              )}
              <div className="flex items-center justify-end gap-2 pt-2">
                <button onClick={() => setPasteOpen(false)} className="px-3 py-2 text-xs font-bold rounded-lg border border-stone-300 hover:bg-stone-50">Cancel</button>
                <button data-testid="paste-preview"
                  onClick={async () => {
                    try {
                      const { data } = await api.post(`/franchisees/${franchiseeId || "preview"}/territory/parse`, { text: pasteText });
                      setPastePreview(data);
                    } catch (e) {
                      setPastePreview({ sectors: [], unrecognised: [], home_count: 0, error: e?.response?.data?.detail || "Parse failed" });
                    }
                  }}
                  className="px-3 py-2 text-xs font-bold rounded-lg border border-stone-400 hover:bg-stone-50">
                  Preview
                </button>
                <button data-testid="paste-apply"
                  onClick={async () => {
                    let toApply = pastePreview?.sectors;
                    if (!toApply) {
                      try {
                        const { data } = await api.post(`/franchisees/${franchiseeId || "preview"}/territory/parse`, { text: pasteText });
                        toApply = data.sectors;
                      } catch (e) {
                        setErr(e?.response?.data?.detail || "Parse failed");
                        return;
                      }
                    }
                    if (!toApply?.length) return;
                    setSelected((cur) => {
                      const set = new Set([...cur, ...toApply]);
                      return [...set];
                    });
                    setPasteOpen(false);
                    setPasteText("");
                    setPastePreview(null);
                  }}
                  className="px-3 py-2 text-xs font-bold uppercase tracking-wider rounded-lg bg-[#dddd16] text-stone-950 hover:bg-[#aaaa11]">
                  Add to selection
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// -------------------------------- Saved plans panel ---------------------
// Lists every territory plan the admin has saved, with quick actions:
// Open (loads it onto the current map), Copy share link, toggle share,
// Delete. Filter box narrows by plan name / contact / centre postcode.
function SavedPlansPanel({
  plans, loading, filter, onFilter, activeId, onCopyShare, onToggleShare,
  onDelete, onLinkContact, shareUrlFor, shareCopied,
}) {
  const [pickerForPlanId, setPickerForPlanId] = useState(null);
  const [contactQuery, setContactQuery] = useState("");
  const [contactResults, setContactResults] = useState([]);
  const [contactsLoading, setContactsLoading] = useState(false);

  // Debounced contact search — fires once a picker is open.
  useEffect(() => {
    if (!pickerForPlanId) return;
    if (!contactQuery || contactQuery.trim().length < 2) { setContactResults([]); return; }
    const t = setTimeout(async () => {
      setContactsLoading(true);
      try {
        const { data } = await api.get("/contacts", {
          params: { search: contactQuery.trim(), limit: 15 },
        });
        const items = data.items || data.contacts || (Array.isArray(data) ? data : []);
        setContactResults(items);
      } catch (e) {
        console.error("[SavedPlansPanel] contact search failed", e);
        setContactResults([]);
      } finally { setContactsLoading(false); }
    }, 250);
    return () => clearTimeout(t);
  }, [contactQuery, pickerForPlanId]);

  const openPicker = (planId) => {
    setPickerForPlanId(planId);
    setContactQuery("");
    setContactResults([]);
  };
  const closePicker = () => setPickerForPlanId(null);
  const pick = async (plan, contactId) => {
    await onLinkContact(plan, contactId);
    closePicker();
  };

  const filtered = (plans || []).filter((p) => {
    if (!filter.trim()) return true;
    const q = filter.toLowerCase();
    return (
      (p.name || "").toLowerCase().includes(q)
      || (p.contact_name || "").toLowerCase().includes(q)
      || (p.centre_postcode || "").toLowerCase().includes(q)
    );
  });

  return (
    <div className="bg-white border border-stone-200 rounded-2xl p-4" data-testid="saved-plans-panel">
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-500 flex items-center gap-1.5">
          <FolderOpen className="w-3.5 h-3.5" />
          Saved plans ({plans.length})
        </div>
        {loading && <Loader2 className="w-3.5 h-3.5 animate-spin text-stone-400" />}
      </div>

      {plans.length > 5 && (
        <input
          value={filter}
          onChange={(e) => onFilter(e.target.value)}
          placeholder="Filter by name / contact / postcode"
          data-testid="saved-plans-filter"
          className="w-full px-2.5 py-1.5 mb-2 text-xs bg-stone-50 border border-stone-200 rounded-lg"
        />
      )}

      {!plans.length && !loading && (
        <div className="text-xs text-stone-500 leading-relaxed">
          No saved plans yet. Build a territory, give it a name, then click <strong>Save plan</strong>. Saved plans appear here so you can re-open or share them with prospects.
        </div>
      )}

      <div className="max-h-80 overflow-auto space-y-1.5">
        {filtered.map((p) => {
          const isActive = p.id === activeId;
          return (
            <div
              key={p.id}
              data-testid={`saved-plan-${p.id}`}
              className={`group rounded-lg border px-2.5 py-2 transition ${
                isActive
                  ? "border-emerald-400 bg-emerald-50/50"
                  : "border-stone-200 hover:border-stone-300 bg-white"
              }`}
            >
              <Link
                to={`/territory-builder?plan_id=${p.id}${p.contact_id ? `&contact_id=${p.contact_id}` : ""}`}
                data-testid={`saved-plan-open-${p.id}`}
                className="block"
              >
                <div className="text-xs font-bold text-stone-950 truncate flex items-center gap-1.5">
                  {p.name || "Untitled plan"}
                  {isActive && <CheckCircle2 className="w-3 h-3 text-emerald-600" />}
                </div>
                <div className="text-[10px] text-stone-500 truncate mt-0.5">
                  {p.contact_name && <span>{p.contact_name} · </span>}
                  <span className="tabular-nums">{p.home_count || 0} homes · {(p.sectors || []).length} sectors</span>
                  {p.centre_postcode && <span> · {p.centre_postcode}</span>}
                </div>
              </Link>
              <div className="mt-1.5 flex items-center gap-1 flex-wrap">
                <button
                  onClick={() => openPicker(p.id)}
                  data-testid={`saved-plan-link-${p.id}`}
                  className={`px-2 py-1 text-[10px] font-bold uppercase tracking-wider rounded flex items-center gap-1 ${
                    p.contact_id
                      ? "border border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100"
                      : "border border-stone-300 hover:bg-stone-50 text-stone-700"
                  }`}
                  title={p.contact_id ? `Linked to ${p.contact_name || "a contact"} — click to change or unlink` : "Link this plan to a contact"}
                >
                  <Users className="w-3 h-3" />
                  {p.contact_id ? "Linked" : "Link contact"}
                </button>
                <button
                  onClick={() => onCopyShare(p)}
                  data-testid={`saved-plan-share-${p.id}`}
                  className="flex-1 px-2 py-1 text-[10px] font-bold uppercase tracking-wider border border-stone-300 hover:bg-stone-50 rounded flex items-center justify-center gap-1"
                  title={p.is_shared ? "Copy share link" : "Generate and copy share link"}
                >
                  {p.is_shared ? <LinkIcon className="w-3 h-3" /> : <Share2 className="w-3 h-3" />}
                  {p.is_shared
                    ? (shareCopied ? "Copied" : "Copy link")
                    : "Share"}
                </button>
                {p.is_shared && (
                  <button
                    onClick={() => onToggleShare(p)}
                    data-testid={`saved-plan-unshare-${p.id}`}
                    className="px-2 py-1 text-[10px] font-bold rounded border border-stone-300 hover:bg-stone-50 text-stone-600"
                    title="Revoke share link"
                  >
                    <EyeOff className="w-3 h-3" />
                  </button>
                )}
                <button
                  onClick={() => onDelete(p.id)}
                  data-testid={`saved-plan-delete-${p.id}`}
                  className="px-2 py-1 text-[10px] font-bold rounded border border-stone-300 text-red-700 hover:bg-red-50"
                  title="Delete plan"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
              {p.is_shared && p.share_token && (
                <div className="mt-1 text-[10px] text-stone-500 truncate font-mono">
                  {shareUrlFor(p.share_token)}
                </div>
              )}
              {pickerForPlanId === p.id && (
                <div className="mt-2 p-2 bg-stone-50 border border-stone-200 rounded-lg" data-testid={`link-picker-${p.id}`}>
                  {p.contact_id && (
                    <div className="flex items-center justify-between gap-2 mb-2 text-[11px]">
                      <span className="text-stone-700">
                        Currently linked to <strong>{p.contact_name || "a contact"}</strong>
                      </span>
                      <button
                        onClick={() => pick(p, null)}
                        data-testid={`link-picker-unlink-${p.id}`}
                        className="px-2 py-1 text-[10px] font-bold uppercase tracking-wider rounded border border-red-300 text-red-700 hover:bg-red-50"
                      >
                        Unlink
                      </button>
                    </div>
                  )}
                  <input
                    value={contactQuery}
                    onChange={(e) => setContactQuery(e.target.value)}
                    placeholder="Search contacts by name or email…"
                    autoFocus
                    data-testid={`link-picker-search-${p.id}`}
                    className="w-full px-2 py-1.5 text-xs bg-white border border-stone-300 rounded"
                  />
                  <div className="mt-1.5 max-h-40 overflow-auto space-y-0.5">
                    {contactsLoading && (
                      <div className="text-[10px] text-stone-500 px-1 py-0.5 flex items-center gap-1">
                        <Loader2 className="w-3 h-3 animate-spin" /> Searching…
                      </div>
                    )}
                    {!contactsLoading && contactQuery.trim().length >= 2 && contactResults.length === 0 && (
                      <div className="text-[10px] text-stone-500 px-1 py-0.5">No matches.</div>
                    )}
                    {contactResults.map((c) => (
                      <button
                        key={c.id}
                        onClick={() => pick(p, c.id)}
                        data-testid={`link-picker-pick-${p.id}-${c.id}`}
                        className="w-full text-left px-2 py-1 text-[11px] rounded hover:bg-white border border-transparent hover:border-stone-300"
                      >
                        <div className="font-bold text-stone-900 truncate">
                          {c.first_name} {c.last_name}
                          {c.organisation && <span className="text-stone-500 font-normal"> · {c.organisation}</span>}
                        </div>
                        <div className="text-[10px] text-stone-500 truncate">{c.email || c.postcode || c.source}</div>
                      </button>
                    ))}
                  </div>
                  <div className="mt-1.5 flex justify-end">
                    <button
                      onClick={closePicker}
                      className="text-[10px] text-stone-500 hover:text-stone-800 px-1"
                    >
                      Close
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
        {!filtered.length && plans.length > 0 && (
          <div className="text-[11px] text-stone-500 italic px-1 py-2">No plans match "{filter}".</div>
        )}
      </div>
    </div>
  );
}

