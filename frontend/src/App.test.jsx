import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import { AppRoutes } from "./App";
import { AuthProvider } from "./auth/AuthContext";
import {
  createApi,
  deferred,
  FILE_ID,
  MockWebSocket,
  response,
  WORKSPACE_ID,
} from "./test/workspaceFixtures";
import { MockTerminal } from "./test/terminalMock";

vi.mock("./components/CodeEditor", () => ({
  default: ({ value, onChange }) => (
    <textarea
      aria-label="Code editor"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));
let signedIn, resources, workspaces, requests, failedAuth, expired, pendingSave;
const secondId = "99999999-9999-4999-8999-999999999999";
const click = (name) =>
  fireEvent.click(screen.getByRole("button", { name, exact: true }));
const fill = (name, value) =>
  fireEvent.change(screen.getByLabelText(name, { exact: true }), {
    target: { value },
  });
const treeRow = () => document.querySelector('.tree-row[title="main.py"]');
const mount = (path = "/workspaces") =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </MemoryRouter>,
  );
const authData = () => ({
  user: { id: 1, username: "alice" },
  csrf: "csrf",
  access: `header.${btoa(JSON.stringify({ exp: Date.now() / 1000 + 300 }))}.signature`,
});

beforeEach(() => {
  signedIn = false;
  failedAuth = false;
  expired = false;
  pendingSave = null;
  requests = [];
  resources = createApi();
  workspaces = [
    { id: WORKSPACE_ID, name: "Project one", children: [] },
    { id: secondId, name: "Project two", children: [] },
  ];
  MockWebSocket.instances = [];
  MockTerminal.instances = [];
  vi.stubGlobal("WebSocket", MockWebSocket);
  fetch.mockImplementation(async (url, options = {}) => {
    const method = options.method || "GET";
    const body = options.body ? JSON.parse(options.body) : {};
    requests.push({ url, method, body, options });
    if (url.endsWith("/auth/csrf/")) return response({ csrf: "csrf" });
    if (url.endsWith("/auth/refresh/"))
      return signedIn && !expired
        ? response(authData())
        : response({ detail: "Session expired" }, 401);
    if (url.endsWith("/auth/login/") || url.endsWith("/auth/register/")) {
      if (failedAuth) return response({ detail: "Invalid credentials" }, 401);
      signedIn = true;
      return response(authData());
    }
    if (url.endsWith("/auth/logout/")) {
      signedIn = false;
      return response({}, 204);
    }
    if (!signedIn || expired) return response({}, 401);
    if (url.endsWith("/workspaces/")) {
      if (method === "POST") {
        const item = { id: "new-workspace", name: body.name, children: [] };
        workspaces.push(item);
        return response(item, 201);
      }
      return response(workspaces);
    }
    const detail = url.match(/\/workspaces\/([^/]+)\/$/);
    if (detail) {
      const item = workspaces.find((w) => w.id === detail[1]);
      if (!item) return response({ detail: "Not found" }, 404);
      if (method === "PATCH") {
        item.name = body.name;
        return response(item);
      }
      if (method === "DELETE") {
        workspaces = workspaces.filter((w) => w.id !== item.id);
        return response({}, 204);
      }
      if (item.id === WORKSPACE_ID) return resources.fetch(url, options);
      return response(item);
    }
    if (pendingSave && method === "PATCH") return pendingSave.promise;
    return resources.fetch(url, options);
  });
});

it("protects workspace routes, validates registration, and reaches the dashboard", async () => {
  mount(`/workspaces/${WORKSPACE_ID}`);
  await screen.findByRole("heading", { name: "Welcome back" });
  expect(requests.some((r) => r.url.includes("/workspaces/"))).toBe(false);
  fireEvent.click(screen.getByRole("link", { name: "Create an account" }));
  fill("Username", "alice");
  fill("Password", "Secure-password!79");
  fill("Confirm password", "wrong");
  click("Create account");
  expect(screen.getByRole("alert")).toHaveTextContent("Passwords do not match");
  fill("Confirm password", "Secure-password!79");
  click("Create account");
  await screen.findByRole("heading", { name: "Your workspaces" });
  expect(requests.find((r) => r.url.endsWith("/auth/register/")).body).toEqual({
    username: "alice",
    password: "Secure-password!79",
    confirm_password: "Secure-password!79",
  });
  expect(localStorage.getItem("workspace_id")).toBeNull();
});

it("shows login errors and supports login followed by confirmed logout", async () => {
  mount("/login");
  await screen.findByRole("heading", { name: "Welcome back" });
  failedAuth = true;
  fill("Username", "alice");
  fill("Password", "wrong");
  click("Log in");
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Invalid username or password. Please try again.",
  );
  failedAuth = false;
  click("Log in");
  await screen.findByRole("heading", { name: "Your workspaces" });
  click("Log out");
  await screen.findByRole("heading", { name: "Welcome back" });
  expect(
    requests.find((r) => r.url.endsWith("/auth/logout/")).options.credentials,
  ).toBe("include");
});

