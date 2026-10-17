import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import TerminalPanel from "../components/TerminalPanel";
import { Link } from "react-router-dom";
import { useAuth } from "../auth/context";
import AccountControls from "../components/AccountControls";
import { API_BASE_URL, WS_BASE_URL, responseData } from "../lib/api";
import { ERROR_MESSAGES, getErrorMessage, getTerminalErrorMessage, HttpError, UserFacingError } from "../lib/errors";
import {
  AlertCircle,
  ArrowRight,
  Check,
  ChevronRight,
  Code2,
  Files,
  FilePlus2,
  FolderOpen,
  LoaderCircle,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  Save,
  Search,
  Settings2,
  Sun,
  X,
} from "lucide-react";
import Explorer, { SearchSidebar } from "../components/Explorer";
import EditorTabs from "../components/EditorTabs";
import SettingsPanel from "../components/SettingsPanel";
import {
  FileIcon,
  IconButton,
  ResizeHandle,
  ResourceDialog,
  SaveIndicator,
} from "../components/IdePrimitives";
import {
  LANGUAGE_EXTENSIONS,
  hasFilenameExtension,
  languageFromFilename,
  detectLanguageFromContent,
  normalizeFilename,
  getFileName,
  flattenFiles,
  findFileById,
  findFolderName,
  findFolderPath,
  replaceFileInTree,
  languageFor,
} from "../lib/ideFiles";
import "../App.css";
import { defineEditorThemes } from "../lib/editorThemes";

const Editor = lazy(() => import("../components/CodeEditor"));

