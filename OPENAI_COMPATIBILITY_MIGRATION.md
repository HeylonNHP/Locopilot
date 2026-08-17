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

### Mapping the canonical output-token limit

The `ChatParams` / `StreamChatParams` interfaces define a provider-agnostic `maxOutputTokens` field. Adapters translate it as follows:

- **Ollama adapter** (`ollamaAdapter.ts`): `maxOutputTokens` → `options.num_predict`
- **OpenAI-compatible adapter** (`openaiCompatibleAdapter.ts`): `maxOutputTokens` → `max_output_tokens` (Responses API field)

Callers (e.g. web content compaction, history compaction/distillation, token measurement) should set `maxOutputTokens` instead of passing `options.num_predict`, `options.max_tokens`, or `options.max_completion_tokens`. The canonical field is always preferred; the legacy `options.*` keys remain available as a fallback for external/unconverted code.

## What Has Already Been Done

### 12) Switched transport to the official `openai` npm SDK (Responses API)

File:

- `C:\git\Locopilot-dev\src\services\adapters\openaiCompatibleAdapter.ts`
- `C:\git\Locopilot-dev\package.json`
- `C:\git\Locopilot-dev\package-lock.json`

**What changed:**

The adapter no longer hand-builds `/v1/chat/completions` requests or manually parses SSE streams. Instead it constructs a per-request `OpenAI` client (from the `openai` npm package) and uses the **Responses API** (`client.responses.create()`).

| Capability                 | Old implementation (chat completions)                        | New implementation (Responses API)                                            |
| -------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| **Chat (non-streaming)**   | `POST /v1/chat/completions` → `OpenAIChatCompletionResponse` | `client.responses.create()` → `Response`                                      |
| **Chat (streaming)**       | Manual SSE `data:` line parsing                              | `client.responses.create({ stream: true })` → `Stream<ResponseStreamEvent>`   |
| **Input format**           | `OpenAIMessage[]` (role/content/tool_calls)                  | `ResponseInputItem[]` (EasyInputMessage + FunctionCallOutput)                 |
| **Output format**          | `OpenAIChatCompletionResponse.choices[0].message`            | `Response.output` (ResponseOutputItem union)                                  |
| **Tool calls (streaming)** | Accumulate `delta.tool_calls` by `index`                     | `response.function_call_arguments.delta` + `response.output_item.done` events |
| **Reasoning text**         | `delta.reasoning_content`                                    | `response.reasoning_text.delta` events + `ResponseReasoningItem`              |
| **Token usage**            | `usage.prompt_tokens` / `usage.completion_tokens`            | `Response.usage.input_tokens` / `output_tokens`                               |
| **Error handling**         | `axios.isAxiosError()` + manual error body parsing           | `OpenAI.APIError` subclass detection                                          |
| **Auth**                   | `setApiKey(apiKey)` / `clearApiKey()` module-level axios     | Per-request `OpenAI` client with `apiKey` from `LlmRequestContext`            |
| **Model listing**          | `GET /v1/models` via axios (unchanged)                       | `GET /v1/models` via axios (unchanged)                                        |

**Key design decisions:**

- A **fresh `OpenAI` client** is created per request (in `buildClient(ctx)`) so concurrent requests with different credentials never leak state. The `baseURL` is normalized to end with `/` (the SDK appends path segments).
- When no `apiKey` is configured, a placeholder `'sk-placeholder'` is used because the SDK requires a non-empty string. This works with providers like Ollama and LM Studio that don't require authentication.
- System messages are collected into the `instructions` field (a single string) rather than being placed in the `input` array, matching the Responses API convention.
- Assistant messages and their tool calls are separate items in the `input` array: the message text as an `EasyInputMessage` with `role: 'assistant'`, followed by `ResponseFunctionToolCall` items.
- Tool results are `ResponseInputItem.FunctionCallOutput` items with the matching `call_id`.
- The orphaned-tool-message fallback (converting to `user` role) is preserved from the old adapter.
- The `buildRequestClient` method now returns an axios client used only for model listing (`/v1/models`), which the SDK doesn't expose for custom endpoints.
- The `setApiKey`/`clearApiKey` exports remain as deprecated no-op shims so legacy callers don't crash.

