# Context window: remaining phases

Status: Phases 1, 2 and 3 are built. See the section "Phase 3: what was built" for where the build differs from the plan, and for what is still open (A-006, A-007 in `CONFIRMATIONS.md`).

Companion files: [`CONFIRMATIONS.md`](../CONFIRMATIONS.md) (what is still unverified), [`CLAUDE.md`](../CLAUDE.md) (the numCtx section), `docs/CHANGELOG.md` (history).

## The rule

The window the user sees, and the window a turn uses, is:

    effective = min(setting, model maximum)     when the maximum is known
    effective = setting                          when the maximum is unknown
                                                 (shown as "model max unknown")

- **setting** = `provider.numCtx` if the active provider has one, otherwise the global `config.numCtx`.
- **model maximum** = what the provider says the model can take. It is only trusted when it comes from a source listed in the table below.
- The **server** computes this. The page displays what the server reports and never computes a limit itself.

## Done (Phase 1)

| Commit    | What                                                                                                                                                                                                                  |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `96adf4f` | The client no longer invents a window. `requestedNumCtx` is `null` until the config loads. No `DEFAULT_NUM_CTX` on the client. Loaders omit `tokenLimit` instead of writing a stand-in. Settings validates the field. |
| `b36a272` | Retry rebuilds `numCtx` from the current setting. A mid-turn switch re-reads the saved config and ignores the turn's body value.                                                                                      |
| `dc66b49` | A missing or unreadable `config.json` is logged as `config_unavailable`.                                                                                                                                              |
| `5597e3d` | Both Ollama request paths log the body of any 400 (`logOllamaBadRequest`).                                                                                                                                            |
| `c6c69a0` | Docs: decisions and findings recorded.                                                                                                                                                                                |

How it was after Phase 1, and what Phase 2 changed (all of it is now done):

- The page **still sends `numCtx`** in chat, compact, title and dump bodies when the setting is known. The server prefers a body value over the provider and config values.
- The server's turn-start resolution is `body > provider > config > DEFAULT_NUM_CTX`, in `src/app/api/chat/route.ts`.
- `GET /api/config` probes the **provider's default model**, not the selected one.
- `/api/ps` (the runtime probe) is used as a cap when `/api/show` returns nothing. It reports the runner's current allocation, so it can under-cap.
- Discovered caps (from a 400) and successful probes were cached for 5 minutes. A probe that failed in both ways was ALSO cached, as an unknown cap, for 5 minutes (the first version of this spec said failures were not cached; that was wrong).

## Evidence that shapes the rule

These are verified in `CONFIRMATIONS.md`. Short form:

- **Ollama Cloud ignores `options.num_ctx`.** Probed with `beam` and `minimax-m3.1-flash`: the prompt count did not change with `num_ctx` 256, and `num_ctx` 4,000,000 was accepted. The provider's own limit applies, so the clamp to the model maximum still matters.
- **Local Ollama honours `num_ctx`.** It truncates the input to the window, and it clamps to the model's `context_length` (`qwen3:0.6b`: 42,000 gave 40,960).
- **Local Ollama reserves the KV cache at load.** For a hybrid model, `bonsai-2:2b`, the cache is 12,288 bytes per token (6 full-attention layers). A simple formula gives 49,152. A full-attention model could reserve about 49 KB per token, which is about 12.9 GB at 262,144 tokens. The owner has accepted this risk and will handle it with per-provider windows.
- **llama.cpp enforces the served window, not `context_length`.** `context_length` in `/v1/models` is the trained maximum. It ignores `--ctx-size` and YaRN. Enforced: the per-slot context (`min` of the served window and the trained context after any YaRN rewrite). Live tests: a 429,927-token prompt was refused at 393,216 for a model whose `context_length` is 1,048,576; a 239,960-token prompt was refused at 222,976 for a model with no `--ctx-size`. The refusal body contains `"n_ctx"`.
- **llama.cpp unloaded models without `--ctx-size` have no knowable maximum** until they load. The served size is then sized to memory at load.
- **NVIDIA publishes no context length.** Its over-limit 400 says "maximum context length is 1048576 tokens", which the existing parser reads. The owner's NVIDIA setting (300,000) is trusted until a 400 says otherwise.
- **The output cap field** is `max_output_tokens` on the Responses API. Not part of this work, but summaries and digests depend on it.

