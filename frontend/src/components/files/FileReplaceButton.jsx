// Replace-with-new-version button for the admin Files page. Lets the
// admin pick a new file from disk and overwrite the existing R2 object
// at the same key — useful when a PDF or asset has been updated but
// existing share links / embed references must keep working.
//
// Renders a compact ghost button (icon-only by default; pass `label` to
// show text). Handles its own file-picker, upload progress and error
// state; calls `onReplaced` once Mongo + R2 have been refreshed.
import { useRef, useState } from "react";
import { FileUp, Loader2 } from "lucide-react";
import api from "@/lib/api";

export default function FileReplaceButton({ file, onReplaced, label = false, className = "" }) {
  const inputRef = useRef(null);
  const [busy, setBusy] = useState(false);

  const pick = (e) => {
    e?.stopPropagation();
    inputRef.current?.click();
  };

  const onPicked = async (e) => {
    const picked = e.target.files?.[0];
    e.target.value = ""; // reset so re-picking the same file still fires onChange
    if (!picked) return;
    const proceed = window.confirm(
      `Replace "${file.name}" with the new version?\n\n` +
      "• The original filename and share link stay the same\n" +
      "• The previous version is overwritten — there's no undo"
    );
    if (!proceed) return;
    const form = new FormData();
    form.append("file", picked);
    form.append("key", file.key);
    setBusy(true);
    try {
      const { data } = await api.post("/files/replace", form, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      onReplaced?.(data?.file);
    } catch (err) {
      window.alert(err?.response?.data?.detail || "Replace failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        className="hidden"
        onChange={onPicked}
        data-testid={`file-replace-input-${file.key}`}
      />
      <button
        type="button"
        onClick={pick}
        disabled={busy}
        title={`Replace "${file.name}" with a new version (link unchanged)`}
        data-testid={`file-replace-${file.key}`}
        className={
          className ||
          "px-2 py-1 text-[10px] font-bold uppercase tracking-wider bg-white border border-stone-300 hover:bg-stone-50 text-stone-700 rounded-md flex items-center gap-1 disabled:opacity-50"
        }
      >
        {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <FileUp className="w-3 h-3" />}
        {label && <span>{busy ? "Replacing…" : "Replace"}</span>}
      </button>
    </>
  );
}
