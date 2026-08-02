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

## Transient-error retry layer (`src/services/adapters/openaiCompatibleAdapter.ts`)

The openai-compatible adapter wraps the initial `client.responses.create`
call in `withRetryAround`, with exponential backoff and `Retry-After`
honoring (seconds form and HTTP-date form, plus `retry-after-ms`). Retry
runs INSIDE the adapter — not at the route — so every consumer of the
adapter (main chat, sub-agents, compaction distill/measure/summarize,
title generation, prompt-loop judge/critic) recovers from 429s and
other transient statuses automatically.

Key facts:

- Pre-stream only. Once any chunk has been yielded to the consumer, a
  retry cannot be transparent to the client (the route's
  `clear_assistant` only removes the last _committed_ assistant
  message, not the in-flight partial). The chat route's existing retry
  loop at `src/app/api/chat/route.ts:1093-1238` stays as the safety net
  for mid-stream failures.
- Defaults: `enabled=true`, `maxAttempts=3`, `baseDelayMs=1000`,
  `maxDelayMs=16000`, retryable statuses `{408, 409, 429, 500, 502, 503, 504}`.
  Configurable via the `retry: { ... }` block in `config.json` (same
  shape as `webSearch`). The adapter reads this through `loadConfig()`
  with a 60-second TTL cache; invalidate with
  `clearRetryConfigCache()` after tests.
- `isRetryableError` in `src/app/api/chat/sseStream.ts:74-99` was
  extended to duck-type any object with a numeric `.status`, so the
  chat route's fallback loop now correctly recognises `OpenAI.APIError`
  (it previously only matched axios errors and missed SDK-thrown 429s).
- The `logAdapter400` debug-dump helper now runs only after the final
  retry attempt, not per attempt, so a 429 storm no longer fills the
  repo root with `debug_400_*.json` files.

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
- **Skills**: Self-contained `SKILL.md` packages with YAML frontmatter (`name`, `description`, optional `alwaysApply`, `autoInvoke`, `globPatterns`, `allowedTools`). Two discovery layers, project wins on name collision:
  - `project` (highest precedence): `<cwd>/.locopilot/skills/<name>/SKILL.md`
  - `user-profile` (lowest precedence): `~/.locopilot/skills/<name>/SKILL.md`
  - On Linux, `~/.locopilot` resolves to `$HOME/.locopilot`; on Windows, `os.homedir()` returns `%USERPROFILE%`, so the path is `%USERPROFILE%\.locopilot\skills\`. The `LOCOPILOT_HOME` env var, when set, overrides the user-profile root (useful for installs that relocate the user directory). The `create_skill` tool's optional `location` argument (`'project'` | `'user-profile'`, default `'project'`) lets the LLM write into either layer; the `Skill` object exposes its source as `skill.location`. See `src/services/skillManager.ts` for the loader and `src/tools/impl/createSkillTool.ts` for the tool schema.

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
  - **Current status**: project is on Next.js 16.2.x; this 15.5 bug does not block the build anymore (`next build` completes successfully). The entry is kept as a reminder that any future attempt to add a `pages/` directory or pin to Next.js 15.x will re-expose these failures. Tracked as a pre-existing upstream bug.

- **Stale / mid-write `.next/dev/types/routes.d.ts`** (known Next.js 16.2.x upstream bug — see vercel/next.js#94153, #95454/#95635 + PR #95638):
  - The dev server's `routes.d.ts` can be left with a truncated / duplicated `interface RouteContext` declaration when its write is interrupted or interleaved with another process touching `.next/`. The resulting file looks like a clean file followed by a partial fragment (`ce RouteContext<...> { ... } }`), which breaks `tsc --noEmit` with `TS1434`/`TS1005`/`TS1128`.
  - `.next/dev/types/routes.d.ts` is included in `tsconfig.json` so the dev server's typed-routes types are visible to the IDE while `next dev` runs; the production `.next/types/routes.d.ts` covers the same surface for `next build`. Excluding the dev copy has no impact on type checking.
  - **Workaround in repo**: `tsconfig.json` excludes `.next/dev/types/routes.d.ts` alongside the existing `validator.ts` excludes. `tsc --noEmit` now stays green even when the dev file is corrupted mid-regeneration.
  - **Current status**: `next build` and `tsc --noEmit` both pass cleanly. The corruption only affects the dev-generated types and is not visible from `next build`. Tracked as a pre-existing upstream bug; PR #95638 (`getDevTypesPath()` now checks `process.env.__NEXT_DEV_SERVER` instead of `NODE_ENV === 'development'`) is still open on the canary branch as of August 2026.
  - Changed `queries` parameter from `string` to `array` in the tool schema to encourage LLMs to provide multiple explicit queries properly.
  - Updated `parseQueriesInput` in `tools.ts` to handle actual arrays, JSON-encoded arrays, and strings separated by newlines, commas, or semicolons.
  - Updated tool description and system prompt to explicitly encourage using 2-3 queries for complex tasks.
  - Improved automated query derivation in `webSearchTool.ts` to split prompts on "and", "or", commas, and semicolons.
  - This ensures more effective search coverage even with "lazy" model inputs.
