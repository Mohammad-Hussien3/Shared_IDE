import { act, render } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import CodeEditor from "./CodeEditor";
import { monaco } from "../lib/monaco";
import Editor from "@monaco-editor/react";

vi.mock("../lib/monaco", () => ({ monaco: { editor: { getModels: vi.fn(() => []) } } }));
vi.mock("@monaco-editor/react", () => ({ default: vi.fn(() => null) }));

it("keeps editor callbacks, model path, view state, and options while responding to reduced motion", () => {
  const original = window.matchMedia;
  const query = { matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() };
  window.matchMedia = vi.fn(() => query);
  try {
    const props = {
      workspaceId: "private", path: "file:///private/file-one", theme: "spark-dark", language: "python",
      value: "print('hello')", onChange: vi.fn(), onMount: vi.fn(), onValidate: vi.fn(),
      keepCurrentModel: true, saveViewState: true,
      options: { fontSize: 15, smoothScrolling: true, cursorSmoothCaretAnimation: "on", readOnly: false },
    };
    const { rerender, unmount } = render(<CodeEditor {...props} />);
    expect(Editor.mock.calls.at(-1)[0]).toMatchObject({
      path: props.path, value: props.value, onChange: props.onChange, onMount: props.onMount,
      onValidate: props.onValidate, keepCurrentModel: true, saveViewState: true, options: props.options,
    });
    act(() => { query.matches = true; query.addEventListener.mock.calls[0][1](); });
    expect(Editor.mock.calls.at(-1)[0].options).toMatchObject({ fontSize: 15, readOnly: false, smoothScrolling: false, cursorSmoothCaretAnimation: "off" });
    rerender(<CodeEditor {...props} theme="spark-light" />);
    expect(Editor.mock.calls.at(-1)[0].theme).toBe("spark-light");
    expect(monaco.editor.getModels).not.toHaveBeenCalled();
    act(() => { query.matches = false; query.addEventListener.mock.calls[0][1](); });
    expect(Editor.mock.calls.at(-1)[0].options.smoothScrolling).toBe(true);
    unmount();
    expect(query.removeEventListener).toHaveBeenCalledWith("change", query.addEventListener.mock.calls[0][1]);
  } finally { window.matchMedia = original; }
});

it("disposes only the departing workspace's models", () => {
  const own = { uri: { toString: () => "file:///one/file" }, dispose: vi.fn() };
  const other = { uri: { toString: () => "file:///two/file" }, dispose: vi.fn() };
  monaco.editor.getModels.mockReturnValue([own, other]);
  const { unmount } = render(<CodeEditor workspaceId="one" />);
  unmount();
  expect(own.dispose).toHaveBeenCalledOnce();
  expect(other.dispose).not.toHaveBeenCalled();
});
