import "@/App.css";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { AuthProvider } from "@/contexts/AuthContext";
import ProtectedRoute from "@/components/ProtectedRoute";
import Layout from "@/components/Layout";
import LoginPage from "@/pages/LoginPage";
import DashboardPage from "@/pages/DashboardPage";
import FranchiseesPage from "@/pages/FranchiseesPage";
import FranchiseeDetailPage from "@/pages/FranchiseeDetailPage";
import ContractsPage from "@/pages/ContractsPage";
import ContractRenewalsPage from "@/pages/ContractRenewalsPage";
import FilesPage from "@/pages/FilesPage";
import ContactsPage from "@/pages/ContactsPage";
import FormIntakePage from "@/pages/FormIntakePage";
import PublicFolderSharePage from "@/pages/PublicFolderSharePage";
import PublicTerritorySharePage from "@/pages/PublicTerritorySharePage";
import PortalLoginPage from "@/pages/PortalLoginPage";
import TerritoryBuilderPage from "@/pages/TerritoryBuilderPage";
import CqcDefinitionsPage from "@/pages/CqcDefinitionsPage";
import CalendarPage from "@/pages/CalendarPage";
import PortalDashboardPage from "@/pages/PortalDashboardPage";
import BankingPage from "@/pages/BankingPage";
import OrdersPage from "@/pages/OrdersPage";
import OrderDetailPage from "@/pages/OrderDetailPage";
import FindClassAdminPage from "@/pages/FindClassAdminPage";
import AdminUsersPage from "@/pages/AdminUsersPage";
import ChangePasswordPage from "@/pages/ChangePasswordPage";
import XeroSettingsPage from "@/pages/XeroSettingsPage";
import OrdersReconciliationPage from "@/pages/OrdersReconciliationPage";
import ScotlandDefinitionsPage from "@/pages/ScotlandDefinitionsPage";
import EmailTemplatesPage from "@/pages/EmailTemplatesPage";
import AnnouncementsPage from "@/pages/AnnouncementsPage";
// Invoices module (merged from Pay-Paperwork)
import InvoiceList from "@/pages/invoices/InvoiceList";
import CreateInvoice from "@/pages/invoices/CreateInvoice";
import EditInvoice from "@/pages/invoices/EditInvoice";
import InvoiceDetail from "@/pages/invoices/InvoiceDetail";
import InvoiceClients from "@/pages/invoices/InvoiceClients";
import DeletedInvoices from "@/pages/invoices/DeletedInvoices";
import InvoiceSettings from "@/pages/invoices/InvoiceSettings";
import InvoicesShell from "@/pages/invoices/InvoicesShell";
import ReconcilePage from "@/pages/invoices/ReconcilePage";
// Portal shell + section pages (refactored from PortalDashboardPage —
// each section is now its own route under /portal/* for a cleaner UX).
import PortalShell from "@/pages/portal/PortalShell";
import PortalDetailsPage from "@/pages/portal/PortalDetailsPage";
import PortalMarketingPage from "@/pages/portal/PortalMarketingPage";
import PortalMarketingSettingsPage from "@/pages/portal/PortalMarketingSettingsPage";
import PortalTrainingPage from "@/pages/portal/PortalTrainingPage";
import PortalPlaylistPage from "@/pages/portal/PortalPlaylistPage";
import PortalBookingsPage from "@/pages/portal/PortalBookingsPage";
import PortalShapeOrdersPage from "@/pages/portal/PortalShapeOrdersPage";
import AdminShapeOrdersPage from "@/pages/AdminShapeOrdersPage";
import PortalChangePasswordPage from "@/pages/portal/PortalChangePasswordPage";
import PortalSubscriptionsPage from "@/pages/portal/PortalSubscriptionsPage";
import AdminYouTubePage from "@/pages/AdminYouTubePage";
import PortalTerritoryPage from "@/pages/portal/PortalTerritoryPage";
import PortalEventsPage from "@/pages/portal/PortalEventsPage";
import PortalFilesPage from "@/pages/portal/PortalFilesPage";
import PortalUpdatesPage from "@/pages/portal/PortalUpdatesPage";
// Portal invoices module — clone of admin Sandra's Invoices, scoped to franchisee.
import PortalInvoicesShell from "@/pages/portal/invoices/PortalInvoicesShell";
import PortalInvoiceList from "@/pages/portal/invoices/PortalInvoiceList";
import PortalInvoiceDetail from "@/pages/portal/invoices/PortalInvoiceDetail";
import CreatePortalInvoice from "@/pages/portal/invoices/CreatePortalInvoice";
import EditPortalInvoice from "@/pages/portal/invoices/EditPortalInvoice";
import PortalInvoiceClients from "@/pages/portal/invoices/PortalInvoiceClients";
import DeletedPortalInvoices from "@/pages/portal/invoices/DeletedPortalInvoices";
import PortalInvoiceSettings from "@/pages/portal/invoices/PortalInvoiceSettings";
import PortalReconcile from "@/pages/portal/invoices/PortalReconcile";

