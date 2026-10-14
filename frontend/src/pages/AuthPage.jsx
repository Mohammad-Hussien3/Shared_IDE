import { useTheme } from "../lib/useTheme";
import { useRef, useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { Code2, LoaderCircle } from "lucide-react";
import { useAuth } from "../auth/context";
import { ThemeButton } from "../components/AccountControls";
import { getErrorMessage } from "../lib/errors";
import GoogleButton from "../components/GoogleButton";
import { navigateToProvider } from "../lib/navigation";

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
  const [googlePending, setGooglePending] = useState(false);
  const googleInProgress = useRef(false);
  const [error, setError] = useState("");
  if (user) return <Navigate to="/workspaces" replace />;
  const submit = async (event) => {
    event.preventDefault();
    if (pending || googleInProgress.current) return;
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
      setError(getErrorMessage(err, register ? "register" : "login"));
    } finally {
      setPending(false);
    }
  };
  const startGoogle = async () => {
    if (pending || googleInProgress.current) return;
    googleInProgress.current = true;
    setGooglePending(true);
    setError("");
    setSessionError("");
    try {
      navigateToProvider(await client.startGoogle());
    } catch (err) {
      setError(getErrorMessage(err));
      googleInProgress.current = false;
      setGooglePending(false);
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
        <GoogleButton onClick={startGoogle} disabled={pending || googlePending} pending={googlePending} />
        <div className="auth-divider">or use your password</div>
        <label className="field-label">
          Username
          <input
            autoComplete="username"
            required
            maxLength={150}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            disabled={pending || googlePending}
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
            disabled={pending || googlePending}
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
              disabled={pending || googlePending}
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
        <button className="button button-primary" disabled={pending || googlePending}>
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
