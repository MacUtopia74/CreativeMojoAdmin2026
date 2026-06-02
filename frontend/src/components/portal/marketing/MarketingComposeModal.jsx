// Marketing compose modal — two-pane editor (left) / live preview
// (right). Mirrors the HQ Updates ComposeModal but scoped to the
// franchisee's own Territory+ clients and capped at 5 recipients.
import { useEffect, useState, useMemo, useCallback } from "react";
import {
  X, Send, Loader2, Search, CheckCircle2, AlertCircle, Image as ImageIcon,
  Trash2, Link as LinkIcon, Calendar, Megaphone, RefreshCw,
} from "lucide-react";
import api from "@/lib/api";
import MarketingImageCropper from "@/components/portal/marketing/MarketingImageCropper";

const MAX_RECIPIENTS = 5;

export default function MarketingComposeModal({ open, access, onClose, onSent }) {
  const [title, setTitle] = useState("");
  const [intro, setIntro] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [imageKey, setImageKey] = useState("");
  const [linkUrl, setLinkUrl] = useState("");
  const [linkLabel, setLinkLabel] = useState("Find out more");
  const [includeBookings, setIncludeBookings] = useState(false);

  const [recipients, setRecipients] = useState([]);
  const [recipientSearch, setRecipientSearch] = useState("");
  const [selectedKeys, setSelectedKeys] = useState(new Set()); // "client_id:contact_index"
  const [recipientsLoading, setRecipientsLoading] = useState(false);

  const [previewHtml, setPreviewHtml] = useState("");
  const [cropOpen, setCropOpen] = useState(false);
  const [rawImageFile, setRawImageFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [sending, setSending] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");

  // Reset when modal opens
  useEffect(() => {
    if (!open) return;
    setTitle(""); setIntro("");
    setImageUrl(""); setImageKey("");
    setLinkUrl(""); setLinkLabel("Find out more");
    setIncludeBookings(false);
    setRecipientSearch(""); setSelectedKeys(new Set());
    setPreviewHtml(""); setError(""); setInfo("");
    setRecipientsLoading(true);
    api.get("/portal/marketing/recipients")
      .then(({ data }) => setRecipients(data.items || []))
      .catch(() => setRecipients([]))
      .finally(() => setRecipientsLoading(false));
  }, [open]);

  // Live preview render (debounced)
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(async () => {
      try {
        const { data } = await api.post("/portal/marketing/preview-html", {
          title, intro,
          image_url: imageUrl,
          link_url: linkUrl,
          link_label: linkLabel,
          bookings_url: includeBookings && access?.bookings_enabled
            ? `${window.location.origin}/portal/bookings` : "",
          sample_first_name: "Sandra",
        });
        setPreviewHtml(data.html || "");
      } catch { /* swallow — preview is best-effort */ }
    }, 300);
    return () => clearTimeout(t);
  }, [open, title, intro, imageUrl, linkUrl, linkLabel, includeBookings, access?.bookings_enabled]);

  const filteredRecipients = useMemo(() => {
    const needle = recipientSearch.trim().toLowerCase();
    if (!needle) return recipients;
    return recipients.filter((r) =>
      (r.name || "").toLowerCase().includes(needle) ||
      (r.organisation || "").toLowerCase().includes(needle) ||
      (r.email || "").toLowerCase().includes(needle) ||
      (r.role || "").toLowerCase().includes(needle)
    );
  }, [recipients, recipientSearch]);

  const toggleRecipient = (r) => {
    const key = `${r.client_id}:${r.contact_index}`;
    setSelectedKeys((s) => {
      const n = new Set(s);
      if (n.has(key)) {
        n.delete(key);
      } else {
        if (n.size >= MAX_RECIPIENTS) {
          setError(`Maximum ${MAX_RECIPIENTS} recipients per send.`);
          setTimeout(() => setError(""), 2000);
          return s;
        }
        n.add(key);
      }
      return n;
    });
  };

  const selectedRecipients = useMemo(() => {
    return recipients.filter((r) => selectedKeys.has(`${r.client_id}:${r.contact_index}`));
  }, [recipients, selectedKeys]);

  // ----- image crop pipeline -----
  const onPickImage = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setRawImageFile(f);
    setCropOpen(true);
    e.target.value = ""; // allow re-picking same file
  };
  const onCropDone = async (croppedBlob) => {
    setCropOpen(false);
    if (!croppedBlob) return;
    setUploading(true); setError("");
    try {
      const fd = new FormData();
      fd.append("file", croppedBlob, "marketing.jpg");
      const { data } = await api.post("/portal/marketing/upload-image", fd, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      setImageUrl(data.image_url);
      setImageKey(data.key);
    } catch (e) {
      setError(e?.response?.data?.detail || "Image upload failed");
    } finally { setUploading(false); }
  };

  // ----- send + test -----
  const buildBody = () => ({
    frontend_origin: typeof window !== "undefined" ? window.location.origin : "",
    title: title.trim(),
    intro: intro.trim(),
    image_url: imageUrl || undefined,
    image_key: imageKey || undefined,
    link_url: linkUrl.trim() || undefined,
    link_label: linkLabel.trim() || undefined,
    include_bookings_link: includeBookings && access?.bookings_enabled,
    recipients: selectedRecipients.map((r) => ({
      client_id: r.client_id, contact_index: r.contact_index,
    })),
  });

  const send = async () => {
    if (selectedRecipients.length === 0) {
      setError("Pick at least one recipient.");
      return;
    }
    const ok = window.confirm(
      `Send "${title.trim() || "(no subject)"}" to ${selectedRecipients.length} recipient${selectedRecipients.length === 1 ? "" : "s"}?`
    );
    if (!ok) return;
    setSending(true); setError(""); setInfo("");
    try {
      const { data } = await api.post("/portal/marketing/campaigns", buildBody());
      setInfo(`Sent to ${data.succeeded} recipient(s).`);
      onSent?.();
    } catch (e) {
      setError(e?.response?.data?.detail || "Send failed.");
    } finally { setSending(false); }
  };

  const sendTest = async () => {
    setTesting(true); setError(""); setInfo("");
    try {
      const { data } = await api.post("/portal/marketing/test-send", {
        ...buildBody(),
        sample_first_name: "Sandra",
      });
      setInfo(`Test email sent to ${data.to}.`);
    } catch (e) {
      setError(e?.response?.data?.detail || "Test send failed.");
    } finally { setTesting(false); }
  };

  const canSend = title.trim() && intro.trim() && selectedRecipients.length > 0 && !sending;

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-stone-950/40 backdrop-blur-sm flex items-stretch justify-center p-4 overflow-y-auto"
      onClick={onClose}
      data-testid="marketing-compose-modal"
    >
      <div
        className="bg-white w-full max-w-[1400px] rounded-2xl border border-stone-200 shadow-2xl my-auto flex flex-col max-h-[95vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 py-4 border-b border-stone-200 flex items-start justify-between gap-4">
          <div>
            <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 flex items-center gap-1.5">
              <Megaphone className="w-3 h-3" /> Send Campaign
            </div>
            <h2 className="font-display text-2xl font-black text-stone-950 mt-1">Compose Campaign</h2>
          </div>
          <button
            onClick={onClose}
            data-testid="marketing-compose-close"
            className="w-9 h-9 rounded-full border border-stone-300 hover:bg-stone-50 flex items-center justify-center"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body — two-pane */}
        <div className="flex-1 overflow-y-auto">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-0">
            {/* LEFT — editor */}
            <div className="px-6 py-5 space-y-5 border-r border-stone-200">
              <Field label="Title (subject line)" required>
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  data-testid="marketing-title"
                  className="w-full px-3 py-2.5 border border-stone-300 rounded-xl text-sm focus:outline-none focus:border-stone-950"
                  placeholder="e.g. New summer craft sessions"
                />
              </Field>

              <Field label="Intro text" required>
                <textarea
                  value={intro}
                  onChange={(e) => setIntro(e.target.value)}
                  data-testid="marketing-intro"
                  rows={4}
                  className="w-full px-3 py-2.5 border border-stone-300 rounded-xl text-sm focus:outline-none focus:border-stone-950 resize-none"
                  placeholder="Hi! We're running…"
                />
              </Field>

              {/* Image panel */}
              <div>
                <label className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 mb-1.5 flex items-center justify-between">
                  <span><ImageIcon className="w-3 h-3 inline mr-1" /> Image (optional)</span>
                  {imageUrl && (
                    <button
                      onClick={() => { setImageUrl(""); setImageKey(""); }}
                      data-testid="marketing-image-remove"
                      className="text-stone-400 hover:text-red-600 text-[10px] inline-flex items-center gap-1"
                    >
                      <Trash2 className="w-3 h-3" /> Remove
                    </button>
                  )}
                </label>
                {imageUrl ? (
                  <div className="border border-stone-300 rounded-xl overflow-hidden bg-stone-100">
                    <img src={imageUrl} alt="" className="w-full h-auto" data-testid="marketing-image-preview" />
                  </div>
                ) : (
                  <label
                    className="flex flex-col items-center justify-center px-4 py-8 border-2 border-dashed border-stone-300 rounded-xl cursor-pointer hover:bg-stone-50 text-stone-500"
                    data-testid="marketing-image-upload"
                  >
                    {uploading ? (
                      <Loader2 className="w-5 h-5 animate-spin text-stone-400" />
                    ) : (
                      <>
                        <ImageIcon className="w-7 h-7 mb-2 text-stone-400" />
                        <span className="text-sm font-medium">Upload &amp; crop an image</span>
                        <span className="text-[11px] mt-1">Free-form crop · max 12 MB · JPG / PNG / WebP</span>
                      </>
                    )}
                    <input type="file" accept="image/*" onChange={onPickImage} className="hidden" />
                  </label>
                )}
              </div>

              {/* Link + label */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field label="Link URL (optional)">
                  <div className="relative">
                    <LinkIcon className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-stone-400" />
                    <input
                      type="url"
                      value={linkUrl}
                      onChange={(e) => setLinkUrl(e.target.value)}
                      data-testid="marketing-link-url"
                      placeholder="https://…"
                      className="w-full pl-9 pr-3 py-2.5 border border-stone-300 rounded-xl text-sm focus:outline-none focus:border-stone-950"
                    />
                  </div>
                </Field>
                <Field label="Button label">
                  <input
                    value={linkLabel}
                    onChange={(e) => setLinkLabel(e.target.value)}
                    data-testid="marketing-link-label"
                    className="w-full px-3 py-2.5 border border-stone-300 rounded-xl text-sm focus:outline-none focus:border-stone-950"
                  />
                </Field>
              </div>

              {/* Bookings link */}
              {access?.bookings_enabled && (
                <label className="flex items-center gap-2 px-3 py-2 border border-stone-200 rounded-xl bg-stone-50 cursor-pointer hover:bg-stone-100" data-testid="marketing-bookings-toggle">
                  <input
                    type="checkbox"
                    checked={includeBookings}
                    onChange={(e) => setIncludeBookings(e.target.checked)}
                    className="w-4 h-4 rounded border-stone-300 text-stone-900 focus:ring-stone-900"
                  />
                  <Calendar className="w-4 h-4 text-stone-600" />
                  <span className="text-sm text-stone-800">
                    Include a <strong>Book a session</strong> button (links to your bookings page)
                  </span>
                </label>
              )}

              {/* Recipients */}
              <div>
                <label className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 mb-1.5 flex items-center justify-between">
                  <span>Recipients <span className="text-stone-400 normal-case font-normal">(max 5 per send)</span></span>
                  <span data-testid="marketing-recipients-count" className={`px-2 py-0.5 rounded ${selectedKeys.size === MAX_RECIPIENTS ? "bg-amber-100 text-amber-900" : "bg-stone-100 text-stone-700"}`}>
                    {selectedKeys.size} / {MAX_RECIPIENTS}
                  </span>
                </label>
                <div className="relative mb-2">
                  <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-stone-400" />
                  <input
                    value={recipientSearch}
                    onChange={(e) => setRecipientSearch(e.target.value)}
                    placeholder="Search clients & contacts…"
                    className="w-full pl-9 pr-3 py-2 text-sm border border-stone-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-stone-900/20"
                    data-testid="marketing-recipient-search"
                  />
                </div>
                <div className="max-h-72 overflow-y-auto border border-stone-200 rounded-xl divide-y divide-stone-100" data-testid="marketing-recipient-list">
                  {recipientsLoading ? (
                    <div className="flex items-center justify-center py-8 text-stone-400 text-sm">
                      <Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading clients…
                    </div>
                  ) : filteredRecipients.length === 0 ? (
                    <div className="px-3 py-6 text-center text-xs text-stone-500">
                      {recipients.length === 0
                        ? "No client contacts with email addresses yet. Add one from My Territory+."
                        : "No matches."}
                    </div>
                  ) : filteredRecipients.map((r) => {
                    const key = `${r.client_id}:${r.contact_index}`;
                    const checked = selectedKeys.has(key);
                    return (
                      <button
                        key={key}
                        type="button"
                        onClick={() => toggleRecipient(r)}
                        data-testid={`marketing-recipient-${r.client_id}-${r.contact_index}`}
                        className={`w-full px-3 py-2 text-left flex items-center gap-3 hover:bg-stone-50 ${checked ? "bg-emerald-50" : ""}`}
                      >
                        <input
                          type="checkbox"
                          readOnly
                          checked={checked}
                          className="w-4 h-4 rounded border-stone-300 text-stone-900 focus:ring-stone-900 pointer-events-none"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium text-stone-900 truncate">
                            {r.name} <span className="text-stone-400 font-normal">· {r.role}</span>
                          </div>
                          <div className="text-xs text-stone-500 truncate">
                            {r.email}{r.organisation ? ` — ${r.organisation}` : ""}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* RIGHT — preview */}
            <div className="bg-stone-50 px-6 py-5 flex flex-col gap-3">
              <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-700 flex items-center gap-1.5">
                <Eye3 /> Live Preview
                <span className="text-stone-400 font-normal normal-case tracking-normal ml-auto">Rendered as recipients will see it</span>
              </div>
              <div className="flex-1 bg-white border border-stone-200 rounded-xl overflow-hidden min-h-[420px]">
                {previewHtml ? (
                  <iframe
                    title="Email preview"
                    srcDoc={previewHtml}
                    className="w-full h-[600px] border-0"
                    data-testid="marketing-preview-iframe"
                  />
                ) : (
                  <div className="flex items-center justify-center h-[420px] text-stone-400 text-sm">
                    <Loader2 className="w-4 h-4 animate-spin mr-2" /> Rendering…
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-stone-200 bg-stone-50 flex items-center justify-between gap-3 flex-wrap shrink-0">
          <div className="flex-1 min-w-0">
            {error && (
              <div className="text-xs text-red-700 flex items-center gap-1.5" data-testid="marketing-error">
                <AlertCircle className="w-3.5 h-3.5" /> {error}
              </div>
            )}
            {info && !error && (
              <div className="text-xs text-emerald-700 flex items-center gap-1.5" data-testid="marketing-info">
                <CheckCircle2 className="w-3.5 h-3.5" /> {info}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={sendTest}
            disabled={testing || !title.trim() || !intro.trim()}
            data-testid="marketing-test-send"
            className="px-4 py-2 text-xs font-bold uppercase tracking-wider border border-stone-300 hover:bg-stone-50 text-stone-700 rounded-lg flex items-center gap-1.5 disabled:opacity-50"
          >
            {testing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            Send test to me
          </button>
          <button
            type="button"
            onClick={send}
            disabled={!canSend}
            data-testid="marketing-send-btn"
            className="px-5 py-2 text-xs font-bold uppercase tracking-wider bg-[#dddd16] hover:bg-[#aaaa11] text-stone-950 rounded-lg flex items-center gap-1.5 disabled:opacity-50"
          >
            {sending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
            Send to {selectedKeys.size || 0} recipient{selectedKeys.size === 1 ? "" : "s"}
          </button>
        </div>
      </div>

      <MarketingImageCropper
        open={cropOpen}
        file={rawImageFile}
        onCancel={() => setCropOpen(false)}
        onDone={onCropDone}
      />
    </div>
  );
}

function Field({ label, required, children }) {
  return (
    <div>
      <label className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 mb-1.5 block">
        {label}{required && <span className="text-red-500 ml-0.5">*</span>}
      </label>
      {children}
    </div>
  );
}

// Inline eye icon stub — avoids dragging the lucide Eye into the import
// list when the rest of the icons live above.
function Eye3() {
  return (
    <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}
