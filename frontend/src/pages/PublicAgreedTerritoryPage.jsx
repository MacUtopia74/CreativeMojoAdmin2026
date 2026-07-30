// Public read-only viewer for a frozen contract territory snapshot.
//
// This page is what the `[[TERRITORY_MAP_URL]]` link inside an issued
// PDF resolves to. No auth — the {snapshotId} + {token} pair in the
// URL is the only guard; the token is cryptographically unguessable
// so a leaked snapshot ID alone is not enough to view the record.
//
// The page renders TWO shapes of frozen territory:
//   1. Sector-only snapshots — franchisees whose agreed territory is
//      expressed as postcode-sector strings (e.g. "EX15 1"). We show
//      the sectors as a readable grouped list. No "map data missing"
//      copy — sector-only IS the agreed data.
//   2. Tile-based snapshots — franchisees whose territory came out of
//      the Territory Builder. We list the tiles with postcode + county.
// Both shapes get the same header (frozen date, franchise ref) and
// footer so recipients can identify which contract this belongs to.
import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import axios from "axios";
import { API_BASE } from "@/lib/api";
import Logo from "@/components/Logo";
import { AlertCircle, CalendarCheck, Loader2, MapPin, ShieldCheck } from "lucide-react";

function formatFrozenDate(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("en-GB", {
      dateStyle: "long",
      timeStyle: "short",
    });
  } catch {
    return iso;
  }
}

/**
 * Group flat postcode sectors ("EX15 1", "EX15 2", "EX16 4", ...)
 * by their outward code (letters+digits before the space) so the
 * reader sees "EX15 · 1, 2, 3" instead of a wall of full strings.
 * Alphabetical within each outward, alphabetical across outwards —
 * deterministic every render.
 */
function groupSectors(sectors) {
  const groups = new Map();
  for (const raw of sectors || []) {
    const s = String(raw || "").trim();
    if (!s) continue;
    const parts = s.split(/\s+/);
    const outward = (parts[0] || s).toUpperCase();
    const inward = (parts[1] || "").toUpperCase();
    if (!groups.has(outward)) groups.set(outward, new Set());
    if (inward) groups.get(outward).add(inward);
  }
  return Array.from(groups.entries())
    .map(([outward, inwards]) => ({
      outward,
      inwards: Array.from(inwards).sort(),
    }))
    .sort((a, b) => a.outward.localeCompare(b.outward));
}

