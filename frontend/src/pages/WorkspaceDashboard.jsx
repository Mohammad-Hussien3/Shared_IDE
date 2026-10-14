import { useTheme } from "../lib/useTheme";
import { useCallback, useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import {
  Code2,
  FolderOpen,
  LoaderCircle,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { useAuth } from "../auth/context";
import AccountControls, { ThemeButton } from "../components/AccountControls";
import { IconButton, ResourceDialog } from "../components/IdePrimitives";
import { API_BASE_URL, responseData } from "../lib/api";
import { getErrorMessage } from "../lib/errors";
import GoogleAccountLink from "../components/GoogleAccountLink";

export default function WorkspaceDashboard() {
  const location = useLocation();
  const { client, user } = useAuth();
  const [theme, toggleTheme] = useTheme();
  const [workspaces, setWorkspaces] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState(null);
  const [notice, setNotice] = useState(location.state?.googleLinked ? "Google account connected." : "");
  const load = useCallback(
    (signal) =>
      client
        .fetch(`${API_BASE_URL}/workspaces/`, { signal })
        .then(responseData)
        .then((items) => {
          if (!signal?.aborted) setWorkspaces(items);
        })
        .catch((err) => {
          if (!signal?.aborted) setError(getErrorMessage(err));
        })
        .finally(() => {
          if (!signal?.aborted) setLoading(false);
        }),
    [client],
  );
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);
  const mutate = async (method, workspace, name) => {
    const result = await responseData(
      await client.fetch(
        `${API_BASE_URL}/workspaces/${workspace ? `${workspace.id}/` : ""}`,
        {
          method,
          headers: { "Content-Type": "application/json" },
          ...(method === "DELETE" ? {} : { body: JSON.stringify({ name }) }),
        },
      ),
    );
    setWorkspaces((current) =>
      method === "POST"
        ? [result, ...current]
        : method === "DELETE"
          ? current.filter((item) => item.id !== workspace.id)
          : current.map((item) => (item.id === workspace.id ? result : item)),
    );
    setNotice(
      method === "POST"
        ? "Workspace created"
        : method === "DELETE"
          ? "Workspace deleted"
          : "Workspace renamed",
    );
  };
  const create = () =>
    setDialog({
      title: "New workspace",
      label: "Workspace name",
      submitLabel: "Create",
      description: "Start with an empty workspace.",
      onSubmit: (name) => mutate("POST", null, name),
    });
  const rename = (workspace) =>
    setDialog({
      title: "Rename workspace",
      label: "Workspace name",
      value: workspace.name,
      submitLabel: "Rename",
      onSubmit: (name) => mutate("PATCH", workspace, name),
    });
  const remove = (workspace) =>
    setDialog({
      title: "Delete workspace?",
      description: `Delete “${workspace.name}” and all its files and folders? This cannot be undone.`,
      confirmOnly: true,
      danger: true,
      submitLabel: "Delete",
      onSubmit: () => mutate("DELETE", workspace),
    });
  return (
    <main className={`ide-shell account-shell theme-${theme}`}>
      <header className="account-topbar">
        <span className="brand">
          <Code2 size={20} /> Workspace
        </span>
        <div className="top-actions">
          <ThemeButton theme={theme} onClick={toggleTheme} />
          <AccountControls />
        </div>
      </header>
      <section className="dashboard">
        <GoogleAccountLink />
        <div className="dashboard-heading">
          <div>
            <span className="eyebrow">{user.username} / YOUR PROJECTS</span>
            <h1>Your workspaces</h1>
            <p>Pick up where you left off, or start something new.</p>
          </div>
          <button className="button button-primary" onClick={create}>
            <Plus size={16} />
            New workspace
          </button>
        </div>
        {notice && (
          <p role="status" className="dashboard-notice">
            {notice}
          </p>
        )}
        {loading ? (
          <div className="dashboard-empty">
            <LoaderCircle className="spin" />
            <p>Loading workspaces…</p>
          </div>
        ) : error ? (
          <div className="dashboard-empty">
            <p role="alert">{error}</p>
            <button
              className="button"
              onClick={() => {
                setLoading(true);
                setError("");
                load();
              }}
            >
              Try again
            </button>
          </div>
        ) : !workspaces.length ? (
          <div className="dashboard-empty">
            <FolderOpen size={38} />
            <h2>A fresh start</h2>
            <p>Create your first workspace to begin coding.</p>
            <button className="button" onClick={create}>
              Create workspace
            </button>
          </div>
        ) : (
          <div className="workspace-grid">
            {workspaces.map((workspace) => (
              <article className="workspace-card" key={workspace.id}>
                <FolderOpen className="workspace-card-icon" size={24} />
                <Link
                  className="workspace-card-link"
                  to={`/workspaces/${workspace.id}`}
                  title={workspace.name}
                >
                  {workspace.name}
                </Link>
                <div className="workspace-card-footer">
                  <span>Private workspace</span>
                  <div>
                    <IconButton
                      icon={Pencil}
                      label={`Rename ${workspace.name}`}
                      onClick={() => rename(workspace)}
                    />
                    <IconButton
                      icon={Trash2}
                      label={`Delete ${workspace.name}`}
                      onClick={() => remove(workspace)}
                    />
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
      {dialog && (
        <ResourceDialog dialog={dialog} onClose={() => setDialog(null)} />
      )}
    </main>
  );
}
