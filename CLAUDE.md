# Locopilot — Agent instructions

This file is loaded into the agent's system prompt for every Claude Code
session in this repository. It captures project conventions, architecture
context, and maintenance rules that aren't obvious from reading the code
alone. Keep it focused on things the agent needs to remember on every
turn — long-form history lives in `docs/CHANGELOG.md`, not here.

- Recent feature changes are logged in `docs/CHANGELOG.md`; consult it
  when investigating non-obvious behavior or stale references.
- This file was renamed from `.github/copilot-instructions.md` (the
  GitHub Copilot path). The filename and content are now Claude-Code-
  native; the `.github/` path is no longer used.

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
    - `/clear-images`: Remove all image attachments from the active conversation, both in client state and persisted SQLite, to free vision context and recover from 400 errors.
    - `/sessions`: Switch between multiple persistent chat histories.
    - `/delete`: Remove a session from the local database.
    - `/nudge`: Manually inject a tool-use reminder if the AI is hesitant.
    - `/help`: Application control and documentation.

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
  - **Add new dated entries to `docs/CHANGELOG.md`, not to this file.**
    This file should hold only the conventions, architecture summary, and
    feature documentation that the agent needs on every turn.

- **Adapter mapping convention**:
  - Canonical request concepts belong on `ChatParams` / `StreamChatParams` as typed fields (e.g. `maxOutputTokens`), not buried inside `options`.
  - Each adapter is responsible for translating canonical fields into provider-native request fields:
    - Ollama: `maxOutputTokens` → `options.num_predict`
    - OpenAI-compatible: `maxOutputTokens` → `max_completion_tokens`
  - Keep provider-specific parameter names out of callers. Legacy `options.*` passthrough may remain as a fallback, but new code should prefer the canonical field.
  - Document the mapping in both JSDoc on `ChatParams` and in `OPENAI_COMPATIBILITY_MIGRATION.md`.
  - When adding a new provider, implement the same canonical fields so callers stay provider-agnostic.

- **numCtx cap resolution** (`src/services/capResolver.ts`, `src/services/llmContextLimit.ts`):
  - The user's `requestedNumCtx` is the source of truth. We always send it to the model as `options.num_ctx`. For Ollama, the server's scheduler reloads the runner if the requested size differs from the runner's current KV cache, so a 4096 runner accepts a 1M request by tearing down the 4096 runner and starting a 1M one.
  - The model cap is discovered from the **static probe** (`/api/show`'s `model_info.<arch>.context_length`, or the Modelfile's `PARAMETER num_ctx N` for RoPE-scaled models). The runtime probe (`/api/ps`) is informational only — it reports the runner's transient state, not the model's ceiling.
  - `getModelContextLimitFromInfo` tries the Modelfile/parameters text scan FIRST, then falls back to the structured walk. This captures RoPE-scaled Modelfile overrides (e.g. `num_ctx 1048576`) that exceed the GGUF training context.
  - The cap cache is per-`(baseUrl, modelName)` with a 5-minute TTL. Invalidate it on model change or `requestedNumCtx` change via `invalidateCapCache(baseUrl?, modelName?)`.
  - The 400-driven discovery path in the chat route no longer writes to `sessions.num_ctx` — that column was a permanent poison pill. `updateSessionNumCtx` is deprecated; the in-memory cache and the SSE `status` event are sufficient.

- **Vision-capability cache** (`src/services/visionCache.ts`, `src/services/llmContextLimit.ts`):
  - Per-`(baseUrl, modelName)` cache of vision (image-input) support, mirroring `capResolver.ts` exactly: NUL-separated key, 5-minute TTL, `Map`-backed, `invalidateVisionCache(baseUrl?, modelName?)` for model/baseUrl change.
  - **Default behaviour**: OpenAI-compatible assumes `'supported'` (optimistic — `/v1/models` has no standard `capabilities` field and the legacy `info.capabilities` check would return `false`, which silently strips images). Ollama assumes `'unsupported'` (preserves the pre-fix behaviour — `/api/show` exposes `capabilities` for vision models, so the optimistic default is the wrong fallback when capabilities are missing).
  - **Reactive discovery**: `parseVisionUnsupportedFromError` in `src/services/llmContextLimit.ts` matches a small set of well-known 400-message patterns ("image input is not supported", "does not support image", "image_url is not supported", etc.). When the chat route's 400 catch block matches, it calls `recordDiscoveredNonVision(baseUrl, model)` and emits an SSE `status` event with `phase: 'vision_unsupported'` so the client warning UI updates. Conservative on purpose — false positives would silently strip images from a model that actually supports them.
  - **Surface for callers**: `resolveVisionSupport(baseUrl, model, provider, probe?)` returns `{state, source}`. The chat route's pre-flight call uses the **async** `getLlmModelVisionSupportAsync` which goes through the cache; the legacy sync `getLlmModelVisionSupport(info)` is kept for the `/api/models` projection and is defensive against `null`/`undefined` info payloads.
  - **Client warning UI**: `ChatInput.tsx` renders an inline amber `⚠` warning when the user attaches an image to a known non-vision model, and a softer `ℹ` "unconfirmed" hint for the `unknown` + openai-compatible case (the optimistic default has not yet been resolved for that model). The attach control stays enabled — the warning is informational, not a block.
  - **Invalidation**: `src/app/api/config/route.ts` calls `invalidateVisionCache(...)` for both the old and new `(baseUrl, model)` pair on model/baseUrl change — same conditions as `invalidateCapCache`.

- **Web search tool** (`web_search`):

- **App Router 404 / `_document` build error** (known Next.js 15.5 upstream bug — see vercel/next.js#90349):
  - Next.js 15.5 always generates an internal Pages Router `_error`/`_document` fallback for `/404` and `/500`, even in pure App Router projects with no `pages/` directory. During static generation this throws `<Html> should not be imported outside of pages/_document`.
  - Correct App Router conventions that should still be followed: include `src/app/not-found.tsx`; `src/app/error.tsx` must not render `<html>` or `<body>` (only `layout.tsx` and `global-error.tsx` may own those tags).
  - Workarounds that do NOT work cleanly: adding a `pages/` directory triggers a separate Next.js 15.5 validator bug (`.next/types/validator.ts` hardcodes wrong `.js` paths when `src/` is used). Setting `typedRoutes: false` does not disable the validator.
  - **Current status**: `npm run build` still fails at the static-page-generation step with this error. `tsc --noEmit` and `npm run dev` are unaffected. This is tracked as a pre-existing upstream bug.
  - Changed `queries` parameter from `string` to `array` in the tool schema to encourage LLMs to provide multiple explicit queries properly.
  - Updated `parseQueriesInput` in `tools.ts` to handle actual arrays, JSON-encoded arrays, and strings separated by newlines, commas, or semicolons.
  - Updated tool description and system prompt to explicitly encourage using 2-3 queries for complex tasks.
  - Improved automated query derivation in `webSearchTool.ts` to split prompts on "and", "or", commas, and semicolons.
  - This ensures more effective search coverage even with "lazy" model inputs.
