// Portal — Playlist player page.
//
// Embedded YouTube playlist iframe + sidebar list of videos pulled from
// our cached metadata. "Watch on YouTube" CTA links externally.
import { useEffect, useMemo, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { ArrowLeft, Loader2, AlertCircle, PlayCircle, Clock, Sparkles } from "lucide-react";
import api from "@/lib/api";
import { bustThumb } from "@/lib/youtubeThumb";

// Convert ISO 8601 duration (PT1H2M3S) to a friendly "1:02:03" or "2:03".
function fmtDuration(iso) {
  if (!iso) return "";
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return "";
  const h = +(m[1] || 0), mm = +(m[2] || 0), s = +(m[3] || 0);
  const pad = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(mm)}:${pad(s)}` : `${mm}:${pad(s)}`;
}

export default function PortalPlaylistPage() {
  const { playlistId } = useParams();
  const [playlist, setPlaylist] = useState(null);
  const [activeVideoId, setActiveVideoId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    setLoading(true); setError("");
    api.get(`/portal/training/${playlistId}`)
      .then(({ data }) => {
        setPlaylist(data);
        // Default to the newest video (first in our date-sorted list) so a
        // freshly-uploaded meeting plays straight away when a franchisee
        // opens the playlist.
        const sortedFirst = [...(data.videos || [])].sort((a, b) => {
          const ta = a.published_at ? new Date(a.published_at).getTime() : 0;
          const tb = b.published_at ? new Date(b.published_at).getTime() : 0;
          return tb - ta;
        })[0];
        if (sortedFirst) setActiveVideoId(sortedFirst.youtube_id);
      })
      .catch((e) => setError(e?.response?.data?.detail || "Couldn't load this playlist."))
      .finally(() => setLoading(false));
  }, [playlistId]);

  // Date-sorted video list (newest first). Falls back to the original
  // playlist order for any videos missing ``published_at``.
  const sortedVideos = useMemo(() => {
    return [...(playlist?.videos || [])].sort((a, b) => {
      const ta = a.published_at ? new Date(a.published_at).getTime() : 0;
      const tb = b.published_at ? new Date(b.published_at).getTime() : 0;
      return tb - ta;
    });
  }, [playlist]);
  const latestVideoId = sortedVideos[0]?.youtube_id;

  if (loading) {
    return <div className="py-16 text-center text-stone-500"><Loader2 className="w-6 h-6 animate-spin inline" /></div>;
  }
  if (error || !playlist) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-900 flex items-center gap-2">
        <AlertCircle className="w-4 h-4 shrink-0" /> {error || "Not found."}
      </div>
    );
  }

  // Embed URL — autoplay the selected video while keeping the playlist
  // queue active so "Up next" works naturally inside the iframe.
  //
  // Sharing hardening (per Paul, Jun 2026):
  //   • ``rel=0`` — never end on suggested videos
  //   • ``modestbranding=1`` — no YT logo bug
  //   • ``iv_load_policy=3`` — hide annotations/cards
  //   • ``disablekb=1`` — kill keyboard shortcuts that surface the share menu
  //   • ``cc_load_policy=0`` — hide closed-caption pop-overs
  //   • Origin pinned so YT denies the iframe outside our hosts
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const lockdownParams = `rel=0&modestbranding=1&iv_load_policy=3&disablekb=1&cc_load_policy=0&playsinline=1&origin=${encodeURIComponent(origin)}`;
  const embedSrc = activeVideoId
    ? `https://www.youtube-nocookie.com/embed/${activeVideoId}?list=${playlist.youtube_id}&${lockdownParams}`
    : `https://www.youtube-nocookie.com/embed/videoseries?list=${playlist.youtube_id}&${lockdownParams}`;

  return (
    <div className="space-y-4" data-testid="portal-playlist-page">
      <Link to="/portal/training" className="inline-flex items-center gap-1.5 text-xs uppercase tracking-wider font-bold text-stone-600 hover:text-stone-950">
        <ArrowLeft className="w-3.5 h-3.5" /> Back to Training
      </Link>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="font-display text-2xl sm:text-3xl font-black text-stone-950 leading-tight">{playlist.title}</h1>
          {playlist.description && (
            <p className="text-sm text-stone-600 mt-2 max-w-3xl whitespace-pre-line">{playlist.description}</p>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-5">
        {/* Player */}
        <div className="bg-stone-950 rounded-2xl overflow-hidden aspect-video relative">
          <iframe
            key={activeVideoId || playlist.youtube_id}
            src={embedSrc}
            title={playlist.title}
            className="w-full h-full"
            frameBorder="0"
            // No `web-share` permission — closes off the most obvious
            // share-menu path inside the player.
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin"
            sandbox="allow-scripts allow-same-origin allow-presentation"
            data-testid="playlist-iframe"
          />
        </div>

        {/* Video list */}
        <aside className="bg-white border border-stone-200 rounded-2xl overflow-hidden">
          <div className="px-4 py-3 border-b border-stone-200">
            <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">Up Next · newest first</div>
            <div className="text-sm font-bold text-stone-950">{sortedVideos.length} video{sortedVideos.length === 1 ? "" : "s"}</div>
          </div>
          <div className="max-h-[60vh] lg:max-h-[480px] overflow-y-auto divide-y divide-stone-100">
            {sortedVideos.map((v, i) => {
              const active = activeVideoId === v.youtube_id;
              const isLatest = v.youtube_id === latestVideoId;
              return (
                <button
                  key={v.youtube_id + i}
                  type="button"
                  onClick={() => setActiveVideoId(v.youtube_id)}
                  data-testid={`playlist-video-${v.youtube_id}`}
                  className={`w-full text-left flex items-stretch gap-2.5 p-2.5 transition-colors ${
                    active ? "bg-[#dedd0a]/15" : "hover:bg-stone-50"
                  }`}
                >
                  <div className="relative w-24 aspect-video bg-stone-100 rounded overflow-hidden shrink-0">
                    {v.thumbnail_url
                      ? <img src={bustThumb(v.thumbnail_url, playlist.last_synced_at)} alt={v.title} className="w-full h-full object-cover" />
                      : <div className="w-full h-full flex items-center justify-center text-stone-400"><PlayCircle className="w-5 h-5" /></div>}
                    {v.duration_iso && (
                      <span className="absolute bottom-0.5 right-0.5 bg-stone-950/85 text-white text-[9px] font-bold px-1 py-0.5 rounded inline-flex items-center gap-0.5">
                        <Clock className="w-2.5 h-2.5" /> {fmtDuration(v.duration_iso)}
                      </span>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start gap-1.5">
                      <div className={`text-xs font-semibold line-clamp-2 flex-1 ${active ? "text-stone-950" : "text-stone-800"}`}>{v.title}</div>
                      {isLatest && (
                        <span
                          data-testid="playlist-latest-badge"
                          className="shrink-0 inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[9px] font-black uppercase tracking-wider rounded bg-[#dedd0a] text-stone-950"
                          title="Most recently added"
                        >
                          <Sparkles className="w-2.5 h-2.5" /> Latest
                        </span>
                      )}
                    </div>
                    <div className="text-[10px] text-stone-500 mt-0.5">#{i + 1}</div>
                  </div>
                </button>
              );
            })}
          </div>
        </aside>
      </div>
    </div>
  );
}
