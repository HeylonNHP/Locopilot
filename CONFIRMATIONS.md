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

### C-003 — Does a local runner honour `options.num_ctx`, and what does it do above the model's maximum?

- **Status:** Partly confirmed. One small model tested on this machine (2026-11-11).
- **Confirmed here** with `qwen3:0.6b` on the owner's local Ollama:
  - A roughly 2,800-token prompt had `prompt_eval_count` 2,816 with no `num_ctx` and with `num_ctx` 4,096.
  - With `num_ctx` 256 the same prompt was cut to 130 tokens. So the local runner honours the window by truncating the input.
  - With `num_ctx` 42,000, above the model's `context_length` of 40,960, `/api/ps` reported `context_length` 40,960. So the local runner clamps `num_ctx` to the model's own maximum.
- **Still to check** on the owner's other machine:
  - A model whose trained context is large (262,144 or more). The clamp keeps the cache at the model's own maximum, which is still large. Check the memory the runner uses (`size` and `size_vram` in `/api/ps`).
  - Whether the clamp behaves the same for larger models.
- **How:** the same calls as before. Use `curl -s http://localhost:11434/api/chat -d '{"model":"<model>","stream":false,"options":{"num_ctx":256,"num_predict":1},"messages":[{"role":"user","content":"<about 2,000 tokens of text>"}]}'`, then read `/api/ps` while the model is loaded. Unload with `{"model":"<model>","keep_alive":0}` on `/api/generate`.
- **Needs:** a local Ollama install with the model pulled. The other machine is the place to test a large model.

### C-004 — Does Ollama Cloud ignore `options.num_ctx`? Also: what does it say above the model's maximum?

- **Status:** Partly confirmed. Two cloud models probed (2026-11-11). The over-maximum message is still open.
- **Confirmed for:**
  - `beam` (advertised 1,048,576): a 2,846-token prompt had the same `prompt_eval_count` with `num_ctx` 256 as with none, and `num_ctx` 4,000,000 was accepted with a tiny prompt.
  - `minimax-m3.1-flash` (advertised 1,000,000): a 3,002-token prompt had `prompt_eval_count` 3,002 with `num_ctx` 256 and with none, and `num_ctx` 4,000,000 was accepted.
- **Still to check:** whether a prompt larger than the model's maximum is refused, and with what message. An Ollama issue (#16598, on a 358,007-token prompt against a 262,144 model) quotes `The prompt is too long: N, model maximum context length: M`. Not reproduced here.
- **How:** the same two calls as C-003, sent to `https://ollama.com/api/chat` with the `Authorization: Bearer <key>` header. Take the key from the owner's `config.json` (provider `ollama-cloud`) and do not write it anywhere else.
- **Caution:** a prompt above the model's maximum costs tokens. Ask the owner before running it.

### C-005 — Cause of the sub-agent's HTTP 400 "invalid params, context window exceeds limit"

