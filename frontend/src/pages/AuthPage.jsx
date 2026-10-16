import { useRef, useState } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import { ArrowRight, Code2, LoaderCircle, Mail, Sparkles, UserRound } from "lucide-react";
import { useAuth } from "../auth/context";
import { getErrorMessage } from "../lib/errors";
import { navigateToProvider } from "../lib/navigation";
import useAuthMotion from "../lib/useAuthMotion";
import GoogleButton from "../components/GoogleButton";
import PasswordField from "../components/PasswordField";
import AuthMascot from "../components/AuthMascot";
import { MASCOT_CAPTIONS } from "../lib/authMascot";
import AuthFormField, { PasswordStrength } from "../components/AuthFormField";
import "../spark-auth.css";

export default function AuthPage({ register = false }) {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, client, error: sessionError, setError: setSessionError } = useAuth();
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [emailValid, setEmailValid] = useState(false);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState(false);
  const [googlePending, setGooglePending] = useState(false);
  const inProgress = useRef(false);
  const [error, setError] = useState("");
  const [focused, setFocused] = useState("");
  const [visible, setVisible] = useState({ password: false, confirmation: false });
  const [touched, setTouched] = useState({});
  const [attempted, setAttempted] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const { reducedMotion, gaze, trackPointer, trackInput, resetGaze } = useAuthMotion();
  const disabled = pending || googlePending;
  const loginEmailValid = !register && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(username);
  const usernameValid = /^[\p{L}\p{N}_@.+-]+$/u.test(username.trim());
  const usernameInvalid = (touched.username || attempted) && (register ? !usernameValid : !username.trim());
  const emailInvalid = register && (touched.email || attempted) && !emailValid;
  const passwordInvalid = (touched.password || attempted) && password.length < (register ? 8 : 1);
  const confirmationInvalid = register && (confirmation || touched.confirmation || attempted) && (!confirmation || password !== confirmation);
  const ready = Boolean(register ? usernameValid && emailValid && password.length >= 8 && password === confirmation : username.trim() && password);
  const hasProblem = Boolean(error || sessionError || usernameInvalid || emailInvalid || passwordInvalid || confirmationInvalid);
  const passwordFocused = focused === "password" || focused === "confirmation";
  const expression = confirmed ? "celebrating" : disabled ? "thinking"
    : passwordFocused ? (visible[focused] ? "peeking" : "covered")
      : hasProblem ? "confused" : ready ? "excited"
        : ((focused === "email" && emailValid) || (focused === "username" && loginEmailValid)) ? "happy" : focused ? "attentive" : "idle";

  // Finish the current request before redirecting so confirmation and navigation
  // are one transition. No animation timer delays authentication or routing.
  if (user && !pending) return <Navigate to="/workspaces" replace state={confirmed ? { authCelebration: "signed-in" } : undefined} />;
  const clearError = () => { setError(""); if (sessionError) setSessionError(""); };
  const focus = field => () => setFocused(field);
  const blur = field => event => {
    if (event.currentTarget.contains(event.relatedTarget)) return;
    setFocused("");
    setTouched(previous => ({ ...previous, [field]: true }));
  };
  const change = setter => value => { setter(value); clearError(); };
  const submit = async event => {
    event.preventDefault();
    if (inProgress.current) return;
    setAttempted(true);
    if (register && password !== confirmation) { setError("Passwords do not match."); return; }
    inProgress.current = true;
    setPending(true);
    setError("");
    setSessionError("");
    try {
      await client.authenticate(register ? "register" : "login", {
        username: username.trim(), password,
        ...(register ? { email: email.trim(), confirm_password: confirmation } : {}),
      });
      setConfirmed(true);
      if (register) navigate('/check-email', { replace: true, state: {
        email: email.trim(), justRegistered: true, authCelebration: "registered",
      } });
    } catch (err) {
      setError(getErrorMessage(err, register ? "register" : "login"));
      setFocused("");
    } finally {
      inProgress.current = false;
      setPending(false);
    }
  };
  const startGoogle = async () => {
    if (inProgress.current) return;
    inProgress.current = true;
    setGooglePending(true);
    setError("");
    setSessionError("");
    try { navigateToProvider(await client.startGoogle()); }
    catch (err) {
      setError(getErrorMessage(err));
      setFocused("");
      inProgress.current = false;
      setGooglePending(false);
    }
  };
  return <main className="ide-shell account-shell spark-auth theme-dark" data-reduced-motion={reducedMotion}
    onPointerMove={trackPointer} onPointerLeave={resetGaze}
    style={{ "--light-x": `${50 + gaze.x * 20}%`, "--light-y": `${45 + gaze.y * 15}%` }}>
    <div className="spark-ambient" aria-hidden="true" />
    <header className="spark-nav">
      <Link to="/login" className="spark-brand" aria-label="Shared IDE home"><span><Code2 size={23} /></span>Shared<span className="spark-brand-underscore">_</span>IDE</Link>
      <span className="spark-lab-label"><span /> SPARK LAB <span className="spark-nav-note">A space for your next idea.</span></span>
    </header>
    <div className="spark-layout">
      <section className="spark-intro" aria-label="Meet Spark">
        <span className="spark-eyebrow"><Sparkles size={14} /> A LITTLE CURIOSITY GOES A LONG WAY</span>
        <h2>A little spark.<br /><span>A lot of possibility.</span></h2>
        <p>Your ideas deserve a place to come alive.<br />Code, create, and make something yours.</p>
        <div className="spark-stage">
          <div className="spark-orbit" aria-hidden="true" />
          <span className="spark-code-tag spark-code-tag-left" aria-hidden="true">&lt;/&gt;</span>
          <span className="spark-code-tag spark-code-tag-right" aria-hidden="true"><span /> hello, world</span>
          <AuthMascot expression={expression} gaze={gaze} reducedMotion={reducedMotion} />
        </div>
        <div className="spark-mascot-caption"><span className="spark-caption-dot" /><span>{MASCOT_CAPTIONS[expression]}</span></div>
        <p className="spark-intro-footnote">WRITE. RUN. REPEAT.</p>
      </section>
      <section className="spark-card" aria-labelledby="auth-title">
        <header className="spark-card-heading">
          <span className="spark-eyebrow">{register ? "EVERY GREAT IDEA STARTS SOMEWHERE" : "GOOD TO HAVE YOU HERE"}</span>
          <h1 id="auth-title">{register ? "Create your account" : "Welcome back"}</h1>
          <p>{register ? "A fresh workspace. A world of possibilities." : "Pick up where your imagination left off."}</p>
        </header>
        {!register && location.state?.passwordReset === true && <p className="spark-success" role="status">Your password has been reset. Sign in with your new password.</p>}
        <form className="spark-form" onSubmit={submit} onInvalid={() => setAttempted(true)}>
          <AuthFormField label={register ? "Username" : "Email or username"} icon={register ? UserRound : Mail}
            name="username" autoComplete="username" inputMode={register ? "text" : "email"} required maxLength={register ? 150 : 254}
            placeholder={register ? "Your creative alias" : "you@example.com"} value={username} disabled={disabled}
            onChange={event => change(setUsername)(event.target.value)} onFocus={focus("username")} onBlur={blur("username")} onSelect={trackInput}
            invalid={usernameInvalid} valid={register && usernameValid}
            feedback={usernameInvalid ? (register ? "Use letters, numbers, or @ . + - _ in your username." : "Enter your email address or username.") : undefined} />
          {register && <AuthFormField label="Email address" icon={Mail} name="email" type="email" autoComplete="email" required maxLength={254}
            placeholder="you@example.com" value={email} disabled={disabled} invalid={emailInvalid} valid={emailValid}
            onChange={event => { change(setEmail)(event.target.value); setEmailValid(Boolean(event.target.value) && event.target.validity.valid); }}
            onFocus={focus("email")} onBlur={blur("email")} onSelect={trackInput}
            feedback={emailInvalid ? "Enter a valid email address." : undefined} />}
          <div className="spark-password-group">
            <PasswordField label="Password" value={password} onChange={change(setPassword)} disabled={disabled} current={!register}
              onFocus={focus("password")} onBlur={blur("password")} onVisibilityChange={value => setVisible(previous => ({ ...previous, password: value }))}
              inputProps={{ name: "password", placeholder: register ? "Make it a good one" : "Enter your password", minLength: register ? 8 : undefined,
                onSelect: trackInput, "aria-invalid": passwordInvalid || undefined, "aria-describedby": register ? "spark-password-help" : undefined }} />
            {!register && <Link className="spark-forgot" to="/forgot-password">Forgot password?</Link>}
            {register && <PasswordStrength password={password} />}
          </div>
          {register && <PasswordField label="Confirm password" value={confirmation} onChange={change(setConfirmation)} disabled={disabled}
            onFocus={focus("confirmation")} onBlur={blur("confirmation")} onVisibilityChange={value => setVisible(previous => ({ ...previous, confirmation: value }))}
            inputProps={{ name: "confirm_password", placeholder: "One more time", onSelect: trackInput,
              "aria-invalid": Boolean(confirmationInvalid) || undefined, "aria-describedby": confirmationInvalid ? "spark-confirmation-help" : undefined }}>
            {confirmationInvalid && <p id="spark-confirmation-help" className="spark-field-feedback" data-invalid="true">Passwords do not match.</p>}
          </PasswordField>}
          {register && <p id="spark-password-help" className="spark-password-help">Use at least 8 characters. Avoid common passwords and personal information.</p>}
          {(error || sessionError) && <div className="spark-error" role="alert">{error || sessionError}</div>}
          <button type="submit" className="spark-submit" disabled={disabled} aria-busy={pending}>
            {pending ? <><LoaderCircle size={18} className="spin" />Please wait…</> : <>{register ? "Create account" : "Sign in"}<ArrowRight size={18} /></>}
          </button>
          <div className="spark-divider">or continue with</div>
          <GoogleButton onClick={startGoogle} disabled={disabled} pending={googlePending} />
        </form>
        <p className="spark-switch">{register ? "Already part of the lab? " : "New around here? "}
          <Link to={register ? "/login" : "/register"}>{register ? "Sign in" : "Create an account"}<ArrowRight size={13} aria-hidden="true" /></Link></p>
      </section>
    </div>
    <footer className="spark-footer"><span>Made for curious minds.</span><span>One idea can change everything.<Sparkles size={12} /></span></footer>
  </main>;
}
