import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import Logo from "@/components/Logo";
import {
  LayoutDashboard,
  Users,
  Contact,
  Database,
  ClipboardList,
  Inbox,
  BellRing,
  FolderOpen,
  Target,
  LogOut,
} from "lucide-react";

const NAV = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard, testid: "nav-dashboard" },
  { to: "/franchisees", label: "Franchisees", icon: Users, testid: "nav-franchisees" },
  { to: "/renewals", label: "Renewals", icon: BellRing, testid: "nav-renewals" },
  { to: "/files", label: "Files", icon: FolderOpen, testid: "nav-files" },
  { to: "/contacts", label: "Sales & Contacts", icon: Contact, testid: "nav-contacts" },
  { to: "/territory-builder", label: "Territory Builder", icon: Target, testid: "nav-territory-builder" },
  { to: "/form-intake", label: "Form Intake", icon: Inbox, testid: "nav-form-intake" },
  { to: "/airtable-inspector", label: "Airtable Inspector", icon: Database, testid: "nav-airtable-inspector" },
  { to: "/migration-plan", label: "Migration Plan", icon: ClipboardList, testid: "nav-migration-plan" },
];

export default function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const handleLogout = async () => {
    await logout();
    navigate("/login");
  };

  return (
    <div className="min-h-screen flex bg-[#F9F9F8]">
      {/* Sidebar */}
      <aside className="w-[260px] shrink-0 bg-[#F2F2F0] border-r border-stone-200 flex flex-col" data-testid="sidebar">
        <div className="px-5 py-5 border-b border-stone-200 bg-white flex flex-col items-start gap-1.5">
          <Logo className="h-16" />
          <div className="text-[10px] uppercase tracking-[0.2em] text-stone-500 font-bold pl-1">Admin Console</div>
        </div>

        <nav className="flex-1 py-4">
          {NAV.map(({ to, label, icon: Icon, testid }) => (
            <NavLink
              key={to}
              to={to}
              end={to === "/"}
              data-testid={testid}
              className={({ isActive }) =>
                `flex items-center gap-3 px-6 py-2.5 text-sm font-semibold transition-colors duration-150 border-l-2 ${
                  isActive
                    ? "bg-white text-stone-950 border-l-[#D4FF00]"
                    : "text-stone-600 hover:text-stone-950 border-l-transparent hover:bg-white/50"
                }`
              }
            >
              <Icon className="w-4 h-4" strokeWidth={2} />
              {label}
            </NavLink>
          ))}
        </nav>

        <div className="p-4 border-t border-stone-200 space-y-3">
          <div className="px-2">
            <div className="text-[10px] uppercase tracking-[0.2em] text-stone-500 font-bold">Signed in as</div>
            <div className="text-sm font-semibold text-stone-900 mt-0.5 truncate" data-testid="current-user-name">{user?.name}</div>
            <div className="text-xs text-stone-500 truncate" data-testid="current-user-email">{user?.email}</div>
          </div>
          <button
            onClick={handleLogout}
            data-testid="logout-button"
            className="w-full flex items-center justify-center gap-2 px-4 py-2 text-xs font-bold uppercase tracking-wider border border-stone-300 bg-white text-stone-900 hover:bg-stone-50 transition-colors rounded-lg"
          >
            <LogOut className="w-3.5 h-3.5" /> Logout
          </button>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 min-w-0">
        <Outlet />
      </main>
    </div>
  );
}
