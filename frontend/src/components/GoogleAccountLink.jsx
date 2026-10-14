import { useRef, useState } from "react";
import { useAuth } from "../auth/context";
import { getErrorMessage } from "../lib/errors";
import { navigateToProvider } from "../lib/navigation";
import GoogleButton from "./GoogleButton";

export default function GoogleAccountLink() {
  const { client, user } = useAuth();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const busy = useRef(false);
  if (user.google_connected) return <p className="google-link-section">Google account connected.</p>;
  if (user.has_password === false) return null;
  const connect = async (event) => {
    event?.preventDefault();
    if (busy.current || !password) return;
    busy.current = true;
    setPending(true);
    setError("");
    const confirmation = password;
    setPassword("");
    try {
      navigateToProvider(await client.startGoogle(confirmation));
    } catch (err) {
      setError(getErrorMessage(err));
      busy.current = false;
      setPending(false);
    }
  };
  return (
    <section className="google-link-section">
      <button className="button" onClick={() => setOpen(!open)} disabled={pending} aria-expanded={open}>Connect Google account</button>
      {open && (
        <form className="google-link-form" onSubmit={connect}>
          <p>Confirm your current password, then choose your Google account. Your workspaces stay with this account.</p>
          <label className="field-label">Current password
            <input type="password" autoComplete="current-password" required maxLength={128} value={password} disabled={pending} onChange={event => setPassword(event.target.value)} />
          </label>
          <GoogleButton onClick={connect} disabled={!password || pending} pending={pending} />
          {error && <div className="inline-error" role="alert">{error}</div>}
        </form>
      )}
    </section>
  );
}
