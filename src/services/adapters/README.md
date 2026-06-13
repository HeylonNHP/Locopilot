# Adapter Guide

This folder contains provider-specific adapter implementations for Locopilot's LLM layer.

## Current implementation in brief

The adapter architecture has three layers:

1. Contract layer: [llmAdapter.ts](llmAdapter.ts)

- Defines normalized, provider-agnostic types such as `ChatMessage`, `ChatApiResponse`, `LlmTurnStats`, and the `LlmAdapter` interface.
- Every provider adapter must implement the same methods (`validateConnection`, `fetchModels`, `fetchModelInfo`, `sendChat`, `sendChatStream`, `getApiErrorMessage`, `getTurnStats`).

2. Provider layer: [ollamaAdapter.ts](ollamaAdapter.ts)

- Implements `LlmAdapter` for Ollama.
- Translates Locopilot's normalized chat payload into Ollama request shape.
- Parses Ollama stream lines into normalized chunks.
- Converts provider token stats into `LlmTurnStats`.

3. Facade layer: [../llm.ts](../llm.ts)

- Holds `activeAdapter` (currently `ollamaAdapter`).
- Exposes provider-agnostic wrappers used across the app.
- The rest of the codebase should import from `services/llm.ts`, not directly from provider adapter files.

## How to add another adapter (human or LLM workflow)

Use this exact sequence to add a new provider adapter (for example, an OpenAI-compatible endpoint):

1. Create a new file

- Add `services/adapters/<provider>Adapter.ts`.
- Import `LlmAdapter` and required shared types from [llmAdapter.ts](llmAdapter.ts).

2. Implement the full `LlmAdapter` interface

- `validateConnection`: lightweight connectivity check.
- `fetchModels`: return normalized `LlmModel[]`.
- `fetchModelInfo`: return normalized `LlmModelInfo`.
- `sendChat`: non-streaming call, optionally aggregate chunk data if `onChunk` is used.
- `sendChatStream`: stream and yield normalized `ChatApiResponse` chunks.
- `getApiErrorMessage`: produce user-friendly provider error text.
- `getTurnStats`: map provider token fields into `LlmTurnStats` or return `null` if unavailable.

3. Normalize provider specifics

- Keep provider-specific JSON fields inside the adapter file.
- Convert provider tool calls into normalized `tool_calls` format.
- Preserve `thinking` content if the provider exposes reasoning text.
- Preserve `images` handling compatibility with `ChatMessage`.

4. Register/select the adapter

- Import the adapter in [../llm.ts](../llm.ts) when needed.
- Either set it as default or switch via `setLlmAdapter(...)` based on runtime config.

5. Verify behavior

- Build check: `npx tsc --noEmit`
- Runtime smoke test: `npm start`
- Manual checks:
  - Model list loads.
  - Normal chat replies render.
  - Streaming still works.
  - Tool-call loop still works.
  - Error messages are readable.

## Maintenance guide for general changes

When making cross-cutting changes (features, message schema updates, metrics changes), keep adapters in sync using this checklist.

1. Change the contract first

- Update shared types and interface in [llmAdapter.ts](llmAdapter.ts).

2. Update every adapter implementation

- Apply matching updates in all `*Adapter.ts` files in this folder.
- Do not leave partial interface implementations.

3. Keep provider boundaries strict

- Provider-specific request/response logic stays in adapter files.
- App logic outside adapters should remain provider-agnostic and call [../llm.ts](../llm.ts).

4. Re-check streaming invariants

- Stream chunks must remain parseable and incremental.
- `sendChat` and `sendChatStream` should stay behaviorally consistent with current callers.

5. Re-check token stats behavior

- If token field names or availability differ by provider, keep `getTurnStats` defensive.
- Returning `null` is valid when authoritative counts are unavailable.

6. Update documentation

- Add a short change note in [.github/copilot-instructions.md](../../.github/copilot-instructions.md) under change history.
- Update this guide if the adapter contract or workflow changes.

## Common pitfalls to avoid

- Importing provider adapters directly from feature modules instead of [../llm.ts](../llm.ts).
- Leaking provider-specific fields into shared app logic.
- Forgetting to update one adapter after modifying the `LlmAdapter` interface.
- Treating all providers as if they expose the same streaming or token usage fields.
