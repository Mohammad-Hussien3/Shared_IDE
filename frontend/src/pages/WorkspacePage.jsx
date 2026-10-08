import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Editor from "@monaco-editor/react";
import "../App.css";

const API_URL = import.meta.env.VITE_API_URL;
const DEFAULT_WORKSPACE_ID = import.meta.env.VITE_WORKSPACE_ID;
const LANGUAGE_EXTENSIONS = {
  python: ".py",
  javascript: ".js",
  typescript: ".ts",
  java: ".java",
  cpp: ".cpp",
  "c++": ".cpp",
  c: ".c",
  csharp: ".cs",
  "c#": ".cs",
  go: ".go",
  rust: ".rs",
  php: ".php",
  ruby: ".rb",
  kotlin: ".kt",
  swift: ".swift",
  html: ".html",
  css: ".css",
  json: ".json",
  xml: ".xml",
  sql: ".sql",
  bash: ".sh",
  shell: ".sh",
};

export function getFileName(file) {
  const name = file?.name || "";
  const extension = LANGUAGE_EXTENSIONS[file?.language?.trim().toLowerCase()];
  if (!extension || name.toLowerCase().endsWith(extension)) return name;
  return `${name}${extension}`;
}

function flattenFiles(nodes = [], parent = "") {
  return nodes.flatMap((node) => {
    const path = parent ? `${parent}/${node.name}` : node.name;
    return node.type === "file"
      ? [{ ...node, path }]
      : flattenFiles(node.children || [], path);
  });
}

function findFileById(nodes = [], fileId) {
  for (const node of nodes) {
    if (node.type === "file" && String(node.id) === String(fileId)) return node;
    const nestedMatch = findFileById(node.children || [], fileId);
    if (nestedMatch) return nestedMatch;
  }
  return null;
}

function TreeItem({ node, depth = 0, selectedId, onSelect, expanded, onToggle }) {
  const isFolder = node.type === "folder";
  const isOpen = expanded.has(node.id);
  return (
    <>
      <button
        className={`tree-row ${!isFolder && selectedId === node.id ? "selected" : ""}`}
        style={{ "--depth": depth }}
        onClick={() => isFolder ? onToggle(node.id) : onSelect(node)}
        title={isFolder ? node.name : getFileName(node)}
      >
        <span className={`tree-chevron ${isOpen ? "open" : ""}`}>{isFolder ? "›" : ""}</span>
        <span className={`tree-icon ${isFolder ? "folder-icon" : "file-icon"}`}>{isFolder ? (isOpen ? "▾" : "▸") : "◦"}</span>
        <span className="tree-name">{isFolder ? node.name : getFileName(node)}</span>
      </button>
      {isFolder && isOpen && (node.children || []).map((child) => (
        <TreeItem key={child.id} node={child} depth={depth + 1} selectedId={selectedId} onSelect={onSelect} expanded={expanded} onToggle={onToggle} />
      ))}
    </>
  );
}

function languageFor(file) {
  const byExtension = { js: "javascript", jsx: "javascript", ts: "typescript", tsx: "typescript", py: "python", html: "html", css: "css", json: "json", md: "markdown", sh: "shell" };
  const ext = file?.name?.split(".").pop()?.toLowerCase();
  return file?.language || byExtension[ext] || "plaintext";
}

