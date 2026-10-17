import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import WorkspacePage from "./WorkspacePage";
import { MemoryRouter } from "react-router-dom";
import { AuthContext } from "../auth/context";
import { WORKSPACE_ID } from "../test/workspaceFixtures";
import { MockTerminal } from "../test/terminalMock";
import {
  apiRoot,
  createApi,
  deferred,
  FILE_ID,
  fileUrl,
  FOLDER_ID,
  MockWebSocket,
  response,
} from "../test/workspaceFixtures";

vi.mock("../components/CodeEditor", () => ({
  default: ({ value, onChange, options, language, path }) => (
    <textarea
      aria-label="Code editor"
      data-language={language}
      data-path={path}
      value={value}
      readOnly={options.readOnly}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));

let api;
let authClient;
function workspaceView(workspaceId = WORKSPACE_ID) {
  return (
    <MemoryRouter>
      <AuthContext.Provider
        value={{ user: { id: 1, username: "tester" }, client: authClient }}
      >
        <WorkspacePage key={workspaceId} workspaceId={workspaceId} />
      </AuthContext.Provider>
    </MemoryRouter>
  );
}
const click = (name, role = "button") =>
  fireEvent.click(
    screen.getByRole(role, {
      name: name === "Run" ? /^Run(?:\s*F5)?$/ : name,
      exact: true,
    }),
  );
const editor = () => screen.getByRole("textbox", { name: "Code editor" });
const edit = (text) => fireEvent.change(editor(), { target: { value: text } });
const status = () => document.querySelector(".editor-toolbar .save-indicator");
const terminal = () => MockTerminal.instances.at(-1);
const output = () => screen.getByTestId("terminal-screen");
const mutations = () => api.requests.filter((r) => r.method !== "GET");
const treeRow = (name) => document.querySelector(`.tree-row[title="${name}"]`);
async function mount() {
  const result = render(workspaceView());
  await screen.findByRole("button", { name: "Select workspace root" });
  await waitFor(() => expect(treeRow("main.py")).toBeInTheDocument());
  return result;
}
async function open(name = "main.py") {
  fireEvent.click(treeRow(name));
  await screen.findByRole("textbox", { name: "Code editor" });
  await waitFor(() => expect(editor()).not.toHaveAttribute("readonly"));
}
async function submitDialog(name, value, submit) {
  const dialog = await screen.findByRole("dialog");
  if (name)
    fireEvent.change(within(dialog).getByRole("textbox", { name }), {
      target: { value },
    });
  fireEvent.click(
    within(dialog).getByRole("button", { name: submit, exact: true }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
}
async function contextAction(name, action) {
  fireEvent.contextMenu(treeRow(name));
  click(action, "menuitem");
}
async function startRun() {
  click("Run");
  await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
  const socket = MockWebSocket.instances[0];
  act(() => {
    socket.open();
    socket.emit({ type: "ready" });
  });
  return socket;
}
async function finish(socket, reason = "completed", exit_code = 0) {
  await act(async () => socket.emit({ type: "finished", reason, exit_code }));
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: /^Run(?:\s*F5)?$/ }),
    ).toBeEnabled(),
  );
}
beforeEach(() => {
  api = createApi();
  authClient = {
    fetch: (...args) => fetch(...args),
    getAccessToken: async () => "test-access",
    logout: vi.fn(),
  };
  vi.stubGlobal("fetch", api.fetch);
  MockWebSocket.instances = [];
  MockTerminal.instances = [];
  vi.stubGlobal("WebSocket", MockWebSocket);
});