## Phase 2: the server owns the window (done)

See "Phase 2: what was built" after section 2.9 for where the build differs from this plan.

### 2.1 The resolver

One function in `src/services/` (suggested: `contextWindow/resolveNumCtx.ts`). Input: `(provider, model)` and the config. Output:

    { requested: number | null,
      modelMax: number | null,
      effective: number | null,
      known: boolean,
      source: 'static' | 'llamacpp-loaded' | 'openai-models' | 'learned' | 'unknown',
      probeError: string | null }

Rules:

- `requested` = `provider.numCtx ?? config.numCtx`. **The request body is never an input.**
- `effective` = `min(requested, modelMax)` when `known`; otherwise `requested`.
- The `modelMax` source depends on the provider:

| Provider                                   | Source of `modelMax`                                                                                                    | Notes                                                                                                                 |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Ollama (local or cloud)                    | `/api/show` `model_info.*.context_length`, after the existing Modelfile `num_ctx` text scan                             | Never `/api/ps`.                                                                                                      |
| llama.cpp router                           | `/v1/models` entry `meta.n_ctx`, **only when `status` is `loaded`**                                                     | Never `context_length`. Unloaded: unknown. Detect the router by `owned_by: "llamacpp"` (seen in the owner's listing). |
| OpenAI-compatible, other (OpenRouter etc.) | `/v1/models` `context_length` (existing recursive walk)                                                                 |                                                                                                                       |
| NVIDIA                                     | none published → unknown                                                                                                | The setting is trusted; a 400 teaches the resolver.                                                                   |
| Any                                        | a 400 whose body states a limit (`maximum context length is N tokens`, `exceeds the available context size (N tokens)`) | `source: 'learned'`. Uses the existing parser.                                                                        |

- **`/api/ps` is removed as a cap source.** It stays available for display only.

### 2.2 Caching and timeouts (owner decisions)

- Each model-maximum probe has a **10-second timeout**.
- A successful probe is cached for **5 minutes** (the current `CAP_CACHE_TTL_MS`).
- A failed or timed-out probe is cached for **60 seconds**. Within that time the turn proceeds with `known: false`.
- A limit learned from a 400 is cached for **5 minutes**. A shorter cache would let a retry hit the same 400 again.
- Cache key: `(baseUrl, provider, model)`.
- Probes for one turn run in parallel where they are independent, so the worst case is about 10 seconds, not 20.

### 2.3 The endpoint

`GET /api/numctx?providerId=&model=`

- Both parameters are optional. The defaults are the config's `activeProviderId` and `model`.
- Returns the resolver's output as JSON. It makes no chat request. It is cheap enough to call on page load.

### 2.4 Server changes (by file)

- **`src/app/api/chat/route.ts`:** replace the `resolveNumCtxForModel` precedence with a call to the resolver. Remove the body `numCtx` as an input, both at turn start and at a mid-turn switch. Keep `adoptDiscoveredContextLimit` for 400s. Status events: `tokenLimit` = `effective`; `modelContextLimit` = `modelMax` (`null` when unknown).
- **`src/tools/impl/subAgentTool.ts`:** sub-agents inherit the parent's `effective`. They are re-resolved through the existing `refreshModels` hook when the model switches. Both consumption points must stay (see CLAUDE.md).
- **`src/app/api/config/route.ts`:** `GET` returns `modelContextLimit` from the resolver for `config.model` with `activeProviderId`. Fix the probe target. `PUT` keeps writing `numCtx`.
- **`src/app/api/compact/route.ts`, `src/app/api/title/route.ts`, `src/app/api/dump/route.ts`:** use the resolver for the window. Compaction resolves against the **compaction** model's own maximum when it differs from the main model; otherwise it reuses the main `effective`. Title keeps its own cap at the call site (`min(window, 8192)`, `4096` for small models). Dump only labels the window.
- **`src/app/api/diagnostics/numctx/route.ts`:** leave as a diagnostic, or route it through the resolver (decision below).
- **`src/services/capResolver.ts`:** becomes the resolver's cache and probe layer. Remove the `/api/ps` fallback. Add the timeouts and the failure cache.
- **`src/services/llmContextLimit.ts`:** unchanged parsers. Add the llama.cpp rule (`meta.n_ctx` when loaded) at the provider boundary.

### 2.5 Client changes

- **Stop sending `numCtx`** in: chat (`useChatStream.ts`), `/compact`, `/title`, `/dump` (`useSlashCommands.ts`). `/ctx` still writes the setting to the config.
- **Fetch `/api/numctx`** on: page load (after the config), model or provider change, a Settings save, and window focus (decision below). Store `effective`, `modelMax`, `known`, `source`.
- **Display rules** (the status bar and Settings):

| State                   | Shown                             |
| ----------------------- | --------------------------------- |
| Server not yet answered | `N/—`                             |
| `known`, capped         | `N/effective (model max: M)`      |
| `known`, not capped     | `N/effective`                     |
| Not `known`             | `N/effective (model max unknown)` |

- **`src/app/lib/contextWindow.ts`:** `resolveContextWindow` takes the server's values. `withCurrentNumCtx` and `numCtxField` are no longer used by the page once it stops sending `numCtx`. Remove them in Phase 3, with their tests.
- **`src/components/StatusBar/StatusBar.tsx`, `src/components/SettingsModal/SettingsModal.tsx`:** use the server values. Settings shows the "Effective Context Size" row only when capped, and "model max unknown" otherwise.
- **`src/app/lib/chatStore.ts`:** the `effectiveNumCtx` and `modelContextLimit` fields are set from `/api/numctx`. A real model or provider change clears them, then refetches (the existing `staleModelCapReset` logic).

### 2.6 Tests

- **`scripts/test-numctx-resolver.mjs`** (new), with fake probes and the fake clock (`scripts/fakeClock.mjs`):
  - provider beats config; the body is ignored (a source pin on the route);
  - Ollama: `context_length` used; `/api/ps` never used;
  - llama.cpp: unloaded is unknown; loaded uses `meta.n_ctx`; `context_length` is never used;
  - NVIDIA: unknown; a learned 400 applies for 5 minutes;
  - timeout after 10 s; failure cached for 60 s; success cached for 5 minutes;
  - a probe that fails does not stall a second turn within the 60 s window.
- **Update** `scripts/test-context-window.mjs`, `scripts/test-compact-receipt.mjs`, and the source pins that name `requestedNumCtxRef`.
- **Keep passing:** `test-chat-store.mjs`, `test-sse-routing.mjs`, `test-stream-machine.mjs`, `test-slash-command-routing.mjs`, `test-update-batcher.mjs`, `test-message-memo.mjs`.
- **`tsc --noEmit`, eslint, prettier, and `next build`.**

### 2.7 Live checks (the owner's sign-off on each)

1. **Local Ollama (`qwen3:0.6b`):** the status bar shows `40,960` for a `42,000` setting, with "model max: 40,960".
2. **llama.cpp (Ornith I-Quality, loaded):** the window is `262,144` from `meta.n_ctx`. For an unloaded model without `--ctx-size` the bar reads "model max unknown".
3. **NVIDIA:** the bar reads "model max unknown" with the 300,000 setting, and the turn proceeds.
4. **Cloud (`minimax-m3.1-flash`):** the bar shows `1,000,000`.
5. **Load order:** with `/api/config` delayed, the bar shows `—` until `/api/numctx` returns (C-010 still holds).
6. **Retry and switch:** unchanged behaviour (C-008).

### 2.8 Phase 2 acceptance

- No request body value is used for the window on the server.
- Every window shown or used comes from the resolver.
- The page never computes `min`.
- `/api/ps` is not a cap source anywhere.
- The probe timeout and cache rules are as above, and tested.
- All checks in 2.6 and 2.7 pass.

### 2.9 Suggested commit order

1. Resolver and its tests, not yet used.
2. Endpoint, and the `/api/config` probe fix.
3. Server routes use the resolver, and the body is ignored.
4. Client stops sending `numCtx` and fetches `/api/numctx`.
5. Docs, CONFIRMATIONS, CHANGELOG.

### Phase 2: what was built

Commits: `82e9af9` (resolver), `d9998f9` (endpoint), `2c9ada8` (server routes), `2a91199` (page), `c9232f1` (compaction failure reason), and the review fixes after the docs commit.

Where it differs from the plan above:

- **`GET /api/config` no longer probes a provider** and no longer returns `modelContextLimit` (the plan said to fix its target). The page gets the window from `/api/numctx`, so reading the config never waits on a slow provider. Commit `d9998f9` first fixed the target to `config.model`; `2a91199` removed the probe.
- **The cache key is (baseUrl, provider kind, model)**, and a failure is remembered for 60 s. The old code cached a failure for 5 minutes.
- **A change of the `numCtx` setting no longer clears the cap cache** on `PUT /api/config`: the maximum does not depend on it, and clearing it threw away a limit learned from a 400.
- **Compaction is always resolved against its own model**, rather than "only when it differs". For the same endpoint and model the probe is shared (cache and in-flight dedupe), so it costs no second call. The main and compaction windows are resolved in parallel.
- **llama.cpp is "known" when `meta.n_ctx` is present and `status.value` is `loaded`, or there is no `status`** (a plain llama-server). The plan said "only when `status` is `loaded`".
- **The page's token display** uses the server's window only. A restored session is measured against the server's current window, not a per-session snapshot. `requestedNumCtxRef` is gone. `numCtxField` and `withCurrentNumCtx` are unused and are removed in Phase 3.
- **The model maximum is a top-level store field** (`modelMaxNumCtx`), not only part of the per-conversation `tokenStats`, so it survives a conversation switch. An explicit `null` means "the server knows none"; an update without the field leaves it alone. `/ctx` saves before it updates the page.
- **New diagnostics:** `numctx_probe_failed`, logged when a probe fails, and a `reason` (the first 300 characters of the message) on a failed compaction's `compaction_end` (CONFIRMATIONS C-013).
- **Decisions 1 to 5 in the table below were adopted as recommended.**

Live checks (2.7): 1, 3, 4, 5 and 6 passed; check 2 (llama.cpp) is blocked because the owner's router was not reachable. See `CONFIRMATIONS.md`.

## Phase 3: robustness

### 3.1 Config save writes the default only for a fresh file

- Today `PUT /api/config` merges a base that includes `numCtx: DEFAULT_NUM_CTX` and saves it when the file has no value.
- Change: the `131072` default is written **only when the config file is created**. A `PUT` to an existing file writes only the fields in the body.
- Test: a `PUT` without `numCtx` against a file without one leaves `numCtx` absent.

### 3.2 Recover from a numberless context-limit 400

- Today the parser returns `null` for `invalid params, context window exceeds limit` (Ollama Cloud, `minimax-m3.1-flash`, C-005). The sub-agent dies.
- Change: recognise that family of messages (the exact set comes from the logs A-001 now writes). On a match, in the main loop and in sub-agents, force one compaction and retry the turn once. **Do not learn a cap** from a numberless message.
- Also check the llama.cpp refusal JSON (`n_ctx` field), which the resolver can use directly.

### 3.3 Remove the server's `DEFAULT_NUM_CTX` fallbacks

- Locations: `src/app/api/chat/route.ts` (the `requestedNumCtx` default), `src/app/api/config/route.ts` (the probe fallback and the base merge), `src/app/api/diagnostics/numctx/route.ts`, `src/app/api/dump/route.ts`, `src/app/api/compact/route.ts`, `src/app/api/title/route.ts`, and `src/constants.ts` if nothing else uses it.
- **Decision needed:** when `config.json` is missing or unreadable, the chat should fail with a clear error ("config.json is missing or unreadable"). Model selection already comes from the config, so the chat cannot proceed without it anyway. Recommended: fail.

### 3.4 Clean up

- Remove `withCurrentNumCtx` and `numCtxField` from `contextWindow.ts` if Phase 2 leaves them unused, with their tests.
- Rewrite the CLAUDE.md numCtx section to match the code. Remove the "decided, not yet built" lines.
- Update `CONFIRMATIONS.md`: close what Phase 2 and 3 resolved.

### 3.5 Phase 3 acceptance

- The default is written only to a fresh config file.
- A numberless context 400 triggers one compaction, not a death, and teaches nothing.
- No `DEFAULT_NUM_CTX` remains in server code paths that set a window.
- Missing config fails clearly.

### Phase 3: what was built

- **3.1 fresh-file default:** the 131072 default is written only when `config.json` is created (`readConfig` → `buildFreshConfig`). A PUT to an existing file no longer merges a window default. Test: `scripts/test-config-load.mjs`.
- **3.2 numberless 400:** the plan's "recognise that family of messages" is one phrasing (`invalid params, context window exceeds limit`), because only one is confirmed. The plan's optional llama.cpp `n_ctx`-in-JSON item was skipped: the message parser already reads that refusal. The retry is "compact once, then re-send" in the main loop (`continue outer`) and in sub-agents. Only the phrasing list is marked NEEDS CLARIFICATION.
- **3.3 server defaults removed:** `DEFAULT_NUM_CTX` no longer exists. A missing window is an error (`requireWindow`), or 0 where a guard already treats 0 as "no window". The plan's "fail clearly" is done as a refusal before any model call (409, with the reason), and an unreadable file answers 503 and is never overwritten. The Settings dialog cannot add a provider, so the refusal's "choose a model in Settings" cannot be followed yet (A-006).
- **3.4 cleanup:** `numCtxField` and `withCurrentNumCtx` removed, with their tests. CLAUDE.md's "decided, not built" lines are replaced by what was built.
- **Not done:** the live check of the numberless 400 (A-007), which needs the owner's OK and a model with a window of about 131,000 tokens.

## Decisions still open

| #   | Question                                                        | Recommendation                                             |
| --- | --------------------------------------------------------------- | ---------------------------------------------------------- |
| 1   | Refetch `/api/numctx` on window focus?                          | Yes, throttled to once per 30 s. Done.                     |
| 2   | Compaction model: probe its own maximum every turn?             | Only when it differs from the main model. Reuse otherwise. |
| 3   | Sub-agents: inherit the parent's window, re-resolved on switch? | Yes, as today, plus the existing `refreshModels` hook.     |
| 4   | Title, compact and dump: same resolver?                         | Yes. Title keeps its own 8,192 cap at the call site.       |
| 5   | Diagnostics route: keep or route through the resolver?          | Route it through the resolver.                             |
| 6   | Missing config (Phase 3): fail or fall back?                    | Fail with a clear error.                                   |

## Risks

- **Behaviour change for providers with their own `numCtx`.** NVIDIA (300,000), Airia (300,000) and OpenRouter (276,480) will start to apply their own windows. Their compactions will happen sooner, and summaries will be smaller. This is the intended result of the decision, but it is visible.
- **Probe stalls at turn start.** Up to 10 seconds per probe. Mitigated by parallel probes and the 60-second failure cache.
- **llama.cpp unloaded models** show "model max unknown" until they load. A setting above the served window will get a 400, which the parser learns from.
- **Local memory.** Large windows on full-attention local models reserve large caches. Mitigated by per-provider windows, as the owner has decided.
- **Stale tabs (C-011).** Phase 2 fixes stale window values. It does not fix the freeze, which has a different cause. Do not describe it as fixing stale tabs in general.

## Not in these phases

- **The stale-tab freeze** (C-011). Needs DevTools evidence from a stuck tab.
- **Output caps for llama.cpp and vLLM** (C-001, C-002). The output cap is separate from the window.
- **Reasoning tokens under the output cap** (C-007).
- **Muse-Glimmer served window** (C-014). Predicted at 131,072, not tested. Needs a load on the owner's router.
- **Compaction failure after a switch** (C-013). The adapter now logs 400 bodies, but this failure may not be a 400.
- **Deploying to the production copy** (A-002). Do after Phase 2.
- **Title length check** (C-012). Verified by reading the code, not run.
