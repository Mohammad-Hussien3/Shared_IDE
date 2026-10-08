import { useCallback, useEffect, useMemo, useState } from "react";
import Editor from "@monaco-editor/react";
import "../App.css";

const API_URL = import.meta.env.VITE_API_URL;
const DEFAULT_WORKSPACE_ID = import.meta.env.VITE_WORKSPACE_ID;

function flattenFiles(nodes = [], parent = "") {
  return nodes.flatMap((node) => {
    const path = parent ? `${parent}/${node.name}` : node.name;
    return node.type === "file"
      ? [{ ...node, path }]
      : flattenFiles(node.children || [], path);
  });
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
        title={node.name}
      >
        <span className={`tree-chevron ${isOpen ? "open" : ""}`}>{isFolder ? "›" : ""}</span>
        <span className={`tree-icon ${isFolder ? "folder-icon" : "file-icon"}`}>{isFolder ? (isOpen ? "▾" : "▸") : "◦"}</span>
        <span className="tree-name">{node.name}</span>
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
  const [tree, setTree] = useState([]);
  const [activeFile, setActiveFile] = useState(null);
  const [contents, setContents] = useState({});
  const [expanded, setExpanded] = useState(new Set());
  const [cursor, setCursor] = useState({ lineNumber: 1, column: 1 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const files = useMemo(() => flattenFiles(tree), [tree]);

  useEffect(() => {
    const workspaceId = DEFAULT_WORKSPACE_ID || localStorage.getItem("workspace_id");
    if (!workspaceId) {
      setError("No workspace found. Create or select a workspace to get started.");
      setLoading(false);
      return;
    }
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
    setNotice("");
    if (Object.hasOwn(contents, file.id)) return;
    setContents((current) => ({ ...current, [file.id]: "" }));
  }, [contents]);

  const toggleFolder = (id) => setExpanded((current) => {
    const next = new Set(current);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  const createNode = (type) => {
    const name = window.prompt(type === "file" ? "New file name" : "New folder name");
    if (!name?.trim()) return;
    const cleanName = name.trim();
    const node = { id: `local-${Date.now()}`, name: cleanName, type, ...(type === "folder" ? { children: [] } : { language: languageFor({ name: cleanName }) }) };
    setTree((current) => [...current, node]);
    if (type === "file") selectFile(node);
    setNotice(`${type === "file" ? "File" : "Folder"} added locally`);
  };

  const saveFile = () => setNotice(activeFile ? "Changes are saved in this session" : "Select a file before saving");
  const runCode = () => setNotice("Run is not connected yet");
  const activeLanguage = languageFor(activeFile);

  return (
    <main className="ide-shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark">⌘</span><span>Web IDE</span><span className="top-divider" /><span className="workspace-name">{workspace?.name || "Workspace"}</span></div>
        <div className="top-actions"><button className="action-button" onClick={saveFile}><span>↓</span> Save</button><button className="run-button" onClick={runCode}><span>▶</span> Run</button></div>
      </header>
      <div className="ide-body">
        <aside className="explorer">
          <div className="explorer-heading"><span>Explorer</span><div className="explorer-tools"><button title="New file" onClick={() => createNode("file")}>＋</button><button title="New folder" onClick={() => createNode("folder")}>▱</button><button title="Refresh workspace" onClick={() => window.location.reload()}>↻</button></div></div>
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
            {activeFile ? <div className="editor-tab active-tab"><span className="tab-file-icon">◦</span>{activeFile.name}<span className="tab-unsaved" title="Unsaved changes">●</span></div> : <div className="tab-empty">No file open</div>}
            <div className="tab-spacer" />
            {notice && <div className="editor-notice">{notice}</div>}
          </div>
          <div className="editor-area">
            {activeFile ? <Editor height="100%" theme="vs-dark" language={activeLanguage} value={contents[activeFile.id] ?? ""} onChange={(value) => setContents((current) => ({ ...current, [activeFile.id]: value ?? "" }))} onMount={(editor) => editor.onDidChangeCursorPosition(({ position }) => setCursor({ lineNumber: position.lineNumber, column: position.column }))} options={{ fontSize: 14, fontFamily: "'JetBrains Mono', 'SFMono-Regular', Consolas, monospace", minimap: { enabled: false }, scrollBeyondLastLine: false, automaticLayout: true, padding: { top: 16 }, lineNumbersMinChars: 3, renderLineHighlight: "line", overviewRulerBorder: false }} /> : <div className="welcome-state"><div className="welcome-glyph">{loading ? "◌" : "⌘"}</div><p>{loading ? "Opening your workspace…" : "Select a file to start coding"}</p><span>{error || (files.length ? "Choose a file from the Explorer" : "Your editor is ready when you are")}</span></div>}
          </div>
        </section>
      </div>
      <footer className="statusbar"><div className="status-left"><span><i className="status-branch">⑂</i> main</span><span>◌ 0 errors</span></div><div className="status-right"><span>{activeLanguage[0]?.toUpperCase() + activeLanguage.slice(1)}</span><span>UTF-8</span><span>LF</span><span>Ln {cursor.lineNumber}, Col {cursor.column}</span><span className="status-bell">◉</span></div></footer>
    </main>
  );
}
