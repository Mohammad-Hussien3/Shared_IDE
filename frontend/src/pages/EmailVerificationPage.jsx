import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { Mail, LoaderCircle } from "lucide-react";
import { useAuth } from "../auth/context";
import { getErrorMessage } from "../lib/errors";
import { useTheme } from "../lib/useTheme";

function EmailCard({ children }) {
  const [theme] = useTheme();
  return <main className={`ide-shell account-shell theme-${theme}`}>
    <section className="auth-card email-card"><span className="brand-mark"><Mail size={25} /></span>{children}</section>
  </main>;
}

export function CheckEmailPage() {
  const { client } = useAuth();
  const location = useLocation();
  const [email, setEmail] = useState(location.state?.email || '');
  const [seconds, setSeconds] = useState(location.state?.justRegistered ? 60 : 0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);
  const busy = useRef(false);
  useEffect(() => {
    if (!seconds) return;
    const timer = setTimeout(() => setSeconds(value => Math.max(0, value - 1)), 1000);
    return () => clearTimeout(timer);
  }, [seconds]);
  const resend = async event => {
    event.preventDefault();
    if (busy.current || seconds) return;
    busy.current = true;
    setPending(true);
    setError('');
    setSent(false);
    try {
      await client.resendVerification(email.trim());
      setSent(true);
      setSeconds(60);
    } catch (err) {
      setError(getErrorMessage(err));
      if (err.status === 429) setSeconds(60);
    } finally {
      busy.current = false;
      setPending(false);
    }
  };
  return <EmailCard>
    <h1>Check your email</h1>
    <p>Verify your email address before signing in. Open the verification link in your inbox; it expires in 30 minutes. Check your spam folder too.</p>
    <form className="email-resend-form" onSubmit={resend}>
      <label className="field-label">Email address
        <input type="email" autoComplete="email" required maxLength={254} value={email} disabled={pending} onChange={event => setEmail(event.target.value)} />
      </label>
      <button className="button" disabled={pending || seconds > 0 || !email.trim()}>
        {pending ? 'Sending…' : seconds > 0 ? `Resend in ${seconds}s` : 'Resend verification email'}
      </button>
    </form>
    {sent && <p role="status">If this address needs verification, a verification email will be sent. Check your inbox and spam folder.</p>}
    {error && <div className="inline-error" role="alert">{error}</div>}
    <Link to="/login">Go to Login</Link>
  </EmailCard>;
}

export function VerifyEmailPage() {
  const { client } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [token] = useState(() => new URLSearchParams(location.hash.slice(1)).get('token') || '');
  const [result, setResult] = useState(null);
  const request = useRef(null);
  useEffect(() => {
    let active = true;
    // Remove the bearer secret from browser history; retain only this request in
    // memory. Reuse it through StrictMode effect replay, never consume twice.
    if (location.hash) navigate('/verify-email', { replace: true });
    if (!request.current) {
      request.current = /^[A-Za-z0-9_-]{43}$/.test(token)
        ? client.verifyEmail(token)
        : Promise.reject({ code: 'verification_invalid' });
    }
    request.current.then(
      () => { if (active) setResult({ code: 'email_verified' }); },
      error => { if (active) setResult({ code: error.code, message: getErrorMessage(error) }); },
    );
    return () => { active = false; };
  }, [client, token, navigate, location.hash]);
  const headings = {
    email_verified: 'Email verified', verification_expired: 'Link expired',
    verification_used: 'Link already used', verification_invalid: 'Invalid link',
  };
  return <EmailCard>
    <h1>{result ? headings[result.code] || 'Could not verify email' : 'Verifying your email'}</h1>
    {!result && <p role="status"><LoaderCircle size={16} className="spin" /> Verifying your email…</p>}
    {result?.code === 'email_verified' && <p role="status">Your email is verified. You can now sign in to Shared IDE.</p>}
    {result?.message && <div className="inline-error" role="alert">{result.message}</div>}
    {result && <Link className="button button-primary" to="/login">Go to Login</Link>}
    {result && result.code !== 'email_verified' && <Link to="/check-email">Request a new verification email</Link>}
  </EmailCard>;
}
