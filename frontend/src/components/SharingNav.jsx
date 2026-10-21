import { NavLink } from "react-router-dom";
export default function SharingNav() {
  return <nav className="sharing-nav" aria-label="Workspace navigation">
    <NavLink to="/workspaces">My workspaces</NavLink>
    <NavLink to="/sharing/files">Shared With Me</NavLink>
    <NavLink to="/sharing/invitations">Invitations</NavLink>
    <NavLink to="/sharing/sent">Sent Invitations</NavLink>
  </nav>;
}
