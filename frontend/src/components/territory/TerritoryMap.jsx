// Mapbox UK postcode-sector map.
//
// Renders real ONS/GeoLytix postcode-sector polygons (loaded server-side
// from `postcode_sector_polygons`, served as a GeoJSON FeatureCollection
// scoped to the visible sectors). Each sector keeps its own boundary —
// internal sector lines stay visible, there is NO dissolved/merged outer
// hull, and there is no client- or server-side polygon generation.
//
// Styling:
//   • translucent yellow/green fill for owned / selected sectors
//   • lighter neutral fill for "available but not selected" sectors
//     (admin builder only — read-only widgets never render these)
//   • dark green outlines on every sector, slightly thicker on the
//     selected/owned ones to make the territory pop
import { useEffect, useRef, useState } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import { getLeadStatusMeta } from "@/lib/leadStatus";

const TOKEN = process.env.REACT_APP_MAPBOX_TOKEN;

// Brand-friendly palette aligned with the rest of the admin (Creative Mojo
// uses #dddd16 lime as its accent; pair with a dark green outline).
const FILL_SELECTED = "#dddd16";   // brand yellow-green
const FILL_AVAILABLE = "#E7E5E4";  // stone-200, very light
const OUTLINE_DARK = "#14532D";    // green-900, strong dark green
const OUTLINE_LIGHT = "#A8A29E";   // stone-400, soft separator

