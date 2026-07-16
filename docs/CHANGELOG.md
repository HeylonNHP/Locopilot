# Changelog

Curated index of notable changes to Locopilot. Newest first. Each entry
captures intent, the files touched, and a short rationale — use git
history for the full diff.

This file replaced the in-`CLAUDE.md` Change History section to keep the
agent-instructions file focused on conventions and architecture, and to
keep the system prompt lean (a 500-line changelog was being loaded on
every turn even though it's only consulted occasionally).

When adding a new entry:

- Date format: `YYYY-MM-DD:` then a one-line title.
- Include `Files:` with the touched paths, then a `Summary:` and
  optional `Intent:` and `Lesson:` bullets.
- Don't include the diff itself — that's what `git log -p` is for.

---

- 2026-07-16: Hardened multi-provider resolution, numCtx, and mount-time provider selection
  - Files: `src/services/providerResolver.ts`, `src/app/api/title/route.ts`, `src/app/api/compact/route.ts`, `src/app/api/config/route.ts`, `src/app/hooks/useDataLoaders.ts`, `src/app/page.tsx`
  - Summary: `resolveProvider` no longer falls back to `providers[0]` when given an explicit but stale `providerId` — it now returns `null` (after trying a model-name recovery) so a stale id can never cross-wire another provider's `apiKey`/`baseUrl` to a request. The synthetic legacy provider now uses a stable constant id (`'legacy'`) instead of slugifying the display name, so the id is deterministic across name changes and cannot collide with a user-authored id. `getProviderNumCtx` falls back to `DEFAULT_NUM_CTX` (131072) instead of a hardcoded 8192, matching the rest of the app. `title` and `compact` routes now (a) prefer the persisted config `baseUrl` over the caller-supplied body `baseUrl` when no provider resolves, matching the chat route's precedence and avoiding sending config's apiKey to an arbitrary host, and (b) resolve numCtx through the active provider's `numCtx` via `getProviderNumCtx` rather than only the global `config.numCtx`. `GET /api/config` passes `config.model` to `resolveProvider` so a stale `activeProviderId` recovers via model match instead of reporting a cap for the wrong (first) provider. `useDataLoaders` replaced the ref-gated, mount-only auto-select in `loadModels` with a reactive reconciler effect (keyed on `state.models`/`state.model`/`state.activeProviderId`) that derives `activeProviderId` from the selected model — fixing migrated legacy configs that had `model` but no `activeProviderId`. `page.tsx` now awaits `loadConfig` before `loadModels` on mount so the reconciler sees the persisted selection first and never briefly adopts a wrong default.
  - Intent: Close credential cross-wiring and wrong-endpoint/wrong-cap paths opened by the multi-provider change, and make active-provider selection deterministic regardless of which mount fetch wins the race.
  - Lesson: When a resolver accepts both an explicit id and a model name, an explicit-but-stale id must not silently degrade to "the first provider"; model-name recovery plus a `null` return is the safe fallback. Loader sequencing and ref-gated auto-selects are brittle on mount — a state-keyed reconciler effect is the robust pattern.

- 2026-07-16: Added multi-provider support so multiple LLM endpoints can coexist
  - Files: `src/types/chatConfig.ts`, `src/services/providerResolver.ts` (new), `src/app/api/chat/route.ts`, `src/app/api/models/route.ts`, `src/app/api/config/route.ts`, `src/app/api/title/route.ts`, `src/app/api/compact/route.ts`, `src/app/lib/chatStore.ts`, `src/app/hooks/useStableRefs.ts`, `src/app/hooks/useDataLoaders.ts`, `src/app/hooks/useChatStream.ts`, `src/app/hooks/useSlashCommands.ts`, `src/components/ModelSelector/ModelSelector.tsx`, `config.json`, `docs/CHANGELOG.md`
  - Summary: Introduced a `providers` array in `config.json` where each entry has its own `id`, `name`, `provider`, `baseUrl`, optional `apiKey`, `model`, and `numCtx`. When `providers` is present, the UI aggregates models from every endpoint and the user selects both a provider and a model per turn. The legacy top-level `provider`/`baseUrl`/`apiKey`/`model` fields remain supported: they are normalized into a single synthetic provider so existing configs continue to work unchanged. The active provider is identified by `activeProviderId` and threaded through the chat, title, and compact routes via a new `providerId` request field. A new `providerResolver.ts` centralizes provider normalization, resolution (by id or model name), and construction of per-request `LlmRequestContext` so concurrent requests with different credentials no longer race on a global axios instance. `ModelSelector.tsx` now groups models by provider and updates `activeProviderId` when a model is picked. Provider-specific context limits and vision support are resolved independently because the cap and vision caches are keyed by `(baseUrl, modelName)`.
  - Intent: Enable setups like an OpenAI-compatible endpoint alongside a local Ollama endpoint, each with independent authentication and defaults, without breaking existing single-provider configurations.
  - Lesson: Multi-provider auth and model state must travel per-request; keeping provider identity only in global config would make concurrent requests with different credentials non-deterministic.

- 2026-07-07: Fixed silent image stripping for the OpenAI-compatible provider
  - Files: `src/services/visionCache.ts` (new), `src/services/llmContextLimit.ts`, `src/services/llm.ts`, `src/app/api/chat/route.ts`, `src/app/api/config/route.ts`, `src/app/api/models/route.ts`, `src/types/sse.ts`, `src/app/lib/chatStore.ts`, `src/app/hooks/useChatStream.ts`, `src/app/hooks/useDataLoaders.ts`, `src/components/InputArea/InputArea.tsx`, `src/components/ChatInput/ChatInput.tsx`, `src/components/ChatInput/ChatInput.scss`, `scripts/test-vision-cache.mjs` (new), `CLAUDE.md`, `docs/CHANGELOG.md`
  - Summary: Added a per-`(baseUrl, modelName)` vision-capability cache (mirrors `capResolver.ts` line-for-line: NUL-separated key, 5-minute TTL, `invalidateVisionCache(baseUrl?, modelName?)` invalidation API) so the openai-compatible provider stops silently stripping image attachments from outgoing chat requests. The legacy sync `getLlmModelVisionSupport(info)` heuristic returned `false` for every openai-compatible model because `/v1/models` has no standard `capabilities` field, and the OpenAI adapter's `buildChatPayload` then called `stripImagesFromMessages` to remove the `images` field before the LLM ever saw the request. The new async `getLlmModelVisionSupportAsync(baseUrl, modelName, provider, info)` consults the cache and falls through to provider-specific defaults: openai-compatible assumes `'supported'` (optimistic — most modern endpoints accept images; a 400 from a non-vision endpoint is captured by the reactive 400 path below), ollama assumes `'unsupported'` (preserves the pre-fix behaviour because `/api/show` exposes `capabilities` for vision models and the absence of `vision` is a real signal). The chat route's 400 catch block now also calls `parseVisionUnsupportedFromError` (a new matcher in `llmContextLimit.ts` covering six conservative patterns) and, on a match, calls `recordDiscoveredNonVision(baseUrl, model)` and emits an SSE `status` event with `phase: 'vision_unsupported'`. The client reads this phase and dispatches a new `SET_VISION_STATE` action to update `ChatState.visionState`, which `ChatInput.tsx` uses to render an inline amber `⚠` warning when the user attaches an image to a known non-vision model and a softer `ℹ` "unconfirmed" hint for the `unknown` + openai-compatible case. The `/api/models` projection merges the vision-cache state into each model's `capabilities` array so the `Vision` badge in the `ModelSelector` reflects the cache (and disappears once a 400-driven `'unsupported'` entry is recorded). `invalidateVisionCache` is wired into `PUT /api/config` on model/baseUrl change, mirroring the existing `invalidateCapCache` calls. A new `scripts/test-vision-cache.mjs` (49 cases, mirrors the `scripts/test-numctx.mjs` pattern) covers the full surface.
  - Intent: Image attachments were being silently dropped from outgoing OpenAI-compatible requests — the user saw the thumbnail in their own bubble but the LLM received text only, with no warning, no error, and no recovery prompt. The hybrid default-yes + reactive-cache approach matches the actual landscape (most modern OpenAI-compatible endpoints accept images; providers that don't tell us so via 400) and avoids the "first request always fails" problem that a probe-based fix would have introduced. The cache is the single backend source of truth for vision support; the legacy sync heuristic is kept for the `/api/models` projection so non-async callers don't have to thread `baseUrl` and `provider` through.
  - Lesson: Capability detection on top of `/v1/models` needs an optimistic default, not a deny-by-default. The OpenAI spec has no `capabilities` field, so treating "unknown" as "unsupported" is the same bug as a missing feature. Same fix shape as `capResolver.ts` — proactive probe with optimistic default, reactive 400 discovery, cache invalidation on config change. The 400-message regexes are intentionally conservative (must match a phrase that explicitly mentions image/vision) because a false positive would silently strip from a model that actually supports images — a strict superset of the original bug.

- 2026-07-05: Fixed model cap discovery to respect user's numCtx (Ollama auto-resize)
  - Files: `src/services/capResolver.ts`, `src/services/llmContextLimit.ts`, `src/app/api/chat/route.ts`, `src/app/api/config/route.ts`, `src/app/hooks/useDataLoaders.ts`, `src/services/history.ts`, `src/components/StatusBar/StatusBar.tsx`, `src/components/StatusBar/StatusBar.scss`, `scripts/test-numctx.mjs` (new), `scripts/verify-numctx.mjs`, `package.json`, `CLAUDE.md`, `docs/CHANGELOG.md`
  - Summary: Three changes that together fix a class of bug where the user's `requestedNumCtx` was silently clamped to a much smaller value.
    (1) **Static probe is now authoritative** for the model cap. `getModelContextLimitFromInfo` scans `info.parameters` / `info.modelfile` for `num_ctx N` FIRST (capturing RoPE-scaled Modelfile overrides), then falls back to the structured walk over `model_info.<arch>.context_length`. The runtime probe (`/api/ps`) is now telemetry-only — the runner's transient KV-cache state is no longer treated as the cap. The cap resolver runs the static probe first; the runtime probe only matters when the static probe is unavailable.
    (2) **Ollama auto-resize**: Ollama's scheduler evicts the old runner and starts a new one with the requested `num_ctx` when a chat request asks for a larger context than the runner is currently allocated. So Locopilot no longer needs to "warn the user to restart Ollama" — sending the user's `requestedNumCtx` in the request body is sufficient. The user's 1M request is honored (clamped to the model's true max, e.g. 262144 for a Qwen3 35B base GGUF) without any manual `--num-ctx` flag.
    (3) **Stopped poisoning `sessions.num_ctx`**: the chat route's 400 catch block no longer writes the discovered cap to the session row. The column became a permanent poison pill (no path could null it out). The in-memory cap cache and the SSE `status` event are sufficient for runtime behaviour; `useDataLoaders.ts` no longer reads the column for the displayed tokenLimit.
  - Also: exposed `invalidateCapCache(baseUrl?, modelName?)` for explicit cache eviction on model change, baseUrl change, or `numCtx` change in Settings. Added a `(model max: N)` label in the status bar when the resolved cap is below the user's requested value. Added `tsx` as a devDependency to support the new `scripts/test-numctx.mjs` unit-test harness (35 tests, no network, no live server).
  - Intent: Make the user's `numCtx` setting the source of truth for the chat request. Today, the cap resolver trusts the runtime probe and clamps the user's request down to whatever `/api/ps` reports — which is Ollama's default 4096 for a default-loaded 35B model, not the model's actual capability. After this change, the cap is the GGUF training context (or the Modelfile's RoPE override), and the user's request is sent verbatim.
  - Lesson: `capResolver.ts` had the static and runtime probes in the wrong order for Ollama. The runtime probe is a useful UI hint (it tells us the runner's current state) but it's not the cap. The right model is "max of probes, where the static probe is the upper bound and the runtime probe is the lower bound."

- 2026-06-24: Corrected App Router error-handling conventions (pre-existing Next.js 15.5 build bug remains)
  - Files: `src/app/not-found.tsx` (new), `src/app/error.tsx`, `.github/copilot-instructions.md`
  - Summary: Added `src/app/not-found.tsx` and removed `<html>`/`<body>` from `src/app/error.tsx` to follow correct App Router conventions. However, the underlying `npm run build` failure (`<Html> should not be imported outside of pages/_document` during prerendering of `/404` and `/500`) is a known Next.js 15.5 upstream bug (vercel/next.js#90349) that cannot be cleanly worked around without triggering a separate validator bug. `tsc --noEmit` and `npm run dev` are unaffected.
  - Intent: Follow correct App Router conventions while documenting the upstream bug so it is not re-investigated.

- 2026-06-24: Canonical `maxOutputTokens` output-token cap across adapters
  - Files: `services/adapters/llmAdapter.ts`, `services/adapters/ollamaAdapter.ts`, `services/adapters/openaiCompatibleAdapter.ts`, `services/compact.ts`, `tools/impl/contentCompactor.ts`, `OPENAI_COMPATIBILITY_MIGRATION.md`, `.github/copilot-instructions.md`
  - Summary: Added a provider-agnostic `maxOutputTokens` field to `ChatParams` / `StreamChatParams`. The Ollama adapter maps it to `options.num_predict`; the OpenAI-compatible adapter maps it to `max_completion_tokens`. Migrated all internal callers that were capping output tokens (`measureConversationTokens`, tool distillation, conversation summary streaming, web content compaction) from `options.num_predict` to the canonical field. Legacy `options.num_predict` / `options.max_tokens` / `options.max_completion_tokens` remain as fallback-only passthroughs. The web content compactor still hard-truncates its final result to the configured per-page character limit as a safety net.
  - Intent: Fix the bug where OpenAI-compatible endpoints ignored the requested output-token cap during compaction/summarization because `num_predict` is an Ollama-specific option. By centralizing the translation inside the adapters, callers stay provider-agnostic and future adapters only need to implement the mapping once.

- 2026-06-20: Decoupled working-directory tracking from ToolOutputSink
  - Files: `tools/workingDirectory.ts`, `tools/toolRegistry.ts`, `tools/impl/writeFileTool.ts`, `tools/impl/readFileTool.ts`, `tools/impl/patchFileTool.ts`, `tools/impl/readPdfTool.ts`, `tools/impl/runCommandTool.ts`, `tools/impl/subAgentTool.ts`, `app/api/chat/route.ts`, `.github/copilot-instructions.md`
  - Summary: Created a dedicated `WorkingDirectoryScope` class as a lightweight identity token for the `WeakMap<WorkingDirectoryScope, string>` in `workingDirectory.ts`, replacing the previous pattern of using `ToolOutputSink` objects as map keys. Added `workingDirectoryScope?: WorkingDirectoryScope` to `RequestContext`. The web chat route now creates one `WorkingDirectoryScope` per HTTP request and threads it through `RequestContext`, so `run_command`'s `cd` tracking persists across all tool calls within a request (previously broken because fresh `ToolOutputSink` objects were created per tool call, making WeakMap entries ephemeral). Sub-agents create their own `WorkingDirectoryScope` in `runSingleAgent` for isolation. Tool classes updated: `WriteFileTool` no longer accepts `output` (it never wrote to it); `ReadFileTool`, `PatchFileTool`, `ReadPdfTool` now accept both `output` (for logging) and `scope` (for path resolution); `runCommand` accepts `scope` as a new parameter for working-directory operations while keeping `output` for UI messages. Removed the dead `SET_STREAMING` action and orphaned `isStreaming` field cleanup was done in the previous commit.
  - Intent: Separate the output-channel concern from the working-directory-identity concern, fix the broken per-request working-directory tracking in the web route, and make tool constructor dependencies honest.

- 2026-06-18: Fixed three compaction status-update bugs
  - Files: `app/api/compact/route.ts`, `app/hooks/useSlashCommands.ts`, `app/hooks/useChatStream.ts`, `app/lib/chatStore.ts`, `.github/copilot-instructions.md`
  - Bug 1 (manual /compact progress thrown away): Converted `/api/compact` from a plain JSON response to an SSE stream. The server now emits `compact_progress` events live via the `onProgress` callback, followed by a `compact` event with the result. Updated `useSlashCommands.ts` to parse the SSE stream with `EventSourceParserStream` and dispatch `COMPACT_PROGRESS` events as they arrive, so the `InputArea` streaming indicator shows live progress during manual `/compact`.
  - Bug 2 (auto-compact label gets stuck): Added `dispatch({ type: 'CLEAR_COMPACT_PROGRESS' })` at the top of the `compact` event handler in `useChatStream.ts`, so the streaming indicator switches back to "Streaming..." as soon as compaction finishes and the model resumes generating.
  - Bug 3 (compaction phases leak across streams/sessions): Updated the `STOP_STREAMING` reducer case in `chatStore.ts` to clear `compactingPhases` when the visible session's stream ends. Guarded with `isVisibleSession` check to avoid clearing phases during the `session_created` placeholder migration (-1 → realId) or when a non-current background session stops. Removed the dead `SET_STREAMING` action type, reducer case, and the orphaned `isStreaming` field from `ChatState` / initial state — these were never dispatched and were leftover from the CLI-to-web-UI migration.
  - Intent: Ensure compaction progress updates reliably reach the UI for both manual and auto-compaction, and that stale progress text doesn't linger after a stream ends.

- 2026-06-18: Added compaction model selector to the status bar
  - Files: `components/StatusBar/StatusBar.tsx`, `components/StatusBar/StatusBar.scss`, `components/ModelSelector/ModelSelector.tsx`, `.github/copilot-instructions.md`
  - Summary: Extended `ModelSelector` with an optional `mode` prop (`'model'` | `'compaction'`). In compaction mode it dispatches `SET_CONFIG { compactionModel: modelName }`, persists via `PUT /api/config`, skips the model-info / context-limit fetch, and shows a "Same as main model" option at the top of the list. Added a second clickable label to `StatusBar` displaying `Compaction: {compactionModel || 'Same as main'}`, plus the corresponding open/close state, ref, keyboard activation, and hover styling. The main model selector continues to behave exactly as before.
  - Intent: Let users quickly view and swap the compaction model from the status bar without opening the full Settings modal, matching the convenience of the main model selector.

- 2026-06-18: Removed dead interrupt-manager code and orphaned aiResponseRenderer
  - Files: `src/tools/interruptManager.ts` (deleted), `src/aiResponseRenderer.ts` (deleted), `src/tools/tools.ts`, `src/tools/impl/runCommandTool.ts`, `src/tools/impl/subAgentTool.ts`, `src/services/chatSession.ts`, `.github/copilot-instructions.md`
  - Summary: Removed the `interruptManager.ts` module entirely — `requestInterrupt()` and `clearInterrupt()` had zero callers, and the handler registry (`registerInterruptHandler`/`unregisterInterruptHandler`/`isInterruptRequested`) was dormant because nothing ever set the interrupt flag. The web UI's actual interrupt path is the HTTP `AbortSignal` (`req.signal`), which is already threaded through `handleToolCall` and `spawn()` separately. Removed the orphaned `aiResponseRenderer.ts` (nothing imported it). Updated `runCommandTool.ts` (removed dead interrupt-handler registration), `subAgentTool.ts` (simplified `isInterruptOrAbort` to only check the signal), `chatSession.ts` (removed dead `isInterruptRequested` checks in the CLI-only `processAITurn`), and `tools.ts` (removed the 5 re-exports from the deleted module).
  - Intent: Clean up dead code left behind by the CLI-to-web-UI migration. The interrupt manager's trigger side was replaced by the HTTP AbortSignal, but the old module and its dormant callers were never removed.

- 2026-06-18: Fixed web UI auto-scroll behavior during fast LLM streaming
  - Files: `app/hooks/useScrollManager.ts`, `app/page.tsx`, `.github/copilot-instructions.md`
  - Summary: Replaced the `IntersectionObserver`-based bottom detection in `useScrollManager` with a synchronous scroll listener throttled by `requestAnimationFrame`. The "at bottom" threshold is now computed from the container's actual bottom `padding-bottom` (which expands to `96px` when the floating "Latest" button is visible) plus a `32px` buffer, instead of a hard-coded `32px`. This fixes the bug where the button's own padding pushed the sentinel outside the observer margin, preventing auto-scroll from re-engaging once the user scrolled back to the bottom. The hook also now accepts an `isStreaming` flag from `page.tsx`; while streaming, it scrolls with `behavior: 'auto'` so rapid chunks don't queue up conflicting smooth animations, and falls back to `behavior: 'smooth'` when not streaming. Manual scroll-up still pauses auto-follow, and scrolling back to the bottom resumes it.
  - Intent: Keep the latest LLM output in view during fast streaming while preserving the user's ability to scroll up and read past content, and ensure the scroll-to-latest button reliably re-anchors the view.

- 2026-06-06: Prompt loop completion mode
  - Files: `services/promptLoop.ts` (new), `components/CompletionModeSelector/` (new — `index.ts`, `CompletionModeSelector.tsx`, `CompletionModeSelector.scss`), `types/chatConfig.ts`, `app/lib/chatStore.ts`, `app/hooks/useStableRefs.ts`, `app/hooks/useDataLoaders.ts`, `app/hooks/useChatStream.ts`, `app/api/config/route.ts`, `app/api/chat/route.ts`, `components/StatusBar/StatusBar.tsx`, `components/StatusBar/StatusBar.scss`, `.github/copilot-instructions.md`
  - Summary: Added a "Completion mode" dropdown to the status bar (next to the Model selector) with two options: **Normal** (default, existing behavior) and **Prompt loop** (auto-continue until the task is done). When Prompt loop is active, after the LLM produces a non-tool-call final response, a lightweight judge call asks the same model "is the user's request fully satisfied?" If no, a continuation nudge ("Continue working on my original request. It is not yet complete.") is injected into the conversation history and the outer LLM loop is re-entered. The loop is capped by a user-configurable `maxPromptLoopIterations` setting (0 = unlimited, default 4), exposed as a number input inside the CompletionModeSelector dropdown when "Prompt loop" is selected. The judge helper (`services/promptLoop.ts`) is modeled on `errorSummary.ts` — short behavior-only system prompt, non-streaming `sendLlmChat` call, fail-open on parse errors (defaults to satisfied), and uses the spread pattern `...(signal ? { signal } : {})` to satisfy `exactOptionalPropertyTypes: true`. The outer `while (true)` tool-calling loop in `chat/route.ts` is now labeled `outer:` so the prompt-loop continuation can `continue outer;` from within the nested judge loop. A new SSE `status` event with `phase: 'completeness-check'` carries the current iteration and max so the client can show progress. The two new config fields (`completionMode`, `maxPromptLoopIterations`) are persisted to `config.json` via the existing `PUT /api/config` endpoint and threaded through the full state pipeline: `ChatState` → `useStableRefs` → `useChatStream` request body → `chat/route.ts` parsing. The CompletionModeSelector component mirrors the ModelSelector pattern (controlled popup, anchorRef positioning, outside-click/Escape close, identical SCSS tokens).
  - Intent: Solve the "small model stops before finishing" problem (e.g. qwen3.6 35B) without requiring the user to manually type "continue". The previous done-reason work was a prerequisite; this is the feature itself.

- 2026-06-06: Done-reason aware finality detection
  - Files: `app/api/chat/route.ts`, `app/lib/chatStore.ts`, `app/hooks/useChatStream.ts`, `.github/copilot-instructions.md`
  - Summary: The chat route now captures `chunk.done_reason` on the terminal SSE chunk (Ollama values: `stop`, `length`, `load`, `unload`) and uses it to interpret what happened at end-of-stream. The terminal-chunk branch in `route.ts` was previously "no `tool_calls` = final response" with no awareness of the underlying stop reason. New behavior: `load`/`unload` are server heartbeats and are ignored (the outer loop continues); `length` indicates the model hit `num_predict` (output token cap) and the response was truncated — the route emits a `status` SSE event with `phase: 'truncated'` so the client can react; `stop` (or missing) is a natural end-of-sequence and is treated as the final response. The reason field augments the existing content-based tool-call check; it never replaces it (some local providers like LM Studio and older llama.cpp have shipped bugs where `done_reason: "stop"` is set even when `tool_calls` is populated). The new `doneReason` is also emitted on the existing `done` SSE event's payload (defaulting to `'stop'` when the field is missing, for backward compatibility with older Ollama versions). On the client, a new `SET_DONE_REASON` action stores it on both the top-level `ChatState` and per-session `SessionState` so the UI can surface a truncation hint in a future change. The `useChatStream` `done` handler defensively validates the server-side value against the new `DoneReason` union (`'stop' | 'length' | 'load' | 'unload' | 'unknown'`) before dispatching. The `lastDoneReason` local in `route.ts` is reset on each retry attempt so a successful retry never inherits a failed attempt's value. `SessionState` literals throughout `chatStore.ts` (initial state, `SHOW_APPROVAL`, `INIT_SESSION`, `SAVE_ACTIVE_SESSION`, `SET_CURRENT_SESSION` snapshot/restore, `RESTORE_SESSION`) all carry the new optional field for type-safety under `exactOptionalPropertyTypes: true`.
  - Intent: Lay the groundwork for the planned `Prompt loop` feature (which asks an LLM judge whether the user's request is satisfied after a turn completes) and immediately fix a real existing bug: today, a `num_predict` truncation looks identical to a natural end-of-sequence to both the user and the rest of the code. With `done_reason` captured, the UI can show "Response was cut off" hints, and a future prompt-loop judge can tailor its continuation nudge ("your last response was truncated at the token limit — finish it" vs the generic "is the request satisfied?" judge). This is shipped as a prerequisite milestone: observe whether it alone resolves the "small models stop before finishing" issue before deciding whether the `Prompt loop` is still needed.
  - Lesson: `exactOptionalPropertyTypes: true` in `tsconfig.json` means an optional field typed as `field?: T` does NOT accept explicit `undefined`; the assignment must use the `field?: T | undefined` form. The first typecheck pass failed with ~15 errors before the type was widened.

- 2026-06-02: Added "Copy markdown" action button to assistant chat bubbles
  - Files: `components/ChatMessageBubble/ChatMessageBubble.tsx`, `components/ChatMessageBubble/ChatMessageBubble.scss`
  - Summary: Added a small hover-revealed button in the top-right corner of every assistant (`role: 'assistant'`) message bubble. Clicking it copies the bubble's raw markdown source (`message.content` — the verbatim streamed text held in the chat store) to the clipboard, using the same `navigator.clipboard.writeText` + `document.execCommand('copy')` fallback pattern already used by the per-`<pre>` code-block copy button in `MarkdownMessage.tsx`. The button label flips to `Copied!` with an inline checkmark SVG for 1500 ms after a successful copy, then reverts. The button is rendered in the React tree (not via DOM mutation), disabled while the bubble has no content, and uses the existing `--code-copy-bg` / `--code-copy-hover-bg` / `--code-copy-active-bg` / `--accent` / `--text-secondary` / `--glass-border-soft` variables — so it picks up both light and dark themes for free. The hover-reveal uses `opacity: 0 → 0.85` on `.bubble-ai-wrap:hover` and `.bubble-ai-wrap:focus-within` so keyboard users get the same affordance. The `.bubble-ai-wrap` was given `position: relative` (one-line SCSS change) to anchor the absolutely-positioned button. A cleanup `useEffect` clears the `Copied!` timeout if the bubble unmounts mid-flash.
  - Intent: Give users a one-click way to copy the raw markdown of an AI reply (e.g. to paste into a doc, ticket, or external editor) without having to select-and-copy around rendered formatting. Mirrors the existing per-`<pre>` copy button UX so the action feels native to the design, and reuses the only existing clipboard pattern in the codebase to stay consistent.

- 2026-06-01: Added `/clear-images` slash command
  - Files: `app/hooks/useSlashCommands.ts`, `app/api/clear-images/route.ts` (new), `components/ChatInput/ChatInput.tsx`, `.github/copilot-instructions.md`
  - Summary: Added a new `/clear-images` slash command and a `POST /api/clear-images` endpoint. The handler strips `images` from every message in the active session, dispatches `SET_MESSAGES` with the cleaned list, and asks the server to persist the change via `updateSessionMessages`. Reports the number of images removed and the approximate token budget freed (1,024 tokens per image, matching `IMAGE_TOKEN_ESTIMATE` in `constants.ts`).
  - Intent: Provide a panic-button recovery for WebUI sessions that have attached too many images and started failing with vision context errors, complementing `/compact` (which only summarises text) and `/new` (which discards everything).
  - Lesson: The slash-command autocomplete dropdown is driven by a hard-coded `COMMANDS` array in `components/ChatInput/ChatInput.tsx` (outside `app/`), NOT by anything in `app/hooks/useSlashCommands.ts`. When adding a new slash command, that array must be updated in addition to the dispatcher and `/help` text — otherwise the command works when typed manually but doesn't appear in the dropdown.

- 2026-05-18: Moved markdown bubble sanitization to client-only loading
  - Files: `components/ChatMessageBubble.tsx`
  - Summary: Loaded `MarkdownMessage` with `next/dynamic({ ssr: false })` so the server bundle no longer initializes `isomorphic-dompurify`/`jsdom` during the initial page render.
  - Intent: Keep markdown rendering and sanitization intact while preventing SSR from touching the browser-only sanitizer stack.

- 2026-05-10: Threaded AbortSignal through all tool implementations
  - Files: `tools/impl/runCommandTool.ts`, `tools/impl/fetchUrlTool.ts`, `tools/impl/fetchImageTool.ts`, `tools/impl/webSearchTool.ts`, `tools/impl/readFileTool.ts`, `tools/impl/writeFileTool.ts`, `tools/impl/patchFileTool.ts`, `tools/impl/subAgentTool.ts`, `tools/web/htmlExtractor.ts`
  - Summary: Commit `3cde6fb` threaded `signal?: AbortSignal` through all tool `run()`/`execute()` signatures but never passed it to the underlying async operations — meaning abort signals from the HTTP layer were completely ineffective for cancelling file I/O, HTTP fetches, and sub-agent LLM calls. Every affected tool now passes the signal to its underlying operations: `spawn()` (via `signal` option), `stdin.write()` (via abort guard), `waitForProcessSnapshot`/`checkProcessOutput`, `axios` calls, `readFile`/`writeFile`/`stat`/`mkdir`/`appendFile`, Playwright `goto`/`waitForLoadState`/`newContext`, and `sendLlmChat`. File-system and Playwright calls use `as any` type assertions to bypass stale TypeScript lib definitions that predate `AbortSignal` support.
  - Intent: Ensure per-request abort signals can actually cancel long-running tool operations (file reads, command execution, web fetches, sub-agent LLM calls) when the client disconnects or the request is cancelled.

- 2026-05-04: Fixed "invalid role: subagent_log" 400 error during compaction
  - Files: `app/api/chat/route.ts`, `app/api/compact/route.ts`, `.github/copilot-instructions.md`
  - Summary: `subagent_log` is a client-only UI role used in `chatStore.ts` to render sub-agent output bubbles. Ollama does not recognise this role and returns a 400 when it appears in a `/compact` message list. Both `chat/route.ts` and `compact/route.ts` now filter out `subagent_log` messages alongside `system` messages when building the server-side history for LLM calls and compaction.
  - Intent: Prevent compact calls from failing with an opaque 400 error when a sub-agent has run in the current session.

- 2026-05-01: Enabled web UI `/dump` markdown downloads
  - Files: `app/api/dump/route.ts` (new), `app/hooks/useSlashCommands.ts`, `services/historyDump.ts`, `WEBUI_MIGRATION.md`
  - Summary: Added a dedicated dump endpoint that rebuilds the existing conversation export markdown on the web server, returns it as a markdown attachment, and wired the slash command to fetch the response and trigger a browser download of the generated `.md` file.
  - Intent: Bring `/dump` to parity with the CLI while keeping the web flow local and download-based.

- 2026-05-01: Fixed web UI assistant-turn boundaries after tool results
  - Files: `app/lib/chatStore.ts`, `app/hooks/useChatStream.ts`, `app/hooks/useSlashCommands.ts`, `app/page.tsx`, `WEBUI_MIGRATION.md`, `.github/copilot-instructions.md`
  - Summary: Replaced the `needsNewAssistantRef` heuristic with a reducer-driven assistant-delta action that creates an assistant message on demand when `thinking` or `chunk` events arrive after tool/system messages. Removed the placeholder assistant insert and the stale flag plumbing from the page and slash-command hooks.
  - Intent: Make streamed post-tool reasoning/content attach to the correct assistant turn without depending on fragile event-order heuristics.

- 2026-05-01: Added empty-response recovery for the web chat route
  - Files: `app/api/chat/route.ts`, `services/textUtils.ts`, `WEBUI_MIGRATION.md`, `.github/copilot-instructions.md`
  - Summary: The web SSE route now strips leaked channel/control markers from streamed assistant text and retries up to three times when a non-tool turn ends without meaningful answer content.
  - Intent: Prevent web sessions from stalling on reasoning-only or marker-only assistant output and bring final-answer recovery closer to the CLI behavior.

- 2026-04-30: Fixed multi-line SSE parsing in the web client
  - Files: `app/hooks/useChatStream.ts`, `WEBUI_MIGRATION.md`, `.github/copilot-instructions.md`
  - Summary: Updated the manual fetch-stream parser to accumulate repeated `data:` lines for one SSE event, join them with newlines per the SSE spec, and flush any buffered trailing event when the stream ends.
  - Intent: Prevent truncated or invalid event payloads when the server emits multi-line SSE data and keep the migration notes aligned with the actual parser behavior.

- 2026-04-30: Fixed web UI session highlight race during sidebar switches
  - Files: `app/page.tsx`, `.github/copilot-instructions.md`
  - Summary: `loadSessionMessages()` now marks the clicked session as current before the fetch resolves and tracks a monotonically increasing request id so older `/api/sessions/:id` responses cannot overwrite a newer selection.
  - Intent: Remove timing-dependent sidebar highlight glitches and stale session re-selection when different browsers return session loads in a different order.

- 2026-04-30: Added web UI `/nudge` slash command implementation
  - Files: `app/page.tsx`, `services/toolUseNudge.ts` (new), `tools/tools.ts`, `WEBUI_MIGRATION.md`
  - Summary: Extracted the manual tool-use reminder text into a shared helper so both CLI and web use the same nudge content. Wired the web UI `/nudge` slash command to inject that reminder as a user message and immediately continue through the normal chat SSE request path instead of showing a stub.
  - Intent: Bring manual AI nudging in the web UI to parity with the CLI flow without maintaining two divergent reminder strings.

- 2026-04-30: Added web UI `/title` slash command implementation
  - Files: `app/api/title/route.ts` (new), `app/page.tsx`, `WEBUI_MIGRATION.md`
  - Summary: Added a dedicated `POST /api/title` endpoint that resolves the effective base URL, context length, and compaction model, runs `generateSessionTitle()`, renames the active session in SQLite, and returns the new title. Wired the web UI `/title` slash command to call this endpoint, refresh the sidebar session list, and show immediate pending feedback while the title request is in flight.
  - Intent: Bring manual session title generation in the web UI to parity with the CLI flow instead of leaving `/title` as a stub.

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

(End of historical change log entries — entries above were preserved verbatim from the previous in-`CLAUDE.md` Change History section.)

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

- 2026-05-02: Removed global mutable state from toolRegistry.ts for multi-WebUI concurrency
  - Files: `tools/toolRegistry.ts`, `tools/tools.ts`, `tools/impl/runCommandTool.ts`, `tools/impl/subAgentTool.ts`, `app/api/chat/route.ts`, `services/chatSession.ts`, `services/configManager.ts`, `services/sessionManager.ts`, `slashCommands.ts`, `.github/copilot-instructions.md`
  - Summary: Replaced three module-level `let` globals (`isYoloMode`, `webSearchSettings`, `subAgentConfig`) with a per-request `RequestContext` interface that is threaded through `handleToolCall()` → `IToolCommand.execute()` → tool implementations. Removed all setter/getter functions (`setYoloMode`, `setWebSearchConfig`, `setSubAgentConfig`, `isYolo`, `getSubAgentConfig`). The web SSE route creates a fresh `RequestContext` per HTTP request and passes it to every tool call, eliminating cross-talk between concurrent requests. The CLI path supplies context from the live config/session state. Also added a per-session write queue in `route.ts` that serializes synchronous `updateSessionMessages()` calls so concurrent requests to the same session do not overwrite each other.
  - Intent: Enable multiple WebUI browser tabs to talk to Locopilot simultaneously without config corruption, YOLO-mode cross-talk, or session data loss.

- 2026-05-02: Atomic config saves with write queue for concurrent settings
  - Files: `services/configManager.ts`, `app/api/config/route.ts`, `.github/copilot-instructions.md`
  - Summary: Replaced direct `writeFile` in `saveConfig()` with an atomic write pattern (write to `config.json.tmp` then `rename`) wrapped in a promise-chain queue so concurrent saves from multiple browser tabs are serialised. Removed the duplicate inline `saveConfig`/`loadConfig` from the API route; it now imports the shared atomic version from `configManager`. Prevents silent data loss when two tabs open Settings simultaneously and save different fields.
  - Intent: Eliminate read-modify-write race on `config.json` when concurrent PUT /api/config requests arrive.

- 2026-05-02: Null output sink for web-triggered tool calls
  - Files: `app/api/chat/route.ts`, `.github/copilot-instructions.md`
  - Summary: Added a `nullOutputSink` (silently discards all write/inline/clear calls) and passes it instead of `undefined` to the fallback `handleToolCall` branch. Previously the web route passed `undefined` for `run_command`, `read_file`, `patch_file`, and `write_file` tools, causing `handleToolCall` to default to `terminalToolOutputSink` which wrote ANSI-coloured output to the server's `stdout`. The web SSE streams remain unaffected since they receive dedicated per-request sinks.
  - Intent: Prevent interleaved terminal output in server logs when multiple browser tabs trigger command/file tools simultaneously.

- 2026-05-02: Per-request process registry isolation via AsyncLocalStorage
  - Files: `tools/impl/runCommandTool.ts`, `app/api/chat/route.ts`, `.github/copilot-instructions.md`
  - Summary: Replaced the module-level singleton `processRegistry` Map and `nextProcessId` counter with an `AsyncLocalStorage`-scoped per-request state. Each HTTP request now gets its own isolated `Map<number, ProcessEntry>` and ID counter, preventing cross-request data leakage if one tab's LLM discovers another tab's process ID. The CLI path falls back to a global registry for compatibility. Added `enterRequestScope()` which the web SSE route calls at the start of every streaming response.
  - Intent: Prevent concurrent browser tabs from reading each other's running-command stdout/stderr via `check_process_output`.

- 2026-05-02: Shared session write queue for /api/compact route
  - Files: `app/lib/sessionWriteQueue.ts` (new), `app/api/chat/route.ts`, `app/api/compact/route.ts`, `.github/copilot-instructions.md`
  - Summary: Extracted the per-session write queue logic from `chat/route.ts` into a shared `app/lib/sessionWriteQueue.ts` module. Both the chat SSE route and the `/api/compact` route now import `enqueueSessionWrite()` from the same shared queue, ensuring concurrent compaction and chat-turn saves for the same session ID are serialised.
  - Intent: Prevent a manual `/compact` from a second browser tab clobbering an auto-compaction or chat-turn save from the first tab.

- 2026-05-02: Scoped content compactor debug data to append-only log
  - Files: `tools/impl/contentCompactor.ts`, `.github/copilot-instructions.md`
  - Summary: Replaced the module-level `let lastWebCompactionDebug: string[]` with an append-only `webCompactionDebugLog: WebCompactionDebugEntry[]` (max 10 entries). Concurrent compaction operations each push their own entry with a unique ID and timestamp instead of overwriting a single variable. `getLastWebCompactionDebug()` returns the most recently completed entry's lines.
  - Intent: Prevent stale or cross-request debug data in conversation dumps when multiple browser tabs trigger web content compaction simultaneously.

- 2026-05-02: Documented activeAdapter concurrency limitation
  - Files: `services/llm.ts`, `.github/copilot-instructions.md`
  - Summary: Added JSDoc comments to `activeAdapter` and `setLlmAdapter()` documenting that the adapter is a module-level singleton and should only be swapped when no HTTP requests are in-flight, as in-flight requests would see the new adapter mid-stream.
  - Intent: Make the concurrency contract explicit for future developers who might add runtime adapter switching.

- 2026-05-02: Live compaction progress streaming to web UI
  - Files: `app/api/chat/route.ts`, `app/api/compact/route.ts`, `app/lib/chatStore.ts`, `app/hooks/useChatStream.ts`, `app/hooks/useSlashCommands.ts`, `app/page.tsx`, `.github/copilot-instructions.md`
  - Summary: Wired compaction progress through to the web UI. The chat SSE route now passes an `onProgress` callback to `compactHistory()` that emits `compact_progress` SSE events with real-time phase updates ("Measuring conversation tokens...", "Preparing compaction: summarizing N messages...", "Distilling tool output...", "AI is summarizing...", retry notifications). The `/compact` JSON endpoint collects phases and includes them in its response. On the client side, `chatStore.ts` gained `compactingPhases` state with `COMPACT_PROGRESS`/`CLEAR_COMPACT_PROGRESS` actions; `useChatStream.ts` handles `compact_progress` events; `useSlashCommands.ts` shows rich stats with locale-formatted token counts and reduction percentages; and `page.tsx` displays the current phase live in the input-area indicator for both auto-compaction (during streaming) and manual `/compact`.
  - Intent: Give users real-time visibility into compaction progress rather than staring at a static "Compacting..." message while it runs.

- 2026-05-20: Removed hard 10 MB size limit from `fetch_image` tool
  - Files: `tools/impl/fetchImageTool.ts`, `.github/copilot-instructions.md`
  - Summary: Removed the `MAX_IMAGE_BYTES` constant and all size enforcement — the explicit `buffer.length > MAX_IMAGE_BYTES` checks in both `fetchRemoteImage` and `fetchLocalImage`, plus the Axios `maxContentLength` option. Removed the size limit mention from the tool schema description. Increased `DEFAULT_TIMEOUT_MS` from 15s to 60s to accommodate larger downloads. The tool's existing error handling (the `catch` block in `run()` that wraps all failures into structured `error:` content) already provides graceful failure handling: if Ollama's vision model rejects an oversized image due to resolution limits, memory exhaustion, or timeouts, the error surfaces cleanly to the model as a tool result error line rather than a hard tool crash.
  - Intent: Remove the artificial 10 MB gate so the tool can handle any image the user provides. Ollama itself has no hard size limit — it passes image bytes raw to the model runner. Any practical limits (model resolution caps, OOM, inference timeouts) are model/backend concerns, and the tool already handles those failures gracefully via its existing error-to-content pattern.
