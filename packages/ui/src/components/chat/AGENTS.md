# packages/ui/src/components/chat — Chat UI

Main chat surface: composer, message list, permissions, model controls, autocompletes, and status.

## Component Map

| File | Lines | Role |
|---|---|---|
| `ChatContainer.tsx` | — | Orchestrator: mounts list + input + overlays |
| `MessageList.tsx` | — | Virtualized message list — **perf-critical render boundary** |
| `ChatMessage.tsx` | — | Single message row (custom `React.memo` comparator) |
| `ChatInput.tsx` | 4514 | Composer + 5 autocompletes — **largest file, surgical edits only** |
| `ChatEmptyState.tsx` | — | Empty / draft starter state |
| `ChatErrorBoundary.tsx` | — | Error boundary |

## Autocompletes in ChatInput

5 autocomplete components, each with its own trigger:

| Component | Trigger |
|---|---|
| `FileMentionAutocomplete.tsx` | `@` file |
| `AgentAutocomplete.tsx` | `@` agent |
| `CommandAutocomplete.tsx` | `/` slash commands |
| `SkillAutocomplete.tsx` | skill trigger |
| `SnippetAutocomplete.tsx` | snippet trigger |

## Subdirectories

- `message/` — `MessageBody`, `MessageHeader`, tool renderers, type definitions
- `message/parts/` — Per-part renderers: `AssistantTextPart`, `UserTextPart`, `ToolPart`, `ReasoningPart`. **Read `message/parts/DOCUMENTATION.md` before editing.**
- `components/` — Shared chat sub-components
- `hooks/` — Chat-local hooks
- `lib/` — Chat-local utilities (includes `composerHighlight.ts`)
- `__tests__/` — Chat tests

## Performance Rules

- `MessageList` is a **virtualized perf boundary** — do NOT add arbitrary React context reads or subscriptions to it
- `ChatMessage` has a **custom `React.memo` comparator** — compare render-relevant fields (role, finish, parts count, part IDs), NOT object references
- `message.part.delta` fires ~60/sec — any `findIndex`/`filter` added to part handlers multiplies across every event; gate behind cheap check first
- Do NOT let text input state repaint unrelated chrome (model picker, toolbar) on every keystroke — those are behind memoized boundaries with stable callbacks

## Mobile-specific rules

- `MobileAgentButton.tsx`: use **pointer events** (not onClick) to keep soft keyboard open
- Do NOT pre-request microphone permission on mount (see `BrowserVoiceButton.tsx`)

## Permission/Question UI

| Component | Purpose |
|---|---|
| `PermissionCard.tsx` / `PermissionRequest.tsx` | Permission prompt inline in chat |
| `PermissionToastActions.tsx` | Permission actions in toast |
| `QuestionCard.tsx` | Pending question prompt |

## Where to Look

| Task | Location |
|---|---|
| Composer input behavior | `ChatInput.tsx` (read before large edits) |
| Message rendering | `message/parts/*.tsx` (read `DOCUMENTATION.md` first) |
| Markdown rendering | `MarkdownRenderer.tsx` + `MarkdownRendererImpl.tsx` |
| Diff / streaming diff | `DiffPreview.tsx` / `StreamingTextDiff.tsx` |
| Status row | `StatusRow.tsx` + `StatusRowContainer.tsx` |
| Queued messages chip | `QueuedMessageChips.tsx` |
| Model/agent selection | `ModelControls.tsx` (2870 lines — surgical edits) |
