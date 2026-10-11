import { X } from "lucide-react";
import { FileIcon, IconButton } from "./IdePrimitives";
import { getFileName } from "../lib/ideFiles";

export default function EditorTabs({
  files,
  activeId,
  dirtyIds,
  onSelect,
  onClose,
}) {
  return (
    <div className="tab-strip" role="tablist" aria-label="Open files">
      {files.length ? (
        files.map((file) => (
          <div
            className={`editor-tab ${file.id === activeId ? "active-tab" : ""}`}
            key={file.id}
          >
            <button
              role="tab"
              aria-selected={file.id === activeId}
              title={getFileName(file)}
              onClick={() => onSelect(file)}
            >
              <FileIcon file={file} />
              <span>{getFileName(file)}</span>
              {dirtyIds.has(file.id) && (
                <span className="dirty-dot" aria-label="Unsaved changes" />
              )}
            </button>
            <IconButton
              icon={X}
              label={`Close ${getFileName(file)}`}
              onClick={() => onClose(file)}
            />
          </div>
        ))
      ) : (
        <span className="tab-empty">Workspace</span>
      )}
    </div>
  );
}
