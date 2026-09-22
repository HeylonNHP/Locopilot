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
- **Sub-agent Terminal Output**: Web UI sub-agent output is attributed through structured `agentId` metadata rather than display-only text prefixes. Nested `run_command` requests still surface the normal approval prompt in standard mode, with the output routed to the requesting sub-agent's bubble.
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
- **Live Token Meter**: The status bar (src/components/StatusBar/StatusBar.tsx) shows real-time context usage (used / limit, estimated vs authoritative), the generation model, and a tokens-per-second badge. The t/s policy lives in two tested modules: src/services/tokenThroughput.ts (shared by the main chat loop and sub-agents) and src/app/lib/tpsDisplay.ts (display precedence/formatting), covered by scripts/test-token-throughput.mjs.
- **Tokens-per-second semantics**: The live rate rebaselines its clock at the first token-bearing chunk (model load and prompt processing are excluded), only updates while new tokens are actively arriving (it freezes instead of decaying while the model streams unobservable tokens such as tool-call arguments), and never reports a rate measured over less than one second of generation time - so bulk token arrivals (buffered provider flushes) can never spike the badge to six-figure t/s. Tool-call argument JSON is deliberately not counted into the live rate (it surfaces retroactively with no honest timestamp); the end-of-turn rate covers it. The end-of-turn rate aggregates every LLM call in the turn as sum(evalCount)/sum(evalDuration) - not last call wins - with a wall-clock fallback for providers that report no durations, tagged (est) in the UI. The prompt-processing rate is never displayed as generation speed. done events always carry the t/s fields (null when unknown) so stale previous-turn rates are cleared; error/abort paths clear the read-out scoped to the owning session, and a background stream buffered done is flushed to its session slot so a switch-back never shows a frozen live estimate.- **Compaction speed (t/s)**: The t/s badge keeps updating while a conversation compaction runs - the distillation and summarisation/map-reduce LLM calls report live rates through the same shared meter (and sub-agent auto-compaction via reportTps), emitted as status events under the `compacting` phase. The `/compact` slash command consumes them in its own SSE loop and clears the badge when compaction ends. The token-measurement call is deliberately excluded (it generates at most one token, so it has no meaningful rate).

- **Authoritative Stats**: Reconciles estimated local token counts (`tiktoken`) with authoritative metrics from Ollama (`prompt_eval_count`, `eval_count`) at the end of each turn.
- **Token Calculation**: Estimated counts [tokenizer.ts](tokenizer.ts) add 4 tokens per message plus role, content, and tool call overhead to match OpenAI-style counting as a robust local approximation.
- **Conversation Compaction**: The `/compact` command [compact.ts](compact.ts) uses a high-context LLM pass to summarize everything (decisions, code, paths) into the third person, injecting a `[This conversation history has been compacted...]` preamble.
- **Auto-Compact**: When context usage reaches 92%, compaction is triggered automatically at the start of each tool-call loop iteration (covers both between-tool-call growth and end-of-turn growth). A yellow `⚡ Context at N% — auto-compacting...` line is printed. If compaction fails or is a no-op, a warning is shown but the loop continues uninterrupted. If the compacted result still exceeds 90% of the context window (`COMPACT_ACCEPTANCE_HEADROOM`), compaction automatically retries up to twice more with a stronger aggressiveness factor that shrinks preservation budgets and summary targets. The most recent user prompt is always preserved verbatim across all passes. Both the to-summarize window and the verbatim-preserved window have their large tool outputs distilled before the final message list is assembled, preventing massive web-search results from bypassing compaction. If the result is still over the model context limit after all passes, a red warning is printed so the user can intervene.
- **Compaction awareness (LLM-visible)**: The post-compaction nudges are LLM-visible and self-reporting. The main chat loop keeps a per-request `compactionsSinceLastPrompt` counter (resets naturally per turn — each user message is a new request) and each auto-compaction nudge tells the model how many times the history has been compacted since its last message plus the current context-usage percentage; from the second compaction onward it adds a directive to economise on tool output and reconsider the approach. Sub-agents track and report their own local count the same way; the parent's count is deliberately not inherited. Synthetic server-generated user-role nudges (post-compaction notice, empty-response recovery, prompt-loop continuation) are prefixed with `SYNTHETIC_NUDGE_MARKER` (`src/services/compact/constants.ts`) and suffixed with `[End system notice]`; `isSyntheticNudge` in `src/services/compact/split.ts` excludes them from the latest-user-message verbatim anchor, so the real user prompt is never summarised away by a second in-turn compaction. Anchor behaviour is covered by `scripts/test-compact-anchor.mjs` (`npx tsx scripts/test-compact-anchor.mjs`).

