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
- The file still defaults to `ollamaAdapter`.
- A provider-aware selection path now exists in the code shape:
  - `selectLlmAdapter(_provider?: LlmProvider)`
  - `configureLlmAdapter(provider?: LlmProvider)`

Current limitation:
- The selection function is still conservative and returns the Ollama adapter for now.
- Provider choice is not yet wired into startup, so the runtime still behaves like Ollama-only.

Why this matters:
- The application now has a clean central place where provider selection can happen.
- Future work can wire config -> adapter selection without changing every call site.

## What Was Verified

- `npm run build` passes successfully in the project root:
  - `C:\git\Locopilot-dev`

That means the repository currently builds cleanly after the groundwork changes above.

## Current Behavior

Right now the app still effectively behaves as Ollama-only because:

- `src/services/llm.ts` still routes everything to `ollamaAdapter`
- No OpenAI-compatible adapter has been implemented yet
- The provider flag is stored, but not yet used to change runtime behavior

So this is a scaffolding milestone, not a full compatibility milestone.

## Intended Next Steps

### Step A: Wire provider selection into startup

Use `provider` from config when the app initializes and call `configureLlmAdapter(provider)` once.

Expected result:
- The runtime chooses a backend based on config, not hardcoded assumptions.

Files likely involved:
- `C:\git\Locopilot-dev\src\services\configManager.ts`
- `C:\git\Locopilot-dev\src\services\llm.ts`
- possibly initialization code in the app entry path

### Step B: Add an OpenAI-compatible adapter

Create a second adapter that translates the app's internal chat/tool request shape into OpenAI-compatible API calls.

Expected responsibilities:
- validate connection against an OpenAI-compatible base URL
- fetch models if the provider exposes them
- send chat/completions requests
- stream responses in the app's expected internal format
- surface errors in a provider-appropriate way

Files likely involved:
- `C:\git\Locopilot-dev\src\services\adapters\openaiCompatibleAdapter.ts`
- `C:\git\Locopilot-dev\src\services\adapters\llmAdapter.ts`
- `C:\git\Locopilot-dev\src\services\llm.ts`

### Step C: Extend config for auth

OpenAI-compatible endpoints usually need an API key.

Expected config additions:
- `apiKey` or similar credential field
- possibly provider-specific headers later if needed

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
- new OpenAI-compatible adapter file
- possibly `C:\git\Locopilot-dev\src\services\adapters\llmAdapter.ts`

## Notes on Design Direction

A good long-term shape is:

- `llm.ts` = the abstraction/facade
- `ollamaAdapter.ts` = existing local backend implementation
- `openaiCompatibleAdapter.ts` = future OpenAI-style backend implementation
- UI/config layer = chooses provider, base URL, and credential settings

This avoids spreading provider-specific conditionals across the codebase.

## Safe Resume Point

If picking up later, the next practical implementation step is:

1. Read provider from loaded config during startup.
2. Call `configureLlmAdapter(config.provider)` once.
3. Keep Ollama as the default when provider is missing.
4. Re-run `npm run build`.

That would turn the current scaffolding into a real runtime decision without changing the backend protocol yet.
