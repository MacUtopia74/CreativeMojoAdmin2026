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
import ContactsPage from "@/pages/ContactsPage";

export default function App() {
  return (
    <div className="App">
      <AuthProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route
              element={
                <ProtectedRoute>
                  <Layout />
                </ProtectedRoute>
              }
            >
              <Route path="/" element={<DashboardPage />} />
              <Route path="/franchisees" element={<FranchiseesPage />} />
              <Route path="/franchisees/:id" element={<FranchiseeDetailPage />} />
              <Route path="/contracts" element={<ContractsPage />} />
              <Route path="/contacts" element={<ContactsPage />} />
              <Route path="/airtable-inspector" element={<AirtableInspectorPage />} />
              <Route path="/migration-plan" element={<MigrationPlanPage />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </div>
  );
}