## Empty-response recovery (`src/services/emptyResponseRecovery.ts`)

Feature summary:

- **Shared policy**: Detection of "empty" assistant replies (`hasMeaningfulAssistantContent` — empty/whitespace, or a bare reasoning-channel label like `thought`/`analysis`/`final`/`commentary` after special-token stripping), the attempt cap (`MAX_EMPTY_RESPONSE_RECOVERY_ATTEMPTS`, 3), the synthetic user-role nudge (`buildEmptyResponseRecoveryNudge`, marker-prefixed so compaction never anchors on it), and the streak tracker (`EmptyResponseRecoveryTracker`) live in one module used by both the main chat loop (`src/app/api/chat/route.ts`) and the sub-agent loop (`src/tools/impl/subAgentTool.ts`), so the behaviour can never drift between the two surfaces.
- **Loop contract**: On an empty reply, the loop pushes the empty assistant message plus the nudge into the LLM context (LLM-context only — nudges are deliberately NOT persisted to SQLite) and re-enters the loop, up to the cap. A tool-call turn or a meaningful reply resets the streak. After the cap is exhausted the empty reply is accepted as final (sub-agents surface `[Sub-agent completed without a final text response.]` to the orchestrator). Sub-agents emit an `empty_response_recovery` diagnostic and write a `[empty response #N/3]` line into their log bubble while retrying.
- Covered by `scripts/test-empty-response-recovery.mjs` (`npx tsx scripts/test-empty-response-recovery.mjs`).

## Web search & Fetch tools

Feature summary:

- **`web_search`**: Multi-query DuckDuckGo search with automatic derivation of search intent and pagination support.
- **`fetch_url`**: Direct page retrieval for following links or deep-diving into specific documentation.
- **`fetch_image`**: Fetches an image from a URL or local file path and attaches it as base64 to the conversation message. Vision-only; only useful with models that have image understanding (e.g. llava, llama3.2-vision). Supports JPEG, PNG, GIF, WebP, and BMP up to 10 MB. The base64 is stored in the `images` field of the tool result message and is persisted to SQLite alongside other message fields.
- **Smart Extraction**: Uses `@mozilla/readability` and `cheerio` to extract clean text from HTML, ignoring navbars and boilerplate.
- **Configurable limits**: Timeouts and character limits are enforced to keep history manageable.

## MCP OAuth client registration & diagnostics

MCP servers that need OAuth 2.1 carry an `oauth` block in `~/.locopilot/mcp.json`.
Client identity is chosen by a priority chain (`resolveClientRegistrationStrategy`
in `src/mcp/oauthDiagnostics.ts`):

- `configured` — a pre-registered `oauth.clientId` (plus `oauth.clientSecret`
  when the server requires one) always wins.
- `cimd` — SEP-991 Client ID Metadata Documents, only for authorization
  servers that genuinely require them (NOT Atlassian). Set
  `oauth.clientMetadataUrl` to a **public HTTPS URL with a non-root
  pathname**; the authorization server fetches that document to identify
  Locopilot. `configLoader` validates the shape eagerly.
- `dcr` — RFC 7591 Dynamic Client Registration, the SDK's fallback. Locopilot
  ALWAYS sends `client_name` via `buildOAuthClientName(serverName)`, because
  some servers (Atlassian) reject DCR with HTTP 400 when it is absent. This is
  how the `atlassian` server actually authenticates: plain DCR, the same
  mechanism Claude Code uses, despite Atlassian also advertising
  `client_id_metadata_document_supported: true`.
- `unavailable` — neither CIMD nor DCR; the user must supply `oauth.clientId`.

`classifyMCPOAuthFailure` (same module) labels a failed connect as a
discriminated-union failure and decides the handle status. A genuine 401 keeps
the live transport alive for the later token exchange; every other auth
problem — including a rejected or unsupported client registration — surfaces as
`auth_required` with an accurate message and reaps the transport. Only
`interactive` connects (the Authenticate button / `/mcp auth`) can reach the
registration branches, so background/eager connects never report an auth
problem the user cannot act on. The classifier also guards on the stashed
authorization URL: an AS that advertises CIMD would otherwise have _every_
post-consent failure mislabelled as a registration problem, but a stashed URL
proves the SDK already had a client identity, so registration cannot be the
cause. The real authorization URL is stashed in memory
(`peekAuthorizationUrl` / `clearAuthorizationUrl` in `oauthProvider.ts`) and
rendered by the sidebar; no placeholder URL is ever fabricated.

