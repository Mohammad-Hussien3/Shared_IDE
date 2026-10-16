import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, Check, LoaderCircle, ShieldCheck, UserRound } from "lucide-react";
import { useAuth } from "../auth/context";
import AccountControls, { ThemeButton } from "../components/AccountControls";
import GoogleAccountLink from "../components/GoogleAccountLink";
import PasswordField from "../components/PasswordField";
import { useTheme } from "../lib/useTheme";
import { getErrorMessage } from "../lib/errors";

function Feedback({ error, success }) {
  return <>{error && <p className="inline-error" role="alert">{error}</p>}
    {success && <p className="account-success" role="status"><Check size={15} />{success}</p>}</>;
}

export default function AccountSettingsPage() {
  const { user, client } = useAuth();
  const [theme, toggleTheme] = useTheme();
  const [username, setUsername] = useState(user.username);
  const [currentPassword, setCurrentPassword] = useState("");
  const [profilePassword, setProfilePassword] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [code, setCode] = useState("");
  const [pending, setPending] = useState("");
  const busy = useRef(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [reload, setReload] = useState(0);
  const [feedback, setFeedback] = useState({});
  const [cooldown, setCooldown] = useState(0);
  const passwordless = user.has_password === false;
  const disabled = loading || Boolean(loadError) || Boolean(pending);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError("");
    client.loadAccount().then(account => { if (active) setUsername(account.username); })
      .catch(error => { if (active) setLoadError(getErrorMessage(error)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [client, reload]);
  useEffect(() => {
    if (!cooldown) return;
    const timer = setTimeout(() => setCooldown(value => Math.max(0, value - 1)), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);
  const perform = async (section, action, success) => {
    if (busy.current || disabled) return;
    busy.current = true;
    setPending(section);
    setFeedback(previous => ({ ...previous, [section]: {} }));
    try {
      await action();
      setFeedback(previous => ({ ...previous, [section]: { success } }));
      if (section === "email") setCooldown(60);
      else {
        setCode("");
        setCurrentPassword("");
        setProfilePassword("");
        setPassword("");
        setConfirmation("");
      }
    } catch (error) {
      setFeedback(previous => ({ ...previous, [section]: { error: getErrorMessage(error) } }));
      if (section === "email" && error.status === 429) setCooldown(60);
    } finally {
      busy.current = false;
      setPending("");
    }
  };
  const saveProfile = event => {
    event.preventDefault();
    perform("profile", () => client.updateUsername({ username: username.trim(),
      ...(passwordless ? { verification_code: code } : { current_password: profilePassword }) }), "Username updated.");
  };
  const savePassword = event => {
    event.preventDefault();
    if (password !== confirmation) {
      setFeedback(previous => ({ ...previous, password: { error: "Passwords do not match." } }));
      return;
    }
    perform("password", () => client.updatePassword({ password, confirm_password: confirmation,
      ...(passwordless ? { verification_code: code } : { current_password: currentPassword }) }),
    "Password saved. Other sessions have been signed out.");
  };
  return <main className={`ide-shell account-shell theme-${theme}`}>
    <header className="account-topbar">
      <Link to="/workspaces" className="dashboard-link account-back"><ArrowLeft size={16} /> Workspaces</Link>
      <div className="account-controls"><ThemeButton theme={theme} onClick={toggleTheme} /><AccountControls /></div>
    </header>
    <div className="account-settings">
      <div className="account-settings-heading"><span className="account-eyebrow">YOUR ACCOUNT</span>
        <h1>Account settings</h1><p>Make yourself at home. Manage your profile and keep your account secure.</p></div>
      {loading && <p role="status">Loading account…</p>}
      {loadError && <div><p role="alert" className="inline-error">{loadError}</p><button className="button" onClick={() => setReload(value => value + 1)}>Try again</button></div>}
      {passwordless && <section className="account-confirmation" aria-labelledby="confirm-heading">
        <ShieldCheck size={21} /><div><h2 id="confirm-heading">Confirm it’s you</h2>
          <p>We’ll send a code to {user.email} before you change your username or set a password. Each code works once and expires in 10 minutes.</p>
          <div className="account-code-controls">
            <button type="button" className="button" disabled={disabled || cooldown > 0}
              onClick={() => perform("email", () => client.requestAccountVerification(), "Code sent. Check your inbox and spam folder.")}>
              {pending === "email" ? "Sending…" : cooldown ? `Resend in ${cooldown}s` : "Send confirmation code"}</button>
            <label className="field-label">Confirmation code
              <input value={code} onChange={event => setCode(event.target.value.replace(/\D/g, "").slice(0, 8))}
                autoComplete="one-time-code" inputMode="numeric" maxLength={8} placeholder="8-digit code" disabled={disabled} />
            </label>
          </div><Feedback {...feedback.email} /></div>
      </section>}
      <div className="account-settings-grid">
        <section className="account-settings-card" aria-labelledby="profile-heading">
          <div className="account-section-title"><UserRound size={20} /><h2 id="profile-heading">Profile information</h2></div>
          <form onSubmit={saveProfile}>
            <label className="field-label">Username<input value={username} onChange={event => setUsername(event.target.value)} required maxLength={150} autoComplete="username" disabled={disabled} /></label>
            <label className="field-label">Email address<input value={user.email || ""} readOnly type="email" /></label>
            <p className="account-help">Your workspaces stay with your account when you change your username.</p>
            {!passwordless && <PasswordField label="Password to confirm username change" value={profilePassword} onChange={setProfilePassword} current disabled={disabled} />}
            <button className="button button-primary" disabled={disabled || !username.trim() || (passwordless && code.length !== 8)}>
              {pending === "profile" && <LoaderCircle size={15} className="spin" />}{pending === "profile" ? "Saving…" : "Save changes"}</button>
            <Feedback {...feedback.profile} />
          </form>
        </section>
        <section className="account-settings-card" aria-labelledby="security-heading">
          <div className="account-section-title"><ShieldCheck size={20} /><h2 id="security-heading">Security</h2></div>
          <div className="account-methods"><span>{passwordless ? "Google sign-in only" : "Password enabled"}</span><GoogleAccountLink /></div>
          <h3>{passwordless ? "Set password" : "Change password"}</h3>
          <p className="account-help">{passwordless ? "Add a password to sign in with your email too. Google stays connected." : "Confirm your current password to choose a new one."} Other sessions will be signed out.</p>
          <form onSubmit={savePassword}>
            {!passwordless && <PasswordField label="Current password" value={currentPassword} onChange={setCurrentPassword} current disabled={disabled} />}
            <PasswordField label="New password" value={password} onChange={setPassword} disabled={disabled} />
            <PasswordField label="Confirm new password" value={confirmation} onChange={setConfirmation} disabled={disabled} />
            <p className="account-help">Use at least 8 characters. Avoid common passwords and personal information.</p>
            <button className="button button-primary" disabled={disabled || (passwordless && code.length !== 8)}>
              {pending === "password" && <LoaderCircle size={15} className="spin" />}{pending === "password" ? "Saving…" : passwordless ? "Set password" : "Change password"}</button>
            <Feedback {...feedback.password} />
          </form>
        </section>
      </div>
    </div>
  </main>;
}
