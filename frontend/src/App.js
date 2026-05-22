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
              <ProtectedRoute role="franchisee"><PortalDashboardPage /></ProtectedRoute>
            } />
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
              <Route path="/admin/password-resets" element={<AdminUsersPage />} />
              <Route path="/admin/xero" element={<XeroSettingsPage />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </div>
  );
}