describe("workspace loading and editor drafts", () => {
  it("loads the configured workspace and recursive Explorer without opening a file", async () => {
    await mount();
    expect(api.requests[0].url).toBe(apiRoot);
    expect(treeRow("src")).toBeInTheDocument();
    expect(treeRow("nested.cpp")).toBeInTheDocument();
    expect(screen.getByText("Make something great.")).toBeInTheDocument();
    expect(
      screen.queryByRole("textbox", { name: "Code editor" }),
    ).not.toBeInTheDocument();
  });
  it("shows a friendly service error and can retry workspace loading", async () => {
    api.intercept("GET", apiRoot, () =>
      response({ detail: "Workspace unavailable" }, 503),
    );
    render(workspaceView());
    expect(
      (await screen.findAllByText("The service is temporarily unavailable. Please try again shortly.")).length,
    ).toBeGreaterThan(0);
    click("Try again");
    await waitFor(() => expect(treeRow("main.py")).toBeInTheDocument());
  });
  it("shows a loading overlay and handles file-detail failure without allowing saves", async () => {
    await mount();
    const gate = deferred();
    api.intercept("GET", fileUrl(), () => gate.promise);
    fireEvent.click(treeRow("main.py"));
    expect(await screen.findByText("Opening file…")).toBeInTheDocument();
    await act(async () =>
      gate.resolve(response({ detail: "File not found" }, 404)),
    );
    expect(
      await screen.findByText("This item is no longer available. Refresh and try again."),
    ).toBeInTheDocument();
    expect(editor()).toHaveAttribute("readonly");
    expect(
      screen.getByRole("button", { name: "Save", exact: true }),
    ).toBeDisabled();
  });
  it("keeps the newest selection when an older file request finishes later", async () => {
    await mount();
    const gate = deferred();
    api.intercept("GET", fileUrl(), () => gate.promise);
    fireEvent.click(treeRow("main.py"));
    await open("nested.cpp");
    await act(async () => gate.resolve(response(api.files[0])));
    expect(editor()).toHaveValue("#include <iostream>");
    expect(
      screen.getByRole("tab", { name: "nested.cpp", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
  });
  it("keeps independent unsaved drafts and stable Monaco paths across tabs", async () => {
    await mount();
    await open();
    const path = editor().dataset.path;
    edit('print("draft")');
    expect(status()).toHaveTextContent("Unsaved");
    await open("nested.cpp");
    edit("std::cout << 42;");
    fireEvent.click(screen.getByRole("tab", { name: /main.py/ }));
    expect(editor()).toHaveValue('print("draft")');
    expect(editor().dataset.path).toBe(path);
    expect(status()).toHaveTextContent("Unsaved");
    expect(
      api.requests.filter((r) => r.url === fileUrl() && r.method === "GET"),
    ).toHaveLength(1);
  });
  it("asks before discarding a dirty tab and reopens the saved version", async () => {
    await mount();
    await open();
    edit("draft");
    click("Close main.py");
    click("Cancel");
    expect(editor()).toHaveValue("draft");
    click("Close main.py");
    click("Discard & close");
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(screen.getByText("Make something great.")).toBeInTheDocument();
    await open();
    expect(editor()).toHaveValue('print("saved")');
  });
});

describe("file and folder operations", () => {
  it.each([
    ["file", null],
    ["folder", null],
    ["file", FOLDER_ID],
    ["folder", FOLDER_ID],
  ])(
    "creates a %s with correct parent/folder destination %s",
    async (kind, parent) => {
      await mount();
      if (parent) fireEvent.click(treeRow("src"));
      click(kind === "file" ? "New File" : "New Folder");
      await submitDialog(
        kind === "file" ? "Filename" : "Folder name",
        kind === "file" ? "new.py" : "child",
        "Create",
      );
      const request = mutations()[0];
      expect(request.method).toBe("POST");
      expect(request.url).toBe(
        `${apiRoot}${kind === "file" ? "files" : "folders"}/`,
      );
      expect(request.body).toEqual(
        kind === "file"
          ? {
              name: "new.py",
              language: "python",
              content: "",
              ...(parent ? { folder: parent } : {}),
            }
          : { name: "child", ...(parent ? { parent } : {}) },
      );
      expect(treeRow(kind === "file" ? "new.py" : "child")).toBeInTheDocument();
      expect(api.requests.at(-1).url).toBe(apiRoot);
    },
  );
  it("renames files and folders, updating language and tabs without changing the draft", async () => {
    await mount();
    await open();
    edit("unsaved draft");
    await contextAction("main.py", "Rename");
    await submitDialog("Name", "solution.cpp", "Rename");
    expect(mutations()[0].body).toEqual({
      name: "solution.cpp",
      language: "cpp",
    });
    expect(editor()).toHaveValue("unsaved draft");
    expect(editor().dataset.language).toBe("cpp");
    expect(
      screen.getByRole("tab", { name: /solution.cpp/ }),
    ).toBeInTheDocument();
    await contextAction("src", "Rename");
    await submitDialog("Name", "source", "Rename");
    expect(treeRow("source")).toBeInTheDocument();
    expect(api.files[1].folder).toBe(FOLDER_ID);
  });
  it.each(["New File", "New Folder"])(
    "shows creation validation errors for %s and preserves dialog input",
    async (action) => {
      await mount();
      const kind = action === "New File" ? "files" : "folders";
      api.intercept("POST", `${apiRoot}${kind}/`, () =>
        response({ name: ["Name already exists"] }, 400),
      );
      click(action);
      const dialog = screen.getByRole("dialog");
      fireEvent.change(within(dialog).getByRole("textbox"), {
        target: { value: "duplicate" },
      });
      fireEvent.click(
        within(dialog).getByRole("button", { name: "Create", exact: true }),
      );
      expect(await within(dialog).findByRole("alert")).toHaveTextContent(
        "Name already exists. Choose another name.",
      );
      expect(within(dialog).getByRole("textbox")).toHaveValue("duplicate");
    },
  );
  it("rejects blank rename input and shows update failures", async () => {
    await mount();
    await contextAction("main.py", "Rename");
    const dialog = screen.getByRole("dialog");
    const input = within(dialog).getByRole("textbox");
    fireEvent.change(input, { target: { value: "  " } });
    expect(
      within(dialog).getByRole("button", { name: "Rename", exact: true }),
    ).toBeDisabled();
    api.intercept("PATCH", fileUrl(), () =>
      response({ detail: "Update failed" }, 500),
    );
    fireEvent.change(input, { target: { value: "next.py" } });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Rename", exact: true }),
    );
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "The service is temporarily unavailable. Please try again shortly.",
    );
    expect(treeRow("main.py")).toBeInTheDocument();
  });
  it("deletes a file and recursive folder while closing affected tabs", async () => {
    await mount();
    await open();
    await open("nested.cpp");
    await contextAction("main.py", "Delete");
    await submitDialog(null, null, "Delete");
    expect(treeRow("main.py")).not.toBeInTheDocument();
    await contextAction("src", "Delete");
    await submitDialog(null, null, "Delete");
    expect(
      screen.queryByRole("tab", { name: "nested.cpp" }),
    ).not.toBeInTheDocument();
    expect(api.files).toEqual([]);
    expect(api.folders).toEqual([]);
  });
  it("keeps file and tab when deletion fails", async () => {
    await mount();
    await open();
    api.intercept("DELETE", fileUrl(), () =>
      response({ detail: "Delete failed" }, 500),
    );
    await contextAction("main.py", "Delete");
    click("Delete");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The service is temporarily unavailable. Please try again shortly.",
    );
    expect(treeRow("main.py")).toBeInTheDocument();
    expect(editor()).toHaveValue('print("saved")');
  });
});

