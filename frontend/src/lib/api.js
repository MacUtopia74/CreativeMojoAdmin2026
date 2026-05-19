import axios from "axios";

const BACKEND_URL = process.env.REACT_APP_BACKEND_URL;
export const API_BASE = `${BACKEND_URL}/api`;

const api = axios.create({
  baseURL: API_BASE,
  withCredentials: true,
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
    config._retried = true;
    try {
      refreshPromise = refreshPromise || api.post("/auth/refresh");
      await refreshPromise;
    } catch (e) {
      refreshPromise = null;
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
