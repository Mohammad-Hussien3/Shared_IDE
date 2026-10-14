import { Link, Navigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../auth/context";
import { GOOGLE_MESSAGES, ERROR_MESSAGES } from "../lib/errors";
import { useTheme } from "../lib/useTheme";

export default function GoogleCallbackPage() {
  // AuthProvider restores the HttpOnly refresh cookie before rendering routes.
  const { user, error } = useAuth();
  const [params] = useSearchParams();
  const [theme] = useTheme();
  const result = params.get("result");
  if (["google_success", "google_linked"].includes(result) && user) {
    return <Navigate to="/workspaces" replace state={{ googleLinked: result === "google_linked" }} />;
  }
  const message = Object.hasOwn(GOOGLE_MESSAGES, result || "")
    ? GOOGLE_MESSAGES[result] : error || (result === "google_success" ? ERROR_MESSAGES.session : GOOGLE_MESSAGES.google_failed);
  return (
    <main className={`ide-shell account-shell theme-${theme}`}>
      <section className="auth-card">
        <h1>Google sign-in</h1>
        <div className="inline-error" role="alert">{message}</div>
        <Link to={user ? "/workspaces" : "/login"} replace>{user ? "Return to workspaces" : "Return to sign in"}</Link>
      </section>
    </main>
  );
}
