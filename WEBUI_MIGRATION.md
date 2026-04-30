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

| Feature | Priority | Notes |
|---------|----------|-------|
| **Command Approval Flow** | ✅ Done | Approval modal is now wired to the backend. `run_command` pauses in standard mode, `POST /api/approve` resolves the approval, and YOLO mode continues to bypass confirmation. |
| `/compact` (actual implementation) | ✅ Done | `POST /api/compact` now wraps `compactHistory()`, and the slash command replaces the client message list with the compacted history. |
| `/title` (auto-generate session title) | ✅ Done | `POST /api/title` now wraps `generateSessionTitle()`, renames the active session, and the slash command refreshes the sidebar with the new title. |
| `/dump` (export markdown) | 🟡 Medium | Stubbed in web UI. CLI exports full conversation to `.md` file. |
| `/nudge` (inject tool-use reminder) | ✅ Done | The slash command now injects the shared tool-use reminder and immediately continues the normal AI request flow with that nudge as a user message. |
| Auto-compaction during chat | ✅ Done | Auto-compacts at 92% context usage; sends `compact` SSE event to replace client message list. Sub-agents already auto-compact via `autoCompactSubAgentIfNeeded`. |
| Connection test in settings | 🟡 Medium | CLI validates Ollama connection before saving baseUrl. Web UI saves without testing. |
| Multiline input (`"""` block, `\` continuation) | 🟡 Medium | Web input is single-line textarea only. No paste detection or block mode. |
| Interrupt handling (Ctrl+X) | 🟡 Medium | CLI has key interrupt listener + AbortController. Web only has Stop button. |
| Token stats display | 🟢 Low | CLI shows live token usage. Web receives `tokenStats` in `done` event but doesn't display them. |
| Empty response recovery | 🟢 Low | CLI handles empty assistant responses with retry loop. Web does not. |
| Session rename | 🟢 Low | CLI has `renameSession`. Web UI does not expose it. |
| Vision support toggle | 🟢 Low | CLI passes `visionSupported` to stream params. Web UI ignores this. |
| Inline slash command menu (`/`) | 🟢 Low | CLI shows `@inquirer/prompts` select menu on typing `/`. Web has autocomplete dropdown instead. |
| Readline history/completer | 🟢 Low | CLI has 500-line history and tab completion. Web has no history. |

---

## Known Bugs

### 🔴 Critical

**1. Command Approval Flow Wired**
- `ApprovalModal` now receives an `approval_request` SSE event from `/api/chat` when the model requests `run_command`.
- The web UI posts `{ requestId, approved }` to `POST /api/approve` to resolve the paused backend execution.
- Standard mode waits for explicit approval before executing the command; YOLO mode continues to bypass confirmation.

### 🟡 Medium

**2. Auto-Compaction** — Fixed. The `/api/chat` route now checks token usage at the start of each tool-calling loop iteration. When usage reaches 92% (`AUTO_COMPACT_THRESHOLD_PCT`), `compactHistory()` is called, the resulting shorter history replaces `currentMessages`, and a `compact` SSE event is sent to the client so it updates its `state.messages`. A yellow system notice is injected into the conversation. Sub-agents already used `autoCompactSubAgentIfNeeded` and are unaffected.

**3. SSE Parser Loses Multi-Line Data**
- The SSE parser in `page.tsx` only keeps one `data:` line per event (`currentData = line.slice(6).trim()`).
- Standard SSE allows multiple `data:` lines per event, which should be concatenated with `\n`.
- If the API ever sends multi-line JSON, the parser will drop lines.
- **Fix needed**: Accumulate all `data:` lines for a single event and join with `\n` before parsing.

**4. Race Condition: Thinking After Tool Result**
- `tool_result` sets `needsNewAssistantRef.current = true`.
- If the next LLM turn emits `thinking` before `chunk`, a new assistant message is created.
- However, if multiple `thinking` events arrive in rapid succession, or if `thinking` and `chunk` interleave, the logic may create duplicate assistant messages or append thinking to the wrong message.
- **Fix needed**: Use a more robust message tracking system, or have the API send explicit event types (`new_assistant_turn`) to signal when to create a new message.

**5. chatTimeoutMs Ignored**
- The frontend sends `chatTimeoutMs` in the chat request body.
- `/api/chat/route.ts` never passes it to `sendLlmChatStream()`.
- **Fix needed**: Thread `chatTimeoutMs` through to the LLM adapter call.

### 🟢 Low

**6. React Key Warning / Index Keys**
- Messages are mapped with `key={i}` in `page.tsx`.
- React may misidentify DOM nodes when messages are added/removed mid-stream.
- **Fix needed**: Use a stable message ID (timestamp or counter) instead of array index.

**7. Textarea Never Auto-Resizes**
- `ChatInput` uses `rows={1}` with `resize: 'none'`.
- No auto-grow logic, so long messages are cramped in a single line.
- **Fix needed**: Add auto-resize logic (measure scrollHeight and adjust rows).

**8. Missing Error Handling on Config Save**
- Settings modal catches fetch errors silently (`catch {}`).
- Users are never notified if config fails to persist.
- **Fix needed**: Show toast/error message on config save failure.

**9. Session Delete No Confirmation**
- Clicking the `×` button on a session immediately deletes it without confirmation.
- **Fix needed**: Add a confirmation dialog.

**10. Config File Path Ambiguity**
- `config.json` is read from `process.cwd()`.
- In a Next.js production build (`next start`), the cwd may not be the project root, causing config loss.
- **Fix needed**: Resolve config path relative to `__dirname` or use an environment variable.

**11. Models Not Auto-Refreshed in Settings**
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

| File | Purpose |
|------|---------|
| `app/page.tsx` | Main chat page — SSE handler, slash commands, session management |
| `app/layout.tsx` | Root layout with `ChatProvider` |
| `app/globals.css` | Dark theme CSS variables |
| `app/lib/chatStore.ts` | React Context + reducer for all chat state |
| `components/ChatInput.tsx` | Textarea input with slash autocomplete |
| `components/ChatMessageBubble.tsx` | Render user/assistant/tool/system messages |
| `components/SessionSidebar.tsx` | Session list, new chat, delete, settings button |
| `components/SettingsModal.tsx` | Full settings editor |
| `components/ApprovalModal.tsx` | Command approval dialog (**UI only, not wired**) |
| `components/StatusBar.tsx` | Footer showing streaming/model/message count |
| `app/api/chat/route.ts` | SSE streaming chat API with full agent loop |
| `app/api/approve/route.ts` | Approval endpoint for paused `run_command` requests |
| `app/lib/approvalRegistry.ts` | Server-side approval promise registry for command approval requests |
| `app/api/compact/route.ts` | Manual compaction endpoint used by the `/compact` slash command |
| `app/api/title/route.ts` | Session-title generation endpoint used by the `/title` slash command |
| `app/api/config/route.ts` | Config read/write |
| `app/api/models/route.ts` | Ollama model listing |
| `app/api/sessions/route.ts` | Session list/create |
| `app/api/sessions/[id]/route.ts` | Session get/delete |

### Modified Files

| File | Change |
|------|--------|
| `package.json` | Added Next.js/React deps; updated scripts (`dev`, `build`, `start`, `start:cli`) |
| `tsconfig.json` | Added `"jsx": "preserve"`, `"plugins": [{"name": "next"}]`, `"allowJs": true`, `"paths": {"@/*": ["./*"]}`, `"moduleResolution": "bundler"` |
| `next.config.mjs` | Next.js config with webpack `copy-webpack-plugin` for tiktoken WASM |
| `.gitignore` | Added `.next/` and `next-env.d.ts` |
| `tools/toolRegistry.ts` | Fixed dynamic import (`./impl/subAgentTool` instead of `./impl/subAgentTool.js`) |
| `tools/toolOutput.ts` | Added `setActiveOutputSink()` / `getActiveOutputSink()` for swappable output |
| `tools/impl/runCommandTool.ts` | Added `setCommandConfirmationPrompt()` for swappable approval |
| `aiResponseRenderer.ts` | Added `setAIResponseRenderer()` / `setThinkingSummaryRenderer()` |
| `statusLine.ts` | Added `setStatusLineBackend()` for swappable status |

### Deleted Files

| File | Reason |
|------|--------|
| `index.ts` | CLI entry point no longer needed |

---

## Continuation Notes / Scratchpad

### Top Priority Fixes

1. **Wire up Approval Modal** (CRITICAL)
   - The `ApprovalModal` component exists in `components/ApprovalModal.tsx`.
   - It receives `command`, `onApprove`, `onReject` props.
   - Currently, `onApprove` and `onReject` just call `dispatch({ type: 'SHOW_APPROVAL', command: null })`.
   - The `/api/chat` route never pauses for approval — it just runs tools.
   - **Approach**: Redesign the chat API so that when a tool needs approval, it:
     - Sends a `needs_approval` event to the client
     - Pauses the loop (does not close the SSE stream)
     - Waits for a client message (maybe via a separate POST to `/api/tools/approve`)
     - Resumes the loop with the approval result
   - Alternative: Use WebSockets instead of SSE for bidirectional communication.

2. **Implement `/dump`** (MEDIUM)
   - The `writeConversationHistoryDump()` function exists in `services/historyDump.ts`.
   - Create a `POST /api/dump` endpoint.
   - Return `{ filePath }` or trigger a file download.

### Architecture Improvements

- **Consider WebSockets for Chat**: SSE is one-way. For approval flows, WebSockets would allow the server to pause and wait for client input without complex HTTP request/response choreography.
- **Async SQLite**: `better-sqlite3` is synchronous. For a web server, consider migrating to `sqlite3` (async) or using a worker thread.
- **Config Path Resolution**: Use `path.resolve(__dirname, '../../config.json')` in API routes instead of `process.cwd()`.
- **Token Stats UI**: The `done` event sends `tokenStats`. Display these in the status bar or a tooltip.
- **Auto-Resize Textarea**: Add CSS `field-sizing: content` (modern browsers) or JavaScript measurement for auto-growing textarea.
- **Message IDs**: Replace `key={i}` with stable IDs to prevent React reconciliation issues during streaming.

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
10. [ ] `/clear`, `/model`, `/help` slash commands work
11. [ ] `/dump` shows "not implemented" (until fixed)
12. [ ] Approval modal appears in Standard mode (but doesn't block execution yet)
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

2026-04-30
