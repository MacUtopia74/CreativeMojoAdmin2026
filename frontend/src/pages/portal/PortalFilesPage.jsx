// Portal — Files page (shared brand files only). The "own" files
// folder is shown on the Details page instead — this page mirrors the
// admin Files tab so franchisees see brand assets / training material.
import { useState } from "react";
import { useOutletContext } from "react-router-dom";
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