describe("saving and execution lifecycle", () => {
  it("manual Save updates Saved and the next edit immediately becomes Unsaved", async () => {
    await mount();
    await open();
    edit('print("new")');
    click("Save");
    await waitFor(() => expect(status()).toHaveTextContent(/^Saved$/));
    expect(mutations()[0]).toEqual({
      url: fileUrl(),
      method: "PATCH",
      body: { content: 'print("new")' },
    });
    edit('print("newer")');
    expect(status()).toHaveTextContent("Unsaved");
  });
  it("edits made during manual saving remain Unsaved", async () => {
    await mount();
    await open();
    edit("snapshot");
    const gate = deferred();
    api.intercept("PATCH", fileUrl(), () => gate.promise);
    click("Save");
    edit("newer draft");
    await act(async () =>
      gate.resolve(response({ ...api.files[0], content: "snapshot" })),
    );
    expect(editor()).toHaveValue("newer draft");
    expect(status()).toHaveTextContent("Unsaved");
  });
  it("failed manual Save keeps the draft and shows a friendly error", async () => {
    await mount();
    await open();
    edit("draft");
    api.intercept("PATCH", fileUrl(), () =>
      response({ detail: "Offline" }, 503),
    );
    click("Save");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The service is temporarily unavailable. Please try again shortly.",
    );
    expect(status()).toHaveTextContent("Unsaved");
    expect(editor()).toHaveValue("draft");
  });
  it("waits for auto-save, submits all fields and prevents duplicate runs", async () => {
    await mount();
    await open();
    edit('print("latest")');
    const gate = deferred();
    api.intercept("PATCH", fileUrl(), () => gate.promise);
    click("Run");
    expect(MockWebSocket.instances).toHaveLength(0);
    expect(mutations()[0].body).toEqual({
      name: "main.py",
      language: "python",
      content: 'print("latest")',
    });
    fireEvent.keyDown(window, { key: "F5" });
    expect(mutations()).toHaveLength(1);
    await act(async () =>
      gate.resolve(response({ ...api.files[0], content: 'print("latest")' })),
    );
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(status()).toHaveTextContent("Saved");
    const socket = MockWebSocket.instances[0];
    expect(socket.url).toBe(fileUrl().replace("http:", "ws:") + "run/");
    act(() => socket.open());
    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: "start" }));
    await finish(socket);
  });
  it("failed auto-save never starts a WebSocket", async () => {
    await mount();
    await open();
    edit("draft");
    api.intercept("PATCH", fileUrl(), () =>
      response({ detail: "Save failed" }, 500),
    );
    click("Run");
    await waitFor(() =>
      expect(output()).toHaveTextContent("The service is temporarily unavailable. Please try again shortly."),
    );
    expect(MockWebSocket.instances).toHaveLength(0);
    expect(status()).toHaveTextContent("Unsaved");
  });
  it("edits during auto-save abort execution and retain the new draft", async () => {
    await mount();
    await open();
    edit("snapshot");
    const gate = deferred();
    api.intercept("PATCH", fileUrl(), () => gate.promise);
    click("Run");
    edit("latest");
    await act(async () =>
      gate.resolve(response({ ...api.files[0], content: "snapshot" })),
    );
    expect(MockWebSocket.instances).toHaveLength(0);
    expect(editor()).toHaveValue("latest");
    expect(status()).toHaveTextContent("Unsaved");
    expect(output()).toHaveTextContent("file changed while saving");
  });
  it.each([
    ["python", "print(1)", ".py"],
    ["c", '#include <stdio.h>\nint main(void) { puts("hi"); }', ".c"],
    ["cpp", "#include <iostream>\nint main() { std::cout << 1; }", ".cpp"],
  ])(
    "assigns extension and persists %s before executing",
    async (language, source, extension) => {
      api.files[0].name = "main";
      api.files[0].language = "";
      render(workspaceView());
      await waitFor(() => expect(treeRow("main")).toBeInTheDocument());
      await open("main");
      edit(source);
      const socket = await startRun();
      expect(api.files[0]).toMatchObject({
        name: "main" + extension,
        language,
        content: source,
        id: FILE_ID,
      });
      expect(
        screen.getByRole("tab", { name: "main" + extension, exact: true }),
      ).toBeInTheDocument();
      await finish(socket);
    },
  );
  it("ambiguous source asks for a language and cancel prevents rename/save/run", async () => {
    api.files[0].name = "main";
    api.files[0].language = "";
    render(workspaceView());
    await waitFor(() => expect(treeRow("main")).toBeInTheDocument());
    await open("main");
    edit("x = 1");
    click("Run");
    expect(screen.getByRole("dialog")).toHaveTextContent("Choose a language");
    click("Cancel");
    await waitFor(() =>
      expect(output()).toHaveTextContent("It was not renamed"),
    );
    expect(mutations()).toHaveLength(0);
    expect(MockWebSocket.instances).toHaveLength(0);
  });
  it("unknown extension and no selection report clear errors", async () => {
    api.files[0].name = "main.unknown";
    render(workspaceView());
    await waitFor(() => expect(treeRow("main.unknown")).toBeInTheDocument());
    click("Run");
    expect(output()).toHaveTextContent("Select a file");
    await open("main.unknown");
    click("Run");
    await waitFor(() =>
      expect(output()).toHaveTextContent("extension is not recognized"),
    );
    expect(mutations()).toHaveLength(0);
  });
  it("streams output, queues early keyboard input, forwards resize and Stop", async () => {
    await mount();
    await open();
    click("Run");
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const socket = MockWebSocket.instances[0];
    act(() => terminal().input("early\r"));
    act(() => {
      socket.open();
      socket.emit({ type: "ready" });
    });
    expect(socket.send).toHaveBeenCalledWith(
      JSON.stringify({ type: "input", data: "early\r" }),
    );
    act(() => {
      socket.emit({ type: "output", data: "Name: " });
      terminal().input("Mohammad\r");
      terminal().resize({ cols: 100, rows: 30 });
    });
    expect(output()).toHaveTextContent("Name:");
    expect(socket.send).toHaveBeenCalledWith(
      JSON.stringify({ type: "input", data: "Mohammad\r" }),
    );
    expect(socket.send).toHaveBeenCalledWith(
      JSON.stringify({ type: "resize", cols: 100, rows: 30 }),
    );
    click("Stop execution");
    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: "stop" }));
    await finish(socket, "stopped");
    expect(output()).toHaveTextContent("[Stopped]");
  });
  it.each([
    ["completed", 1, "Exited with code 1"],
    ["timeout", null, "Timed out"],
    ["error", null, "Code execution is temporarily unavailable. Please try again later."],
  ])("handles execution %s", async (reason, code, text) => {
    await mount();
    await open();
    const socket = await startRun();
    if (reason === "error")
      act(() => socket.emit({ type: "error", message: "image missing" }));
    await finish(socket, reason, code);
    expect(output()).toHaveTextContent(text);
    expect(
      screen.getByRole("button", { name: "Stop execution" }),
    ).toBeDisabled();
    expect(status()).toHaveTextContent("Saved");
  });
  it("handles malformed messages and early socket failure, and cleans up on unmount", async () => {
    const view = await mount();
    await open();
    const socket = await startRun();
    act(() => socket.onmessage({ data: "not json" }));
    act(() => {
      socket.onerror();
      socket.close();
    });
    await waitFor(() =>
      expect(output()).toHaveTextContent(
        "The terminal disconnected. Run your file again to reconnect.",
      ),
    );
    expect(output()).toHaveTextContent("The terminal disconnected. Run your file again to reconnect.");
    MockWebSocket.instances = [];
    const next = await startRun();
    view.unmount();
    expect(next.close).toHaveBeenCalled();
  });
  it("theme preference persists and applies to the terminal", async () => {
    localStorage.setItem("ide-theme", "light");
    const view = await mount();
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(terminal().options.theme.background).toBe("#fffaf6");
    click("Switch to dark theme");
    expect(localStorage.getItem("ide-theme")).toBe("dark");
    view.unmount();
    await mount();
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});

