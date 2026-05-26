// Renders a real thumbnail for image + PDF files via the backend's
// server-side rendering cache.
//
// Endpoint: GET /api/files/thumbnail?key=...&size=md
//
// IMPORTANT: We MUST fetch the bytes via axios (so the
// ``Authorization: Bearer`` token is attached) and convert them to a
// blob URL. A plain ``<img src={...}>`` can't carry an Authorization
// header — and on production the frontend and backend live on
// different sites, so the browser's cross-site cookie block makes
// cookie-based auth unreliable too. This was why every image/PDF
// thumbnail in Sandra's portal silently fell back to the generic icon.
import { useEffect, useRef, useState } from "react";
import {
  File as FileIcon, FileText, FileAudio, FileVideo, FileArchive,
  Image as ImageIcon, Loader2,
} from "lucide-react";
import api from "@/lib/api";

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
  const [src, setSrc] = useState(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const currentUrl = useRef(null);

  useEffect(() => {
    let cancelled = false;
    if (!file?.key || !isThumbable(file)) {
      setLoading(false);
      return undefined;
    }
    setLoading(true);
    setFailed(false);
    (async () => {
      try {
        const res = await api.get("/files/thumbnail", {
          params: { key: file.key, size },
          responseType: "blob",
        });
        if (cancelled) {
          // Release the blob immediately if the component already unmounted.
          try { URL.revokeObjectURL(URL.createObjectURL(res.data)); } catch { /* noop */ }
          return;
        }
        const url = URL.createObjectURL(res.data);
        // Revoke the previous blob URL if any.
        if (currentUrl.current) URL.revokeObjectURL(currentUrl.current);
        currentUrl.current = url;
        setSrc(url);
      } catch (e) {
        if (!cancelled) setFailed(true);
        console.debug("[FileThumbnail] preview unavailable", e?.response?.status);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      if (currentUrl.current) {
        URL.revokeObjectURL(currentUrl.current);
        currentUrl.current = null;
      }
    };
  }, [file?.key, size, file]);

  if (!file?.key || !isThumbable(file) || failed) {
    return (
      <div className={`flex items-center justify-center ${tint} ${className}`}>
        <Icon className="w-10 h-10 opacity-80" />
      </div>
    );
  }

  return (
    <div className={`relative bg-stone-100 ${className}`}>
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center">
          <Loader2 className="w-5 h-5 animate-spin text-stone-400" />
        </div>
      )}
      {src && (
        <img
          src={src}
          alt={file.name}
          decoding="async"
          className="w-full h-full object-cover"
        />
      )}
    </div>
  );
}
