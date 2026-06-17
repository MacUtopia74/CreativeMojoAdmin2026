// Shared "Link Woo product → R2 file" modal — reused by:
//  • Project Codes admin page  (Edit on a product row)
//  • Projects-this-month modal (Match button on each tile, admin only)
//
// Encapsulates the WooFilePicker (debounced search → inline PDF
// preview → Approve) and the manual project_code fallback, so callers
// don't have to reinvent the file-finder UX.
import { useEffect, useState } from "react";
import api from "@/lib/api";
import FilePreviewModal from "@/components/files/FilePreviewModal";
import {
  Loader2, Search, Link2, CheckCircle2, X, FileText, Eye, ExternalLink,
} from "lucide-react";

// Woo product names sometimes ship raw HTML — render them clean.
function stripHtml(raw) {
  if (raw == null) return "";
  const s = String(raw)
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
  return s.replace(/\s+/g, " ").trim();
}

function WooFilePicker({ initialQuery, busy, onApprove }) {
  const [q, setQ] = useState(initialQuery || "");
  const [results, setResults] = useState([]);
  const [previewFile, setPreviewFile] = useState(null);

  useEffect(() => {
    const trimmed = q.trim();
    if (trimmed.length < 2) { setResults([]); return; }
    let cancelled = false;
    const id = setTimeout(() => {
      api.get("/files/search", { params: { q: trimmed, limit: 20 } })
        .then(({ data }) => { if (!cancelled) setResults(data?.items || []); })
        .catch(() => { if (!cancelled) setResults([]); });
    }, 250);
    return () => { cancelled = true; clearTimeout(id); };
  }, [q]);

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="w-3.5 h-3.5 text-stone-400 absolute left-3 top-3" />
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search files by name (e.g. 'Flying Scotsman')…"
          data-testid="pc-file-picker-search"
          className="w-full pl-9 pr-3 py-2 text-sm border border-stone-300 rounded-lg focus:outline-none focus:border-stone-900"
        />
      </div>
      <div className="max-h-80 overflow-y-auto border border-stone-100 rounded-lg divide-y divide-stone-100" data-testid="pc-file-picker-results">
        {q.trim().length < 2 ? (
          <div className="py-6 text-center text-xs text-stone-400">
            Type a few words from the file name to search the vault.<br />
            Tip: shorter is better &mdash; e.g. <em>&ldquo;Flying Scotsman&rdquo;</em> not the full product title.
          </div>
        ) : !results.length ? (
          <div className="py-6 text-center text-xs text-stone-500">No files match &ldquo;{q}&rdquo;.</div>
        ) : (
          results.map((f) => (
            <div
              key={f.key}
              onClick={() => setPreviewFile(f)}
              data-testid={`pc-file-result-${f.key}`}
              title="Click to preview this file"
              className="px-3 py-2 flex items-center gap-3 hover:bg-stone-50 cursor-pointer group"
            >
              <FileText className="w-5 h-5 text-stone-400 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-xs font-semibold text-stone-900 truncate group-hover:text-stone-950">{f.name}</div>
                <div className="text-[10px] text-stone-500 truncate">{f.parent_prefix}</div>
                {f.project_code && (
                  <div className="text-[10px] font-mono text-emerald-700 mt-0.5">↪ {f.project_code}</div>
                )}
              </div>
              <button
                onClick={(e) => { e.stopPropagation(); setPreviewFile(f); }}
                title="Preview file"
                data-testid={`pc-file-preview-${f.key}`}
                className="w-7 h-7 rounded-md border border-stone-300 hover:bg-stone-100 flex items-center justify-center text-stone-600"
              >
                <Eye className="w-3.5 h-3.5" />
              </button>
              <a
                href={`/files?prefix=${encodeURIComponent(f.parent_prefix || "")}`}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                title="Open the containing folder in the Files page (new tab)"
                data-testid={`pc-file-open-files-${f.key}`}
                className="w-7 h-7 rounded-md border border-stone-300 hover:bg-stone-100 flex items-center justify-center text-stone-600"
              >
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
              <button
                onClick={(e) => { e.stopPropagation(); onApprove(f); }}
                disabled={busy}
                data-testid={`pc-file-approve-${f.key}`}
                className="px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider bg-emerald-600 hover:bg-emerald-700 text-white rounded-md flex items-center gap-1 disabled:opacity-40"
              >
                <CheckCircle2 className="w-3 h-3" /> Approve
              </button>
            </div>
          ))
        )}
      </div>
      {previewFile && (
        <FilePreviewModal file={previewFile} onClose={() => setPreviewFile(null)} />
      )}
    </div>
  );
}

/**
 * Edit/Match a single Woo product → R2 file pairing.
 *
 * Props:
 *  - product:  { id, name, image, value }   (value = current project_code, optional)
 *  - onClose(): close without saving
 *  - onSaved(): called after a successful approve / manual save so the
 *               caller can refetch its data.
 */
