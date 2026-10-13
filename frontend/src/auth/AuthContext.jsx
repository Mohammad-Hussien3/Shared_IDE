import { useEffect, useState } from "react";
import { AuthContext } from "./context";
import { createAuthClient } from "../lib/api";
import { getErrorMessage } from "../lib/errors";

export function AuthProvider({ children }) {
  const [client] = useState(createAuthClient);
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    let sessionEstablished = false;
    const unsubscribe = client.subscribe((nextUser, sessionError) => {
      if (sessionEstablished && sessionError) setError(getErrorMessage(sessionError));
      else if (nextUser || !sessionError) setError("");
      sessionEstablished = Boolean(nextUser);
      setUser(nextUser);
    });
    let active = true;
    client
      .restore()
      .catch((err) => {
        if (active && err.status !== 401) setError(getErrorMessage(err));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [client]);
  return (
    <AuthContext.Provider value={{ client, user, loading, error, setError }}>
      {children}
    </AuthContext.Provider>
  );
}
