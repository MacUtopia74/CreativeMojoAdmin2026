// Admin — YouTube Playlists management.
//
// One-click sync from YouTube, plus per-playlist category assignment +
// enabled toggle. Sync log shown below. The portal /portal/training
// page reads only enabled+categorised playlists.
import { useEffect, useState } from "react";
import {
  Youtube, RefreshCw, Loader2, AlertCircle, CheckCircle2, Clock,
  GraduationCap, Users, EyeOff, ExternalLink, ShieldCheck, ShieldOff, KeyRound,
} from "lucide-react";
import api from "@/lib/api";
import { bustThumb } from "@/lib/youtubeThumb";

const CATEGORY_LABELS = { training: "Training Videos", meetings: "Franchisee Meetings" };

function fmtDate(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch { return "—"; }
}

function StatusPill({ status }) {
  const map = {
    success: { cls: "bg-emerald-100 text-emerald-800 border-emerald-300", icon: CheckCircle2, label: "Success" },
    partial: { cls: "bg-amber-100 text-amber-900 border-amber-300", icon: AlertCircle, label: "Partial" },
    failed:  { cls: "bg-red-100 text-red-700 border-red-300", icon: AlertCircle, label: "Failed" },
    running: { cls: "bg-blue-100 text-blue-700 border-blue-300", icon: Clock, label: "Running…" },
  };
  const v = map[status] || map.failed;
  const I = v.icon;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded border ${v.cls}`}>
      <I className="w-3 h-3" /> {v.label}
    </span>
  );
}

export default function AdminYouTubePage() {
  const [items, setItems] = useState([]);
  const [logs, setLogs] = useState([]);
  const [oauth, setOauth] = useState(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [authorising, setAuthorising] = useState(false);
  const [error, setError] = useState("");
  const [flash, setFlash] = useState("");

  const load = async () => {
    try {
      const [pls, syncLog, oauthRes] = await Promise.all([
        api.get("/admin/youtube/playlists"),
        api.get("/admin/youtube/sync-log?limit=10"),
        api.get("/admin/youtube/oauth/status"),
      ]);
      setItems(pls.data.items || []);
      setLogs(syncLog.data.items || []);
      setOauth(oauthRes.data || null);
    } catch (e) {
      setError(e?.response?.data?.detail || "Couldn't load playlists.");
    } finally { setLoading(false); }
  };
  useEffect(() => {
    load();
    // Surface OAuth callback result if Google bounced us back here.
    const url = new URL(window.location.href);
    if (url.searchParams.get("yt_connected") === "1") {
      setFlash("YouTube channel connected. Run a sync to pull Unlisted + Private playlists.");
      url.searchParams.delete("yt_connected");
      window.history.replaceState({}, "", url.pathname + (url.search || ""));
    } else if (url.searchParams.get("yt_error")) {
      setError(`YouTube authorisation failed: ${url.searchParams.get("yt_error")}`);
      url.searchParams.delete("yt_error");
      window.history.replaceState({}, "", url.pathname + (url.search || ""));
    }
  }, []);

  const sync = async () => {
    setSyncing(true); setError("");
    try {
      await api.post("/admin/youtube/sync");
      await load();
    } catch (e) {
      setError(e?.response?.data?.detail || "Sync failed.");
    } finally { setSyncing(false); }
  };

  const authorise = async () => {
    setAuthorising(true); setError("");
    try {
      // Pass our origin so the backend mints a redirect_uri that EXACTLY
      // matches the host the user is on (preview vs production). Both are
      // registered in Google Cloud Console.
      const r = await api.get("/admin/youtube/oauth/auth-url", {
        params: { origin: window.location.origin },
      });
      // Full-page redirect — Google's flow requires it.
      window.location.href = r.data.url;
    } catch (e) {
      setError(e?.response?.data?.detail || "Couldn't start authorisation.");
      setAuthorising(false);
    }
  };

  const disconnect = async () => {
    if (!window.confirm("Disconnect the YouTube channel? Future syncs will only see Public playlists until you re-authorise.")) return;
    setError("");
    try {
      await api.post("/admin/youtube/oauth/disconnect");
      await load();
    } catch (e) {
      setError(e?.response?.data?.detail || "Disconnect failed.");
    }
  };

  const patch = async (id, body) => {
    // Optimistic update — keeps the table responsive while the PATCH flies.
    setItems((prev) => prev.map((p) => p.id === id ? { ...p, ...body } : p));
    try {
      await api.patch(`/admin/youtube/playlists/${id}`, body);
    } catch (e) {
      setError(e?.response?.data?.detail || "Save failed.");
      await load();
    }
  };

  const lastSync = logs[0];

  return (
    <div className="space-y-5" data-testid="admin-youtube-page">
      {/* Hero */}
      <div className="bg-stone-950 text-white rounded-2xl px-5 sm:px-8 py-5 sm:py-7 flex items-center justify-between gap-4">
        <div className="flex items-center gap-4 min-w-0">
          <Youtube className="w-7 h-7 sm:w-8 sm:h-8 text-[#dedd0a] shrink-0" strokeWidth={2.2} />
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-400">Admin</div>
            <h1 className="font-display text-2xl sm:text-3xl font-black tracking-tight">YouTube Playlists</h1>
            <div className="text-xs sm:text-sm text-stone-400 mt-1">
              Last sync: {lastSync ? <>{fmtDate(lastSync.started_at)} · <StatusPill status={lastSync.status} /></> : "never"}
            </div>
          </div>
        </div>
        <button
          onClick={sync}
          disabled={syncing}
          data-testid="yt-sync-btn"
          className="px-4 py-2.5 text-xs font-bold uppercase tracking-wider bg-[#dedd0a] text-stone-950 hover:brightness-95 rounded-lg flex items-center gap-2 shrink-0 disabled:opacity-50 disabled:cursor-wait"
        >
          {syncing ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
          {syncing ? "Syncing…" : "Sync from YouTube"}
        </button>
      </div>

      {error && (
        <div className="px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-900 flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" /> {error}
        </div>
      )}

      {flash && (
        <div className="px-4 py-3 bg-emerald-50 border border-emerald-200 rounded-lg text-sm text-emerald-900 flex items-center gap-2" data-testid="yt-oauth-flash">
          <CheckCircle2 className="w-4 h-4 shrink-0" /> {flash}
        </div>
      )}

      {/* OAuth connection panel — enables sync of Unlisted + Private playlists */}
      <div className="bg-white border border-stone-200 rounded-2xl p-5 flex flex-col sm:flex-row sm:items-center gap-4" data-testid="yt-oauth-panel">
        <div className="shrink-0">
          {oauth?.connected ? (
            <div className="w-12 h-12 rounded-xl bg-emerald-100 text-emerald-700 flex items-center justify-center">
              <ShieldCheck className="w-6 h-6" />
            </div>
          ) : (
            <div className="w-12 h-12 rounded-xl bg-stone-100 text-stone-500 flex items-center justify-center">
              <ShieldOff className="w-6 h-6" />
            </div>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-display text-base font-black text-stone-950">
            Channel authorisation
            {oauth?.connected ? (
              <span className="ml-2 inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded border bg-emerald-100 text-emerald-800 border-emerald-300">
                <CheckCircle2 className="w-3 h-3" /> Connected
              </span>
            ) : (
              <span className="ml-2 inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded border bg-stone-100 text-stone-700 border-stone-300">
                <KeyRound className="w-3 h-3" /> API-key only
              </span>
            )}
          </div>
          {oauth?.connected ? (
            <div className="text-xs text-stone-600 mt-1">
              Authorised by <strong>{oauth.connected_email || "—"}</strong>
              {oauth.connected_channel ? <> · channel <strong>{oauth.connected_channel}</strong></> : null}
              {oauth.connected_at ? <> · {fmtDate(oauth.connected_at)}</> : null}
              <div className="text-stone-500 mt-0.5">Syncs now include Public, Unlisted, <em>and</em> Private playlists owned by this channel.</div>
            </div>
          ) : (
            <div className="text-xs text-stone-600 mt-1">
              Only Public playlists are visible right now. Authorise the channel owner&rsquo;s Google account to also pull in Unlisted and Private playlists.
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {oauth?.connected ? (
            <>
              <button
                onClick={authorise}
                data-testid="yt-reauthorise-btn"
                className="px-3 py-2 text-xs font-bold uppercase tracking-wider bg-stone-100 hover:bg-stone-200 text-stone-800 rounded-lg flex items-center gap-2"
              >
                <RefreshCw className="w-4 h-4" /> Re-authorise
              </button>
              <button
                onClick={disconnect}
                data-testid="yt-disconnect-btn"
                className="px-3 py-2 text-xs font-bold uppercase tracking-wider bg-red-50 hover:bg-red-100 text-red-700 rounded-lg flex items-center gap-2"
              >
                <ShieldOff className="w-4 h-4" /> Disconnect
              </button>
            </>
          ) : (
            <button
              onClick={authorise}
              disabled={authorising || !oauth?.configured}
              data-testid="yt-authorise-btn"
              className="px-4 py-2.5 text-xs font-bold uppercase tracking-wider bg-stone-950 hover:bg-stone-800 text-white rounded-lg flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {authorising ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
              {authorising ? "Redirecting…" : "Authorise YouTube channel"}
            </button>
          )}
        </div>
      </div>

      {/* Playlists table */}
      <div className="bg-white border border-stone-200 rounded-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-stone-200">
          <h2 className="font-display text-lg font-black text-stone-950">Playlists ({items.length})</h2>
          <p className="text-xs text-stone-500 mt-1">Set the sort order (lower number first), assign a category, then toggle enabled to show on the franchisee portal.</p>
        </div>
        {loading ? (
          <div className="p-10 text-center text-stone-500"><Loader2 className="w-5 h-5 animate-spin inline" /></div>
        ) : items.length === 0 ? (
          <div className="p-10 text-center text-stone-500 text-sm">
            No playlists yet. Click <strong>Sync from YouTube</strong> above to pull from your channel.
          </div>
        ) : (
          <div className="divide-y divide-stone-100">
            {items.map((p) => (
              <div key={p.id} className="px-5 py-4 flex items-center gap-4" data-testid={`yt-row-${p.id}`}>
                <img src={bustThumb(p.thumbnail_url, p.last_synced_at)} alt={p.title} className="w-28 h-16 rounded object-cover bg-stone-100 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 min-w-0">
                    <div className="font-display text-base font-bold text-stone-950 truncate">{p.title}</div>
                    <a href={`https://www.youtube.com/playlist?list=${p.youtube_id}`} target="_blank" rel="noopener noreferrer"
                      className="text-stone-400 hover:text-stone-700 shrink-0" title="Open on YouTube">
                      <ExternalLink className="w-3.5 h-3.5" />
                    </a>
                  </div>
                  <div className="text-xs text-stone-500 truncate">{p.video_count} videos · synced {fmtDate(p.last_synced_at)}</div>
                  {p.description && <div className="text-[11px] text-stone-500 mt-0.5 line-clamp-2">{p.description}</div>}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <input
                    type="number"
                    defaultValue={p.sort_order ?? 0}
                    onBlur={(e) => {
                      const n = parseInt(e.target.value, 10) || 0;
                      if (n !== (p.sort_order ?? 0)) patch(p.id, { sort_order: n });
                    }}
                    onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
                    data-testid={`yt-order-${p.id}`}
                    title="Sort order — lower numbers appear first"
                    className="w-14 px-2 py-1.5 text-xs bg-stone-50 border border-stone-300 rounded font-mono text-center"
                  />
                  <select
                    value={p.category || ""}
                    onChange={(e) => patch(p.id, { category: e.target.value || null })}
                    data-testid={`yt-cat-${p.id}`}
                    className="px-2.5 py-1.5 text-xs bg-stone-50 border border-stone-300 rounded font-medium"
                  >
                    <option value="">— Uncategorised —</option>
                    <option value="training">Training Videos</option>
                    <option value="meetings">Franchisee Meetings</option>
                  </select>
                  <button
                    onClick={() => patch(p.id, { enabled: !p.enabled })}
                    data-testid={`yt-enable-${p.id}`}
                    className={`px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest rounded-md transition-colors ${
                      p.enabled
                        ? "bg-emerald-600 hover:bg-emerald-700 text-white"
                        : "bg-stone-300 hover:bg-stone-400 text-stone-800"
                    }`}
                  >
                    {p.enabled ? "Enabled" : "Disabled"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Sync log */}
      <div className="bg-white border border-stone-200 rounded-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-stone-200">
          <h2 className="font-display text-lg font-black text-stone-950">Recent sync activity</h2>
        </div>
        {logs.length === 0 ? (
          <div className="p-6 text-center text-stone-500 text-sm">No sync runs yet.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-stone-50 text-[10px] uppercase tracking-wider font-bold text-stone-600">
              <tr><th className="text-left px-4 py-2.5">When</th>
                  <th className="text-left px-4 py-2.5">Status</th>
                  <th className="text-left px-4 py-2.5">Trigger</th>
                  <th className="text-right px-4 py-2.5">Scanned</th>
                  <th className="text-right px-4 py-2.5">Added</th>
                  <th className="text-right px-4 py-2.5">Updated</th>
                  <th className="text-right px-4 py-2.5">Videos</th>
                  <th className="text-left px-4 py-2.5">Error</th></tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {logs.map((l) => (
                <tr key={l.id}>
                  <td className="px-4 py-2 text-stone-700">{fmtDate(l.started_at)}</td>
                  <td className="px-4 py-2"><StatusPill status={l.status} /></td>
                  <td className="px-4 py-2 text-stone-600 font-mono text-xs">{l.triggered_by}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{l.playlists_scanned}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{l.playlists_added}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{l.playlists_updated}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{l.videos_synced}</td>
                  <td className="px-4 py-2 text-rose-700 text-xs max-w-md truncate">{l.error || ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
