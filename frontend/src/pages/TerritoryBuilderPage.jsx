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
  ClipboardPaste,
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

  // Load contact details + existing plans if contact_id is provided
  useEffect(() => {
    if (!contactId) return;
    (async () => {
      try {
        const c = await api.get(`/contacts/${contactId}`);
        setContact(c.data);
      } catch {/* ignore */}
      try {
        const p = await api.get("/territory-plans", { params: { contact_id: contactId } });
        setExistingPlans(p.data.plans || []);
      } catch {/* ignore */}
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
          } catch {/* ignore */}
        }
      } catch {/* ignore */}
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
      } catch {/* ignore */}
    })();
  }, [planId]);

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
        const { data } = await api.get("/territory/sector-geometries", {
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
      } catch {/* ignore */}
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
      }
    } catch (e) {
      setErr(e?.response?.data?.detail || "Could not save");
    } finally { setSaving(false); }
  };

  const deletePlan = async () => {
    if (!savedPlan?.id) return;
    if (!window.confirm("Delete this territory plan?")) return;
    await api.delete(`/territory-plans/${savedPlan.id}`);
    setSavedPlan(null);
    setSelected([]);
    setName("");
    setNotes("");
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

      <div className="grid lg:grid-cols-3 gap-5">
        {/* Map */}
        <div className="lg:col-span-2">
          <TerritoryMap
            sectors={sectors}
            selected={selected}
            centre={centre}
            centreLabel={centreLabel}
            onToggleSector={toggleSector}
            height={620}
          />
          <div className="text-[11px] text-stone-500 mt-2 flex items-center gap-3 flex-wrap">
            <span className="inline-flex items-center gap-1.5"><span className="w-3 h-3 rounded-full bg-stone-950" /> Selected</span>
            <span className="inline-flex items-center gap-1.5"><span className="w-3 h-3 rounded-full bg-white border-2 border-stone-400" /> Available</span>
            <span className="inline-flex items-center gap-1.5"><span className="w-3 h-3 rounded-full bg-red-500 border-2 border-white shadow" /> Contact's postcode</span>
            <span className="text-stone-400">·</span>
            <span>Numbers on each dot are CQC home counts in that sector</span>
          </div>
        </div>

        {/* Side panel */}
        <div className="space-y-4">
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
                className="flex-1 px-3 py-2 text-xs font-bold uppercase tracking-wider bg-[#D4FF00] text-stone-950 hover:bg-[#BDE600] rounded-lg disabled:opacity-50 flex items-center justify-center gap-1.5">
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
            {franchiseeId && territorySavedAt && (
              <div className="mt-3 px-3 py-2 text-[11px] bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-lg flex items-center gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5" /> Locked · {new Date(territorySavedAt).toLocaleString()}
              </div>
            )}
          </div>

          {/* Selected sectors list */}
          <div className="bg-white border border-stone-200 rounded-2xl p-4">
            <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-500 mb-2">Selected sectors ({sortedSelected.length})</div>
            {!sortedSelected.length && <div className="text-xs text-stone-500">Click sectors on the map to add them here.</div>}
            <div className="flex flex-wrap gap-1.5">
              {sortedSelected.map((s) => (
                <button key={s} onClick={() => toggleSector(s)} data-testid={`chip-selected-${s}`}
                  className="group inline-flex items-center gap-1 px-2 py-1 text-[10px] font-bold uppercase tracking-wider bg-stone-950 text-white hover:bg-red-700 rounded-md">
                  {s} · {homeCount.per_sector?.[s] || 0}
                  <Trash2 className="w-3 h-3 opacity-0 group-hover:opacity-100 transition-opacity" />
                </button>
              ))}
            </div>
          </div>

          {/* Sectors in radius */}
          <div className="bg-white border border-stone-200 rounded-2xl p-4">
            <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-500 mb-2 flex items-center justify-between">
              <span>Nearby sectors ({sectors.length})</span>
              {loading && <Loader2 className="w-3.5 h-3.5 animate-spin text-stone-400" />}
            </div>
            <div className="max-h-72 overflow-auto space-y-1">
              {sectors.map((s) => {
                const isSel = selected.includes(s.sector);
                return (
                  <button key={s.sector} onClick={() => toggleSector(s.sector)} data-testid={`chip-near-${s.sector}`}
                    className={`w-full flex items-center justify-between gap-2 px-2.5 py-1.5 text-xs rounded-lg text-left ${isSel ? "bg-stone-950 text-white" : "hover:bg-stone-50 text-stone-800"}`}>
                    <span className="font-bold">{s.sector}</span>
                    <span className="tabular-nums">{s.home_count} homes · {(s.distance_km / KM_PER_MI).toFixed(1)} mi</span>
                    {isSel ? <CheckCircle2 className="w-3.5 h-3.5 text-[#D4FF00] shrink-0" /> : <Plus className="w-3.5 h-3.5 text-stone-400 shrink-0" />}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
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
                    <strong>{pastePreview.sectors.length}</strong> sectors recognised · <strong>{pastePreview.home_count}</strong> CQC homes
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
                  className="px-3 py-2 text-xs font-bold uppercase tracking-wider rounded-lg bg-[#D4FF00] text-stone-950 hover:bg-[#BDE600]">
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
