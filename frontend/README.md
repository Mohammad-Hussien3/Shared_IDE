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

## Google sign-in setup

Google sign-in is optional; username/password authentication continues to work without Google credentials. The backend uses Authlib Authorization Code + PKCE and validates Google's signed OpenID Connect ID token. All unit tests mock Google network calls and need no real credentials.

### Google Cloud and local development

1. Create or select a project in [Google Cloud Console](https://console.cloud.google.com/). In Google Auth Platform, configure Branding (application name, support email, developer contact) and Audience. For development, keep an external app in Testing and add the Google accounts you will use as test users. Configure the `openid` and email identity scopes only.
2. Under Clients, create an OAuth client with application type **Web application**. Add this exact **Authorized redirect URI**, including its trailing slash:

   ```text
   http://localhost:5173/api/auth/google/callback/
   ```

   This is a Django endpoint reached through Vite's `/api` proxy. Do not register the React finish page `/auth/google/callback` as Google's redirect URI. No Google JavaScript SDK is used, so authorized JavaScript origins are not required by this flow.
3. Put the Web application client ID and secret in **backend/.env**, never in a `VITE_` variable, source control, a screenshot, or frontend code:

   ```dotenv
   GOOGLE_CLIENT_ID=your-web-client-id.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=your-web-client-secret
   GOOGLE_FRONTEND_ORIGIN=http://localhost:5173
   GOOGLE_REDIRECT_URI=http://localhost:5173/api/auth/google/callback/
   DJANGO_DEBUG=true
   AUTH_COOKIE_SECURE=false
   AUTH_COOKIE_SAMESITE=Lax
   FRONTEND_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
   ```

4. Activate your backend virtual environment and install dependencies/apply the accounts migration from the repository root:

   ```sh
   python -m pip install -r backend/requirements.txt
   python backend/manage.py migrate
   ```

5. Restart Django and Vite. Keep `VITE_API_URL=/api` in `frontend/.env`, run Django on port 8000, and open **http://localhost:5173**. Select **Continue with Google** on Login or Register.

Use one browser hostname consistently. If you prefer `127.0.0.1`, change both Google URL settings to that hostname, register that exact callback with Google, and use the corresponding trusted frontend origin. Cookies for `localhost` cannot bind a flow returning to `127.0.0.1`. Starting Google login from an origin other than `GOOGLE_FRONTEND_ORIGIN` is rejected with a friendly message.

### Account linking and session behavior

- A first Google login creates a regular Django user with an opaque unique username and an unusable password. Its workspaces use the existing ownership checks. Returning users are identified by Google's stable `sub`, even if their email changes.
- A matching email never automatically merges accounts. To link an existing password account, log in normally, select **Connect Google account** on the dashboard, confirm its current password, and choose the Google identity. An identity already linked to another user cannot be moved.
- The server stores a ten-minute, single-use attempt with PKCE verifier and nonce. An HttpOnly browser cookie binds the callback to the browser that started the flow. Linking also requires the original active refresh session and unchanged password; logout invalidates it.
- The callback sets the existing HttpOnly refresh cookie and redirects with a fixed result code only. React restores the session through the existing CSRF-protected refresh endpoint. Application JWTs and Google tokens never appear in redirect URLs or localStorage. Google access/refresh tokens are not persisted.
- Starting a new flow replaces the browser's previous attempt. Finish sign-in in one tab; restarting is required after cancellation, expiration, or replay rejection.

Endpoints: `POST /api/auth/google/start/`, authenticated/password-confirmed `POST /api/auth/google/link/`, and `GET /api/auth/google/callback/`. The POST endpoints require the existing CSRF cookie/header. Frontend-supplied identities and redirect destinations are ignored.

### Production

Serve the frontend and `/api` behind an HTTPS reverse proxy on the same hostname. Register a separate production Web client or add the exact production callback in Google Cloud. For example:

```dotenv
DJANGO_DEBUG=false
DJANGO_ALLOWED_HOSTS=ide.example.com
FRONTEND_ORIGINS=https://ide.example.com
GOOGLE_FRONTEND_ORIGIN=https://ide.example.com
GOOGLE_REDIRECT_URI=https://ide.example.com/api/auth/google/callback/
AUTH_COOKIE_SECURE=true
AUTH_COOKIE_SAMESITE=Lax
```

Set production Google credentials through backend secrets management. This integration requires matching frontend/callback schemes and hostnames and `SameSite=Lax`; insecure production cookies or HTTP callbacks are rejected. The reverse proxy must forward the callback to Django, preserve cookies, serve React's finish route, and avoid recording callback query strings (they contain short-lived authorization codes). Configure Django's trusted proxy HTTPS handling for your deployment. Follow Google's consent-screen publishing/verification requirements before public launch. A shared cache is recommended for provider JWKS and authentication throttling across multiple Django workers.

### Verification

```sh
python backend/manage.py test --noinput
cd frontend
npm test
npm run lint
npm run build
```

Backend tests validate real signed test ID tokens with mocked Google token/JWKS requests: new/returning users, ownership, invalid claims/signatures, key rotation, state/browser binding, replay, email collisions, password-confirmed linking, and provider failures. Existing password/session and WebSocket tests remain in the full suite. Frontend tests cover both buttons, duplicate clicks, redirects, callback messages, and linking. CI needs no Google secrets or running containers.

**Live Google verification still requires your OAuth client:** sign in with an allowed test account, create a workspace, log out, and sign in again to confirm it remains. Verify a second account cannot access that workspace. Then test cancellation and password-account linking. Automated mocked tests cannot verify your Google Cloud consent configuration or registered redirect URI.

References: [Google OpenID Connect setup](https://developers.google.com/identity/openid-connect/openid-connect), [Authlib HTTP OAuth client](https://docs.authlib.org/en/stable/oauth2/client/http/index.html), and [Google button branding](https://developers.google.com/identity/branding-guidelines). The button uses Google's official gradient G asset and a locally served Google Sans Medium font; see `src/assets/google-sans-LICENSE.txt`. It does not load a third-party script or font during page rendering.

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