- **Status:** Unexplained.
- **Observed:** 2026-11-11, a sub-agent on Ollama Cloud (`minimax-m3.1-flash`, session 522 in the owner's production copy). Its window was configured at 1,000,000 and the model advertises 1,000,000. `num_ctx` cannot be the cause (C-004). The Ollama path does not log the 400 body, so the real message is not on record.
- **Also observed:** the numberless message is not matched by the parser (`parseContextLimitFromError` returns `null` for it, checked 2026-11-11), so the sub-agent cannot learn from it.
- **How to confirm:** do action A-001 (log the 400 body on the Ollama path), then read the body the next time it happens, or reproduce it.
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
- **Why it matters:** the switch itself worked (C-008). The failure is in the compaction path, which Phase 2 changes (compaction resolved against its own model's maximum).
- **How to confirm:** reproduce it, or do action A-001 and log the compaction error. Check whether the compaction prompt fits in the 30,000 window, and whether the 0.6B model returns usable output.
- **Needs:** the owner's Ollama, and the `qwen3:0.6b` model on this machine (already pulled).

### C-014 — For llama.cpp, is the model maximum the trained context or the served window?

- **Status:** Open. A decision is needed before Phase 2.
- **Observed:** the llama.cpp router (`localhost:60300`) reports two different numbers for the same model:
  - `context_length` on every entry (loaded or not) is the model's trained maximum. For example, `Nemotron-3.5-Lightning-30B-A3B-UD-Q4_K_XL` shows 1,048,576.
  - The served window is the `--ctx-size` argument in `status.args` for each model. For the same model it is 393,216. A loaded model also exposes `meta.n_ctx`, which matched its `--ctx-size` (262,144) for the one loaded model.
  - `Muse-Glimmer-30B-Q4_K_M` is the opposite: `context_length` 131,072 against a `--ctx-size` of 262,144.
- **Why it matters:** if Phase 2 takes `context_length` as the maximum, a 1,000,000-token setting on `Nemotron-3.5-Lightning` would be sent, but the server would refuse anything above 393,216. The served value is the one that is enforced. Confirm this on the server, not just in the listing.
- **How to confirm:** load one such model (on the owner's machine, where memory allows) and send a request just above `--ctx-size`. Read the error. Then compare with `meta.n_ctx` once it is loaded.
- **Needs:** the owner's llama.cpp router, and enough memory to load a 30B model.

---

## Pending actions

### A-001 — Log the response body for 400 errors on the Ollama path

- **Status:** Not done.
- **Why:** the OpenAI-compatible path logs a debug dump of every 400 body, but the Ollama path logs none. Without the body, C-005, C-006 and C-013 cannot be explained.
- **Where:** the Ollama adapter's error handling (`src/services/adapters/ollamaAdapter.ts`), the sub-agent error path (`src/tools/impl/subAgentTool.ts`), and the compaction error path (`src/services/compact/`).

### A-002 — Deploy the recent commits to the production copy

- **Status:** Not done.
- **Why:** the production copy at `C:\git\Locopilot - HeylonHome` is still on `e7429a4`. Commits `96adf4f` (stop inventing a context window) and `b36a272` (retry and mid-turn switches use the current setting) are not there yet.
- **How:** on that machine, pull `dev`, rebuild, restart, and check the status bar on a reloaded session.

### A-003 — Phase 2: the server owns the window

- **Status:** Decided, not built.
- **Decisions:** a provider's own `numCtx` applies to chat, and a provider without one takes the global setting. There is no Settings control for provider windows; they are set by editing `config.json`.
- **Scope:** one server resolver for `(provider, model)`; a `GET /api/numctx` endpoint; the page stops sending `numCtx`; `/api/config` probes the selected model rather than the provider's default; probes get timeouts; failures are cached for 30 to 60 seconds; `/api/ps` is no longer used as a cap; compaction is resolved against its own model's maximum.
- **Keep:** each caller keeps its own output cap at its call site. The title route's `min(window, 8192)` stays where it is.
- **Gated by:** C-014 (which maximum llama.cpp enforces), and the open part of C-003 (large local models).

### A-004 — Phase 3: robustness

- **Status:** Decided, not built.
- **Scope:** the config save writes the 131072 default only when it creates a fresh config file (saving an existing file writes only the fields the user changed); compaction on a numberless context-limit 400; removal of the server's `DEFAULT_NUM_CTX` fallbacks; resolver tests with a fake adapter.

### A-005 — Commit the missing-config log fix

- **Status:** Done in the working tree, not committed.
- **What:** `src/app/api/chat/route.ts` now logs `config_unavailable` when `loadConfig()` returns `null`. Before, the log sat only in the `catch`, and `loadConfig()` never throws, so a missing or unreadable config was not logged. A regression check is in `scripts/test-context-window.mjs`.
- **How:** commit both files after the owner's review.

---

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
