// Share a whole folder. Generates a public token; the recipient lands
// on /share/folder/:token which lists every file with individual
// download buttons + a "Download All as ZIP" option.
import { useState, useEffect, useCallback } from "react";
import api from "@/lib/api";
import { Share2, X, Loader2, Copy, CheckCircle2 } from "lucide-react";
import { prettyFolderName } from "@/utils/folderName";

export default function FolderShareModal({ folder, onClose }) {
  const [days, setDays] = useState(0);  // 0 = lifetime
  const [url, setUrl] = useState(null);
  const [expiresAt, setExpiresAt] = useState(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState("");

  const generate = useCallback(async (d) => {
    setBusy(true); setErr(""); setUrl(null); setCopied(false);
    try {
      const { data } = await api.post("/files/folder-share", { prefix: folder.key, days: d });
      setUrl(data.url);
      setExpiresAt(data.expires_at);
    } catch (e) { setErr(e?.response?.data?.detail || "Could not generate link."); }
    finally { setBusy(false); }
  }, [folder]);

  useEffect(() => { if (folder) generate(days); /* eslint-disable-next-line */ }, [folder]);

  if (!folder) return null;
  const copy = async () => {
    try { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 2000); }
    catch (e) { /* ignore */ }
  };

  return (
    <div onClick={onClose} className="fixed inset-0 z-[60] bg-stone-950/60 backdrop-blur-sm flex items-center justify-center p-6" data-testid="folder-share-modal">
      <div onClick={(e) => e.stopPropagation()} className="bg-white rounded-2xl shadow-2xl max-w-xl w-full overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3 border-b border-stone-200">
          <div className="flex items-center gap-2">
            <Share2 className="w-4 h-4 text-stone-700" />
            <span className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-700">Share Folder</span>
          </div>
          <button onClick={onClose} data-testid="folder-share-close" className="w-9 h-9 flex items-center justify-center hover:bg-stone-100 rounded-lg"><X className="w-4 h-4" /></button>
        </div>
        <div className="px-5 py-4 space-y-3">
          <div>
            <div className="text-sm font-semibold text-stone-950 truncate">{prettyFolderName(folder.name)}</div>
            <div className="text-[11px] text-stone-500 truncate font-mono">{folder.key}</div>
            <div className="text-[11px] text-stone-500 mt-0.5">{folder.files} files · {fmtBytes(folder.bytes)}</div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">Expires in</span>
            {[1, 7, 30].map((d) => (
              <button key={d} onClick={() => { setDays(d); generate(d); }} data-testid={`folder-share-days-${d}`}
                className={`px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider rounded-md border ${days === d ? "bg-stone-950 text-white border-stone-950" : "bg-white text-stone-700 border-stone-300 hover:bg-stone-50"}`}>
                {d} {d === 1 ? "day" : "days"}
              </button>
            ))}
            <button onClick={() => { setDays(0); generate(0); }} data-testid="folder-share-days-lifetime"
              className={`px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider rounded-md border ${days === 0 ? "bg-stone-950 text-white border-stone-950" : "bg-white text-stone-700 border-stone-300 hover:bg-stone-50"}`}>
              Lifetime
            </button>
          </div>
          {busy && <div className="text-sm text-stone-500 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Generating…</div>}
          {err && <div className="text-xs text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{err}</div>}
          {url && !busy && (
            <div className="space-y-2">
              <div className="flex items-stretch gap-2">
                <input readOnly value={url} data-testid="folder-share-url"
                  className="flex-1 px-3 py-2 text-xs bg-stone-50 border border-stone-300 rounded-lg font-mono text-stone-700" />
                <button onClick={copy} data-testid="folder-share-copy"
                  className="px-3 py-2 text-xs font-bold uppercase tracking-wider bg-[#D4FF00] hover:bg-[#BDE600] text-stone-950 rounded-lg flex items-center gap-1.5">
                  {copied ? <><CheckCircle2 className="w-3.5 h-3.5" /> Copied</> : <><Copy className="w-3.5 h-3.5" /> Copy</>}
                </button>
              </div>
              <div className="text-[11px] text-stone-500">
                Recipients see a clean page listing every file with individual download buttons AND a “Download All as ZIP” option.
                {expiresAt
                  ? ` Auto-expires ${new Date(expiresAt).toLocaleString()}.`
                  : " This link never expires — share with franchisees for permanent access."}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function fmtBytes(b) {
  if (b == null) return "—";
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
}
