# Outstanding confirmations

This file lists claims that are **not yet verified** and actions that are **still pending**. It is kept in the repository so that anyone (or any agent, on any machine) can pick an item up without needing the conversation that raised it.

## For AI agents: read and update this file

- **Read it first** before working on: the context window (`numCtx`), the OpenAI-compatible or Ollama adapters, retry or mid-turn model switching, compaction budgets, or the title route.
- **When your work verifies or contradicts an entry**, update it. Move a verified item to _Confirmed_ with the date and the evidence. If an entry is contradicted, say so, and correct any code or docs that relied on it.
- **When you write a "not verified" or "inferred" claim** in a commit message, a doc, or a reply, add an entry here with a way to confirm it.
- **Keep entries self-contained.** Someone with no conversation context, on another machine, should be able to run the check from the entry alone.
- **Never record secrets** (API keys, tokens, account details) here. Say where the key is kept (for example, `config.json`) and leave it there.
- **Expensive checks** (large prompts, paid calls) need the owner's go-ahead first. The entry says so.

Entry format: `C-nnn` for open confirmations, `A-nnn` for pending actions. Use the next free number.

---

## Open confirmations

### C-001 — llama.cpp: does `/v1/responses` pass `max_output_tokens` through?

- **Status:** Unconfirmed.
- **Claim:** Not confirmed: llama.cpp converts Responses requests to Chat Completions, and its docs do not say whether `max_output_tokens` survives that conversion. If it does not, the output caps Locopilot sets (summaries, digests, title) are silently ignored on a llama.cpp provider. Your local llama.cpp server may not pass the cap through.
- **Why it matters:** the adapter only calls `/v1/responses` (`src/services/adapters/openaiCompatibleAdapter.ts`, the `requestPath` default), so every llama.cpp provider depends on this.
- **How to confirm:** start `llama-server` with a small model, then run (replace the model name and port):
  ```bash
  curl -s http://127.0.0.1:8080/v1/responses -H "Content-Type: application/json" -d '{"model":"<model>","input":"Count from 1 to 300, one number per line.","max_output_tokens":16}'
  ```
  The cap works if the reply has `"status":"incomplete"` with `incomplete_details.reason` set to `max_output_tokens`, and `usage.output_tokens` is 16 or less. If it writes all 300 numbers, the cap is ignored. Run it again without the cap for comparison.
- **Needs:** a machine with llama.cpp built (`llama-server`) and a model. The owner's config points a provider at `http://localhost:60300`, which is a llama.cpp router on the owner's home machine.
- **Source:** web check of the llama.cpp server README (master branch), 2026-11-11. The README describes the conversion but not the field.

### C-002 — vLLM: does `/v1/responses` accept and enforce `max_output_tokens`?

- **Status:** Unconfirmed.
- **Claim:** vLLM's docs list `/v1/responses` but do not name the output-length field for it.
- **How to confirm:** run the same request as C-001 against a vLLM server's `/v1/responses` and check `status` and `usage.output_tokens`.
- **Needs:** a machine running vLLM.

### C-003 — Does a local runner honour `options.num_ctx`, and how much memory does it reserve?

- **Status:** Partly confirmed. Two local models tested on this machine (2026-11-11, CPU only). The large-window question for a full-attention model is still open.
- **Honours `num_ctx`:** with `qwen3:0.6b`, a roughly 2,800-token prompt was cut to 130 tokens at `num_ctx` 256. So the runner truncates the input to the window.
- **Clamps above the model's own maximum:** with `qwen3:0.6b` (context 40,960), `num_ctx` 42,000 and 40,960 both reported `context_length` 40,960 and the same size, 5,500,211,034 bytes.
- **Reserves the cache up front:** with `bonsai-2:2b` (`qwen35`, `context_length` 262,144, a hybrid model), `/api/ps` size rose with `num_ctx`:
  - 8,192: 1,025,968,699 bytes
  - 32,768: 1,378,290,235 bytes
  - 65,536: 2,099,752,466 bytes
  - The server log's CPU KV buffer was 96, 384 and 768 MiB, which is exactly 12,288 bytes per token. The reserve happens at model load, not on demand.
