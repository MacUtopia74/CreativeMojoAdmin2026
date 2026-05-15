// Public folder-share viewer. No auth. Token from URL → fetches the
// folder listing from /api/files/folder-share/:token → renders a clean
// branded page with individual download buttons + Download All as ZIP.
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { API_BASE } from "@/lib/api";
import axios from "axios";
import { Download, FileText, Image as ImageIcon, FileAudio, FileVideo, FileArchive, File as FileIcon, AlertCircle, Loader2, Package } from "lucide-react";

function fmtBytes(b) {
  if (b == null) return "—";
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
}

function pickIcon(name, ct) {
  const ext = (name?.split(".").pop() || "").toLowerCase();
  const t = (ct || "").toLowerCase();
  if (t.startsWith("image/") || ["jpg","jpeg","png","gif","webp","svg","heic"].includes(ext)) return ImageIcon;
  if (t === "application/pdf" || ext === "pdf") return FileText;
  if (t.startsWith("audio/") || ["mp3","wav","m4a","aac","ogg","flac"].includes(ext)) return FileAudio;
  if (t.startsWith("video/") || ["mp4","mov","webm","mkv","avi"].includes(ext)) return FileVideo;
  if (["zip","rar","7z","tar","gz"].includes(ext)) return FileArchive;
  return FileIcon;
}

export default function PublicFolderSharePage() {
  const { token } = useParams();
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const { data } = await axios.get(`${API_BASE}/files/folder-share/${token}`);
        setData(data);
      } catch (e) {
        setErr(e?.response?.data?.detail || "Link not found or expired.");
      } finally { setLoading(false); }
    })();
  }, [token]);

  const zipUrl = `${API_BASE}/files/folder-share/${token}/zip`;
  const exp = data?.expires_at ? new Date(data.expires_at) : null;

  return (
    <div className="min-h-screen bg-[#FBFAF8]" data-testid="public-folder-share">
      <div className="max-w-4xl mx-auto px-6 py-10">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 bg-[#D4FF00] rounded-lg flex items-center justify-center font-display text-stone-950 text-xl font-bold">M</div>
          <div>
            <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-500">Creative Mojo</div>
            <div className="font-display text-xl text-stone-950">Shared Folder</div>
          </div>
        </div>

        {loading && (
          <div className="flex items-center gap-2 text-sm text-stone-500"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>
        )}
        {err && (
          <div className="border border-red-200 bg-red-50 text-red-700 rounded-2xl px-5 py-4 flex items-center gap-2" data-testid="public-folder-error">
            <AlertCircle className="w-4 h-4" /> {err}
          </div>
        )}

        {data && (
          <>
            <div className="bg-white border border-stone-200 rounded-2xl p-5 mb-5 flex items-center justify-between gap-4 flex-wrap">
              <div className="min-w-0">
                <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-500">Folder</div>
                <h1 className="font-display text-2xl text-stone-950 truncate" data-testid="public-folder-label">{data.label}</h1>
                <div className="text-xs text-stone-500 mt-1 tabular-nums">
                  {data.file_count} files{exp ? ` · expires ${exp.toLocaleDateString()}` : ""}
                </div>
              </div>
              <a href={zipUrl} data-testid="public-folder-zip-btn"
                className="inline-flex items-center gap-2 px-4 py-2 text-xs font-bold uppercase tracking-wider bg-stone-950 text-white hover:bg-stone-800 rounded-lg">
                <Package className="w-3.5 h-3.5" /> Download all as ZIP
              </a>
            </div>

            <div className="bg-white border border-stone-200 rounded-2xl overflow-hidden">
              <div className="divide-y divide-stone-100">
                {data.files.map((f) => {
                  const Icon = pickIcon(f.name, f.content_type);
                  return (
                    <div key={f.rel_path} className="px-4 py-2.5 flex items-center justify-between gap-3 hover:bg-stone-50" data-testid={`public-file-${f.rel_path}`}>
                      <div className="flex items-center gap-3 min-w-0 flex-1">
                        <Icon className="w-4 h-4 text-stone-500 shrink-0" />
                        <div className="min-w-0">
                          <div className="text-sm text-stone-900 truncate">{f.name}</div>
                          {f.rel_path !== f.name && (
                            <div className="text-[11px] text-stone-500 truncate font-mono">{f.rel_path}</div>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-3 shrink-0">
                        <span className="text-xs text-stone-500 tabular-nums">{fmtBytes(f.size)}</span>
                        <a href={f.download_url} target="_blank" rel="noreferrer"
                          className="px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider bg-stone-950 text-white hover:bg-stone-800 rounded-md flex items-center gap-1">
                          <Download className="w-3 h-3" /> Download
                        </a>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="text-[11px] text-stone-400 text-center mt-6">
              Shared via Creative Mojo Admin · Anyone with this link can download these files.
            </div>
          </>
        )}
      </div>
    </div>
  );
}