it("restores a session and creates, renames, and deletes a workspace with confirmation", async () => {
  signedIn = true;
  mount();
  await screen.findByRole("heading", { name: "Your workspaces" });
  click("New workspace");
  fill("Workspace name", "Created");
  click("Create");
  await screen.findByRole("link", { name: "Created" });
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  click("Rename Created");
  fill("Workspace name", "Renamed");
  click("Rename");
  await screen.findByRole("link", { name: "Renamed" });
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  click("Delete Renamed");
  click("Cancel");
  expect(workspaces.some((w) => w.name === "Renamed")).toBe(true);
  click("Delete Renamed");
  click("Delete");
  await waitFor(() =>
    expect(
      screen.queryByRole("link", { name: "Renamed" }),
    ).not.toBeInTheDocument(),
  );
  expect(workspaces).toHaveLength(2);
});

it("opens and switches workspaces, clearing drafts and stopping the old terminal", async () => {
  signedIn = true;
  mount();
  fireEvent.click(await screen.findByRole("link", { name: "Project one" }));
  await waitFor(() => expect(treeRow()).toBeInTheDocument());
  fireEvent.click(treeRow());
  const editor = await screen.findByRole("textbox", { name: "Code editor" });
  await waitFor(() => expect(editor).toHaveValue('print("saved")'));
  fill("Code editor", 'print("draft")');
  click(/^Run(?:\s*F5)?$/);
  await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
  const socket = MockWebSocket.instances[0];
  act(() => {
    socket.open();
    socket.emit({ type: "ready" });
    socket.emit({ type: "output", data: "private output" });
  });
  expect(socket.send).toHaveBeenCalledWith(
    expect.stringContaining('"type":"authenticate"'),
  );
  fireEvent.click(screen.getByRole("link", { name: "Workspaces" }));
  fireEvent.click(await screen.findByRole("link", { name: "Project two" }));
  await screen.findByText("Make something great.");
  expect(socket.close).toHaveBeenCalled();
  expect(
    screen.queryByRole("textbox", { name: "Code editor" }),
  ).not.toBeInTheDocument();
  expect(screen.queryByText("private output")).not.toBeInTheDocument();
  expect(treeRow()).not.toBeInTheDocument();
});

it("never starts an old run when its save finishes after switching workspaces", async () => {
  signedIn = true;
  mount(`/workspaces/${WORKSPACE_ID}`);
  await waitFor(() => expect(treeRow()).toBeInTheDocument());
  fireEvent.click(treeRow());
  await screen.findByRole("textbox", { name: "Code editor" });
  await waitFor(() =>
    expect(screen.getByLabelText("Code editor")).toHaveValue('print("saved")'),
  );
  pendingSave = deferred();
  click(/^Run(?:\s*F5)?$/);
  await waitFor(() =>
    expect(requests.some((r) => r.method === "PATCH")).toBe(true),
  );
  fireEvent.click(screen.getByRole("link", { name: "Workspaces" }));
  fireEvent.click(await screen.findByRole("link", { name: "Project two" }));
  await act(async () =>
    pendingSave.resolve(
      response({
        id: FILE_ID,
        name: "main.py",
        content: 'print("old")',
        language: "python",
      }),
    ),
  );
  expect(MockWebSocket.instances).toHaveLength(0);
  expect(
    screen.queryByRole("textbox", { name: "Code editor" }),
  ).not.toBeInTheDocument();
});

