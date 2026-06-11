# packages/electron — Desktop Shell

Electron desktop app. Boots the web server in-process and loads the UI over loopback.

## Architecture

**No sidecar subprocess.** The web server runs in the same Node process as Electron main:

```javascript
// main.mjs
const server = await startWebUiServer({ ... });  // from @openchamber/web/server/index.js
const port = server.getPort();
mainWindow.loadURL(`http://127.0.0.1:${port}`);
```

Notifications flow via `onDesktopNotification` callback — NOT stdout parsing.

## Key Files

| File | Role |
|---|---|
| `main.mjs` | Main process: server boot, window management, menus, updater, deep links, SSH |
| `preload.mjs` | Preload script: exposes desktop IPC bridge to renderer (contextBridge) |
| `tray.mjs` | System tray icon + menu |
| `ssh-manager.mjs` | SSH tunnel and remote connection management |

## What Belongs Here

- Window creation, sizing, position persistence
- Native menus, dock/tray icons
- System notifications (via `onDesktopNotification` callback)
- Auto-updater
- Deep-link URL scheme handling
- Runtime host switching (local ↔ remote)
- SSH / tunnel management
- Local IPC gates (preload ↔ renderer)

**Does NOT belong here:** OpenCode feature backends, shared UI features, anything renderable in the web surface.

## Windows: windowsHide Rule

Any non-user-visible `child_process` call on Windows MUST use `windowsHide: true`. Background helpers also need `stdio: 'ignore'`. Do NOT use `cmd.exe /c` pipelines — `windowsHide` only applies to the first child. For delayed background operations, prefer a single hidden process (`powershell.exe -WindowStyle Hidden -EncodedCommand …`) or a native Electron API.

## Build

```bash
bun run electron:dev        # Dev mode
bun run electron:build      # Production package (primary release target)
bun run electron:dev:bundled  # Dev with bundled server
```

## Where to Look

| Task | Location |
|---|---|
| Window behavior (create/resize/close) | `main.mjs` |
| Expose new API to renderer | `preload.mjs` (contextBridge) |
| Tray icon or menu | `tray.mjs` |
| SSH / remote connection | `ssh-manager.mjs` |
| Desktop notifications | `main.mjs` `onDesktopNotification` callback |
