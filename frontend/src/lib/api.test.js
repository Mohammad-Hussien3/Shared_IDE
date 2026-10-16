import { describe, expect, it, vi } from "vitest";
import { createAuthClient } from "./api";
import { ERROR_MESSAGES, HttpError } from "./errors";
import { deferred, response } from "../test/workspaceFixtures";

const token = (suffix = "one", exp = Date.now() / 1000 + 300) =>
  `header.${btoa(JSON.stringify({ exp }))}.${suffix}`;
const session = (access = token()) => ({
  access,
  csrf: "rotated-csrf",
  user: { id: 1, username: "alice" },
});

describe("authentication HTTP client", () => {
  it('waits for a pending password response before logout revokes its replacement cookie', async () => {
    const gate = deferred();
    fetch.mockResolvedValueOnce(response({ csrf: 'csrf' })).mockResolvedValueOnce(response(session()))
      .mockReturnValueOnce(gate.promise).mockResolvedValueOnce(response({}, 204));
    const client = createAuthClient();
    const changed = vi.fn();
    client.subscribe(changed);
    await client.authenticate('login', {});
    const saving = client.updatePassword({ password: 'new-secret', confirm_password: 'new-secret' });
    const rejection = expect(saving).rejects.toThrow('Your session has expired.');
    // Let the request reach the server before logout is requested.
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    const loggingOut = client.logout();
    expect(fetch.mock.calls.some(([url]) => url.endsWith('/auth/logout/'))).toBe(false);
    gate.resolve(response(session(token('replacement'))));
    await rejection;
    await loggingOut;
    expect(fetch.mock.calls[3][0]).toBe('http://api.test/api/auth/logout/');
    expect(changed).toHaveBeenLastCalledWith(null);
  });
  it('sends account changes with JWT and CSRF, and publishes the updated user', async () => {
    const initial = session();
    fetch.mockResolvedValueOnce(response({ csrf: 'csrf' })).mockResolvedValueOnce(response(initial))
      .mockResolvedValueOnce(response({ user: { id: 1, username: 'renamed' } }));
    const client = createAuthClient();
    const changed = vi.fn();
    client.subscribe(changed);
    await client.authenticate('login', {});
    await client.updateUsername({ username: 'renamed', current_password: 'secret' });
    expect(fetch.mock.calls[2]).toEqual(['http://api.test/api/auth/account/username/', expect.objectContaining({
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-CSRFToken': 'rotated-csrf', Authorization: `Bearer ${initial.access}` },
    })]);
    expect(changed).toHaveBeenLastCalledWith({ id: 1, username: 'renamed' });
  });
  it('accepts the replacement session after a password change', async () => {
    const replacement = session(token('replacement'));
    fetch.mockResolvedValueOnce(response({ csrf: 'csrf' })).mockResolvedValueOnce(response(session()))
      .mockResolvedValueOnce(response(replacement));
    const client = createAuthClient();
    await client.authenticate('login', {});
    await client.updatePassword({ password: 'new-secret', confirm_password: 'new-secret', current_password: 'old-secret' });
    expect(await client.getAccessToken()).toBe(replacement.access);
  });
  it('registration returns the check-email response without accepting a session', async () => {
    fetch.mockResolvedValueOnce(response({ csrf: 'csrf' }))
      .mockResolvedValueOnce(response({ detail: 'Check your email' }, 201));
    const client = createAuthClient();
    const changed = vi.fn();
    client.subscribe(changed);
    const result = await client.authenticate('register', { username: 'alice', email: 'alice@example.com', password: 'Private!923' });
    expect(result).toEqual({ detail: 'Check your email' });
    expect(changed).not.toHaveBeenCalled();
  });

  it.each([
    ['verifyEmail', 'verify-email', 'a'.repeat(43), { token: 'a'.repeat(43) }],
    ['resendVerification', 'resend-verification', 'alice@example.com', { email: 'alice@example.com' }],
  ])('%s uses CSRF and credentials without accepting a session', async (method, path, value, body) => {
    fetch.mockResolvedValueOnce(response({ csrf: 'csrf' })).mockResolvedValueOnce(response({ code: 'email_verified' }));
    const client = createAuthClient();
    const changed = vi.fn();
    client.subscribe(changed);
    await client[method](value);
    expect(fetch.mock.calls[1]).toEqual([`http://api.test/api/auth/${path}/`, expect.objectContaining({
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-CSRFToken': 'csrf' }, body: JSON.stringify(body),
    })]);
    expect(changed).not.toHaveBeenCalled();
  });
  it("starts Google through a CSRF-protected credentialed POST", async () => {
    fetch.mockResolvedValueOnce(response({ csrf: 'csrf' }))
      .mockResolvedValueOnce(response({ authorization_url: 'https://accounts.google.com/o/oauth2/v2/auth?state=random' }));
    expect(await createAuthClient().startGoogle()).toBe('https://accounts.google.com/o/oauth2/v2/auth?state=random');
    expect(fetch.mock.calls[1]).toEqual(['http://api.test/api/auth/google/start/', expect.objectContaining({
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-CSRFToken': 'csrf' }, body: '{}',
    })]);
  });
  it.each(['https://evil.example/auth', 'javascript:alert(1)', 'https://accounts.google.com.evil.example/o/oauth2/v2/auth'])("rejects an untrusted Google authorization destination %s", async (authorization_url) => {
    fetch.mockResolvedValueOnce(response({ csrf: 'csrf' })).mockResolvedValueOnce(response({ authorization_url }));
    await expect(createAuthClient().startGoogle()).rejects.toThrow("Google sign-in couldn't be started.");
  });
  it("uses the browser origin for relative HTTP and WebSocket API URLs", async () => {
    vi.stubEnv("VITE_API_URL", "/api");
    vi.resetModules();
    try {
      const api = await import("./api");
      expect(api.API_BASE_URL).toBe("/api");
      expect(api.WS_BASE_URL).toBe(`${window.location.origin.replace(/^http/, "ws")}/api`);
      fetch
        .mockResolvedValueOnce(response({ csrf: "csrf" }))
        .mockResolvedValueOnce(response(session()));
      await api.createAuthClient().authenticate("register", {});
      expect(fetch.mock.calls.map(([url]) => url)).toEqual(["/api/auth/csrf/", "/api/auth/register/"]);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it("bootstraps CSRF before login and uses the rotated token on logout", async () => {
    const action = "login";
    const bootstrap = deferred();
    fetch
      .mockReturnValueOnce(bootstrap.promise)
      .mockResolvedValueOnce(response(session()))
      .mockResolvedValueOnce(response({}, 204));
    const client = createAuthClient();
    const payload = { username: "alice", password: "Private-password!723" };
    const authentication = client.authenticate(action, payload);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("http://api.test/api/auth/csrf/", {
      credentials: "include",
      cache: "no-store",
    });
    bootstrap.resolve(response({ csrf: "initial-csrf" }));
    await authentication;
    expect(fetch.mock.calls[1]).toEqual([
      `http://api.test/api/auth/${action}/`,
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", "X-CSRFToken": "initial-csrf" },
        body: JSON.stringify(payload),
      }),
    ]);
    await client.logout();
    expect(fetch.mock.calls[2][1]).toMatchObject({
      credentials: "include",
      headers: { "X-CSRFToken": "rotated-csrf" },
    });
  });

  it.each(["register", "login", "refresh", "logout"])("recovers from one explicit CSRF rejection during %s", async (action) => {
    fetch
      .mockResolvedValueOnce(response({ csrf: "old-csrf" }))
      .mockResolvedValueOnce(response({ detail: "CSRF verification failed", code: "csrf_failed" }, 403))
      .mockResolvedValueOnce(response({ csrf: "fresh-csrf" }))
      .mockResolvedValueOnce(action === "logout" ? response({}, 204) : response(session()));
    const client = createAuthClient();
    const changed = vi.fn();
    client.subscribe(changed);
    if (action === "refresh") await client.restore();
    else if (action === "logout") await client.logout();
    else await client.authenticate(action, { username: "alice" });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "http://api.test/api/auth/csrf/",
      `http://api.test/api/auth/${action}/`,
      "http://api.test/api/auth/csrf/",
      `http://api.test/api/auth/${action}/`,
    ]);
    expect(fetch.mock.calls[3][1]).toMatchObject({
      credentials: "include",
      headers: { "X-CSRFToken": "fresh-csrf" },
    });
    if (action === "register") expect(changed).not.toHaveBeenCalled();
    else {
      expect(changed).toHaveBeenCalledTimes(1);
      expect(changed).toHaveBeenCalledWith(action === "logout" ? null : session().user);
    }
  });

  it("reports persistent CSRF failures without an infinite retry", async () => {
    fetch.mockImplementation(async (url) => url.endsWith("/auth/csrf/")
      ? response({ csrf: "csrf" })
      : response({ detail: "CSRF cookie not set", code: "csrf_failed" }, 403));
    const client = createAuthClient();
    const changed = vi.fn();
    client.subscribe(changed);
    await expect(client.authenticate("register", {})).rejects.toMatchObject({ status: 403, code: "csrf_failed", message: ERROR_MESSAGES.csrf });
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(changed).not.toHaveBeenCalled();
  });

  it.each([403, 500])("does not replay authentication for unrelated HTTP %s failures", async (status) => {
    fetch
      .mockResolvedValueOnce(response({ csrf: "csrf" }))
      .mockResolvedValueOnce(response({ detail: "Denied" }, status));
    await expect(createAuthClient().authenticate("register", {})).rejects.toMatchObject({ status, message: status === 403 ? ERROR_MESSAGES.permission : ERROR_MESSAGES.server });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([null, "", undefined])("does not submit credentials when CSRF bootstrap returns %s", async (csrf) => {
    fetch.mockResolvedValueOnce(response({ csrf }));
    await expect(createAuthClient().authenticate("login", {})).rejects.toThrow(ERROR_MESSAGES.csrf);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not replay an old user's mutation when another tab changes accounts", async () => {
    fetch
      .mockResolvedValueOnce(response({ csrf: "csrf" }))
      .mockResolvedValueOnce(response(session()))
      .mockResolvedValueOnce(response({}, 401))
      .mockResolvedValueOnce(
        response({
          ...session(token("bob")),
          user: { id: 2, username: "bob" },
        }),
      );
    const client = createAuthClient();
    const changed = vi.fn();
    client.subscribe(changed);
    await client.restore();
    await expect(
      client.fetch("/workspaces/", { method: "POST", body: "{}" }),
    ).rejects.toThrow("Session changed");
    expect(
      fetch.mock.calls.filter(([url]) => url === "/workspaces/"),
    ).toHaveLength(1);
    expect(changed).toHaveBeenLastCalledWith({ id: 2, username: "bob" });
  });
  it("fetches a fresh CSRF token when retrying a rejected logout", async () => {
    fetch
      .mockResolvedValueOnce(response({ csrf: "initial-csrf" }))
      .mockResolvedValueOnce(response(session()))
      .mockResolvedValueOnce(
        response({ detail: "CSRF verification failed" }, 403),
      )
      .mockResolvedValueOnce(response({ csrf: "new-csrf" }))
      .mockResolvedValueOnce(response({}, 204));
    const client = createAuthClient();
    await client.restore();
    await expect(client.logout()).rejects.toThrow(ERROR_MESSAGES.csrf);
    await client.logout();
    expect(fetch.mock.calls[4][1].headers["X-CSRFToken"]).toBe("new-csrf");
  });
  it("restores using CSRF and cookies and only sends the access token in Authorization", async () => {
    const access = token();
    fetch
      .mockResolvedValueOnce(response({ csrf: "csrf" }))
      .mockResolvedValueOnce(response(session(access)))
      .mockResolvedValueOnce(response([]));
    const client = createAuthClient();
    const change = vi.fn();
    client.subscribe(change);
    await client.restore();
    await client.fetch("http://api.test/api/workspaces/");
    expect(fetch.mock.calls[1][1]).toMatchObject({
      credentials: "include",
      headers: { "X-CSRFToken": "csrf" },
    });
    expect(fetch.mock.calls[2][1]).toMatchObject({
      credentials: "omit",
      headers: { Authorization: `Bearer ${access}` },
    });
    expect(change).toHaveBeenCalledWith({ id: 1, username: "alice" });
    expect(localStorage.length).toBe(0);
  });

  it("shares one refresh between concurrent unauthorized requests and retries both", async () => {
    const initial = token("initial");
    const renewed = token("renewed");
    fetch
      .mockResolvedValueOnce(response({ csrf: "csrf" }))
      .mockResolvedValueOnce(response(session(initial)));
    const client = createAuthClient();
    await client.restore();
    const gate = deferred();
    fetch.mockImplementation(async (url, options) => {
      if (url.endsWith("/auth/refresh/")) return gate.promise;
      return options.headers.Authorization === `Bearer ${initial}`
        ? response({}, 401)
        : response({ ok: true });
    });
    const first = client.fetch("/resource");
    const second = client.fetch("/resource");
    await vi.waitFor(() =>
      expect(
        fetch.mock.calls.filter(([url]) => url.endsWith("/auth/refresh/")),
      ).toHaveLength(2),
    );
    gate.resolve(response(session(renewed)));
    expect((await first).ok).toBe(true);
    expect((await second).ok).toBe(true);
    expect(
      fetch.mock.calls.filter(([url]) => url.endsWith("/auth/refresh/")),
    ).toHaveLength(2);
  });

  it("refreshes an expired access token before a request", async () => {
    fetch
      .mockResolvedValueOnce(response({ csrf: "csrf" }))
      .mockResolvedValueOnce(response(session(token("old", 1))))
      .mockResolvedValueOnce(response(session(token("new"))))
      .mockResolvedValueOnce(response([]));
    const client = createAuthClient();
    await client.restore();
    await client.fetch("/resource");
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "http://api.test/api/auth/csrf/",
      "http://api.test/api/auth/refresh/",
      "http://api.test/api/auth/refresh/",
      "/resource",
    ]);
  });

  it("expires the local session when refresh is rejected without retrying mutations", async () => {
    fetch
      .mockResolvedValueOnce(response({ csrf: "csrf" }))
      .mockResolvedValueOnce(response(session()))
      .mockResolvedValueOnce(response({}, 401))
      .mockResolvedValueOnce(response({ detail: "Session expired" }, 401));
    const client = createAuthClient();
    const change = vi.fn();
    client.subscribe(change);
    await client.restore();
    await expect(
      client.fetch("/resource", { method: "PATCH", body: "{}" }),
    ).rejects.toThrow(ERROR_MESSAGES.session);
    expect(change).toHaveBeenLastCalledWith(null, expect.any(HttpError));
    expect(
      fetch.mock.calls.filter(([url]) => url === "/resource"),
    ).toHaveLength(1);
  });

  it("clears the session after confirmed logout and rejects an old in-flight response", async () => {
    const gate = deferred();
    fetch
      .mockResolvedValueOnce(response({ csrf: "csrf" }))
      .mockResolvedValueOnce(response(session()));
    const client = createAuthClient();
    const change = vi.fn();
    client.subscribe(change);
    await client.restore();
    fetch.mockImplementation((url) =>
      url === "/resource" ? gate.promise : Promise.resolve(response({}, 204)),
    );
    const request = client.fetch("/resource");
    await vi.waitFor(() =>
      expect(fetch).toHaveBeenCalledWith("/resource", expect.anything()),
    );
    await client.logout();
    gate.resolve(response({ private: "old" }));
    await expect(request).rejects.toThrow("Session changed");
    expect(change).toHaveBeenLastCalledWith(null);
  });

  it("reports failed logout without pretending the server session was revoked", async () => {
    fetch
      .mockResolvedValueOnce(response({ csrf: "csrf" }))
      .mockResolvedValueOnce(response(session()))
      .mockResolvedValueOnce(response({ detail: "Offline" }, 503));
    const client = createAuthClient();
    const change = vi.fn();
    client.subscribe(change);
    await client.restore();
    await expect(client.logout()).rejects.toThrow(ERROR_MESSAGES.server);
    expect(change).not.toHaveBeenCalledWith(null);
  });
});
