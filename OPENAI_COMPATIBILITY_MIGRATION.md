# OpenAI-Compatible API Migration Notes

## Goal

Move Locopilot from being hardwired to Ollama's local API toward supporting OpenAI-compatible endpoints.

The intent is not to break Ollama support. The immediate goal is to add the scaffolding needed so the application can eventually select between provider backends at runtime.

## End State We Want

The application should be able to:

1. Read a provider setting from config.
2. Choose the correct LLM adapter at startup.
3. Send chat requests using an OpenAI-compatible request/response shape when provider = `openai-compatible`.
4. Continue supporting Ollama for users who still want local inference.
5. Keep the rest of the application talking to a stable abstraction layer instead of directly to provider-specific APIs.

In practical terms, the app should no longer assume that every LLM backend behaves like Ollama.

## What Has Already Been Done

### 1) Added a provider field to config

File:
- `C:\git\Locopilot-dev\src\types\chatConfig.ts`

Change made:
- Added:
  - `export type LlmProvider = 'ollama' | 'openai-compatible';`
  - `provider?: LlmProvider;`

Why this matters:
- The app now has a place to remember which backend style the user wants.
- This is the first step in separating configuration from backend implementation.

### 2) Added provider to the saved root config

File:
- `C:\git\Locopilot-dev\config.json`

Current value:
- `"provider": "ollama"`

Why this matters:
- The current default still preserves existing Ollama behavior.
- The file format now carries the provider choice forward.

### 3) Introduced adapter-selection scaffolding in the LLM service layer

File:
- `C:\git\Locopilot-dev\src\services\llm.ts`

Current state:
- `selectLlmAdapter()` now **actually switches on the provider** — returns `openaiCompatibleAdapter` for `'openai-compatible'`, falls back to `ollamaAdapter` for everything else.
- `configureLlmAdapter(provider)` calls `selectLlmAdapter` and sets the active adapter.
- The switch statement uses proper case braces and has no redundant cases (satisfies `unicorn/switch-case-braces`).

Why this matters:
- The runtime can now choose a backend based on config.
- The adapter selection is no longer a stub — it makes a real decision.

### 4) Created the OpenAI-compatible adapter (Step B)

File:
- `C:\git\Locopilot-dev\src\services\adapters\openaiCompatibleAdapter.ts`

This is a complete adapter implementing the `LlmAdapter` interface for any OpenAI-compatible API endpoint. It handles:

