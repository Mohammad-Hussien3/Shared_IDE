import { useEffect, useRef, useState } from "react";
import {
  Braces,
  Check,
  Code2,
  FileCode2,
  FileJson2,
  FileText,
  LoaderCircle,
  X,
} from "lucide-react";
import { languageFor } from "../lib/ideFiles";

export function IconButton({ icon: Icon, label, className = "", ...props }) {
  return (
    <button
      type="button"
      className={`icon-button ${className}`}
      title={label}
      aria-label={label}
      {...props}
    >
      <Icon size={16} strokeWidth={1.7} />
    </button>
  );
}

export function FileIcon({ file, size = 16 }) {
  const language = languageFor(file);
  const Icon =
    language === "json"
      ? FileJson2
      : ["python", "c", "cpp", "java"].includes(language)
        ? FileCode2
        : ["javascript", "typescript", "css"].includes(language)
          ? Braces
          : language === "html"
            ? Code2
            : FileText;
  return (
    <Icon
      size={size}
      strokeWidth={1.6}
      className={`file-icon language-${language}`}
      aria-hidden="true"
    />
  );
}

export function SaveIndicator({ status = "Saved" }) {
  return (
    <span
      className={`save-indicator ${status === "Unsaved" ? "is-dirty" : ""}`}
    >
      {status === "Saving…" ? (
        <LoaderCircle size={12} className="spin" />
      ) : status === "Unsaved" ? (
        <span className="dirty-dot" />
      ) : (
        <Check size={12} />
      )}
      {status}
    </span>
  );
}

export function ResizeHandle({
  orientation,
  value,
  min,
  max,
  onChange,
  label,
}) {
  const vertical = orientation === "vertical";
  const begin = (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const start = vertical ? event.clientX : event.clientY;
    handle.setPointerCapture(event.pointerId);
    const move = (next) =>
      onChange(
        Math.max(
          min,
          Math.min(
            max,
            value + (vertical ? next.clientX - start : start - next.clientY),
          ),
        ),
      );
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  };
  return (
    <div
      className={`resize-handle resize-${orientation}`}
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation={orientation}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      onPointerDown={begin}
      onKeyDown={(event) => {
        const direction = vertical
          ? { ArrowLeft: -20, ArrowRight: 20 }
          : { ArrowDown: -20, ArrowUp: 20 };
        if (direction[event.key]) {
          event.preventDefault();
          onChange(Math.max(min, Math.min(max, value + direction[event.key])));
        }
      }}
    />
  );
}

export function ResourceDialog({ dialog, onClose }) {
  const ref = useRef(null);
  const [value, setValue] = useState(dialog.value || "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const element = ref.current;
    element.showModal();
    return () => element.close();
  }, []);
  const submit = async (event) => {
    event.preventDefault();
    if (pending || (!dialog.confirmOnly && !value.trim())) return;
    setPending(true);
    setError("");
    try {
      await dialog.onSubmit(value.trim());
      onClose();
    } catch (err) {
      setError(err.message || "Something went wrong. Please try again.");
    } finally {
      setPending(false);
    }
  };
  return (
    <dialog
      ref={ref}
      className="resource-dialog"
      aria-labelledby="dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!pending) onClose();
      }}
    >
      <form onSubmit={submit}>
        <div className="dialog-heading">
          <h2 id="dialog-title">{dialog.title}</h2>
          <IconButton
            icon={X}
            label="Close dialog"
            disabled={pending}
            onClick={onClose}
          />
        </div>
        <p>{dialog.description}</p>
        {!dialog.confirmOnly && (
          <label className="field-label">
            {dialog.label || "Name"}
            {dialog.options ? (
              <select
                autoFocus
                value={value}
                onChange={(event) => setValue(event.target.value)}
              >
                {dialog.options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            ) : (
              <input
                autoFocus
                aria-label={dialog.label || "Name"}
                value={value}
                placeholder={dialog.placeholder}
                onChange={(event) => setValue(event.target.value)}
                onFocus={(event) => event.target.select()}
                disabled={pending}
                required
              />
            )}
          </label>
        )}
        {error && (
          <div className="inline-error" role="alert">
            {error}
          </div>
        )}
        <div className="dialog-actions">
          <button
            type="button"
            className="button"
            onClick={onClose}
            disabled={pending}
          >
            Cancel
          </button>
          <button
            className={`button ${dialog.danger ? "button-danger" : "button-primary"}`}
            disabled={pending || (!dialog.confirmOnly && !value.trim())}
          >
            {pending && <LoaderCircle size={14} className="spin" />}
            {pending ? "Working…" : dialog.submitLabel || "Save"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