**Why this matters:**

- The adapter now delegates the OpenAI wire protocol to the official SDK instead of reimplementing it, reducing maintenance burden and automatically tracking spec changes.
- The Responses API is the recommended endpoint for new OpenAI integrations and supports features (reasoning, structured outputs, built-in tools) that chat completions handles less cleanly.
- The SDK's `Stream` type provides proper backpressure, abort signal integration, and error handling that the manual SSE parser lacked.

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
- `configureLlmAdapterAndAuth(provider, apiKey)` also configures the adapter **and** sets/clears the OpenAI API key in one call.
- The switch statement uses proper case braces and has no redundant cases (satisfies `unicorn/switch-case-braces`).

Why this matters:

- The runtime can now choose a backend based on config.
- The adapter selection is no longer a stub — it makes a real decision.

### 4) Created the OpenAI-compatible adapter (Step B)

File:

- `C:\git\Locopilot-dev\src\services\adapters\openaiCompatibleAdapter.ts`

This is a complete adapter implementing the `LlmAdapter` interface for any OpenAI-compatible API endpoint. It handles:

| Capability                      | Implementation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| **Connection validation**       | `GET /v1/models` with configurable timeout                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Model listing**               | `GET /v1/models` → maps to `LlmModel[]`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Model info**                  | Derived from model list (OpenAI doesn't have a `/api/show` equivalent)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Chat (non-streaming)**        | `POST /v1/chat/completions` → maps response to `ChatApiResponse`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **Chat (streaming)**            | SSE stream from `POST /v1/chat/completions?stream=true`, parses `data:` lines                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Tool calls (non-streaming)**  | Converts OpenAI `tool_calls` → app's `ToolCall[]` format with parsed JSON arguments                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Tool calls (streaming)**      | Accumulates incremental `delta.tool_calls` by `index` across chunks, yields complete calls on the final chunk                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Token usage stats**           | Maps `usage.prompt_tokens` / `usage.completion_tokens` → `prompt_eval_count` / `eval_count`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Error messages**              | Parses OpenAI error format `{ error: { message, type, param, code } }` and common provider variants                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Auth**                        | `setApiKey(apiKey)` / `clearApiKey()` — configures a module-level axios instance with `Authorization: Bearer` header                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Reasoning effort**            | Maps `params.think` → `reasoning_effort: 'low'                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 'medium'` |
| **Stream options**              | Sends `stream_options: { include_usage: true }` to get token counts in streaming                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **Output token cap**            | Maps the canonical `params.maxOutputTokens` field to `max_completion_tokens`. Legacy `options.max_tokens` / `options.max_completion_tokens` are fallback-only.                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **Standard params passthrough** | Forwards `temperature`, `top_p`, `frequency_penalty`, `presence_penalty`, `seed`, `stop`, `logit_bias` from `params.options` — but consults the per-model sampling-params cache (see `src/services/samplingParamsCache.ts`) first, so any field the upstream rejects is omitted automatically.                                                                                                                                                                                                                                                                                                                         |
| **Per-model param support**     | `fetchSamplingParamSupport(ctx, model)` hits `GET /v1/models` and reads the model entry's `supported_parameters` list (OpenRouter exposes this; other providers ignore the field). The adapter consults `params.samplingParamSupport` synchronously at request build time, populated by the chat route via `getLlmModelSamplingParamSupportAsync`. Reactive 400-driven discovery (see `parseUnsupportedParamFromError` + `recordDiscoveredUnsupportedParam` in `src/services/llmContextLimit.ts` and `src/services/samplingParamsCache.ts`) folds a runtime rejection into the cache so the next turn omits the field. |
| **Response format**             | Passes through `params.format` as `response_format`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Provider extras**             | Passes through `params.options.extra_body` for provider-specific parameters                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

**Key design decisions:**

- All OpenAI API types are defined as concrete interfaces matching the official spec (no `Record<string, unknown>` for API shapes).
- Tool call arguments (`parsedArgs`) use `Record<string, unknown>` — genuinely dynamic, depends on tool definition.
- The `sendChat` method with `onChunk` callback accumulates `content`, `thinking`, and `tool_calls` across chunks (matching the Ollama adapter pattern).
- The `sendChatStream` generator yields each SSE chunk as a `ChatApiResponse`, with `done: true` and `done_reason` set on the final chunk.

### 5) Wired provider selection and auth into every API route (Step A + Step C)

Files changed:

- `C:\git\Locopilot-dev\src\services\llm.ts`
- `C:\git\Locopilot-dev\src\types\chatConfig.ts`
- `C:\git\Locopilot-dev\src\app\api\config\route.ts`
- `C:\git\Locopilot-dev\src\app\api\models\route.ts`
- `C:\git\Locopilot-dev\src\app\api\chat\route.ts`
- `C:\git\Locopilot-dev\src\app\api\compact\route.ts`
- `C:\git\Locopilot-dev\src\app\api\title\route.ts`

What changed:

- Added `apiKey?: string` to the `Config` interface.
- Added `configureLlmAdapterAndAuth(provider, apiKey)` helper in `llm.ts`.
- Every route that talks to the LLM now:
  1. Loads config with `loadConfig()`.
  2. Calls `configureLlmAdapterAndAuth(config?.provider, config?.apiKey)` before any LLM call.
  3. Uses the active adapter for chat, model listing, compaction, title generation, etc.
- The config PUT endpoint persists `apiKey` and scrubs empty strings so they aren't saved.
- The models route error message is now provider-agnostic ("LLM base URL not configured" instead of "Ollama base URL").

Why this matters:

- The app now reads provider and API key from config at request time and routes to the right backend.
- OpenAI-compatible endpoints actually work end-to-end once config is set.
- No route accidentally falls back to the stale module-level Ollama adapter.

### 6) Fixed regressions from earlier work

File:

- `C:\git\Locopilot-dev\src\services\configManager.ts`

An earlier attempt (GPT 5.4-mini) had stripped all `// eslint-disable-next-line unicorn/no-process-exit` comments from this file, causing 4 build errors. These have been restored.

### 7) Removed unnecessary `raw?: unknown` from ChatApiResponse

File:

- `C:\git\Locopilot-dev\src\services\adapters\llmAdapter.ts`

The `raw?: unknown` field was added to stash the raw OpenAI response for token stats extraction, but it was redundant — `toChatApiResponse()` already maps `usage.prompt_tokens` → `prompt_eval_count` and `usage.completion_tokens` → `eval_count` directly onto `ChatApiResponse`. The adapter's `getTurnStats` now reads from `ChatApiResponse` directly, matching the Ollama adapter pattern. Removed one unnecessary `unknown` type.

### 8) Fixed Airia API 400 error — strip nested descriptions from tool schemas

File:

- `C:\git\Locopilot-dev\src\services\adapters\openaiCompatibleAdapter.ts`

**Root cause:** The Airia API gateway rejects `description` fields inside nested `items.properties` in tool parameter JSON Schemas. The `run_subagents` tool has descriptions on its nested `id` and `prompt` properties, which caused every chat request to fail with HTTP 400 "Invalid request body format".

**Fix:** Added `stripDescriptions()` — a recursive function that removes all `description` keys from a schema object — and `stripToolDescriptions()` which applies it to every tool's `parameters` before sending. The top-level `function.description` is preserved (it's standard and supported).

