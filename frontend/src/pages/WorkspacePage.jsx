import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Editor from "@monaco-editor/react";
import "../App.css";

const API_URL = import.meta.env.VITE_API_URL;
const DEFAULT_WORKSPACE_ID = import.meta.env.VITE_WORKSPACE_ID;
const API_BASE_URL = API_URL?.replace(/\/$/, "");
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
const EXTENSION_LANGUAGES = {
  py: "python", js: "javascript", ts: "typescript", java: "java", cpp: "cpp",
  c: "c", cs: "csharp", go: "go", rs: "rust", php: "php", rb: "ruby",
  kt: "kotlin", swift: "swift", html: "html", css: "css", json: "json",
  xml: "xml", sql: "sql", sh: "bash",
};
const LANGUAGE_ALIASES = { "c++": "cpp", "c#": "csharp", shell: "bash" };

function hasFilenameExtension(name) {
  return /\.[^./\\]+$/.test(name) && name.lastIndexOf(".") > 0;
}

function languageFromFilename(name) {
  if (!hasFilenameExtension(name)) return "";
  const extension = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  return EXTENSION_LANGUAGES[extension] || "";
}

function normalizeFilename(name, language) {
  const extension = LANGUAGE_EXTENSIONS[LANGUAGE_ALIASES[language] || language];
  if (!extension) return name;
  let normalized = name;
  while (normalized.toLowerCase().endsWith(extension + extension)) {
    normalized = normalized.slice(0, -extension.length);
  }
  return normalized;
}

export function getFileName(file) {
  const name = file?.name || "";
  if (hasFilenameExtension(name)) return name;
  const storedLanguage = file?.language?.trim().toLowerCase();
  const language = LANGUAGE_ALIASES[storedLanguage] || storedLanguage;
  const extension = LANGUAGE_EXTENSIONS[language];
  if (!extension) return name;
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

function findFolderName(nodes = [], folderId) {
  for (const node of nodes) {
    if (node.type === "folder" && node.id === folderId) return node.name;
    const nestedName = findFolderName(node.children || [], folderId);
    if (nestedName) return nestedName;
  }
  return "selected folder";
}

function findFolderPath(nodes = [], folderId, ancestors = []) {
  for (const node of nodes) {
    if (node.type !== "folder") continue;
    const path = [...ancestors, node.id];
    if (String(node.id) === String(folderId)) return path;
    const nestedPath = findFolderPath(node.children || [], folderId, path);
    if (nestedPath.length) return nestedPath;
  }
  return [];
}

async function responseData(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data.detail || Object.values(data).flat().join(" ") || response.statusText;
    throw new Error(`HTTP ${response.status}${message ? `: ${message}` : ""}`);
  }
  return data;
}

