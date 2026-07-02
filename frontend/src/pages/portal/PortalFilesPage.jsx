// Portal — "File Vault" page (shared brand files only). The "own"
// files folder is shown on the My Franchise page instead — this page
// mirrors the admin Files tab so franchisees see brand assets / training
// material.
import { useState } from "react";
import { useOutletContext } from "react-router-dom";
import { FolderOpen } from "lucide-react";
import api from "@/lib/api";
import FranchiseeFilesPanel from "@/components/files/FranchiseeFilesPanel";
import RecentFilesStrip from "@/components/files/RecentFilesStrip";
import FilePreviewModal from "@/components/files/FilePreviewModal";
import PortalPageHeading from "@/components/portal/PortalPageHeading";

export default function PortalFilesPage() {
  const { profile: data } = useOutletContext();
  const profile = data?.profile;
  const [previewFile, setPreviewFile] = useState(null);
  // Signal passed to FranchiseeFilesPanel to jump to a folder when the
  // "Recently added" strip is clicked. Uses an object so re-clicking
  // the same folder still triggers the effect (stable-value bugbear).
  const [openFolderSignal, setOpenFolderSignal] = useState(null);
  if (!profile) return null;

  const downloadRecent = async (key) => {
    try {
      const { data: dl } = await api.get("/files/download", { params: { key, attachment: true } });
      window.location.href = dl.url;
    } catch (e) { console.debug("[PortalFilesPage] download failed", e); }
  };

  return (
    <div className="space-y-5" data-testid="portal-files-page">
      <PortalPageHeading
        eyebrow="Shared brand library"
        icon={FolderOpen}
        title="File Vault"
        subtitle="Brand assets, training material, and project files curated by HQ."
      />
      <RecentFilesStrip
        onOpenFile={(f) => setPreviewFile(f)}
        onDownload={downloadRecent}
        onOpenFolder={(key) => {
          // Bump signal into the file browser panel below. Suffix with
          // a nonce so the useEffect fires even when the same folder is
          // clicked twice in a row.
          setOpenFolderSignal({ key, nonce: Date.now() });
          // Scroll the panel into view so the user sees the change
          // (the strip is above the panel on tall screens).
          setTimeout(() => {
            document.querySelector('[data-testid="franchisee-files-panel"]')
              ?.scrollIntoView({ behavior: "smooth", block: "start" });
          }, 50);
        }}
      />
      <FranchiseeFilesPanel
        franchisee={profile}
        lockedTab="brand"
        openPrefixSignal={openFolderSignal?.key}
      />
      {previewFile && <FilePreviewModal file={previewFile} onClose={() => setPreviewFile(null)} />}
    </div>
  );
}
