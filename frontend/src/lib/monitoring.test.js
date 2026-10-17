import { describe, expect, it, vi } from "vitest";
import * as Sentry from "@sentry/react";
import { captureApiFailure, initMonitoring, privateTransport, sanitizeEnvelope, sanitizeEvent, sentryOptions } from "./monitoring";
import { responseData } from "./api";

vi.mock("@sentry/react", async (original) => ({
  ...await original(), init: vi.fn(), isEnabled: vi.fn(() => false),
  captureException: vi.fn(), makeFetchTransport: vi.fn(),
}));

const SECRET = "PRIVATE-password-JWT-OAuth-verification-token-source-stdin-stdout";
const metadata = { environment: "staging", release: "shared-ide@abc123" };
const configured = { MODE: "production", VITE_SENTRY_DSN: "https://public@example.invalid/1" };
const dirtyEvent = () => ({
  event_id: "a".repeat(32), timestamp: 1234,
  exception: { values: [{ type: "TypeError", value: SECRET, mechanism: { data: SECRET }, stacktrace: { frames: [
    { filename: `https://ide.test/assets/index-abc.js?token=${SECRET}`, lineno: 42, colno: 7, function: SECRET, vars: { password: SECRET }, context_line: SECRET, pre_context: [SECRET] },
    { filename: `file:///${SECRET}.py` }, { filename: `https://ide.test/verify-email?token=${SECRET}` },
  ] } }] },
  request: { url: SECRET, data: SECRET, headers: { Authorization: SECRET }, cookies: SECRET },
  user: { email: SECRET, id: SECRET }, extra: { componentStack: SECRET, editor: SECRET },
  breadcrumbs: [{ message: SECRET }], contexts: { terminal: SECRET },
  tags: { component: "react", filename: SECRET }, environment: SECRET, release: SECRET,
});