export default function App() {
  return (
    <div className="App">
      <AuthProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/portal/login" element={<PortalLoginPage />} />
            <Route path="/change-password" element={
              <ProtectedRoute><ChangePasswordPage /></ProtectedRoute>
            } />
            <Route path="/portal" element={
              <ProtectedRoute role="franchisee"><PortalShell /></ProtectedRoute>
            }>
              <Route index element={<PortalDetailsPage />} />
              <Route path="details" element={<PortalDetailsPage />} />
              <Route path="territory" element={<PortalTerritoryPage />} />
              <Route path="territory/basic" element={<PortalTerritoryPage forceBasic={true} />} />
              <Route path="events" element={<PortalEventsPage />} />
              <Route path="marketing" element={<PortalMarketingPage />} />
              <Route path="marketing/settings" element={<PortalMarketingSettingsPage />} />
              <Route path="training" element={<PortalTrainingPage />} />
              <Route path="training/:playlistId" element={<PortalPlaylistPage />} />
              <Route path="bookings" element={<PortalBookingsPage />} />
              <Route path="shape-orders" element={<PortalShapeOrdersPage />} />
              <Route path="account/password" element={<PortalChangePasswordPage />} />
              <Route path="account/subscriptions" element={<PortalSubscriptionsPage />} />
              <Route path="files" element={<PortalFilesPage />} />
              <Route path="updates" element={<PortalUpdatesPage />} />
              <Route path="invoices" element={<PortalInvoicesShell />}>
                <Route index element={<PortalInvoiceList />} />
                <Route path="reconcile" element={<PortalReconcile />} />
                <Route path="new" element={<CreatePortalInvoice />} />
                <Route path="deleted" element={<DeletedPortalInvoices />} />
                <Route path="clients" element={<PortalInvoiceClients />} />
                <Route path="settings" element={<PortalInvoiceSettings />} />
                <Route path=":id" element={<PortalInvoiceDetail />} />
                <Route path=":id/edit" element={<EditPortalInvoice />} />
              </Route>
            </Route>
            <Route path="/share/folder/:token" element={<PublicFolderSharePage />} />
            <Route path="/share/territory/:token" element={<PublicTerritorySharePage />} />
            <Route
              element={
                <ProtectedRoute role="admin">
                  <Layout />
                </ProtectedRoute>
              }
            >
              <Route path="/" element={<DashboardPage />} />
              <Route path="/franchisees" element={<FranchiseesPage />} />
              <Route path="/franchisees/:id" element={<FranchiseeDetailPage />} />
              <Route path="/contracts" element={<ContractsPage />} />
              <Route path="/renewals" element={<ContractRenewalsPage />} />
              <Route path="/files" element={<FilesPage />} />
              <Route path="/territory-builder" element={<TerritoryBuilderPage />} />
              <Route path="/cqc-definitions" element={<CqcDefinitionsPage />} />
              <Route path="/scotland-definitions" element={<ScotlandDefinitionsPage />} />
              <Route path="/admin/email-templates" element={<EmailTemplatesPage />} />
              <Route path="/admin/announcements" element={<AnnouncementsPage />} />
              <Route path="/admin/youtube" element={<AdminYouTubePage />} />
              <Route path="/calendar" element={<CalendarPage />} />
              <Route path="/contacts" element={<ContactsPage />} />
              <Route path="/form-intake" element={<FormIntakePage />} />
              {/* Invoices module — merged from the legacy Pay-Paperwork app */}
              <Route path="/invoices" element={<InvoicesShell />}>
                <Route index element={<InvoiceList />} />
                <Route path="reconcile" element={<ReconcilePage />} />
                <Route path="new" element={<CreateInvoice />} />
                <Route path="deleted" element={<DeletedInvoices />} />
                <Route path="clients" element={<InvoiceClients />} />
                <Route path="settings" element={<InvoiceSettings />} />
                <Route path=":id" element={<InvoiceDetail />} />
                <Route path=":id/edit" element={<EditInvoice />} />
              </Route>
              <Route path="/banking" element={<BankingPage />} />
              <Route path="/orders" element={<OrdersPage />} />
              <Route path="/orders/reconcile" element={<OrdersReconciliationPage />} />
              <Route path="/orders/:orderId" element={<OrderDetailPage />} />
              <Route path="/find-class" element={<FindClassAdminPage />} />
              <Route path="/admin/users" element={<AdminUsersPage />} />
              <Route path="/admin/shape-orders" element={<AdminShapeOrdersPage />} />
              <Route path="/admin/password-resets" element={<AdminUsersPage />} />
              <Route path="/admin/xero" element={<XeroSettingsPage />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </div>
  );
}
