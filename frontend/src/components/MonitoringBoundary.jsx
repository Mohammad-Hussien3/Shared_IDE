import { ErrorBoundary } from "@sentry/react";

function CrashFallback() {
  return <main className="ide-shell account-shell theme-dark">
    <section className="auth-card" role="alert">
      <h1>Something went wrong</h1>
      <p>The editor encountered an unexpected problem. Reload to try again. Unsaved changes may be lost.</p>
      <button className="button button-primary" type="button" onClick={() => window.location.reload()}>Reload Shared IDE</button>
    </section>
  </main>;
}

export default function MonitoringBoundary({ children }) {
  return <ErrorBoundary fallback={<CrashFallback />} showDialog={false} beforeCapture={(scope) => scope.setTag("component", "react")}>
    {children}
  </ErrorBoundary>;
}
