# Workspace IDE frontend

React + Vite, Monaco Editor, xterm, and Lucide icons. Monaco and its language workers are served from local Vite assets and loaded when an editor is opened. The frontend uses the existing Django workspace CRUD APIs and interactive execution WebSocket.

## Development

```sh
npm install
npm run dev
```

Set `VITE_API_URL` to the Django API base (for example, `http://127.0.0.1:8000/api`) and `VITE_WORKSPACE_ID` to an existing workspace UUID in `.env`. Run Django and prepare its Podman images using the project's existing setup. The frontend does not execute code locally.

## Interface

- Explorer supports recursive folders, root selection, hover actions, and right-click menus for creating, renaming, and deleting items.
- Open files have independent draft buffers and Monaco view state. Closing a dirty tab asks before discarding changes.
- Run saves the current content, filename, and detected language before opening the execution WebSocket. A failed save prevents execution; edits made during a save remain Unsaved.
- Terminal stays mounted when switching to Output or Problems. Stop terminates the current program. Clear affects the selected output view.
- Drag panel borders to resize them, or focus a separator and use the arrow keys. The sidebar becomes an overlay on narrow screens.
- Search finds files by name/path. Settings controls the theme, editor font size, and word wrap; preferences persist in local storage.
- Shortcuts: Ctrl/Cmd+S saves, F5 runs, Ctrl/Cmd+B toggles the sidebar.

## Structure

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

The helper tests cover extension display, language detection, ambiguous content, and recursive tree updates. Browser regression checks should use a disposable workspace and cover:

1. Create root/nested folders and files; rename each; delete a file and a nested folder.
2. Edit two files, switch tabs, and verify drafts, cursor positions, and dirty indicators.
3. Save manually, then Run an edited extensionless file; verify the persisted filename, language, content, and output.
4. Delay or fail a save request: newer edits must remain Unsaved, and failed saves must not start execution.
5. Run Python `input()`, C `scanf()`, and C++ `std::cin`; verify output, errors, Stop, and Clear.
6. Switch panel tabs during execution; scroll upward and verify incoming output does not force the view to the bottom.
7. Check both themes, preference persistence, pointer/keyboard resizing, panel maximize/collapse, and a narrow mobile viewport.
