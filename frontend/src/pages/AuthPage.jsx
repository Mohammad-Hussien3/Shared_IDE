import { useTheme } from "../lib/useTheme";
import { useRef, useState } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import { Code2, LoaderCircle } from "lucide-react";
import { useAuth } from "../auth/context";
import { ThemeButton } from "../components/AccountControls";
import { getErrorMessage } from "../lib/errors";
import GoogleButton from "../components/GoogleButton";
import { navigateToProvider } from "../lib/navigation";

export default function AuthPage({ register = false }) {
  const navigate = useNavigate();
  const location = useLocation();
  const {
    user,
    client,
    error: sessionError,
    setError: setSessionError,
  } = useAuth();
  const [theme, toggleTheme] = useTheme();
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
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
        ...(register ? { email: email.trim(), confirm_password: confirmation } : {}),
      });
      if (register) navigate('/check-email', { replace: true, state: { email: email.trim(), justRegistered: true } });
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
    <main className={`ide-shell account-shell auth-entry-shell theme-${theme}`}>
      <div className="account-topbar">
        <span className="brand">
          <Code2 size={20} /> Workspace
        </span>
        <ThemeButton theme={theme} onClick={toggleTheme} />
      </div>
      <div className="auth-entry-content">
        <form className="auth-card auth-entry-card" onSubmit={submit} aria-labelledby="auth-title">
          <header className="auth-entry-heading">
            <span className="brand-mark" aria-hidden="true">
              <Code2 size={25} />
            </span>
            <h1 id="auth-title">{register ? "Create your account" : "Welcome back"}</h1>
            <p>
              {register
                ? "Give your next idea a home. Your workspace awaits."
                : "Your ideas are right where you left them. Let’s get back to building."}
            </p>
          </header>
          {!register && location.state?.passwordReset === true && (
            <p role="status">Your password has been reset. Sign in with your new password.</p>
          )}
          <label className="field-label">
            Username
            <input
              autoComplete="username"
              required
              maxLength={register ? 150 : 254}
              placeholder={register ? undefined : "Username or email address"}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              disabled={pending || googlePending}
            />
          </label>
          {register && (
            <label className="field-label">Email address
              <input type="email" autoComplete="email" required maxLength={254} value={email}
                onChange={event => setEmail(event.target.value)} disabled={pending || googlePending} />
            </label>
          )}
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
          {!register && <Link to="/forgot-password">Forgot password?</Link>}
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
          <button type="submit" className="button button-primary" disabled={pending || googlePending} aria-busy={pending}>
            {pending && <LoaderCircle size={15} className="spin" />}
            {pending ? "Please wait…" : register ? "Create account" : "Log in"}
          </button>
          <div className="auth-divider">or continue with</div>
          <GoogleButton onClick={startGoogle} disabled={pending || googlePending} pending={googlePending} />
          <p className="auth-entry-footer">
            {register ? "Already have an account? " : "New here? "}
            <Link to={register ? "/login" : "/register"}>
              {register ? "Log in" : "Create an account"}
            </Link>
          </p>
        </form>
      </div>
    </main>
  );
}
