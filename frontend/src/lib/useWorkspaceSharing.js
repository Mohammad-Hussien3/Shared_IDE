import { useCallback, useEffect, useRef, useState } from "react";
import { useSharingApi } from "./sharing";
import { getErrorMessage } from "./errors";

// Lives with the workspace, so sidebar navigation never restarts requests or editors.
export function useWorkspaceSharing() {
  const api = useSharingApi();
  const controller = useRef(null);
  const revision = useRef(0);
  const mutation = useRef(false);
  const [data, setData] = useState({ files: [], owned: [], incoming: [], sent: [] });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const refresh = useCallback(async () => {
    if (!controller.current || controller.current.signal.aborted) return;
    const signal = controller.current.signal;
    const request = ++revision.current;
    setLoading(true);
    try {
      const [files, owned, incoming, sent] = await Promise.all([
        api("files/", "GET", undefined, signal),
        api("files/?direction=owned", "GET", undefined, signal),
        api("invitations/", "GET", undefined, signal),
        api("invitations/?direction=sent", "GET", undefined, signal),
      ]);
      if (!signal.aborted && request === revision.current) {
        setData({ files, owned, incoming, sent }); setError("");
      }
    } catch (err) {
      if (!signal.aborted && request === revision.current) setError(getErrorMessage(err));
    } finally {
      if (!signal.aborted && request === revision.current) setLoading(false);
    }
  }, [api]);
  useEffect(() => {
    const lifetime = new AbortController();
    controller.current = lifetime;
    refresh();
    const poll = () => { if (!mutation.current) refresh(); };
    const timer = setInterval(poll, 15000);
    window.addEventListener("focus", poll);
    return () => { lifetime.abort(); clearInterval(timer); window.removeEventListener("focus", poll); };
  }, [refresh]);
  const respond = async (id, action) => {
    if (mutation.current) return;
    mutation.current = true;
    ++revision.current; // An older poll must not resurrect an accepted invitation.
    setBusy(id); setError("");
    const signal = controller.current.signal;
    try {
      await api(`invitations/${id}/`, "POST", { action }, signal);
      if (!signal.aborted) await refresh();
    } catch (err) {
      if (!signal.aborted) setError(getErrorMessage(err));
    } finally {
      mutation.current = false;
      if (!signal.aborted) { setBusy(""); setLoading(false); }
    }
  };
  return { ...data, loading, error, busy, refresh, respond };
}
