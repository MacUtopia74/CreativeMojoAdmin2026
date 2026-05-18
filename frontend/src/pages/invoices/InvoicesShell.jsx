// Shared shell for the /invoices/* section — visually matches the original
// standalone "Sandra's Invoices" app the user knows. Renders the brand on
// the left, the secondary tabs in the centre, and a prominent blue
// "+ New Invoice" CTA on the right, with proper horizontal padding so the
// whole section feels like a self-contained card inside the admin shell.
import { Outlet, NavLink, useNavigate } from "react-router-dom";
import {
  FileText,
  Receipt,
  Users as UsersIcon,
  Trash2,
  Settings as SettingsIcon,
  Plus,
  Link2,
} from "lucide-react";

const TABS = [
  { to: "/invoices", label: "Invoices", icon: Receipt, end: true, testid: "inv-tab-list" },
  { to: "/invoices/reconcile", label: "Reconcile", icon: Link2, testid: "inv-tab-reconcile" },
  { to: "/invoices/clients", label: "Clients", icon: UsersIcon, testid: "inv-tab-clients" },
  { to: "/invoices/deleted", label: "Deleted", icon: Trash2, testid: "inv-tab-deleted" },
  { to: "/invoices/settings", label: "Settings", icon: SettingsIcon, testid: "inv-tab-settings" },
];

export default function InvoicesShell() {
  const navigate = useNavigate();

  return (
    <div data-testid="invoices-shell">
      {/* Top bar — Sandra's Invoices brand · tabs · New Invoice CTA */}
      <div className="bg-white border-b border-stone-200 px-8 py-4 sticky top-0 z-20">
        <div className="flex items-center gap-6 flex-wrap">
          {/* Brand */}
          <div className="flex items-center gap-2.5 shrink-0">
            <div className="w-9 h-9 rounded-lg bg-blue-600 flex items-center justify-center shadow-sm">
              <FileText className="w-5 h-5 text-white" strokeWidth={2.25} />
            </div>
            <span className="font-bold text-lg text-slate-900 whitespace-nowrap">
              Sandra's Invoices
            </span>
          </div>
          {/* Tabs */}
          <div className="flex items-center gap-1 flex-wrap mx-auto" data-testid="invoices-tabs">
            {TABS.map(({ to, label, icon: Icon, end, testid }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                data-testid={testid}
                className={({ isActive }) =>
                  `inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium rounded-lg transition-colors ${
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
          {/* CTA */}
          <button
            onClick={() => navigate("/invoices/new")}
            data-testid="inv-new-cta"
            className="inline-flex items-center gap-1.5 px-5 py-2.5 text-sm font-semibold bg-blue-600 hover:bg-blue-700 text-white rounded-full shadow-sm transition shrink-0"
          >
            <Plus className="w-4 h-4" />
            New Invoice
          </button>
        </div>
      </div>

      {/* Page content with proper inset padding so the layout breathes */}
      <div className="px-8 py-8">
        <Outlet />
      </div>
    </div>
  );
}