it("reports a network failure when loading the workspace", async () => {
  api.intercept("GET", apiRoot, () =>
    Promise.reject(new Error("Network offline")),
  );
  render(workspaceView());
  expect(
    (await screen.findAllByText("Could not connect. Check your internet connection and try again.")).length,
  ).toBeGreaterThan(0);
});

it.each([
  [403, "You don't have permission to do that."],
  [404, "This item is no longer available. Refresh and try again."],
  [500, "The service is temporarily unavailable. Please try again shortly."],
  [0, "Could not connect. Check your internet connection and try again."],
])("keeps edits unsaved and prevents Run after save failure %s", async (code, message) => {
  await mount();
  await open();
  edit("private draft");
  api.intercept("PATCH", fileUrl(), () => code
    ? response({ detail: "HTTP error Traceback /srv/private.py Authorization: Bearer secret" }, code)
    : Promise.reject(new TypeError("Failed to fetch")));
  click("Run");
  expect(await screen.findByRole("alert")).toHaveTextContent(message);
  expect(output()).toHaveTextContent(message);
  expect(output()).not.toHaveTextContent(/HTTP|Traceback|private\.py|Bearer|secret/);
  expect(status()).toHaveTextContent("Unsaved");
  expect(editor()).toHaveValue("private draft");
  expect(MockWebSocket.instances).toHaveLength(0);
});

