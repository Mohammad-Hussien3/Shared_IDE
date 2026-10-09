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

function detectLanguageFromContent(source) {
  const signatures = {
    python: [
      /^\s*(?:async\s+)?def\s+\w+\s*\(/m,
      /^\s*(?:from\s+[\w.]+\s+import|import\s+[\w.]+)/m,
      /\b(?:None|True|False|lambda|self)\b/,
      /\bprint\s*\(/,
    ],
    c: [
      /^\s*#\s*include\s*[<"](?:stdio|stdlib|string|stdbool|stdint)\.h[>"]/m,
      /\b(?:printf|scanf|puts|fopen|malloc|free)\s*\(/,
    ],
    cpp: [
      /^\s*#\s*include\s*[<"](?:iostream|bits\/stdc\+\+\.h)[>"]/m,
      /\bstd::(?:cout|cin|cerr)\b/,
      /\b(?:cout|cin)\s*<</,
    ],
  };
  const candidates = Object.entries(signatures)
    .filter(([, markers]) => markers.some((marker) => marker.test(source)))
    .map(([language]) => language);
  return candidates.length === 1 ? candidates[0] : "";
}

function replaceFileInTree(nodes, fileId, updatedFile) {
  return nodes.map((node) => {
    if (node.type === "file" && String(node.id) === String(fileId)) {
      return { ...node, ...updatedFile, type: "file" };
    }
    if (node.type === "folder") {
      return { ...node, children: replaceFileInTree(node.children || [], fileId, updatedFile) };
    }
    return node;
  });
}

function askForLanguage() {
  const answer = window.prompt(
    "I couldn't confidently detect the language. Type python, c, or cpp to choose one.",
  );
  const normalized = answer?.trim().toLowerCase();
  const language = normalized === "c++" ? "cpp" : normalized;
  return ["python", "c", "cpp"].includes(language) ? language : "";
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
  const [saveError, setSaveError] = useState("");
  const [manualSaving, setManualSaving] = useState(false);
  const [actionMessage, setActionMessage] = useState("");
  const [actionError, setActionError] = useState(false);
  const [creating, setCreating] = useState(false);
  const [renamingFileId, setRenamingFileId] = useState(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameError, setRenameError] = useState("");
  const [renameSaving, setRenameSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [runStage, setRunStage] = useState("");
  const [showOutput, setShowOutput] = useState(false);
  const [runResult, setRunResult] = useState(null);
  const [runError, setRunError] = useState("");
  const fileRequestId = useRef(0);
  const runInProgressRef = useRef(false);
  const saveInProgressRef = useRef(false);
  const activeFileRef = useRef(activeFile);
  const contentRevisionsRef = useRef(new Map());
  const dirtyFilesRef = useRef(new Set());

  useEffect(() => {
    activeFileRef.current = activeFile;
  }, [activeFile]);
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
    setSaveStatus(dirtyFilesRef.current.has(file.id) ? "Unsaved" : "Saved");
    setSaveError("");
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
        setSaveStatus("Saved");
        setSaveError("");
        contentRevisionsRef.current.set(file.id, 0);
        dirtyFilesRef.current.delete(file.id);
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
    if (!activeFile || !workspaceId || saveInProgressRef.current || runInProgressRef.current) return;
    const fileId = activeFile.id;
    const contentToSave = fileContent;
    const revisionAtSave = contentRevisionsRef.current.get(fileId) || 0;
    saveInProgressRef.current = true;
    setManualSaving(true);
    setSaveStatus("Saving…");
    setSaveError("");
    try {
      const updated = await responseData(await fetch(
        `${API_BASE_URL}/workspaces/${workspaceId}/files/${fileId}/`,
        { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: contentToSave }) },
      ));
      const revisionAfterSave = contentRevisionsRef.current.get(fileId) || 0;
      if (revisionAfterSave === revisionAtSave) {
        const savedContent = updated.content ?? contentToSave;
        dirtyFilesRef.current.delete(fileId);
        setContentsByFile((current) => ({ ...current, [fileId]: savedContent }));
        if (activeFileRef.current?.id === fileId) setFileContent(savedContent);
      }
      if (activeFileRef.current?.id === fileId) {
        const stillDirty = (contentRevisionsRef.current.get(fileId) || 0) !== revisionAtSave;
        setSaveStatus(stillDirty ? "Unsaved" : "Saved");
        setSaveError("");
      }
    } catch (err) {
      if (activeFileRef.current?.id === fileId) {
        dirtyFilesRef.current.add(fileId);
        setSaveStatus("Unsaved");
        setSaveError(`Save failed: ${err.message}`);
      }
    } finally {
      saveInProgressRef.current = false;
      setManualSaving(false);
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
    if (runInProgressRef.current) return;
    setShowOutput(true);
    setRunResult(null);
    setRunError("");
    if (!activeFile) {
      setRunError("Select a file before running code.");
      return;
    }
    if (loadingFile) {
      setRunError("Wait for the selected file to finish loading before running it.");
      return;
    }
    if (saveInProgressRef.current) {
      setRunError("Wait for the current save to finish before running the file.");
      return;
    }

    const fileId = activeFile.id;
    const contentToRun = fileContent;
    const revisionAtRun = contentRevisionsRef.current.get(fileId) || 0;
    let saveAttempted = false;
    let saveConfirmed = false;
    runInProgressRef.current = true;
    setRunning(true);
    setRunStage("saving");
    try {
      const filenameHasExtension = hasFilenameExtension(activeFile.name);
      let language;
      if (filenameHasExtension) {
        language = languageFromFilename(activeFile.name);
        if (!language) {
          throw new Error(
            `The .${activeFile.name.split(".").at(-1)} extension is not recognized. Rename the file with a supported extension before running it.`,
          );
        }
      } else {
        language = detectLanguageFromContent(fileContent) || askForLanguage();
        if (!language) {
          throw new Error("Choose python, c, or cpp to run this file. It was not renamed.");
        }
      }

      const newName = filenameHasExtension
        ? activeFile.name
        : `${activeFile.name}${LANGUAGE_EXTENSIONS[language]}`;
      saveAttempted = true;
      setSaveStatus("Saving…");
      setSaveError("");
      const savedFile = await responseData(await fetch(
        `${API_BASE_URL}/workspaces/${workspaceId}/files/${fileId}/`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content: contentToRun,
            name: newName,
            language,
          }),
        },
      ));
      saveConfirmed = true;
      const revisionAfterSave = contentRevisionsRef.current.get(fileId) || 0;
      if (revisionAfterSave !== revisionAtRun || activeFileRef.current?.id !== fileId) {
        if (activeFileRef.current?.id === fileId) {
          dirtyFilesRef.current.add(fileId);
          setSaveStatus("Unsaved");
          setSaveError("The file changed while saving. Run again to save and execute the latest edits.");
        }
        throw new Error("The file changed while saving. Run again to save and execute the latest edits.");
      }
      dirtyFilesRef.current.delete(fileId);
      setSaveStatus("Saved");
      setSaveError("");
      setContentsByFile((current) => ({ ...current, [fileId]: savedFile.content ?? contentToRun }));
      const runFileRecord = { ...activeFile, ...savedFile, name: newName, language, type: "file" };
      setActiveFile((current) => current?.id === activeFile.id ? runFileRecord : current);
      setTree((current) => replaceFileInTree(current, activeFile.id, runFileRecord));

      setRunStage("running");
      const result = await responseData(await fetch(
        `${API_BASE_URL}/workspaces/${workspaceId}/files/${runFileRecord.id}/run/`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: savedFile.content ?? contentToRun }),
        },
      ));
      setRunResult(result);
    } catch (err) {
      if (saveAttempted && !saveConfirmed && activeFileRef.current?.id === fileId) {
        dirtyFilesRef.current.add(fileId);
        setSaveStatus("Unsaved");
        setSaveError(`Save failed: ${err.message}`);
      }
      setRunError(err.message || "Code execution failed.");
    } finally {
      runInProgressRef.current = false;
      setRunStage("");
      setRunning(false);
    }
  };

  return (
    <main className="ide-shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark">⌘</span><span>Web IDE</span><span className="top-divider" /><span className="workspace-name">{workspace?.name || "Workspace"}</span></div>
        <div className="top-actions"><span className={`save-status ${saveError || saveStatus === "Unsaved" ? "save-error" : ""}`}>{saveStatus}</span>{saveError && <span className="save-error" role="alert" title={saveError}>{saveError}</span>}<button className="run-button" onClick={runFile} disabled={running || loadingFile || manualSaving}>{runStage === "saving" ? "Saving…" : running ? "Running…" : "▶ Run"}</button><button className="action-button" onClick={saveFile} disabled={!activeFile || manualSaving || running}>Save Content</button></div>
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
              contentRevisionsRef.current.set(activeFile.id, (contentRevisionsRef.current.get(activeFile.id) || 0) + 1);
              dirtyFilesRef.current.add(activeFile.id);
              setFileContent(content);
              setContentsByFile((current) => ({ ...current, [activeFile.id]: content }));
              setSaveStatus("Unsaved");
              setSaveError("");
            }} options={{ fontSize: 14, fontFamily: "'JetBrains Mono', 'SFMono-Regular', Consolas, monospace", minimap: { enabled: false }, scrollBeyondLastLine: false, automaticLayout: true, padding: { top: 16 }, lineNumbersMinChars: 3, renderLineHighlight: "line", overviewRulerBorder: false }} />) : <div className="welcome-state"><div className="welcome-glyph">{loading ? "◌" : "⌘"}</div><p>{loading ? "Opening your workspace…" : "Select a file to view its content"}</p><span>{error || (files.length ? "Choose a file from the Explorer" : "Your workspace is empty")}</span></div>}
          </div>
          {showOutput && <section className="output-panel" aria-live="polite">
            <div className="output-heading"><span>Run Output</span><button onClick={() => setShowOutput(false)} aria-label="Close output panel">×</button></div>
            <div className="output-body">
              {runStage === "saving" && <div className="output-placeholder">Saving the latest editor content before execution…</div>}
              {runStage === "running" && <div className="output-placeholder">Running in an isolated container…</div>}
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
