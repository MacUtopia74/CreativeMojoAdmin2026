// Public PDF landing page — accessed via /info/:slug, no auth required.
// Branded Creative Mojo viewer with a single big yellow CTA that 302's
// straight into a fresh signed R2 download URL.
//
// The optional `?t=<send-id>` query param ties this visit to the email
// that drove it, so the admin's Activity Timeline picks the click up.
import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { Download, Loader2, AlertCircle, Check } from "lucide-react";
import axios from "axios";
import DOMPurify from "dompurify";

const BACKEND_URL = process.env.REACT_APP_BACKEND_URL;

export default function InfoLandingPage() {
  const { slug } = useParams();
  const [params] = useSearchParams();
  const token = params.get("t");
  const [page, setPage] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true); setError("");
      try {
        const { data } = await axios.get(
          `${BACKEND_URL}/api/public/landing/${encodeURIComponent(slug)}`,
          { params: token ? { t: token } : {} },
        );
        if (!cancelled) setPage(data);
      } catch (e) {
        if (!cancelled) {
          setError(e?.response?.status === 404
            ? "This page no longer exists. Please contact us if you reached this link from an email."
            : (e?.response?.data?.detail || "Could not load this page."));
        }
      } finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [slug, token]);

  const downloadUrl = `${BACKEND_URL}/api/public/landing/${encodeURIComponent(slug)}/download${token ? `?t=${encodeURIComponent(token)}` : ""}`;

  return (
    <div className="min-h-screen bg-stone-50 flex flex-col" data-testid="info-landing-page">
      <header className="px-6 sm:px-10 pt-10 sm:pt-14 pb-4 flex justify-center">
        <img
          src="/brand/creative-mojo-logo.png"
          alt="Creative Mojo"
          className="max-w-[240px] h-auto"
          data-testid="info-landing-logo"
        />
      </header>

      <main className="flex-1 px-4 sm:px-6 py-6 flex justify-center">
        <div className="w-full max-w-2xl">
          {loading && (
            <div className="bg-white rounded-2xl border border-stone-200 p-10 text-center text-stone-500" data-testid="info-landing-loading">
              <Loader2 className="w-6 h-6 animate-spin mx-auto mb-3" />
              Loading…
            </div>
          )}
          {error && !loading && (
            <div className="bg-white rounded-2xl border border-rose-200 p-10 text-center text-rose-800" data-testid="info-landing-error">
              <AlertCircle className="w-7 h-7 mx-auto mb-3" />
              <div className="font-semibold mb-1">Page unavailable</div>
              <div className="text-sm text-rose-700">{error}</div>
            </div>
          )}
          {page && !loading && (
            <article className="bg-white rounded-2xl border border-stone-200 shadow-sm overflow-hidden">
              <div className="px-6 sm:px-10 pt-8 sm:pt-10 pb-6">
                <h1 className="text-3xl sm:text-4xl font-bold text-stone-900 tracking-tight leading-tight" data-testid="info-landing-title">
                  {page.title}
                </h1>
                {page.intro_html ? (
                  <div
                    className="prose prose-stone mt-4 text-stone-700 leading-relaxed"
                    dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(page.intro_html) }}
                    data-testid="info-landing-intro"
                  />
                ) : null}

                {(page.bullets || []).length > 0 && (
                  <ul className="mt-6 space-y-2" data-testid="info-landing-bullets">
                    {page.bullets.map((b, i) => (
                      <li key={i} className="flex items-start gap-2.5 text-stone-700">
                        <Check className="w-4 h-4 text-emerald-600 mt-0.5 shrink-0" />
                        <span>{b}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="px-6 sm:px-10 pb-10 pt-2 bg-stone-50 border-t border-stone-100">
                {page.has_file ? (
                  <a
                    href={downloadUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2.5 px-6 sm:px-8 py-3.5 bg-[#dddd16] hover:bg-[#c8c814] text-stone-900 font-bold uppercase tracking-wider text-sm rounded-lg shadow-sm transition-colors"
                    data-testid="info-landing-download-btn"
                  >
                    <Download className="w-4 h-4" /> {page.cta_label || "Download"}
                  </a>
                ) : (
                  <div className="text-sm text-stone-500 italic">
                    No file attached to this page yet.
                  </div>
                )}
                {page.file_name && page.has_file && (
                  <div className="mt-2.5 text-[11px] text-stone-500 font-mono truncate" title={page.file_name}>
                    {page.file_name}
                  </div>
                )}
              </div>
            </article>
          )}
        </div>
      </main>

      <footer className="px-6 py-6 text-center text-[11px] text-stone-400">
        © {new Date().getFullYear()} Creative Mojo Ltd · Registered in England &amp; Wales No. 10261882
      </footer>
    </div>
  );
}
