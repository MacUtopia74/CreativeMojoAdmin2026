// Preview modal shared between the admin Files page and the franchisee
// portal. Handles images, PDFs, audio, video inline; everything else
// falls back to a Download button. Header carries a permanent Download
// button so any file can be saved with one click.
import { useEffect, useState } from "react";
import api, { API_BASE } from "@/lib/api";
import {
  Download, X, ExternalLink, Loader2, AlertCircle, File as FileIcon,
} from "lucide-react";
import PdfJsViewer from "@/components/files/PdfJsViewer";

export default function FilePreviewModal({ file, onClose }) {
  const [url, setUrl] = useState(null);
  const [dlUrl, setDlUrl] = useState(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (!file) return;
    setUrl(null); setDlUrl(null); setErr("");
    (async () => {
      try {
        const ct = (file.content_type || "").toLowerCase();
        const ext = (file.name?.split(".").pop() || "").toLowerCase();
        const isPdf = ct === "application/pdf" || ext === "pdf";
        // PDFs: stream through same-origin proxy so the browser
        // renders them inline (avoids Safari/R2 cross-site refusal).
        if (isPdf) {
          setUrl(`${API_BASE}/files/proxy?key=${encodeURIComponent(file.key)}`);
          const { data: dl } = await api.get("/files/download", { params: { key: file.key, attachment: true } });
          setDlUrl(dl.url);
          return;
        }
        const previewReq = api.get("/files/download", { params: { key: file.key, attachment: false } });
        const dlReq = api.get("/files/download", { params: { key: file.key, attachment: true } });
        const [{ data: pv }, { data: dl }] = await Promise.all([previewReq, dlReq]);
        setUrl(pv.url);
        setDlUrl(dl.url);
      } catch (e) { setErr(e?.response?.data?.detail || "Could not load preview."); }
    })();
  }, [file]);

  if (!file) return null;
  const ct = (file.content_type || "").toLowerCase();
  const ext = (file.name?.split(".").pop() || "").toLowerCase();
  const isImg = ct.startsWith("image/") || ["jpg","jpeg","png","gif","webp","svg","heic"].includes(ext);
  const isPdf = ct === "application/pdf" || ext === "pdf";
  const isAudio = ct.startsWith("audio/") || ["mp3","wav","m4a","aac","ogg","flac","aif","aiff"].includes(ext);
  const isVideo = ct.startsWith("video/") || ["mp4","mov","webm","mkv","avi","wmv"].includes(ext);

  return (
    <div onClick={onClose} className="fixed inset-0 z-[60] bg-stone-950/80 backdrop-blur-sm flex items-center justify-center p-6" data-testid="preview-modal">
      <div onClick={(e) => e.stopPropagation()} className="bg-white rounded-2xl shadow-2xl max-w-5xl w-full max-h-[90vh] overflow-hidden flex flex-col">
        <div className="flex items-center justify-between px-5 py-3 border-b border-stone-200">
          <div className="truncate min-w-0">
            <div className="text-sm font-bold text-stone-950 truncate">{file.name}</div>
            <div className="text-[11px] text-stone-500 truncate font-mono">{file.key}</div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {dlUrl && (
              <a href={dlUrl} target="_blank" rel="noreferrer" data-testid="preview-download"
                className="inline-flex items-center gap-1.5 px-3 py-2 text-[10px] font-bold uppercase tracking-wider bg-[#D4FF00] text-stone-950 hover:bg-[#BDE600] rounded-lg">
                <Download className="w-3.5 h-3.5" /> Download
              </a>
            )}
            {url && (
              <a href={url} target="_blank" rel="noreferrer" title="Open in new tab"
                className="inline-flex items-center gap-1.5 px-3 py-2 text-[10px] font-bold uppercase tracking-wider border border-stone-300 bg-white text-stone-900 hover:bg-stone-50 rounded-lg" data-testid="preview-open-tab">
                <ExternalLink className="w-3.5 h-3.5" /> Full page preview
              </a>
            )}
            <button onClick={onClose} data-testid="preview-close" className="w-9 h-9 flex items-center justify-center hover:bg-stone-100 rounded-lg"><X className="w-4 h-4" /></button>
          </div>
        </div>
        <div className="flex-1 overflow-auto bg-stone-50 flex items-center justify-center p-4">
          {!url && !err && <Loader2 className="w-6 h-6 animate-spin text-stone-400" />}
          {err && <div className="text-sm text-red-700 flex items-center gap-2"><AlertCircle className="w-4 h-4" /> {err}</div>}
          {url && isImg && <img src={url} alt={file.name} className="max-w-full max-h-[70vh] object-contain rounded" />}
          {url && isPdf && <PdfJsViewer url={url} />}
          {url && isAudio && <audio src={url} controls className="w-full max-w-2xl" />}
          {url && isVideo && <video src={url} controls className="max-w-full max-h-[70vh] rounded" />}
          {url && !isImg && !isPdf && !isAudio && !isVideo && (
            <div className="text-center">
              <FileIcon className="w-12 h-12 text-stone-300 mx-auto mb-3" />
              <div className="text-sm text-stone-600 mb-3">Preview not supported for this file type.</div>
              <a href={dlUrl || url} target="_blank" rel="noreferrer"
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-bold uppercase tracking-wider bg-stone-950 text-white hover:bg-stone-800 rounded-lg">
                <Download className="w-3.5 h-3.5" /> Download
              </a>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
