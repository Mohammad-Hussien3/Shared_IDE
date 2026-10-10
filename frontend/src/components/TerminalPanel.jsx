import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

const MIN_HEIGHT = 130;

const TerminalPanel = forwardRef(function TerminalPanel({ onInput, onResize, onStop, running }, ref) {
  const containerRef = useRef(null);
  const terminalRef = useRef(null);
  const onInputRef = useRef(onInput);
  const onResizeRef = useRef(onResize);
  const [height, setHeight] = useState(220);

  useEffect(() => {
    onInputRef.current = onInput;
    onResizeRef.current = onResize;
  }, [onInput, onResize]);

  useImperativeHandle(ref, () => ({
    write(value) {
      const terminal = terminalRef.current;
      terminal?.write(value, () => terminal.scrollToBottom());
    },
    clear() {
      terminalRef.current?.clear();
    },
    focus() {
      terminalRef.current?.focus();
    },
    getDimensions() {
      return { cols: terminalRef.current?.cols || 80, rows: terminalRef.current?.rows || 24 };
    },
  }), []);

  useEffect(() => {
    const terminal = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontFamily: "'JetBrains Mono', 'SFMono-Regular', Consolas, monospace",
      fontSize: 12,
      lineHeight: 1.3,
      scrollback: 1000,
      theme: {
        background: "#1c1d22",
        foreground: "#d4d5dc",
        cursor: "#a593ff",
        selectionBackground: "#6555ad80",
      },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(containerRef.current);
    terminalRef.current = terminal;

    const inputSubscription = terminal.onData((data) => onInputRef.current(data));
    const resizeSubscription = terminal.onResize(({ cols, rows }) => onResizeRef.current(cols, rows));
    const observer = new ResizeObserver(() => {
      if (containerRef.current?.clientWidth && containerRef.current?.clientHeight) {
        fitAddon.fit();
      }
    });
    observer.observe(containerRef.current);
    const fitFrame = requestAnimationFrame(() => fitAddon.fit());

    return () => {
      cancelAnimationFrame(fitFrame);
      observer.disconnect();
      inputSubscription.dispose();
      resizeSubscription.dispose();
      terminalRef.current = null;
      terminal.dispose();
    };
  }, []);

  const beginResize = (event) => {
    event.preventDefault();
    const handle = event.currentTarget;
    const startY = event.clientY;
    const startHeight = height;
    handle.setPointerCapture(event.pointerId);

    const move = (moveEvent) => {
      const maxHeight = Math.max(MIN_HEIGHT, window.innerHeight - 180);
      setHeight(Math.max(MIN_HEIGHT, Math.min(maxHeight, startHeight + startY - moveEvent.clientY)));
    };
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
    <section className="terminal-panel" style={{ height }} aria-label="Program terminal">
      <div className="terminal-resize" onPointerDown={beginResize} role="separator" aria-label="Resize terminal" aria-orientation="horizontal" />
      <div className="terminal-heading">
        <span>Terminal</span>
        <div className="terminal-actions">
          <button type="button" onClick={() => terminalRef.current?.clear()}>Clear Terminal</button>
          <button type="button" onClick={onStop} disabled={!running}>Stop</button>
        </div>
      </div>
      <div className="terminal-screen" ref={containerRef} />
    </section>
  );
});

export default TerminalPanel;