export default function WorkspacePage() {
  const [workspace, setWorkspace] = useState(null);
  const [workspaceId, setWorkspaceId] = useState("");
  const [tree, setTree] = useState([]);
  const [activeFile, setActiveFile] = useState(null);
  const [fileContent, setFileContent] = useState("");
  const [contentsByFile, setContentsByFile] = useState({});
  const [loadingFile, setLoadingFile] = useState(false);
  const [fileError, setFileError] = useState("");
  const [expanded, setExpanded] = useState(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const fileRequestId = useRef(0);
  const files = useMemo(() => flattenFiles(tree), [tree]);

  useEffect(() => {
    const workspaceId = DEFAULT_WORKSPACE_ID || localStorage.getItem("workspace_id");
    if (!workspaceId) {
      setError("No workspace found. Create or select a workspace to get started.");
      setLoading(false);
      return;
    }
    setWorkspaceId(workspaceId);
    if (!API_URL) {
      setError("VITE_API_URL is not configured.");
      setLoading(false);
      return;
    }
    let cancelled = false;
    fetch(`${API_URL.replace(/\/$/, "")}/workspaces/${workspaceId}/`)
      .then((response) => {
        if (!response.ok) throw new Error(`Workspace request failed (${response.status})`);
        return response.json();
      })
      .then((data) => {
        if (cancelled) return;
        setWorkspace(data);
        setTree(data.children || []);
        setExpanded(new Set((data.children || []).filter((item) => item.type === "folder").map((item) => item.id)));
        setError("");
      })
      .catch((err) => !cancelled && setError(err.message || "Could not load workspace."))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, []);

  const selectFile = useCallback(async (file) => {
    setActiveFile(file);
    setFileError("");
    const requestId = ++fileRequestId.current;
    if (Object.hasOwn(contentsByFile, file.id)) {
      setFileContent(contentsByFile[file.id]);
      setLoadingFile(false);
      return;
    }
    setFileContent("");
    setLoadingFile(true);

    try {
      // The API has no file-detail route. Its workspace-detail response includes each file's content.
      const response = await fetch(`${API_URL.replace(/\/$/, "")}/workspaces/${workspaceId}/`);
      if (!response.ok) throw new Error(`File request failed (${response.status})`);
      const workspaceData = await response.json();
      const fetchedFile = findFileById(workspaceData.children || [], file.id);
      if (!fetchedFile) throw new Error("File was not found in the workspace response.");
      if (requestId === fileRequestId.current) {
        const content = fetchedFile.content ?? "";
        setFileContent(content);
        setContentsByFile((current) => ({ ...current, [file.id]: content }));
      }
    } catch (err) {
      if (requestId === fileRequestId.current) setFileError(err.message || "Could not load file content.");
    } finally {
      if (requestId === fileRequestId.current) setLoadingFile(false);
    }
  }, [workspaceId, contentsByFile]);

  const toggleFolder = (id) => setExpanded((current) => {
    const next = new Set(current);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  return (
    <main className="ide-shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark">⌘</span><span>Web IDE</span><span className="top-divider" /><span className="workspace-name">{workspace?.name || "Workspace"}</span></div>
      </header>
      <div className="ide-body">
        <aside className="explorer">
          <div className="explorer-heading"><span>Explorer</span></div>
          <div className="workspace-root"><span className="root-chevron">⌄</span><span className="root-icon">◈</span>{workspace?.name || "WORKSPACE"}</div>
          <div className="tree-scroll">
            {loading && <div className="tree-message">Loading workspace…</div>}
            {!loading && error && <div className="tree-message error-message">{error}</div>}
            {!loading && !error && tree.length === 0 && <div className="tree-message">This workspace is empty.</div>}
            {tree.map((node) => <TreeItem key={node.id} node={node} selectedId={activeFile?.id} onSelect={selectFile} expanded={expanded} onToggle={toggleFolder} />)}
          </div>
          <div className="explorer-footer"><span className="online-dot" /> Workspace files</div>
        </aside>
        <section className="editor-panel">
          <div className="tab-strip">
            {activeFile ? <div className="editor-tab active-tab"><span className="tab-file-icon">◦</span>{getFileName(activeFile)}</div> : <div className="tab-empty">No file open</div>}
            <div className="tab-spacer" />
          </div>
          <div className="editor-area">
            {activeFile ? (loadingFile ? <div className="welcome-state"><p>Loading file…</p></div> : fileError ? <div className="welcome-state"><p>{fileError}</p></div> : <Editor height="100%" theme="vs-dark" language={languageFor(activeFile)} value={fileContent} onChange={(value) => {
              const content = value ?? "";
              setFileContent(content);
              setContentsByFile((current) => ({ ...current, [activeFile.id]: content }));
            }} options={{ fontSize: 14, fontFamily: "'JetBrains Mono', 'SFMono-Regular', Consolas, monospace", minimap: { enabled: false }, scrollBeyondLastLine: false, automaticLayout: true, padding: { top: 16 }, lineNumbersMinChars: 3, renderLineHighlight: "line", overviewRulerBorder: false }} />) : <div className="welcome-state"><div className="welcome-glyph">{loading ? "◌" : "⌘"}</div><p>{loading ? "Opening your workspace…" : "Select a file to view its content"}</p><span>{error || (files.length ? "Choose a file from the Explorer" : "Your workspace is empty")}</span></div>}
          </div>
        </section>
      </div>
      <footer className="statusbar"><div className="status-left"><span>{workspace?.name || "Workspace"}</span></div><div className="status-right"><span>{activeFile ? languageFor(activeFile) : "Ready"}</span><span>UTF-8</span></div></footer>
    </main>
  );
}
