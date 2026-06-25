// Public PDF landing page — accessed via /info/:slug, no auth required.
// Branded Creative Mojo viewer with a single big yellow CTA that 302's
// straight into a fresh signed R2 download URL.
//
// The optional `?t=<send-id>` query param ties this visit to the email
// that drove it, so the admin's Activity Timeline picks the click up.
import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { Download, Loader2, AlertCircle } from "lucide-react";
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
              </div>

              <div className="px-6 sm:px-10 pb-10 pt-2 bg-stone-50 border-t border-stone-100">
                {page.has_file ? (
                  <div className="flex flex-col sm:flex-row items-center gap-6">
                    {/* Big PDF document icon — visual cue that the CTA
                        downloads a PDF, not opens a webpage. Custom SVG
                        styled like the classic Acrobat "PDF page". */}
                    <a
                      href={downloadUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={`Download ${page.file_name || "PDF"}`}
                      data-testid="info-landing-pdf-icon"
                      className="shrink-0 transition-transform hover:scale-105"
                    >
                      <svg
                        width="120"
                        height="148"
                        viewBox="0 0 120 148"
                        fill="none"
                        xmlns="http://www.w3.org/2000/svg"
                        aria-label="PDF document"
                      >
                        {/* Folded-corner page outline */}
                        <path
                          d="M14 6 H88 L114 32 V134 a8 8 0 0 1 -8 8 H14 a8 8 0 0 1 -8 -8 V14 a8 8 0 0 1 8 -8 z"
                          fill="#ffffff"
                          stroke="#dc2626"
                          strokeWidth="6"
                          strokeLinejoin="round"
                        />
                        <path d="M88 6 V32 H114" fill="none" stroke="#dc2626" strokeWidth="6" strokeLinejoin="round" />
                        {/* PDF wordmark */}
                        <text
                          x="60"
                          y="118"
                          textAnchor="middle"
                          fontFamily="Helvetica, Arial, sans-serif"
                          fontSize="26"
                          fontWeight="900"
                          fill="#1a1a1a"
                          letterSpacing="2"
                        >
                          PDF
                        </text>
                      </svg>
                    </a>

                    <div className="flex-1 text-center sm:text-left min-w-0">
                      <a
                        href={downloadUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-2.5 px-6 sm:px-8 py-3.5 bg-[#dddd16] hover:bg-[#c8c814] text-stone-900 font-bold uppercase tracking-wider text-sm rounded-lg shadow-sm transition-colors"
                        data-testid="info-landing-download-btn"
                      >
                        <Download className="w-4 h-4" /> {page.cta_label || "Download"}
                      </a>
                      {page.file_name && (
                        <div className="mt-2.5 text-[11px] text-stone-500 font-mono truncate" title={page.file_name}>
                          {page.file_name}
                        </div>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="text-sm text-stone-500 italic">
                    No file attached to this page yet.
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
