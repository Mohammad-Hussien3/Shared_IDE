import * as Sentry from "@sentry/react";

const ERROR_TYPES = new Set(["Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "URIError", "EvalError", "AggregateError"]);
const COMPONENTS = new Set(["frontend", "react", "api", "websocket"]);
const hex = (value, length) => typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`).test(value);
const label = (value, fallback) => typeof value === "string" && /^[\w.@+/-]{1,100}$/.test(value) ? value : fallback;

function safeFrame(frame) {
  if (typeof frame.filename !== "string" || /^(?:blob:|data:|file:)/.test(frame.filename)) return null;
  let path;
  try { path = new URL(frame.filename, "https://app.invalid").pathname; } catch { return null; }
  // Application stack locations only; no Monaco document URIs, query strings,
  // hostnames, function names, component stacks, locals, or source snippets.
  if (!/^\/assets\/[\w.-]+\.js$/.test(path) && !/^\/src\/(?:[\w-]+\/)*[\w.-]+\.[jt]sx?$/.test(path)) return null;
  return {
    filename: path, in_app: true,
    ...(Number.isInteger(frame.lineno) && frame.lineno > 0 ? { lineno: frame.lineno } : {}),
    ...(Number.isInteger(frame.colno) && frame.colno > 0 ? { colno: frame.colno } : {}),
  };
}

export function sanitizeEvent(event, metadata) {
  if (!event || typeof event !== "object") return null;
  const result = { platform: "javascript", ...metadata };
  if (hex(event.event_id, 32)) result.event_id = event.event_id;
  if (Number.isFinite(event.timestamp)) result.timestamp = event.timestamp;
  if (event.type === "transaction") {
    const trace = event.contexts?.trace;
    if (!hex(trace?.trace_id, 32) || !hex(trace?.span_id, 16) || !Number.isFinite(event.start_timestamp) || !Number.isFinite(event.timestamp)) return null;
    return {
      ...result, type: "transaction", transaction: "Browser navigation",
      start_timestamp: event.start_timestamp, spans: [],
      contexts: { trace: { trace_id: trace.trace_id, span_id: trace.span_id, op: "ui.navigation" } },
    };
  }
  const values = event.exception?.values?.slice(-10).map((exception) => ({
    type: ERROR_TYPES.has(exception.type) ? exception.type : "Error",
    value: "Unexpected application error (details withheld).",
    stacktrace: { frames: (exception.stacktrace?.frames || []).slice(-50).map(safeFrame).filter(Boolean) },
  }));
  if (!values?.length) return null;
  const tags = { component: COMPONENTS.has(event.tags?.component) ? event.tags.component : "frontend" };
  const status = Number(event.tags?.http_status);
  if (Number.isInteger(status) && status >= 500 && status <= 599) tags.http_status = status;
  return { ...result, level: "error", exception: { values }, tags };
}

export function sanitizeEnvelope(envelope, metadata) {
  const headers = {};
  const items = [];
  for (const [itemHeader, payload] of envelope[1]) {
    if (!["event", "transaction"].includes(itemHeader.type)) continue;
    const event = sanitizeEvent(payload, metadata);
    if (!event) continue;
    if (event.event_id) headers.event_id = event.event_id;
    items.push([{ type: event.type === "transaction" ? "transaction" : "event" }, event]);
  }
  // Drop dynamic sampling context, attachment filenames, Replay, logs, profiles,
  // session items, and any future SDK item types, even if an integration adds them.
  return [headers, items];
}

export function privateTransport(options, metadata) {
  const transport = Sentry.makeFetchTransport({
    ...options, fetchOptions: { credentials: "omit", referrerPolicy: "no-referrer" },
  });
  return {
    send(envelope) {
      const safe = sanitizeEnvelope(envelope, metadata);
      return safe[1].length ? transport.send(safe) : Promise.resolve({});
    },
    flush: (timeout) => transport.flush(timeout),
  };
}

export function sentryOptions(env) {
  if (!env.VITE_SENTRY_DSN?.trim() || env.MODE === "test" || env.CI === "true" || /^(?:1|true|yes)$/i.test(env.VITE_SENTRY_DISABLED || "")) return null;
  const metadata = { environment: label(env.VITE_SENTRY_ENVIRONMENT, env.MODE || "development") };
  const release = label(env.VITE_SENTRY_RELEASE, null);
  if (release) metadata.release = release;
  const configuredRate = Number(env.VITE_SENTRY_TRACES_SAMPLE_RATE || 0);
  const rate = Number.isFinite(configuredRate) ? Math.min(Math.max(configuredRate, 0), 0.05) : 0;
  return {
    dsn: env.VITE_SENTRY_DSN, ...metadata, debug: false,
    defaultIntegrations: false,
    integrations: [
      Sentry.globalHandlersIntegration(), Sentry.browserApiErrorsIntegration(),
      ...(rate > 0 ? [Sentry.browserTracingIntegration({ traceFetch: false, traceXHR: false, enableInp: false })] : []),
    ],
    sendDefaultPii: false, sendClientReports: false,
    maxBreadcrumbs: 0, beforeBreadcrumb: () => null,
    beforeSendLog: () => null, beforeSendMetric: () => null,
    beforeSend: (event) => sanitizeEvent(event, metadata),
    beforeSendTransaction: (event) => sanitizeEvent(event, metadata),
    transport: (options) => privateTransport(options, metadata),
    tracesSampleRate: rate, traceLifecycle: "static", tracePropagationTargets: [],
    replaysSessionSampleRate: 0, replaysOnErrorSampleRate: 0,
  };
}

export function initMonitoring(env = import.meta.env) {
  const options = sentryOptions(env);
  if (!options) return false;
  try {
    Sentry.init(options);
    return true;
  } catch {
    console.warn("Sentry initialization failed; monitoring is disabled.");
    return false;
  }
}

export function captureApiFailure(status) {
  if (!Sentry.isEnabled() || !Number.isInteger(status) || status < 500 || status > 599) return;
  try {
    // Never pass the response, request, URL, auth context, or server error text.
    Sentry.captureException(new Error("API service failure"), { tags: { component: "api", http_status: status } });
  } catch { /* Monitoring must not change API behavior. */ }
}
