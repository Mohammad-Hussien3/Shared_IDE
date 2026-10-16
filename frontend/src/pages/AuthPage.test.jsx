import { useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import { AuthContext } from "../auth/context";
import { HttpError } from "../lib/errors";
import { navigateToProvider } from "../lib/navigation";
import { deferred } from "../test/workspaceFixtures";
import AuthCelebration from "../components/AuthCelebration";
import AuthPage from "./AuthPage";

vi.mock("../lib/navigation", () => ({ navigateToProvider: vi.fn() }));
let client;
const fill = (label, value) => fireEvent.change(screen.getByLabelText(label, { exact: true }), { target: { value } });
const click = name => fireEvent.click(screen.getByRole("button", { name, exact: true }));
const mascot = () => screen.getByRole("img", { name: /^Spark mascot:/ });
function Destination() {
  const location = useLocation();
  return <h1>{location.pathname} {location.state?.email}</h1>;
}
function Provider({ children }) {
  const [user, setUser] = useState(null);
  const wrapped = { ...client, authenticate: async (...args) => {
    const result = await client.authenticate(...args);
    if (args[0] === "login") setUser(result.user);
    return result;
  } };
  return <AuthContext.Provider value={{ client: wrapped, user, error: "", setError: vi.fn() }}>{children}</AuthContext.Provider>;
}
function mount(register = false) {
  return render(<MemoryRouter initialEntries={[register ? "/register" : "/login"]}><Provider>
    <AuthCelebration /><Routes>
      <Route path="/login" element={<AuthPage key="login" />} />
      <Route path="/register" element={<AuthPage key="register" register />} />
      <Route path="/forgot-password" element={<Destination />} />
      <Route path="/check-email" element={<Destination />} />
      <Route path="/workspaces" element={<Destination />} />
    </Routes>
  </Provider></MemoryRouter>);
}
function completeRegistration() {
  fill("Username", "spark_builder");
  fill("Email address", "spark@example.com");
  fill("Password", "Original-password!79");
  fill("Confirm password", "Original-password!79");
}
beforeEach(() => {
  client = { authenticate: vi.fn(), startGoogle: vi.fn() };
});

it.each([false, true])("keeps Google below the form, its official logo intact, and no resend link (register=%s)", register => {
  mount(register);
  const submit = screen.getByRole("button", { name: register ? "Create account" : "Sign in", exact: true });
  const google = screen.getByRole("button", { name: "Continue with Google" });
  expect(submit.compareDocumentPosition(google) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(google.querySelector("img")).toHaveAttribute("src", expect.stringContaining("google-g.png"));
  expect(screen.queryByRole("link", { name: /resend/i })).not.toBeInTheDocument();
  expect(screen.getByLabelText("Password", { exact: true })).toHaveAttribute("autocomplete", register ? "new-password" : "current-password");
  expect(mascot()).toHaveAttribute("data-expression", "idle");
});

it("reacts to email typing, covers its eyes for passwords, and peeks only when shown", () => {
  mount();
  fireEvent.focus(screen.getByLabelText("Email or username"));
  expect(mascot()).toHaveAttribute("data-expression", "attentive");
  fill("Email or username", "spark@example.com");
  expect(mascot()).toHaveAttribute("data-expression", "happy");
  const password = screen.getByLabelText("Password", { exact: true });
  fireEvent.focus(password);
  expect(mascot()).toHaveAttribute("data-expression", "covered");
  fill("Password", "Some password");
  click("Show password");
  expect(password).toHaveAttribute("type", "text");
  expect(screen.getByRole("button", { name: "Hide password" })).toHaveAttribute("aria-pressed", "true");
  expect(mascot()).toHaveAttribute("data-expression", "peeking");
  click("Hide password");
  expect(password).toHaveAttribute("type", "password");
  expect(mascot()).toHaveAttribute("data-expression", "covered");
  fireEvent.blur(password);
  expect(mascot()).toHaveAttribute("data-expression", "excited");
});

it("validates email, username, password strength, and confirmation without authenticating", () => {
  mount(true);
  fill("Username", "bad name");
  fireEvent.blur(screen.getByLabelText("Username"));
  expect(screen.getByLabelText("Username")).toHaveAttribute("aria-invalid", "true");
  fill("Email address", "invalid");
  fireEvent.blur(screen.getByLabelText("Email address"));
  expect(screen.getByText("Enter a valid email address.")).toBeInTheDocument();
  expect(mascot()).toHaveAttribute("data-expression", "confused");
  fill("Password", "short");
  expect(screen.getByRole("meter")).toHaveAttribute("aria-valuenow", "1");
  completeRegistration();
  expect(screen.getByRole("meter")).toHaveAttribute("aria-valuenow", "4");
  expect(mascot()).toHaveAttribute("data-expression", "excited");
  fill("Confirm password", "different");
  click("Create account");
  expect(screen.getByRole("alert")).toHaveTextContent("Passwords do not match.");
  expect(screen.getByLabelText("Confirm password")).toHaveAttribute("aria-invalid", "true");
  expect(client.authenticate).not.toHaveBeenCalled();
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});

it("preserves native required validation and the recovery and signup links", () => {
  mount();
  click("Sign in");
  expect(client.authenticate).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Email or username")).toBeInvalid();
  expect(screen.getByRole("link", { name: "Create an account" })).toHaveAttribute("href", "/register");
  fireEvent.click(screen.getByRole("link", { name: "Forgot password?" }));
  expect(screen.getByRole("heading", { name: "/forgot-password" })).toBeInTheDocument();
});

it("waits for registration confirmation, prevents duplicate requests, and navigates without a celebration delay", async () => {
  const gate = deferred();
  client.authenticate.mockReturnValue(gate.promise);
  mount(true);
  completeRegistration();
  click("Create account");
  click("Please wait…");
  expect(client.authenticate).toHaveBeenCalledExactlyOnceWith("register", {
    username: "spark_builder", email: "spark@example.com", password: "Original-password!79", confirm_password: "Original-password!79",
  });
  expect(screen.getByRole("button", { name: "Please wait…" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Continue with Google" })).toBeDisabled();
  expect(mascot()).toHaveAttribute("data-expression", "thinking");
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  await act(async () => gate.resolve({ detail: "Check your email" }));
  expect(screen.getByRole("heading", { name: "/check-email spark@example.com" })).toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("First step done. Check your inbox!");
  expect(screen.queryByRole("heading", { name: "/workspaces" })).not.toBeInTheDocument();
});

it.each(["spark_builder", "spark@example.com"])("preserves login by %s and celebrates only confirmed success", async identifier => {
  const gate = deferred();
  client.authenticate.mockReturnValue(gate.promise);
  mount();
  fill("Email or username", identifier);
  fill("Password", "Original-password!79");
  click("Sign in");
  expect(client.authenticate).toHaveBeenCalledExactlyOnceWith("login", { username: identifier, password: "Original-password!79" });
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  await act(async () => gate.resolve({ user: { id: 1, username: "spark_builder" } }));
  expect(screen.getByRole("heading", { name: "/workspaces" })).toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("You’re in. Let’s build something.");
});

it("shows a friendly server error, keeps the form editable, and never celebrates failure", async () => {
  client.authenticate.mockRejectedValue(new HttpError(401, { detail: "Invalid credentials" }));
  mount();
  fill("Email or username", "spark_builder");
  fill("Password", "Wrong password");
  click("Sign in");
  expect(await screen.findByRole("alert")).toHaveTextContent("Invalid username or password.");
  expect(mascot()).toHaveAttribute("data-expression", "confused");
  expect(screen.getByRole("button", { name: "Sign in", exact: true })).toBeEnabled();
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  fill("Password", "Corrected password");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("preserves Google redirect behavior without treating the redirect as confirmed login", async () => {
  const gate = deferred();
  client.startGoogle.mockReturnValue(gate.promise);
  mount();
  click("Continue with Google");
  expect(screen.getByRole("button", { name: "Connecting…" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Sign in", exact: true })).toBeDisabled();
  expect(mascot()).toHaveAttribute("data-expression", "thinking");
  await act(async () => gate.resolve("https://accounts.google.com/o/oauth2/v2/auth?state=one-time"));
  expect(navigateToProvider).toHaveBeenCalledExactlyOnceWith("https://accounts.google.com/o/oauth2/v2/auth?state=one-time");
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});

it("supports confirmation visibility independently and keeps privacy poses in reduced-motion mode", () => {
  const original = window.matchMedia;
  window.matchMedia = vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  try {
    const view = mount(true);
    fireEvent.focus(screen.getByLabelText("Confirm password"));
    expect(mascot()).toHaveAttribute("data-motion", "reduced");
    expect(mascot()).toHaveAttribute("data-expression", "covered");
    click("Show confirm password");
    expect(mascot()).toHaveAttribute("data-expression", "peeking");
    expect(screen.getByLabelText("Confirm password")).toHaveAttribute("type", "text");
    expect(screen.getByLabelText("Password", { exact: true })).toHaveAttribute("type", "password");
    view.unmount();
  } finally { window.matchMedia = original; }
});
