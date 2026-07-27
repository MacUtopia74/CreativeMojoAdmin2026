// UK-wide territory atlas modal — at-a-glance geo view of where a
// contact sits relative to every franchisee's territory. Triggered
// from the compact "Show on map" button beside the postcode inside
// ContactDrawer.
//
// Reuses:
//   * ``GET /api/territory/all-franchisees``  → cached FeatureCollection
//     of every franchisee's dissolved territory outlines + fills.
//   * ``https://api.postcodes.io/postcodes/{postcode}``  → free public
//     geocoder for a single postcode → { latitude, longitude }.
//
// Deliberately minimal: no interaction beyond zoom/pan, no editing.
// Square 800px modal, keyboard-close on Escape, click-outside close.

import { useEffect, useMemo, useRef, useState } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import { X, MapPin, Loader2, AlertTriangle } from "lucide-react";
import api from "@/lib/api";

const MAPBOX_TOKEN = process.env.REACT_APP_MAPBOX_TOKEN;

export default function ContactPostcodeMapModal({ contact, onClose }) {
  const wrapRef = useRef(null);
  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);
  const [atlas, setAtlas] = useState(null);        // FeatureCollection
  const [geocode, setGeocode] = useState(null);    // { lat, lng }
  const [geocodeError, setGeocodeError] = useState(null);
  const [atlasError, setAtlasError] = useState(null);
  const [loading, setLoading] = useState(true);

  const postcode = useMemo(
    () => (contact?.postcode || "").trim().toUpperCase(),
    [contact],
  );

  // Fetch atlas + geocode in parallel.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const [atlasP, geoP] = await Promise.allSettled([
        api.get("/territory/all-franchisees"),
        postcode
          ? fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(postcode)}`)
              .then((r) => r.json())
          : Promise.resolve(null),
      ]);
      if (cancelled) return;

      if (atlasP.status === "fulfilled") {
        setAtlas(atlasP.value.data);
        setAtlasError(null);
      } else {
        setAtlasError(atlasP.reason?.message || "Could not load territory atlas");
      }

      if (geoP.status === "fulfilled" && geoP.value?.result) {
        setGeocode({
          lat: geoP.value.result.latitude,
          lng: geoP.value.result.longitude,
          admin_district: geoP.value.result.admin_district,
        });
        setGeocodeError(null);
      } else if (postcode) {
        setGeocodeError(
          geoP.status === "fulfilled"
            ? (geoP.value?.error || "Postcode not recognised")
            : "Postcode lookup failed",
        );
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [postcode]);

  // Escape / outside-click close.
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose?.(); };
    const onDoc = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) onClose?.();
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDoc);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDoc);
    };
  }, [onClose]);

  // Boot Mapbox once we have both the container AND the atlas.
  useEffect(() => {
    if (!MAPBOX_TOKEN) return;
    if (!mapContainerRef.current || !atlas) return;
    if (mapRef.current) return;
    mapboxgl.accessToken = MAPBOX_TOKEN;
    const map = new mapboxgl.Map({
      container: mapContainerRef.current,
      style: "mapbox://styles/mapbox/light-v11",
      center: [-2.5, 54.0],          // rough UK centre
      zoom: 5.2,
      attributionControl: false,
    });
    mapRef.current = map;

    map.on("load", () => {
      // Add every franchisee's dissolved territory outline + fill.
      // Atlas response shape from /territory/all-franchisees:
      //   { geojson: FeatureCollection (fills, one per franchisee),
      //     outlines: FeatureCollection (outlines, one per franchisee),
      //     franchisees: [...] }
      // Each feature carries a ``color`` property already assigned via
      // Welsh-Powell colouring server-side, so adjacent territories
      // never collide.
      const fills = atlas.geojson || atlas.fills || null;
      const outlines = atlas.outlines || null;

      if (fills) {
        map.addSource("all-fills", { type: "geojson", data: fills });
        map.addLayer({
          id: "all-fills-layer",
          type: "fill",
          source: "all-fills",
          paint: {
            "fill-color": ["coalesce", ["get", "color"], "#a3e635"],
            "fill-opacity": 0.45,
          },
        });
      }
      if (outlines) {
        map.addSource("all-outlines", { type: "geojson", data: outlines });
        map.addLayer({
          id: "all-outlines-layer",
          type: "line",
          source: "all-outlines",
          paint: {
            "line-color": ["coalesce", ["get", "color"], "#65a30d"],
            "line-width": 1.2,
            "line-opacity": 0.95,
          },
        });
      }

      // Drop the contact's pin + fly to it if we have a geocode.
      if (geocode?.lat && geocode?.lng) {
        new mapboxgl.Marker({ color: "#dc2626" })
          .setLngLat([geocode.lng, geocode.lat])
          .setPopup(
            new mapboxgl.Popup({ offset: 20, closeButton: false }).setHTML(
              `<div style="font-family: system-ui; font-size: 12px; padding: 4px 6px;">
                <div style="font-weight: 700;">${contact?.first_name || ""} ${contact?.last_name || ""}</div>
                <div style="color: #57534e;">${postcode}</div>
                ${geocode.admin_district ? `<div style="color: #78716c;">${geocode.admin_district}</div>` : ""}
              </div>`,
            ),
          )
          .addTo(map)
          .togglePopup();
        map.flyTo({ center: [geocode.lng, geocode.lat], zoom: 8.5, duration: 900 });
      }
    });
  }, [atlas, geocode, contact, postcode]);

  // Fly to a new geocode when it arrives after the map has already loaded.
  useEffect(() => {
    if (!mapRef.current || !geocode?.lat) return;
    if (!mapRef.current.loaded()) return;
    mapRef.current.flyTo({
      center: [geocode.lng, geocode.lat], zoom: 8.5, duration: 900,
    });
  }, [geocode]);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      if (mapRef.current) { mapRef.current.remove(); mapRef.current = null; }
    };
  }, []);

  const displayName = `${contact?.first_name || ""} ${contact?.last_name || ""}`.trim()
    || contact?.email || "Contact";

  return (
    <div
      className="fixed inset-0 z-[70] bg-black/60 flex items-center justify-center p-4"
      data-testid="contact-postcode-map-modal"
    >
      <div
        ref={wrapRef}
        className="bg-white rounded-2xl shadow-2xl overflow-hidden flex flex-col"
        style={{ width: 800, height: 800, maxWidth: "95vw", maxHeight: "95vh" }}
      >
        <div className="px-4 py-3 border-b border-stone-200 flex items-start justify-between gap-3 shrink-0">
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-500 mb-0.5 flex items-center gap-1.5">
              <MapPin className="w-3 h-3" /> UK territory atlas
            </div>
            <div className="text-base font-bold text-stone-950 truncate">
              {displayName} · <span className="font-mono">{postcode || "no postcode"}</span>
            </div>
            {geocode?.admin_district && (
              <div className="text-xs text-stone-500 mt-0.5">{geocode.admin_district}</div>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            data-testid="postcode-map-close"
            className="shrink-0 w-8 h-8 rounded-full border border-stone-300 text-stone-600 hover:bg-stone-50 flex items-center justify-center"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="relative flex-1 min-h-0 bg-stone-100">
          {loading && (
            <div className="absolute inset-0 flex items-center justify-center z-10 bg-white/70">
              <div className="flex items-center gap-2 text-sm text-stone-600">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading atlas…
              </div>
            </div>
          )}
          {!MAPBOX_TOKEN && (
            <div className="absolute inset-0 flex items-center justify-center p-6 text-center">
              <div className="text-sm text-stone-600">
                Map unavailable — <code>REACT_APP_MAPBOX_TOKEN</code> is not configured.
              </div>
            </div>
          )}
          {atlasError && (
            <div className="absolute top-3 left-3 right-3 z-10 bg-red-50 border border-red-200 text-red-900 text-xs rounded p-2 flex items-start gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" /> {atlasError}
            </div>
          )}
          {geocodeError && !loading && (
            <div className="absolute bottom-3 left-3 right-3 z-10 bg-amber-50 border border-amber-300 text-amber-900 text-xs rounded p-2 flex items-start gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              Postcode <span className="font-mono">{postcode}</span> couldn&apos;t be geocoded ({geocodeError}). Showing UK atlas without a pin.
            </div>
          )}
          <div ref={mapContainerRef} className="w-full h-full" data-testid="postcode-map-canvas" />
        </div>
      </div>
    </div>
  );
}