function TreeItem({
  node, depth = 0, selectedId, selectedFolderId, onSelect, onSelectFolder,
  expanded, onToggle, renamingFileId, renameValue, setRenameValue,
  renameError, renameSaving, onStartRename, onSaveRename, onCancelRename,
}) {
  const isFolder = node.type === "folder";
  const isOpen = expanded.has(node.id);
  const isRenaming = !isFolder && renamingFileId === node.id;
  const fileRow = (
    <button
      className={`tree-row ${selectedId === node.id ? "selected" : ""}`}
      style={{ "--depth": depth }}
      onClick={() => onSelect(node)}
      title={getFileName(node)}
    >
      <span className="tree-chevron" />
      <span className="tree-icon file-icon">◦</span>
      <span className="tree-name">{getFileName(node)}</span>
    </button>
  );
  return (
    <>
      {isFolder ? (
        <button
          className={`tree-row ${selectedFolderId === node.id ? "selected" : ""}`}
          style={{ "--depth": depth }}
          onClick={() => { onSelectFolder(node); onToggle(node.id); }}
          title={node.name}
        >
          <span className={`tree-chevron ${isOpen ? "open" : ""}`}>{isOpen ? "▾" : "›"}</span>
          <span className="tree-icon folder-icon">{isOpen ? "▾" : "▸"}</span>
          <span className="tree-name">{node.name}</span>
        </button>
      ) : isRenaming ? (
        <div className="rename-form" style={{ "--depth": depth }}>
          <input
            aria-label={`Rename ${getFileName(node)}`}
            autoFocus
            value={renameValue}
            onChange={(event) => setRenameValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") onSaveRename(node);
              if (event.key === "Escape") onCancelRename();
            }}
          />
          <button title="Save rename" onClick={() => onSaveRename(node)} disabled={renameSaving || !renameValue.trim()}>Save</button>
          <button title="Cancel rename" onClick={onCancelRename} disabled={renameSaving}>Cancel</button>
          {renameError && <span className="rename-error">{renameError}</span>}
        </div>
      ) : (
        <div className="tree-file-row">
          {fileRow}
          <button className="rename-action" title={`Rename ${getFileName(node)}`} onClick={() => onStartRename(node)}>Rename</button>
        </div>
      )}
      {isFolder && isOpen && (node.children || []).map((child) => (
        <TreeItem
          key={child.id} node={child} depth={depth + 1} selectedId={selectedId}
          selectedFolderId={selectedFolderId} onSelect={onSelect} onSelectFolder={onSelectFolder}
          expanded={expanded} onToggle={onToggle} renamingFileId={renamingFileId}
          renameValue={renameValue} setRenameValue={setRenameValue} renameError={renameError}
          renameSaving={renameSaving} onStartRename={onStartRename} onSaveRename={onSaveRename}
          onCancelRename={onCancelRename}
        />
      ))}
    </>
  );
}

function languageFor(file) {
  const filenameLanguage = languageFromFilename(file?.name || "");
  const storedLanguage = file?.language?.trim().toLowerCase();
  return filenameLanguage || LANGUAGE_ALIASES[storedLanguage] || storedLanguage || "plaintext";
}

