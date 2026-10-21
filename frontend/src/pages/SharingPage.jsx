import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useTheme } from "../lib/useTheme";
import { useSharingApi } from "../lib/sharing";
import { getErrorMessage } from "../lib/errors";
import { getFileName } from "../lib/ideFiles";
import AccountControls from "../components/AccountControls";
import SharingNav from "../components/SharingNav";
import ManageCollaborators from "../components/ManageCollaborators";
import { ResourceDialog } from "../components/IdePrimitives";

export default function SharingPage() {
  const { section } = useParams();
  return <SharingContent key={section} section={section} />;
}

function SharingContent({ section }) {
  const api = useSharingApi();
  const [theme] = useTheme();
  const [items, setItems] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [manage, setManage] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const title = section === "files" ? "Shared With Me" : section === "sent" ? "Sent Invitations" : "Invitations";
  const load = useCallback(async (signal) => {
    const path = section === "files" ? "files/" : `invitations/${section === "sent" ? "?direction=sent" : ""}`;
    const data = await api(path, "GET", undefined, signal);
    if (!signal?.aborted) { setItems(data); setError(""); }
  }, [api, section]);
  useEffect(() => {
    const controller = new AbortController();
    const refresh = () => load(controller.signal).catch(err => {
      if (!controller.signal.aborted) setError(getErrorMessage(err));
    });
    refresh();
    const timer = setInterval(refresh, 15000);
    window.addEventListener("focus", refresh);
    return () => { controller.abort(); clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, [load]);
  const respond = async (id, action) => {
    setBusy(true); setError("");
    try {
      await api(`invitations/${id}/`, "POST", { action });
      setNotice(action === "accept" ? "Invitation accepted. Find the file in Shared With Me." : "Invitation updated.");
      await load();
    } catch (err) { setError(getErrorMessage(err)); throw err; }
    finally { setBusy(false); }
  };
  return <main className={`ide-shell account-shell theme-${theme}`}>
    <header className="account-topbar"><Link className="brand" to="/workspaces">Shared_IDE</Link><AccountControls /></header>
    <section className="dashboard"><SharingNav /><h1>{title}</h1>
      <p>Collaborate on individual files while keeping workspaces private.</p>
      {error && <p className="inline-error" role="alert">{error}</p>}
      {notice && <p role="status" className="dashboard-notice">{notice}</p>}
      {!items ? (!error && <p role="status">Loading…</p>) : !items.length ? <div className="dashboard-empty">Nothing here yet.</div> :
        <div className="sharing-list">{items.map(item => <article className="sharing-card" key={item.id}>
          <h2 title={getFileName(item.file || item)}>{getFileName(item.file || item)}</h2>
          <p>{section === "files" ? `Owner: ${item.owner.username}` :
            section === "sent" ? `To: ${item.recipient.username}` : `From: ${item.sender.username}`}</p>
          <p>Can {item.permission} {item.status ? `· ${item.status}` : ""}</p>
          <time dateTime={item.updated_at}>{new Date(item.updated_at).toLocaleString()}</time>
          <div className="sharing-actions">
            {section === "files" ? <Link className="button button-primary" to={`/shared/${item.id}`}>Open File</Link> :
              section !== "sent" ? <>
                <button className="button button-primary" disabled={busy} onClick={() => respond(item.id, "accept").catch(() => {})}>Accept</button>
                <button className="button" disabled={busy} onClick={() => respond(item.id, "decline").catch(() => {})}>Decline</button>
              </> : item.status === "pending" ?
                <button className="button" disabled={busy} onClick={() => setConfirm({
                  title: "Cancel invitation?", description: `Cancel the invitation to ${item.recipient.username}?`,
                  confirmOnly: true, danger: true, submitLabel: "Cancel invitation",
                  onSubmit: () => respond(item.id, "cancel"),
                })}>Cancel Invitation</button> : item.status === "accepted" ?
                  <button className="button" onClick={() => setManage(item.file)}>Manage Collaborators</button> : null}
          </div>
        </article>)}</div>}
    </section>
    {manage && <ManageCollaborators file={manage} onClose={() => setManage(null)} onChanged={load} />}
    {confirm && <ResourceDialog dialog={confirm} onClose={() => setConfirm(null)} />}
  </main>;
}
