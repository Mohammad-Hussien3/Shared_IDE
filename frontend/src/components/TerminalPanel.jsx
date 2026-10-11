import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Circle,
  ListFilter,
  Maximize2,
  Minimize2,
  Square,
  TerminalSquare,
  Trash2,
} from "lucide-react";
import { IconButton, ResizeHandle } from "./IdePrimitives";
import "@xterm/xterm/css/xterm.css";

const THEMES = {
  dark: {
    background: "#111419",
    foreground: "#c9d1dd",
    cursor: "#8fa9ff",
    selectionBackground: "#5269a755",
    red: "#f08080",
    green: "#87cfa8",
  },
  light: {
    background: "#ffffff",
    foreground: "#354052",
    cursor: "#4869cc",
    selectionBackground: "#b9caff88",
    red: "#c13c46",
    green: "#237b52",
  },
};
// Terminal output intentionally contains ANSI control sequences.
const stripAnsi = (text) =>
  // eslint-disable-next-line no-control-regex
  text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\r/g, "");

const TerminalPanel = forwardRef(function TerminalPanel(
  {
    onInput,
    onResize,
    onStop,
    running,
    runStage,
    theme,
    problems = [],
    onProblemSelect,
    onMaximize,
  },
  ref,
) {
  const containerRef = useRef(null);
  const terminalRef = useRef(null);
  const handlersRef = useRef({ onInput, onResize });
  const followRef = useRef(true);
  const outputRef = useRef(null);
  const followOutputRef = useRef(true);
  const [height, setHeight] = useState(240);
  const [tab, setTab] = useState("terminal");
  const [collapsed, setCollapsed] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [output, setOutput] = useState("");

  useEffect(() => {
    handlersRef.current = { onInput, onResize };
  }, [onInput, onResize]);
  useEffect(() => {
    if (tab === "output" && followOutputRef.current && outputRef.current)
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [output, tab]);

  useImperativeHandle(
    ref,
    () => ({
      write(value) {
        const terminal = terminalRef.current;
        const follow = followRef.current;
        terminal?.write(value, () => {
          if (follow) terminal.scrollToBottom();
        });
        setOutput((current) => (current + stripAnsi(value)).slice(-100000));
      },
      clear() {
        terminalRef.current?.reset();
        setOutput("");
        followRef.current = true;
        followOutputRef.current = true;
      },
      reveal(nextTab = "terminal") {
        setCollapsed(false);
        setTab(nextTab);
      },
      focus() {
        terminalRef.current?.focus();
      },
      getDimensions() {
        return {
          cols: terminalRef.current?.cols || 80,
          rows: terminalRef.current?.rows || 24,
        };
      },
    }),
    [],
  );

  useEffect(() => {
    const terminal = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontFamily: "'JetBrains Mono', 'SFMono-Regular', Consolas, monospace",
      fontSize: 12,
      lineHeight: 1.45,
      scrollback: 3000,
      theme: THEMES.dark,
      allowProposedApi: false,
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(containerRef.current);
    terminalRef.current = terminal;
    terminal.options.theme =
      THEMES[document.documentElement.dataset.theme || "dark"];
    const inputSubscription = terminal.onData((data) =>
      handlersRef.current.onInput(data),
    );
    const resizeSubscription = terminal.onResize(({ cols, rows }) =>
      handlersRef.current.onResize(cols, rows),
    );
    const scrollSubscription = terminal.onScroll(() => {
      followRef.current =
        terminal.buffer.active.viewportY >= terminal.buffer.active.baseY;
    });
    const fit = () => {
      if (
        containerRef.current?.clientWidth &&
        containerRef.current?.clientHeight
      )
        fitAddon.fit();
    };
    const observer = new ResizeObserver(fit);
    observer.observe(containerRef.current);
    const fitFrame = requestAnimationFrame(fit);
    return () => {
      cancelAnimationFrame(fitFrame);
      observer.disconnect();
      inputSubscription.dispose();
      resizeSubscription.dispose();
      scrollSubscription.dispose();
      terminalRef.current = null;
      terminal.dispose();
    };
  }, []);

  useEffect(() => {
    if (terminalRef.current) terminalRef.current.options.theme = THEMES[theme];
  }, [theme]);

  const toggleMaximize = () => {
    const next = !maximized;
    setMaximized(next);
    setCollapsed(false);
    onMaximize(next);
  };
  const toggleCollapse = () => {
    setCollapsed(!collapsed);
    if (maximized) {
      setMaximized(false);
      onMaximize(false);
    }
  };
  const clear = () => {
    if (tab === "terminal") terminalRef.current?.reset();
    else setOutput("");
    followRef.current = true;
    followOutputRef.current = true;
  };

  return (
    <section
      className={`terminal-panel ${collapsed ? "is-collapsed" : ""} ${maximized ? "is-maximized" : ""}`}
      style={!collapsed && !maximized ? { height } : undefined}
      aria-label="Bottom panel"
    >
      {!collapsed && !maximized && (
        <ResizeHandle
          orientation="horizontal"
          value={height}
          min={140}
          max={Math.max(160, window.innerHeight - 220)}
          onChange={setHeight}
          label="Resize bottom panel"
        />
      )}
      <div className="panel-heading">
        <div
          className="panel-tabs"
          role="tablist"
          aria-label="Bottom panel tabs"
        >
          {[
            { id: "terminal", label: "Terminal", icon: TerminalSquare },
            { id: "output", label: "Output", icon: ListFilter },
            { id: "problems", label: "Problems", icon: AlertCircle },
          ].map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              className={tab === id ? "active" : ""}
              onClick={() => {
                setTab(id);
                setCollapsed(false);
              }}
            >
              <Icon size={13} />
              <span>{label}</span>
              {id === "problems" && (
                <span className="count-badge">{problems.length}</span>
              )}
            </button>
          ))}
        </div>
        <div className="panel-controls">
          <span className={`execution-label ${running ? "is-running" : ""}`}>
            <Circle size={6} fill="currentColor" />
            {runStage === "saving" ? "Saving" : running ? "Running" : "Ready"}
          </span>
          <IconButton
            icon={Trash2}
            label={tab === "output" ? "Clear output" : "Clear Terminal"}
            onClick={clear}
            disabled={tab === "problems"}
          />
          <IconButton
            icon={Square}
            label="Stop execution"
            disabled={!running || runStage === "saving"}
            onClick={onStop}
          />
          <IconButton
            icon={maximized ? Minimize2 : Maximize2}
            label={maximized ? "Restore panel" : "Maximize panel"}
            onClick={toggleMaximize}
          />
          <IconButton
            icon={collapsed ? ChevronUp : ChevronDown}
            label={collapsed ? "Expand panel" : "Collapse panel"}
            onClick={toggleCollapse}
          />
        </div>
      </div>
      <div className={`panel-content ${collapsed ? "hidden" : ""}`}>
        <div
          className={`terminal-content ${tab !== "terminal" ? "hidden" : ""}`}
          role="tabpanel"
          aria-label="Terminal"
        >
          <div className="terminal-session">
            <TerminalSquare size={12} />
            <span>
              {running
                ? "Program is running · type below to send input"
                : "Program terminal"}
            </span>
            <span className="session-tag">{running ? "active" : "idle"}</span>
          </div>
          <div className="terminal-screen" ref={containerRef} />
        </div>
        <div
          className={`output-content ${tab !== "output" ? "hidden" : ""}`}
          role="tabpanel"
          aria-label="Output"
          ref={outputRef}
          onScroll={(event) => {
            const el = event.currentTarget;
            followOutputRef.current =
              el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          }}
        >
          {output ? (
            <pre>{output}</pre>
          ) : (
            <div className="panel-empty">
              <ListFilter size={24} />
              <p>No output yet</p>
              <span>Run a file to see its execution log here.</span>
            </div>
          )}
        </div>
        <div
          className={`problems-content ${tab !== "problems" ? "hidden" : ""}`}
          role="tabpanel"
          aria-label="Problems"
        >
          {problems.length ? (
            problems.map((problem, index) => (
              <button
                className="problem-row"
                key={`${problem.fileId}-${index}`}
                onClick={() => onProblemSelect?.(problem)}
              >
                <AlertCircle size={14} />
                <span>
                  {problem.message}
                  <small>
                    {problem.filename}
                    {problem.line ? ` · line ${problem.line}` : ""}
                  </small>
                </span>
              </button>
            ))
          ) : (
            <div className="panel-empty">
              <CheckCircle2 size={25} />
              <p>All clear</p>
              <span>No editor diagnostics or execution errors.</span>
            </div>
          )}
        </div>
      </div>
    </section>
  );
});

export default TerminalPanel;
