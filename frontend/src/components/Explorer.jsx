import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  FilePlus2,
  Folder,
  FolderOpen,
  FolderPlus,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { FileIcon, IconButton } from "./IdePrimitives";
import { findParentId, getFileName } from "../lib/ideFiles";

function TreeNode({ node, depth = 0, ...props }) {
  const folder = node.type === "folder";
  const open = props.expanded.has(node.id);
  const selected = folder
    ? props.selectedFolderId === node.id
    : props.selectedId === node.id;
  return (
    <div className="tree-node">
      <div
        className={`tree-line ${selected ? "selected" : ""}`}
        style={{ "--depth": depth }}
        onContextMenu={(event) => props.onContext(event, node)}
      >
        <button
          className="tree-row"
          title={folder ? node.name : getFileName(node)}
          aria-expanded={folder ? open : undefined}
          onClick={() => (folder ? props.onFolder(node) : props.onSelect(node))}
        >
          <span className="tree-chevron">
            {folder && (
              <ChevronRight size={13} className={open ? "rotated" : ""} />
            )}
          </span>
          {folder ? (
            open ? (
              <FolderOpen size={16} className="folder-icon" />
            ) : (
              <Folder size={16} className="folder-icon" />
            )
          ) : (
            <FileIcon file={node} />
          )}
          <span className="tree-name">
            {folder ? node.name : getFileName(node)}
          </span>
          {!folder && props.dirtyIds.has(node.id) && (
            <span className="dirty-dot" />
          )}
        </button>
        <div className="tree-hover-actions">
          {folder && (
            <IconButton
              icon={FilePlus2}
              label={`New file in ${node.name}`}
              onClick={() => props.onCreate("file", node.id)}
              disabled={props.busy}
            />
          )}
          {folder && (
            <IconButton
              icon={FolderPlus}
              label={`New folder in ${node.name}`}
              onClick={() => props.onCreate("folder", node.id)}
              disabled={props.busy}
            />
          )}
          <IconButton
            icon={MoreHorizontal}
            label={`Actions for ${node.name}`}
            onClick={(event) => props.onContext(event, node)}
          />
        </div>
      </div>
      {folder && open && (
        <div className="tree-children">
          {(node.children || []).map((child) => (
            <TreeNode
              key={child.id}
              node={child}
              depth={depth + 1}
              {...props}
            />
          ))}
          {!node.children?.length && (
            <div className="empty-folder" style={{ "--depth": depth + 1 }}>
              Empty folder
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function Explorer({
  tree,
  workspaceName,
  loading,
  error,
  expanded,
  setExpanded,
  selectedId,
  selectedFolderId,
  onSelect,
  onSelectFolder,
  onToggle,
  onCreate,
  onRename,
  onDelete,
  onRefresh,
  dirtyIds,
  busy,
  onClose,
}) {
  const [context, setContext] = useState(null);
  const menuRef = useRef(null);
  useEffect(() => {
    if (!context) return;
    menuRef.current?.querySelector("button")?.focus();
    const dismiss = (event) => {
      if (!menuRef.current?.contains(event.target)) setContext(null);
    };
    const escape = (event) => {
      if (event.key === "Escape") setContext(null);
    };
    window.addEventListener("pointerdown", dismiss);
    window.addEventListener("keydown", escape);
    window.addEventListener("resize", dismiss);
    return () => {
      window.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("keydown", escape);
      window.removeEventListener("resize", dismiss);
    };
  }, [context]);
  const onContext = (event, node = null) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    setContext({
      node,
      x: Math.max(
        8,
        Math.min(event.clientX || rect.right, window.innerWidth - 210),
      ),
      y: Math.max(
        8,
        Math.min(event.clientY || rect.bottom, window.innerHeight - 200),
      ),
    });
  };
  const destination =
    context?.node?.type === "folder"
      ? context.node.id
      : context?.node
        ? findParentId(tree, context.node.id)
        : null;
  const act = (callback) => {
    setContext(null);
    callback();
  };
  return (
    <>
      <div className="sidebar-heading">
        <span>Explorer</span>
        <div className="toolbar-actions">
          <IconButton
            icon={RefreshCw}
            label="Refresh Explorer"
            onClick={onRefresh}
            disabled={loading}
          />
          <IconButton
            icon={ChevronsDownUp}
            label="Collapse all folders"
            onClick={() => setExpanded(new Set())}
          />
          <IconButton
            icon={X}
            label="Close sidebar"
            className="mobile-only"
            onClick={onClose}
          />
        </div>
      </div>
      <div
        className={`workspace-root ${selectedFolderId === null ? "root-selected" : ""}`}
        onContextMenu={(event) => onContext(event)}
      >
        <button
          onClick={() => onSelectFolder(null)}
          title="Select workspace root"
          aria-label="Select workspace root"
        >
          <ChevronDown size={14} />
          <span>{workspaceName}</span>
        </button>
        <div className="toolbar-actions">
          <IconButton
            icon={FilePlus2}
            label="New File"
            onClick={() => onCreate("file", selectedFolderId)}
            disabled={busy || loading || Boolean(error)}
          />
          <IconButton
            icon={FolderPlus}
            label="New Folder"
            onClick={() => onCreate("folder", selectedFolderId)}
            disabled={busy || loading || Boolean(error)}
          />
        </div>
      </div>
      <div
        className="tree-scroll"
        onContextMenu={(event) => {
          if (event.target === event.currentTarget) onContext(event);
        }}
      >
        {loading ? (
          <div className="tree-skeleton">
            {[70, 90, 60, 80, 50].map((width, index) => (
              <span key={index} style={{ width: `${width}%` }} />
            ))}
          </div>
        ) : error ? (
          <div className="sidebar-empty">
            <p className="error-text">{error}</p>
            <button className="button" onClick={onRefresh}>
              Try again
            </button>
          </div>
        ) : tree.length ? (
          tree.map((node) => (
            <TreeNode
              key={node.id}
              node={node}
              expanded={expanded}
              selectedId={selectedId}
              selectedFolderId={selectedFolderId}
              dirtyIds={dirtyIds}
              onSelect={onSelect}
              onFolder={(folder) => {
                onSelectFolder(folder.id);
                onToggle(folder.id);
              }}
              onCreate={onCreate}
              onContext={onContext}
              busy={busy}
            />
          ))
        ) : (
          <div className="sidebar-empty">
            <FolderOpen size={28} />
            <h3>A fresh workspace</h3>
            <p>Create your first file to start building.</p>
            <button className="button" onClick={() => onCreate("file", null)}>
              <FilePlus2 size={14} />
              New file
            </button>
          </div>
        )}
      </div>
      <div className="sidebar-footer">
        <span className="connection-dot" />
        {selectedFolderId
          ? "New items go in selected folder"
          : "Workspace root selected"}
      </div>
      {context && (
        <div
          className="context-menu"
          ref={menuRef}
          role="menu"
          style={{ left: context.x, top: context.y }}
          onKeyDown={(event) => {
            if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
            event.preventDefault();
            const buttons = [...menuRef.current.querySelectorAll("button")];
            const index = buttons.indexOf(document.activeElement);
            buttons[
              (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) %
                buttons.length
            ]?.focus();
          }}
        >
          <button
            disabled={busy}
            role="menuitem"
            onClick={() => act(() => onCreate("file", destination))}
          >
            <FilePlus2 size={15} />
            New File
          </button>
          <button
            disabled={busy}
            role="menuitem"
            onClick={() => act(() => onCreate("folder", destination))}
          >
            <FolderPlus size={15} />
            New Folder
          </button>
          {context.node && (
            <>
              <div className="menu-divider" />
              <button
                disabled={busy}
                role="menuitem"
                onClick={() => act(() => onRename(context.node))}
              >
                <Pencil size={15} />
                Rename
              </button>
              <button
                disabled={busy}
                role="menuitem"
                className="danger-text"
                onClick={() => act(() => onDelete(context.node))}
              >
                <Trash2 size={15} />
                Delete
              </button>
            </>
          )}
        </div>
      )}
    </>
  );
}

export function SearchSidebar({ files, onSelect }) {
  const [query, setQuery] = useState("");
  const results = query.trim()
    ? files.filter((file) =>
        `${file.path} ${getFileName(file)}`
          .toLowerCase()
          .includes(query.toLowerCase()),
      )
    : [];
  return (
    <>
      <div className="sidebar-heading">Search files</div>
      <div className="search-field">
        <Search size={15} />
        <input
          autoFocus
          aria-label="Search workspace files"
          placeholder="Find a file…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {query && (
          <IconButton
            icon={X}
            label="Clear search"
            onClick={() => setQuery("")}
          />
        )}
      </div>
      <div className="tree-scroll">
        {query ? (
          <>
            <p className="search-caption">
              {results.length} {results.length === 1 ? "file" : "files"} found
            </p>
            {results.map((file) => (
              <button
                className="search-result"
                key={file.id}
                onClick={() => onSelect(file)}
                title={file.path}
              >
                <FileIcon file={file} />
                <span>
                  <strong>{getFileName(file)}</strong>
                  <small>{file.path}</small>
                </span>
              </button>
            ))}
          </>
        ) : (
          <div className="sidebar-empty">
            <Search size={26} />
            <p>Find files by name or path in this workspace.</p>
          </div>
        )}
      </div>
    </>
  );
}
