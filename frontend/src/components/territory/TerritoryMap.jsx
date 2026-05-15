// Mapbox UK map that renders postcode-sector Voronoi polygons. Two
// rendering modes:
//   - "build" mode (default): every sector polygon shown individually
//     so each click toggles a visible cell.
//   - "merged" mode: all owned sectors are dissolved into one outline
//     (no internal borders) — matches the style of the reference map.
import { useEffect, useRef, useState } from "react";
import mapboxgl from "mapbox-gl";
import * as turf from "@turf/turf";
import "mapbox-gl/dist/mapbox-gl.css";

const TOKEN = process.env.REACT_APP_MAPBOX_TOKEN;

export default function TerritoryMap({
  sectors = [],
  selected = [],
  centre = null,
  centreLabel = "",
  height = 520,
  fillColor = "#D4FF00",
  selectedStrokeColor = "#15803D",
  mode = "build", // "build" | "merged"
  onToggleSector = () => {},
}) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const centreMarkerRef = useRef(null);
  const [ready, setReady] = useState(false);

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
      map.addSource("sectors", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addSource("merged", { type: "geojson", data: { type: "FeatureCollection", features: [] } });

      // Build-mode layers
      map.addLayer({
        id: "sectors-fill",
        type: "fill",
        source: "sectors",
        layout: { visibility: mode === "build" ? "visible" : "none" },
        paint: {
          "fill-color": ["case",
            ["get", "selected"], fillColor,
            ["get", "owned"], "#10B981",
            "#ffffff",
          ],
          "fill-opacity": ["case",
            ["get", "selected"], 0.65,
            ["get", "owned"], 0.45,
            ["boolean", ["feature-state", "hover"], false], 0.5,
            0.15,
          ],
        },
      });
      map.addLayer({
        id: "sectors-outline",
        type: "line",
        source: "sectors",
        layout: { visibility: mode === "build" ? "visible" : "none" },
        paint: {
          "line-color": ["case",
            ["get", "selected"], selectedStrokeColor,
            ["get", "owned"], "#047857",
            "#a8a29e",
          ],
          "line-width": ["case", ["get", "selected"], 2.5, ["get", "owned"], 1.5, 1],
          "line-opacity": 0.8,
        },
      });
      map.addLayer({
        id: "sectors-label",
        type: "symbol",
        source: "sectors",
        layout: {
          visibility: mode === "build" ? "visible" : "none",
          "text-field": ["concat", ["get", "sector"], "\n", ["to-string", ["get", "home_count"]], " homes"],
          "text-size": 11,
          "text-font": ["Open Sans Bold", "Arial Unicode MS Bold"],
        },
        paint: { "text-color": "#0c0a09", "text-halo-color": "#ffffff", "text-halo-width": 1.5 },
      });

      // Merged-mode layers
      map.addLayer({
        id: "merged-fill",
        type: "fill",
        source: "merged",
        layout: { visibility: mode === "merged" ? "visible" : "none" },
        paint: { "fill-color": fillColor, "fill-opacity": 0.55 },
      });
      map.addLayer({
        id: "merged-outline",
        type: "line",
        source: "merged",
        layout: { visibility: mode === "merged" ? "visible" : "none" },
        paint: { "line-color": selectedStrokeColor, "line-width": 2.5 },
      });

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
      setReady(true);
    });

    return () => { map.remove(); mapRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!ready || !mapRef.current) return;
    const src = mapRef.current.getSource("sectors");
    if (!src) return;
    const sel = new Set(selected);
    const features = sectors.filter((s) => s.geometry).map((s, i) => ({
      type: "Feature",
      id: i + 1,
      geometry: s.geometry,
      properties: {
        sector: s.sector,
        home_count: s.home_count || 0,
        selected: sel.has(s.sector),
        owned: !!s.owned,
      },
    }));
    src.setData({ type: "FeatureCollection", features });

    const mergeSrc = mapRef.current.getSource("merged");
    if (mergeSrc) {
      const ownedFeatures = features.filter((f) => f.properties.owned || f.properties.selected);
      if (ownedFeatures.length === 0) {
        mergeSrc.setData({ type: "FeatureCollection", features: [] });
      } else {
        try {
          let merged = ownedFeatures[0];
          for (let i = 1; i < ownedFeatures.length; i++) {
            const u = turf.union(turf.featureCollection([merged, ownedFeatures[i]]));
            if (u) merged = u;
          }
          mergeSrc.setData({ type: "FeatureCollection", features: [merged] });
          if (mode === "merged") {
            const bb = turf.bbox(merged);
            mapRef.current.fitBounds(bb, { padding: 50, maxZoom: 11, duration: 700 });
          }
        } catch {
          mergeSrc.setData({ type: "FeatureCollection", features: ownedFeatures });
        }
      }
    }
  }, [sectors, selected, ready, mode]);

  useEffect(() => {
    if (!ready || !mapRef.current) return;
    const m = mapRef.current;
    const buildVis = mode === "build" ? "visible" : "none";
    const mergedVis = mode === "merged" ? "visible" : "none";
    ["sectors-fill", "sectors-outline", "sectors-label"].forEach((id) =>
      m.setLayoutProperty(id, "visibility", buildVis),
    );
    ["merged-fill", "merged-outline"].forEach((id) =>
      m.setLayoutProperty(id, "visibility", mergedVis),
    );
  }, [mode, ready]);

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
      mapRef.current.flyTo({ center: [centre.lng, centre.lat], zoom: 10, speed: 1.4 });
    }
  }, [centre, centreLabel, ready]);

  if (!TOKEN) {
    return (
      <div className="rounded-2xl border border-amber-300 bg-amber-50 px-4 py-6 text-sm text-amber-900">
        <strong>Map disabled:</strong> add <code className="bg-amber-100 px-1 rounded">REACT_APP_MAPBOX_TOKEN</code> to <code>/app/frontend/.env</code>.
      </div>
    );
  }
  return (
    <div ref={containerRef}
      style={{ height, width: "100%" }}
      className="rounded-2xl overflow-hidden border border-stone-200"
      data-testid="territory-map" />
  );
}
