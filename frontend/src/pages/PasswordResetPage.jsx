import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { KeyRound, LoaderCircle } from "lucide-react";
import { useAuth } from "../auth/context";
import PasswordField from "../components/PasswordField";
import { getErrorMessage } from "../lib/errors";
import { useTheme } from "../lib/useTheme";

function ResetCard({ children }) {
  const [theme] = useTheme();
  return <main className={`ide-shell account-shell auth-entry-shell theme-${theme}`}>
    <div className="auth-entry-content"><section className="auth-card auth-entry-card email-card">
      <span className="brand-mark" aria-hidden="true"><KeyRound size={25} /></span>
      {children}
      <Link to="/login">Back to Sign In</Link>
    </section></div>
  </main>;
}

export function ForgotPasswordPage() {
  const { client } = useAuth();
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const busy = useRef(false);
  const submit = async event => {
    event.preventDefault();
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError("");
    setSent(false);
    try {
      await client.requestPasswordReset(email.trim());
      setSent(true);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      busy.current = false;
      setPending(false);
    }
  };
  return <ResetCard>
    <h1>Forgot password?</h1>
    <p>Enter your account’s email address. We’ll send you a link to choose a new password.</p>
    <form className="email-resend-form" onSubmit={submit}>
      <label className="field-label">Email address
        <input type="email" autoComplete="email" required maxLength={254} value={email}
          onChange={event => setEmail(event.target.value)} disabled={pending} />
      </label>
      <button className="button button-primary" disabled={pending} aria-busy={pending}>
        {pending && <LoaderCircle size={15} className="spin" />}{pending ? "Sending…" : "Send Reset Link"}
      </button>
    </form>
    {sent && <p role="status">If an account exists with this email, we've sent a password reset link. Check your inbox and spam folder. The link expires in 30 minutes.</p>}
    {error && <p className="inline-error" role="alert">{error}</p>}
  </ResetCard>;
}

export function ResetPasswordPage() {
  const { client } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [token] = useState(() => new URLSearchParams(location.hash.slice(1)).get("token") || "");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [code, setCode] = useState(/^[A-Za-z0-9_-]{43}$/.test(token) ? "" : "reset_invalid");
  const busy = useRef(false);
  useEffect(() => {
    // Keep the secret only in component memory, never history or storage.
    if (location.hash || location.search) navigate('/reset-password', { replace: true });
  }, [navigate, location.hash, location.search]);
  const submit = async event => {
    event.preventDefault();
    if (busy.current || code) return;
    if (password !== confirmation) {
      setError("Passwords do not match.");
      return;
    }
    busy.current = true;
    setPending(true);
    setError("");
    try {
      await client.confirmPasswordReset({ token, password, confirm_password: confirmation });
      setPassword("");
      setConfirmation("");
      navigate('/login', { replace: true, state: { passwordReset: true } });
    } catch (err) {
      if (["reset_invalid", "reset_expired", "reset_used"].includes(err.code)) setCode(err.code);
      else setError(getErrorMessage(err));
    } finally {
      busy.current = false;
      setPending(false);
    }
  };
  const headings = { reset_invalid: "Invalid reset link", reset_expired: "Reset link expired", reset_used: "Reset link already used" };
  return <ResetCard>
    <h1>{headings[code] || "Reset your password"}</h1>
    {code ? <>
      <p className="inline-error" role="alert">{getErrorMessage({ code })}</p>
      <Link to="/forgot-password">Request a new reset link</Link>
    </> : <>
      <p>Choose a new password for your account. Existing sessions will be signed out.</p>
      <form className="email-resend-form" onSubmit={submit}>
        <PasswordField label="New password" value={password} onChange={setPassword} disabled={pending} />
        <PasswordField label="Confirm new password" value={confirmation} onChange={setConfirmation} disabled={pending} />
        <p className="auth-hint">Use at least 8 characters. Avoid common passwords and personal information.</p>
        <button className="button button-primary" disabled={pending} aria-busy={pending}>
          {pending && <LoaderCircle size={15} className="spin" />}{pending ? "Resetting…" : "Reset Password"}
        </button>
      </form>
    </>}
    {error && <p className="inline-error" role="alert">{error}</p>}
  </ResetCard>;
}