- **The simple per-token formula overstates the cache for hybrid models.** Layers × KV heads × (key + value length) × 2 gives 49,152 bytes per token for this model. The log shows 12,288, because only 6 of its 24 layers keep a full-attention cache. Use the log figure, or count only the full-attention layers.
- **Not yet tested:** `num_ctx` 131,072 and 262,144 for this model, which the 6 GB budget blocked. The projected cache is 1.6 GB and 3.2 GB at those sizes. Whether the compute buffer also grows is unknown. And the clamp above `context_length` is untested on this model.
- **Why it matters:** the cache size depends on the model's architecture, not only on `num_ctx`. A full-attention model of similar size could need about 49 KB per token, which is about 12.9 GB at 262,144 tokens. So a model-specific check is needed before the server sends a large window to local runners.
- **How to reproduce:** `POST /api/chat` with `options.num_ctx`, read `GET /api/ps`, then unload with `POST /api/generate` and `keep_alive: 0`. Read the server log for the KV buffer size.
- **Needs:** the owner's machine, ideally with a GPU, to run the larger sizes. The compute buffer at those sizes is unknown.
- **Installed for testing on this machine:** `qwen3:0.6b`, `bonsai-2:2b` (911 MB) and `tev1:0.8b` (833 MB). `tev1:0.8b` refused chat requests ("does not support chat") and can be removed on request.

### C-004 — Does Ollama Cloud ignore `options.num_ctx`? Also: what does it say above the model's maximum?

- **Status:** Partly confirmed. Two cloud models probed (2026-11-11). The over-maximum message is still open.
- **Confirmed for:**
  - `beam` (advertised 1,048,576): a 2,846-token prompt had the same `prompt_eval_count` with `num_ctx` 256 as with none, and `num_ctx` 4,000,000 was accepted with a tiny prompt.
  - `minimax-m3.1-flash` (advertised 1,000,000): a 3,002-token prompt had `prompt_eval_count` 3,002 with `num_ctx` 256 and with none, and `num_ctx` 4,000,000 was accepted.
- **Still to check:** whether a prompt larger than the model's maximum is refused, and with what message. An Ollama issue (#16598, on a 358,007-token prompt against a 262,144 model) quotes `The prompt is too long: N, model maximum context length: M`. Not reproduced here.
- **How:** the same two calls as C-003, sent to `https://ollama.com/api/chat` with the `Authorization: Bearer <key>` header. Take the key from the owner's `config.json` (provider `ollama-cloud`) and do not write it anywhere else.
- **Caution:** a prompt above the model's maximum costs tokens. Ask the owner before running it.

### C-005 — Cause of the sub-agent's HTTP 400 "invalid params, context window exceeds limit"

