import "@/App.css";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { AuthProvider } from "@/contexts/AuthContext";
import ProtectedRoute from "@/components/ProtectedRoute";
import Layout from "@/components/Layout";
import LoginPage from "@/pages/LoginPage";
import DashboardPage from "@/pages/DashboardPage";
import AirtableInspectorPage from "@/pages/AirtableInspectorPage";
import PlaceholderPage from "@/pages/PlaceholderPage";

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
              <Route path="/airtable-inspector" element={<AirtableInspectorPage />} />
              <Route
                path="/franchisees"
                element={
                  <PlaceholderPage
                    title="Franchisees"
                    subtitle="Franchisees Directory"
                    description="Once schema decisions are agreed in the Airtable Inspector, your 88 franchisees will be migrated here with full detail pages mirroring your current Airtable layout — photo, contact details, address, status, contract number and linked contracts."
                  />
                }
              />
              <Route
                path="/contracts"
                element={
                  <PlaceholderPage
                    title="Contracts"
                    subtitle="Contract Records"
                    description="All 134 contracts from Airtable will be migrated here once we agree the schema. Each will link back to its associated franchisee."
                  />
                }
              />
              <Route
                path="/contacts"
                element={
                  <PlaceholderPage
                    title="Contacts"
                    subtitle="Unified Contact Records"
                    description="After the schema walkthrough we'll merge the legacy Contacts table (5,958), the active Web Form - Contact table (1,674), and live submissions from the three Gravity Forms — deduplicated and tagged by source."
                  />
                }
              />
            </Route>
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </div>
  );
}
