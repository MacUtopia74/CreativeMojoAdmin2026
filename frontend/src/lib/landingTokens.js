// Shared landing-token resolver used by every email-preview surface.
//
// Root cause of the "CTA becomes /admin/%7B%7B..." bug: preview code
// paths (EmailTemplatesPage, ReplyWithTemplateModal, Announcements,
// etc.) each rendered raw ``{{landing:<slug>}}`` tokens straight into
// anchor ``href`` attributes. Browsers treated those hrefs as relative
// URLs, url-encoding the curly braces and prepending the current
// admin path. This helper centralises the fix so every preview and
// every future preview uses the SAME resolution the Resend send
// pipeline uses at send time (see backend/resend_routes.py
// _resolve_landing_tokens).
//
// Behaviour:
//   * Extract every unique {{landing:<slug>}} token in the html.
//   * Ask the backend to resolve them to public URLs.
//   * Replace each anchor whose ``href`` is a landing token:
//       - resolved       → rewrite href to the public URL and force
//                          target="_blank" rel="noopener noreferrer".
//       - unresolved     → strip the href, add a red "unresolved
//                          landing token" warning span so the admin
//                          notices before sending (rather than the
//                          link silently going to /admin/%7B%7B...).
//   * All non-anchor occurrences of the token in the html are also
//     substituted (or wrapped in the same warning span) so plain-text
//     tokens don't leak into the outgoing email either.
//
// Idempotent — re-running on already-resolved html is a no-op.
import api from "@/lib/api";

const LANDING_TOKEN_RE = /\{\{\s*landing:([a-z0-9-]+?)\s*\}\}/g;

/**
 * @param {string} html — raw body_html containing zero or more
 *   ``{{landing:<slug>}}`` tokens.
 * @returns {Promise<string>} resolved html with anchors rewritten in
 *   place. Never throws — a network failure just leaves the tokens
 *   visible AND replaces the anchor with a warning span so the admin
 *   can't accidentally send a broken CTA.
 */
export async function resolveLandingTokens(html) {
  if (!html || typeof html !== "string") return html || "";
  const slugs = Array.from(new Set(
    [...html.matchAll(LANDING_TOKEN_RE)].map((m) => m[1]),
  ));
  if (slugs.length === 0) return html;

  let resolved = {};
  try {
    const { data } = await api.get("/admin/landing-pages/resolve", {
      params: { slugs: slugs.join(",") },
    });
    resolved = data?.resolved || {};
  } catch (e) {
    // Network / auth error — mark everything as unresolved so the
    // preview flags the problem instead of silently issuing bad hrefs.
    resolved = Object.fromEntries(slugs.map((s) => [s, null]));
  }

  // 1) Rewrite anchor hrefs that hold a landing token. Regex covers
  //    both quote styles and any whitespace inside the braces.
  const anchorHrefRe = /(<a\b[^>]*\shref\s*=\s*["'])\{\{\s*landing:([a-z0-9-]+?)\s*\}\}(["'][^>]*>)/gi;
  let out = html.replace(anchorHrefRe, (match, pre, slug, post) => {
    const url = resolved[slug];
    if (url) {
      // Force target=_blank + noopener so preview clicks open safely
      // in a new tab (matches what recipients see in email clients).
      const openerAttrs = /target=/i.test(pre + post) ? "" : ` target="_blank" rel="noopener noreferrer"`;
      return `${pre}${url}${post.replace(">", `${openerAttrs}>`)}`;
    }
    // Unresolved slug — kill the href so the preview link can't be
    // clicked, and inject a data attribute the wrapping code can
    // decorate visually.
    return `${pre}#unresolved-landing-token-${slug}${post.replace(">", ` data-cm-landing-unresolved="${slug}" style="color:#b91c1c;text-decoration:line-through;cursor:not-allowed;" title="Landing page slug &quot;${slug}&quot; does not resolve to an active page.">`)}`;
  });

  // 2) Any remaining bare tokens in text (or in attributes we didn't
  //    match above) → wrap in an inline warning span so the admin
  //    spots them before sending.
  out = out.replace(LANDING_TOKEN_RE, (match, slug) => {
    const url = resolved[slug];
    if (url) return url;
    return `<span style="color:#b91c1c;font-weight:600;" title="Unresolved landing token">⚠ {{landing:${slug}}}</span>`;
  });

  return out;
}

/**
 * Synchronous check — returns the set of unresolved slugs in html.
 * Callers can use this to disable the Send button until every token
 * resolves. NOT a full resolution — call ``resolveLandingTokens`` for
 * that; this just extracts the slugs.
 */
export function extractLandingSlugs(html) {
  if (!html || typeof html !== "string") return [];
  return Array.from(new Set(
    [...html.matchAll(LANDING_TOKEN_RE)].map((m) => m[1]),
  ));
}
