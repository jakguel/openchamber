# packages/vscode — VS Code Extension

Provides the VS Code runtime surface: an extension host that manages OpenCode and a webview that mounts the shared UI.

## Structure

```
src/              # Extension host (Node.js, VS Code API)
src/bridge-*-runtime.ts  # Per-capability bridge runtimes (see pattern below)
webview/          # Webview bootstrap + bridge API layer
webview/api/      # Client-side bridge wrappers (mirrors packages/web/src/api/)
```

## Key Architecture: Bridge Pattern

**Each runtime capability has a dedicated bridge file:**

| Bridge file | Capability |
|---|---|
| `bridge-config-runtime.ts` | Configuration |
| `bridge-settings-runtime.ts` | Settings |
| `bridge-system-runtime.ts` | System info / host queries |
| `bridge-proxy-runtime.ts` | HTTP proxy passthrough |
| `bridge-fs-runtime.ts` | Filesystem access |
| `bridge-localfs-proxy-runtime.ts` | Local FS proxy |
| `bridge-git-runtime.ts` | Git operations |
| `bridge-git-process-runtime.ts` | Git process dispatch |
| `bridge-git-special-runtime.ts` | Special git ops (rebase, cherry-pick) |

The webview sends messages via `postMessage`; the extension host dispatches to the correct bridge runtime. `webview/api/*.ts` are the typed client-side wrappers for each capability.

## Key Files

| File | Lines | Role |
|---|---|---|
| `src/extension.ts` | — | `activate`/`deactivate`; registers all providers + OpenCode manager |
| `src/bridge.ts` | — | Main webview↔host message dispatch |
| `src/gitService.ts` | 3684 | Git service (large — prefer surgical edits) |
| `src/opencodeConfig.ts` | 2794 | OpenCode config management (large — prefer surgical edits) |
| `src/ChatViewProvider.ts` | — | Main chat webview panel |
| `src/AgentManagerPanelProvider.ts` | — | Agent manager panel |
| `src/sseProxy.ts` | — | Proxies SSE events from extension host to webview |
| `webview/main.tsx` | 1755 | Webview bootstrap + bridge wiring |
| `src/DOCUMENTATION.md` | — | **Read before editing any module here** |

## Webview API vs Web API

`webview/api/*.ts` mirrors `packages/web/src/api/*.ts` but routes through the extension bridge instead of direct HTTP. When adding a new capability:
1. Add bridge runtime in `src/bridge-<name>-runtime.ts`
2. Add client wrapper in `webview/api/<name>.ts`
3. Wire in `src/bridge.ts` dispatch and `webview/main.tsx`

## Where to Look

| Task | Location |
|---|---|
| Add VS Code command | `src/extension.ts` (registerCommand) |
| Add new bridge capability | `src/bridge-<name>-runtime.ts` + `webview/api/<name>.ts` |
| Git operation in extension | `src/gitService.ts` (read first — 3684 lines) |
| Config management | `src/opencodeConfig.ts` (read first — 2794 lines) |
| Theme mapping (VS Code → tokens) | `src/theme.ts` + `src/shikiThemes.ts` |
| GitHub in extension | `src/githubAuth.ts`, `src/githubPr.ts`, `src/githubPulls.ts` |
| Webview HTML generation | `src/webviewHtml.ts` |
| Skills from VS Code | `src/skillsCatalog.ts` |
