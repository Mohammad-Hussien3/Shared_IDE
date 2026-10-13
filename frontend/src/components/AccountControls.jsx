import { useState } from "react";
import { LogOut, Moon, Sun } from "lucide-react";
import { useAuth } from "../auth/context";
import { getErrorMessage } from "../lib/errors";

export function ThemeButton({ theme, onClick }) {
  const Icon = theme === "dark" ? Sun : Moon;
  return (
    <button className="icon-button" aria-label="Toggle theme" onClick={onClick}>
      <Icon size={17} />
    </button>
  );
}

export default function AccountControls() {
  const { user, client } = useAuth();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const logout = async () => {
    if (pending) return;
    setPending(true);
    setError("");
    try {
      await client.logout();
    } catch (err) {
      setError(getErrorMessage(err, "logout"));
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="account-controls">
      <span className="account-name" title={user?.username}>
        {user?.username}
      </span>
      <button className="button" onClick={logout} disabled={pending}>
        <LogOut size={14} />
        {pending ? "Logging out…" : "Log out"}
      </button>
      {error && (
        <span className="account-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