export default function EditProductLinkModal({ product, onClose, onSaved }) {
  const [value, setValue] = useState(product?.value || "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [productImagePreview, setProductImagePreview] = useState(null);

  // Strip storefront-editor boilerplate so the seed query is "12 Days of"
  // not "12 Days of Christmas Advent Colouring In A3 Booklet" (zero hits).
  const initialQuery = (() => {
    const clean = stripHtml(product?.name || "")
      .replace(/\b(Project Kit|Project|Kit|Standard|Boxed|Set|Cards?|Booklet|A3|A4)\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    return clean.split(" ").slice(0, 3).join(" ");
  })();

  const slug = (s) => (s || "")
    .toString()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  const approveFile = async (file) => {
    if (!product || !file) return;
    const code = file.project_code || value || slug(product.name);
    if (!code) { setErr("Couldn't derive a Project Code from this product name."); return; }
    setBusy(true);
    try {
      await Promise.all([
        api.put(`/admin/project-codes/woo/${encodeURIComponent(product.id)}`, { project_code: code }),
        api.put(`/admin/project-codes/file/${encodeURIComponent(file.key)}`, { project_code: code }),
      ]);
      onSaved?.({ kind: "approve", product, file, code });
      onClose?.();
    } catch (e) {
      setErr(e?.response?.data?.detail || "Approve failed.");
    } finally {
      setBusy(false);
    }
  };

  const saveManual = async () => {
    if (!product) return;
    setBusy(true);
    try {
      await api.put(`/admin/project-codes/woo/${encodeURIComponent(product.id)}`, {
        project_code: value,
      });
      onSaved?.({ kind: "manual", product, code: value });
      onClose?.();
    } catch (e) {
      setErr(e?.response?.data?.detail || "Save failed.");
    } finally {
      setBusy(false);
    }
  };

  if (!product) return null;

  return (
    <>
      <div
        className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
        data-testid="pc-edit-modal"
        onClick={(e) => { if (e.target === e.currentTarget) onClose?.(); }}
      >
        <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl p-6 space-y-4">
          <div className="flex items-start gap-3">
            {product.image && (
              <button
                type="button"
                onClick={() => setProductImagePreview(product.image)}
                title="Click to view the storefront image at full size"
                data-testid="pc-product-thumb"
                className="shrink-0 rounded-lg overflow-hidden ring-1 ring-stone-200 hover:ring-stone-900 transition focus:outline-none"
              >
                <img src={product.image} alt="" className="w-14 h-14 object-cover bg-stone-100" />
              </button>
            )}
            <div className="min-w-0">
              <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">Link product to a file</div>
              <h3 className="font-display text-xl text-stone-950 mt-1 truncate">{stripHtml(product.name)}</h3>
              {value && (
                <div className="text-[11px] text-stone-500 mt-1 flex items-center gap-1.5">
                  <Link2 className="w-3 h-3" /> Currently linked: <span className="font-mono text-stone-800">{value}</span>
                </div>
              )}
            </div>
          </div>

          <div className="border-t border-stone-200 pt-4 space-y-2">
            <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600">
              Step 1 — Find &amp; preview the file
            </div>
            <WooFilePicker
              initialQuery={initialQuery}
              busy={busy}
              onApprove={approveFile}
            />
          </div>

          <div className="border-t border-stone-200 pt-4">
            <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 mb-2">
              Or — set the Project Code manually
            </div>
            <label className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600">Project Code</label>
            <input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="MAY_VE_DAY_GRAMOPHONE"
              data-testid="pc-edit-input"
              className="w-full mt-1 px-3 py-2 text-sm font-mono border border-stone-300 rounded-lg focus:outline-none focus:border-stone-900"
            />
            <p className="text-[11px] text-stone-500 mt-1">Slugified server-side — any case/punctuation collapses to <code>FOO_BAR</code>.</p>
          </div>

          {err && <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">{err}</div>}

          <div className="flex justify-end gap-2 pt-2">
            <button onClick={onClose} className="px-3 py-2 text-xs font-bold uppercase tracking-wider border border-stone-300 hover:bg-stone-50 rounded-lg">Cancel</button>
            <button
              onClick={saveManual}
              disabled={busy}
              data-testid="pc-edit-save"
              className="px-4 py-2 text-xs font-bold uppercase tracking-wider bg-stone-950 hover:bg-stone-800 text-[#dedd0a] rounded-lg disabled:opacity-50"
            >{busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Save"}</button>
          </div>
        </div>
      </div>

      {productImagePreview && (
        <div
          onClick={() => setProductImagePreview(null)}
          className="fixed inset-0 z-[70] bg-stone-950/85 backdrop-blur-sm flex items-center justify-center p-4 sm:p-8"
          data-testid="pc-product-image-lightbox"
        >
          <button
            onClick={() => setProductImagePreview(null)}
            aria-label="Close storefront image"
            data-testid="pc-product-image-close"
            className="absolute top-4 right-4 w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center"
          >
            <X className="w-5 h-5" />
          </button>
          <img
            src={productImagePreview}
            alt="Product storefront image"
            onClick={(e) => e.stopPropagation()}
            className="max-w-full max-h-full object-contain rounded-xl shadow-2xl"
          />
        </div>
      )}
    </>
  );
}
