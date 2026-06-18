// Opens when a franchisee clicks "Open Project Guide" on the
// Calendar → "Projects this month" modal. Embeds the linked
// Instruction PDF inline and lists every other file that lives in
// the SAME R2 folder (stencils, cutting files, videos, photos —
// whatever's there) so they can be grabbed without leaving the modal.
import { useEffect, useMemo, useState } from "react";
import {
  X, Loader2, AlertCircle, FileText, FileDown,
} from "lucide-react";
import api from "@/lib/api";

function humanSize(b) {
  if (b == null) return "";
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

export default function ProjectGuideModal({ project, onClose }) {
  const { name, project_code, guide_url, guide_key } = project;
  const [pdfUrl, setPdfUrl] = useState(null);
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setErr("");
    (async () => {
      try {
        // (1) Get a signed URL for the embedded instruction PDF. We
        // explicitly pass attachment=false so the signed URL is minted
        // with ``Content-Disposition: inline`` instead of ``attachment``
        // — without this Safari (and most browsers) force-download the
        // PDF instead of rendering it inside the <iframe>.
        const pdfReq = guide_url
          ? api.get(guide_url, { params: { attachment: false } })
              .then((r) => r.data?.url || r.data?.signed_url || null)
          : Promise.resolve(null);
        // (2) Fetch every other file in the SAME folder as the guide.
        // Backend uses guide_key to derive the folder prefix — no
        // dependence on asset_type tagging.
        const filesReq = project_code
          ? api.get(`/portal/projects/${encodeURIComponent(project_code)}/files`, {
              params: guide_key ? { guide_key } : {},
            }).then((r) => r.data?.files || [])
          : Promise.resolve([]);
        const [pdf, filesData] = await Promise.all([pdfReq, filesReq]);
        if (cancelled) return;
        setPdfUrl(pdf);
        // Drop the guide itself from the sidebar — it's already embedded
        // up top.
        setFiles((filesData || []).filter((f) => f.key !== guide_key));
      } catch (e) {
        if (!cancelled) setErr(e?.response?.data?.detail || "Could not load this project.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [guide_url, guide_key, project_code]);

  // Folder name for the sidebar header. ``project-files/aaa/bbb/x.pdf``
  // → ``bbb`` — short, human, no path noise.
  const folderLabel = useMemo(() => {
    if (!guide_key) return "";
    const parts = guide_key.split("/");
    return parts.length >= 2 ? parts[parts.length - 2] : "";
  }, [guide_key]);

  const openFile = async (f) => {
    try {
      const { data } = await api.get(f.download_url);
      const url = data?.url || data?.signed_url;
      if (url) window.open(url, "_blank", "noopener,noreferrer");
    } catch (e) {
      setErr(e?.response?.data?.detail || "Couldn't open that file.");
    }
  };

  return (
    <div
      className="fixed inset-0 z-[70] bg-black/60 flex items-center justify-center p-0 sm:p-4"
      data-testid="project-guide-modal"
      onClick={(e) => { if (e.target === e.currentTarget) onClose?.(); }}
    >
      <div className="bg-white w-full max-w-6xl h-full sm:h-[92vh] sm:rounded-2xl shadow-2xl flex flex-col overflow-hidden">
        <div className="px-5 py-4 border-b border-stone-200 flex items-center justify-between gap-3 flex-shrink-0">
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-500">
              Project guide{project_code ? ` · ${project_code}` : ""}
            </div>
            <h2 className="font-display text-xl sm:text-2xl text-stone-950 mt-0.5 truncate">{name}</h2>
          </div>
          <button
            onClick={onClose}
            data-testid="project-guide-close"
            className="w-9 h-9 rounded-full border border-stone-300 bg-white hover:bg-stone-100 flex items-center justify-center flex-shrink-0"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {err && (
          <div className="mx-5 mt-4 px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-900 flex items-center gap-2" data-testid="project-guide-error">
            <AlertCircle className="w-4 h-4 shrink-0" /> {err}
          </div>
        )}

        <div className="flex-1 flex flex-col lg:flex-row min-h-0">
          {/* PDF embed */}
          <div className="flex-1 bg-stone-100 min-h-[40vh] lg:min-h-0 relative">
            {loading ? (
              <div className="absolute inset-0 flex items-center justify-center text-stone-500">
                <Loader2 className="w-6 h-6 animate-spin" />
              </div>
            ) : pdfUrl ? (
              <iframe
                src={pdfUrl}
                title={`${name} project guide`}
                className="w-full h-full border-0"
                data-testid="project-guide-pdf-frame"
              />
            ) : (
              <div className="absolute inset-0 flex flex-col items-center justify-center text-stone-500 gap-2 p-6 text-center">
                <FileText className="w-10 h-10 text-stone-300" />
                <div className="text-sm">No project guide is linked to this product yet.</div>
              </div>
            )}
          </div>

          {/* Sidebar — every file that lives in the same folder */}
          <aside className="w-full lg:w-80 xl:w-96 border-t lg:border-t-0 lg:border-l border-stone-200 bg-white overflow-y-auto flex-shrink-0">
            <div className="px-4 py-3 border-b border-stone-200 sticky top-0 bg-white">
              <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600">
                Folder contents
              </div>
              <div className="text-xs text-stone-500 mt-0.5 truncate" title={folderLabel}>
                {folderLabel
                  ? <>Other files in <span className="font-medium text-stone-700">{folderLabel}/</span></>
                  : "Other files alongside this guide."}
              </div>
            </div>
            <div className="p-4" data-testid="project-guide-related">
              {loading ? (
                <div className="py-6 text-center text-stone-400">
                  <Loader2 className="w-5 h-5 animate-spin inline" />
                </div>
              ) : files.length === 0 ? (
                <div className="py-6 text-center text-sm text-stone-400" data-testid="project-guide-no-related">
                  No other files in this folder yet.
                </div>
              ) : (
                <ul className="space-y-1.5">
                  {files.map((f) => (
                    <li key={f.key}>
                      <button
                        onClick={() => openFile(f)}
                        data-testid={`project-guide-file-${f.key}`}
                        className="w-full text-left px-3 py-2 rounded-lg border border-stone-200 bg-stone-50 hover:bg-stone-100 hover:border-stone-300 transition-colors flex items-center justify-between gap-2 group"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-medium text-stone-900 truncate">{f.name}</div>
                          {f.size != null && (
                            <div className="text-[11px] text-stone-500 mt-0.5">{humanSize(f.size)}</div>
                          )}
                        </div>
                        <FileDown className="w-4 h-4 text-stone-400 group-hover:text-stone-900 flex-shrink-0" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
