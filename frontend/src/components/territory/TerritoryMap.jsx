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

const TOKEN = process.env.REACT_APP_MAPBOX_TOKEN;

// Brand-friendly palette aligned with the rest of the admin (Creative Mojo
// uses #D4FF00 lime as its accent; pair with a dark green outline).
const FILL_SELECTED = "#D4FF00";   // brand yellow-green
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
  flyTo = null,          // { lat, lng } — pan-zoom-here trigger, bumps each update
}) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const centreMarkerRef = useRef(null);
  const homeMarkersRef = useRef([]);
  const [ready, setReady] = useState(false);

  // ----------------- one-shot map init -----------------
  useEffect(() => {
    if (!containerRef.current || mapRef.current || !TOKEN) return;
    mapboxgl.accessToken = TOKEN;
    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: "mapbox://styles/mapbox/light-v11",
      center: centre ? [centre.lng, centre.lat] : [-2.5, 53.4],
      zoom: centre ? 9 : 5.4,
    });
    map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), "top-right");
    map.addControl(new mapboxgl.ScaleControl({ maxWidth: 100, unit: "imperial" }), "bottom-left");
    mapRef.current = map;

    map.on("load", () => {
      map.addSource("sectors", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });

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
          "line-width": ["case", ["get", "selected"], 2, 0.8],
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
          onToggleSector(f.properties.sector);
        });
      }

      setReady(true);
    });

    return () => { map.remove(); mapRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ----------------- update features when props change -----------------
  useEffect(() => {
    if (!ready || !mapRef.current) return;
    const src = mapRef.current.getSource("sectors");
    if (!src) return;
    const sel = new Set(selected);
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
  }, [sectors, selected, ready, interactive]);

  // ----------------- HQ marker -----------------
  useEffect(() => {
    if (!ready || !mapRef.current) return;
    if (centreMarkerRef.current) { centreMarkerRef.current.remove(); centreMarkerRef.current = null; }
    if (centre && centre.lat != null && centre.lng != null) {
      const el = document.createElement("div");
      el.style.cssText = "width:28px;height:28px;border-radius:50%;background:#EF4444;border:3px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.4);";
      const marker = new mapboxgl.Marker(el)
        .setLngLat([centre.lng, centre.lat])
        .setPopup(centreLabel ? new mapboxgl.Popup({ offset: 18 }).setText(centreLabel) : undefined)
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
    homeMarkersRef.current.forEach((m) => m.remove());
    homeMarkersRef.current = [];
    if (!homes.length) return;
    homes.forEach((home, i) => {
      if (home.latitude == null || home.longitude == null) return;
      const el = document.createElement("div");
      el.className = "cm-home-marker";
      el.textContent = String(i + 1);
      el.style.cssText = "background:#14532D;color:#fff;font-size:11px;font-weight:700;width:24px;height:24px;border-radius:50%;display:flex;align-items:center;justify-content:center;border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.4);cursor:pointer;font-family:Inter,system-ui,sans-serif;";
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
        el.addEventListener("click", () => onMarkerClick(i, home));
      }
      homeMarkersRef.current.push(marker);
    });
    return () => {
      homeMarkersRef.current.forEach((m) => m.remove());
      homeMarkersRef.current = [];
    };
  }, [homes, ready, onMarkerClick]);

  // ----------------- pan-to (used by "Zoom map here" buttons in the list)
  useEffect(() => {
    if (!ready || !mapRef.current || !flyTo) return;
    if (flyTo.lat == null || flyTo.lng == null) return;
    mapRef.current.flyTo({ center: [flyTo.lng, flyTo.lat], zoom: 14, speed: 1.6 });
  }, [flyTo, ready]);

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
