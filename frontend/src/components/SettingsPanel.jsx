import { Moon, Sun } from "lucide-react";

export default function SettingsPanel({
  theme,
  setTheme,
  fontSize,
  setFontSize,
  wordWrap,
  setWordWrap,
}) {
  return (
    <>
      <div className="sidebar-heading">Settings</div>
      <div className="settings-content">
        <h3>Make it yours</h3>
        <p>A comfortable space for your next idea.</p>
        <label className="field-label">Appearance</label>
        <div className="theme-options">
          <button
            className={theme === "dark" ? "selected" : ""}
            onClick={() => setTheme("dark")}
            aria-pressed={theme === "dark"}
          >
            <Moon size={18} />
            Dark
          </button>
          <button
            className={theme === "light" ? "selected" : ""}
            onClick={() => setTheme("light")}
            aria-pressed={theme === "light"}
          >
            <Sun size={18} />
            Light
          </button>
        </div>
        <label className="field-label" htmlFor="editor-font-size">
          Editor font size <span>{fontSize}px</span>
        </label>
        <input
          id="editor-font-size"
          type="range"
          min="11"
          max="22"
          value={fontSize}
          onChange={(event) => setFontSize(Number(event.target.value))}
        />
        <label className="setting-toggle">
          <span>
            Word wrap<small>Keep long lines in view</small>
          </span>
          <input
            type="checkbox"
            checked={wordWrap}
            onChange={(event) => setWordWrap(event.target.checked)}
          />
        </label>
        <div className="settings-shortcuts">
          <h4>Keyboard shortcuts</h4>
          <span>
            Save file <kbd>Ctrl / ⌘ S</kbd>
          </span>
          <span>
            Run file <kbd>F5</kbd>
          </span>
          <span>
            Toggle sidebar <kbd>Ctrl / ⌘ B</kbd>
          </span>
        </div>
      </div>
    </>
  );
}
