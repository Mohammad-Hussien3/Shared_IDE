# Workspace IDE frontend

React + Vite, Monaco Editor, xterm, and Lucide icons. Monaco and its language workers are served from local Vite assets and loaded when an editor is opened. The frontend uses the existing Django workspace CRUD APIs and interactive execution WebSocket.

## Development

```sh
npm install
npm run dev
```

Set `VITE_API_URL=/api` (see `.env.example`). Vite forwards `/api` HTTP and WebSocket requests to Django at `http://127.0.0.1:8000`, while browser cookies stay on whichever frontend hostname you open: `http://localhost:5173` or `http://127.0.0.1:5173`. Restart Vite after changing `.env`. For a different backend port, start Vite with `DEV_API_TARGET=http://127.0.0.1:8001 npm run dev`. Port 5173 is fixed so Vite will not silently switch to an untrusted origin.

Register or log in, then create/open a workspace from the dashboard. `VITE_WORKSPACE_ID` and the old anonymous localStorage selection are no longer used. Run Django migrations and prepare its Podman images using the project's existing setup. The frontend does not execute code locally.

### CSRF and local hostnames

A frontend on `localhost` calling an API on `127.0.0.1` cannot use the default `SameSite=Lax` cookies, even with correct CORS/trusted-origin settings. The original local configuration reproduced HTTP 403 with `X-CSRFToken` present but the CSRF cookie missing. Use the relative `/api` URL above; if using a direct absolute API URL, use the same hostname for both apps.

Django's `FRONTEND_ORIGINS` defaults to `http://localhost:5173,http://127.0.0.1:5173` for both CORS and CSRF origin checking. Add an exact origin if you use a custom frontend port. For local HTTP use `AUTH_COOKIE_SECURE=false`; production HTTPS defaults remain secure. CSRF protection, HttpOnly cookies, and `SameSite=Lax` stay enabled.

The API client fetches `/api/auth/csrf/` with credentials and caching disabled before cookie-authenticated requests. Registration, login, refresh, and logout send credentials and `X-CSRFToken`. A stale token is refreshed once after an explicit CSRF rejection; persistent failures show a friendly refresh prompt. CSRF protection and the same-origin development proxy are independent of error message formatting. Production needs its own `/api` reverse proxy or a correctly configured absolute API URL; Vite's development proxy is not part of the production build.

## Error handling

`src/lib/errors.js` centralizes user-facing error messages. HTTP status and the CSRF retry code remain available to the client, while authentication, workspace dialogs, file operations, saves, and terminal service errors use the existing themed inline displays. Recognized backend validation messages become specific guidance; unknown validation text, server tracebacks, paths, and configuration details are not echoed. Add new safe validation templates there when adding API validation rules.

Use `getErrorMessage(error)` in UI catch handlers and `getTerminalErrorMessage(message)` for WebSocket service errors. `UserFacingError` is reserved for local, developer-authored instructions and must never wrap server text. Program stdout/stderr and compiler diagnostics remain visible as program output.

Development DevTools receive `[IDE error]` records containing the operation, numeric status, recognized error code, error type, and known validation field names. Bodies, credentials, tokens, headers, source code, URLs, and raw exception messages are excluded; these logs are disabled in production builds.

## Interface

- Explorer supports recursive folders, root selection, hover actions, and right-click menus for creating, renaming, and deleting items.
- Open files have independent draft buffers and Monaco view state. Closing a dirty tab asks before discarding changes.
- Run saves the current content, filename, and detected language before opening the execution WebSocket. A failed save prevents execution; edits made during a save remain Unsaved.
- Terminal stays mounted when switching to Output or Problems. Stop terminates the current program. Clear affects the selected output view.
- Drag panel borders to resize them, or focus a separator and use the arrow keys. The sidebar becomes an overlay on narrow screens.
- Search finds files by name/path. Settings controls the theme, editor font size, and word wrap; preferences persist in local storage.
- Shortcuts: Ctrl/Cmd+S saves, F5 runs, Ctrl/Cmd+B toggles the sidebar.

## Structure

- `src/auth/AuthContext.jsx` and `src/lib/api.js`: in-memory access tokens, refresh-cookie session restoration, authenticated HTTP requests, and logout.
- `src/pages/AuthPage.jsx` and `src/pages/WorkspaceDashboard.jsx`: registration, login, and user-owned workspaces.

- `src/pages/WorkspacePage.jsx`: workspace state, existing API calls, save/run lifecycle, and layout composition.
- `src/components/Explorer.jsx`: recursive tree, context menus, and file search.
- `src/components/CodeEditor.jsx` and `src/lib/monaco.js`: lazy editor loading and local language worker setup.
- `src/components/EditorTabs.jsx`: open files and dirty indicators.
- `src/components/TerminalPanel.jsx`: persistent xterm session, Output/Problems tabs, panel controls.
- `src/components/IdePrimitives.jsx`: buttons, file icons, dialogs, status indicators, and resize handles.
- `src/components/SettingsPanel.jsx`: appearance/editor preferences.
- `src/lib/ideFiles.js`: shared filename, language, and recursive tree helpers.
- `src/App.css`: dark/light design tokens and responsive IDE styles.

## Checks

```sh
npm test
npm run lint
npm run build
```

Vitest and React Testing Library cover filename/tree helpers, Explorer operations, tabs, dialogs, settings, save races, execution events, and terminal behavior. Browser regression checks should use a disposable workspace and cover:

1. Create root/nested folders and files; rename each; delete a file and a nested folder.
2. Edit two files, switch tabs, and verify drafts, cursor positions, and dirty indicators.
3. Save manually, then Run an edited extensionless file; verify the persisted filename, language, content, and output.
4. Delay or fail a save request: newer edits must remain Unsaved, and failed saves must not start execution.
5. Run Python `input()`, C `scanf()`, and C++ `std::cin`; verify output, errors, Stop, and Clear.
6. Switch panel tabs during execution; scroll upward and verify incoming output does not force the view to the bottom.
7. Check both themes, preference persistence, pointer/keyboard resizing, panel maximize/collapse, and a narrow mobile viewport.