describe("private Sentry monitoring", () => {
  it("is disabled without a DSN, in tests, in CI, and by the kill switch", () => {
    for (const env of [{}, { ...configured, MODE: "test" }, { ...configured, CI: "true" }, { ...configured, VITE_SENTRY_DISABLED: "true" }]) {
      expect(initMonitoring(env)).toBe(false);
    }
    expect(initMonitoring()).toBe(false); // Actual Vitest mode.
    expect(Sentry.init).not.toHaveBeenCalled();
  });

  it("initializes the SDK only when enabled and safely handles invalid configuration", () => {
    expect(initMonitoring(configured)).toBe(true);
    expect(Sentry.init).toHaveBeenCalledWith(expect.objectContaining({ dsn: configured.VITE_SENTRY_DSN }));
    Sentry.init.mockImplementationOnce(() => { throw new Error(SECRET); });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(initMonitoring(configured)).toBe(false);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(SECRET);
  });

  it("disables Replay, breadcrumbs, sensitive integrations and outgoing trace propagation", () => {
    const options = sentryOptions(configured);
    expect(options.defaultIntegrations).toBe(false);
    expect(options.sendDefaultPii).toBe(false);
    expect(options.sendClientReports).toBe(false);
    expect(options.tracePropagationTargets).toEqual([]);
    expect(options.traceLifecycle).toBe("static");
    expect(options.replaysSessionSampleRate).toBe(0);
    expect(options.replaysOnErrorSampleRate).toBe(0);
    expect(options.beforeBreadcrumb({ message: SECRET })).toBeNull();
    expect(options.beforeSendLog({ body: SECRET })).toBeNull();
    expect(options.beforeSendMetric({ value: SECRET })).toBeNull();
    expect(options.integrations.map((item) => item.name)).toEqual(["GlobalHandlers", "BrowserApiErrors"]);
  });

  it.each([["0.01", .01], ["1", .05], ["-1", 0], ["NaN", 0], ["", 0]])("caps optional performance sampling: %s", (raw, rate) => {
    const options = sentryOptions({ ...configured, VITE_SENTRY_TRACES_SAMPLE_RATE: raw });
    expect(options.tracesSampleRate).toBe(rate);
    expect(options.integrations.some((item) => item.name === "BrowserTracing")).toBe(rate > 0);
  });

  it("rebuilds errors with only deployment metadata, type and application stack locations", () => {
    const event = sanitizeEvent(dirtyEvent(), metadata);
    expect(JSON.stringify(event)).not.toContain(SECRET);
    expect(event.exception.values[0]).toEqual({
      type: "TypeError", value: "Unexpected application error (details withheld).",
      stacktrace: { frames: [{ filename: "/assets/index-abc.js", in_app: true, lineno: 42, colno: 7 }] },
    });
    expect(event.release).toBe(metadata.release);
    expect(event.tags).toEqual({ component: "react" });
    expect(sanitizeEvent(event, metadata)).toEqual(event);
    expect(sanitizeEvent({ message: SECRET }, metadata)).toBeNull();
    const custom = dirtyEvent();
    custom.exception.values[0].type = SECRET;
    expect(sanitizeEvent(custom, metadata).exception.values[0].type).toBe("Error");
  });

  it("strips routes, URLs, query strings, SQL, fetch details and child spans from timing events", () => {
    const event = sanitizeEvent({ ...dirtyEvent(), type: "transaction", transaction: SECRET, start_timestamp: 1230,
      spans: [{ description: SECRET }], contexts: { trace: { trace_id: "b".repeat(32), span_id: "c".repeat(16), data: SECRET } },
    }, metadata);
    expect(JSON.stringify(event)).not.toContain(SECRET);
    expect(event.transaction).toBe("Browser navigation");
    expect(event.spans).toEqual([]);
    expect(event.start_timestamp).toBe(1230);
    expect(event.exception).toBeUndefined();
  });

  it("filters final envelope headers and every non-error/non-transaction item", async () => {
    const envelope = [{ trace: { transaction: SECRET }, sdk: SECRET }, [
      [{ type: "event", filename: SECRET }, dirtyEvent()],
      ...["attachment", "session", "profile", "log", "span", "replay_event", "client_report"].map((type) => [{ type }, SECRET]),
    ]];
    const expected = sanitizeEnvelope(envelope, metadata);
    expect(JSON.stringify(expected)).not.toContain(SECRET);
    expect(expected[0]).toEqual({ event_id: "a".repeat(32) });
    expect(expected[1]).toHaveLength(1);
    const send = vi.fn().mockResolvedValue({ statusCode: 200 });
    const flush = vi.fn().mockResolvedValue(true);
    Sentry.makeFetchTransport.mockReturnValueOnce({ send, flush });
    const transport = privateTransport({ url: "https://sentry.invalid/envelope" }, metadata);
    await transport.send(envelope);
    expect(send).toHaveBeenCalledWith(expected);
    expect(Sentry.makeFetchTransport).toHaveBeenCalledWith(expect.objectContaining({
      fetchOptions: { credentials: "omit", referrerPolicy: "no-referrer" },
    }));
    await transport.send([{}, [[{ type: "attachment" }, SECRET]]]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(await transport.flush(100)).toBe(true);
  });

  it("captures only 5xx categories, without altering API errors or passing bodies to Sentry", async () => {
    Sentry.isEnabled.mockReturnValue(true);
    for (const status of [400, 401, 403, 404, 422, 429]) {
      await expect(responseData({ status, ok: false, json: async () => ({ detail: SECRET }) })).rejects.toHaveProperty("status", status);
    }
    expect(Sentry.captureException).not.toHaveBeenCalled();
    await expect(responseData({ status: 503, ok: false, json: async () => ({ detail: SECRET }) })).rejects.toHaveProperty("status", 503);
    expect(Sentry.captureException).toHaveBeenCalledWith(expect.any(Error), { tags: { component: "api", http_status: 503 } });
    expect(Sentry.captureException.mock.calls[0][0].message).not.toContain(SECRET);
    // HTML and malformed 500 bodies are also reported with a static error.
    await expect(responseData({ status: 500, ok: false, json: async () => { throw new Error(SECRET); } })).rejects.toHaveProperty("status", 500);
    expect(Sentry.captureException).toHaveBeenCalledTimes(2);
    Sentry.captureException.mockImplementationOnce(() => { throw new Error(SECRET); });
    expect(() => captureApiFailure(503)).not.toThrow();
  });
});
