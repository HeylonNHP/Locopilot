<!-- Use this file to provide workspace-specific custom instructions to Copilot. For more details, visit https://code.visualstudio.com/docs/copilot/copilot-customization#_use-a-githubcopilotinstructionsmd-file -->
- [x] Verify that the copilot-instructions.md file in the .github directory is created.
- [x] Clarify Project Requirements
- [x] Scaffold the Project
- [x] Customize the Project
- [x] Install Required Extensions
- [x] Compile the Project
- [ ] Create and Run Task
- [ ] Launch the Project
- [x] Ensure Documentation is Complete

## Project Summary
A CLI tool for chatting with Ollama. It handles configuration for host/port, model selection, and basic chat loops.

## Technical Stack
- Node.js (ESM)
- Inquirer for CLI interactions
- Axios for Ollama API communication
- Chalk for terminal styling

## Coding Guidelines

Apply appropriate design patterns and good programming practices to all code changes:

### Design Patterns
- **Prefer composition over inheritance** — use composition, delegation, and dependency injection to build flexible, testable components.
- **Apply SOLID principles** — single responsibility, open/closed, Liskov substitution, interface segregation, and dependency inversion.
- **Use established patterns where fit**:
  - Factory functions for complex object creation
  - Registry pattern for extensible feature sets (e.g., slash commands, tool handlers)
  - Adapter pattern for provider abstraction (see `services/adapters/`)
  - Facade pattern for simplified public APIs over complex subsystems
  - Strategy pattern for swappable algorithms (e.g., token counting, HTML extraction)
- **Avoid over-engineering** — use patterns when they genuinely simplify complexity, not to add abstraction layers for their own sake.

