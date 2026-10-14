import WorkspacePage from "./pages/WorkspacePage.jsx";
import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
  useParams,
} from "react-router-dom";
import { AuthProvider } from "./auth/AuthContext";
import { useAuth } from "./auth/context";
import AuthPage from "./pages/AuthPage";
import WorkspaceDashboard from "./pages/WorkspaceDashboard";
import GoogleCallbackPage from "./pages/GoogleCallbackPage";
import "./App.css";
import "./accounts.css";

function Protected({ children }) {
  const { user } = useAuth();
  return user ? children : <Navigate to="/login" replace />;
}

function WorkspaceRoute() {
  const { workspaceId } = useParams();
  const { user } = useAuth();
  // Remounting isolates drafts, requests, Monaco models, and terminal sessions.
  return (
    <WorkspacePage
      key={`${user.id}:${workspaceId}`}
      workspaceId={workspaceId}
    />
  );
}

export function AppRoutes() {
  const { loading, user } = useAuth();
  if (loading)
    return (
      <main className="ide-shell account-shell theme-dark">
        <div className="dashboard-empty" role="status">
          Restoring your session…
        </div>
      </main>
    );
  return (
    <Routes>
      <Route path="/auth/google/callback" element={<GoogleCallbackPage />} />
      <Route path="/login" element={<AuthPage key="login" />} />
      <Route path="/register" element={<AuthPage key="register" register />} />
      <Route
        path="/workspaces"
        element={
          <Protected>
            <WorkspaceDashboard key={user?.id} />
          </Protected>
        }
      />
      <Route
        path="/workspaces/:workspaceId"
        element={
          <Protected>
            <WorkspaceRoute />
          </Protected>
        }
      />
      <Route path="*" element={<Navigate to="/workspaces" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </BrowserRouter>
  );
}
