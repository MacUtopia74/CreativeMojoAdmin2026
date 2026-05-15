// Reusable Mapbox UK map for the Territory Builder + franchisee portal.
// Renders postcode-sector centroids as clickable circles. Click toggles
// selection and bubbles the change to the parent via `onToggleSector`.
import { useEffect, useRef, useState } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";

const TOKEN = process.env.REACT_APP_MAPBOX_TOKEN;

export default function TerritoryMap({
  sectors = [],          // [{sector, latitude, longitude, home_count, distance_km}]
  selected = [],         // array of sector codes (strings)
  centre = null,         // { lat, lng } — marker for the contact's postcode
  centreLabel = "",
  height = 520,
  interactive = true,
  onToggleSector = () => {},
  onMapClick = () => {}, // bubbles non-sector clicks
}) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const centreMarkerRef = useRef(null);
  const [ready, setReady] = useState(false);

  // Init once
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    if (!TOKEN) {
      // Will render an inline notice below; map ref stays null.
      return;
    }
    mapboxgl.accessToken = TOKEN;
    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: "mapbox://styles/mapbox/light-v11",
      center: centre ? [centre.lng, centre.lat] : [-2.5, 53.4],
      zoom: centre ? 9.5 : 5.4,
      attributionControl: true,
    });
    map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), "top-right");
    mapRef.current = map;

    map.on("load", () => {
      map.addSource("sectors", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });

      // Outer "halo" — selected sectors get a thick highlight
      map.addLayer({
        id: "sectors-halo",
        type: "circle",
        source: "sectors",
        paint: {
          "circle-radius": ["case", ["get", "selected"], 18, 0],
          "circle-color": "#D4FF00",
          "circle-opacity": 0.55,
        },
      });

      // Main sector circle (size scales with home count)
      map.addLayer({
        id: "sectors-fill",
        type: "circle",
        source: "sectors",
        paint: {
          "circle-radius": [
            "interpolate", ["linear"], ["get", "home_count"],
            0, 6, 5, 9, 15, 12, 40, 16,
          ],
          "circle-color": ["case",
            ["get", "selected"], "#0F172A",
            ["get", "owned"], "#10B981",
            "#FFFFFF",
          ],
          "circle-stroke-width": 2,
          "circle-stroke-color": ["case",
            ["get", "selected"], "#0F172A",
            ["get", "owned"], "#059669",
            "#737373",
          ],
        },
      });

      // Sector label
      map.addLayer({
        id: "sectors-label",
        type: "symbol",
        source: "sectors",
        layout: {
          "text-field": ["get", "sector"],
          "text-size": 10,
          "text-offset": [0, 1.4],
          "text-font": ["Open Sans Bold", "Arial Unicode MS Bold"],
        },
        paint: {
          "text-color": "#1c1917",
          "text-halo-color": "#ffffff",
          "text-halo-width": 1.5,
        },
      });

      // Home-count badge in the centre of the dot
      map.addLayer({
        id: "sectors-count",
        type: "symbol",
        source: "sectors",
        layout: {
          "text-field": ["to-string", ["get", "home_count"]],
          "text-size": 10,
          "text-font": ["Open Sans Bold", "Arial Unicode MS Bold"],
          "text-allow-overlap": true,
        },
        paint: {
          "text-color": ["case", ["get", "selected"], "#D4FF00", "#1c1917"],
        },
      });

      map.on("click", "sectors-fill", (e) => {
        const f = e.features?.[0];
        if (!f) return;
        e.preventDefault?.();
        onToggleSector(f.properties.sector);
      });

      map.on("mouseenter", "sectors-fill", () => {
        map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", "sectors-fill", () => {
        map.getCanvas().style.cursor = "";
      });

      map.on("click", (e) => {
        if (e.defaultPrevented) return;
        onMapClick({ lng: e.lngLat.lng, lat: e.lngLat.lat });
      });

      setReady(true);
    });

    return () => {
      map.remove();
      mapRef.current = null;
    };
    // We deliberately do NOT depend on centre/sectors here — those drive
    // separate effects below to avoid re-creating the map on every change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Push sector data into the map whenever they change
  useEffect(() => {
    if (!ready || !mapRef.current) return;
    const src = mapRef.current.getSource("sectors");
    if (!src) return;
    const sel = new Set(selected);
    const features = sectors
      .filter((s) => s.latitude != null && s.longitude != null)
      .map((s) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [s.longitude, s.latitude] },
        properties: {
          sector: s.sector,
          home_count: s.home_count || 0,
          selected: sel.has(s.sector),
          owned: !!s.owned,
        },
      }));
    src.setData({ type: "FeatureCollection", features });
  }, [sectors, selected, ready]);

  // Centre marker
  useEffect(() => {
    if (!ready || !mapRef.current) return;
    if (centreMarkerRef.current) {
      centreMarkerRef.current.remove();
      centreMarkerRef.current = null;
    }
    if (centre && centre.lat != null && centre.lng != null) {
      const el = document.createElement("div");
      el.style.cssText = "width:28px;height:28px;border-radius:50%;background:#EF4444;border:3px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.4);";
      const marker = new mapboxgl.Marker(el)
        .setLngLat([centre.lng, centre.lat])
        .setPopup(centreLabel ? new mapboxgl.Popup({ offset: 18 }).setText(centreLabel) : undefined)
        .addTo(mapRef.current);
      centreMarkerRef.current = marker;
      mapRef.current.flyTo({ center: [centre.lng, centre.lat], zoom: 10.5, speed: 1.4 });
    }
  }, [centre, centreLabel, ready]);

  if (!TOKEN) {
    return (
      <div className="rounded-2xl border border-amber-300 bg-amber-50 px-4 py-6 text-sm text-amber-900" data-testid="map-no-token">
        <strong>Map disabled:</strong> add <code className="bg-amber-100 px-1 rounded">REACT_APP_MAPBOX_TOKEN</code> to <code>/app/frontend/.env</code> to render the map.
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
