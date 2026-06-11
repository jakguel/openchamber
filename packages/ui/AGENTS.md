# packages/ui — Shared UI Package

All runtime surfaces (web, desktop, VS Code) mount this package's React tree.

## Structure

```
src/
├── apps/          # Runtime entry points (mobile, VS Code, Electron mini-chat)
├── components/    # React UI (chat/, views/, sections/, session/, ui/, terminal/, …)
├── stores/        # 42 Zustand stores (app-level state, NOT session live state)
├── sync/          # Session sync layer (SSE pipeline, per-directory child stores)
├── hooks/         # ~47 hooks (runtime APIs, gestures, platform, voice/TTS)
├── lib/           # Theme tokens, i18n, OpenCode client, quota, router, voice
└── types/         # Shared TS types
```

## Runtime Entry Points (apps/)

Three `render*` functions, each exported with `initializeSharedPreferences`:

| Entry | File | Surface |
|---|---|---|
| `renderMobileApp` | `apps/renderMobileApp.tsx` | Mobile PWA |
| `renderVSCodeApp` | `apps/renderVSCodeApp.tsx` | VS Code webview |
| `renderElectronMiniChatApp` | `apps/renderElectronMiniChatApp.tsx` | Electron mini-chat |

The main web app root is NOT in `apps/` — it's bootstrapped by `packages/web/src/main.tsx`.

## State Architecture

### App-Level Stores (stores/)

**Read before editing: `stores/DOCUMENTATION.md`** — authoritative ownership map and perf rules.

Store categories:
- **Feature cache** (perf-sensitive): `useGitStore` (per-dir Git, use `ensureStatus()`), `useGitHubPrStatusStore` (PR cache, `startWatching/stopWatching`)
- **UI state**: `useUIStore`, `useDirectoryStore`, `useFeatureFlagsStore`, `useConfigStore`
- **Session coordination**: `useGlobalSessionsStore`, `useSessionFoldersStore`, `useSessionPinnedStore`, `useSessionDisplayStore`, `useSessionMultiSelectStore`
- **Feature stores**: agents, commands, MCP, plugins, skills, terminal, quota, git-identities, snippets, etc.

Performance contract: use **leaf selectors** — `useGitStatus(dir)` not `useGitStore(s => s.directories)`. Never subscribe shell/layout components to broad live collections.

### Sync Layer (sync/)

**Read before editing: `sync/DOCUMENTATION.md`** — two session scopes, event→field cloning map.

Two distinct data scopes:
- **Directory-scoped** (created lazily per dir in `sync-context.tsx`): owns live session/message/part/permission/question state; fed via `event-pipeline.ts` → `event-reducer.ts` → `child-store.ts`
- **Global** (`stores/useGlobalSessionsStore`): sidebar + retention; updated by `sync/session-actions.ts`

Critical file map:
| File | Role |
|---|---|
| `sync-context.tsx` | `SyncProvider` root, per-directory child store creation |
| `event-pipeline.ts` | SSE/WS connection + reconnect loop |
| `event-reducer.ts` | Pure reducer, event → state mutation |
| `session-actions.ts` | Canonical SDK session mutations (create/delete/archive) |
| `session-ui-store.ts` | Selection, draft, abort, worktree actions |
| `input-store.ts` | Draft text + attachments |
| `streaming.ts` | Streaming hot path (~60 events/sec) |
| `optimistic.ts` | Shadow-Map optimistic update + rollback |
| `bootstrap.ts` | Startup resync (throws on failure — do NOT swallow) |
| `content-cache.ts` | Dual LRU (count+byte limit) |

Event cloning rule: only clone fields the event mutates. `message.part.delta` fires ~60/sec — cloning entire session state caused 10× render overhead in production.

## Component Sub-packages with their own docs

- `components/chat/` — see `components/chat/AGENTS.md`
- `components/chat/message/parts/` — see `DOCUMENTATION.md` in that dir
- `components/session/sidebar/` — see `DOCUMENTATION.md` in that dir

## Where to Look

| Task | Location |
|---|---|
| Add/edit store | `stores/use*.ts` matching the domain, read `stores/DOCUMENTATION.md` first |
| Session SSE events | `sync/event-reducer.ts` |
| Submit / send flow | `sync/submit.ts` → `sync/session-actions.ts` |
| Reconnect + resync | `sync/reconnect-recovery.ts` + `sync/bootstrap.ts` |
| Chat UI | `components/chat/` + `components/chat/AGENTS.md` |
| Typing a new hook | `hooks/use*.ts` matching concern; check if it already exists |
| Theme/color tokens | `lib/theme/` — `cssGenerator.ts`, `themes/` JSON files |
| i18n text | `lib/i18n/messages/*.ts` |
| Runtime APIs (data access) | `hooks/useRuntimeAPIs.ts` + `lib/api/types.ts` |