**Verified:** Tested against the live Airia API with a payload containing the `run_subagents` tool (with nested descriptions). Previously returned 400; now returns a successful streaming response.

### 9) Fixed Airia API 400 error — never send `reasoning_effort` with function tools

File:

- `C:\git\Locopilot-dev\src\services\adapters\openaiCompatibleAdapter.ts`

**Root cause:** The Airia API gateway rejects the combination of `reasoning_effort` and `tools` in the same `/v1/chat/completions` request:

```json
{
  "error": {
    "message": "Function tools with reasoning_effort are not supported for gpt-5.4-mini in /v1/chat/completions. Please use /v1/responses instead.",
    "type": "invalid_request_error",
    "param": "reasoning_effort"
  }
}
```

**Fix:** `buildChatPayload()` now only adds `reasoning_effort` when **no tools** are present. It also has a defensive post-check that deletes `reasoning_effort` from the payload if tools were somehow included.

**Verified:**

- Tested the exact failing payload (`tools` + `reasoning_effort: "medium"`) against the live Airia API — it reproduces the 400.
- Tested the corrected payload (`tools` without `reasoning_effort`) against the same endpoint — it streams successfully.
- Added explicit 400 debug logging that prints the payload summary and flags `reasoning_effort` + tools as the probable cause.

