// Portal — Video Hub landing page.
//
// Two sections (Training Videos / Franchisee Meetings) populated from
// the admin-curated YouTube playlist cache. Each card clicks through
// to /portal/training/{id} where the embedded player lives.
//
// View modes:
//   • Grid — large thumbnails, 3 across on desktop (default).
//   • List — single column with small thumbnail + meta on the right.
//     Choice is persisted in localStorage like the File Vault page.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  GraduationCap, Loader2, AlertCircle, PlayCircle, Users,
  LayoutGrid, List,
} from "lucide-react";
import api from "@/lib/api";

function GridCard({ playlist }) {
  return (
    <Link
      to={`/portal/training/${playlist.id}`}
      data-testid={`training-card-${playlist.id}`}
      className="group bg-white border border-stone-200 rounded-2xl overflow-hidden hover:border-stone-400 hover:shadow-md transition-all flex flex-col"
    >
      <div className="aspect-video bg-stone-100 relative">
        {playlist.thumbnail_url ? (
          <img src={playlist.thumbnail_url} alt={playlist.title}
               className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-stone-400">
            <PlayCircle className="w-12 h-12" />
          </div>
        )}
        <div className="absolute bottom-2 right-2 bg-stone-950/80 text-white text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded">
          {playlist.video_count} video{playlist.video_count === 1 ? "" : "s"}
        </div>
        <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity bg-stone-950/30">
          <PlayCircle className="w-14 h-14 text-white" strokeWidth={1.5} />
        </div>
      </div>
      <div className="px-4 py-3 flex-1 flex flex-col">
        <h3 className="font-display text-base font-bold text-stone-950 leading-snug line-clamp-2">{playlist.title}</h3>
        {playlist.description && (
          <p className="text-xs text-stone-600 mt-1.5 line-clamp-3 leading-relaxed">{playlist.description}</p>
        )}
      </div>
    </Link>
  );
}

function ListRow({ playlist }) {
  return (
    <Link
      to={`/portal/training/${playlist.id}`}
      data-testid={`training-row-${playlist.id}`}
      className="group bg-white border border-stone-200 rounded-xl overflow-hidden hover:border-stone-400 hover:shadow-sm transition-all flex items-stretch"
    >
      <div className="w-40 sm:w-56 aspect-video bg-stone-100 relative shrink-0">
        {playlist.thumbnail_url ? (
          <img src={playlist.thumbnail_url} alt={playlist.title}
               className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-stone-400">
            <PlayCircle className="w-8 h-8" />
          </div>
        )}
        <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity bg-stone-950/30">
          <PlayCircle className="w-10 h-10 text-white" strokeWidth={1.5} />
        </div>
      </div>
      <div className="px-4 py-3 flex-1 min-w-0 flex flex-col justify-center">
        <div className="flex items-center gap-2 flex-wrap">
          <h3 className="font-display text-base sm:text-lg font-bold text-stone-950 leading-snug">{playlist.title}</h3>
          <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-stone-100 text-stone-700 border border-stone-200">
            {playlist.video_count} video{playlist.video_count === 1 ? "" : "s"}
          </span>
        </div>
        {playlist.description && (
          <p className="text-xs sm:text-sm text-stone-600 mt-1 line-clamp-2 leading-relaxed">{playlist.description}</p>
        )}
      </div>
    </Link>
  );
}

function Section({ title, icon: Icon, playlists, viewMode }) {
  if (!playlists?.length) return null;
  return (
    <section data-testid={`training-section-${title.toLowerCase().replace(/\s+/g, "-")}`}>
      <div className="flex items-center gap-3 mb-4">
        <Icon className="w-6 h-6 text-stone-700 shrink-0" />
        <h2 className="font-display text-2xl sm:text-3xl font-black text-stone-950 tracking-tight">{title}</h2>
      </div>
      {viewMode === "list" ? (
        <div className="flex flex-col gap-3">
          {playlists.map((p) => <ListRow key={p.id} playlist={p} />)}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {playlists.map((p) => <GridCard key={p.id} playlist={p} />)}
        </div>
      )}
    </section>
  );
}

export default function PortalTrainingPage() {
  const [groups, setGroups] = useState({ training: [], meetings: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [viewMode, setViewMode] = useState(() => {
    try { return localStorage.getItem("videoHubViewMode") || "grid"; } catch { return "grid"; }
  });

  useEffect(() => {
    try { localStorage.setItem("videoHubViewMode", viewMode); } catch { /* ignore */ }
  }, [viewMode]);

  useEffect(() => {
    api.get("/portal/training")
      .then(({ data }) => setGroups(data.groups || { training: [], meetings: [] }))
      .catch((e) => setError(e?.response?.data?.detail || "Couldn't load videos."))
      .finally(() => setLoading(false));
  }, []);

  const empty = !loading && !groups.training.length && !groups.meetings.length;

  return (
    <div className="space-y-8" data-testid="portal-training-page">
      {/* Yellow hero banner — matches the File Vault + Marketing pages. */}
      <div className="bg-[#dedd0a] rounded-2xl px-5 sm:px-8 py-5 sm:py-7 flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-4 min-w-0">
          <GraduationCap className="w-7 h-7 sm:w-8 sm:h-8 text-stone-950 shrink-0" strokeWidth={2.2} />
          <h1 className="font-display text-2xl sm:text-4xl font-black text-stone-950 tracking-tight">
            Video Hub
          </h1>
        </div>
        {!empty && !loading && (
          <div className="flex items-center bg-white/70 border border-stone-950/10 rounded-lg p-0.5 shrink-0" data-testid="video-hub-view-toggle">
            <button onClick={() => setViewMode("list")} data-testid="video-hub-view-list"
              title="List view"
              className={`px-2.5 py-1.5 rounded-md flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider transition-all ${viewMode === "list" ? "bg-stone-950 text-[#dedd0a] shadow-sm" : "text-stone-700 hover:text-stone-950"}`}>
              <List className="w-3.5 h-3.5" /> List
            </button>
            <button onClick={() => setViewMode("grid")} data-testid="video-hub-view-grid"
              title="Grid view"
              className={`px-2.5 py-1.5 rounded-md flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider transition-all ${viewMode === "grid" ? "bg-stone-950 text-[#dedd0a] shadow-sm" : "text-stone-700 hover:text-stone-950"}`}>
              <LayoutGrid className="w-3.5 h-3.5" /> Grid
            </button>
          </div>
        )}
      </div>

      {loading && (
        <div className="text-center py-16 text-stone-500">
          <Loader2 className="w-6 h-6 animate-spin inline" />
        </div>
      )}
      {error && (
        <div className="px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-900 flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" /> {error}
        </div>
      )}
      {empty && !error && (
        <div className="bg-white border border-stone-200 rounded-2xl px-6 py-16 text-center">
          <PlayCircle className="w-12 h-12 mx-auto text-stone-300 mb-3" strokeWidth={1.5} />
          <h2 className="font-display text-xl font-bold text-stone-950 mb-1">Nothing here yet</h2>
          <p className="text-sm text-stone-600 max-w-md mx-auto">We'll add training videos and meeting recordings here as soon as they're ready.</p>
        </div>
      )}

      <Section title="Training Videos" icon={GraduationCap} playlists={groups.training} viewMode={viewMode} />
      <Section title="Franchisee Meetings" icon={Users} playlists={groups.meetings} viewMode={viewMode} />
    </div>
  );
}
