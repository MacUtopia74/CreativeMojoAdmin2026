// Admin — Yearly Events manager. Lets HQ upload a CSV of date,event
// pairs that get displayed on every franchisee portal calendar as
// solid light-blue all-day events with a "Yearly Events" legend entry.
//
// The CSV format is forgiving: header row is optional, dates can be
// DD/MM/YYYY, YYYY-MM-DD, or DD-MM-YYYY. Re-uploads dedupe on
// (date, title) so admins can safely re-run the same file twice.
import { useEffect, useRef, useState } from "react";
import api from "@/lib/api";
import {
  Upload, X, Loader2, AlertCircle, CheckCircle2, Trash2, Plus, FileSpreadsheet, Sparkles,
} from "lucide-react";

function fmtDateUK(iso) {
  try {
    const [y, m, d] = (iso || "").split("-");
    if (!y || !m || !d) return iso;
    return `${d}/${m}/${y}`;
  } catch { return iso; }
}

export default function YearlyEventsModal({ onClose }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [uploadInfo, setUploadInfo] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [replaceMode, setReplaceMode] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const fileInput = useRef(null);

  const load = async () => {
    setLoading(true);
    setErr("");
    try {
      const { data } = await api.get("/admin/calendar/yearly-events");
      setItems(data.items || []);
    } catch (e) {
      setErr(e?.response?.data?.detail || "Could not load yearly events");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const upload = async (file) => {
    if (!file) return;
    if (replaceMode && !window.confirm(
      "Replace mode: this will DELETE all existing yearly events before importing the new ones. Continue?",
    )) return;
    setUploading(true);
    setErr("");
    setUploadInfo(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const { data } = await api.post(
        `/admin/calendar/yearly-events/upload?replace=${replaceMode ? "true" : "false"}`,
        fd,
        { headers: { "Content-Type": "multipart/form-data" } },
      );
      setUploadInfo(data);
      await load();
    } catch (e) {
      const detail = e?.response?.data?.detail;
      if (detail && typeof detail === "object") {
        setErr(detail.message || "Upload failed");
        if (Array.isArray(detail.errors)) {
          setUploadInfo({ errors: detail.errors, inserted: 0, skipped_duplicates: 0, total_in_csv: 0 });
        }
      } else {
        setErr(detail || "Upload failed");
      }
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const deleteOne = async (id) => {
    if (!window.confirm("Delete this event from the yearly calendar?")) return;
    try {
      await api.delete(`/admin/calendar/yearly-events/${id}`);
      setItems((arr) => arr.filter((x) => x.id !== id));
    } catch (e) {
      alert(e?.response?.data?.detail || "Delete failed");
    }
  };

  const wipeAll = async () => {
    if (!window.confirm(`Delete ALL ${items.length} yearly event(s)? This can't be undone.`)) return;
    try {
      await api.delete("/admin/calendar/yearly-events");
      setItems([]);
    } catch (e) {
      alert(e?.response?.data?.detail || "Delete failed");
    }
  };

  return (
    <div
      className="fixed inset-0 z-[70] bg-stone-950/70 backdrop-blur-sm flex items-center justify-center p-6"
      onClick={onClose}
      data-testid="yearly-events-modal"
    >
      <div onClick={(e) => e.stopPropagation()} className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[90vh] flex flex-col">
        <div className="px-5 py-4 border-b border-stone-200 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-blue-600" />
            <span className="font-bold text-stone-950">Yearly events · Franchisee portal calendar</span>
          </div>
          <button onClick={onClose} className="w-8 h-8 hover:bg-stone-100 rounded-md flex items-center justify-center">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-4 border-b border-stone-200 bg-blue-50/50 space-y-3">
          <p className="text-xs text-stone-700 leading-relaxed">
            Upload a CSV with two columns: <strong>date</strong> (e.g. <code className="bg-white px-1 rounded">25/12/2026</code>) and <strong>event title</strong>.
            Header row optional. Each event will appear as a solid light-blue block on every franchisee's portal calendar.
          </p>
          <div className="flex items-center gap-3 flex-wrap">
            <input
              ref={fileInput}
              type="file"
              accept=".csv,.txt"
              onChange={(e) => upload(e.target.files?.[0])}
              data-testid="yearly-csv-input"
              className="hidden"
            />
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              disabled={uploading}
              data-testid="yearly-upload-btn"
              className="px-4 py-2 text-xs font-bold uppercase tracking-wider bg-blue-600 text-white hover:bg-blue-700 rounded-lg disabled:opacity-50 flex items-center gap-1.5"
            >
              {uploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
              {uploading ? "Uploading…" : "Choose CSV file"}
            </button>
            <label className="flex items-center gap-1.5 text-[11px] text-stone-700 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={replaceMode}
                onChange={(e) => setReplaceMode(e.target.checked)}
                data-testid="yearly-replace-toggle"
                className="accent-blue-600"
              />
              Replace existing (delete all first)
            </label>
            <button
              type="button"
              onClick={() => setManualOpen(true)}
              data-testid="yearly-add-manual"
              className="ml-auto px-3 py-2 text-xs font-bold uppercase tracking-wider border border-stone-300 bg-white hover:bg-stone-50 rounded-lg flex items-center gap-1.5"
            >
              <Plus className="w-3.5 h-3.5" /> Add single
            </button>
          </div>
          {uploadInfo && (
            <div className="text-xs bg-white border border-stone-200 rounded-lg px-3 py-2 space-y-1">
              <div className="flex items-center gap-2 text-emerald-800 font-semibold">
                <CheckCircle2 className="w-3.5 h-3.5" />
                Imported {uploadInfo.inserted} new event{uploadInfo.inserted === 1 ? "" : "s"}
                {uploadInfo.skipped_duplicates > 0 && ` · skipped ${uploadInfo.skipped_duplicates} duplicate(s)`}
                {" "}out of {uploadInfo.total_in_csv} row(s).
              </div>
              {uploadInfo.errors?.length > 0 && (
                <div className="text-amber-800 mt-1.5">
                  <div className="font-semibold mb-1">{uploadInfo.errors.length} row(s) skipped:</div>
                  <ul className="list-disc pl-5 space-y-0.5 text-[11px] text-stone-700">
                    {uploadInfo.errors.slice(0, 10).map((e, i) => <li key={i}>{e}</li>)}
                  </ul>
                </div>
              )}
            </div>
          )}
          {err && (
            <div className="text-xs text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg flex items-center gap-1.5">
              <AlertCircle className="w-3.5 h-3.5" /> {err}
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          <div className="flex items-center justify-between mb-3">
            <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">
              {loading ? "Loading…" : `${items.length} event${items.length === 1 ? "" : "s"} live on the portal`}
            </div>
            {items.length > 0 && (
              <button
                type="button"
                onClick={wipeAll}
                data-testid="yearly-wipe-all"
                className="text-[11px] text-rose-700 hover:text-rose-900 underline"
              >
                Delete all
              </button>
            )}
          </div>
          {loading ? (
            <div className="text-sm text-stone-500 flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading…
            </div>
          ) : items.length === 0 ? (
            <div className="text-center py-10 text-stone-500 text-sm border border-dashed border-stone-300 rounded-xl">
              <FileSpreadsheet className="w-8 h-8 mx-auto text-stone-300 mb-2" />
              No yearly events yet. Upload a CSV above to get started.
            </div>
          ) : (
            <ul className="divide-y divide-stone-100 border border-stone-200 rounded-xl overflow-hidden">
              {items.map((it) => (
                <li key={it.id} className="px-3 py-2 flex items-center gap-3" data-testid={`yearly-row-${it.id}`}>
                  <span
                    className="inline-block w-2.5 h-2.5 rounded-sm shrink-0"
                    style={{ background: "#3B82F6" }}
                  />
                  <span className="text-xs font-mono text-stone-700 w-24 shrink-0 tabular-nums">{fmtDateUK(it.date_iso)}</span>
                  <span className="flex-1 text-sm text-stone-950 truncate">{it.title}</span>
                  <span className="text-[10px] uppercase tracking-wider text-stone-400 shrink-0">
                    {it.source === "csv" ? "CSV" : "Manual"}
                  </span>
                  <button
                    onClick={() => deleteOne(it.id)}
                    data-testid={`yearly-del-${it.id}`}
                    title="Delete"
                    className="w-7 h-7 rounded-md border border-stone-200 hover:bg-rose-50 hover:border-rose-300 flex items-center justify-center"
                  >
                    <Trash2 className="w-3.5 h-3.5 text-stone-600" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="px-5 py-3 border-t border-stone-200 bg-stone-50 rounded-b-2xl flex justify-end">
          <button onClick={onClose} className="px-3 py-2 text-xs font-bold rounded-lg border border-stone-300 bg-white hover:bg-stone-50">
            Close
          </button>
        </div>

        {manualOpen && (
          <ManualYearlyModal
            onClose={() => setManualOpen(false)}
            onCreated={(doc) => {
              setItems((arr) => [...arr, doc].sort((a, b) => a.date_iso.localeCompare(b.date_iso)));
              setManualOpen(false);
            }}
          />
        )}
      </div>
    </div>
  );
}

function ManualYearlyModal({ onClose, onCreated }) {
  const [date, setDate] = useState("");
  const [title, setTitle] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  const save = async () => {
    setErr("");
    if (!date || !title.trim()) { setErr("Pick a date and add a title."); return; }
    setSaving(true);
    try {
      const { data } = await api.post("/admin/calendar/yearly-events", {
        date_iso: date,
        title: title.trim(),
      });
      onCreated(data);
    } catch (e) {
      setErr(e?.response?.data?.detail || "Could not save");
    } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-[80] bg-stone-950/70 flex items-center justify-center p-6" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="bg-white rounded-2xl shadow-2xl w-full max-w-sm">
        <div className="px-5 py-4 border-b border-stone-200 flex items-center justify-between">
          <span className="font-bold text-stone-950">Add yearly event</span>
          <button onClick={onClose} className="w-8 h-8 hover:bg-stone-100 rounded-md flex items-center justify-center">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-5 space-y-3">
          <div>
            <label className="block text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 mb-1">Date</label>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              data-testid="yearly-manual-date"
              className="w-full px-3 py-2 text-sm border border-stone-300 rounded-lg tabular-nums"
            />
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 mb-1">Title</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Spring half-term"
              data-testid="yearly-manual-title"
              className="w-full px-3 py-2 text-sm border border-stone-300 rounded-lg"
            />
          </div>
          {err && <div className="text-xs text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{err}</div>}
        </div>
        <div className="px-5 py-3 border-t border-stone-200 bg-stone-50 rounded-b-2xl flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-2 text-xs font-bold rounded-lg border border-stone-300 bg-white hover:bg-stone-50">Cancel</button>
          <button
            onClick={save}
            disabled={saving}
            data-testid="yearly-manual-save"
            className="px-4 py-2 text-xs font-bold uppercase tracking-wider bg-blue-600 text-white hover:bg-blue-700 rounded-lg disabled:opacity-50 flex items-center gap-1.5"
          >
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
            Add
          </button>
        </div>
      </div>
    </div>
  );
}
