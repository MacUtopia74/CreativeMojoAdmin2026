// Renders a real thumbnail for image + PDF files. Falls back to a
// type-specific Lucide icon for everything else.
//
// Implementation notes:
// - Images: just an <img> with `loading="lazy"` so off-screen tiles
//   don't fetch. Object-cover for tidy square crops.
// - PDFs: client-side PDF.js render of page 1 to an off-screen canvas,
//   then displayed via toDataURL. PDF.js's worker is loaded via
//   `?url` import (Webpack 5 / CRA 5 will produce a static asset URL).
//   At our volume (admin uploads 5-10 files/week, recents shows ≤9
//   tiles at once) this is plenty fast.
import { useEffect, useRef, useState } from "react";
import {
  File as FileIcon, FileText, FileAudio, FileVideo, FileArchive,
  Image as ImageIcon, Loader2,
} from "lucide-react";
import * as pdfjsLib from "pdfjs-dist";

// PDF.js needs a Web Worker. We point it at the unpkg CDN copy that
// matches the package.json version — avoids Webpack/CRA worker-chunk
// gymnastics and is cached aggressively by the browser after first hit.
pdfjsLib.GlobalWorkerOptions.workerSrc =
  `https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;

function fallbackIcon(file) {
  const ct = (file.content_type || "").toLowerCase();
  const ext = (file.name?.split(".").pop() || "").toLowerCase();
  if (ct.startsWith("image/") || ["jpg","jpeg","png","gif","webp","svg","heic"].includes(ext)) return ImageIcon;
  if (ct === "application/pdf" || ext === "pdf") return FileText;
  if (ct.startsWith("audio/") || ["mp3","wav","m4a","aac","ogg","flac"].includes(ext)) return FileAudio;
  if (ct.startsWith("video/") || ["mp4","mov","webm","mkv","avi"].includes(ext)) return FileVideo;
  if (["zip","rar","7z","tar","gz"].includes(ext)) return FileArchive;
  return FileIcon;
}

function fallbackTint(file) {
  const ct = (file.content_type || "").toLowerCase();
  const ext = (file.name?.split(".").pop() || "").toLowerCase();
  if (ct.startsWith("image/") || ["jpg","jpeg","png","gif","webp","svg","heic"].includes(ext)) return "bg-rose-50 text-rose-700";
  if (ct === "application/pdf" || ext === "pdf") return "bg-red-50 text-red-700";
  if (ct.startsWith("audio/") || ["mp3","wav","m4a","aac","ogg","flac"].includes(ext)) return "bg-purple-50 text-purple-700";
  if (ct.startsWith("video/") || ["mp4","mov","webm","mkv","avi"].includes(ext)) return "bg-indigo-50 text-indigo-700";
  return "bg-stone-50 text-stone-600";
}

// Module-level cache so re-renders / scroll-back doesn't re-render
// the same PDF. Keyed by R2 key (stable, regardless of presigned URL).
const PDF_THUMB_CACHE = new Map();

async function renderPdfThumb(url, key, targetWidth = 240) {
  if (PDF_THUMB_CACHE.has(key)) return PDF_THUMB_CACHE.get(key);
  const loadingTask = pdfjsLib.getDocument({ url });
  const pdf = await loadingTask.promise;
  const page = await pdf.getPage(1);
  const viewport = page.getViewport({ scale: 1 });
  const scale = targetWidth / viewport.width;
  const scaled = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = scaled.width;
  canvas.height = scaled.height;
  const ctx = canvas.getContext("2d");
  await page.render({ canvasContext: ctx, viewport: scaled }).promise;
  const dataUrl = canvas.toDataURL("image/jpeg", 0.7);
  PDF_THUMB_CACHE.set(key, dataUrl);
  return dataUrl;
}

export default function FileThumbnail({ file, className = "" }) {
  const kind = file?.preview_kind;
  const previewUrl = file?.preview_url;
  const Icon = fallbackIcon(file || {});
  const tint = fallbackTint(file || {});
  const [pdfDataUrl, setPdfDataUrl] = useState(() => (kind === "pdf" && file?.key && PDF_THUMB_CACHE.get(file.key)) || null);
  const [pdfLoading, setPdfLoading] = useState(false);
  const [imgLoaded, setImgLoaded] = useState(false);
  const [imgFailed, setImgFailed] = useState(false);
  const triedKey = useRef(null);

  useEffect(() => {
    if (kind !== "pdf" || !file?.key) return;
    if (pdfDataUrl) return;
    if (triedKey.current === file.key) return;
    triedKey.current = file.key;
    // Prefer the same-origin proxy URL (works around R2 CORS); fall
    // back to the signed R2 URL if the backend didn't supply one.
    const url = file.pdf_proxy_url || previewUrl;
    if (!url) return;
    setPdfLoading(true);
    renderPdfThumb(url, file.key)
      .then((u) => setPdfDataUrl(u))
      .catch(() => { /* fall through to icon */ })
      .finally(() => setPdfLoading(false));
  }, [kind, previewUrl, file?.key, file?.pdf_proxy_url, pdfDataUrl]);

  // --- Image ---
  if (kind === "image" && previewUrl && !imgFailed) {
    return (
      <div className={`relative bg-stone-100 ${className}`}>
        {!imgLoaded && (
          <div className="absolute inset-0 flex items-center justify-center">
            <Loader2 className="w-5 h-5 animate-spin text-stone-400" />
          </div>
        )}
        <img src={previewUrl} alt={file.name} loading="lazy"
          onLoad={() => setImgLoaded(true)}
          onError={() => setImgFailed(true)}
          className={`w-full h-full object-cover transition-opacity ${imgLoaded ? "opacity-100" : "opacity-0"}`} />
      </div>
    );
  }

  // --- PDF ---
  if (kind === "pdf" && pdfDataUrl) {
    return (
      <div className={`bg-white ${className}`}>
        <img src={pdfDataUrl} alt={file.name}
          className="w-full h-full object-cover object-top" />
      </div>
    );
  }
  if (kind === "pdf" && pdfLoading) {
    return (
      <div className={`flex items-center justify-center ${tint} ${className}`}>
        <Loader2 className="w-5 h-5 animate-spin opacity-60" />
      </div>
    );
  }

  // --- Fallback icon (audio/video/zip/unknown OR no preview_url) ---
  return (
    <div className={`flex items-center justify-center ${tint} ${className}`}>
      <Icon className="w-10 h-10 opacity-80" />
    </div>
  );
}
