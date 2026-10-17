import { afterEach, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import * as Sentry from "@sentry/react";
import MonitoringBoundary from "./MonitoringBoundary";
import { sentryOptions } from "../lib/monitoring";

vi.mock("@sentry/react", async (original) => ({ ...await original(), makeFetchTransport: vi.fn() }));

afterEach(async () => { await Sentry.close(); });

it("renders children normally with monitoring disabled", () => {
  render(<MonitoringBoundary><p>Editor contents</p></MonitoringBoundary>);
  expect(screen.getByText("Editor contents")).toBeInTheDocument();
  expect(Sentry.makeFetchTransport).not.toHaveBeenCalled();
});

it("captures a React crash through the real SDK with a safe fallback and sanitized final envelope", async () => {
  const secret = "PRIVATE-source-JWT-password-terminal";
  const envelopes = [];
  Sentry.makeFetchTransport.mockReturnValue({
    send: async (envelope) => { envelopes.push(envelope); return { statusCode: 200 }; },
    flush: async () => true,
  });
  // Deliberate in-memory SDK test: no network transport or global integrations.
  Sentry.init({ ...sentryOptions({ MODE: "production", VITE_SENTRY_DSN: "https://public@example.invalid/1" }), integrations: [] });
  Sentry.setUser({ email: secret });
  Sentry.setExtra("source", secret);
  function BrokenEditor() { throw new Error(secret); }
  vi.spyOn(console, "error").mockImplementation(() => {});
  render(<MonitoringBoundary><BrokenEditor /></MonitoringBoundary>);
  expect(screen.getByRole("alert")).toHaveTextContent("Something went wrong");
  expect(screen.getByRole("button", { name: "Reload Shared IDE" })).toBeInTheDocument();
  expect(screen.queryByText(secret)).not.toBeInTheDocument();
  await Sentry.flush(1000);
  expect(envelopes).toHaveLength(1);
  expect(envelopes[0][1][0][1].tags.component).toBe("react");
  expect(JSON.stringify(envelopes)).not.toContain(secret);
});

it("sends only sanitized root timing through the real SDK in static trace mode", async () => {
  const secret = "PRIVATE-query-token-SQL-source";
  const envelopes = [];
  Sentry.makeFetchTransport.mockReturnValue({
    send: async (envelope) => { envelopes.push(envelope); return { statusCode: 200 }; },
    flush: async () => true,
  });
  Sentry.init({
    ...sentryOptions({ MODE: "production", VITE_SENTRY_DSN: "https://public@example.invalid/1" }),
    tracesSampleRate: 1, integrations: [Sentry.browserTracingIntegration({
      instrumentPageLoad: false, instrumentNavigation: false, traceFetch: false, traceXHR: false, enableInp: false,
    })],
  });
  Sentry.startSpan({ name: secret, op: "navigation", forceTransaction: true }, () => {
    Sentry.startSpan({ name: secret, op: "http.client", attributes: { source: secret } }, () => {});
  });
  await Sentry.flush(1000);
  expect(envelopes).toHaveLength(1);
  expect(envelopes[0][1][0][0].type).toBe("transaction");
  expect(envelopes[0][1][0][1].transaction).toBe("Browser navigation");
  expect(envelopes[0][1][0][1].spans).toEqual([]);
  expect(JSON.stringify(envelopes)).not.toContain(secret);
});