### Good Practices
- **Single Responsibility** — each function/module should do one thing well; keep functions small and focused.
- **DRY (Don't Repeat Yourself)** — extract shared logic into reusable helpers; avoid copy-paste code.
- **Explicit over implicit** — prefer clear, descriptive naming and explicit flows over clever shortcuts.
- **Type safety** — use TypeScript strictly; avoid `any` unless absolutely necessary; define proper types for all interfaces.
- **Error handling** — handle errors gracefully with meaningful messages; propagate errors up the call stack appropriately.
- **Modularity** — organize code into focused modules with clear public APIs; follow the existing `services/` and `tools/` directory structure.
- **Separation of concerns** — keep business logic separate from I/O, rendering, and orchestration.
- **Testability** — structure code so dependencies can be injected or mocked for testing.

### Refactoring Guidelines
- When modifying existing code, look for opportunities to improve structure.
- Extract new helpers into dedicated modules (e.g., `services/`, `tools/`) rather than bloating `index.ts`.
- Update this file when patterns or key architectural decisions change.


- Work through each checklist item systematically.
- Keep communication concise and focused.
- Follow development best practices.


<!-- Feature documentation — keep this section up to date as the application evolves -->

## Application overview

Locopilot is a terminal-based chat client for Ollama, providing a lightweight, local-first AI assistant with no cloud dependency. Key design goals:

- **Local & Private**: All inference runs through a local Ollama instance; no data leaves the machine.
- **Persistent State**: Host, port, and model selections are persisted in `config.json`. Conversations are automatically saved to a local SQLite database (`locopilot.db`).
- **Safety First**: Commands requested by the AI require explicit user approval by default.
- **YOLO Mode**: A high-trust mode that skips command confirmation for automated workflows, enabled via startup prompt, `--yolo`/`-y` flag, or `YOLO=true` environment variable.
- **Session Management**: Resume recent chats, switch between multiple active sessions (`/sessions`), or delete old ones (`/delete`).
- **Slash Commands**: Specialized commands for utility tasks:
    - `/model`: Refresh and switch LLM models mid-conversation.
    - `/settings`: Change App and Session settings (replaces initial startup prompts).
    - `/compact`: Force conversation summarization to recover context.
  - `/dump`: Export the current conversation history, including the system prompt and tool call/tool result details, to a markdown debug file.
    - `/sessions`: Switch between multiple persistent chat histories.
    - `/delete`: Remove a session from the local database.
    - `/nudge`: Manually inject a tool-use reminder if the AI is hesitant.
    - `/exit` / `/help`: Application control and documentation.

## Tool-calling / Command-execution

Feature summary:
- **`run_command`**: Request shell commands. Uses a process registry for tracking and `Ctrl+X` for interruption.
- **`run_subagents`**: Run one or more isolated sub-agents sequentially. Each sub-agent gets a fresh ephemeral history, the normal tool set except `run_subagents` itself, and returns only its final answer back to the parent agent.
- **Process Registry**: Long-running commands are tracked by ID, allowing the AI to poll for output using a `check_process_output` tool if a command exceeds the initial 30s timeout.
- **Shell Precision**: On Windows, PowerShell is preferred. Commands are fed via `stdin` (e.g., `powershell -Command -`) to avoid quoting/tokenization issues across different shells. POSIX shell requests on Windows are automatically remapped to PowerShell with a warning.
- **Failure Analysis**: Non-zero exit codes trigger an AI-powered error summary ([errorSummary.ts](errorSummary.ts)) that distills technical `stderr` into a brief fix suggestion, which is then fed back into the history as a user-role nudge.
- **Sub-agent Terminal Output**: Sub-agent tool output is tagged with `[sub-agent: id]` for attribution. Nested `run_command` requests still surface the normal approval prompt in standard mode, preceded by a sub-agent context header so the user knows which worker requested it.
- **Interruption**: `Ctrl+X` interrupts the tool-call loop or kills the running process without exiting the application. `Ctrl+C` remains a global exit signal.

## Markdown rendering

Feature summary:
- **`streamAIResponse`**: Provides real-time "typing" effect chunk-by-chunk. Intentionally skips markdown formatting during streaming for performance and accuracy.
- **`printAIResponse`**: Renders full markdown (tables, code blocks, formatting) using `marked` and `marked-terminal` once the stream is complete or for static messages.
- **Viewport Recovery**: Uses a viewport-aware strategy to replace raw streamed text with formatted markdown if the response fits on screen; otherwise, appends the formatted version after a separator.
- **Normalization**: Automatically fixes accidental global indentation in model responses to prevent formatting breakages (like misidentified code blocks).

## Session & Token Management

Feature summary:
- **SQLite Storage**: Uses `better-sqlite3` in WAL mode for reliable, concurrent message persistence. 
- **Live Token Meter**: Displays a real-time status line ([statusLine.ts](statusLine.ts)) with a 10-frame spinner (`⠋⠙⠹...`), current phase, model, context usage (`used / limit`), and source tag (`estimated` vs `ollama`).
- **Authoritative Stats**: Reconciles estimated local token counts (`tiktoken`) with authoritative metrics from Ollama (`prompt_eval_count`, `eval_count`) at the end of each turn.
- **Token Calculation**: Estimated counts [tokenizer.ts](tokenizer.ts) add 4 tokens per message plus role, content, and tool call overhead to match OpenAI-style counting as a robust local approximation.
- **Conversation Compaction**: The `/compact` command [compact.ts](compact.ts) uses a high-context LLM pass to summarize everything (decisions, code, paths) into the third person, injecting a `[This conversation history has been compacted...]` preamble.
- **Auto-Compact**: When context usage reaches 92%, compaction is triggered automatically at the start of each tool-call loop iteration (covers both between-tool-call growth and end-of-turn growth). A yellow `⚡ Context at N% — auto-compacting...` line is printed. If compaction fails or is a no-op, a warning is shown but the loop continues uninterrupted. If the compacted result still exceeds 90% of the context window (`COMPACT_ACCEPTANCE_HEADROOM`), compaction automatically retries up to twice more with a stronger aggressiveness factor that shrinks preservation budgets and summary targets. The most recent user prompt is always preserved verbatim across all passes. Both the to-summarize window and the verbatim-preserved window have their large tool outputs distilled before the final message list is assembled, preventing massive web-search results from bypassing compaction. If the result is still over the model context limit after all passes, a red warning is printed so the user can intervene.

## Web search & Fetch tools

Feature summary:
- **`web_search`**: Multi-query DuckDuckGo search with automatic derivation of search intent and pagination support.
- **`fetch_url`**: Direct page retrieval for following links or deep-diving into specific documentation.
- **`fetch_image`**: Fetches an image from a URL or local file path and attaches it as base64 to the conversation message. Vision-only; only useful with models that have image understanding (e.g. llava, llama3.2-vision). Supports JPEG, PNG, GIF, WebP, and BMP up to 10 MB. The base64 is stored in the `images` field of the tool result message and is persisted to SQLite alongside other message fields.
- **Smart Extraction**: Uses `@mozilla/readability` and `cheerio` to extract clean text from HTML, ignoring navbars and boilerplate.
- **Configurable limits**: Timeouts and character limits are enforced to keep history manageable.

## LLM maintenance instruction (always keep up to date)

- PURPOSE: Document developer intent, UX constraints, and tool behaviors for contributors and automated agents.

- MANDATE:
  - Update this file whenever code, configuration, or tool behaviors change.
  - Keep entries concise: target file, summary of change, and rationale.
  - When adding tools, document their security profile and confirmation UX.
  - Ensure all new features align with the "Local, Private, Safe" philosophy.

- **Web search tool** (`web_search`):
    - Changed `queries` parameter from `string` to `array` in the tool schema to encourage LLMs to provide multiple explicit queries properly.
    - Updated `parseQueriesInput` in `tools.ts` to handle actual arrays, JSON-encoded arrays, and strings separated by newlines, commas, or semicolons.
    - Updated tool description and system prompt to explicitly encourage using 2-3 queries for complex tasks.
    - Improved automated query derivation in `webSearchTool.ts` to split prompts on "and", "or", commas, and semicolons.
    - This ensures more effective search coverage even with "lazy" model inputs.- [x] **Alternate interrupt key** (default: `Ctrl+X`):
    - Files: `tools.ts`, `index.ts`, `.github/copilot-instructions.md`
    - Summary: Added a `keypress` listener (defaulting to `Ctrl+X`) that interrupts the AI tool-call loop without exiting the application. `Ctrl+C` retains its normal behavior (exits Locopilot) at all times.
    - Intent: Prevent accidental closures of Locopilot when the user only wants to stop a looping or long-running AI task. Because `setRawMode(true)` suppresses the OS SIGINT signal for Ctrl+C, the keypress listener re-raises SIGINT via `process.kill(process.pid, 'SIGINT')` so the top-level exit handler fires normally.
- [x] **Refactored run_command tool** (`runCommandTool.ts`):
    - Files: `runCommandTool.ts` (new), `tools.ts`
    - Summary: Extracted command execution logic, process registry, and shell resolution into `runCommandTool.ts`.
    - Intent: Keep `tools.ts` focused on common tool-calling orchestration and schemas while isolating concrete tool implementations.
- [x] **Preserve message history on error/interrupt**:
    - Files: `index.ts`
    - Summary: Removed the code that rolled back `messages.length` to `historyLengthBeforeTurn` when an AI turn was interrupted or failed due to an Ollama API error.
    - Intent: Ensure that when an error occurs mid-turn (e.g. after several successful tool calls), the previous context and already-executed tool output remain in the history. This allows the user to "try again" with the model seeing exactly where it left off, rather than losing the entire turn's progress.

## Change History

- 2026-04-30: Surfaced web tool progress in the web UI
  - Files: `app/api/chat/route.ts`, `app/lib/chatStore.ts`, `app/page.tsx`, `tools/toolRegistry.ts`, `.github/copilot-instructions.md`
  - Summary: Added a web-only tool output sink for `web_search` and `fetch_url` in the chat SSE route, threaded that sink through the web search/fetch settings so `ContentCompactor` uses it, and appended `tool_progress` events into the active tool bubble on the client.
  - Intent: Show web search pagination and web content compaction progress in the browser instead of printing those messages only to the server terminal.

- 2026-04-30: Added immediate pending-state feedback for web UI `/compact`
  - Files: `app/page.tsx`, `.github/copilot-instructions.md`
  - Summary: The `/compact` slash command now flips the composer into a visible `Compacting conversation...` state as soon as the request starts and blocks duplicate manual compaction requests until the current one finishes.
  - Intent: Prevent the web UI from feeling unresponsive when manual compaction takes a while and stop accidental repeat submissions.

- 2026-04-30: Added web UI `/compact` slash command implementation
  - Files: `app/api/compact/route.ts` (new), `app/page.tsx`, `WEBUI_MIGRATION.md`
  - Summary: Added a dedicated `POST /api/compact` endpoint that resolves the effective base URL, context length, and compaction model, runs `compactHistory()`, persists the compacted history for the active session when one exists, and returns the new messages plus token stats. Wired the web UI `/compact` slash command to call this endpoint, replace the current client message list, and show compaction notices consistent with auto-compaction.
  - Intent: Bring manual history compaction in the web UI to parity with the CLI flow instead of leaving `/compact` as a stub.

- 2026-04-29: Added isolated `run_subagents` tool
  - Files: `tools/impl/subAgentTool.ts` (new), `tools/toolRegistry.ts`, `tools/tools.ts`, `services/chatSession.ts`, `.github/copilot-instructions.md`
  - Summary: Added a new `run_subagents` tool that runs multiple sub-agents sequentially in isolated ephemeral histories, reuses the existing tool registry except for a recursion guard that withholds `run_subagents` from sub-agents, and returns only each sub-agent's final response to the parent agent. Added runtime sub-agent config syncing from the active chat session and labeled nested tool transcripts with `[sub-agent: id]`; nested `run_command` requests still surface approval prompts with a sub-agent context header.
  - Intent: Let the orchestrator offload bounded subtasks to isolated workers without polluting the parent conversation history, while preserving existing safety and approval UX.

- 2026-04-28: Centralized terminal width lookup
  - Files: `terminalWidth.ts`, `statusLine.ts`, `services/markdownRenderer.ts`, `services/splashScreen.ts`, `tools/toolOutput.ts`
  - Summary: Added a shared `getTerminalWidth()` helper and replaced the direct terminal-width reads in the status line, markdown renderer, splash screen, and tool transcript formatter.
  - Intent: Keep width detection consistent across the CLI and make future terminal-layout changes use one source of truth.

- 2026-04-28: Added compact terminal tool transcripts
  - Files: `tools/toolOutput.ts`, `tools/impl/readFileTool.ts`, `tools/impl/writeFileTool.ts`, `tools/impl/patchFileTool.ts`
  - Summary: Added a shared terminal transcript formatter for tool output and switched the file tools to render compact, sectioned blocks. Absolute file paths are shortened only when the rendered line would exceed the current terminal width.
  - Intent: Improve terminal readability while keeping the model-facing tool result strings unchanged and preserving the live spinner/status UX.

- 2026-04-18: Added configurable poll interval for long-running command checks
  - Files: `tools/impl/runCommandTool.ts`, `tools/toolRegistry.ts`, `tools/tools.ts`, `tools/TOOL_GUIDE.md`, `.github/copilot-instructions.md`
  - Summary: Added optional `poll_interval_seconds` to `check_process_output`, wired the dispatcher to honor it, and updated the command tool prompt/schema so the model can intentionally sample long-running command output less often.
  - Intent: Reduce noisy polling for commands that are expected to run for a long time while keeping the command registry contract explicit.

- 2026-04-17: Added user-selectable compaction model
  - Files: `services/modelManager.ts`, `slashCommands.ts`, `index.ts`, `README.md`, `.github/copilot-instructions.md`
  - Summary: Added a persisted `compactionModel` setting and threaded it through `/settings`, startup configuration, `/compact`, and web-content compaction. The new setting defaults to the active chat model until the user explicitly chooses a cheaper model.
  - Intent: Let users keep chat quality high while shifting summarization and web-content reduction to a smaller, less expensive model.

- 2026-04-17: Extracted shared model-list lookup into a service module
  - Files: `services/modelManager.ts` (new), `slashCommands.ts`, `index.ts`, `.github/copilot-instructions.md`
  - Summary: Moved the reusable Ollama model enumeration helper out of `slashCommands.ts` and into `services/modelManager.ts` so startup model selection and the `/model` command share one service-owned implementation.
  - Intent: Keep `slashCommands.ts` focused on command orchestration while centralizing model-fetch and error-handling logic in the services layer.

- 2026-04-16: Added Playwright fallback for JS-heavy page visits
  - Files: `tools/htmlExtractor.ts`, `package.json`, `package-lock.json`
  - Summary: `fetchAndExtract()` now heuristically detects thin SPA-style pages and can re-render them through Playwright/Chromium before title, text, and link extraction. The browser path is lazy and only kicks in when the static scrape looks insufficient.
  - Intent: Improve scraping of JavaScript-heavy pages without changing DuckDuckGo search parsing or the existing fast HTTP path.

- 2026-04-15: Added browser-like headers and optional cookie support for web fetches
  - Files: `tools/webRequestHeaders.ts` (new), `tools/htmlExtractor.ts`, `README.md`, `.github/copilot-instructions.md`
  - Summary: Moved web request header construction into a dedicated helper, switched the shared HTML fetch path to browser-like headers (`Accept`, `Accept-Language`, `Sec-Fetch-*`, referer), and added optional `LOCOPILOT_WEB_COOKIE` support to pass a raw `Cookie` header through the web tools.
  - Intent: Improve compatibility with sites that gate non-browser requests, while keeping the fetch layer modular and easy to extend.

- 2026-04-14: Hardened compaction against massively oversized context windows (three-pronged fix)
  - Files: `services/compact.ts`, `index.ts`, `slashCommands.ts`, `.github/copilot-instructions.md`
  - Summary: Three independent fixes applied together. (1) **Distill preserved messages** — `distillToolMessages` is now also run on `historySplit.preservedRecentMessages` before those messages are assembled into `newMessages`, so large web-search and command-output tool results in the preserved window are compressed identically to those in the summarized window. This was the primary cause of 273 k → 272 k "reduction" when 6 preserved tool messages each held 25 k+ chars. (2) **Bounded multi-pass retry** — the aggressive retry loop was generalized with a `remainingRetries` counter (default 2), replacing the single-shot `aggressiveFactor <= 1.0` guard, so the service can run up to 3 progressively more aggressive passes without possibility of infinite recursion. (3) **Caller-side over-budget warning** — both `autoCompactIfNeeded` and `COMPACT_HANDLER` now print a red warning if `result.stats.newTokenCount > numCtx` after all passes, making the failure visible instead of silently allowing the next turn to receive a 400 from Ollama.
  - Intent: Prevent the scenario where preserved tool-result verbosity dominates the compacted history and neutralizes all summarization effort, while keeping the latest user prompt verbatim and giving the user clear feedback when the context window is genuinely unrecoverable.

- 2026-04-14: Added aggressive compaction retry when first pass still exceeds context window
  - Files: `services/compact.ts`, `.github/copilot-instructions.md`
  - Summary: `compactHistory` now accepts an `aggressiveFactor` parameter (default 1.0) that scales down the preserved-recent-token budget, preserved-message floor, and summary target/max token ranges. After measuring the compacted result, if it still exceeds 90% of `numCtx` and the current factor is the default, the service automatically retries once with a stronger factor derived from the overflow ratio (`max(1.5, newTokenCount / (numCtx * 0.75))`). The retry feeds the already-compacted messages back through the full pipeline with tighter budgets. The latest user prompt remains a hard anchor across both passes; all earlier user prompts are eligible for summarization. Stats reported to the caller reflect the original-to-final token delta.
  - Intent: Fix the failure mode where a single compaction pass reduced tokens but still left the history above the model's context limit, causing repeated no-op compactions and eventual 400 errors from the provider.

- 2026-04-14: Added configurable per-page character limit for web page extraction
  - Files: `constants.ts`, `tools/commandHelpers.ts`, `tools/htmlExtractor.ts`, `tools/toolRegistry.ts`, `index.ts`, `slashCommands.ts`, `README.md`
  - Summary: Promoted the hard-coded 2,500-character extraction cap into persisted `webSearch.perPageCharLimit` config, propagated it through startup and runtime tool settings, and added a `/settings` control that accepts `0` for unlimited page text.
  - Intent: Let users trade off token usage versus retrieval depth without editing source, while keeping the default behavior unchanged.

- 2026-04-14: Added `/dump` conversation history export
  - Files: `services/historyDump.ts` (new), `slashCommands.ts`, `README.md`, `.github/copilot-instructions.md`
  - Summary: Added a slash command that writes the current conversation transcript, system prompt, tool calls, tool results, and attached images to a timestamped markdown file in the working directory.
  - Intent: Make it easy to capture a full debugging snapshot without bloating the main slash command registry.

- 2026-04-14: Emit thought summary immediately when tool calls arrive after thinking
  - Files: `aiResponseRenderer.ts`, `.github/copilot-instructions.md`
  - Summary: In `streamAIResponse`, added a check inside the `chunk.message?.tool_calls` handler that fires `printThinkingSummary` as soon as the first tool-call chunk arrives (when the model was thinking). Previously the summary was only printed after the full stream ended, so the status bar would silently transition from `AI is thinking...` to `AI is requesting tools...` with no persistent record until later. The fix mirrors the existing behaviour for text content (line 243), where the summary is printed the instant thinking ends and output begins.
  - Intent: Ensure users always see `(Thought for Xs · N chars)` the moment thinking transitions to tool-calling, not deferred until the end of the stream.

- 2026-04-14: Added runtime-only model context clamping
  - Files: `index.ts`, `services/adapters/llmAdapter.ts`, `services/adapters/ollamaAdapter.ts`, `services/llm.ts`, `slashCommands.ts`, `README.md`
  - Summary: Added provider model-context lookup and split the saved requested `num_ctx` from the active runtime value. When a selected model reports a smaller context window than the user's setting, Locopilot now clamps the live session context in memory only, warns the user, and keeps `config.json` unchanged until the user explicitly changes the setting.
  - Intent: Respect provider limits without silently overwriting the user's saved context preference.

- 2026-04-12: Introduced provider adapter layer for LLM backends
  - Files: `services/adapters/llmAdapter.ts` (new), `services/adapters/ollamaAdapter.ts`, `services/llm.ts` (new), `index.ts`, `aiResponseRenderer.ts`, `slashCommands.ts`, `services/compact.ts`, `services/errorSummary.ts`, `history.ts`, `tokenizer.ts`, `.github/copilot-instructions.md`
  - Summary: Moved the concrete Ollama implementation to `services/adapters/ollamaAdapter.ts`, added a generic `LlmAdapter` contract in `services/adapters/llmAdapter.ts`, and introduced `services/llm.ts` as the active-adapter facade (`getLlmAdapter`/`setLlmAdapter` plus provider-agnostic API wrappers). Updated all consumers to import generic chat/model/error functions and shared message/tool types from the facade.
  - Intent: Decouple application flow from Ollama-specific modules so additional providers (for example OpenAI-compatible endpoints) can be added as drop-in adapters without rewriting chat/session/tool orchestration.

- 2026-04-12: Fixed lingering final-status line and missing thought summary on tool-only turns
  - Files: `aiResponseRenderer.ts`, `index.ts`, `.github/copilot-instructions.md`
  - Summary: Added a dedicated thought-summary printer in `streamAIResponse` and ensured it also runs when the model produces tool calls without assistant content. Updated final-stats handling in `index.ts` to clear the live status line before logging token usage so `AI response received...` is not left in scrollback.
  - Intent: Preserve clear terminal UX after thinking completes by showing thought duration/character count and preventing status-line artifacts from becoming permanent output.

- 2026-04-12: Restored persistent final token snapshot after each AI turn
  - Files: `index.ts`, `.github/copilot-instructions.md`
  - Summary: Added `printFinalTokenSnapshot()` and invoked it from the final-stats callback so each completed response prints a stable `used/limit`, percentage, source tag, and used-token count line after clearing the live status line.
  - Intent: Bring back easy-to-read final token totals in scrollback without reintroducing lingering status-line artifacts.

- 2026-04-12: Hid estimated token totals from live status output
  - Files: `statusLine.ts`, `index.ts`, `.github/copilot-instructions.md`
  - Summary: Updated the live status bar and warning text so estimated counts no longer print as raw totals. Only the final authoritative Ollama snapshot prints full `used/limit` totals; in-progress UI now stays percentage-based unless the source is definitively Ollama.
  - Intent: Prevent tokenizer-based estimates from looking like authoritative token totals while preserving the final post-response token snapshot.

- 2026-04-05: Integrated Ollama authoritative tokens for auto-compaction
  - Files: `index.ts`, `.github/copilot-instructions.md`
  - Summary: `getCurrentTokenEstimate()` now anchors the total context estimate to the last exact token count provided by Ollama (`lastAuthoritativeTokens`) and only uses the local Tiktoken approximation for the delta of added messages since that point.
  - Intent: Fix a bug where the local tokenizer heavily underestimated true token cost, causing the application to warn about 96% context usage but incorrectly failing to automatically compact because its internal calculation stayed under 92%.

- 2026-04-04: Improved `/compact` with output budgeting and sliding-window preservation
  - Files: `compact.ts`, `.github/copilot-instructions.md`
  - Summary: Added three compaction upgrades: (1) explicit `num_predict` overrides for summarization/distillation to avoid backend defaults truncating around ~2k tokens, (2) dynamic budget signaling in the summarizer system prompt with target/min/max token guidance derived from `numCtx`, and (3) context-scaled sliding-window preservation of recent messages so only older history is summarized while newer turns remain verbatim.
  - Intent: Retain materially more useful context on large windows (e.g. 128k) while still reducing history size and preventing over-aggressive summarization.

- 2026-04-04: Tuned `/compact` to avoid no-op growth on short splits
  - Files: `compact.ts`, `.github/copilot-instructions.md`
  - Summary: Reduced preserved-recent aggressiveness (lower ratio/floor, capped preserved message count by minimum summary share) and added source-aware summary budget capping so summary targets scale down when only a small slice is being summarized.
  - Intent: Reduce failures where compaction preserved too much recent history and summary output grew enough to exceed original token count.

- 2026-04-04: Added automatic context compaction
  - Files: `index.ts`, `.github/copilot-instructions.md`
  - Summary: Added `autoCompactIfNeeded()` in `index.ts` that triggers compaction when estimated token usage reaches `AUTO_COMPACT_THRESHOLD_PCT` (92%). The function is called at the top of every tool-call loop iteration, covering both mid-turn (between tool calls) and end-of-turn growth. A yellow `⚡` status line informs the user; errors are caught and shown as non-fatal warnings so the loop always continues.
  - Intent: Prevent context-overflow hard stops by proactively compacting during long agentic runs without requiring user intervention.

- 2026-03-24: Moved startup configuration prompts to a /settings menu
  - Files: `index.ts`, `slashCommands.ts`, `constants.ts`
  - Summary: Removed repetitive prompts for Execution Mode, max queries, and context length on startup. Added a `/settings` slash command to configure these mid-session.
  - Intent: Streamline app startup and improve UX by persisting previous configurations and relying on fallbacks.

- 2026-03-24: Replaced Inquirer `search` with standard `readline` for improved multi-line input
  - Files: `index.ts`
  - Summary: Replaced `@inquirer/prompts/search` component with a custom `getMultilineInput` node readline interface. It gracefully delays `30ms` upon encountering a newline to wait for potentially fast-arriving lines (pasting multi-line text) and supports `"""` syntax or trailing `\` to compose lines manually.
  - Intent: Allow the user to intuitively paste terminal outputs or Python blocks into the CLI without accidental early submissions caused by embedded `\r\n`. Autocomplete for `/slash` commands was retained via the native `readline` completer (`<Tab>`).

- 2026-03-12: Added `fetch_image` tool for vision models
  - Files: `tools/fetchImageTool.ts` (new), `tools.ts`, `ollamaApi.ts`, `history.ts`, `index.ts`, `package.json`
  - Summary: New tool that fetches an image from an HTTP/HTTPS URL or an absolute local file path, encodes it as base64, and attaches it to the tool result message via the `images` field on `ChatMessage`. `handleToolCall` return type changed from `string` to `ToolCallResult { content, images? }`. `history.ts` gained an `images` column on the messages table (migration-safe via `addColumnIfMissing`) so image data survives session reload. Supports JPEG, PNG, GIF, WebP, BMP, etc.; 10 MB limit. Image format is validated using the `image-type` library (magic bytes) to reject non-image resources (like HTML error pages masquerading as images) before processing.
  - Intent: Enable vision-capable models to inspect images safely and persistently.

- 2026-03-09: Fixed post-stream re-render using viewport-aware strategy
  - Files: [aiResponseRenderer.ts](aiResponseRenderer.ts)
  - Summary: Replaced the broken DSR/absolute-positioning attempt with a reliable short/long split: if `streamedLines < termHeight` the cursor steps back with `\x1B[{N}A` (safe because content never scrolled the viewport) and the raw text is replaced with formatted markdown; if content scrolled the terminal, the raw stream is left in scrollback and the formatted version is appended below a dim separator — avoiding the half-erase artefact caused by `\x1B[{N}A` being capped at the top of the visible screen. Also removed the non-functional `queryCursorRow` DSR helper.
  - Intent: Ensure formatted markdown is always visible and never partially overwrites raw streamed output. Simple, reliable, no stdin dependency.

- 2026-03-09: Corrected bold/italic/code rendering fix in list items
  - Files: [markdownRenderer.ts](markdownRenderer.ts)
  - Summary: Replaced the earlier regex-based `listitem` monkey-patch with a targeted `text` renderer patch. Root cause: `marked-terminal`'s `text` renderer discards inline token children (`token.tokens`) and returns the raw markdown string, so `strong`/`em`/`codespan` renderers are never invoked for text inside list items. The fix overrides `renderer.text` to delegate to `renderer.parser.parseInline(token.tokens)` when token children are present, letting the real renderers run. Also primes the renderer with an empty `marked.parse('', { renderer })` call so `renderer.parser` is initialized before the patch runs.
  - Intent: Fix the issue correctly at the source (the `text` renderer, not `listitem`), removing fragile regex substitution and correctly routing through the configured Chalk styles.

- 2026-03-04: Implemented DuckDuckGo pagination for `web_search`
  - Files: `tools/webSearchTool.ts`, `.github/copilot-instructions.md`
  - Summary: `fetchSearchResults` now fetches additional pages via POST (using the `vqd` token and `s`/`dc` offset) until `resultsPerQuery` is satisfied or no more results are available. Result parsing was extracted into a `parseResultsFromPage` helper. Duplicate URLs across pages are deduplicated.
  - Intent: Honour the user-configured `resultsPerQuery` value (e.g. 15) rather than being silently capped at ~10 by the default DDG HTML page size.

- 2026-03-03: Switched token reporting to Ollama-authoritative final stats
  - Files: `ollamaApi.ts`, `aiResponseRenderer.ts`, `index.ts`, `statusLine.ts`, `compact.ts`, `history.ts`, `slashCommands.ts`, `README.md`, `.github/copilot-instructions.md`
  - Summary: Added support for `prompt_eval_count` / `eval_count` in chat responses, propagated final turn stats through the streaming renderer, reconciled the live token meter to authoritative values after each response, updated `/compact` token math to use Ollama-measured counts, and persisted latest turn token stats in session records.
  - Intent: Keep the responsive live meter UX while using model-native token accounting for final numbers and compaction decisions.

- 2026-03-02: Hardened markdown normalization heuristic for mixed indentation
  - Files: `markdownRenderer.ts`, `.github/copilot-instructions.md`
  - Summary: Updated normalization to count indentation in columns (spaces + tabs), strip indentation safely, and trigger dedent based on indented markdown-structure lines instead of all non-empty lines.
  - Intent: Ensure a single unindented line does not disable normalization and fix cases where tab-indented markdown was still rendered as an indented code block.

- 2026-03-02: Added markdown indentation normalization before terminal rendering
  - Files: `markdownRenderer.ts`, `.github/copilot-instructions.md`
  - Summary: Added a normalization pass that detects accidental global indentation in model responses and removes shared left padding (typically 4 spaces) before passing text to `marked`. The heuristic only applies when multiple markdown-structure lines are detected and avoids mutating fenced code blocks.
  - Intent: Prevent headings/lists/links from being misinterpreted as indented code blocks while preserving legitimate code-fence formatting.

- 2026-03-02: Moved to true streaming output in `aiResponseRenderer.ts`
  - Files: `aiResponseRenderer.ts`, `index.ts`, `.github/copilot-instructions.md`
  - Summary: `streamAIResponse` now owns the full turn lifecycle — it creates the `AbortController` and `sendOllamaChatStream` call internally. The caller only passes `(baseUrl, params, { onStatusUpdate })`. Text chunks are written to the terminal immediately as each NDJSON chunk arrives (no more buffering), giving a real-time "model is typing" effect. The `AI >` label is printed on the first chunk, and an inline `(interrupted)` suffix is appended if the stream is cut short. `printAIResponse` is kept for pre-built/fallback strings and still uses markdown rendering.
  - Intent: Eliminate the blank-wait before any output appears; make the call-site in `index.ts` as simple as possible by hiding all stream/abort plumbing inside the renderer where it belongs. Markdown rendering during live streaming is intentionally omitted (same trade-off as the Ollama CLI) since `marked` requires the full text for tables and code blocks.

- 2026-03-02: Centralised AI response rendering into `aiResponseRenderer.ts`
  - Files: `aiResponseRenderer.ts` (new), `index.ts`, `.github/copilot-instructions.md`
  - Summary: Extracted all AI response printing logic from `index.ts` into two focused exports: `printAIResponse(content, opts?)` which clears the status line and renders markdown with the correct label, and `streamAIResponse(stream, opts)` which consumes an Ollama chat stream, manages the interrupt handler lifecycle, updates the live status, and delegates rendering to `printAIResponse`. Removed `sanitize`, `registerInterruptHandler`, `unregisterInterruptHandler` from `index.ts` imports, and removed the `renderMarkdown` import.
  - Intent: Eliminate repeated and fragmented stream/render code in `index.ts`, making it trivial to add future response sites (e.g. inline tool result summaries) by calling a single well-tested function. `printAIResponse` can also be called outside a streaming context (e.g. fallback messages) without duplicating label/markdown/newline boilerplate.

- 2026-03-01: Aligned `fetch_url` required-arg validation in dispatcher
  - Files: `tools.ts`, `.github/copilot-instructions.md`
  - Summary: Added an explicit `url` presence check in `handleToolCall` for `fetch_url` so missing/blank input returns `[Error: missing required argument "url"]` before tool execution.
  - Intent: Keep tool dispatch behavior consistent with other handlers and provide clearer, immediate argument errors.

- 2026-03-01: Reset interrupt key hint on listener removal
  - Files: `tools.ts`, `.github/copilot-instructions.md`
  - Summary: Updated `removeKeyInterruptListener` to reset `currentInterruptKeySpec` back to the default (`Ctrl+X`) even when no listener is active.
  - Intent: Prevent stale interrupt hints from persisting between listener lifecycles and keep `getInterruptHint()` accurate.

- 2026-02-28: Hardened `parseQueriesInput` fallback behavior
  - Files: `tools.ts`, `.github/copilot-instructions.md`
  - Summary: Updated `parseQueriesInput` so malformed or non-array JSON-like `queries` input no longer returns an empty list silently; it now falls back to plain delimiter-based parsing.
  - Intent: Preserve usable query text from imperfect model/tool arguments and avoid accidental loss of search intent.

- 2026-02-28: Validated numeric tool arguments from LLM tool calls
  - Files: `tools.ts`, `.github/copilot-instructions.md`
  - Summary: Added strict validation/coercion for `timeout_seconds`, `max_queries`, and `results_per_query` in `handleToolCall`. Invalid, non-finite, and out-of-range values now return explicit tool errors instead of passing through.
  - Intent: Prevent malformed numeric arguments (e.g., `NaN`, negatives, infinity) from causing broken timeouts or unpredictable web tool behavior.

- 2026-02-28: Extracted slash command logic into `slashCommands.ts`
  - Files: `slashCommands.ts` (new), `index.ts`, `.github/copilot-instructions.md`
  - Summary: Moved all slash-command handlers, the `SLASH_COMMANDS` array, `COMMAND_HANDLERS` registry, and shared utilities (`withExitGuard`, `replaceMessages`, `getModels`) plus the `Config`, `ChatContext`, `SlashCommand`, and `SlashHandler` types into a dedicated `slashCommands.ts` module. Updated `index.ts` to import from the new module.
  - Intent: Reduce `index.ts` line count and improve separation of concerns by isolating command definitions and their handlers.

- 2026-02-28: Refactored slash commands into a registry and fixed regressions
  - Files: `index.ts`, `.github/copilot-instructions.md`
  - Summary: Moved slash-command handling (`/model`, `/compact`, `/sessions`, `/delete`, `/nudge`, `/help`, `/exit`) into a command-handler registry with shared chat context. Fixed post-refactor TypeScript issues (duplicate `historyLengthBeforeTurn` declaration and safe command parsing).
  - Intent: Keep the main chat loop focused and make command behaviors modular, testable, and easier to extend without re-growing conditional blocks.

- 2026-02-28: Fixed multiple technical bugs and performance issues
  - Files: `index.ts`, `tokenizer.ts`, `history.ts`, `tools/htmlExtractor.ts`, `tools/webSearchTool.ts`
  - Summary: Fixed dead variables, interrupt guards, token encoder staleness, session JSON parsing, and redundant HTML extraction. Corrected string concatenation in web search system prompt.
  - Intent: Improve application stability, accuracy of token counts, and performance of web tool execution.

- 2026-02-28: Added stdin error handling for `run_command`
  - Files: `runCommandTool.ts`, `.github/copilot-instructions.md`
  - Summary: Added explicit handling for missing stdin streams, asynchronous stdin errors, and synchronous stdin write/end failures when sending shell commands.
  - Intent: Prevent unhandled EPIPE-like failures and ensure command execution errors are surfaced as tool results instead of crashing or hanging.

- 2026-02-28: Fixed `cmd` shell configuration for stdin execution
  - Files: `runCommandTool.ts`, `.github/copilot-instructions.md`
  - Summary: Updated `getShellConfig` to use `cmd.exe` with `/D /Q` so stdin-fed scripts execute more predictably and with cleaner output on Windows.
  - Intent: Keep command execution behavior consistent across shells while preserving the exact-via-stdin design.

- 2026-02-28: Added elapsed time to command tool output
  - Files: `runCommandTool.ts`, `.github/copilot-instructions.md`
  - Summary: `buildOutput` now reports `elapsed_seconds` for both running and completed commands.
  - Intent: Give the model and user clearer runtime context when polling long-running commands or diagnosing slow executions.

(End of maintenance instructions)
- 2026-02-24: Added alternate `Ctrl+X` interrupt key
  - Files: `tools.ts`, `index.ts`, `.github/copilot-instructions.md`
  - Summary: Added `installKeyInterruptListener` / `removeKeyInterruptListener` in `tools.ts`. `Ctrl+X` interrupts the AI loop; `Ctrl+C` exits the app as normal at all times. Because `setRawMode(true)` suppresses OS SIGINT, the keypress listener re-raises it via `process.kill(process.pid, 'SIGINT')` when Ctrl+C is pressed.
- 2026-02-23: Added minimal `web_search` tool (no page summarization)
  - Files: `webSearchTool.ts` (new), `tools.ts`, `index.ts`, `README.md`, `.github/copilot-instructions.md`
  - Summary: Added DuckDuckGo-backed web search with configurable max queries/results per query, readability-based text extraction, and live terminal progress logs.
  - Intent: Provide optional external context with minimal runtime overhead; keep architecture flexible for future summary-based output instead of full page text.

- 2026-02-23: Include AI error summary in conversation history
  - Files: `index.ts`, `.github/copilot-instructions.md`
  - Summary: The AI-generated error summary for failed commands is now pushed into the `messages` array as a user-role nudge.
  - Intent: Help the LLM reasoning about command failures by providing an explicit analysis of the error in its context.
- 2026-02-23: Added AI error summarization for failed commands
  - Files: `errorSummary.ts` (new), `index.ts`, `.github/copilot-instructions.md`
  - Summary: When a `run_command` tool call fails (non-zero exit code), Locopilot now calls the LLM to summarize the error and prints this summary to the terminal.
  - Intent: Help the user understand technical command failures quickly without reading through raw stderr output.
- 2026-02-23: Added YOLO mode menu option
  - Files: `index.ts`, `README.md`, `.github/copilot-instructions.md`
  - Summary: Added a startup menu to select between Standard and YOLO execution modes. The choice is persisted in `config.json`.
  - Intent: Provide a reliable way to enable YOLO mode when command-line flags are consumed or ignored by the environment/shell.
- 2026-02-23: Improved YOLO mode detection
  - Files: `index.ts`, `tools.ts`, `README.md`
  - Summary: Made YOLO mode detection more robust by adding support for `-y` shorthand and `YOLO` environment variable. Refactored `index.ts` to use a central `isYolo()` check from `tools.ts`.
  - Intent: Resolve issues where some environments/shells (like PowerShell) or `npm` versions might not pass the `--yolo` flag correctly.
- 2026-02-23: Fixed TS2451 redeclaration error
  - Files: `index.ts`
  - Summary: Removed redundant `let` keyword for `configData` variable in `main` function.
  - Intent: Fix a regression introduced in the previous update that prevented compilation.
- 2026-02-23: Added `/compact` conversation compaction feature
  - Files: `compact.ts` (new), `index.ts`, `.github/copilot-instructions.md`
  - Summary: Added a `/compact` slash command that summarises the conversation history via the LLM, replaces the live history in-place, and prints before/after stats.
  - Intent: Reduce context window consumption during long sessions without losing important context. The model is always told it is reading a summary so it does not get confused.
- 2026-02-23: Added Ctrl+C interrupt for the AI tool-call loop
  - Files: `tools.ts`, `index.ts`, `.github/copilot-instructions.md`
  - Summary: Added `requestInterrupt`, `clearInterrupt`, and `isInterruptRequested` to `tools.ts`. The SIGINT handler in `index.ts` is temporarily replaced during the tool-call loop so Ctrl+C fires `requestInterrupt()` (killing any running child process) instead of exiting the app. The loop breaks cleanly and the conversation history is left consistent.
  - Intent: Let the user escape a stuck or looping AI without losing their session or corrupting history.
- 2026-02-23: Refactored tools.ts to improve DRYness
  - Files: `tools.ts`
  - Summary: Consolidated shell resolution and configuration logic. Extracted redundant process completion and interrupt handling logic into a shared helper within the runCommand promise.
  - Intent: Improve maintainability and reduce code duplication in the tool execution layer.
- 2026-04-19: Added runtime Ollama connection configuration
  - Files: `slashCommands.ts`, `constants.ts`, `services/llm.ts`, `.github/copilot-instructions.md`
  - Summary: Added a `Connection` option to the `/settings` menu that lets users change the Ollama host and port mid-session. The handler parses the current URL to pre-fill defaults, prompts for new host/port, validates connectivity, and persists the updated `baseUrl` to `config.json` along with refreshing `setWebSearchConfig`.
  - Intent: Allow users to switch between different Ollama instances without restarting the application.

- 2026-04-26: Added targeted file patch tool
  - Files: `tools/impl/patchFileTool.ts` (new), `tools/toolRegistry.ts`, `tools/tools.ts`, `tools/impl/writeFileTool.ts`, `tools/TOOL_GUIDE.md`
  - Summary: Added `patch_file(path, patches)` so the model can apply small atomic replacements without rewriting whole files. The tool validates each patch against the current file, tolerates line-ending and trailing-whitespace drift, rejects missing or ambiguous matches, and writes only after all patches pass validation.
  - Intent: Reduce token usage and accidental regressions when editing large source files one or two lines at a time.
