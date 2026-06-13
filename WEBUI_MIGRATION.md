# Locopilot Web UI Migration

**Objective:** Convert the terminal-based Locopilot CLI app into a Next.js web UI that runs locally via `npm run dev` / `npm start`.

**Branch:** `feat/web-ui` (created from `master`)

**Date:** 2026-04-30

---

## Quick Start

```bash
npm run dev     # Development server on localhost:3000
npm run build   # Production build
npm start       # Production server
```

---

## Implemented Features

### Chat Interface ✅ Working

- SSE streaming with real-time token/chunk delivery
- Stop streaming button (AbortController)
- Auto-scroll to bottom on new messages
- Error banner with dismiss button
- Empty state welcome screen

### Message Rendering ✅ Working

- User messages (right-aligned, accent color)
- Assistant messages with collapsible thinking/reasoning section
- Tool call / tool result messages (monospace, max-height scrollable with scrollbar)
- System messages (centered, muted styling)

### Chat Input ✅ Working

- Textarea with Enter-to-send, Shift+Enter for newlines
- Slash command autocomplete with Tab/Enter/Arrow keys
- Disabled while streaming

### Session Management ✅ Working

- Sidebar with session list, click to switch
- "+ New chat" button
- Delete session button (⚠️ no confirmation)
- Session persistence in SQLite via shared `history.ts`

### Settings Modal ✅ Working

- Model selection dropdown (populated from Ollama)
- Ollama base URL
- Context size (numCtx)
- Execution Mode toggle (Standard / YOLO)
- Thinking toggle (Enabled / Disabled)
- Chat timeout (ms)
- Compaction model selection
- Web search config: max queries, results per query, page char limit

### Tool Calling ✅ Working (Backend)

- Full agent loop in `/api/chat` (LLM → tool calls → execute → loop back)
- Tool call and tool result events streamed to UI
- Max 20 tool loop iterations safety limit
- Config (yolo, web search settings) loaded from `config.json` and applied per-request

### State Management ✅ Working

- React Context + `useReducer` in `chatStore.ts`
- Ref-based stale-closure avoidance for streaming callback

### API Routes ✅ Working

- `POST /api/chat` — SSE streaming with full tool loop
- `POST /api/title` — Generate and persist a session title for the active session
- `GET /api/config` — Read `config.json`
- `PUT /api/config` — Write `config.json` (deep merge for webSearch)
- `GET /api/models` — Ollama model listing
- `GET /api/sessions` — List sessions
- `POST /api/sessions` — Create session
- `GET /api/sessions/[id]` — Load session messages
- `DELETE /api/sessions/[id]` — Delete session

---

## Missing Features (from CLI)

