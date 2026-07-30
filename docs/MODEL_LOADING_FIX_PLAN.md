# Plan: Fix "Loading models…" stuck bug

> Saved so it survives conversation compaction.

## Context

The user reported: _"Why does the backend say that the models have been fetched (with a 200 status), but the frontend still shows the models are loading?"_

The screenshot shows the StatusBar stuck on **"Loading models…"** while the dev console logs multiple successful `GET /api/models 200` responses — including one that took **78 seconds** to complete (the user's OpenAI-compatible provider returns 179 models).

The StatusBar text is bound to `state.modelsLoading`, which is set `true` on `loadModels` start and `false` in its `finally` block (`src/app/hooks/useDataLoaders.ts:168-183`). An adversarial trace confirmed there is no other code path that ever dispatches `SET_MODELS_LOADING`, so the state machinery is correct — the StatusBar will eventually flip to `false` once `loadModels`'s promise resolves. The visible bug is that the **latest `loadModels` invocation is still in flight** when the screenshot was taken.

## Root cause

`src/services/adapters/openaiCompatibleAdapter.ts:713-734` — `fetchOpenAICompatibleModelInfo` is implemented as:

```ts
async function fetchOpenAICompatibleModelInfo(ctx, modelName) {
  const models = await fetchOpenAICompatibleModels(ctx);  // ← re-fetches ENTIRE /v1/models list
  const foundModel = models.find((model) => model.name === modelName);
  return { model_info: { model: modelName, ...(foundModel ? ...) : {} }, details: {...} };
}
```

The OpenAI-compatible `/v1/models` endpoint has **no per-model info endpoint** (unlike Ollama's `/api/show`), so the adapter re-downloads the whole model list just to find one entry. This is the same payload returned by `fetchLlmModels(ctx)` upstream — and the caller (`src/app/api/models/route.ts:60-115`) already has the full list in memory.

The route handler calls `fetchLlmModelInfo` once per model in `Promise.all`, so each `/api/models` request fans out into **N parallel re-fetches of the same model list**. For the user's `prodaus.gateway.airia.ai` provider with **179 models**, that's **1 + 179 = 180 calls to `/v1/models`** per `/api/models` request — explaining the 78-second application-code latency in the dev console.

## Files involved

- `src/services/adapters/openaiCompatibleAdapter.ts:713-734` — the N+1 offender
- `src/app/api/models/route.ts:60-115` — the caller that fans out into N parallel info fetches
- `src/app/hooks/useDataLoaders.ts:168-183` — `loadModels` (correct; reports the symptom)
- `src/components/StatusBar/StatusBar.tsx:167-176` — the consumer (correct; reads the symptom)
- `src/app/lib/chatStore.ts:838-839` — the reducer (correct; stores the symptom)

## Recommended fix

**Add an optional `preFetchedModels` argument to `fetchOpenAICompatibleModelInfo`** so callers who already have the model list can skip the network call. Then in the route, pass the already-fetched list down. This eliminates the N+1 with zero behavioural change and preserves the existing adapter contract for other callers.

### Step 1: openaiCompatibleAdapter.ts

Replace `fetchOpenAICompatibleModelInfo` (line 713-734):

```ts
async function fetchOpenAICompatibleModelInfo(
  ctx: LlmRequestContext,
  modelName: string,
  preFetchedModels?: LlmModel[]
): Promise<LlmModelInfo> {
  const models = preFetchedModels ?? (await fetchOpenAICompatibleModels(ctx));
  const foundModel = models.find((model) => model.name === modelName);
  return {
    model_info: {
      model: modelName,
      ...(foundModel
        ? Object.fromEntries(
            Object.entries(foundModel).filter(([k]) => k !== 'name' && k !== 'model')
          )
        : {}),
    },
    details: {
      ...(foundModel?.details?.parent_model
        ? { parent_model: foundModel.details.parent_model }
        : {}),
    },
  };
}
```

This change is backward-compatible: any caller that doesn't pass `preFetchedModels` falls back to the original behaviour (one network call per invocation).

### Step 2: route.ts

In the `Promise.all` map at `src/app/api/models/route.ts:60-115`, pass the already-fetched `models` array down:

```ts
const modelsWithCapabilities = await Promise.all(
  models.map(async (model) => {
    const caps = new Set<string>();
    try {
      const modelInfo = await fetchLlmModelInfo(llmRequestContext, model.name, models);
      if (Array.isArray(modelInfo.capabilities)) {
        for (const cap of modelInfo.capabilities) {
          caps.add(String(cap));
        }
      }
    } catch {
      // probe failure — fall through to the vision cache check below
    }
    // ... rest unchanged
  })
);
```

The Ollama adapter ignores the new optional argument (since its own `fetchOllamaModelInfo` doesn't accept it). Other callers (chat route, etc.) keep working unchanged.

## Expected impact

For the user's 179-model OpenAI-compatible provider, this collapses `/api/models` from **180 backend hits** to **1**, dropping application-code latency from ~78s to <1s.

## Verification

1. Reload the page with `npm run dev` and `provider: openai-compatible` pointing at `https://prodaus.gateway.airia.ai`.
2. Watch the dev console — `/api/models 200` should complete in well under 5 seconds (single round-trip).
3. The StatusBar should flip from "Loading models…" to "Model: <name>" within that window.
4. As a quick sanity check, temporarily add `console.time('models')` at the top of `route.ts`'s `GET` and `console.timeEnd('models')` before `return NextResponse.json(...)` — the elapsed time should be roughly one upstream `/v1/models` call (single-digit seconds), not 60–80s.
5. Click around in the session sidebar to trigger re-renders — `/api/models` should not be called repeatedly, and the StatusBar should never get stuck on "Loading models…".

## Auto-fixable lint cleanups (orthogonal, do alongside)

The Stop hook surfaces pre-existing lint errors across the project. Auto-fixable ones:

- `src/app/mermaid-streaming/page.tsx` L4:1 — perfectionist/sort-imports spacing
- `src/app/mermaid-test/page.tsx` L6:12, L7:4 — `unicorn/prefer-global-this` (`window` → `globalThis.window`)
- `src/components/MarkdownMessage/MarkdownMessage.tsx` L173:17, L240:17 — `unicorn/better-regex` (character class order)
- `test-markdown-pipeline.mjs` L7:1, etc. — import sort, `no-undef`/`no-console`

Run `npx eslint --fix` on these files to clean them up. The remaining 254 errors are NOT auto-fixable and out of scope for this task.
