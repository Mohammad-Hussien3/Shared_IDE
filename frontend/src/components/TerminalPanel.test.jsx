import { createRef } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import TerminalPanel from "./TerminalPanel";
import { MockTerminal } from "../test/terminalMock";

beforeEach(() => {
  MockTerminal.instances = [];
});
function mount(overrides = {}) {
  const ref = createRef();
  const props = {
    onInput: vi.fn(),
    onResize: vi.fn(),
    onStop: vi.fn(),
    onMaximize: vi.fn(),
    onProblemSelect: vi.fn(),
    running: false,
    theme: "dark",
    ...overrides,
  };
  const view = render(<TerminalPanel ref={ref} {...props} />);
  return { ref, props, terminal: MockTerminal.instances.at(-1), ...view };
}
const click = (name) =>
  fireEvent.click(screen.getByRole("button", { name, exact: true }));

it("streams stdout/stderr into terminal and strips ANSI for Output", () => {
  const { ref, terminal } = mount();
  act(() => ref.current.write("hello\r\n\x1b[31merror\x1b[0m"));
  expect(terminal.write).toHaveBeenCalledWith(
    "hello\r\n\x1b[31merror\x1b[0m",
    expect.any(Function),
  );
  fireEvent.click(screen.getByRole("tab", { name: "Output" }));
  expect(screen.getByRole("tabpanel", { name: "Output" })).toHaveTextContent(
    "hello error",
  );
  expect(
    screen.getByRole("tabpanel", { name: "Output" }).textContent,
  ).not.toContain("\x1b");
});

it("forwards keyboard data and resize events using the latest callbacks", () => {
  const { props, terminal, rerender } = mount({ running: true });
  act(() => {
    terminal.input("hello\r");
    terminal.resize({ cols: 100, rows: 30 });
  });
  expect(props.onInput).toHaveBeenCalledWith("hello\r");
  expect(props.onResize).toHaveBeenCalledWith(100, 30);
  const next = vi.fn();
  rerender(<TerminalPanel {...props} onInput={next} />);
  act(() => terminal.input("new\r"));
  expect(next).toHaveBeenCalledWith("new\r");
  expect(MockTerminal.instances).toHaveLength(1);
});

it("switches tabs without replacing the active terminal session", () => {
  const { ref, terminal } = mount({ running: true });
  for (const name of ["Output", /Problems/, "Terminal"])
    fireEvent.click(screen.getByRole("tab", { name }));
  act(() => ref.current.write("still running"));
  expect(MockTerminal.instances).toHaveLength(1);
  expect(terminal.dispose).not.toHaveBeenCalled();
  expect(screen.getByTestId("terminal-screen")).toHaveTextContent(
    "still running",
  );
});

it("follows output unless the user has scrolled up", () => {
  const { ref, terminal } = mount();
  act(() => ref.current.write("one"));
  expect(terminal.scrollToBottom).toHaveBeenCalledTimes(1);
  terminal.buffer.active = { viewportY: 0, baseY: 20 };
  act(() => terminal.scroll());
  act(() => ref.current.write("two"));
  expect(terminal.scrollToBottom).toHaveBeenCalledTimes(1);
  terminal.buffer.active.viewportY = 20;
  act(() => terminal.scroll());
  act(() => ref.current.write("three"));
  expect(terminal.scrollToBottom).toHaveBeenCalledTimes(2);
});

it("enables Stop only for execution, not during saving or when idle", () => {
  const { props, rerender } = mount();
  expect(screen.getByRole("button", { name: "Stop execution" })).toBeDisabled();
  rerender(<TerminalPanel {...props} running runStage="saving" />);
  expect(screen.getByRole("button", { name: "Stop execution" })).toBeDisabled();
  rerender(<TerminalPanel {...props} running runStage="running" />);
  click("Stop execution");
  expect(props.onStop).toHaveBeenCalledOnce();
});

it("clears each output view and resets both at the start of a fresh run", () => {
  const { ref, terminal } = mount();
  act(() => ref.current.write("old output"));
  click("Clear Terminal");
  expect(terminal.reset).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("tab", { name: "Output" }));
  expect(screen.getByRole("tabpanel", { name: "Output" })).toHaveTextContent(
    "old output",
  );
  click("Clear output");
  expect(screen.getByText("No output yet")).toBeInTheDocument();
  act(() => {
    ref.current.write("fresh");
    ref.current.clear();
  });
  expect(screen.getByTestId("terminal-screen")).toBeEmptyDOMElement();
});

it("maximizes, collapses, reveals and resizes the panel", () => {
  const { ref, props, container } = mount();
  const separator = screen.getByRole("separator");
  fireEvent.keyDown(separator, { key: "ArrowUp" });
  expect(container.querySelector(".terminal-panel")).toHaveStyle({
    height: "260px",
  });
  click("Maximize panel");
  expect(props.onMaximize).toHaveBeenLastCalledWith(true);
  click("Collapse panel");
  expect(props.onMaximize).toHaveBeenLastCalledWith(false);
  expect(container.querySelector(".panel-content")).toHaveClass("hidden");
  act(() => ref.current.reveal("output"));
  expect(container.querySelector(".panel-content")).not.toHaveClass("hidden");
  expect(screen.getByRole("tab", { name: "Output" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

it("displays problems and forwards selection", () => {
  const problem = {
    fileId: "one",
    filename: "main.py",
    line: 3,
    message: "Syntax error",
  };
  const { props } = mount({ problems: [problem] });
  fireEvent.click(screen.getByRole("tab", { name: /Problems/ }));
  fireEvent.click(screen.getByRole("button", { name: /Syntax error/ }));
  expect(props.onProblemSelect).toHaveBeenCalledWith(problem);
});

it("applies themes and disposes subscriptions on unmount", () => {
  const { terminal, props, rerender, unmount, ref } = mount({ theme: "light" });
  expect(terminal.options.theme.background).toBe("#ffffff");
  rerender(<TerminalPanel ref={ref} {...props} theme="dark" />);
  expect(terminal.options.theme.background).toBe("#111419");
  expect(ref.current.getDimensions()).toEqual({ cols: 80, rows: 24 });
  act(() => ref.current.focus());
  expect(terminal.focus).toHaveBeenCalled();
  unmount();
  expect(terminal.dispose).toHaveBeenCalledOnce();
  terminal.subscriptions.forEach((subscription) =>
    expect(subscription.dispose).toHaveBeenCalledOnce(),
  );
});