MCP/OAuth diagnostics land in `logs/locopilot-debug.log` via
`debugLog.diagnostic({ layer: 'mcp', phase: 'oauth_*', failureKind, … })`
(`src/app/lib/debugLogger.ts`). Use the `oauth_discovery`, `oauth_redirect`,
`oauth_callback`, `oauth_token_exchange`, or `oauth_error` phases when extending
the flow. Regression coverage lives in `scripts/test-mcp-oauth.mjs`
(`npm run test:mcp-oauth`).

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

- **Mid-turn model switching** (`src/app/lib/modelSwitchRegistry.ts`, `src/app/api/chat/switch-model/route.ts`, `src/app/api/chat/route.ts`, `src/tools/impl/subAgentTool.ts`):
  - SSE is server→client only, so a streaming turn has no inbound channel. `POST /api/chat/switch-model` is the side channel — same pattern as `/api/approve`. It writes a pending `{ model?, providerId?, compactionModel?, compactionProviderId? }` into a per-session in-memory registry; a session with no streaming turn gets a 404, which the client treats as "the config update already covers the next turn".
  - **Boundary semantics, not interruption.** The switch is consumed at the top of the main `outer:` tool-call loop and at the top of each sub-agent iteration. An in-flight LLM call is never aborted, so the latency of a switch is bounded by the longest single tool call in progress.
  - **The sub-agent hook is load-bearing.** A `run_subagents` batch parks the main loop for its whole duration, so a top-of-loop check alone would delay the swap until the batch returned. `SubAgentConfig.refreshModels` (wired to `applyPendingModelSwitch` in `buildRequestContext`, called at the top of `runSingleAgent`'s `while`) is what makes the swap land mid-batch. It mirrors the existing `approvalRequester` closure — a callback on the config object that reaches back into route scope. When editing either loop, keep both consumption points.
  - **In-place mutation is deliberate.** `requestContext.subAgent` is mutated, never rebuilt: `subAgentTool` captures that object once by reference and reads `config.model` fresh each iteration, so mutation is what propagates. Rebuilding the context would strand already-running sub-agents on the old model. Provider fields are `delete`d when the new model has no configured provider, so a stale `apiKey` can't survive a swap.
  - `model` in the chat route is a `let`, and the model-dependent setup — `resolveNumCtxForModel`, `resolveVisionForModel`, `resolveSamplingSupportForModel`, `resolveCompactionRuntime` — is factored into closures reused by both initial setup and the switch, so a swapped model never runs on the previous model's verdicts.
  - Main and compaction models switch independently. Because `resolveCompactionModel('', model)` returns the main model, a "Same as main" user's compaction model follows a main-model switch for free.
  - The server confirms with a `status` event of phase `model_switched` carrying the resolved `model` and `compactionModel`. The client sets `modelSwitchPending` on request and clears it on that event — the status bar shows "(switching…)" rather than flipping optimistically on click.
  - The `/model` slash command needs no equivalent: `InputArea` unmounts `ChatInput` while streaming, so slash commands are unreachable mid-turn by construction.

- **Mid-turn steering messages** (`src/app/lib/steerRegistry.ts`, `src/app/api/chat/steer/route.ts`, `src/components/SteerInput/`, `src/app/api/chat/route.ts`, `src/tools/impl/subAgentTool.ts`):
  - Same side-channel/boundary-consumption shape as mid-turn model switching above, with two differences: the registry is a per-session FIFO **queue** (`SteerMessage[]`, not a merge-on-write object — several messages can be typed before either loop reaches its next boundary and none may be dropped), and entries carry a `target: 'main' | 'subagent'` so a drain can be scoped to whichever loop is asking. `modelSwitchRegistry.ts` exports `hasActiveTurn` so the new registry shares turn-liveness tracking instead of duplicating it.
  - `target: 'main'` entries are drained in the chat route's `outer:` loop right after `applyPendingModelSwitch()` and **before** auto-compaction — pushed as an ordinary, unmarked `user` message (not a `SYNTHETIC_NUDGE_MARKER` nudge) into both `currentMessages` and `pendingAppends`, so it is persisted normally and becomes the newest real user message. This is deliberate: compaction's existing "preserve the latest user message verbatim" anchor (`isSyntheticNudge` / `src/services/compact/split.ts`) protects it automatically, with no special-casing.
  - `target: 'subagent'` entries are drained by a new `SubAgentConfig.applySteerMessages?: (messages, agentId) => Promise<void>` hook, called in `runSingleAgent`'s loop right after `config.refreshModels?.()`. Unlike `refreshModels`, it cannot mutate shared config in place — a sub-agent's message history is a `while`-loop-local variable, not part of the shared `SubAgentConfig` object — so `runSingleAgent` passes its own `messages` array in explicitly. The hook only drains entries pinned to the currently-running `agent.id`; it never touches `target: 'main'` entries, so a main-targeted steer can never land mid-batch ahead of that sub-agent's own tool-call/tool-result rows.
  - **No new "is a sub-agent running" registry.** `run_subagents` already executes agents sequentially (never in parallel), so at most one `agentId` is ever active. The client derives this purely from SSE events it already receives (`tool_call` for `run_subagents` starting, `subagent_output`/`subagent_chunk` carrying the active `agentId`, the matching `tool_result` clearing it) into `chatStore.activeSubagentId` — see the `case 'status'`-adjacent handlers in `useChatStream.ts`.
  - **Client hold-until-ack invariant.** `InputArea` mounts a slim, always-available `SteerInput` next to Stop while streaming (instead of hiding the composer), with a main/sub-agent toggle shown only when `activeSubagentId` is set (defaults to sub-agent). Sending stores the draft in `chatStore.pendingSteerDraft` and does **not** clear/echo it until a matching `status` event with `phase: 'steer_applied'` (carrying `steerId`) arrives — that event alone adds the message to the transcript. Any path that ends without that ack — the `POST /api/chat/steer` 404s, the turn aborts, or the turn completes — routes through the `STOP_STREAMING` reducer case, which moves the undelivered draft into `chatStore.steerRestoreText`. `ChatInput` (which fully remounts once streaming ends) seeds its input from `steerRestoreText` on mount and clears it — kept as a separate field from `inputDraft`, which has its own history-navigation lifecycle, to avoid the two colliding.
  - **Server-side salvage is a backstop, not the guarantee.** `salvageSteerMessages()` runs just before the final and the abort-path `flushSessionState()` calls, folding any still-queued entries (e.g. pinned to a sub-agent that never got another iteration before the batch — and the turn — ended) into the persisted history. The real guarantee against losing typed text is the client-side hold-until-ack invariant above; this only protects against the client's in-memory state being lost (e.g. a page refresh) before that invariant could fire.

- **Vision-capability cache** (`src/services/visionCache.ts`, `src/services/llmContextLimit.ts`):
  - Per-`(baseUrl, provider, modelName)` cache of vision (image-input) support, mirroring `capResolver.ts`: NUL-separated key, 5-minute TTL, `Map`-backed, and `invalidateVisionCache(...)` for model/baseUrl/provider changes.
  - **Resolution precedence**: OpenAI-compatible assumes `'supported'` when no runtime discovery exists; Ollama assumes `'unsupported'` only as a weak fallback. A successful Ollama `/api/show` capabilities probe refreshes a weak default or older probe, while a runtime-discovered rejection from a matching 400 remains authoritative for the TTL. Probe failures preserve a valid cache entry and otherwise fall back to the provider default.
  - **Reactive discovery**: `parseVisionUnsupportedFromError` in `src/services/llmContextLimit.ts` matches a small set of well-known 400-message patterns ("image input is not supported", "does not support image", "image_url is not supported", etc.). When the chat route's 400 catch block matches, it calls `recordDiscoveredNonVision(baseUrl, model, provider)` and emits an SSE `status` event with `phase: 'vision_unsupported'` so the client warning UI updates. Conservative on purpose — false positives would silently strip images from a model that actually supports them.
  - **Surface for callers**: `resolveVisionSupport(baseUrl, model, provider, probe?)` returns `{state, source}`. The chat route and `/api/models` use the async `getLlmModelVisionSupportAsync` facade; Ollama model-info capabilities are passed when available so model listing cannot poison the cache with the default. The legacy sync `getLlmModelVisionSupport(info)` remains defensive for metadata-only callers.
  - **Client warning UI**: `ChatInput.tsx` renders an inline amber `⚠` warning when the user attaches an image to a known non-vision model, and a softer `ℹ` "unconfirmed" hint for the `unknown` + openai-compatible case (the optimistic default has not yet been resolved for that model). The attach control stays enabled — the warning is informational, not a block.
  - **Invalidation**: `src/app/api/config/route.ts` calls `invalidateVisionCache(...)` for both the old and new `(baseUrl, model)` pair on model/baseUrl change — same conditions as `invalidateCapCache`.

- **Sampling-parameter cache** (`src/services/samplingParamsCache.ts`, `src/services/llmContextLimit.ts`):
  - Per-`(baseUrl, provider, modelName, paramName)` cache of standard sampling-parameter support (`temperature`, `top_p`, `frequency_penalty`, `presence_penalty`, `seed`, `stop`, `logit_bias`). Mirrors the vision-cache shape: NUL-separated key, 5-minute TTL, `Map`-backed, `invalidateSamplingParamCache(...)` for model/baseUrl changes.
  - **Resolution precedence**: a fresh `discovered` (reactive 400) entry wins over later probes until its TTL expires. Successful `supported_parameters` probes refresh a weak default or older probe. Provider default is `'supported'` for both openai-compatible and Ollama — Ollama's API accepts every sampling knob even when a specific model ignores it, and a wrong strip is worse than a redundant field.
  - **Proactive discovery**: `fetchSamplingParamSupport` on the openai-compatible adapter hits `GET /v1/models` and reads the model entry's `supported_parameters` list (OpenRouter exposes this; other providers ignore the field). The chat route fires the probe once per turn via `getLlmModelSamplingParamSupportAsync` and feeds the result into `params.samplingParamSupport`, which the adapter consults synchronously at request build time. This proactive path is main-chat-turn only — it needs a network round trip, so it isn't worth doing on every sub-agent/judge/compaction call.
  - **Reactive discovery is adapter-level, not route-level.** `parseUnsupportedParamFromError` in `src/services/llmContextLimit.ts` matches a small set of well-known 400-message patterns ("temperature is not supported", "unsupported parameter: temperature", "does not accept temperature", "value not supported for parameter `temperature`", etc.). `openaiCompatibleAdapter.ts`'s own catch blocks (`sendOpenAICompatibleChat` and `sendOpenAICompatibleChatStream`) parse every failed request through `recordUnsupportedParamIfDiscovered`, which calls `recordDiscoveredUnsupportedParam` directly — so ANY caller's 400 teaches the cache, not just the main chat route's. The chat route's own copy of this same parse+record block still runs too (recording the same verdict twice is harmless — it just refreshes the TTL) because it's also what emits the SSE `status` event (`phase: 'sampling_param_unsupported'`, `param`) that drives the client UI. Conservative on purpose — false positives would silently strip a sampling knob the model actually accepts.
  - **Every call site benefits automatically, with no wiring.** `resolveEffectiveSamplingParamSupport` in `openaiCompatibleAdapter.ts` prefers a caller-supplied `params.samplingParamSupport` (only the main chat route resolves this explicitly, via the proactive probe) and otherwise falls back to a synchronous cache peek (`peekSamplingParamSupportMap`, no network, no probe) before building the payload. This is what makes the cache apply uniformly regardless of who is calling `sendLlmChat`/`sendLlmChatStream` — sub-agents (`src/tools/impl/subAgentTool.ts`), the prompt-loop judge/critic (`src/services/promptLoop.ts`), compaction, and title generation never resolve or pass `samplingParamSupport` themselves, and don't need to: once ANY call has taught the cache that a model rejects e.g. `temperature`, every subsequent call from every caller silently omits it, without the caller knowing the cache exists.
  - **Adapter integration**: `src/services/adapters/openaiCompatibleAdapter.ts` walks the `SUPPORTED_SAMPLING_PARAMS` registry in `applySupportedSamplingParams`, omits any field marked `'unsupported'` by the effective support map, and uses a `(payload as Record<string, unknown>)[param] = value` cast to project onto the typed outbound payload. Fields absent from the registry or unsupported keep their existing behavior.
  - **Invalidation**: `src/app/api/config/route.ts` calls `invalidateSamplingParamCache(...)` for both the old and new `(baseUrl, model, provider)` triple on model/baseUrl change — same conditions as `invalidateVisionCache`.

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

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