it("hides terminal service internals in all panels but preserves program diagnostics", async () => {
  await mount();
  await open();
  const socket = await startRun();
  const programError = 'Traceback (most recent call last): File "main.py", line 1\nZeroDivisionError: division by zero';
  act(() => {
    socket.emit({ type: "output", data: programError });
    socket.emit({ type: "error", message: "Isolated runner unavailable: podman /srv/runner.py SECRET=private" });
  });
  expect(output()).toHaveTextContent("ZeroDivisionError: division by zero");
  expect(output()).toHaveTextContent("Code execution is temporarily unavailable. Please try again later.");
  click("Output", "tab");
  const outputPanel = screen.getByRole("tabpanel", { name: "Output", exact: true });
  expect(outputPanel).toHaveTextContent("ZeroDivisionError");
  expect(outputPanel).not.toHaveTextContent(/podman|runner\.py|SECRET/);
  click(/Problems/, "tab");
  const problems = screen.getByRole("tabpanel", { name: "Problems" });
  expect(problems).toHaveTextContent("Code execution is temporarily unavailable. Please try again later.");
  expect(problems).not.toHaveTextContent(/podman|runner\.py|SECRET/);
  await finish(socket, "error", null);
});

it.each([
  [4401, "Your session has expired. Please log in again."],
  [4403, "You don't have permission to do that."],
  [4404, "This item is no longer available. Refresh and try again."],
  [1006, "The terminal disconnected. Run your file again to reconnect."],
])("shows a friendly terminal close message for %s", async (code, message) => {
  authClient.restore = vi.fn().mockResolvedValue(undefined);
  await mount();
  await open();
  const socket = await startRun();
  await act(async () => socket.onclose({ code, reason: "SECRET /srv/internal.py" }));
  expect(output()).toHaveTextContent(message);
  expect(output()).not.toHaveTextContent(/SECRET|internal\.py/);
  if (code === 4401) expect(authClient.restore).toHaveBeenCalledOnce();
});

