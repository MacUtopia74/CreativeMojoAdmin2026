// Portal — "File Vault" page (shared brand files only). The "own"
// files folder is shown on the My Franchise page instead — this page
// mirrors the admin Files tab so franchisees see brand assets / training
// material.
import { useState } from "react";
import { useOutletContext } from "react-router-dom";
import { Sparkles } from "lucide-react";
import api from "@/lib/api";
import FranchiseeFilesPanel from "@/components/files/FranchiseeFilesPanel";
import RecentFilesStrip from "@/components/files/RecentFilesStrip";
import FilePreviewModal from "@/components/files/FilePreviewModal";

export default function PortalFilesPage() {
  const { profile: data } = useOutletContext();
  const profile = data?.profile;
  const [previewFile, setPreviewFile] = useState(null);
  if (!profile) return null;

  const downloadRecent = async (key) => {
    try {
      const { data: dl } = await api.get("/files/download", { params: { key, attachment: true } });
      window.location.href = dl.url;
    } catch (e) { console.debug("[PortalFilesPage] download failed", e); }
  };

  return (
    <div className="space-y-5" data-testid="portal-files-page">
      {/* Yellow hero banner — matches the admin Files header so franchisee
          and admin feel like the same family of products. */}
      <div className="bg-[#dddd16] rounded-2xl px-5 sm:px-8 py-5 sm:py-7 flex items-center gap-4" data-testid="portal-files-hero">
        <Sparkles className="w-7 h-7 sm:w-8 sm:h-8 text-stone-950 shrink-0" strokeWidth={2.2} />
        <h1 className="font-display text-2xl sm:text-4xl font-black text-stone-950 tracking-tight">
          Files for all Franchisees
        </h1>
      </div>
      <RecentFilesStrip
        onOpenFile={(f) => setPreviewFile(f)}
        onDownload={downloadRecent}
        onOpenFolder={() => { /* the panel below is the browser */ }}
      />
      <FranchiseeFilesPanel franchisee={profile} lockedTab="brand" />
      {previewFile && <FilePreviewModal file={previewFile} onClose={() => setPreviewFile(null)} />}
    </div>
  );
}
