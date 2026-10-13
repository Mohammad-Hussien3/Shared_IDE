import { useTheme } from "../lib/useTheme";
import { useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { Code2, LoaderCircle } from "lucide-react";
import { useAuth } from "../auth/context";
import { ThemeButton } from "../components/AccountControls";

export default function AuthPage({ register = false }) {
  const {
    user,
    client,
    error: sessionError,
    setError: setSessionError,
  } = useAuth();
  const [theme, toggleTheme] = useTheme();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  if (user) return <Navigate to="/workspaces" replace />;
  const submit = async (event) => {
    event.preventDefault();
    if (pending) return;
    if (register && password !== confirmation) {
      setError("Passwords do not match.");
      return;
    }
    setPending(true);
    setError("");
    setSessionError("");
    try {
      await client.authenticate(register ? "register" : "login", {
        username: username.trim(),
        password,
        ...(register ? { confirm_password: confirmation } : {}),
      });
    } catch (err) {
      setError(err.message);
    } finally {
      setPending(false);
    }
  };
  return (
    <main className={`ide-shell account-shell theme-${theme}`}>
      <div className="account-topbar">
        <span className="brand">
          <Code2 size={20} /> Workspace
        </span>
        <ThemeButton theme={theme} onClick={toggleTheme} />
      </div>
      <form className="auth-card" onSubmit={submit}>
        <span className="brand-mark">
          <Code2 size={25} />
        </span>
        <h1>{register ? "Create your account" : "Welcome back"}</h1>
        <p>
          {register
            ? "A private space for your code and ideas."
            : "Sign in to your workspaces."}
        </p>
        <label className="field-label">
          Username
          <input
            autoComplete="username"
            required
            maxLength={150}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            disabled={pending}
          />
        </label>
        <label className="field-label">
          Password
          <input
            type="password"
            autoComplete={register ? "new-password" : "current-password"}
            required
            maxLength={128}
            minLength={register ? 8 : undefined}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={pending}
          />
        </label>
        {register && (
          <label className="field-label">
            Confirm password
            <input
              type="password"
              autoComplete="new-password"
              required
              maxLength={128}
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
              disabled={pending}
            />
          </label>
        )}
        {register && (
          <p className="auth-hint">
            Use at least 8 characters. Avoid common passwords and personal
            information.
          </p>
        )}
        {(error || sessionError) && (
          <div className="inline-error" role="alert">
            {error || sessionError}
          </div>
        )}
        <button className="button button-primary" disabled={pending}>
          {pending && <LoaderCircle size={15} className="spin" />}
          {pending ? "Please wait…" : register ? "Create account" : "Log in"}
        </button>
        <p>
          {register ? "Already have an account? " : "New here? "}
          <Link to={register ? "/login" : "/register"}>
            {register ? "Log in" : "Create an account"}
          </Link>
        </p>
      </form>
    </main>
  );
}