- **Status:** Partly answered (2026-11-11). Two wordings of a context-limit 400 that names no window are now confirmed from Ollama Cloud, from different models: `invalid params, context window exceeds limit` (`minimax-m3.1-flash`, the original sub-agent failure) and `prompt too long; exceeded max context length by N tokens` (`gpt-oss:20b`, seen live in A-007). Both get one forced compaction and one re-send, and neither teaches a cap. Still unknown: whether other models or providers use other wording, and whether every occurrence of the original sub-agent failure is the minimax wording.
- **Observed:** 2026-11-11, a sub-agent on Ollama Cloud (`minimax-m3.1-flash`, session 522 in the owner's production copy). Its window was configured at 1,000,000 and the model advertises 1,000,000. `num_ctx` cannot be the cause (C-004). The Ollama path does not log the 400 body, so the real message is not on record.
- **Also observed:** the numberless message is not matched by the parser (`parseContextLimitFromError` returns `null` for it, checked 2026-11-11), so the sub-agent cannot learn from it.
- **How to confirm:** A-001 is done, so the body of the next Ollama 400 is logged. Read it in `logs/locopilot-debug.log` (`"phase":"error"`, `"layer":"adapter"`, `errorBody`), or reproduce it.
- **Needs:** the owner's logs or a reproduction on the owner's Ollama Cloud account.

### C-007 — Reasoning tokens count against `max_output_tokens`

- **Status:** Documented by OpenAI, not measured here.
- **Claim:** The OpenAI reference says the Responses output cap covers both visible and reasoning tokens. On a reasoning model, a summary or digest cap could be spent on reasoning, leaving little or no visible text.
- **How to confirm:** send a reasoning model a request with `max_output_tokens` set to 64 and a prompt that needs thought. Check `usage.output_tokens_details.reasoning_tokens` and whether `output_text` is empty or cut off.
- **Needs:** a reasoning-capable model on any provider that serves `/v1/responses`.

### C-011 — Cause of the stale-tab freeze

- **Status:** Root cause unknown.
- **Claim:** An open browser tab stopped updating while the server kept streaming. Sub-agent output stopped rendering, and no error appeared in the tab. The server log shows the work continued, and the database later persisted a sub-agent error the tab never showed. Separately, a page refresh cancelled the running turn on the server (2026-11-11, about 00:34–00:52 UTC). The browser-side cause is not established. Session 712's tab was in the background at the time.
- **How to confirm:** the next time it happens, before refreshing, in DevTools: is the `/api/chat` request still pending, and is its EventStream still receiving frames? Check `document.visibilityState`. Compare the last frame's `seq` with the server's log.
- **Note:** a refresh cancels the running turn on the server. Don't refresh a stuck tab if the turn is still needed.

### C-012 — Title length does not depend on `numCtx`

- **Status:** Verified by reading the code; not run.
- **Claim:** The title route sets the input window to `min(window, 4096 or 8192)` and sends no output cap. Title length comes from the prompt's wording ("3 to 6 words", "under 55 characters"), temperature 0.2, and a hard cut at 80 characters (`src/services/titleGeneration.ts`).
- **How to confirm:** generate titles for the same conversation with two different windows (for example 8,192 and 1,000,000). Compare lengths and how often the 80-character cut applies. Expect no systematic change.

### C-013 — Compaction failed after a mid-turn switch to a small model with a 30,000 window

- **Status:** Observed, cause unknown.
- **Observed:** 2026-11-11, on the dev server. After a mid-turn switch to `qwen3:0.6b` (window 30,000), auto-compaction started with 4 messages and failed after about 21 seconds (`compaction_end` with `result: failed`). The error text is not in the log.
- **Seen again (2026-11-11, after Phase 2):** the same scenario, with the saved setting changed to 30,000 and the turn switched from `minimax-m3.1-flash` (Ollama Cloud) to `qwen3:0.6b`. `compaction_start` logged `numCtx` 30,000 with 4 messages, and `compaction_end` logged `result: failed`, `errorName: Error`, after 22.9 seconds. The log still carries no message, because `debugLog.diagnostic` writes only an error's name, code and status. A 4-message history is small, so "compaction failed to reduce history size" is a candidate, but that is a guess. It is not a 400: no adapter error was logged. The `qwen3:0.6b` turn that followed ran for more than two minutes until the test client was stopped.
- **Why it matters:** the switch itself worked (C-008). The failure is in the compaction path. Phase 2 now resolves the compaction window against the compaction model's own maximum, which did not change this outcome.
- **How to confirm:** the main loop's `compaction_end` failure diagnostic now carries `reason` (the first 300 characters of the error message). Repeat the scenario above and read it from `logs/locopilot-debug.log`. Then check whether the compaction prompt fits in the 30,000 window, and whether the 0.6B model returns usable output.
- **Needs:** the owner's Ollama, and the `qwen3:0.6b` model on this machine (already pulled).

### C-014 — For llama.cpp, which maximum is enforced: the trained context or the served window?

- **Status:** Mostly answered (2026-11-11). Three models tested live. One model (Muse-Glimmer) still needs a live check; the source predicts a result for it.
- **Result (live):** the enforced limit is the **served** window, not the trained context that `/v1/models` lists as `context_length`.
  - `Nemotron-3.5-Lightning-30B-A3B-UD-Q4_K_XL`: `context_length` 1,048,576, `--ctx-size 393216`, served `n_ctx` 393,216. A 429,927-token prompt was refused in about 1 second with `request (429927 tokens) exceeds the available context size (393216 tokens)`. The loaded `meta.n_ctx_train` also reads 393,216, which fits a YaRN rewrite (see the source below).
  - `Ornith-1.5-35B-A3B-Heretic-MTP-APEX` (no `--ctx-size`): `context_length` 262,144, served `n_ctx` 222,976 (sized by llama.cpp at load to fit memory). A 239,960-token prompt was refused with `exceeds the available context size (222976 tokens)`.
  - `Ornith-1.5-35B-A3B-Heretic-MTP-APEX-I-Quality` (`--ctx-size 262144`): served 262,144, equal to its `context_length`. This case does not discriminate.
- **Result (live):** a single 109,987-token prompt was accepted on the Nemotron model, which has 4 slots. A single request can use the whole served window.
- **Result (live):** the refusal's JSON body carries `"n_ctx"` with the enforced value (for example `"n_ctx":393216`). This is the most reliable value to read at request time.
- **Source (llama.cpp tag `b12124`, read by a research agent; the key check spot-verified by hand on 2026-11-11):**
  - The 400 is raised in `tools/server/server-context.cpp` around line 4081, by `slot.task->n_tokens() >= slot.n_ctx`, and the value is the per-slot context.
  - The per-slot value comes from `n_ctx_slot()` (line 5066): the smallest of the per-sequence context, `--kv-unified-per-slot` if set, and the trained context after any YaRN rewrite.
  - `context_length` in `/v1/models` is set from the GGUF key `<arch>.context_length` (`tools/server/server-models.cpp` around lines 2133–2225, and `common/common.cpp` around 1247). It ignores `--ctx-size`, RoPE and YaRN. That is why it differs from the served value.
  - With `--rope-scale` and YaRN, `src/llama-context.cpp` around 4383 sets `n_ctx_train` to `n_ctx_orig_yarn / rope_freq_scale`. For Nemotron, 262,144 / (1/1.5) = 393,216, which matches both its `--ctx-size` and its loaded `n_ctx_train`.
  - A `--ctx-size` above the trained context is accepted, but each slot is capped at the trained value (warning at `server-context.cpp` around 1464).
- **Predicted, not yet tested:** `Muse-Glimmer-30B-Q4_K_M` (`context_length` 131,072, `--ctx-size 262144`, no YaRN) should be enforced at **131,072**, because the trained value caps each slot. A request above 131,072 should be refused with `(131072 tokens)`.
  - The owner recalls that this model natively supports a 128K window, which is 131,072 tokens. That is consistent with the prediction, but it is the owner's recollection and has not been checked against the model card.
- **Still open:** the Muse load failed twice (HTTP 500, "failed to load") on 2026-11-11, and the router's logs are not reachable from here. To test the prediction, load it on the owner's router and send a prompt of about 140,000 tokens with `max_tokens: 1`.
- **Built in Phase 2 (2026-11-11):** `getLlamaCppServedWindow` in `src/services/llmContextLimit.ts`. A llama.cpp model is known only when its `/v1/models` entry has `meta.n_ctx` and its `status.value` is `loaded` (or there is no `status`, as on a plain llama-server). `context_length` and `n_ctx_train` are never used, and an unloaded model is unknown. Checked with fixtures, and through the real adapter mapping against a local test server (`tests/numctx-resolver.test.mjs`). **Not checked live against the owner's router**: it was not reachable from this machine on 2026-11-11 (HTTP 000 on `localhost:60300`). The resolver reads the served window from the model list, not from `GET /props?model=` or from a refusal's `n_ctx`; the refusal body is still learned from through its message.
- **Consequence for Phase 2 (as planned):**
  - `context_length` from `/v1/models` is not the maximum to clamp to for llama.cpp.
  - For a loaded model, read the served value from `GET /props?model=<name>` (`default_generation_settings.n_ctx`), or from the refusal's `n_ctx`.
  - For an unloaded model, the enforced value depends on `--ctx-size`, the trained context, and any YaRN rewrite. It is not reliably known before the model loads, so the resolver should treat it as unknown until then.
- **How to reproduce:** `POST /tokenize` with `{"model": "<name>", "content": "..."}` counts tokens exactly. Then send `POST /v1/chat/completions` with `max_tokens: 1` and a prompt just above the expected size. The error body names the enforced value.
- **Could not verify (per the research):** whether `GET /props?model=` loads an unloaded model, the owner's GGUF `rope_freq_scale_train`, and the `--parallel` behaviour on the owner's build. The owner's router log line "custom YaRN scaling detected" would confirm the YaRN rewrite.

---

## Pending actions

### A-001 — Log the response body for 400 errors on the Ollama path

- **Status:** Done in commit `5597e3d`. Verified live (a 400 from Ollama, "does not support chat", was logged with its body) and by `tests/ollama-error-log.test.mjs`.
- **What now happens:** both Ollama request paths log a 400's body as an adapter `error` diagnostic (`errorStatus`, `errorBody`, `requestId`, `model`). The body is cut to 1,000 characters. The user-facing message is unchanged.
- **To use it:** search `logs/locopilot-debug.log` for `"phase":"error"` with `"layer":"adapter"`. The `requestId` matches the chat turn.
- **Not covered:** a compaction failure that is not an HTTP 400 (C-013) still has no error text. The sub-agent's own error path logs the status, not the body.

### A-002 — Deploy the recent commits to the production copy

- **Status:** Not done.
- **Why:** the production copy at `C:\git\Locopilot - HeylonHome` is still on `e7429a4`. The context window commits are not there yet: `96adf4f` (stop inventing a context window), `b36a272` (retry and mid-turn switches use the current setting), and the four Phase 2 commits (`82e9af9`, `d9998f9`, `2c9ada8`, `2a91199`). Phase 2 changes behaviour the owner will see: providers with their own `numCtx` (NVIDIA, Airia, OpenRouter) now apply it, and the bar shows "—" until the server answers.
- **How:** on that machine, pull `dev`, rebuild, restart, and check the status bar on a reloaded session.

### A-003 — Phase 2: the server owns the window

- **Status:** Done (2026-11-11), commits `82e9af9`, `d9998f9`, `2c9ada8`, `2a91199`. The plan and the places where the build differs from it are in `docs/context-window-phases.md`.
- **What it does:** one server resolver for `(provider, model)` (`src/services/contextWindow/resolveNumCtx.ts`, probe and cache in `src/services/capResolver.ts`); `GET /api/numctx`; no route reads `numCtx` from a request body; the page stops sending it and shows what the server reports; `/api/ps` is no longer a cap; probes time out after 10 s, failures are cached 60 s, successes and learned limits 5 minutes; compaction is resolved against its own model's maximum.
- **Decisions by the owner (2026-11-11), all applied:** a provider's own `numCtx` applies to chat and a provider without one takes the global setting (no Settings control for provider windows); an unknown maximum is shown as "model max unknown"; local runners get no new cap; the memory risk is accepted.
- **Live checks:** see the Confirmed section ("Phase 2 live checks"). One was blocked: llama.cpp (C-014).

### A-004 — Phase 3: robustness

- **Status:** Built (2026-11-11), committed as 6c13e14 and c646d82. What is in place: a missing `config.json` is created with defaults, and the window default is written only then; an unreadable one is refused everywhere and never overwritten (503, with the reason shown on screen); chat, compact, title and dump refuse a turn with no model chosen or no context size (409, with the reason); no server code defaults a window (`DEFAULT_NUM_CTX` removed); the numberless 400 gets one forced compaction and one re-send (see C-005).
- **Settings gap:** closed by A-006 (the Add provider form). Still open from this phase: the live check of the numberless 400 (A-007).
- **Plan and differences:** `docs/context-window-phases.md`.

### A-005 — Commit the missing-config log fix

- **Status:** Done, committed as `dc66b49`.
- **What:** `src/app/api/chat/route.ts` now logs `config_unavailable` when `loadConfig()` returns `null`. Before, the log sat only in the `catch`, and `loadConfig()` never throws, so a missing or unreadable config was not logged. A regression check is in `tests/context-window.test.mjs`.
- **Committed with:** the regression check in `tests/context-window.test.mjs`.

---

### A-006 — Settings cannot add a provider

- **Status:** Done (2026-11-11). The owner chose option (a): a small form in Settings.
- **What was built:** a Providers section at the top of Settings (`src/components/SettingsModal/ProviderSection.tsx`). It lists the providers by name, kind and address (never a key) and has an Add provider button. The button opens a dialog (`src/components/SettingsModal/AddProviderDialog.tsx`) that lists the providers again and holds the form: name, kind (Ollama or OpenAI-compatible), server address, an optional API key and an optional model. Adding calls `POST /api/providers`, which appends one validated entry to `config.json` on the server; it does not wait for the Save button. The dialog is not opened by itself when there is no provider. (First built as an inline form, open by default when there was no provider; moved into the dialog on 2026-11-11, see the changelog.)
- **Rules the server applies:** the id is made from the name and never reused; the address is stored without a trailing slash, and without a trailing `/v1` for an OpenAI-compatible server (the adapter appends `/v1` itself); a provider with the same name (any case) is refused; only name, kind, address, key and model are taken from the body; the response never carries the key (`hasApiKey` says whether one is stored); an unreadable `config.json` is refused and left alone.
- **Scope kept small:** add only. Editing or removing a provider, and setting a provider's own `numCtx`, are still done in `config.json`.
- **The key** is stored in `config.json` in plain text, as it always was. The field is masked on screen, and the page never receives a stored key back.

### A-007 — Live check of the numberless 400

- **Status:** Done (2026-11-11), with the owner's OK.
- **What was sent**, to `gpt-oss:20b` on Ollama Cloud, straight to the adapter (no chat route, so no auto-compaction in front of it):
  - a one-word ping: answered, and the provider counted 69 tokens for a 7-token prompt (a fixed overhead);
  - a calibration prompt: estimate 3,599 tokens, provider count 3,269, so about 0.89 provider tokens per estimated token plus about 62 of overhead;
  - one prompt with an estimate of about 155,000 tokens, aimed at about 5% over the model's 131,072-token window.
- **Result:** HTTP 400 with `prompt too long; exceeded max context length by 8397 tokens (ref: ...)`. This is NOT the minimax wording. The number is how far over the request was, not the size of the window (the estimate puts the window near 131,072, consistent with `/api/numctx`).
- **What changed because of it:** before, the classifier said `none` for this message, so a sub-agent or the main loop would have failed without compacting. The phrasing list in `src/services/llmContextLimit.ts` now has both wordings, with a test on the exact text, and a check that the 8397 is not read as a window.
- **Not done:** the excess could drive a smarter compaction target (compact by at least N tokens). The current retry compacts the way auto-compaction does.
- **Cost:** about 3,500 tokens for the ping and calibration, and one request of roughly 138,000 tokens that the provider rejected at its limit. Whether the provider billed a rejected request is unknown. The earlier `clef:27b` attempt (about 69,000 tokens) was a routing error: it is a decision model and only accepts `/v1/systemone`.

### A-008 — Live check of the Add provider dialog's submit path

- **Status:** Not done. The dialog was checked live on 2026-11-11 WITHOUT submitting, because a submit writes the owner's `config.json` at once.
- **Checked live** (dev server on port 3001, built-in browser): opened from Settings; Tab and Shift+Tab stay inside the dialog and wrap at both ends; Escape closes the dialog only and returns focus to the Add provider button; a backdrop click closes the dialog only; Settings' own Tab trap works afterwards; an empty submit shows "Enter a name for this provider." and "Enter the server address." and sends no `POST /api/providers`; no console errors.
- **Still to check:** adding a provider through the dialog. The list in the dialog and in Settings must refresh, the note must appear, the default model must be preselected when the provider lists it, and `config.json` must gain exactly one provider. With the owner's OK: rename `config.json` aside, start the dev server, add one provider, restore the file, and check its hash. The in-flight guard (Escape and the backdrop do nothing while a save runs) is also not exercised live.

### A-009 — Test fixtures in the repo-root `config.json`

- **Status:** Not done. Editing `config.json` needs the owner's OK; it is the owner's file.
- **What was found:** the repo-root `config.json` (git-ignored) holds providers that match the fixtures of `tests/provider-add.test.mjs`: `Router` (`https://api.example.com`, stored with the key the test uses), `Sneaky` (`http://sneaky:11434`), `Local-Ollama!` (`http://third:11434`), and `Local Ollama` (`http://localhost:11434`, id `local-ollama`). The file's mtime is 19:27 on 2026-11-11, before the current suite was run.
- **Verified:** the current suite leaves the file unchanged. Its SHA-256 prefix `770530678b06f6c5` was the same before and after `npm test -- tests/provider-add` and after the full `npm test`. The endpoint tests run in a temporary directory, as intended.
- **Not verified:** which earlier run wrote the fixtures, and whether `Local Ollama` is the owner's own provider (the owner may have added it during the live check of A-006). To settle it, compare with the earlier `scripts/test-provider-add.mjs` in git history and ask the owner.
- **Action with the owner's OK:** copy `config.json` aside, then remove the fixture providers by hand. Settings can add a provider but cannot remove one.

## Confirmed

- **OpenAI output-cap field.** `max_output_tokens` is the cap on the Responses API (`/v1/responses`) and covers visible and reasoning tokens. Chat Completions uses `max_completion_tokens`. Source: OpenAI API reference, read through a mirror on 2026-11-11 (`platform.openai.com` returned 403). The installed `openai` SDK (6.48.0) types agree.
- **The adapter's field.** The OpenAI-compatible adapter calls only `/v1/responses` and sends `max_output_tokens` (`openaiCompatibleAdapter.ts`). Verified in code on 2026-11-11.
- **Ollama and NVIDIA documentation.** Ollama's compatibility page and NVIDIA NIM's troubleshooting page both name `max_output_tokens` for `/v1/responses` (read 2026-11-11, medium to medium-high confidence). OpenRouter's docs do the same.
- **Ollama Cloud context lengths** from `/api/show`, 2026-11-11: `beam` 1,048,576; `minimax-m3.1-flash` 1,000,000.
- **`sessions.num_ctx`.** The column exists in the production database, every row is NULL, and nothing in `src` reads or writes it (verified 2026-11-11).
- **`/api/ps` as a cap.** Used only when the static `/api/show` probe returns nothing (`src/services/capResolver.ts`, step 3a). Verified in code on 2026-11-11.
- **Local Ollama model context (2026-11-11, this machine).** The local Ollama here has no local weights except `qwen3:0.6b`. Its other 13 tags are cloud proxies. Nine report a `context_length` through `/api/show`. Five return HTTP 410 "Gone", which means the upstream model has been retired, so they can't be used. Phase 2 must treat a retired model as "maximum unknown".
- **llama.cpp listing (2026-11-11).** Every model in the router reports a top-level `context_length`, loaded or not. Loaded models also report `meta.n_ctx` and `meta.n_ctx_train`. The `--ctx-size` argument is in `status.args`. See C-014 for why the two differ.
- **The context-limit parser on real text (2026-11-11).** `parseContextLimitFromError` returns 1,048,576 for NVIDIA's message (see C-006 below) and `null` for "invalid params, context window exceeds limit". `getModelContextLimitFromInfo` reads `.context_length` (empty architecture name) and `glm5.2.context_length` correctly.
- **C-006, NVIDIA over-limit error and limit (2026-11-11).** `nvidia/nemotron-3-ultra-550b-a55b` accepted about 997,000 input tokens and refused about 1,096,000 with `{"message":"This model's maximum context length is 1048576 tokens. However, your messages resulted in 1096287 tokens. Please reduce the length of the messages.","type":"Bad Request","code":400}`. The parser's first pattern matches it, so the learning path works for NVIDIA. The limit is 1,048,576, not OpenRouter's 262,144 or the owner's 300,000 setting. Only this model answered `/v1/responses` among the NVIDIA models tried (about 20 candidates; the rest returned 404).
- **C-008, retry and mid-turn switching (2026-11-11, dev server).**
  - Retry: after a simulated network failure with the setting at 300,000, Settings was lowered to 250,000 and Retry was pressed. The first request sent `numCtx` 300,000 and the retry sent 250,000.
  - Mid-turn switch: a turn with a 25-second PowerShell tool call was running. The saved setting was set to 30,000 through `PUT /api/config`, then the turn was switched to `qwen3:0.6b`. The `model_switched` status reported `tokenLimit` 30,000 and `modelContextLimit` 40,960. The 30,000 came from the saved setting, not from the 250,000 the turn started with.
- **C-009, config-failure logging (2026-11-11).** The page warns `Config could not be loaded (HTTP 500)` when `/api/config` fails, and the status bar stays at `42868/—` (window unknown). The server logs `config_unavailable` with `reason: config_null` when `config.json` is missing (confirmed after the fix in A-005).
- **C-010, load order (2026-11-11, browser).** With `/api/config` delayed 20 seconds through a local proxy, the session's count showed `42868/— tokens` and never 131072. The config arrived at 20.3 seconds and the bar then showed `42868/300000 tokens (14%)`.
- **Phase 2 live checks (2026-11-11, dev server and browser pane; the dev config was backed up and restored byte for byte afterwards).**
  - Local Ollama, `qwen3:0.6b`, setting 42,000: `GET /api/numctx` gave `requested` 42,000, `modelMax` 40,960, `effective` 40,960, `source: static`; the status bar read `0/40960 tokens (0%) (model max: 40,960)`.
  - NVIDIA (`nvidia/nemotron-3-ultra-550b-a55b`, setting 300,000): `modelMax: null`, `known: false`, `probeError: null`, so "model max unknown"; the bar read `0/300000 tokens (0%) (model max unknown)` and Settings read `300,000 (model max unknown)`.
  - Ollama Cloud, `minimax-m3.1-flash`, setting 2,000,000: the bar read `0/1000000 tokens (0%) (model max: 1,000,000)`. With the setting at 300,000 it showed `300000` with no label, because the maximum (1,000,000) is above the setting. `beam` gave 1,048,576. An unknown model gave `known: false` with `probeError: "Request failed with status code 404"`, and a second request was answered from the cache in about 20 ms.
  - Request body ignored: a chat request sent with `numCtx` 5,000 reported `tokenLimit` 300,000 (the saved setting) and `modelContextLimit` 1,048,576.
  - Load order: with `/api/numctx` delayed 5 seconds in the page, a model change in Settings showed `0/— tokens` for the whole wait and the window and label once the answer arrived. (The answer arrived about 10 seconds late in that run, although the server answered in 9 ms. The cause was not found; `/api/models` calls of 4 to 6 seconds were running at the same time. In an undelayed run the bar updated within the 3.5 seconds that were observed.)
  - Mid-turn switch: a turn on `minimax-m3.1-flash` was running a 20-second tool call, the saved setting was changed to 30,000 and the turn switched to `qwen3:0.6b`. The `model_switched` status reported `tokenLimit` 30,000 and `modelContextLimit` 40,960, as before Phase 2 (C-008). The compaction failure that followed is C-013.
  - A provider's own window beats the global setting: with the global setting at 42,000, `GET /api/numctx` for NVIDIA reported `requested` 300,000, and for Ollama Cloud (no window of its own) 42,000. A chat turn on NVIDIA reported `tokenLimit` 300,000 in its first `status` event.
  - Settings: changing Context Size to 77,000 on an Ollama Cloud model made the bar go from `0/42000` to `0/77000`, through a second `/api/numctx` request sent after the save.
  - Not run live: Retry after a failure (the stored body now has no window; a pin checks that Retry replays it unchanged), and llama.cpp (the router was down).
- **Phase 3 live checks (2026-11-11, dev server; the owner's `config.json` was renamed out of the way and restored, hash `bd44524e221e8ad5` confirmed afterwards).**
  - Missing file: the first `GET /api/config` created `config.json` with `providers: []`, `model: ""`, `numCtx: 131072`, and the default retry and web-search settings. Nothing else was written.
  - Fresh config, every model-using route: chat (SSE error), compact, title and dump each answered 409 "No model is set up yet. Open Settings and choose a model to start chatting." with no model call. `GET /api/numctx` and `GET /api/models` answered 400 (no provider).
  - Settings on a fresh config opens with Context Size 131072 and a model list holding only "Select a model...". No provider can be added (A-006).
  - Unreadable file (`{ "model": "broken", "providers": [ ` written in place): `GET` and `PUT /api/config`, chat and `/api/numctx` all answered 503 with "config.json exists but could not be read (it is not valid JSON ...). Locopilot will not overwrite it". The file's hash did not change. The page showed the same text on screen.
  - Cloud windows read from `/api/numctx` (metadata only, no inference): Ollama Cloud has 23 models, none unknown. Smallest: `clef:27b` 65,536 (a decision model, not a chat model), `gpt-oss:20b` and `gpt-oss:120b` 131,072, `gemma4:31b`, `kimi-k2.6`, `kimi-k2.7-code`, `nemotron-3-super`, `nemotron-3-ultra` 262,144, `minimax-m3` 512,000, `minimax-m3.1-flash` 1,000,000, `beam` and `deepseek-v4-pro:0813` 1,048,576.
- **Add provider, live (2026-11-11, dev server and browser; the owner's `config.json` was renamed aside and restored, hash `bd44524e221e8ad5` confirmed).**
  - From an empty config: Settings opened with the Providers section and the form open, and "No provider yet". An empty submit showed "Enter a name for this provider." and "Enter the server address."; `localhost` showed "That is not a valid address. For example: http://localhost:11434".
  - Adding "Local Ollama" (`http://localhost:11434/`, model `qwen3:0.6b`) saved the provider with the trailing slash removed, listed 17 models, and preselected `qwen3:0.6b`. `config.json` then held the provider, `numCtx` 131072 and no chosen model. After Save it held the model and `activeProviderId`, and the status bar read `0/40960 tokens (0%) (model max: 40,960)`. A chat request through the new provider reported `tokenLimit` 40960 and `modelContextLimit` 40960.
  - Ollama Cloud added with a dummy key: 23 models listed; the key was not on screen. (Ollama Cloud lists models without a key, so this did not exercise the failure path.)
  - A provider at an address with nothing listening (`http://127.0.0.1:9`): saved, with the note "was added, but it did not answer: connect ECONNREFUSED 127.0.0.1:9".
  - A second provider with the same name in a different case: refused inline, "A provider named ... already exists."
  - The owner's real config: Settings lists NVIDIA, Ollama Cloud and Airia with their kinds and addresses, no key on screen, and the form collapsed behind an Add provider button.
- **Numberless 400, live (2026-11-11, A-007).** `gpt-oss:20b` on Ollama Cloud answers chat (a ping returned, with the 16-token output cap spent on reasoning, so the reply text was empty). A prompt about 5% over its 131,072-token window was refused with HTTP 400 `prompt too long; exceeded max context length by 8397 tokens`. The classifier now treats it as `compact-only`; it names no window and teaches no cap. `clef:27b` (65,536) is a decision model and is not usable for chat.
