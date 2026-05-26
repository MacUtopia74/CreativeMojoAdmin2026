import axios from "axios";

const BACKEND_URL = process.env.REACT_APP_BACKEND_URL;
export const API_BASE = `${BACKEND_URL}/api`;

// ---------------------------------------------------------------------------
// Token storage — primary auth path for cross-site deployments
//
// In production the frontend (hub.creativemojo.co.uk) and backend
// (*.emergent.host) live on different *sites*, so modern Chrome — and
// especially incognito windows — silently strip cross-site cookies even
// though we set them with ``SameSite=None; Secure``. To keep auth working
// we mirror the access/refresh JWT in localStorage and send them as
// ``Authorization: Bearer …`` headers. The backend still accepts cookies
// too, so same-origin dev (preview) keeps working unchanged.
// ---------------------------------------------------------------------------
const ACCESS_KEY = "cm.auth.access";
const REFRESH_KEY = "cm.auth.refresh";

export function setAuthTokens({ access_token, refresh_token } = {}) {
  try {
    if (access_token) localStorage.setItem(ACCESS_KEY, access_token);
    if (refresh_token) localStorage.setItem(REFRESH_KEY, refresh_token);
  } catch (e) {
    console.debug("[api] localStorage write blocked:", e);
  }
}
export function clearAuthTokens() {
  try {
    localStorage.removeItem(ACCESS_KEY);
    localStorage.removeItem(REFRESH_KEY);
  } catch { /* noop */ }
}
export function getAccessToken() {
  try { return localStorage.getItem(ACCESS_KEY); } catch { return null; }
}
export function getRefreshToken() {
  try { return localStorage.getItem(REFRESH_KEY); } catch { return null; }
}

const api = axios.create({
  baseURL: API_BASE,
  withCredentials: true,
});

// Attach Bearer token to every outbound request when we have one.
api.interceptors.request.use((config) => {
  const t = getAccessToken();
  if (t) {
    config.headers = config.headers || {};
    if (!config.headers.Authorization) config.headers.Authorization = `Bearer ${t}`;
  }
  return config;
});

// ---------------------------------------------------------------------------
// 401 → silent refresh interceptor.
// When any authenticated call returns 401 we hit /auth/refresh once. On
// success we replay the original request (so the user never sees a flicker).
// On failure we let the 401 propagate and bounce them to /login.
// ---------------------------------------------------------------------------
let refreshPromise = null;

api.interceptors.response.use(
  (resp) => resp,
  async (error) => {
    const { response, config } = error;
    if (!response || response.status !== 401) throw error;
    // Don't try to refresh inside the refresh call itself (avoids loops).
    if (config?.url?.includes("/auth/refresh") || config?.url?.includes("/auth/login")) {
      throw error;
    }
    if (config?._retried) throw error;
    // Public landing pages (share links, login screens) should never trigger
    // a refresh+redirect loop — just let the 401 propagate so the calling
    // component can handle it however it likes.
    const pathNow = typeof window !== "undefined" ? window.location.pathname : "";
    if (
      pathNow === "/login"
      || pathNow.startsWith("/portal/login")
      || pathNow.startsWith("/share/")
    ) {
      throw error;
    }
    config._retried = true;
    try {
      // Pass refresh_token in the body too so the call still works when
      // the cookie was blocked by cross-site rules.
      refreshPromise = refreshPromise || api.post("/auth/refresh", {
        refresh_token: getRefreshToken() || undefined,
      }).then((res) => {
        setAuthTokens(res.data);
        return res;
      });
      await refreshPromise;
    } catch (e) {
      refreshPromise = null;
      clearAuthTokens();
      // Refresh failed — force a login bounce. We swap the location only
      // when we're not already on a public page so we don't loop the
      // login page itself.
      const path = window.location.pathname;
      // Public pages (no auth) shouldn't be bounced to login. The 401 here
      // is just the AuthProvider's "am I logged in?" probe failing.
      if (
        !path.startsWith("/login")
        && !path.startsWith("/portal/login")
        && !path.startsWith("/share/")
      ) {
        const target = path.startsWith("/portal") ? "/portal/login" : "/login";
        window.location.href = target;
      }
      throw error;
    } finally {
      // Tiny grace window before nulling the gate so concurrent calls
      // share one network round-trip.
      setTimeout(() => { refreshPromise = null; }, 200);
    }
    return api.request(config);
  }
);

export function formatError(err) {
  const detail = err?.response?.data?.detail;
  if (detail == null) return err?.message || "Something went wrong.";
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    return detail.map((e) => (e && typeof e.msg === "string" ? e.msg : JSON.stringify(e))).join(" ");
  }
  if (detail && typeof detail.msg === "string") return detail.msg;
  return String(detail);
}

export default api;