it("accepts an explicit language for ambiguous code before saving and running", async () => {
  api.files[0].name = "main";
  api.files[0].language = "";
  render(workspaceView());
  await waitFor(() => expect(treeRow("main")).toBeInTheDocument());
  await open("main");
  edit("x = 1");
  click("Run");
  fireEvent.change(screen.getByRole("combobox"), {
    target: { value: "python" },
  });
  click("Continue");
  await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
  expect(mutations()[0].body).toEqual({
    name: "main.py",
    language: "python",
    content: "x = 1",
  });
  await finish(MockWebSocket.instances[0]);
});

it("a save completing in another tab does not overwrite that tab or its status", async () => {
  await mount();
  await open();
  edit("snapshot");
  const gate = deferred();
  api.intercept("PATCH", fileUrl(), () => gate.promise);
  click("Save");
  await open("nested.cpp");
  edit("other draft");
  await act(async () =>
    gate.resolve(response({ ...api.files[0], content: "snapshot" })),
  );
  expect(editor()).toHaveValue("other draft");
  expect(status()).toHaveTextContent("Unsaved");
  fireEvent.click(screen.getByRole("tab", { name: /main.py/ }));
  expect(editor()).toHaveValue("snapshot");
  expect(status()).toHaveTextContent("Saved");
});

it("keyboard Save and settings persist font size and word wrap", async () => {
  await mount();
  await open();
  edit("saved with shortcut");
  fireEvent.keyDown(window, { key: "s", ctrlKey: true });
  await waitFor(() => expect(status()).toHaveTextContent(/^Saved$/));
  click("Settings");
  fireEvent.change(screen.getByRole("slider"), { target: { value: "18" } });
  fireEvent.click(screen.getByRole("checkbox"));
  expect(localStorage.getItem("ide-font-size")).toBe("18");
  expect(localStorage.getItem("ide-word-wrap")).toBe("true");
});

it("starting a new run clears prior output and creates a fresh socket", async () => {
  await mount();
  await open();
  const first = await startRun();
  act(() => first.emit({ type: "output", data: "old output" }));
  await finish(first);
  click("Run");
  await waitFor(() => expect(MockWebSocket.instances).toHaveLength(2));
  expect(output()).not.toHaveTextContent("old output");
  expect(MockWebSocket.instances[1]).not.toBe(first);
  await finish(MockWebSocket.instances[1]);
});
