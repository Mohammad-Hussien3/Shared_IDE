import { afterEach, describe, expect, it, vi } from "vitest";
import { ERROR_MESSAGES, getErrorMessage, getTerminalErrorMessage, HttpError, UserFacingError } from "./errors";
import { responseData } from "./api";
import { response } from "../test/workspaceFixtures";

afterEach(() => vi.unstubAllEnvs());

describe("safe error messages", () => {
  it.each([
    [401, "general", "Your session has expired. Please log in again."],
    [401, "login", "Invalid username or password. Please try again."],
    [403, "general", "You don't have permission to do that."],
    [404, "general", ERROR_MESSAGES.missing],
    [409, "general", ERROR_MESSAGES.conflict],
    [408, "general", ERROR_MESSAGES.timeout],
    [413, "general", ERROR_MESSAGES.tooLarge],
    [429, "general", ERROR_MESSAGES.rateLimit],
    [500, "general", ERROR_MESSAGES.server],
    [502, "general", ERROR_MESSAGES.server],
    [503, "execution", ERROR_MESSAGES.runner],
    [504, "general", ERROR_MESSAGES.timeout],
    [418, "general", ERROR_MESSAGES.unexpected],
  ])("maps %s in %s without exposing response details", (status, context, expected) => {
    const error = new HttpError(status, { detail: "Traceback: /srv/private.py password=secret" }, context);
    expect(getErrorMessage(error)).toBe(expected);
    expect(error.message).toBe(expected);
    expect(error.status).toBe(status);
    expect(JSON.stringify(error)).not.toMatch(/private|password=secret|Traceback/);
  });

  it("preserves the CSRF retry code while making the message actionable", () => {
    const error = new HttpError(403, { code: "csrf_failed", detail: "CSRF verification failed: Origin checking failed - http://internal" });
    expect(error.code).toBe("csrf_failed");
    expect(getErrorMessage(error)).toBe(ERROR_MESSAGES.csrf);
    expect(getErrorMessage(new HttpError(403, { detail: "CSRF verification failed" }))).toBe(ERROR_MESSAGES.csrf);
    expect(getErrorMessage(new HttpError(500, { code: "csrf_failed" }))).toBe(ERROR_MESSAGES.server);
  });

  it.each([
    [{ username: ["A user with that username already exists."] }, "Username already exists. Choose another username."],
    [{ password: ["Invalid password"] }, "Invalid password. Please try again."],
    [{ password: ["This password is too short. It must contain at least 8 characters."] }, "Use at least 8 characters for your password."],
    [{ confirm_password: ["Passwords do not match."] }, "Passwords do not match."],
    [{ name: ["This field may not be blank."] }, "Name is required."],
    [{ name: ["Ensure this field has no more than 100 characters."] }, "Name must have no more than 100 characters."],
    [{ parent: ["A folder cannot be its own ancestor."] }, "A folder cannot be moved inside itself or one of its subfolders."],
    [{ language: ["The py extension requires language 'python'."] }, "Choose a language that matches the filename extension."],
  ])("keeps useful validation guidance from %j", (data, expected) => {
    expect(getErrorMessage(new HttpError(400, data))).toBe(expected);
  });

  it.each([
    null, [], "<html>secret</html>", { detail: { traceback: "secret" } },
    { detail: "HTTP 400: Traceback (most recent call last)" },
    { non_field_errors: ["DATABASE_PASSWORD=secret", { internal: "secret" }] },
  ])("rejects unrecognized or malformed validation content %j", data => {
    expect(getErrorMessage(new HttpError(400, data))).toBe(ERROR_MESSAGES.validation);
  });

  it("does not echo secrets or arbitrary text even in known validation fields", () => {
    const error = new HttpError(422, {
      username: ["Username already exists. Authorization: Bearer secret"],
      password: ["secret", { traceback: "/srv/internal.py" }],
      content: ["print('private source')"],
      internal_setting: "DATABASE_PASSWORD=secret",
    });
    expect(getErrorMessage(error)).toBe("Username is invalid. Please check it. Password is invalid. Please check it. File content is invalid. Please check it.");
    expect(JSON.stringify(error)).not.toMatch(/secret|internal|private source/);
  });

  it.each(["Failed to fetch", "Load failed", "NetworkError when attempting to fetch resource.", "Network offline"])("handles network error %s", message => {
    expect(getErrorMessage(new TypeError(message))).toBe(ERROR_MESSAGES.network);
  });

  it("does not display unexpected exception messages or HTML", async () => {
    expect(getErrorMessage(new Error("HTTP 500: password=secret"))).toBe(ERROR_MESSAGES.unexpected);
    expect(getErrorMessage(undefined)).toBe(ERROR_MESSAGES.unexpected);
    expect(getErrorMessage(new DOMException("internal", "AbortError"))).toBe(ERROR_MESSAGES.cancelled);
    expect(getErrorMessage(new DOMException("internal", "TimeoutError"))).toBe(ERROR_MESSAGES.timeout);
    const htmlResponse = { ok: false, status: 502, json: () => Promise.reject(new SyntaxError("<html>private traceback</html>")) };
    await expect(responseData(htmlResponse)).rejects.toThrow(ERROR_MESSAGES.server);
    await expect(responseData({ ...htmlResponse, ok: true, status: 200 })).rejects.toThrow(ERROR_MESSAGES.unexpected);
    await expect(responseData(response(null, 500))).rejects.toThrow(ERROR_MESSAGES.server);
    await expect(responseData(response({}, 204))).resolves.toEqual({});
    expect(getErrorMessage(new UserFacingError("Select a file before running code."))).toBe("Select a file before running code.");
  });

  it.each([
    ["Isolated runner unavailable: /srv/config SECRET=private", ERROR_MESSAGES.runner],
    ["Error: docker.io/library/python:3.12-alpine: image not known", ERROR_MESSAGES.runner],
    ["Execution timed out.", ERROR_MESSAGES.executionTimeout],
    ["Isolated runner unavailable: Podman query timed out", ERROR_MESSAGES.runner],
    ["Output limit reached.", ERROR_MESSAGES.outputLimit],
    ["There is no isolated runner for javascript.", ERROR_MESSAGES.language],
    ["Session expired or access revoked. Please log in again.", ERROR_MESSAGES.session],
    ["Traceback (most recent call last): /home/server/internal.py", ERROR_MESSAGES.execution],
    [null, ERROR_MESSAGES.execution],
    [{ message: "secret" }, ERROR_MESSAGES.execution],
  ])("sanitizes terminal service error %j", (raw, expected) => {
    expect(getTerminalErrorMessage(raw)).toBe(expected);
  });

  it("logs useful development metadata once without payloads or credentials", () => {
    vi.stubEnv("DEV", true);
    vi.stubEnv("MODE", "development");
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const error = new HttpError(403, { code: "csrf_failed", detail: "secret", password: "secret", access: "secret" });
    getErrorMessage(error, "register");
    getErrorMessage(error, "register");
    expect(debug).toHaveBeenCalledExactlyOnceWith("[IDE error]", {
      operation: "register", status: 403, code: "csrf_failed", type: "HttpError", fields: ["password"],
    });
    expect(JSON.stringify(debug.mock.calls)).not.toContain("secret");
    vi.stubEnv("DEV", false);
    getErrorMessage(new HttpError(500, { detail: "secret" }));
    expect(debug).toHaveBeenCalledTimes(1);
  });
});