### 10) Fixed circular JSON crash that masked the real 400 error

File:

- `C:\git\Locopilot-dev\src\services\adapters\openaiCompatibleAdapter.ts`

**Root cause:** When a streaming request fails, `err.response.data` can be an axios response stream containing circular references (`TLSSocket` → `ClientRequest` → `Agent` → ...). The 400 debug logging was calling `JSON.stringify(data)` on it, which threw `TypeError: Converting circular structure to JSON`. That secondary error replaced the actual 400 and propagated up through the sub-agent web search path, making it look like content compaction had failed.

**Fix:** Replaced raw `JSON.stringify` with a safe extractor that only copies primitive / array / object-type labels. Also saves the full request payload to `debug_400_payload.json` for direct inspection and curl reproduction.

### 11) Fixed `/api/models/[name]/info` using the wrong adapter

File:

- `C:\git\Locopilot-dev\src\app\api\models\[name]\info\route.ts`

**Root cause:** This route was not calling `configureLlmAdapterAndAuth()`, so it kept using the default Ollama adapter against the configured OpenAI-compatible base URL, returning HTTP 500.

**Fix:** Added `configureLlmAdapterAndAuth(config.provider, config.apiKey)` before `fetchLlmModelInfo()`. Also updated the "Ollama base URL not configured" error message to "LLM base URL not configured".

## What Was Verified

- `npm run build` compiles and type-checks successfully (all files).
- The only build failure is a pre-existing `_document.tsx` issue (`<Html>` imported outside `_document`) — unrelated to these changes.

## Current Behavior

The app can now:

1. **Select the OpenAI-compatible adapter at runtime** via config `"provider": "openai-compatible"`.
2. **Authenticate with an API key** by setting `"apiKey": "sk-..."` in `config.json`.
3. **Send requests to any OpenAI-compatible endpoint** using the new adapter.
4. **Stream responses** with proper tool call accumulation across SSE chunks.
5. **Continue using Ollama** as the default when no provider is specified.
6. **List models, compact history, and generate titles** through the correct provider adapter.

What's still missing for full user-facing OpenAI support:

- The UI doesn't expose provider selection or an API-key field yet.
- The UI doesn't handle providers that don't support model listing (manual model entry).

## Intended Next Steps

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

### Step F: Add UI settings for provider and API key

Expose the new config fields in the settings modal so users can switch providers without hand-editing `config.json`.

Files likely involved:

- `C:\git\Locopilot-dev\src\components\SettingsModal\SettingsModal.tsx`
- `C:\git\Locopilot-dev\src\app\api\config\route.ts`

## Notes on Design Direction

A good long-term shape is:

- `llm.ts` = the abstraction/facade
- `ollamaAdapter.ts` = existing local backend implementation
- `openaiCompatibleAdapter.ts` = OpenAI-style backend implementation (done)
- UI/config layer = chooses provider, base URL, and credential settings

This avoids spreading provider-specific conditionals across the codebase.

## Safe Resume Point

If picking up later, the next practical implementation step is:

1. Add provider/API-key inputs to `SettingsModal.tsx`.
2. Update `ModelSelector` to allow manual model entry when model listing fails.
3. Re-run `npm run build`.