export default function WorkspacePage({ workspaceId }) {
  const { client, user } = useAuth();
  const requestControllerRef = useRef(null);
  const mountedRef = useRef(false);
  const apiFetch = useCallback(
    async (url, options = {}) => {
      const controller = requestControllerRef.current;
      if (!controller || controller.signal.aborted)
        throw new Error("Workspace closed.");
      const response = await client.fetch(url, {
        ...options,
        signal: controller.signal,
      });
      if (controller.signal.aborted) throw new Error("Workspace closed.");
      return response;
    },
    [client],
  );
  const [workspace, setWorkspace] = useState(null);
  const [tree, setTree] = useState([]);
  const [activeFile, setActiveFile] = useState(null);
  const [selectedFolderId, setSelectedFolderId] = useState(null);
  const [fileContent, setFileContent] = useState("");
  const [contentsByFile, setContentsByFile] = useState({});
  const [loadingFile, setLoadingFile] = useState(false);
  const [fileError, setFileError] = useState("");
  const [expanded, setExpanded] = useState(new Set());
  const [loading, setLoading] = useState(Boolean(workspaceId));
  const [error, setError] = useState("");
  const [saveStatus, setSaveStatus] = useState("");
  const [saveError, setSaveError] = useState("");
  const [manualSaving, setManualSaving] = useState(false);
  const [actionMessage, setActionMessage] = useState("");
  const [actionError, setActionError] = useState(false);
  const [creating, setCreating] = useState(false);
  const [dialog, setDialog] = useState(null);
  const [openFileIds, setOpenFileIds] = useState([]);
  const [theme, setTheme] = useState(
    () => localStorage.getItem("ide-theme") || "dark",
  );
  const [fontSize, setFontSize] = useState(
    () => Number(localStorage.getItem("ide-font-size")) || 14,
  );
  const [wordWrap, setWordWrap] = useState(
    () => localStorage.getItem("ide-word-wrap") === "true",
  );
  const [sidebarView, setSidebarView] = useState("explorer");
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth > 760);
  const [sidebarWidth, setSidebarWidth] = useState(258);
  const [panelMaximized, setPanelMaximized] = useState(false);
  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  const [diagnostics, setDiagnostics] = useState({});
  const [executionProblems, setExecutionProblems] = useState([]);
  const editorRef = useRef(null);
  const cursorSubscriptionRef = useRef(null);
  const [running, setRunning] = useState(false);
  const [runStage, setRunStage] = useState("");
  const terminalRef = useRef(null);
  const activeSocketRef = useRef(null);
  const pendingInputRef = useRef("");
  const terminalReadyRef = useRef(false);
  const fileRequestId = useRef(0);
  const runInProgressRef = useRef(false);
  const saveInProgressRef = useRef(false);
  const activeFileRef = useRef(activeFile);
  const contentRevisionsRef = useRef(new Map());
  const dirtyFilesRef = useRef(new Set());
  const [dirtyIds, setDirtyIds] = useState(new Set());
  const markDirty = (id, dirty) => {
    if (dirty) dirtyFilesRef.current.add(id);
    else dirtyFilesRef.current.delete(id);
    setDirtyIds(new Set(dirtyFilesRef.current));
  };

  useEffect(() => {
    activeFileRef.current = activeFile;
  }, [activeFile]);
  useEffect(() => {
    const controller = new AbortController();
    requestControllerRef.current = controller;
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      controller.abort();
      fileRequestId.current += 1;
      activeFileRef.current = null;
      activeSocketRef.current?.close();
    };
  }, []);
  const files = useMemo(() => flattenFiles(tree), [tree]);
  const openedFiles = openFileIds
    .map(
      (id) =>
        findFileById(tree, id) || (activeFile?.id === id ? activeFile : null),
    )
    .filter(Boolean);
  const problems = [...Object.values(diagnostics).flat(), ...executionProblems];
  const activePath =
    files.find((file) => file.id === activeFile?.id)?.path ||
    activeFile?.name ||
    "";

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("ide-theme", theme);
  }, [theme]);
  useEffect(() => {
    localStorage.setItem("ide-font-size", String(fontSize));
  }, [fontSize]);
  useEffect(() => {
    localStorage.setItem("ide-word-wrap", String(wordWrap));
  }, [wordWrap]);
  useEffect(() => () => cursorSubscriptionRef.current?.dispose(), []);
  useEffect(() => {
    if (!actionMessage || actionError) return;
    const timer = setTimeout(() => setActionMessage(""), 4500);
    return () => clearTimeout(timer);
  }, [actionMessage, actionError]);

  const closeDialog = () => {
    dialog?.onCancel?.();
    setDialog(null);
  };
  const chooseLanguage = () =>
    new Promise((resolve) =>
      setDialog({
        title: "Choose a language",
        description:
          "The code is ambiguous. Choose the language to assign an extension and run this file.",
        label: "Language",
        value: "python",
        submitLabel: "Continue",
        options: [
          { value: "python", label: "Python" },
          { value: "c", label: "C" },
          { value: "cpp", label: "C++" },
        ],
        onSubmit: (value) => resolve(value),
        onCancel: () => resolve(""),
      }),
    );
  const openSidebar = (view) => {
    setSidebarView(view);
    setSidebarOpen(true);
  };

  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    apiFetch(`${API_BASE_URL}/workspaces/${workspaceId}/`)
      .then(responseData)
      .then((data) => {
        if (cancelled) return;
        setWorkspace(data);
        setTree(data.children || []);
        setExpanded(
          new Set(
            (data.children || [])
              .filter((item) => item.type === "folder")
              .map((item) => item.id),
          ),
        );
        setError("");
      })
      .catch(
        (err) =>
          !cancelled && setError(getErrorMessage(err)),
      )
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [workspaceId, apiFetch]);

  const selectFile = useCallback(
    async (file) => {
      setActiveFile(file);
      activeFileRef.current = file;
      setOpenFileIds((current) =>
        current.includes(file.id) ? current : [...current, file.id],
      );
      if (window.innerWidth <= 760) setSidebarOpen(false);
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
        const fetchedFile = await responseData(
          await apiFetch(
            `${API_BASE_URL}/workspaces/${workspaceId}/files/${file.id}/`,
          ),
        );
        if (requestId === fileRequestId.current) {
          const content = fetchedFile.content ?? "";
          setFileContent(content);
          setContentsByFile((current) => ({ ...current, [file.id]: content }));
        }
      } catch (err) {
        if (requestId === fileRequestId.current)
          setFileError(getErrorMessage(err));
      } finally {
        if (requestId === fileRequestId.current) setLoadingFile(false);
      }
    },
    [workspaceId, contentsByFile, apiFetch],
  );

  const toggleFolder = (id) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const refreshWorkspaceTree = useCallback(
    async (folderIdsToExpand = []) => {
      const data = await responseData(
        await apiFetch(`${API_BASE_URL}/workspaces/${workspaceId}/`),
      );
      setWorkspace(data);
      setTree(data.children || []);
      if (folderIdsToExpand.length) {
        setExpanded((current) => new Set([...current, ...folderIdsToExpand]));
      }
      return data;
    },
    [workspaceId, apiFetch],
  );

  const createItem = (type, folderId = selectedFolderId) =>
    setDialog({
      title: `New ${type}`,
      description: folderId
        ? `Create inside ${findFolderName(tree, folderId)}.`
        : "Create at the workspace root.",
      label: type === "file" ? "Filename" : "Folder name",
      placeholder: type === "file" ? "main.py" : "src",
      submitLabel: "Create",
      onSubmit: (name) => submitCreate(type, folderId, name),
    });

  const submitCreate = async (type, folderId, name) => {
    setCreating(true);
    setActionMessage("");
    setActionError(false);
    try {
      const isFolder = type === "folder";
      const endpoint = isFolder ? "folders" : "files";
      const cleanName = isFolder
        ? name.trim()
        : normalizeFilename(name.trim(), languageFromFilename(name.trim()));
      const payload = isFolder
        ? { name: cleanName, ...(folderId ? { parent: folderId } : {}) }
        : {
            name: cleanName,
            language: languageFromFilename(cleanName),
            content: "",
            ...(folderId ? { folder: folderId } : {}),
          };
      const created = await responseData(
        await apiFetch(
          `${API_BASE_URL}/workspaces/${workspaceId}/${endpoint}/`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          },
        ),
      );
      const visibleFolderPath = findFolderPath(tree, folderId);
      await refreshWorkspaceTree(
        isFolder ? [...visibleFolderPath, created.id] : visibleFolderPath,
      );

      if (isFolder) {
        setSelectedFolderId(created.id);
        setActionMessage("Folder created");
      } else {
        fileRequestId.current += 1;
        const file = { ...created, type: "file" };
        setActiveFile(file);
        activeFileRef.current = file;
        setOpenFileIds((current) => [...current, file.id]);
        setLoadingFile(false);
        setFileContent(created.content ?? "");
        setContentsByFile((current) => ({
          ...current,
          [created.id]: created.content ?? "",
        }));
        setFileError("");
        setSaveStatus("Saved");
        setSaveError("");
        contentRevisionsRef.current.set(file.id, 0);
        markDirty(file.id, false);
        setActionMessage("File created");
      }
    } catch (err) {
      setActionMessage(getErrorMessage(err));
      setActionError(true);
      throw err;
    } finally {
      setCreating(false);
    }
  };

  const saveFile = async () => {
    if (
      !activeFile ||
      loadingFile ||
      fileError ||
      !workspaceId ||
      saveInProgressRef.current ||
      runInProgressRef.current
    )
      return;
    const fileId = activeFile.id;
    const contentToSave = fileContent;
    const revisionAtSave = contentRevisionsRef.current.get(fileId) || 0;
    saveInProgressRef.current = true;
    setManualSaving(true);
    setSaveStatus("Saving…");
    setSaveError("");
    try {
      const updated = await responseData(
        await apiFetch(
          `${API_BASE_URL}/workspaces/${workspaceId}/files/${fileId}/`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: contentToSave }),
          },
        ),
      );
      const revisionAfterSave = contentRevisionsRef.current.get(fileId) || 0;
      if (revisionAfterSave === revisionAtSave) {
        const savedContent = updated.content ?? contentToSave;
        markDirty(fileId, false);
        setContentsByFile((current) => ({
          ...current,
          [fileId]: savedContent,
        }));
        if (activeFileRef.current?.id === fileId) setFileContent(savedContent);
      }
      if (activeFileRef.current?.id === fileId) {
        const stillDirty =
          (contentRevisionsRef.current.get(fileId) || 0) !== revisionAtSave;
        setSaveStatus(stillDirty ? "Unsaved" : "Saved");
        setSaveError("");
      }
    } catch (err) {
      if (activeFileRef.current?.id === fileId) {
        markDirty(fileId, true);
        setSaveStatus("Unsaved");
        setSaveError(getErrorMessage(err, "save"));
      }
    } finally {
      saveInProgressRef.current = false;
      setManualSaving(false);
    }
  };

  const renameItem = (node) =>
    setDialog({
      title: `Rename ${node.type}`,
      description:
        node.type === "folder"
          ? "Give this folder a new name."
          : "The extension determines the programming language.",
      label: "Name",
      value: node.type === "folder" ? node.name : getFileName(node),
      submitLabel: "Rename",
      onSubmit: async (inputName) => {
        const isFolder = node.type === "folder";
        const language = languageFromFilename(inputName);
        const name = isFolder
          ? inputName
          : normalizeFilename(inputName, language);
        const updated = await responseData(
          await apiFetch(
            `${API_BASE_URL}/workspaces/${workspaceId}/${isFolder ? "folders" : "files"}/${node.id}/`,
            {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(isFolder ? { name } : { name, language }),
            },
          ),
        );
        if (!isFolder)
          setActiveFile((current) =>
            current?.id === node.id
              ? { ...current, ...updated, type: "file" }
              : current,
          );
        await refreshWorkspaceTree();
        setActionMessage(`${isFolder ? "Folder" : "File"} renamed`);
        setActionError(false);
      },
    });

  const discardTab = (file) => {
    const remaining = openFileIds.filter((id) => id !== file.id);
    setOpenFileIds(remaining);
    markDirty(file.id, false);
    setContentsByFile((current) => {
      const next = { ...current };
      delete next[file.id];
      return next;
    });
    if (activeFileRef.current?.id === file.id) {
      const next = findFileById(tree, remaining.at(-1));
      if (next) selectFile(next);
      else {
        fileRequestId.current += 1;
        activeFileRef.current = null;
        setActiveFile(null);
        setFileContent("");
        setSaveStatus("");
        setSaveError("");
      }
    }
  };
  const closeTab = (file) => {
    if (dirtyFilesRef.current.has(file.id))
      setDialog({
        title: "Discard unsaved changes?",
        description: `${getFileName(file)} has changes that haven't been saved.`,
        confirmOnly: true,
        danger: true,
        submitLabel: "Discard & close",
        onSubmit: () => discardTab(file),
      });
    else discardTab(file);
  };
  const deleteItem = (node) =>
    setDialog({
      title: `Delete ${node.type}?`,
      description: `Delete “${node.name}”${node.type === "folder" ? " and everything inside it" : ""}? This cannot be undone.`,
      confirmOnly: true,
      danger: true,
      submitLabel: "Delete",
      onSubmit: async () => {
        const response = await apiFetch(
          `${API_BASE_URL}/workspaces/${workspaceId}/${node.type === "folder" ? "folders" : "files"}/${node.id}/`,
          { method: "DELETE" },
        );
        if (!response.ok) await responseData(response);
        const removed =
          node.type === "file"
            ? [node.id]
            : flattenFiles(node.children).map((file) => file.id);
        const remaining = openFileIds.filter((id) => !removed.includes(id));
        setOpenFileIds(remaining);
        removed.forEach((id) => markDirty(id, false));
        setContentsByFile((current) =>
          Object.fromEntries(
            Object.entries(current).filter(([id]) => !removed.includes(id)),
          ),
        );
        setDiagnostics((current) =>
          Object.fromEntries(
            Object.entries(current).filter(([id]) => !removed.includes(id)),
          ),
        );
        setSelectedFolderId(null);
        if (removed.includes(activeFileRef.current?.id)) {
          fileRequestId.current += 1;
          activeFileRef.current = null;
          setActiveFile(null);
          setSaveStatus("");
          setFileContent("");
        }
        await refreshWorkspaceTree();
        setActionMessage(
          `${node.type === "folder" ? "Folder" : "File"} deleted`,
        );
        setActionError(false);
      },
    });

  const writeTerminal = (message) => terminalRef.current?.write(message);

  const stopRun = () => {
    const socket = activeSocketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "stop" }));
    } else if (socket?.readyState === WebSocket.CONNECTING) {
      socket.close();
    }
  };

  const sendTerminalInput = (data) => {
    const socket = activeSocketRef.current;
    if (!socket || !runInProgressRef.current) return;
    if (socket.readyState === WebSocket.OPEN && terminalReadyRef.current) {
      socket.send(JSON.stringify({ type: "input", data }));
    } else if (
      socket.readyState === WebSocket.CONNECTING ||
      socket.readyState === WebSocket.OPEN
    ) {
      pendingInputRef.current += data;
    }
  };

  const sendTerminalResize = (cols, rows) => {
    const socket = activeSocketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "resize", cols, rows }));
    }
  };

  const executeSavedFile = async (fileId, filename) => {
    const accessToken = await client.getAccessToken();
    if (!mountedRef.current) throw new Error("Workspace closed.");
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(
        `${WS_BASE_URL}/workspaces/${workspaceId}/files/${fileId}/run/`,
      );
      activeSocketRef.current = socket;
      terminalReadyRef.current = false;
      pendingInputRef.current = "";
      let finished = false;

      socket.onopen = () => {
        socket.send(
          JSON.stringify({ type: "authenticate", token: accessToken }),
        );
      };
      const startProgram = () => {
        socket.send(JSON.stringify({ type: "start" }));
        const { cols, rows } = terminalRef.current?.getDimensions() || {
          cols: 80,
          rows: 24,
        };
        socket.send(JSON.stringify({ type: "resize", cols, rows }));
      };
      socket.onmessage = (event) => {
        let message;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        if (!message || typeof message !== "object") return;
        if (message.type === "authenticated") {
          startProgram();
        } else if (message.type === "ready") {
          terminalReadyRef.current = true;
          const dimensions = terminalRef.current?.getDimensions();
          if (dimensions)
            socket.send(JSON.stringify({ type: "resize", ...dimensions }));
          terminalRef.current?.focus();
          if (pendingInputRef.current) {
            socket.send(
              JSON.stringify({ type: "input", data: pendingInputRef.current }),
            );
            pendingInputRef.current = "";
          }
        } else if (message.type === "output") {
          if (typeof message.data === "string") writeTerminal(message.data);
        } else if (message.type === "error") {
          const friendlyMessage = getTerminalErrorMessage(message.message);
          setExecutionProblems((current) => [
            ...current,
            {
              fileId,
              filename,
              message: friendlyMessage,
            },
          ]);
          writeTerminal(
            `\r\n\x1b[31m${friendlyMessage}\x1b[0m\r\n`,
          );
        } else if (message.type === "finished") {
          // Only numeric process exit codes belong in the terminal UI.
          if (message.reason === "completed" && !Number.isInteger(message.exit_code)) return;
          finished = true;
          terminalReadyRef.current = false;
          if (message.reason === "completed" && message.exit_code !== 0) {
            setExecutionProblems((current) => [
              ...current,
              {
                fileId,
                filename,
                message: `Program exited with code ${message.exit_code}. See Terminal or Output for details.`,
              },
            ]);
          }
          if (message.reason === "stopped") writeTerminal("\r\n[Stopped]\r\n");
          else if (message.reason === "timeout")
            writeTerminal("\r\n[Timed out]\r\n");
          else if (message.reason === "completed")
            writeTerminal(`\r\n[Exited with code ${message.exit_code}]\r\n`);
          socket.close();
          resolve();
        }
      };
      socket.onerror = () => {
        if (!finished)
          writeTerminal(`\r\n\x1b[31m${ERROR_MESSAGES.terminal}\x1b[0m\r\n`);
      };
      socket.onclose = (event) => {
        if (event?.code === 4401 && mountedRef.current)
          client.restore().catch(() => {});
        if (activeSocketRef.current === socket) {
          activeSocketRef.current = null;
          terminalReadyRef.current = false;
          pendingInputRef.current = "";
        }
        if (!finished)
          reject(
            event?.code === 4401 ? new HttpError(401)
              : event?.code === 4403 ? new HttpError(403)
                : event?.code === 4404 ? new HttpError(404)
                  : new UserFacingError(ERROR_MESSAGES.terminal),
          );
      };
    });
  };

  const runFile = async () => {
    if (runInProgressRef.current) return;
    terminalRef.current?.clear();
    terminalRef.current?.reveal();
    setExecutionProblems([]);
    if (!activeFile) {
      writeTerminal("Select a file before running code.\r\n");
      return;
    }
    if (loadingFile) {
      writeTerminal(
        "Wait for the selected file to finish loading before running it.\r\n",
      );
      return;
    }
    if (saveInProgressRef.current) {
      writeTerminal(
        "Wait for the current save to finish before running the file.\r\n",
      );
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
    writeTerminal("Saving the latest editor content…\r\n");
    try {
      const filenameHasExtension = hasFilenameExtension(activeFile.name);
      let language;
      if (filenameHasExtension) {
        language = languageFromFilename(activeFile.name);
        if (!language) {
          throw new UserFacingError(
            "This file extension is not recognized. Rename the file with a supported extension before running it.",
          );
        }
      } else {
        language =
          detectLanguageFromContent(fileContent) || (await chooseLanguage());
        if (!language) {
          throw new UserFacingError(
            "Choose python, c, or cpp to run this file. It was not renamed.",
          );
        }
      }

      const newName = filenameHasExtension
        ? activeFile.name
        : `${activeFile.name}${LANGUAGE_EXTENSIONS[language]}`;
      saveAttempted = true;
      setSaveStatus("Saving…");
      setSaveError("");
      const savedFile = await responseData(
        await apiFetch(
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
        ),
      );
      saveConfirmed = true;
      const revisionAfterSave = contentRevisionsRef.current.get(fileId) || 0;
      if (
        revisionAfterSave !== revisionAtRun ||
        activeFileRef.current?.id !== fileId
      ) {
        if (activeFileRef.current?.id === fileId) {
          markDirty(fileId, true);
          setSaveStatus("Unsaved");
          setSaveError(
            "The file changed while saving. Run again to save and execute the latest edits.",
          );
        }
        throw new UserFacingError(
          "The file changed while saving. Run again to save and execute the latest edits.",
        );
      }
      markDirty(fileId, false);
      setSaveStatus("Saved");
      setSaveError("");
      setContentsByFile((current) => ({
        ...current,
        [fileId]: savedFile.content ?? contentToRun,
      }));
      setFileContent(savedFile.content ?? contentToRun);
      const runFileRecord = {
        ...activeFile,
        ...savedFile,
        name: newName,
        language,
        type: "file",
      };
      setActiveFile((current) =>
        current?.id === activeFile.id ? runFileRecord : current,
      );
      setTree((current) =>
        replaceFileInTree(current, activeFile.id, runFileRecord),
      );

      setRunStage("running");
      writeTerminal("Running in an isolated container…\r\n");
      await executeSavedFile(runFileRecord.id, getFileName(runFileRecord));
    } catch (err) {
      const friendlyMessage = getErrorMessage(err, saveAttempted && !saveConfirmed ? "save" : "execution");
      if (
        saveAttempted &&
        !saveConfirmed &&
        activeFileRef.current?.id === fileId
      ) {
        markDirty(fileId, true);
        setSaveStatus("Unsaved");
        setSaveError(friendlyMessage);
      }
      setExecutionProblems([
        {
          fileId,
          filename: getFileName(activeFile),
          message: friendlyMessage,
        },
      ]);
      writeTerminal(
        `\r\n\x1b[31m${friendlyMessage}\x1b[0m\r\n`,
      );
    } finally {
      runInProgressRef.current = false;
      setRunStage("");
      setRunning(false);
    }
  };

  useEffect(() => {
    const shortcut = (event) => {
      if (dialog) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        saveFile();
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "b") {
        event.preventDefault();
        setSidebarOpen((value) => !value);
      }
      if (event.key === "F5") {
        event.preventDefault();
        runFile();
      }
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  });

  const onEditorChange = (value) => {
    if (!activeFile || loadingFile) return;
    const content = value ?? "";
    if (content === fileContent) return;
    contentRevisionsRef.current.set(
      activeFile.id,
      (contentRevisionsRef.current.get(activeFile.id) || 0) + 1,
    );
    markDirty(activeFile.id, true);
    setFileContent(content);
    setContentsByFile((current) => ({ ...current, [activeFile.id]: content }));
    setSaveStatus("Unsaved");
    setSaveError("");
  };
  const refresh = async () => {
    try {
      await refreshWorkspaceTree();
      setError("");
    } catch (err) {
      setActionMessage(getErrorMessage(err));
      setActionError(true);
    }
  };
  const runDisabled =
    running || loadingFile || Boolean(fileError) || manualSaving;

  return (
    <main className={`ide-shell theme-${theme}`}>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" title="Shared IDE · Spark Lab">
            <Code2 size={19} />
          </span>
          <span className="workspace-lab-label">SPARK LAB</span>
          <Link
            className="dashboard-link"
            to="/workspaces"
            title="Back to workspaces"
          >
            Workspaces
          </Link>
          <span className="top-divider" />
          <span className="workspace-name">{workspace?.name || "Web IDE"}</span>
        </div>
        <button
          className="command-search"
          onClick={() => openSidebar("search")}
        >
          <Search size={14} />
          <span>Search workspace</span>
          <kbd>Files</kbd>
        </button>
        <div className="top-actions">
          <AccountControls />
          <button
            className="button save-button"
            onClick={saveFile}
            disabled={
              !activeFile ||
              loadingFile ||
              Boolean(fileError) ||
              manualSaving ||
              running
            }
          >
            <Save size={14} />
            <span>Save</span>
          </button>
          <button
            className="button button-primary run-button"
            onClick={runFile}
            disabled={runDisabled}
            aria-busy={running}
            title="Save and run the current file (F5)"
          >
            {running ? (
              <LoaderCircle size={14} className="spin" />
            ) : (
              <Play size={14} fill="currentColor" />
            )}
            <span>
              {runStage === "saving" ? "Saving" : running ? "Running" : "Run"}
            </span>
            <kbd>F5</kbd>
          </button>
          <IconButton
            icon={Settings2}
            label="Open settings"
            onClick={() => openSidebar("settings")}
          />
        </div>
      </header>
      <div className="ide-body">
        <nav className="activity-bar" aria-label="Workspace views">
          <div>
            {[
              { id: "explorer", icon: Files, label: "Explorer" },
              { id: "search", icon: Search, label: "Search" },
            ].map(({ id, icon: Icon, label }) => (
              <IconButton
                key={id}
                icon={Icon}
                label={label}
                className={sidebarOpen && sidebarView === id ? "active" : ""}
                aria-pressed={sidebarOpen && sidebarView === id}
                onClick={() => {
                  if (sidebarOpen && sidebarView === id) setSidebarOpen(false);
                  else openSidebar(id);
                }}
              />
            ))}
          </div>
          <div>
            <IconButton
              icon={theme === "dark" ? Sun : Moon}
              label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            />
            <IconButton
              icon={Settings2}
              label="Settings"
              className={
                sidebarOpen && sidebarView === "settings" ? "active" : ""
              }
              onClick={() => openSidebar("settings")}
            />
            <span className="workspace-avatar" title={user.username}>
              {user.username.slice(0, 1).toUpperCase()}
            </span>
          </div>
        </nav>
        {sidebarOpen && (
          <>
            <button
              className="sidebar-backdrop"
              aria-label="Close sidebar overlay"
              onClick={() => setSidebarOpen(false)}
            />
            <aside className="sidebar" style={{ width: sidebarWidth }}>
              {sidebarView === "explorer" ? (
                <Explorer
                  tree={tree}
                  workspaceName={workspace?.name || "Workspace"}
                  loading={loading}
                  error={error}
                  expanded={expanded}
                  setExpanded={setExpanded}
                  selectedId={activeFile?.id}
                  selectedFolderId={selectedFolderId}
                  onSelect={selectFile}
                  onSelectFolder={setSelectedFolderId}
                  onToggle={toggleFolder}
                  onCreate={createItem}
                  onRename={renameItem}
                  onDelete={deleteItem}
                  onRefresh={refresh}
                  dirtyIds={dirtyIds}
                  busy={creating || running || manualSaving}
                  onClose={() => setSidebarOpen(false)}
                />
              ) : sidebarView === "search" ? (
                <SearchSidebar files={files} onSelect={selectFile} />
              ) : (
                <SettingsPanel
                  theme={theme}
                  setTheme={setTheme}
                  fontSize={fontSize}
                  setFontSize={setFontSize}
                  wordWrap={wordWrap}
                  setWordWrap={setWordWrap}
                />
              )}
              <ResizeHandle
                orientation="vertical"
                value={sidebarWidth}
                min={190}
                max={Math.max(190, Math.min(450, window.innerWidth - 350))}
                onChange={setSidebarWidth}
                label="Resize Explorer sidebar"
              />
            </aside>
          </>
        )}
        <section
          className={`editor-panel ${panelMaximized ? "panel-maximized" : ""}`}
        >
          <EditorTabs
            files={openedFiles}
            activeId={activeFile?.id}
            dirtyIds={dirtyIds}
            onSelect={selectFile}
            onClose={closeTab}
          />
          <div className="editor-toolbar">
            <div className="breadcrumbs">
              <IconButton
                icon={sidebarOpen ? PanelLeftClose : PanelLeftOpen}
                label="Toggle sidebar"
                onClick={() => setSidebarOpen(!sidebarOpen)}
              />
              <span>{workspace?.name || "Workspace"}</span>
              {activeFile && (
                <>
                  <ChevronRight size={12} />
                  <FileIcon file={activeFile} />
                  <span title={activePath}>{getFileName(activeFile)}</span>
                </>
              )}
            </div>
            <div className="toolbar-actions">
              {activeFile && <SaveIndicator status={saveStatus} />}
              <IconButton
                icon={Save}
                label="Save file (Ctrl+S)"
                onClick={saveFile}
                disabled={
                  !activeFile ||
                  loadingFile ||
                  Boolean(fileError) ||
                  manualSaving ||
                  running
                }
              />
              <IconButton
                icon={Play}
                label="Run file (F5)"
                onClick={runFile}
                disabled={runDisabled}
              />
            </div>
          </div>
          {saveError && (
            <div className="editor-alert" role="alert">
              <AlertCircle size={14} />
              <span>{saveError}</span>
              <IconButton
                icon={X}
                label="Dismiss save error"
                onClick={() => setSaveError("")}
              />
            </div>
          )}
          <div className="editor-area">
            {activeFile ? (
              <>
                <Suspense
                  fallback={
                    <div className="editor-loading">
                      <LoaderCircle className="spin" size={22} />
                      <span>Preparing your editor…</span>
                    </div>
                  }
                >
                  <Editor
                    workspaceId={workspaceId}
                    height="100%"
                    path={`file:///${workspaceId}/${activeFile.id}`}
                    saveViewState
                    keepCurrentModel
                    theme={`spark-${theme}`}
                    beforeMount={defineEditorThemes}
                    language={languageFor(activeFile)}
                    value={fileContent}
                    onChange={onEditorChange}
                    onMount={(editor) => {
                      editorRef.current = editor;
                      cursorSubscriptionRef.current?.dispose();
                      cursorSubscriptionRef.current =
                        editor.onDidChangeCursorPosition(({ position }) =>
                          setCursor({
                            line: position.lineNumber,
                            column: position.column,
                          }),
                        );
                    }}
                    onValidate={(markers) =>
                      setDiagnostics((current) => ({
                        ...current,
                        [activeFile.id]: markers.map((marker) => ({
                          fileId: activeFile.id,
                          filename: getFileName(activeFile),
                          message: marker.message,
                          line: marker.startLineNumber,
                        })),
                      }))
                    }
                    loading={
                      <div className="editor-loading">
                        <LoaderCircle className="spin" size={22} />
                        <span>Preparing your editor…</span>
                      </div>
                    }
                    options={{
                      fontSize,
                      fontFamily:
                        "'JetBrains Mono', 'SFMono-Regular', Consolas, monospace",
                      fontLigatures: true,
                      minimap: { enabled: false },
                      wordWrap: wordWrap ? "on" : "off",
                      readOnly: loadingFile || Boolean(fileError),
                      scrollBeyondLastLine: false,
                      automaticLayout: true,
                      padding: { top: 20, bottom: 20 },
                      lineNumbersMinChars: 4,
                      renderLineHighlight: "line",
                      overviewRulerBorder: false,
                      smoothScrolling: true,
                      cursorSmoothCaretAnimation: "on",
                      bracketPairColorization: { enabled: true },
                    }}
                  />
                </Suspense>
                {(loadingFile || fileError) && (
                  <div className="editor-overlay">
                    {loadingFile ? (
                      <LoaderCircle size={22} className="spin" />
                    ) : (
                      <AlertCircle size={22} />
                    )}
                    <p>{fileError || "Opening file…"}</p>
                  </div>
                )}
              </>
            ) : (
              <div className="welcome-state">
                <div className="welcome-logo">
                  <Code2 size={38} strokeWidth={1.2} />
                </div>
                <span className="eyebrow">YOUR SPACE TO BUILD</span>
                <h1>Make something great.</h1>
                <p>
                  Open a file, explore an idea, and bring it to life.
                  <br />
                  Your workspace is ready when you are.
                </p>
                <div className="welcome-actions">
                  <button
                    className="button button-primary"
                    onClick={() => createItem("file", null)}
                    disabled={loading || Boolean(error)}
                  >
                    <FilePlus2 size={15} />
                    Create a file
                    <ArrowRight size={14} />
                  </button>
                  <button
                    className="button"
                    onClick={() => openSidebar("explorer")}
                  >
                    <FolderOpen size={15} />
                    Explore files
                  </button>
                </div>
                <div className="welcome-shortcuts">
                  <span>
                    Save your work<kbd>Ctrl / ⌘ S</kbd>
                  </span>
                  <span>
                    Run a program<kbd>F5</kbd>
                  </span>
                  <span>
                    Toggle sidebar<kbd>Ctrl / ⌘ B</kbd>
                  </span>
                </div>
                {error && <p className="error-text">{error}</p>}
              </div>
            )}
          </div>
          <TerminalPanel
            ref={terminalRef}
            onInput={sendTerminalInput}
            onResize={sendTerminalResize}
            onStop={stopRun}
            running={running}
            runStage={runStage}
            theme={theme}
            problems={problems}
            onMaximize={setPanelMaximized}
            onProblemSelect={(problem) => {
              const file = findFileById(tree, problem.fileId);
              if (file) selectFile(file);
            }}
          />
        </section>
      </div>
      <footer className="statusbar">
        <div className="status-left">
          <span className="status-workspace">
            <Code2 size={12} />
            {workspace?.name || "Workspace"}
          </span>
          <button onClick={() => terminalRef.current?.reveal("problems")}>
            <AlertCircle size={12} />
            {problems.length} problems
          </button>
          <span className="status-file" title={activePath}>
            {activeFile ? getFileName(activeFile) : "No file open"}
          </span>
        </div>
        <div className="status-right">
          {activeFile && (
            <>
              <span className="cursor-status">
                Ln {cursor.line}, Col {cursor.column}
              </span>
              <SaveIndicator status={saveStatus} />
              <span>{languageFor(activeFile)}</span>
            </>
          )}
          <span className="encoding-status">UTF-8</span>
          <span className={`status-execution ${running ? "is-running" : ""}`}>
            <span className="connection-dot" />
            {runStage === "saving" ? "Saving…" : running ? "Running" : "Ready"}
          </span>
        </div>
      </footer>
      {actionMessage && (
        <div
          className={`toast ${actionError ? "toast-error" : ""}`}
          role={actionError ? "alert" : "status"}
        >
          {actionError ? <AlertCircle size={17} /> : <Check size={17} />}
          <span>{actionMessage}</span>
          <IconButton
            icon={X}
            label="Dismiss notification"
            onClick={() => setActionMessage("")}
          />
        </div>
      )}
      {dialog && (
        <ResourceDialog
          key={dialog.title}
          dialog={dialog}
          onClose={closeDialog}
        />
      )}
    </main>
  );
}
