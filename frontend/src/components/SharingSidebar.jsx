import { useState } from "react";
import { RefreshCw, UsersRound } from "lucide-react";
import { FileIcon, IconButton } from "./IdePrimitives";
import { getFileName } from "../lib/ideFiles";
import "../sharing.css";

export default function SharingSidebar({ view, sharing, onOpen, onManage }) {
  const [direction, setDirection] = useState("incoming");
  const { files, owned, incoming, sent, loading, error, busy, refresh, respond } = sharing;
  const fileList = (items, isOwner) => items.length ? items.map(file => (
    <li key={file.id} className="sharing-sidebar-item">
      <button className="sharing-file-open" onClick={() => onOpen(file)} title={getFileName(file)}>
        <FileIcon file={file} />
        <span><strong>{getFileName(file)}</strong><small>{isOwner ? "You own this file" : `By ${file.owner.username}`} · {isOwner ? "Owner" : `Can ${file.permission}`}</small>
          <small>{isOwner ? `${file.collaborator_count} collaborator${file.collaborator_count === 1 ? "" : "s"}` : "Accepted · Live collaboration"}</small></span>
      </button>
      {isOwner && <button className="sharing-manage" onClick={() => onManage(file)} title={`Manage collaborators for ${getFileName(file)}`}><UsersRound size={13} />Manage collaborators</button>}
    </li>
  )) : <li className="sharing-sidebar-empty">{isOwner ? "Files with accepted collaborators will appear here. Use Share on an owned file to invite someone." : "Accept an invitation to start collaborating."}</li>;
  const invitations = direction === "incoming" ? incoming : sent;
  return <section className="sharing-sidebar" aria-label={view === "shared" ? "Shared files panel" : "Invitations panel"}>
    <header className="sidebar-heading"><span>{view === "shared" ? "Shared Files" : "Invitations"}</span>
      <IconButton icon={RefreshCw} label="Refresh sharing" onClick={refresh} disabled={loading} /></header>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {loading && <p className="sharing-sidebar-empty" role="status">Updating sharing…</p>}
    {view === "shared" ? <>
      <h3>Shared With Me <span>{files.length}</span></h3><ul>{fileList(files, false)}</ul>
      <h3>Files I've Shared <span>{owned.length}</span></h3><ul>{fileList(owned, true)}</ul>
    </> : <>
      <div className="sharing-directions" aria-label="Invitation direction">
        <button className={direction === "incoming" ? "active" : ""} aria-pressed={direction === "incoming"} onClick={() => setDirection("incoming")}>Incoming ({incoming.length})</button>
        <button className={direction === "sent" ? "active" : ""} aria-pressed={direction === "sent"} onClick={() => setDirection("sent")}>Sent</button>
      </div>
      <ul>{invitations.length ? invitations.map(invite => <li key={invite.id} className="sharing-sidebar-item">
        <strong title={getFileName(invite.file)}>{getFileName(invite.file)}</strong>
        <small>{direction === "incoming" ? `From ${invite.sender.username}` : `To ${invite.recipient.username}`} · Can {invite.permission}</small>
        <small>{invite.status}</small>
        {invite.status === "pending" && <div className="sharing-invitation-actions">
          {direction === "incoming" ? <>
            <button className="button button-primary" disabled={Boolean(busy)} onClick={() => respond(invite.id, "accept")}>Accept</button>
            <button className="button" disabled={Boolean(busy)} onClick={() => respond(invite.id, "decline")}>Decline</button>
          </> : <button className="button" disabled={Boolean(busy)} onClick={() => respond(invite.id, "cancel")}>Cancel invitation</button>}
        </div>}
      </li>) : <li className="sharing-sidebar-empty">No {direction === "incoming" ? "pending" : "sent"} invitations.</li>}</ul>
    </>}
  </section>;
}