export default function PublicAgreedTerritoryPage() {
  const { snapshotId, token } = useParams();
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const { data } = await axios.get(
          `${API_BASE}/territory-snapshots/${snapshotId}/${token}`,
        );
        setData(data);
      } catch (e) {
        setErr(
          e?.response?.status === 404
            ? "This agreed-territory link is not recognised. If you received it from Creative Mojo, please contact them for a refreshed link."
            : e?.response?.data?.detail || "We couldn't load this agreed territory.",
        );
      } finally {
        setLoading(false);
      }
    })();
  }, [snapshotId, token]);

  const sectorGroups = useMemo(
    () => groupSectors(data?.territory_sectors || []),
    [data],
  );
  const totalSectors = (data?.territory_sectors || []).length;
  const tiles = data?.territory_tiles || [];
  const hasSectors = totalSectors > 0;
  const hasTiles = tiles.length > 0;

  if (loading) {
    return (
      <div className="min-h-screen bg-stone-50 flex items-center justify-center">
        <Loader2
          className="w-6 h-6 animate-spin text-stone-400"
          data-testid="agreed-territory-loading"
        />
      </div>
    );
  }

  if (err) {
    return (
      <div className="min-h-screen bg-stone-50 flex items-center justify-center p-6">
        <div
          className="max-w-md bg-white border border-amber-300 bg-amber-50/60 rounded-2xl p-6 text-center"
          data-testid="agreed-territory-error"
        >
          <AlertCircle className="w-8 h-8 text-amber-700 mx-auto mb-2" />
          <div className="text-sm text-stone-800">{err}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F9F9F8]" data-testid="agreed-territory-page">
      {/* Branded header */}
      <header className="bg-white border-b border-stone-200">
        <div className="max-w-4xl mx-auto px-6 py-5 flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-4">
            <Logo className="h-12" />
            <div className="hidden sm:block w-px h-10 bg-stone-200" />
            <div>
              <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-500">
                Agreed Territory
              </div>
              <div className="font-display text-lg text-stone-950 leading-tight">
                Frozen at contract signing
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 text-xs text-stone-500">
            <ShieldCheck className="w-4 h-4 text-emerald-600" />
            <span>Immutable snapshot</span>
          </div>
        </div>
      </header>

      {/* Meta strip */}
      <div className="max-w-4xl mx-auto px-6 pt-8 pb-4">
        <div
          className="grid grid-cols-1 sm:grid-cols-3 gap-px bg-stone-200 border border-stone-200 rounded-2xl overflow-hidden"
          data-testid="agreed-territory-meta"
        >
          <div className="bg-white p-4">
            <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 flex items-center gap-1.5">
              <CalendarCheck className="w-3 h-3" /> Frozen on
            </div>
            <div
              className="font-display text-lg text-stone-950 mt-1"
              data-testid="agreed-territory-frozen-at"
            >
              {formatFrozenDate(data?.created_at)}
            </div>
          </div>
          <div className="bg-white p-4">
            <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 flex items-center gap-1.5">
              <MapPin className="w-3 h-3" /> Total scope
            </div>
            <div className="font-display text-lg text-stone-950 mt-1">
              {hasSectors ? (
                <span data-testid="agreed-territory-sector-count">
                  {totalSectors} postcode {totalSectors === 1 ? "sector" : "sectors"}
                </span>
              ) : hasTiles ? (
                <span data-testid="agreed-territory-tile-count">
                  {tiles.length} territory {tiles.length === 1 ? "tile" : "tiles"}
                </span>
              ) : (
                <span className="text-stone-400">—</span>
              )}
            </div>
          </div>
          <div className="bg-white p-4">
            <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">
              Snapshot reference
            </div>
            <div
              className="font-mono text-xs text-stone-700 mt-1 truncate"
              title={data?.snapshot_id || ""}
            >
              {(data?.snapshot_id || "").slice(0, 12) || "—"}
            </div>
          </div>
        </div>
      </div>

      {/* Body */}
      <main className="max-w-4xl mx-auto px-6 py-8 space-y-8">
        {/* Sector-only or sector-first: readable postcode list */}
        {hasSectors && (
          <section
            className="bg-white border border-stone-200 rounded-2xl p-6 sm:p-8"
            data-testid="agreed-territory-sectors-section"
          >
            <h1 className="font-display text-2xl sm:text-3xl text-stone-950 mb-1">
              Agreed postcode sectors
            </h1>
            <p className="text-sm text-stone-500 mb-6">
              These are the exact postcode sectors covered by the contract, frozen at
              the moment of signing. The list below is the authoritative record.
            </p>

            <ul
              className="space-y-4"
              data-testid="agreed-territory-sector-groups"
            >
              {sectorGroups.map((g) => (
                <li
                  key={g.outward}
                  className="grid grid-cols-[auto_1fr] gap-4 items-baseline"
                  data-testid={`agreed-territory-group-${g.outward}`}
                >
                  <span className="font-display text-lg text-stone-950 tabular-nums">
                    {g.outward}
                  </span>
                  <div className="flex flex-wrap gap-1.5">
                    {g.inwards.map((inw) => (
                      <span
                        key={`${g.outward}-${inw}`}
                        className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-stone-100 text-stone-800 border border-stone-200 tabular-nums"
                        data-testid={`agreed-territory-sector-${g.outward}-${inw}`}
                      >
                        {g.outward} {inw}
                      </span>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Tile-based rendering — only shown when tiles are present.
            Sector-only snapshots deliberately hide this block. */}
        {hasTiles && (
          <section
            className="bg-white border border-stone-200 rounded-2xl p-6 sm:p-8"
            data-testid="agreed-territory-tiles-section"
          >
            <h2 className="font-display text-2xl text-stone-950 mb-1">
              Agreed territory tiles
            </h2>
            <p className="text-sm text-stone-500 mb-6">
              The individual territory tiles included in this contract, frozen at signing.
            </p>
            <ul className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {tiles.map((t) => (
                <li
                  key={t.id || `${t.postcode}-${t.county}`}
                  className="border border-stone-200 rounded-xl p-3 flex items-baseline justify-between gap-3"
                  data-testid={`agreed-territory-tile-${t.id || t.postcode}`}
                >
                  <span className="font-mono text-sm text-stone-900 tabular-nums">
                    {t.postcode || "—"}
                  </span>
                  <span className="text-xs text-stone-500 truncate">
                    {t.county || ""}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>

      <footer className="max-w-4xl mx-auto px-6 pb-10">
        <p className="text-xs text-stone-500 text-center">
          Creative Mojo Ltd · Registered in England &amp; Wales No. 10261882.
          This page is the immutable record referenced by your Franchise Agreement.
        </p>
      </footer>
    </div>
  );
}