it("redirects to login on an expired session and clears the editor", async () => {
  signedIn = true;
  mount(`/workspaces/${WORKSPACE_ID}`);
  await waitFor(() => expect(treeRow()).toBeInTheDocument());
  expired = true;
  fireEvent.click(treeRow());
  await screen.findByRole("heading", { name: "Welcome back" });
  expect(screen.getByRole("alert")).toHaveTextContent("Your session has expired. Please log in again.");
  expect(
    screen.queryByRole("textbox", { name: "Code editor" }),
  ).not.toBeInTheDocument();
});

it("shows dashboard load errors and supports retry and theme persistence", async () => {
  signedIn = true;
  const original = fetch.getMockImplementation();
  let fail = true;
  fetch.mockImplementation((url, options) =>
    url.endsWith("/workspaces/") && fail
      ? Promise.resolve(response({ detail: "Unavailable" }, 503))
      : original(url, options),
  );
  mount();
  expect(await screen.findByRole("alert")).toHaveTextContent("The service is temporarily unavailable. Please try again shortly.");
  fail = false;
  click("Try again");
  await screen.findByRole("link", { name: "Project one" });
  click("Toggle theme");
  expect(localStorage.getItem("ide-theme")).toBe("light");
});

it.each([
  ["register", 400, { username: ["A user with that username already exists."] }, "Username already exists. Choose another username."],
  ["register", 400, { password: ["This password is too common."] }, "This password is too common. Choose a stronger password."],
  ["login", 401, { detail: "Invalid credentials" }, "Invalid username or password. Please try again."],
  ["register", 403, { code: "csrf_failed", detail: "CSRF verification failed. SECRET=private" }, "We couldn't verify this request. Refresh the page and try again."],
  ["login", 429, { detail: "Throttle backend internals" }, "Too many attempts. Please wait a moment and try again."],
  ["register", 500, { detail: "Traceback /srv/settings.py SECRET=private" }, "The service is temporarily unavailable. Please try again shortly."],
  ["login", 0, null, "Could not connect. Check your internet connection and try again."],
])("shows friendly %s errors for status %s", async (action, status, payload, message) => {
  const original = fetch.getMockImplementation();
  fetch.mockImplementation((url, options) => {
    if (url.endsWith(`/auth/${action}/`)) {
      return status ? Promise.resolve(response(payload, status)) : Promise.reject(new TypeError("Failed to fetch"));
    }
    return original(url, options);
  });
  mount(`/${action}`);
  await screen.findByLabelText("Username", { exact: true });
  fill("Username", "alice");
  fill("Password", "Secure-password!79");
  if (action === "register") fill("Confirm password", "Secure-password!79");
  click(action === "register" ? "Create account" : "Log in");
  expect(await screen.findByRole("alert")).toHaveTextContent(message);
  expect(screen.getByRole("alert")).not.toHaveTextContent(/HTTP|CSRF|Traceback|SECRET|settings\.py|Throttle/);
  expect(screen.queryByRole("heading", { name: "Your workspaces" })).not.toBeInTheDocument();
});

it("keeps the account signed in and explains a failed logout", async () => {
  signedIn = true;
  const original = fetch.getMockImplementation();
  fetch.mockImplementation((url, options) => url.endsWith("/auth/logout/")
    ? Promise.resolve(response({ detail: "Traceback /srv/logout.py" }, 500)) : original(url, options));
  mount();
  await screen.findByRole("heading", { name: "Your workspaces" });
  click("Log out");
  expect(await screen.findByRole("alert")).toHaveTextContent("The service is temporarily unavailable. Please try again shortly.");
  expect(screen.getByRole("heading", { name: "Your workspaces" })).toBeInTheDocument();
});

it("shows workspace permission errors inside the existing creation dialog", async () => {
  signedIn = true;
  const original = fetch.getMockImplementation();
  fetch.mockImplementation((url, options) => url.endsWith("/workspaces/") && options?.method === "POST"
    ? Promise.resolve(response({ detail: "PermissionDenied in /srv/private.py" }, 403)) : original(url, options));
  mount();
  await screen.findByRole("heading", { name: "Your workspaces" });
  click("New workspace");
  fill("Workspace name", "New project");
  click("Create");
  expect(await screen.findByRole("alert")).toHaveTextContent("You don't have permission to do that.");
  expect(screen.getByLabelText("Workspace name")).toHaveValue("New project");
});
