# packages/web — Web App, Server, and CLI

Web build target + Express server that embeds/proxies OpenCode + the `openchamber` CLI.

## Structure

```
src/             # Web frontend (main.tsx bootstrap, api/ client wrappers, sw.ts PWA)
src/api/         # Client-side RuntimeAPI wrappers — NOT Express route handlers
server/          # Express server (index.js entry, lib/ domain modules)
server/lib/      # 25 domain modules, most with DOCUMENTATION.md
bin/             # CLI (cli.js ~3500 LOC, cli-output.js, cli-entry.js)
```

## Critical distinction: src/api/ vs server/lib/

- `src/api/*.ts` — **client-side** TypeScript wrappers that call the server. Live in the browser bundle.
- `server/lib/*/routes.js` — **Express route handlers** registered server-side. Never confuse the two.

## CLI Commands (bin/cli.js)

| Command | Description |
|---|---|
| `serve` | Start web server (daemon by default) |
| `stop` | Stop running instance(s) |
| `restart` | Stop + start |
| `status` | Show server status |
| `tunnel` | Tunnel lifecycle (`status` / `start` / `stop`) |
| `startup` | System startup management (systemd / launchd) |
| `logs` | Tail OpenChamber logs |
| `connect-url` | Generate URL/QR for remote client |
| `update` | Check and install updates |

**IMPORTANT** (`cli.js:3472`): foreground server must stay **inline/in-process** — do NOT convert to a subprocess spawn.

## Server Lib Modules (server/lib/)

Most have a `DOCUMENTATION.md` — **read it before editing the module**.

| Module | Key purpose |
|---|---|
| **opencode/** (largest) | OpenCode server lifecycle, startup, proxying, config/settings, agents/skills/plugins/MCP, route registration |
| **event-stream/** | SSE/WS runtime event fanout, upstream reader, per-directory + global bridges |
| **ui-auth/** | Session auth, client tokens, passkey/reset, route-level auth gates |
| **quota/** | Provider quota/usage registry + dispatch; 15+ provider integrations |
| **github/** | OAuth device flow, Octokit factory, PR status, repo URL parsing |
| **terminal/** | PTY runtime + WebSocket protocol (normalization, replay, rate-limit) |
| **tunnels/** | Tunnel provider setup (Cloudflare, ngrok) + runtime helpers |
| **git/** | Git repo operations (simple-git), credentials, identity storage |
| **fs/** | Filesystem routes, raw file access, workspace-scoped search |
| **tts/** | Server-side TTS/STT services + `/api/tts/*` endpoints |
| **scheduled-tasks/** | Recurring-session task persistence + event fanout |
| **skills-catalog/** | Agent skill discovery, install, config; clawdhub remote source |
| **notifications/** | System/push notification prep, templating, truncation |
| **github/** | OAuth device flow, Octokit, PR status |
| **security/** | Request-level origin/host validation |
| **session-folders/** | Session folder/grouping CRUD |
| **client-auth/** | Remote client registration/token for connect-url flow |
| **projects/** | Per-project config + stable project ID |
| **magic-prompts/** | Magic prompt generation |
| **text/** | Shared text summarization helpers |
| **preview/** | Reverse-proxy runtime for user app port preview |
| Loose: `cloudflare-tunnel.js`, `ngrok-tunnel.js`, `package-manager.js`, `path-realpath-cache.js` | Top-level helpers (each has `.test.js`) |

## Where to Look

| Task | Location |
|---|---|
| Add an API endpoint | `server/lib/<domain>/routes.js` → register in `server/lib/opencode/feature-routes-runtime.js` |
| Add a client API wrapper | `src/api/<domain>.ts` |
| Add a CLI command | `bin/cli.js` + `server/lib/opencode/cli-entry-runtime.js` |
| OpenCode server startup | `server/lib/opencode/server-startup-runtime.js` + `startup-pipeline-runtime.js` |
| SSE event dispatch | `server/lib/event-stream/runtime.js` |
| Terminal WebSocket | `server/lib/terminal/` + `server/TERMINAL_WS_PROTOCOL.md` |
| Auth for a new route | `server/lib/ui-auth/ui-auth.js` |
| Quota for a new provider | `server/lib/quota/providers/` + `DOCUMENTATION.md` |
