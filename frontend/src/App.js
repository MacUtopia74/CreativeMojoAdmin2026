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
import PortalDashboardPage from "@/pages/PortalDashboardPage";

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
              <Route path="/contacts" element={<ContactsPage />} />
              <Route path="/form-intake" element={<FormIntakePage />} />
              <Route path="/airtable-inspector" element={<AirtableInspectorPage />} />
              <Route path="/migration-plan" element={<MigrationPlanPage />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </div>
  );
}
