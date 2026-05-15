// Renders a real thumbnail for image + PDF files using the backend's
// server-side rendering cache. Falls back to a type-specific Lucide
// icon for everything else.
//
// Endpoint: GET /api/files/thumbnail?key=...&size=md
// First hit renders + caches in R2; every subsequent hit is served
// from the cache and is also cached aggressively by the browser
// (Cache-Control: public, max-age=86400, immutable).
import { useState } from "react";
import {
  File as FileIcon, FileText, FileAudio, FileVideo, FileArchive,
  Image as ImageIcon, Loader2,
} from "lucide-react";
import { API_BASE } from "@/lib/api";

function isThumbable(file) {
  const ct = (file.content_type || "").toLowerCase();
  const ext = (file.name?.split(".").pop() || "").toLowerCase();
  if (ct.startsWith("image/") || ["jpg","jpeg","png","gif","webp","heic"].includes(ext)) return true;
  if (ct === "application/pdf" || ext === "pdf") return true;
  return false;
}

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

export default function FileThumbnail({ file, className = "", size = "md" }) {
  const Icon = fallbackIcon(file || {});
  const tint = fallbackTint(file || {});
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  if (!file?.key || !isThumbable(file) || failed) {
    return (
      <div className={`flex items-center justify-center ${tint} ${className}`}>
        <Icon className="w-10 h-10 opacity-80" />
      </div>
    );
  }

  const url = `${API_BASE}/files/thumbnail?key=${encodeURIComponent(file.key)}&size=${size}`;
  return (
    <div className={`relative bg-stone-100 ${className}`}>
      {!loaded && (
        <div className="absolute inset-0 flex items-center justify-center">
          <Loader2 className="w-5 h-5 animate-spin text-stone-400" />
        </div>
      )}
      <img src={url} alt={file.name} loading="lazy" decoding="async"
        onLoad={() => setLoaded(true)}
        onError={() => setFailed(true)}
        className={`w-full h-full object-cover transition-opacity duration-200 ${loaded ? "opacity-100" : "opacity-0"}`} />
    </div>
  );
}
