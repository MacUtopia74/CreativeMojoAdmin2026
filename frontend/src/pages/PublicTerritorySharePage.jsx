// Public read-only viewer for a shared Territory Plan.
//
// No auth — token from the URL hits `/api/public/territory-plans/:token`
// and renders a clean, branded page so a prospective franchisee can see
// their proposed territory + total CQC home count.
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { API_BASE } from "@/lib/api";
import axios from "axios";
import TerritoryMap from "@/components/territory/TerritoryMap";
import Logo from "@/components/Logo";
import { AlertCircle, Loader2, MapPin, Home as HomeIcon } from "lucide-react";

export default function PublicTerritorySharePage() {
  const { token } = useParams();
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const { data } = await axios.get(`${API_BASE}/public/territory-plans/${token}`);
        setData(data);
      } catch (e) {
        setErr(
          e?.response?.status === 404
            ? "This share link is no longer active. Please contact the Creative Mojo team for a refreshed link."
            : e?.response?.data?.detail || "We couldn't load this territory."
        );
      } finally {
        setLoading(false);
      }
    })();
  }, [token]);

  if (loading) {
    return (
      <div className="min-h-screen bg-stone-50 flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-stone-400" data-testid="public-territory-loading" />
      </div>
    );
  }
  if (err) {
    return (
      <div className="min-h-screen bg-stone-50 flex items-center justify-center p-6">
        <div className="max-w-md bg-white border border-amber-300 bg-amber-50/60 rounded-2xl p-6 text-center" data-testid="public-territory-error">
          <AlertCircle className="w-8 h-8 text-amber-700 mx-auto mb-2" />
          <div className="text-sm text-stone-800">{err}</div>
        </div>
      </div>
    );
  }

  // Map expects `sectors: [{ sector, geometry }]` and treats `selected` as
  // the highlighted set. We want every sector highlighted (it's the proposed
  // territory) — so we pass the same codes in both arrays.
  const mapSectors = (data.sectors || []).map((s) => ({
    sector: s.sector,
    geometry: s.geometry,
    home_count: s.home_count || 0,
    distance_km: 0,
  }));
  const selectedCodes = (data.sector_codes || []).slice();

  return (
    <div className="min-h-screen bg-[#F9F9F8]">
      {/* Branded header */}
      <header className="bg-white border-b border-stone-200">
        <div className="max-w-6xl mx-auto px-6 py-5 flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-4">
            <Logo className="h-12" />
            <div className="hidden sm:block w-px h-10 bg-stone-200" />
            <div>
              <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-500">
                Proposed Territory
              </div>
              <h1 className="font-display text-xl sm:text-2xl text-stone-950 leading-tight" data-testid="public-plan-name">
                {data.name}
              </h1>
            </div>
          </div>
          <div className="bg-stone-50 border border-stone-200 rounded-xl px-4 py-2.5 flex items-center gap-3">
            <HomeIcon className="w-5 h-5 text-emerald-600" />
            <div>
              <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">
                Care Homes
              </div>
              <div className="font-display text-2xl text-stone-950 tabular-nums" data-testid="public-home-count">
                {data.home_count}
              </div>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-6 space-y-5">
        {/* Map */}
        <div className="bg-white border border-stone-200 rounded-2xl overflow-hidden" data-testid="public-territory-map">
          <TerritoryMap
            sectors={mapSectors}
            selected={selectedCodes}
            centre={data.centre}
            centreLabel={data.centre_postcode || ""}
            height={620}
            interactive={false}
          />
        </div>

        {/* Below-map info */}
        <div className="grid sm:grid-cols-2 gap-4">
          <div className="bg-white border border-stone-200 rounded-2xl p-5">
            <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-500 mb-2">
              At a glance
            </div>
            <ul className="text-sm text-stone-700 space-y-1.5 leading-relaxed">
              <li className="flex items-baseline gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 mt-1.5 shrink-0" />
                <span><strong className="text-stone-950 tabular-nums">{data.sector_codes?.length || 0}</strong> postcode sectors</span>
              </li>
              <li className="flex items-baseline gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 mt-1.5 shrink-0" />
                <span><strong className="text-stone-950 tabular-nums">{data.home_count}</strong> regulated care homes (CQC-registered)</span>
              </li>
              {data.centre_postcode && (
                <li className="flex items-baseline gap-2">
                  <MapPin className="w-3.5 h-3.5 text-stone-500 shrink-0 mt-0.5" />
                  <span>Centred near <strong className="text-stone-950">{data.centre_postcode}</strong></span>
                </li>
              )}
            </ul>
          </div>

          <div className="bg-white border border-stone-200 rounded-2xl p-5">
            <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-500 mb-2">
              Postcode sectors in this territory
            </div>
            <div className="flex flex-wrap gap-1.5 max-h-40 overflow-auto">
              {(data.sector_codes || []).map((s) => (
                <span key={s} className="px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider bg-stone-100 text-stone-700 rounded">
                  {s}
                </span>
              ))}
            </div>
          </div>
        </div>

        <footer className="text-center text-xs text-stone-500 pt-4">
          Shared by Creative Mojo · Bringing craft to care.
        </footer>
      </main>
    </div>
  );
}