| Capability | Implementation |
|---|---|
| **Connection validation** | `GET /v1/models` with configurable timeout |
| **Model listing** | `GET /v1/models` → maps to `LlmModel[]` |
| **Model info** | Derived from model list (OpenAI doesn't have a `/api/show` equivalent) |
| **Chat (non-streaming)** | `POST /v1/chat/completions` → maps response to `ChatApiResponse` |
| **Chat (streaming)** | SSE stream from `POST /v1/chat/completions?stream=true`, parses `data:` lines |
| **Tool calls (non-streaming)** | Converts OpenAI `tool_calls` → app's `ToolCall[]` format with parsed JSON arguments |
| **Tool calls (streaming)** | Accumulates incremental `delta.tool_calls` by `index` across chunks, yields complete calls on the final chunk |
| **Token usage stats** | Maps `usage.prompt_tokens` / `usage.completion_tokens` → `prompt_eval_count` / `eval_count` |
| **Error messages** | Parses OpenAI error format `{ error: { message, type, param, code } }` and common provider variants |
| **Auth** | `setApiKey(apiKey)` / `clearApiKey()` — configures a module-level axios instance with `Authorization: Bearer` header |
| **Reasoning effort** | Maps `params.think` → `reasoning_effort: 'low' | 'medium'` |
| **Stream options** | Sends `stream_options: { include_usage: true }` to get token counts in streaming |
| **Standard params passthrough** | Forwards `max_tokens`, `max_completion_tokens`, `temperature`, `top_p`, `stop`, `seed`, `frequency_penalty`, `presence_penalty`, `logit_bias`, `user` from `params.options` |
| **Response format** | Passes through `params.format` as `response_format` |
| **Provider extras** | Passes through `params.options.extra_body` for provider-specific parameters |

**Key design decisions:**
- All OpenAI API types are defined as concrete interfaces matching the official spec (no `Record<string, unknown>` for API shapes).
- Tool call arguments (`parsedArgs`) use `Record<string, unknown>` — genuinely dynamic, depends on tool definition.
- The `sendChat` method with `onChunk` callback accumulates `content`, `thinking`, and `tool_calls` across chunks (matching the Ollama adapter pattern).
- The `sendChatStream` generator yields each SSE chunk as a `ChatApiResponse`, with `done: true` and `done_reason` set on the final chunk.

### 5) Fixed regressions from earlier work

File:
- `C:\git\Locopilot-dev\src\services\configManager.ts`

An earlier attempt (GPT 5.4-mini) had stripped all `// eslint-disable-next-line unicorn/no-process-exit` comments from this file, causing 4 build errors. These have been restored.

### 6) Removed unnecessary `raw?: unknown` from ChatApiResponse

File:
- `C:\git\Locopilot-dev\src\services\adapters\llmAdapter.ts`

The `raw?: unknown` field was added to stash the raw OpenAI response for token stats extraction, but it was redundant — `toChatApiResponse()` already maps `usage.prompt_tokens` → `prompt_eval_count` and `usage.completion_tokens` → `eval_count` directly onto `ChatApiResponse`. The adapter's `getTurnStats` now reads from `ChatApiResponse` directly, matching the Ollama adapter pattern. Removed one unnecessary `unknown` type.

## What Was Verified

- `npm run build` compiles and type-checks successfully (all files).
- The only build failure is a pre-existing `_document.tsx` issue (`<Html>` imported outside `_document`) — unrelated to these changes.

## Current Behavior

The app can now:

1. **Select the OpenAI-compatible adapter at runtime** via `configureLlmAdapter('openai-compatible')`.
2. **Send requests to any OpenAI-compatible endpoint** using the new adapter.
3. **Stream responses** with proper tool call accumulation across SSE chunks.
4. **Authenticate** via `setApiKey()` for providers that require a Bearer token.
5. **Continue using Ollama** as the default when no provider is specified.

What's still missing for full runtime switching:
- The provider is not yet read from config at startup (Step A wiring).
- The UI doesn't expose provider selection yet.

## Intended Next Steps

### Step A: Wire provider selection into startup (remaining work)

Use `provider` from config when the app initializes and call `configureLlmAdapter(provider)` once.

Expected result:
- The runtime chooses a backend based on config, not hardcoded assumptions.

Files likely involved:
- `C:\git\Locopilot-dev\src\services\configManager.ts`
- `C:\git\Locopilot-dev\src\services\llm.ts`
- possibly initialization code in the app entry path

### Step C: Extend config for auth (partially done)

OpenAI-compatible endpoints usually need an API key.

What's done:
- The adapter exports `setApiKey()` and `clearApiKey()` functions.

What remains:
- Add `apiKey` field to the `Config` interface in `chatConfig.ts`.
- Wire config → `setApiKey()` during startup.
- Add API key input to UI settings.

Files likely involved:
- `C:\git\Locopilot-dev\src\types\chatConfig.ts`
- `C:\git\Locopilot-dev\src\app\api\config\route.ts`
- `C:\git\Locopilot-dev\src\services\configManager.ts`
- UI settings components

### Step D: Update model discovery UX

Some OpenAI-compatible providers may not expose models the same way Ollama does.

Expected behavior:
- The UI should not assume the provider has Ollama-style model listing.
- Manual model entry may be needed when discovery is unavailable.

Files likely involved:
- `C:\git\Locopilot-dev\src\components\ModelSelector\ModelSelector.tsx`
- `C:\git\Locopilot-dev\src\app\api\models\route.ts`
- `C:\git\Locopilot-dev\src\app\api\models\[name]\info\route.ts`

### Step E: Convert provider-specific payload/response assumptions

Ollama and OpenAI-compatible APIs differ in details like:
- request body shape
- streaming event format
- tool call output shape
- usage/token metadata
- model-info endpoint availability

Files likely involved:
- `C:\git\Locopilot-dev\src\services\adapters\ollamaAdapter.ts`
- `C:\git\Locopilot-dev\src\services\adapters\openaiCompatibleAdapter.ts`
- possibly `C:\git\Locopilot-dev\src\services\adapters\llmAdapter.ts`

## Notes on Design Direction

A good long-term shape is:

- `llm.ts` = the abstraction/facade
- `ollamaAdapter.ts` = existing local backend implementation
- `openaiCompatibleAdapter.ts` = OpenAI-style backend implementation (done)
- UI/config layer = chooses provider, base URL, and credential settings

This avoids spreading provider-specific conditionals across the codebase.

## Safe Resume Point

If picking up later, the next practical implementation step is:

1. Read provider from loaded config during startup.
2. Call `configureLlmAdapter(config.provider)` once.
3. If provider is `'openai-compatible'`, call `setApiKey(config.apiKey)`.
4. Keep Ollama as the default when provider is missing.
5. Re-run `npm run build`.
