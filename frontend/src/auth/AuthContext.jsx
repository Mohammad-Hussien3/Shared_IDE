import { useEffect, useState } from "react";
import { AuthContext } from "./context";
import { createAuthClient } from "../lib/api";

export function AuthProvider({ children }) {
  const [client] = useState(createAuthClient);
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    const unsubscribe = client.subscribe(setUser);
    let active = true;
    client
      .restore()
      .catch((err) => {
        if (active && err.status !== 401) setError(err.message);
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