| Feature                                         | Priority  | Notes                                                                                                                                                                         |
| ----------------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Command Approval Flow**                       | ✅ Done   | Approval modal is now wired to the backend. `run_command` pauses in standard mode, `POST /api/approve` resolves the approval, and YOLO mode continues to bypass confirmation. |
| `/compact` (actual implementation)              | ✅ Done   | `POST /api/compact` now wraps `compactHistory()`, and the slash command replaces the client message list with the compacted history.                                          |
| `/title` (auto-generate session title)          | ✅ Done   | `POST /api/title` now wraps `generateSessionTitle()`, renames the active session, and the slash command refreshes the sidebar with the new title.                             |
| `/dump` (export markdown)                       | 🟡 Medium | Stubbed in web UI. CLI exports full conversation to `.md` file.                                                                                                               |
| `/nudge` (inject tool-use reminder)             | ✅ Done   | The slash command now injects the shared tool-use reminder and immediately continues the normal AI request flow with that nudge as a user message.                            |
| Auto-compaction during chat                     | ✅ Done   | Auto-compacts at 92% context usage; sends `compact` SSE event to replace client message list. Sub-agents already auto-compact via `autoCompactSubAgentIfNeeded`.              |
| Connection test in settings                     | 🟡 Medium | CLI validates Ollama connection before saving baseUrl. Web UI saves without testing.                                                                                          |
| Multiline input (`"""` block, `\` continuation) | 🟡 Medium | Web input is single-line textarea only. No paste detection or block mode.                                                                                                     |
| Interrupt handling (Ctrl+X)                     | 🟡 Medium | CLI has key interrupt listener + AbortController. Web only has Stop button.                                                                                                   |
| Token stats display                             | 🟢 Low    | CLI shows live token usage. Web receives `tokenStats` in `done` event but doesn't display them.                                                                               |
| Empty response recovery                         | ✅ Done   | The web chat route now retries up to 3 times when a turn ends with no meaningful assistant content after stripping leaked control tokens/channel markers.                     |
| Session rename                                  | 🟢 Low    | CLI has `renameSession`. Web UI does not expose it.                                                                                                                           |
| Vision support toggle                           | 🟢 Low    | CLI passes `visionSupported` to stream params. Web UI ignores this.                                                                                                           |
| Inline slash command menu (`/`)                 | 🟢 Low    | CLI shows `@inquirer/prompts` select menu on typing `/`. Web has autocomplete dropdown instead.                                                                               |
| Readline history/completer                      | 🟢 Low    | CLI has 500-line history and tab completion. Web has no history.                                                                                                              |

---

## Fixed Bugs

### ✅ Fixed

**1. Command Approval Flow Wired**

- `ApprovalModal` now receives an `approval_request` SSE event from `/api/chat` when the model requests `run_command`.
- The web UI posts `{ requestId, approved }` to `POST /api/approve` to resolve the paused backend execution.
- Standard mode waits for explicit approval before executing the command; YOLO mode continues to bypass confirmation.

**2. Auto-Compaction**

- The `/api/chat` route now checks token usage at the start of each tool-calling loop iteration. When usage reaches 92% (`AUTO_COMPACT_THRESHOLD_PCT`), `compactHistory()` is called, the resulting shorter history replaces `currentMessages`, and a `compact` SSE event is sent to the client so it updates its `state.messages`. A yellow system notice is injected into the conversation. Sub-agents already used `autoCompactSubAgentIfNeeded` and are unaffected.

**3. SSE Parser Handles Multi-Line Data**

- The client-side parser in `app/hooks/useChatStream.ts` now accumulates all `data:` lines for a single SSE event and joins them with `\n` before parsing.
- The parser also flushes any buffered event when the stream ends, so a valid trailing event is not dropped just because the transport ended without another blank separator.

**4. Empty Final-Answer Recovery**

- The web chat route now strips leaked control tokens such as `<|channel|>` from streamed assistant text before rendering it in the browser.
- If a turn still ends without meaningful assistant content and there are no tool calls, the route automatically nudges the model to answer directly and retries up to 3 times instead of silently ending on reasoning-only output.

**5. Assistant Turn Boundary After Tool Results**

- The web client no longer relies on a `needsNewAssistantRef` flag to decide when to start the next assistant message after tool output.
- Assistant `thinking` and `chunk` events now flow through a reducer action that creates an assistant message on demand when the last message is not already assistant, so post-tool reasoning/content always attaches to the correct turn.

**6. React Key Warning / Index Keys Fixed**

- Messages are now assigned stable IDs instead of using array indices for `key` in `page.tsx`.
- This prevents React from misidentifying DOM nodes when messages are added or removed mid-stream.

**7. Textarea Auto-Resize Added**

- The chat input now grows with its content instead of staying fixed to a single row.
- Long prompts remain readable while still capping the textarea height so the layout stays usable.

**8. Config Save Errors Surface in the UI**

- Settings save now checks the `/api/config` response and shows an inline error banner if persistence fails.
- The modal stays open on failure so the user can retry without losing their edits.

**9. Subagent Live Output in Web UI**

- `run_subagents` tool calls now stream their output to the browser via a new `subagent_output` SSE event.
- Each distinct sub-agent gets its own collapsible bubble (collapsed state is toggled with a ▶/▼ button); the bubble expands by default so output is visible while the agent runs.
- The log auto-scrolls to the latest line as messages arrive.
- The `[sub-agent: id]` prefix emitted by `makeLabeledSink` is stripped and used to route output to the correct bubble; unrecognised lines fall back to a `__subagent__` bucket.

## Known Bugs

### 🔴 Critical

### 🟡 Medium

**3. chatTimeoutMs Ignored**

- The frontend sends `chatTimeoutMs` in the chat request body.
- `/api/chat/route.ts` never passes it to `sendLlmChatStream()`.
- **Fix needed**: Thread `chatTimeoutMs` through to the LLM adapter call.

### 🟢 Low

**4. Session Delete No Confirmation**

- Clicking the `×` button on a session immediately deletes it without confirmation.
- **Fix needed**: Add a confirmation dialog.

**5. Config File Path Ambiguity**

- `config.json` is read from `process.cwd()`.
- In a Next.js production build (`next start`), the cwd may not be the project root, causing config loss.
- **Fix needed**: Resolve config path relative to `__dirname` or use an environment variable.

**6. Models Not Auto-Refreshed in Settings**

- Settings modal shows whatever models were loaded on mount.
- If Ollama gains/loses models, the dropdown is stale until page reload.
- **Fix needed**: Add a "Refresh" button or auto-refresh when opening settings.

---

## Architecture

### Framework

- Next.js 14 (App Router, not Pages Router)
- React 18
- TypeScript (strict mode, `verbatimModuleSyntax`, `exactOptionalPropertyTypes`)

### State Management

- **Single global store**: React Context (`ChatContext`) + `useReducer`
- **Not using**: Zustand, Redux, Jotai
- **Stale closure fix**: Refs (`messagesRef`, `modelRef`, `numCtxRef`, etc.) synced via `useEffect`

### Styling

- Inline styles throughout (no Tailwind, no CSS-in-JS library)
- CSS variables defined in `app/globals.css` for theming

### Streaming

- **Server**: `ReadableStream` with `TextEncoder` in `/api/chat/route.ts`
- **Client**: `fetch()` + `response.body.getReader()` + `TextDecoder`
- **Event format**: Custom SSE-like protocol (`event: name\ndata: json\n\n`)

### Shared Backend

- Web UI reuses the same core modules as the CLI:
  - `history.ts` — SQLite session persistence
  - `tools/` — All tool implementations (run_command, read_file, web_search, etc.)
  - `services/llm.ts` — LLM adapter layer
  - `services/configManager.ts` — Config file read/write
- CLI entry point (`index.ts`) was removed; `start:cli` script may fail if called

### Database

- SQLite via `better-sqlite3`
- **Synchronous API** used inside async Next.js route handlers
- **Warning**: Under high concurrency, this blocks the server thread

### Security

- **No auth** — intended for local single-user use
- **No rate limiting**
- **No CORS configuration**
- User messages sent straight to LLM without escaping (XSS-safe because React escapes text content)

---

## File Map

### New Web UI Files

| File                               | Purpose                                                              |
| ---------------------------------- | -------------------------------------------------------------------- |
| `app/page.tsx`                     | Main chat page — SSE handler, slash commands, session management     |
| `app/layout.tsx`                   | Root layout with `ChatProvider`                                      |
| `app/globals.css`                  | Dark theme CSS variables                                             |
| `app/lib/chatStore.ts`             | React Context + reducer for all chat state                           |
| `components/ChatInput.tsx`         | Textarea input with slash autocomplete                               |
| `components/ChatMessageBubble.tsx` | Render user/assistant/tool/system messages                           |
| `components/SessionSidebar.tsx`    | Session list, new chat, delete, settings button                      |
| `components/SettingsModal.tsx`     | Full settings editor                                                 |
| `components/ApprovalModal.tsx`     | Command approval dialog for standard-mode `run_command` requests     |
| `components/StatusBar.tsx`         | Footer showing streaming/model/message count                         |
| `app/api/chat/route.ts`            | SSE streaming chat API with full agent loop                          |
| `app/api/approve/route.ts`         | Approval endpoint for paused `run_command` requests                  |
| `app/lib/approvalRegistry.ts`      | Server-side approval promise registry for command approval requests  |
| `app/api/compact/route.ts`         | Manual compaction endpoint used by the `/compact` slash command      |
| `app/api/title/route.ts`           | Session-title generation endpoint used by the `/title` slash command |
| `app/api/config/route.ts`          | Config read/write                                                    |
| `app/api/models/route.ts`          | Ollama model listing                                                 |
| `app/api/sessions/route.ts`        | Session list/create                                                  |
| `app/api/sessions/[id]/route.ts`   | Session get/delete                                                   |

### Modified Files

| File                           | Change                                                                                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `package.json`                 | Added Next.js/React deps; updated scripts (`dev`, `build`, `start`, `start:cli`)                                                            |
| `tsconfig.json`                | Added `"jsx": "preserve"`, `"plugins": [{"name": "next"}]`, `"allowJs": true`, `"paths": {"@/*": ["./*"]}`, `"moduleResolution": "bundler"` |
| `next.config.mjs`              | Next.js config with webpack `copy-webpack-plugin` for tiktoken WASM                                                                         |
| `.gitignore`                   | Added `.next/` and `next-env.d.ts`                                                                                                          |
| `tools/toolRegistry.ts`        | Fixed dynamic import (`./impl/subAgentTool` instead of `./impl/subAgentTool.js`)                                                            |
| `tools/toolOutput.ts`          | Added `setActiveOutputSink()` / `getActiveOutputSink()` for swappable output                                                                |
| `tools/impl/runCommandTool.ts` | Added `setCommandConfirmationPrompt()` for swappable approval                                                                               |
| `aiResponseRenderer.ts`        | Added `setAIResponseRenderer()` / `setThinkingSummaryRenderer()`                                                                            |
| `statusLine.ts`                | Added `setStatusLineBackend()` for swappable status                                                                                         |

### Deleted Files

| File       | Reason                           |
| ---------- | -------------------------------- |
| `index.ts` | CLI entry point no longer needed |

---

## Continuation Notes / Scratchpad

### Top Priority Fixes

1. **Implement `/dump`** (completed)

- Added `POST /api/dump` to rebuild the existing markdown export for the web UI.
- The slash command now triggers a browser download of the generated `.md` file.

### Architecture Improvements

- **Consider WebSockets for Chat**: SSE is one-way. For approval flows, WebSockets would allow the server to pause and wait for client input without complex HTTP request/response choreography.
- **Async SQLite**: `better-sqlite3` is synchronous. For a web server, consider migrating to `sqlite3` (async) or using a worker thread.
- **Config Path Resolution**: Use `path.resolve(__dirname, '../../config.json')` in API routes instead of `process.cwd()`.
- **Token Stats UI**: The `done` event sends `tokenStats`. Display these in the status bar or a tooltip.
- **Auto-Resize Textarea**: Implemented in `components/ChatInput.tsx` with measured height growth and a max-height cap.
- **Message IDs**: Fixed with stable client-side IDs in `app/lib/chatStore.ts`; `page.tsx` now keys messages by `msg.id`.

### Testing Checklist for Next Session

When resuming work, verify these in order:

1. [ ] `npm run dev` starts without errors
2. [ ] Can select a model in settings
3. [ ] Can send a message and receive a streaming response
4. [ ] Tool calls display correctly (tool call + tool result)
5. [ ] Final LLM response appears AFTER tool results
6. [ ] Settings (web search results per query, max queries) are respected
7. [ ] New chat starts clean (no stale messages)
8. [ ] Session switch loads correct messages
9. [ ] Session delete removes from sidebar
10. [x] `/dump` downloads a markdown file in the browser
11. [ ] `/clear`, `/model`, `/help` slash commands work
12. [ ] Approval modal appears in Standard mode and blocks execution until approved or rejected
13. [ ] YOLO mode toggle works
14. [ ] Thinking toggle works
15. [ ] `npx tsc --noEmit` passes with zero errors

---

## Configuration Reference

The `config.json` format (auto-generated):

```json
{
  "baseUrl": "http://localhost:11434",
  "lastModel": "llama3.2",
  "compactionModel": "llama3.2",
  "numCtx": 4096,
  "chatTimeoutMs": 720000,
  "yolo": false,
  "thinkingEnabled": true,
  "webSearch": {
    "maxQueries": 3,
    "resultsPerQuery": 5,
    "perPageCharLimit": 5000
  }
}
```

---

## Last Updated

2026-05-01

---

## Known Regressions & Bugs (Last 10 Commits)

Identified 2026-05-02 via automated audit of commits `3257eda..7a495d2`.

### Critical (🔴 — functional bug, incorrect behavior)

| #   | Commit    | File                          | Issue                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | --------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | `0597a40` | `app/hooks/useChatStream.ts`  | **Non-ok HTTP response with valid JSON lacking `message`/`error` falls through to success-path code.** If the server returns HTTP 500 with body `{"status":"error_code_42"}`, the try/catch blocks all exit without throwing. Execution continues past the `!response.ok` guard, and the body stream is already consumed — producing a misleading `"No response body stream"` error instead of the actual HTTP error. |
| B2  | `7262c46` | `app/hooks/useChatStream.ts`  | **Stale token stats when compact SSE lacks `stats.newTokenCount`.** If the server sends a `compact` event without `stats.newTokenCount`, token stats are neither updated nor cleared — pre-compaction values remain displayed.                                                                                                                                                                                        |
| B3  | `7680831` | `app/hooks/useDataLoaders.ts` | **Stale model context limit applied after session-switch race.** `loadModelContextLimit` fetches model info asynchronously after the stale-response guard. Rapid session switching can dispatch the wrong model's context limit.                                                                                                                                                                                      |

### Medium (🟡 — incorrect behavior in specific scenarios)

| #   | Commit    | File                         | Issue                                                                                                                                                                                                                                             |
| --- | --------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1  | `0597a40` | `app/hooks/useChatStream.ts` | **SSE regex with lazy `.+?` breaks on nested JSON error payloads.** `data:\s*({.+?})\s*$` matches only up to the first `}` — nested objects like `{"error":{"message":"...","code":123}}` produce truncated JSON, losing structured error detail. |
| M2  | `1ff8f21` | `services/compact.ts`        | **Tool messages excluded from title-generation prompt.** New code filters to only `user`/`assistant` messages (old code included all roles). Tool-heavy conversations may get vaguer titles.                                                      |

### Low (🔸 — defensive gap, dead code, or minor inconsistency)

| #   | Commit    | File                                               | Issue                                                                                                                                                                                                                                              |
| --- | --------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1  | `7a495d2` | `services/chatSession.ts`, `app/api/chat/route.ts` | **`visionSupported` param never passed to `createSystemPrompt()`.** The plumbing is dead code — `fetch_image` is always included regardless of model capabilities.                                                                                 |
| L2  | `7a495d2` | `app/api/title/route.ts`                           | **Guard inconsistency after system-message stripping.** Route checks message count on raw array (with system message), then inner function re-checks on stripped array. A client sending `[sys, user]` passes the outer guard but fails the inner. |
| L3  | `7262c46` | `app/hooks/useSlashCommands.ts`                    | **No fallback for `refs.numCtxRef.current` in `tokenLimit`.** Other paths use `data.tokenLimit ?? refs.numCtxRef.current ?? state.numCtx`; this path has zero fallbacks.                                                                           |
| L4  | `7262c46` | `app/api/compact/route.ts`                         | **Semantic type mismatch** — `CompactStats.newTokenCount` mapped to `SessionTokenStats.promptEvalCount`. Works numerically but semantically incorrect for future readers.                                                                          |
| L5  | `7680831` | `app/lib/chatStore.ts`                             | **`...restConfig` can overwrite computed `requestedNumCtx`** if a future caller passes `requestedNumCtx` in the config action payload.                                                                                                             |
| L6  | `8d2718b` | `components/ApprovalModal.tsx`                     | **Redundant `import '@/app/styles.css'`** — `layout.tsx` already imports it globally. Harmless but inconsistent with other components.                                                                                                             |
| L7  | `8d2718b` | `components/ChatMessageBubble.tsx`                 | **Missing `cursor: default` fallback** on `bubble-ai-msg` when condition is false. No visual impact but a semantic deviation from the original inline style.                                                                                       |
| L8  | `59d9d1d` | `app/api/chat/route.ts`                            | **Missing `.catch()` fallback** on `getLlmApiErrorMessage()` that other routes (`compact`, `title`) include. Could produce unhandled rejection with a future adapter.                                                                              |

### No issues found in these commits

| Commit    | Description                                          |
| --------- | ---------------------------------------------------- |
| `e9558cc` | eventsource-parser integration                       |
| `7921176` | Clear token stats on new messages                    |
| `3257eda` | Remove console logs, use `state.numCtx` in StatusBar |

### Priority fixes

| Priority | Bug    | Fix                                                                                              |
| -------- | ------ | ------------------------------------------------------------------------------------------------ |
| **P1**   | **B1** | Add `throw new Error(...)` after the JSON try/catch in the `!response.ok` guard as a fallback    |
| **P2**   | **B2** | Add `if (typeof data.stats?.newTokenCount !== 'number') dispatch({ type: 'CLEAR_TOKEN_STATS' })` |
| **P3**   | **B3** | Guard `loadModelContextLimit` behind the stale-response check                                    |
| **P4**   | **M1** | Use balanced-braces regex or full-body JSON parse before the regex approach                      |

---

## Last Updated

2026-05-02
