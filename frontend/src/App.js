import "@/App.css";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { AuthProvider } from "@/contexts/AuthContext";
import ProtectedRoute from "@/components/ProtectedRoute";
import Layout from "@/components/Layout";
import LoginPage from "@/pages/LoginPage";
import DashboardPage from "@/pages/DashboardPage";
import AirtableInspectorPage from "@/pages/AirtableInspectorPage";
import MigrationPlanPage from "@/pages/MigrationPlanPage";
import FranchiseesPage from "@/pages/FranchiseesPage";
import FranchiseeDetailPage from "@/pages/FranchiseeDetailPage";
import ContractsPage from "@/pages/ContractsPage";
import ContractRenewalsPage from "@/pages/ContractRenewalsPage";
import FilesPage from "@/pages/FilesPage";
import ContactsPage from "@/pages/ContactsPage";
import FormIntakePage from "@/pages/FormIntakePage";
import PublicFolderSharePage from "@/pages/PublicFolderSharePage";
import PortalLoginPage from "@/pages/PortalLoginPage";
import TerritoryBuilderPage from "@/pages/TerritoryBuilderPage";
import CqcDefinitionsPage from "@/pages/CqcDefinitionsPage";
import CalendarPage from "@/pages/CalendarPage";
import PortalDashboardPage from "@/pages/PortalDashboardPage";
import BankingPage from "@/pages/BankingPage";
// Invoices module (merged from Pay-Paperwork)
import InvoiceList from "@/pages/invoices/InvoiceList";
import CreateInvoice from "@/pages/invoices/CreateInvoice";
import EditInvoice from "@/pages/invoices/EditInvoice";
import InvoiceDetail from "@/pages/invoices/InvoiceDetail";
import InvoiceClients from "@/pages/invoices/InvoiceClients";
import DeletedInvoices from "@/pages/invoices/DeletedInvoices";
import InvoiceSettings from "@/pages/invoices/InvoiceSettings";

export default function App() {
  return (
    <div className="App">
      <AuthProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/portal/login" element={<PortalLoginPage />} />
            <Route path="/portal" element={
              <ProtectedRoute role="franchisee"><PortalDashboardPage /></ProtectedRoute>
            } />
            <Route path="/share/folder/:token" element={<PublicFolderSharePage />} />
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
              <Route path="/calendar" element={<CalendarPage />} />
              <Route path="/contacts" element={<ContactsPage />} />
              <Route path="/form-intake" element={<FormIntakePage />} />
              <Route path="/airtable-inspector" element={<AirtableInspectorPage />} />
              <Route path="/migration-plan" element={<MigrationPlanPage />} />
              {/* Invoices module — merged from the legacy Pay-Paperwork app */}
              <Route path="/invoices" element={<InvoiceList />} />
              <Route path="/invoices/new" element={<CreateInvoice />} />
              <Route path="/invoices/deleted" element={<DeletedInvoices />} />
              <Route path="/invoices/clients" element={<InvoiceClients />} />
              <Route path="/invoices/settings" element={<InvoiceSettings />} />
              <Route path="/invoices/:id" element={<InvoiceDetail />} />
              <Route path="/invoices/:id/edit" element={<EditInvoice />} />
              <Route path="/banking" element={<BankingPage />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </div>
  );
}
