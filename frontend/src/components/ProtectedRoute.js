import { Navigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";

export default function ProtectedRoute({ children, role }) {
  const { user } = useAuth();
  if (user === null) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#F9F9F8]" data-testid="auth-loading">
        <div className="text-stone-500 text-sm font-mono uppercase tracking-widest">Loading…</div>
      </div>
    );
  }
  if (!user) {
    // Franchisee portal routes send unauth'd users to /portal/login,
    // admin routes send them to /login.
    return <Navigate to={role === "franchisee" ? "/portal/login" : "/login"} replace />;
  }
  // Role gate: if a non-matching user lands here, bounce them to their
  // own home. (e.g. franchisee trying to load /files)
  if (role && user.role !== role) {
    return <Navigate to={user.role === "franchisee" ? "/portal" : "/"} replace />;
  }
  return children;
}