export default function WorkspacePage() {
  const [workspace, setWorkspace] = useState(null);
  const [workspaceId] = useState(() => DEFAULT_WORKSPACE_ID || localStorage.getItem("workspace_id") || "");
  const [tree, setTree] = useState([]);
  const [activeFile, setActiveFile] = useState(null);
  const [selectedFolderId, setSelectedFolderId] = useState(null);
  const [fileContent, setFileContent] = useState("");
  const [contentsByFile, setContentsByFile] = useState({});
  const [loadingFile, setLoadingFile] = useState(false);
  const [fileError, setFileError] = useState("");
  const [expanded, setExpanded] = useState(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saveStatus, setSaveStatus] = useState("");
  const [actionMessage, setActionMessage] = useState("");
  const [actionError, setActionError] = useState(false);
  const [creating, setCreating] = useState(false);
  const [renamingFileId, setRenamingFileId] = useState(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameError, setRenameError] = useState("");
  const [renameSaving, setRenameSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [showOutput, setShowOutput] = useState(false);
  const [runResult, setRunResult] = useState(null);
  const [runError, setRunError] = useState("");
  const fileRequestId = useRef(0);
  const files = useMemo(() => flattenFiles(tree), [tree]);

  useEffect(() => {
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
    fetch(`${API_BASE_URL}/workspaces/${workspaceId}/`)
      .then(responseData)
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
  }, [workspaceId]);

  const selectFile = useCallback(async (file) => {
    setActiveFile(file);
    setFileError("");
    setSaveStatus("");
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
      const response = await fetch(`${API_BASE_URL}/workspaces/${workspaceId}/`);
      const workspaceData = await responseData(response);
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
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  const refreshWorkspaceTree = useCallback(async (folderIdsToExpand = []) => {
    const data = await responseData(
      await fetch(`${API_BASE_URL}/workspaces/${workspaceId}/`),
    );
    setWorkspace(data);
    setTree(data.children || []);
    if (folderIdsToExpand.length) {
      setExpanded((current) => new Set([...current, ...folderIdsToExpand]));
    }
    return data;
  }, [workspaceId]);

  const createItem = async (type) => {
    const folderName = selectedFolderId
      ? `inside ${findFolderName(tree, selectedFolderId)}`
      : "at workspace root";
    const name = window.prompt(`New ${type} name (${folderName})`);
    if (!name?.trim()) return;

    setCreating(true);
    setActionMessage("");
    setActionError(false);
    try {
      const isFolder = type === "folder";
      const endpoint = isFolder ? "folders" : "files";
      const cleanName = normalizeFilename(name.trim(), languageFromFilename(name.trim()));
      const payload = isFolder
        ? { name: cleanName, ...(selectedFolderId ? { parent: selectedFolderId } : {}) }
        : { name: cleanName, language: languageFromFilename(cleanName), content: "", ...(selectedFolderId ? { folder: selectedFolderId } : {}) };
      const created = await responseData(await fetch(
        `${API_BASE_URL}/workspaces/${workspaceId}/${endpoint}/`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) },
      ));
      const visibleFolderPath = findFolderPath(tree, selectedFolderId);
      await refreshWorkspaceTree(isFolder
        ? [...visibleFolderPath, created.id]
        : visibleFolderPath);

      if (isFolder) {
        setSelectedFolderId(created.id);
        setActionMessage("Folder created");
      } else {
        fileRequestId.current += 1;
        const file = { ...created, type: "file" };
        setActiveFile(file);
        setFileContent(created.content ?? "");
        setContentsByFile((current) => ({ ...current, [created.id]: created.content ?? "" }));
        setFileError("");
        setSaveStatus("");
        setActionMessage("File created");
      }
    } catch (err) {
      setActionMessage(err.message || `Could not create ${type}.`);
      setActionError(true);
    } finally {
      setCreating(false);
    }
  };

  const saveFile = async () => {
    if (!activeFile || !workspaceId) return;
    setSaveStatus("Saving…");
    try {
      const updated = await responseData(await fetch(
        `${API_BASE_URL}/workspaces/${workspaceId}/files/${activeFile.id}/`,
        { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: fileContent }) },
      ));
      setContentsByFile((current) => ({ ...current, [activeFile.id]: updated.content ?? fileContent }));
      setFileContent(updated.content ?? fileContent);
      setSaveStatus("Saved");
    } catch (err) {
      setSaveStatus(`Save failed: ${err.message}`);
    }
  };

  const startRename = (file) => {
    setRenamingFileId(file.id);
    setRenameValue(getFileName(file));
    setRenameError("");
  };

  const cancelRename = () => {
    setRenamingFileId(null);
    setRenameValue("");
    setRenameError("");
  };

  const saveRename = async (file) => {
    const inputName = renameValue.trim();
    if (!inputName) {
      setRenameError("Filename cannot be empty.");
      return;
    }
    const recognizedLanguage = languageFromFilename(inputName);
    const newName = normalizeFilename(inputName, recognizedLanguage);
    const language = recognizedLanguage || "";
    setRenameSaving(true);
    setRenameError("");
    try {
      const updated = await responseData(await fetch(
        `${API_BASE_URL}/workspaces/${workspaceId}/files/${file.id}/`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: newName, language }),
        },
      ));
      await refreshWorkspaceTree();
      setActiveFile((current) => current?.id === file.id ? { ...current, ...updated, type: "file" } : current);
      setRenamingFileId(null);
      setRenameValue("");
      setActionMessage("File renamed");
      setActionError(false);
    } catch (err) {
      setRenameError(err.message || "Could not rename file.");
    } finally {
      setRenameSaving(false);
    }
  };

  const runFile = async () => {
    setShowOutput(true);
    setRunResult(null);
    setRunError("");
    if (!activeFile) {
      setRunError("Select a file before running code.");
      return;
    }

    setRunning(true);
    try {
      const result = await responseData(await fetch(
        `${API_BASE_URL}/workspaces/${workspaceId}/files/${activeFile.id}/run/`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: fileContent }),
        },
      ));
      setRunResult(result);
    } catch (err) {
      setRunError(err.message || "Code execution failed.");
    } finally {
      setRunning(false);
    }
  };

  return (
    <main className="ide-shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark">⌘</span><span>Web IDE</span><span className="top-divider" /><span className="workspace-name">{workspace?.name || "Workspace"}</span></div>
        <div className="top-actions"><span className={`save-status ${saveStatus.startsWith("Save failed") ? "save-error" : ""}`}>{saveStatus}</span><button className="run-button" onClick={runFile} disabled={running}>{running ? "Running…" : "▶ Run"}</button><button className="action-button" onClick={saveFile} disabled={!activeFile || saveStatus === "Saving…"}>Save Content</button></div>
      </header>
      <div className="ide-body">
        <aside className="explorer">
          <div className="explorer-heading"><span>Explorer</span></div>
          <div className={`workspace-root ${selectedFolderId === null ? "root-selected" : ""}`} role="button" tabIndex={0} onClick={() => setSelectedFolderId(null)} onKeyDown={(event) => event.key === "Enter" && setSelectedFolderId(null)} title="Create items at workspace root"><span className="root-chevron">⌄</span><span className="root-icon">◈</span>{workspace?.name || "WORKSPACE"}</div>
          <div className="explorer-actions"><button onClick={() => createItem("folder")} disabled={creating || loading || Boolean(error)}>＋ New Folder</button><button onClick={() => createItem("file")} disabled={creating || loading || Boolean(error)}>＋ New File</button></div>
          {actionMessage && <div className={`explorer-message ${actionError ? "error-message" : "success-message"}`} role="status">{actionMessage}</div>}
          <div className="tree-scroll">
            {loading && <div className="tree-message">Loading workspace…</div>}
            {!loading && error && <div className="tree-message error-message">{error}</div>}
            {!loading && !error && tree.length === 0 && <div className="tree-message">This workspace is empty.</div>}
            {tree.map((node) => <TreeItem
              key={node.id} node={node} selectedId={activeFile?.id} selectedFolderId={selectedFolderId}
              onSelect={selectFile} onSelectFolder={(folder) => setSelectedFolderId(folder.id)}
              expanded={expanded} onToggle={toggleFolder} renamingFileId={renamingFileId}
              renameValue={renameValue} setRenameValue={setRenameValue} renameError={renameError}
              renameSaving={renameSaving} onStartRename={startRename} onSaveRename={saveRename}
              onCancelRename={cancelRename}
            />)}
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
              setSaveStatus("Unsaved changes");
            }} options={{ fontSize: 14, fontFamily: "'JetBrains Mono', 'SFMono-Regular', Consolas, monospace", minimap: { enabled: false }, scrollBeyondLastLine: false, automaticLayout: true, padding: { top: 16 }, lineNumbersMinChars: 3, renderLineHighlight: "line", overviewRulerBorder: false }} />) : <div className="welcome-state"><div className="welcome-glyph">{loading ? "◌" : "⌘"}</div><p>{loading ? "Opening your workspace…" : "Select a file to view its content"}</p><span>{error || (files.length ? "Choose a file from the Explorer" : "Your workspace is empty")}</span></div>}
          </div>
          {showOutput && <section className="output-panel" aria-live="polite">
            <div className="output-heading"><span>Run Output</span><button onClick={() => setShowOutput(false)} aria-label="Close output panel">×</button></div>
            <div className="output-body">
              {running && <div className="output-placeholder">Running in an isolated container…</div>}
              {runError && <pre className="output-error">{runError}</pre>}
              {runResult && <>
                <div className={`run-summary ${runResult.exit_code === 0 && !runResult.timed_out ? "" : "output-error"}`}>
                  {runResult.language} · {runResult.timed_out ? "Timed out" : `exit code ${runResult.exit_code}`}{runResult.output_limited ? " · output limit reached" : ""}
                </div>
                {runResult.stdout && <pre>{runResult.stdout}</pre>}
                {runResult.stderr && <pre className="output-error">{runResult.stderr}</pre>}
                {!runResult.stdout && !runResult.stderr && !runResult.timed_out && <div className="output-placeholder">Program completed without output.</div>}
              </>}
            </div>
          </section>}
        </section>
      </div>
      <footer className="statusbar"><div className="status-left"><span>{workspace?.name || "Workspace"}</span></div><div className="status-right"><span>{activeFile ? languageFor(activeFile) : "Ready"}</span><span>UTF-8</span></div></footer>
    </main>
  );
}
