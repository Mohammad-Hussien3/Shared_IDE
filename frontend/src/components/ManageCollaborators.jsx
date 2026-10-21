import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { IconButton } from "./IdePrimitives";
import { getFileName } from "../lib/ideFiles";
import { getErrorMessage } from "../lib/errors";
import { useSharingApi } from "../lib/sharing";

export default function ManageCollaborators({ file, onClose, onChanged, onlineUsers = [] }) {
  const api = useSharingApi();
  const dialog = useRef(null);
  const [data, setData] = useState(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [recipient, setRecipient] = useState("");
  const [permission, setPermission] = useState("edit");
  const [busy, setBusy] = useState(false);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirm, setConfirm] = useState(null);
  const load = useCallback(() => api(`files/${file.id}/manage/`).then(setData), [api, file.id]);
  useEffect(() => {
    const element = dialog.current;
    element.showModal();
    const controller = new AbortController();
    const refresh = () => api(`files/${file.id}/manage/`, "GET", undefined, controller.signal)
      .then(value => { if (!controller.signal.aborted) setData(value); })
      .catch(err => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    refresh();
    const timer = setInterval(refresh, 15000);
    return () => { controller.abort(); clearInterval(timer); element.close(); };
  }, [load, api, file.id]);
  const updateQuery = value => {
    setQuery(value); setResults([]); setRecipient(""); setSearching(value.trim().length >= 3);
  };
  useEffect(() => {
    if (query.trim().length < 3) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      api(`users/?file=${file.id}&q=${encodeURIComponent(query.trim())}`, "GET", undefined, controller.signal)
        .then(items => { if (!controller.signal.aborted) setResults(items); })
        .catch(err => { if (!controller.signal.aborted) setError(getErrorMessage(err)); })
        .finally(() => { if (!controller.signal.aborted) setSearching(false); });
    }, 350);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [api, file.id, query]);
  const mutate = async (path, method, body, message) => {
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      await api(path, method, body);
      setConfirm(null); setNotice(message); updateQuery("");
      await load(); await onChanged?.();
    } catch (err) { setError(getErrorMessage(err)); }
    finally { setBusy(false); }
  };
  return <dialog ref={dialog} className="resource-dialog sharing-dialog" aria-labelledby="sharing-title"
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <div className="dialog-heading"><h2 id="sharing-title">Manage Collaborators</h2>
      <IconButton icon={X} label="Close sharing" onClick={onClose} disabled={busy} /></div>
    <p className="sharing-filename" title={getFileName(file)}>{getFileName(file)}</p>
    {error && <p role="alert" className="inline-error">{error}</p>}
    {notice && <p role="status" className="dashboard-notice">{notice}</p>}
    {!data ? (!error && <p role="status">Loading access…</p>) : <>
      <p>Owned by <strong>{data.owner.username}</strong>. Access applies only to this file.</p>
      <form className="sharing-invite" onSubmit={event => {
        event.preventDefault();
        if (recipient) mutate(`files/${file.id}/manage/`, "POST", { recipient: Number(recipient), permission }, "Invitation sent.");
      }}>
        <label className="field-label">Find a collaborator
          <input value={query} onChange={e => updateQuery(e.target.value)} placeholder="Username or exact email" disabled={busy} maxLength={254} />
        </label>
        {searching && <p role="status">Searching…</p>}
        {!searching && query.length >= 3 && !results.length && <p>No eligible users found.</p>}
        {!!results.length && <label className="field-label">Recipient
          <select aria-label="Recipient" required value={recipient} onChange={e => setRecipient(e.target.value)}>
            <option value="">Choose a user</option>
            {results.map(user => <option key={user.id} value={user.id}>{user.username}</option>)}
          </select></label>}
        <label className="field-label">Invitation permission
          <select aria-label="Invitation permission" value={permission} onChange={e => setPermission(e.target.value)} disabled={busy}>
            <option value="edit">Can edit</option><option value="view">Can view</option>
          </select></label>
        <button className="button button-primary" disabled={busy || !recipient}>Send Invitation</button>
      </form>
      <h3>Collaborators</h3>
      {!data.collaborators.length && <p>No collaborators yet.</p>}
      {data.collaborators.map(member => <div className="sharing-row" key={member.user.id}>
        <span><strong>{member.user.username}</strong>
          <small>{(member.online || onlineUsers.some(u => u.id === member.user.id)) ? "Online" : "Offline"}</small></span>
        <select aria-label={`Permission for ${member.user.username}`} value={member.permission} disabled={busy}
          onChange={e => mutate(`files/${file.id}/members/${member.user.id}/`, "PATCH", { permission: e.target.value }, "Permission updated.")}>
          <option value="edit">Can edit</option><option value="view">Can view</option>
        </select>
        <button className="button danger-text" disabled={busy} onClick={() => setConfirm({
          label: `Remove ${member.user.username}'s access?`, path: `files/${file.id}/members/${member.user.id}/`,
          method: "DELETE", message: "Access removed.",
        })}>Remove Access</button>
      </div>)}
      <h3>Pending invitations</h3>
      {!data.invitations.length && <p>No pending invitations.</p>}
      {data.invitations.map(invitation => <div className="sharing-row" key={invitation.id}>
        <span>{invitation.recipient.username}<small>Can {invitation.permission}</small></span>
        <button className="button" disabled={busy} onClick={() => setConfirm({
          label: `Cancel invitation to ${invitation.recipient.username}?`, path: `invitations/${invitation.id}/`,
          method: "POST", body: { action: "cancel" }, message: "Invitation canceled.",
        })}>Cancel Invitation</button>
      </div>)}
      {confirm && <section className="sharing-confirm" role="alertdialog" aria-label={confirm.label}>
        <p>{confirm.label}</p>
        <button className="button" onClick={() => setConfirm(null)} disabled={busy}>Keep access</button>
        <button className="button button-danger" autoFocus disabled={busy}
          onClick={() => mutate(confirm.path, confirm.method, confirm.body, confirm.message)}>Confirm</button>
      </section>}
    </>}
  </dialog>;
}
