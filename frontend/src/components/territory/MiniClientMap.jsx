// Mini-map shown inside the My-Client modal so the franchisee sees
// exactly where the client sits while they're editing details. Light,
// self-contained Mapbox instance — never shares state with the main
// territory map. Renders a single gold ★ marker at the client's coords
// and a "Open in Google Maps" deep-link below.
import { useEffect, useRef } from "react";
import mapboxgl from "mapbox-gl";
import { ExternalLink } from "lucide-react";

const TOKEN = process.env.REACT_APP_MAPBOX_TOKEN;

export default function MiniClientMap({ lat, lng, label = "", postcode = "", heightClass = "h-48" }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);

  useEffect(() => {
    if (!TOKEN || !containerRef.current || lat == null || lng == null) return;
    mapboxgl.accessToken = TOKEN;
    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: "mapbox://styles/mapbox/streets-v12",
      center: [lng, lat],
      zoom: 15,
      interactive: true,
      attributionControl: false,
    });
    mapRef.current = map;

    // Gold ★ marker matching the main-map My-Client styling.
    const el = document.createElement("div");
    el.style.cssText = "width:30px;height:30px;border-radius:50%;background:#dddd16;color:#0c0a09;font-weight:900;font-size:16px;display:flex;align-items:center;justify-content:center;border:2px solid #0c0a09;box-shadow:0 0 0 3px rgba(221,221,22,0.45),0 2px 6px rgba(0,0,0,.4);";
    el.textContent = "★";
    new mapboxgl.Marker({ element: el, anchor: "center" })
      .setLngLat([lng, lat])
      .addTo(map);

    map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), "top-right");
    return () => { map.remove(); mapRef.current = null; };
  }, [lat, lng]);

  if (lat == null || lng == null) {
    return (
      <div className="rounded-lg bg-stone-100 border border-stone-200 text-stone-500 text-xs px-3 py-4 text-center">
        No location on file — set a postcode + we'll drop a pin automatically.
      </div>
    );
  }

  if (!TOKEN) {
    return (
      <div className="rounded-lg bg-amber-50 border border-amber-200 text-amber-900 text-xs px-3 py-4 text-center">
        Map disabled — Mapbox token missing.
      </div>
    );
  }

  const query = encodeURIComponent(label && postcode ? `${label}, ${postcode}` : (label || postcode || `${lat},${lng}`));
  const gmaps = `https://www.google.com/maps/search/?api=1&query=${query}`;

  return (
    <div className="space-y-2" data-testid="client-modal-mini-map">
      <div ref={containerRef} className={`w-full ${heightClass} rounded-lg overflow-hidden border border-stone-200`} />
      <a
        href={gmaps}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-stone-700 hover:text-stone-950"
        data-testid="client-modal-gmaps-link"
      >
        <ExternalLink className="w-3 h-3" /> Open in Google Maps
      </a>
    </div>
  );
}