export default function TerritoryMap({
  sectors = [],          // [{ sector, geometry, home_count, ... }]
  selected = [],         // sector codes treated as selected/owned
  centre = null,         // { lat, lng } — drops a red HQ marker + fits view
  centreLabel = "",
  height = 520,
  onToggleSector = () => {},
  interactive = true,    // false → no click-toggle (read-only widgets)
  homes = [],            // optional: numbered markers on the map
  onMarkerClick = null,  // (idx, home) — typically scrolls the list below
  activeHomeIndex = null, // optional: highlights the matching numbered pin in brand colour
  flyTo = null,          // { lat, lng } — pan-zoom-here trigger, bumps each update
  pinnedPostcode = null, // { postcode, lat, lng, inside } — looked-up postcode pin
  franchiseeOverlay = null, // { franchisees: [...], geojson: FeatureCollection }
  onFranchiseeClick = null, // (franchisee) — clicking an HQ pin or a sector
  basemap = "light",        // "light" | "streets" — toggleable basemap. Streets
                            //   shows full road network + labels; light is the
                            //   minimalist default that keeps the territory pop.
  clientHomeKeys = null,    // optional Set of `${source}:${home_id}` strings —
                            //   when present, any matching ``home`` marker is
                            //   skinned in My Territory+ gold instead of green
                            //   to signal "this regulated home is My Client".
  homeStatusByKey = null,   // optional Map "${source}:${home_id}" → lead_status
                            //   string. When set, the matching home marker is
                            //   tinted with that status's colour (orange for
                            //   "Not Contacted", purple for "Interested", …).
                            //   Clients (gold ★) still override the tint.
  statusFilter = "",        // optional lead_status to filter markers by — when
                            //   set, only markers whose tracked status matches
                            //   are rendered (everything else hidden, including
                            //   untracked CQC homes). "" = no filter.
  customClients = [],       // optional: [{id, name, lat, lng, ...}] — custom
                            //   clients added by the franchisee. Plotted with
                            //   a gold ★ marker, distinct from numbered homes.
  onCustomClientClick = null, // (client) — typically opens the client edit modal
  onClientMarkerClick = null, // (home) — clicked a CQC home that's flagged as
                              //   My Client; parent typically finds the
                              //   matching franchisee_clients doc and opens
                              //   the edit modal.
  providerFilter = null,    // optional string — only show markers whose
                            //   ``providerName`` matches (case-insensitive
                            //   exact); ``null`` = show everything.
  dimNonClients = false,    // when true (My Clients Only mode), non-client
                            //   numbered markers are rendered at low opacity
                            //   so they read as background context while the
                            //   gold client markers pop.
  searchPin = null,         // { lat, lng, label } — purely-visual blue pin
                            //   dropped via the on-map search box. Independent
                            //   of ``pinnedPostcode`` (which carries the
                            //   inside/outside-territory verdict). Setting
                            //   to ``null`` removes the pin.
  suggestedRemovals = [],   // array of sector codes painted with a soft
                            //   red diagonal-stripe overlay so the admin
                            //   can visually flag "areas that could come
                            //   out" without modifying the territory.
  overlayMode = false,      // when true, clicking a sector calls
                            //   ``onToggleRemoval`` (overlay-edit mode)
                            //   instead of ``onToggleSector``. Lets the
                            //   admin paint the suggested-removals layer
                            //   using the same map-click UX.
  onToggleRemoval = null,   // (sector: string) => void — called in
                            //   overlay-edit mode.
}) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const centreMarkerRef = useRef(null);
  const homeMarkersRef = useRef([]);
  const pinnedMarkerRef = useRef(null);
  const searchMarkerRef = useRef(null);
  const franchiseeHqMarkersRef = useRef([]);
  // Click handler captures `onToggleSector` / `overlayMode` at style.load
  // time (Mapbox event listeners aren't re-bound per render). Stash the
  // live values in a ref so the click logic always reads the current
  // mode / callbacks without re-subscribing.
  const clickModeRef = useRef({ overlayMode: false, onToggleSector: () => {}, onToggleRemoval: null });
  useEffect(() => {
    clickModeRef.current = { overlayMode, onToggleSector, onToggleRemoval };
  }, [overlayMode, onToggleSector, onToggleRemoval]);
  const [ready, setReady] = useState(false);
  // Bumped each time the basemap finishes (re)loading so the data effects
  // re-run and repopulate the freshly-created sources.
  const [styleVersion, setStyleVersion] = useState(0);

  // ----------------- one-shot map init -----------------
  useEffect(() => {
    if (!containerRef.current || mapRef.current || !TOKEN) return;
    mapboxgl.accessToken = TOKEN;
    const initialStyle = basemap === "streets"
      ? "mapbox://styles/mapbox/streets-v12"
      : "mapbox://styles/mapbox/light-v11";
    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: initialStyle,
      center: centre ? [centre.lng, centre.lat] : [-2.5, 53.4],
      zoom: centre ? 9 : 5.4,
    });
    map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), "top-right");
    map.addControl(new mapboxgl.ScaleControl({ maxWidth: 100, unit: "imperial" }), "bottom-left");
    mapRef.current = map;

    map.on("style.load", () => {
      // Runs on the initial style load AND every time `setStyle` swaps the
      // basemap. We re-add every source/layer because Mapbox wipes them when
      // the style changes.
      // ----- Background: existing franchisee territories (multi-colour) -----
      // Added FIRST so the active builder layers always paint on top of them.
      map.addSource("franchisee-territories", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addLayer({
        id: "franchisee-fill",
        type: "fill",
        source: "franchisee-territories",
        paint: {
          "fill-color": ["coalesce", ["get", "color"], "#94A3B8"],
          "fill-opacity": [
            "case",
            ["boolean", ["feature-state", "hover"], false], 0.35,
            0.18,
          ],
        },
      });
      // Light per-sector boundary so each sector inside a franchisee is still
      // legible. Drawn thin and slightly dimmer than the dissolved edge.
      map.addLayer({
        id: "franchisee-inner-line",
        type: "line",
        source: "franchisee-territories",
        paint: {
          "line-color": ["coalesce", ["get", "color"], "#475569"],
          "line-width": 0.4,
          "line-opacity": 0.5,
        },
      });

      // ----- Dissolved franchisee outline (one ring per franchisee) -----
      // This is the "thicker keyline around the overall franchise territory"
      // the user asked for — drawn over the fills so the OUTSIDE edge of each
      // territory pops, even when neighbours share similar palette colours.
      map.addSource("franchisee-outlines", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      // Soft white halo first, then the coloured edge on top — gives the
      // outline real presence on busy areas.
      map.addLayer({
        id: "franchisee-outline-halo",
        type: "line",
        source: "franchisee-outlines",
        paint: {
          "line-color": "#ffffff",
          "line-width": 6,
          "line-opacity": 0.85,
        },
      });
      map.addLayer({
        id: "franchisee-outline-edge",
        type: "line",
        source: "franchisee-outlines",
        paint: {
          "line-color": ["coalesce", ["get", "color"], "#0f172a"],
          "line-width": 3.2,
          "line-opacity": 1.0,
        },
      });

      // ----- Active builder layers (selection / available sectors) -----
      map.addSource("sectors", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });

      // Register a diagonal-stripe pattern image used by the suggested-
      // removals overlay layer. Generated as an inline canvas (so we don't
      // bundle a PNG asset). Transparent background + bold red diagonal
      // stripes so the underlying yellow selected fill still reads
      // through *between* stripes but the red is clearly visible. Re-
      // registered on every style swap because Mapbox sprites are
      // scoped to a single style.
      try {
        if (!map.hasImage("removal-stripe")) {
          const sz = 16;
          const cv = document.createElement("canvas");
          cv.width = sz; cv.height = sz;
          const ctx = cv.getContext("2d");
          if (ctx) {
            ctx.clearRect(0, 0, sz, sz);
            ctx.strokeStyle = "rgba(220, 38, 38, 0.85)";
            ctx.lineWidth = 3;
            ctx.lineCap = "square";
            ctx.beginPath();
            ctx.moveTo(-4, sz / 2 + 2); ctx.lineTo(sz / 2 + 2, -4);
            ctx.moveTo(sz / 2 - 2, sz + 4); ctx.lineTo(sz + 4, sz / 2 - 2);
            ctx.stroke();
            // Mapbox addImage only accepts ImageData / ImageBitmap /
            // HTMLImageElement / {width,height,data}. A bare canvas is
            // NOT supported and was silently rejected (this is why the
            // overlay didn't paint). Convert to ImageData for safe ingest.
            const imageData = ctx.getImageData(0, 0, sz, sz);
            map.addImage("removal-stripe", imageData, { pixelRatio: 1 });
          }
        }
      } catch (e) { /* pattern add is best-effort */ }

      // Fill — translucent for available, brand-yellow translucent for owned
      map.addLayer({
        id: "sectors-fill",
        type: "fill",
        source: "sectors",
        paint: {
          "fill-color": [
            "case",
            ["get", "selected"], FILL_SELECTED,
            FILL_AVAILABLE,
          ],
          "fill-opacity": [
            "case",
            ["get", "selected"], 0.45,
            ["boolean", ["feature-state", "hover"], false], 0.55,
            0.18,
          ],
        },
      });

      // Suggested-removals overlay — diagonal red stripes painted on
      // sectors flagged for potential removal. Filtered to the
      // ``removalFlag`` property which the React layer toggles on/off
      // via ``suggestedRemovals`` + ``overlayMode``.
      map.addLayer({
        id: "sectors-removal-overlay",
        type: "fill",
        source: "sectors",
        filter: ["==", ["get", "removalFlag"], true],
        paint: {
          "fill-pattern": "removal-stripe",
          "fill-opacity": 0.95,
        },
      });

      // Outline — dark green on every sector to preserve internal boundaries
      map.addLayer({
        id: "sectors-outline",
        type: "line",
        source: "sectors",
        paint: {
          "line-color": [
            "case",
            ["get", "selected"], OUTLINE_DARK,
            OUTLINE_LIGHT,
          ],
          "line-width": ["case", ["get", "selected"], 1.25, 0.5],
          "line-opacity": 0.9,
        },
      });

      // Labels — sector code + CQC home count, only visible at zoom ≥ 9
      map.addLayer({
        id: "sectors-label",
        type: "symbol",
        source: "sectors",
        minzoom: 9,
        layout: {
          "text-field": [
            "concat",
            ["get", "sector"],
            "\n",
            ["to-string", ["get", "home_count"]],
            " homes",
          ],
          "text-size": 11,
          "text-font": ["Open Sans Bold", "Arial Unicode MS Bold"],
          "text-allow-overlap": false,
        },
        paint: {
          "text-color": "#0c0a09",
          "text-halo-color": "#ffffff",
          "text-halo-width": 1.5,
        },
      });

      // ----- Boost Mapbox's built-in place labels so towns/cities are
      // easy to read against our coloured territory fills. We re-raise
      // each settlement label layer above all our overlays, bump the
      // font, and thicken the white halo. This runs on initial style
      // load AND on basemap swaps (style.load fires for both).
      const BOOSTED_LABELS = [
        "settlement-major-label",
        "settlement-minor-label",
        "settlement-subdivision-label",
        "state-label",
      ];
      for (const id of BOOSTED_LABELS) {
        const lyr = map.getLayer(id);
        if (!lyr) continue;
        // Move on top of every overlay we just added.
        try { map.moveLayer(id); } catch { /* ignore */ }
        // Larger, bolder type with a stronger halo. Use Mapbox style
        // expressions so the size still scales with zoom.
        try {
          if (id === "settlement-major-label") {
            map.setLayoutProperty(id, "text-size", [
              "interpolate", ["linear"], ["zoom"],
              4, 13,
              6, 17,
              10, 22,
              14, 26,
            ]);
            map.setLayoutProperty(id, "text-font", ["Open Sans Bold", "Arial Unicode MS Bold"]);
          } else if (id === "settlement-minor-label") {
            map.setLayoutProperty(id, "text-size", [
              "interpolate", ["linear"], ["zoom"],
              6, 11,
              9, 14,
              12, 17,
              14, 19,
            ]);
            map.setLayoutProperty(id, "text-font", ["Open Sans Semibold", "Arial Unicode MS Bold"]);
          } else if (id === "settlement-subdivision-label") {
            map.setLayoutProperty(id, "text-size", [
              "interpolate", ["linear"], ["zoom"],
              10, 11,
              14, 14,
            ]);
          }
          map.setPaintProperty(id, "text-color", "#0c0a09");
          map.setPaintProperty(id, "text-halo-color", "#ffffff");
          map.setPaintProperty(id, "text-halo-width", 2.2);
        } catch { /* ignore — layer might not support these props */ }
      }

      if (interactive) {
        let hoverId = null;
        map.on("mousemove", "sectors-fill", (e) => {
          const f = e.features?.[0];
          if (!f) return;
          if (hoverId !== null) map.setFeatureState({ source: "sectors", id: hoverId }, { hover: false });
          hoverId = f.id;
          map.setFeatureState({ source: "sectors", id: hoverId }, { hover: true });
          map.getCanvas().style.cursor = "pointer";
        });
        map.on("mouseleave", "sectors-fill", () => {
          if (hoverId !== null) map.setFeatureState({ source: "sectors", id: hoverId }, { hover: false });
          hoverId = null;
          map.getCanvas().style.cursor = "";
        });
        map.on("click", "sectors-fill", (e) => {
          const f = e.features?.[0];
          if (!f) return;
          // Route by current mode (ref-backed so prop changes take
          // effect without rebinding the Mapbox listener).
          const { overlayMode: om, onToggleSector: ts, onToggleRemoval: tr } = clickModeRef.current;
          if (om && tr) {
            tr(f.properties.sector);
          } else {
            ts(f.properties.sector);
          }
        });
      }

      // Franchisee territory click — surfaces the owner above the active
      // sectors-fill so admins can identify overlaps even when "available"
      // sectors are stacked on top.
      map.on("click", "franchisee-fill", (e) => {
        const f = e.features?.[0];
        if (!f) return;
        const p = f.properties || {};
        const fnum = p.franchise_number ? `#${String(p.franchise_number).replace(/</g, "&lt;")} ` : "";
        const html = `
          <div style="font-family:Inter,system-ui;font-size:12px;line-height:1.4;min-width:180px">
            <strong>${fnum}${(p.name || "").replace(/</g, "&lt;")}</strong>
            ${p.owner_name ? `<div style="color:#0c0a09;margin-top:2px">${String(p.owner_name).replace(/</g, "&lt;")}</div>` : ""}
            <div style="color:#78716c;margin-top:3px">Sector ${(p.sector || "").replace(/</g, "&lt;")}</div>
          </div>`;
        new mapboxgl.Popup({ offset: 12, closeButton: true })
          .setLngLat(e.lngLat)
          .setHTML(html)
          .addTo(map);
      });
      map.on("mouseenter", "franchisee-fill", () => { map.getCanvas().style.cursor = "pointer"; });

      setReady(true);
      setStyleVersion((v) => v + 1);
    });

    return () => { map.remove(); mapRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ----------------- basemap swap (light ↔ streets) -----------------
  // Skip the first run — the map is constructed with the right initial
  // style. Subsequent prop changes call `setStyle`, which fires `style.load`
  // and triggers our data-effects (gated on `styleVersion`) to repopulate.
  const initialBasemapRef = useRef(basemap);
  useEffect(() => {
    if (!mapRef.current || !ready) return;
    if (basemap === initialBasemapRef.current) return;
    initialBasemapRef.current = basemap;
    const styleUrl = basemap === "streets"
      ? "mapbox://styles/mapbox/streets-v12"
      : "mapbox://styles/mapbox/light-v11";
    mapRef.current.setStyle(styleUrl);
  }, [basemap, ready]);

  // ----------------- update features when props change -----------------
  useEffect(() => {
    if (!ready || !mapRef.current) return;
    const src = mapRef.current.getSource("sectors");
    if (!src) return;
    const sel = new Set(selected);
    const removals = new Set(suggestedRemovals || []);
    const features = sectors
      .filter((s) => s && s.geometry)
      .map((s, i) => ({
        type: "Feature",
        id: i + 1,
        geometry: s.geometry,
        properties: {
          sector: s.sector,
          home_count: s.home_count || 0,
          selected: sel.has(s.sector),
          removalFlag: removals.has(s.sector),
        },
      }));
    src.setData({ type: "FeatureCollection", features });

    // Auto-fit to the selected sectors so the territory frames itself nicely
    // (read-only widgets benefit most — admin builder already centres on HQ).
    if (!interactive && features.length) {
      const selFeatures = features.filter((f) => f.properties.selected);
      const target = selFeatures.length ? selFeatures : features;
      let minLng = 180, minLat = 90, maxLng = -180, maxLat = -90;
      const walk = (coords) => {
        if (typeof coords[0] === "number") {
          minLng = Math.min(minLng, coords[0]);
          maxLng = Math.max(maxLng, coords[0]);
          minLat = Math.min(minLat, coords[1]);
          maxLat = Math.max(maxLat, coords[1]);
        } else {
          coords.forEach(walk);
        }
      };
      target.forEach((f) => walk(f.geometry.coordinates));
      if (minLng < 180) {
        mapRef.current.fitBounds(
          [[minLng, minLat], [maxLng, maxLat]],
          { padding: 40, maxZoom: 11, duration: 600 },
        );
      }
    }
  }, [sectors, selected, suggestedRemovals, ready, interactive, styleVersion]);

  // ----------------- HQ marker -----------------
  // Renders the franchisee's home postcode as a small "Me" pill so it's
  // visually distinct from numbered home markers and gold ★ client pins.
  useEffect(() => {
    if (!ready || !mapRef.current) return;
    if (centreMarkerRef.current) { centreMarkerRef.current.remove(); centreMarkerRef.current = null; }
    if (centre && centre.lat != null && centre.lng != null) {
      const el = document.createElement("div");
      el.className = "cm-me-marker";
      el.textContent = "Me";
      el.style.cssText = [
        "display:inline-flex",
        "align-items:center",
        "justify-content:center",
        "padding:3px 8px",
        "border-radius:9999px",
        "background:#0F172A",
        "color:#FFFFFF",
        "font:600 11px/1 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif",
        "letter-spacing:0.02em",
        "border:2px solid #FFFFFF",
        "box-shadow:0 2px 6px rgba(0,0,0,.35)",
        "cursor:pointer",
        "white-space:nowrap",
        "z-index:9999",
        "position:relative",
      ].join(";");
      const marker = new mapboxgl.Marker({ element: el, anchor: "center" })
        .setLngLat([centre.lng, centre.lat])
        .setPopup(centreLabel ? new mapboxgl.Popup({ offset: 14 }).setText(centreLabel) : undefined)
        .addTo(mapRef.current);
      centreMarkerRef.current = marker;
      if (interactive) {
        mapRef.current.flyTo({ center: [centre.lng, centre.lat], zoom: 10, speed: 1.4 });
      }
    }
  }, [centre, centreLabel, ready, interactive]);

  // ----------------- numbered home markers -----------------
  useEffect(() => {
    if (!ready || !mapRef.current) return;
    // Remove previous markers
    homeMarkersRef.current.forEach((m) => m && m.remove());
    homeMarkersRef.current = [];
    if (!homes.length) return;
    homes.forEach((home, i) => {
      if (home.latitude == null || home.longitude == null) return;
      // Provider filter — when set, hide markers that don't match.
      if (providerFilter && (home.providerName || "").toLowerCase() !== providerFilter.toLowerCase()) return;
      // Is THIS home flagged as "My Client"? Keyed by source:home_id so
      // we can light it up in My Territory+ gold instead of green.
      const homeKey = home.id || home.locationId || "";
      const yourClient = clientHomeKeys
        && (clientHomeKeys.has(`cqc:${homeKey}`)
            || clientHomeKeys.has(`scotland:${homeKey}`));
      // Tracked lead-status for this home (prospect or client). Drives
      // the per-marker tint AND the status-filter visibility check.
      const trackedStatus = homeStatusByKey
        ? (homeStatusByKey.get(`cqc:${homeKey}`)
            || homeStatusByKey.get(`scotland:${homeKey}`)
            || null)
        : null;
      // "My clients only" filter: drop non-client markers entirely so the
      // map shows only your own client pins (the user said dimming was
      // confusing — full hide is clearer).
      if (dimNonClients && !yourClient) {
        homeMarkersRef.current.push(null);
        return;
      }
      // Status-filter visibility: when the franchisee picks a single
      // status from the Client Pool filter dropdown, the map mirrors
      // it — only tracked homes whose status matches are rendered.
      // Untracked CQC homes are also hidden (they have no status).
      if (statusFilter && trackedStatus !== statusFilter) {
        homeMarkersRef.current.push(null);
        return;
      }
      const el = document.createElement("div");
      el.className = "cm-home-marker";
      // Marked-as-mine homes render as a gold ★ on the map so they're
      // visually unmistakable (matches the My Clients panel iconography).
      // Tracked prospects use a numbered circle tinted with their lead
      // status colour. Untracked CQC homes keep the default dark-green
      // numbered circle.
      el.textContent = yourClient ? "★" : String(i + 1);
      if (yourClient) {
        el.style.cssText = "background:#dddd16;color:#0c0a09;font-size:16px;font-weight:900;width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;border:2px solid #0c0a09;box-shadow:0 0 0 3px rgba(221,221,22,0.45),0 1px 3px rgba(0,0,0,.4);cursor:pointer;font-family:Inter,system-ui,sans-serif;line-height:1;";
      } else if (trackedStatus) {
        const meta = getLeadStatusMeta(trackedStatus);
        const bg = meta.tone.markerBg || "#14532D";
        const fg = meta.tone.markerFg || "#fff";
        // Start from the default green baseline then re-apply the
        // status tint on the next animation frame. Setting cssText
        // alone was being clobbered by a follow-up render where
        // ``yourClient`` / ``trackedStatus`` flickered to stale values
        // — the rAF defers the colour-write past that flicker so the
        // tint sticks.
        el.style.cssText = `background:${bg};color:${fg};font-size:11px;font-weight:700;width:24px;height:24px;border-radius:50%;display:flex;align-items:center;justify-content:center;border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.4);cursor:pointer;font-family:Inter,system-ui,sans-serif;`;
        el.setAttribute("data-tracked-status", trackedStatus);
        requestAnimationFrame(() => {
          el.style.backgroundColor = bg;
          el.style.color = fg;
        });
      } else {
        el.style.cssText = "background:#14532D;color:#fff;font-size:11px;font-weight:700;width:24px;height:24px;border-radius:50%;display:flex;align-items:center;justify-content:center;border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.4);cursor:pointer;font-family:Inter,system-ui,sans-serif;";
      }
      const marker = new mapboxgl.Marker(el)
        .setLngLat([home.longitude, home.latitude])
        .setPopup(new mapboxgl.Popup({ offset: 16, closeButton: false }).setHTML(
          `<div style="font-family:Inter,system-ui;font-size:12px;line-height:1.35">
            <strong>${i + 1}. ${(home.name || "").replace(/</g, "&lt;")}</strong><br/>
            <span style="color:#57534e">${(home.postalAddressTownCity || home.postcode_district || "").replace(/</g, "&lt;")} · ${(home.postalCode || "").replace(/</g, "&lt;")}</span>
          </div>`,
        ))
        .addTo(mapRef.current);
      if (onMarkerClick) {
        el.addEventListener("click", () => {
          // For marked-as-mine homes: delegate to onClientMarkerClick if
          // provided so the parent can open the edit modal. Falls back
          // to the row-expansion behaviour for non-clients.
          if (yourClient && typeof onClientMarkerClick === "function") {
            onClientMarkerClick(home);
          } else {
            onMarkerClick(i, home);
          }
        });
      }
      homeMarkersRef.current.push(marker);
    });
    return () => {
      homeMarkersRef.current.forEach((m) => m && m.remove());
      homeMarkersRef.current = [];
    };
  }, [homes, ready, onMarkerClick, onClientMarkerClick, clientHomeKeys, providerFilter, dimNonClients, homeStatusByKey, statusFilter]);

  // ----------------- custom client markers (Territory+ "my clients") -----
  // Drawn separately from regulated homes — gold ★ markers, no number,
  // sit ABOVE the numbered home pins via a larger size so they stand out.
  const customClientsRef = useRef([]);
  useEffect(() => {
    if (!ready || !mapRef.current) return;
    customClientsRef.current.forEach((m) => m.remove());
    customClientsRef.current = [];
    if (!customClients.length) return;
    customClients.forEach((c) => {
      if (c.lat == null || c.lng == null) return;
      const el = document.createElement("div");
      el.className = "cm-client-marker";
      el.innerHTML = "★";
      el.style.cssText = "background:#dddd16;color:#0c0a09;font-size:14px;font-weight:900;width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;border:2px solid #0c0a09;box-shadow:0 0 0 2px rgba(221,221,22,0.4),0 2px 4px rgba(0,0,0,.4);cursor:pointer;line-height:1;";
      const m = new mapboxgl.Marker(el)
        .setLngLat([c.lng, c.lat])
        .setPopup(new mapboxgl.Popup({ offset: 18, closeButton: false }).setHTML(
          `<div style="font-family:Inter,system-ui;font-size:12px;line-height:1.35">
            <strong>★ ${(c.name || "").replace(/</g, "&lt;")}</strong><br/>
            <span style="color:#57534e">My client${c.provider ? ` · ${(c.provider || "").replace(/</g, "&lt;")}` : ""}</span>
          </div>`,
        ))
        .addTo(mapRef.current);
      if (onCustomClientClick) {
        el.addEventListener("click", () => onCustomClientClick(c));
      }
      customClientsRef.current.push(m);
    });
    return () => {
      customClientsRef.current.forEach((m) => m.remove());
      customClientsRef.current = [];
    };
  }, [customClients, ready, onCustomClientClick]);

  // ----------------- highlight the active home marker -----------------
  // When the user opens a row in the homes list below the map, we re-skin
  // the matching numbered pin in brand yellow so it's instantly findable.
  // Markers that have been hidden (null) by the My-Clients-only filter
  // are skipped — they're not on the map at all.
  useEffect(() => {
    if (!homeMarkersRef.current.length) return;
    homeMarkersRef.current.forEach((marker, i) => {
      if (!marker) return;
      const el = marker.getElement();
      if (!el) return;
      const home = homes[i] || {};
      const homeKey = home.id || home.locationId || "";
      const isClient = clientHomeKeys
        && (clientHomeKeys.has(`cqc:${homeKey}`) || clientHomeKeys.has(`scotland:${homeKey}`));
      const isActive = i === activeHomeIndex;
      if (isActive) {
        el.style.background = "#dddd16";
        el.style.color = "#0c0a09";
        el.style.borderColor = "#0c0a09";
        el.style.width = "30px";
        el.style.height = "30px";
        el.style.fontSize = "13px";
        el.style.boxShadow = "0 0 0 3px rgba(221,221,22,0.35), 0 2px 6px rgba(0,0,0,.45)";
        el.style.zIndex = "10";
      } else if (isClient) {
        el.style.background = "#dddd16";
        el.style.color = "#0c0a09";
        el.style.borderColor = "#0c0a09";
        el.style.width = "28px";
        el.style.height = "28px";
        el.style.fontSize = "16px";
        el.style.boxShadow = "0 0 0 3px rgba(221,221,22,0.45), 0 1px 3px rgba(0,0,0,.4)";
        el.style.zIndex = "";
        // Re-apply ★ in case the active-state override replaced it
        // with the row index.
        el.textContent = "★";
      } else {
        el.style.background = "#14532D";
        el.style.color = "#fff";
        el.style.borderColor = "#fff";
        el.style.width = "24px";
        el.style.height = "24px";
        el.style.fontSize = "11px";
        el.style.boxShadow = "0 1px 3px rgba(0,0,0,.4)";
        el.style.zIndex = "";
        el.textContent = String(i + 1);
      }
    });
  }, [activeHomeIndex, homes, ready, clientHomeKeys]);

  // ----------------- pan-to (used by "Zoom map here" buttons in the list)
  useEffect(() => {
    if (!ready || !mapRef.current || !flyTo) return;
    if (flyTo.lat == null || flyTo.lng == null) return;
    mapRef.current.flyTo({ center: [flyTo.lng, flyTo.lat], zoom: 14, speed: 1.6 });
  }, [flyTo, ready]);

  // ----------------- pinned postcode (typed by the franchisee in "Check a
  // postcode"). Distinct from the HQ marker — uses a teardrop shape with a
  // tick if inside the territory and a cross if outside.
  useEffect(() => {
    if (!ready || !mapRef.current) return;
    if (pinnedMarkerRef.current) { pinnedMarkerRef.current.remove(); pinnedMarkerRef.current = null; }
    if (!pinnedPostcode || pinnedPostcode.lat == null || pinnedPostcode.lng == null) return;
    const inside = !!pinnedPostcode.inside;
    const bg = inside ? "#059669" : "#B91C1C"; // emerald-600 / red-700
    const icon = inside ? "✓" : "✕";
    // Build the marker DOM with element APIs rather than innerHTML —
    // ``bg`` and ``icon`` are hardcoded ternary results so injection
    // isn't possible today, but using textContent + setAttribute keeps
    // the code review's "no raw innerHTML" guarantee intact going
    // forward (any future caller can't accidentally smuggle markup in).
    const el = document.createElement("div");
    el.style.cssText = "width:34px;height:42px;position:relative;cursor:pointer;";
    const pin = document.createElement("div");
    pin.style.cssText = `position:absolute;inset:0;background:${bg};border:3px solid #fff;border-radius:50% 50% 50% 0;transform:rotate(-45deg);box-shadow:0 3px 8px rgba(0,0,0,.4);`;
    const tick = document.createElement("div");
    tick.style.cssText = "position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:800;font-size:14px;font-family:Inter,system-ui,sans-serif;padding-bottom:6px;";
    tick.textContent = icon;
    el.appendChild(pin);
    el.appendChild(tick);
    const marker = new mapboxgl.Marker({ element: el, anchor: "bottom" })
      .setLngLat([pinnedPostcode.lng, pinnedPostcode.lat])
      .setPopup(new mapboxgl.Popup({ offset: 24, closeButton: false }).setHTML(
        `<div style="font-family:Inter,system-ui;font-size:12px;line-height:1.35;text-align:center">
          <strong>${(pinnedPostcode.postcode || "").replace(/</g, "&lt;")}</strong><br/>
          <span style="color:${inside ? "#059669" : "#B91C1C"};font-weight:600">${inside ? "Inside your territory" : "Outside your territory"}</span>
        </div>`,
      ))
      .addTo(mapRef.current);
    marker.togglePopup();
    pinnedMarkerRef.current = marker;
    mapRef.current.flyTo({ center: [pinnedPostcode.lng, pinnedPostcode.lat], zoom: 12, speed: 1.4 });
  }, [pinnedPostcode, ready]);

  // ----------------- search-box pin -----------------------------------
  // Purely-visual marker dropped via the in-map "Search town/postcode"
  // box. A distinct blue teardrop so admins can tell at a glance it's a
  // scratch pad pin, not part of the territory data (sectors, HQ pins,
  // or the inside/outside ``pinnedPostcode`` verdict). Removed when the
  // parent passes ``searchPin = null``.
  useEffect(() => {
    if (!ready || !mapRef.current) return;
    if (searchMarkerRef.current) { searchMarkerRef.current.remove(); searchMarkerRef.current = null; }
    if (!searchPin || searchPin.lat == null || searchPin.lng == null) return;
    const el = document.createElement("div");
    el.style.cssText = "width:34px;height:42px;position:relative;cursor:pointer;";
    const pin = document.createElement("div");
    // Sky-blue so it can't be confused with the green/red inside/outside
    // pin or the dark indigo franchisee HQ pins already on the map.
    pin.style.cssText = "position:absolute;inset:0;background:#0284c7;border:3px solid #fff;border-radius:50% 50% 50% 0;transform:rotate(-45deg);box-shadow:0 3px 8px rgba(0,0,0,.4);";
    const dot = document.createElement("div");
    dot.style.cssText = "position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:800;font-size:14px;font-family:Inter,system-ui,sans-serif;padding-bottom:6px;";
    dot.textContent = "📍";
    el.appendChild(pin);
    el.appendChild(dot);
    const popupHtml = searchPin.label
      ? `<div style="font-family:Inter,system-ui;font-size:12px;line-height:1.35;text-align:center"><strong>${(searchPin.label || "").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</strong></div>`
      : null;
    const m = new mapboxgl.Marker({ element: el, anchor: "bottom" })
      .setLngLat([searchPin.lng, searchPin.lat]);
    if (popupHtml) {
      m.setPopup(new mapboxgl.Popup({ offset: 24, closeButton: false }).setHTML(popupHtml));
    }
    m.addTo(mapRef.current);
    if (popupHtml) m.togglePopup();
    searchMarkerRef.current = m;
    mapRef.current.flyTo({ center: [searchPin.lng, searchPin.lat], zoom: 11, speed: 1.2 });
  }, [searchPin, ready]);

  // ----------------- franchisee overlay: territory polygons + HQ pins -----
  useEffect(() => {
    if (!ready || !mapRef.current) return;
    const src = mapRef.current.getSource("franchisee-territories");
    if (src) {
      src.setData(franchiseeOverlay?.geojson || { type: "FeatureCollection", features: [] });
    }
    const outSrc = mapRef.current.getSource("franchisee-outlines");
    if (outSrc) {
      outSrc.setData(franchiseeOverlay?.outlines || { type: "FeatureCollection", features: [] });
    }
    // Clear previous HQ markers
    franchiseeHqMarkersRef.current.forEach((m) => m.remove());
    franchiseeHqMarkersRef.current = [];
    const franchisees = franchiseeOverlay?.franchisees || [];
    franchisees.forEach((f) => {
      if (f.hq_lat == null || f.hq_lng == null) return;
      const el = document.createElement("div");
      el.className = "cm-franchisee-pin";
      el.title = f.name;
      el.style.cssText = `
        width:22px;height:22px;border-radius:50%;
        background:${f.color};border:3px solid #fff;
        box-shadow:0 2px 5px rgba(0,0,0,.45);cursor:pointer;
        display:flex;align-items:center;justify-content:center;
        color:#fff;font:700 9px/1 Inter,system-ui,sans-serif;
        text-shadow:0 1px 1px rgba(0,0,0,.35);`;
      el.textContent = f.franchise_number ? `#${f.franchise_number}` : "";
      const popupHtml = `
        <div style="font-family:Inter,system-ui;font-size:12px;line-height:1.4;min-width:180px">
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:2px">
            <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${f.color};border:1px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,.2)"></span>
            <strong>${(f.name || "").replace(/</g, "&lt;")}</strong>
          </div>
          ${f.owner_name ? `<div style="color:#0c0a09">${String(f.owner_name).replace(/</g, "&lt;")}</div>` : ""}
          ${f.franchise_number ? `<div style="color:#78716c">Franchise #${f.franchise_number}</div>` : ""}
          ${f.postcode ? `<div style="color:#78716c">HQ ${String(f.postcode).replace(/</g, "&lt;")}</div>` : ""}
          <div style="color:#78716c">${f.sectors?.length || 0} sector${f.sectors?.length === 1 ? "" : "s"}</div>
        </div>`;
      const marker = new mapboxgl.Marker({ element: el, anchor: "center" })
        .setLngLat([f.hq_lng, f.hq_lat])
        .setPopup(new mapboxgl.Popup({ offset: 16, closeButton: true }).setHTML(popupHtml))
        .addTo(mapRef.current);
      if (onFranchiseeClick) {
        el.addEventListener("click", (ev) => { ev.stopPropagation(); onFranchiseeClick(f); });
      }
      franchiseeHqMarkersRef.current.push(marker);
    });
    return () => {
      franchiseeHqMarkersRef.current.forEach((m) => m.remove());
      franchiseeHqMarkersRef.current = [];
    };
  }, [franchiseeOverlay, ready, onFranchiseeClick, styleVersion]);

  if (!TOKEN) {
    return (
      <div className="rounded-2xl border border-amber-300 bg-amber-50 px-4 py-6 text-sm text-amber-900">
        <strong>Map disabled:</strong> add <code className="bg-amber-100 px-1 rounded">REACT_APP_MAPBOX_TOKEN</code> to <code>/app/frontend/.env</code>.
      </div>
    );
  }
  return (
    <div
      ref={containerRef}
      style={{ height, width: "100%" }}
      className="rounded-2xl overflow-hidden border border-stone-200"
      data-testid="territory-map"
    />
  );
}
