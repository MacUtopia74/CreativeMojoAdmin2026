// Shared shell for the /invoices/* section. Adds the secondary tab strip
// the user is used to (Invoices · Clients · Deleted · Settings) plus a
// prominent "+ New Invoice" CTA. Styled to match the host admin's stone
// palette so it feels native rather than like an embedded app.
import { Outlet, NavLink, useNavigate, useLocation } from "react-router-dom";
import {
  Receipt,
  Users as UsersIcon,
  Trash2,
  Settings as SettingsIcon,
  Plus,
} from "lucide-react";

const TABS = [
  { to: "/invoices", label: "Invoices", icon: Receipt, end: true, testid: "inv-tab-list" },
  { to: "/invoices/clients", label: "Clients", icon: UsersIcon, testid: "inv-tab-clients" },
  { to: "/invoices/deleted", label: "Deleted", icon: Trash2, testid: "inv-tab-deleted" },
  { to: "/invoices/settings", label: "Settings", icon: SettingsIcon, testid: "inv-tab-settings" },
];

export default function InvoicesShell() {
  const navigate = useNavigate();
  const location = useLocation();
  // Hide the "+ New Invoice" CTA on pages where it doesn't make sense
  // (the editor itself, the detail view, AND the list view because the
  // list page renders its own copy in the page header). The Clients,
  // Deleted and Settings sub-pages still benefit from the shell's CTA.
  const showNewInvoice = ![
    /^\/invoices$/,
    /^\/invoices\/new$/,
    /^\/invoices\/[^/]+(\/edit)?$/,
  ].some((re) => re.test(location.pathname));

  return (
    <div className="space-y-6" data-testid="invoices-shell">
      <div className="flex items-center gap-3 flex-wrap border-b border-stone-200 pb-3">
        <div className="flex items-center gap-1 flex-wrap" data-testid="invoices-tabs">
          {TABS.map(({ to, label, icon: Icon, end, testid }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              data-testid={testid}
              className={({ isActive }) =>
                `inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
                  isActive
                    ? "bg-blue-50 text-blue-700 ring-1 ring-blue-200"
                    : "text-stone-600 hover:bg-stone-100"
                }`
              }
            >
              <Icon className="w-4 h-4" />
              {label}
            </NavLink>
          ))}
        </div>
        {showNewInvoice && (
          <button
            onClick={() => navigate("/invoices/new")}
            data-testid="inv-new-cta"
            className="ml-auto inline-flex items-center gap-1.5 px-5 py-2.5 text-sm font-semibold bg-blue-600 hover:bg-blue-700 text-white rounded-full shadow-sm transition"
          >
            <Plus className="w-4 h-4" />
            New Invoice
          </button>
        )}
      </div>
      <Outlet />
    </div>
  );
}
