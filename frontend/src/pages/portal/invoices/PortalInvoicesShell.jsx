// Portal-side invoicing shell. Mirrors the look of the admin Invoices
// shell but mounts inside the franchisee PortalShell, so it inherits the
// brand bar / sidebar already supplied by the parent route. The whole
// section is scoped to /portal/invoices/* and every API call inside the
// child pages hits the franchisee-scoped /api/portal/invoices/* router.
import { Outlet, NavLink, useNavigate } from "react-router-dom";
import {
  Receipt,
  Users as UsersIcon,
  Trash2,
  Settings as SettingsIcon,
  Plus,
  Link2,
} from "lucide-react";

const TABS = [
  { to: "/portal/invoices", label: "Invoices", icon: Receipt, end: true, testid: "portal-inv-tab-list" },
  { to: "/portal/invoices/reconcile", label: "Reconcile", icon: Link2, testid: "portal-inv-tab-reconcile" },
  { to: "/portal/invoices/clients", label: "Clients", icon: UsersIcon, testid: "portal-inv-tab-clients" },
  { to: "/portal/invoices/deleted", label: "Deleted", icon: Trash2, testid: "portal-inv-tab-deleted" },
  { to: "/portal/invoices/settings", label: "Settings", icon: SettingsIcon, testid: "portal-inv-tab-settings" },
];

export default function PortalInvoicesShell() {
  const navigate = useNavigate();

  return (
    <div data-testid="portal-invoices-shell">
      {/* Tabs strip — sits inside PortalShell which already has its own
          sticky header, so this stays inline. */}
      <div className="bg-white border border-stone-200 rounded-2xl px-4 sm:px-6 py-3 mb-5">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-1 flex-wrap mr-auto" data-testid="portal-invoices-tabs">
            {TABS.map(({ to, label, icon: Icon, end, testid }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                data-testid={testid}
                className={({ isActive }) =>
                  `inline-flex items-center gap-2 px-3.5 py-2 text-sm font-medium rounded-lg transition-colors ${
                    isActive
                      ? "bg-blue-50 text-blue-700 ring-1 ring-blue-200"
                      : "text-slate-600 hover:bg-stone-100"
                  }`
                }
              >
                <Icon className="w-4 h-4" />
                {label}
              </NavLink>
            ))}
          </div>
          <button
            onClick={() => navigate("/portal/invoices/new")}
            data-testid="portal-inv-new-cta"
            className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-semibold bg-blue-600 hover:bg-blue-700 text-white rounded-full shadow-sm transition shrink-0"
          >
            <Plus className="w-4 h-4" />
            New Invoice
          </button>
        </div>
      </div>

      <Outlet />
    </div>
  );
}
