import { createContext, useContext, useEffect, useState, useCallback } from "react";
import api, { formatError, setAuthTokens, clearAuthTokens } from "@/lib/api";

const AuthContext = createContext(null);

// Paths where we MUST NOT probe /auth/me on mount — these are public pages
// that prospective franchisees / share-link recipients land on without any
// account. Probing /auth/me there returns 401 and (on slow networks) can
// flash a login redirect before the interceptor's path-check fires.
function isPublicPath(pathname) {
  return (
    pathname === "/login"
    || pathname.startsWith("/portal/login")
    || pathname.startsWith("/share/")
  );
}

export function AuthProvider({ children }) {
  // null = checking, false = unauthenticated, object = user
  const [user, setUser] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const { data } = await api.get("/auth/me");
      setUser(data);
      return data;
    } catch (e) {
      setUser(false);
      return null;
    }
  }, []);

  useEffect(() => {
    // Skip the /auth/me probe entirely on public landing pages — there's no
    // user to fetch and the 401 round-trip just creates a redirect flicker
    // for share-link recipients who have never had an account here.
    if (typeof window !== "undefined" && isPublicPath(window.location.pathname)) {
      setUser(false);
      return;
    }
    refresh();
  }, [refresh]);

  const login = async (email, password) => {
    try {
      const { data } = await api.post("/auth/login", { email, password });
      // Persist tokens for cross-site Bearer auth (Chrome blocks
      // cross-site cookies in incognito + increasingly in regular mode).
      setAuthTokens(data);
      setUser(data);
      return { ok: true, user: data };
    } catch (e) {
      return { ok: false, error: formatError(e) };
    }
  };

  const logout = async () => {
    try {
      await api.post("/auth/logout");
    } catch (e) {
      // ignore
    }
    clearAuthTokens();
    setUser(false);
  };

  return (
    <AuthContext.Provider value={{ user, login, logout, refresh }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
