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
- **Needs:** a machine with llama.cpp built (`llama-server`) and a model. The owner's config points a provider at `http://localhost:60300`, which is a llama.cpp endpoint on the owner's home machine.
- **Source:** web check of the llama.cpp server README (master branch), 2026-11-11. The README describes the conversion but not the field.

### C-002 — vLLM: does `/v1/responses` accept and enforce `max_output_tokens`?

- **Status:** Unconfirmed.
- **Claim:** vLLM's docs list `/v1/responses` but do not name the output-length field for it.
- **How to confirm:** run the same request as C-001 against a vLLM server's `/v1/responses` and check `status` and `usage.output_tokens`.
- **Needs:** a machine running vLLM.

### C-003 — Local Ollama honours `options.num_ctx`

- **Status:** Owner's observation, not tested in this repository.
- **Claim:** The owner reports that local Ollama runners honour `num_ctx` on the owner's own hardware. Ollama Cloud does not (see C-004).
- **How to confirm** on a machine with local Ollama and a model pulled. Replace `<local model>` and use roughly 2,000 tokens of text as the message:
  ```bash
  curl -s http://localhost:11434/api/chat -d '{"model":"<local model>","stream":false,"options":{"num_predict":1},"messages":[{"role":"user","content":"<about 2000 tokens of text>"}]}'
  curl -s http://localhost:11434/api/chat -d '{"model":"<local model>","stream":false,"options":{"num_ctx":256,"num_predict":1},"messages":[{"role":"user","content":"<the same text>"}]}'
  ```
  If `prompt_eval_count` drops to about 256 in the second call (or the call errors), the local runner honours `num_ctx`. Then `curl -s http://localhost:11434/api/ps` while the model is loaded should show `context_length` equal to the value used.
- **Needs:** a local Ollama install with a model pulled.

### C-004 — Ollama Cloud ignores `options.num_ctx` (one model probed)

- **Status:** Partly confirmed. One model probed.
- **Claim:** Ollama Cloud ignores `options.num_ctx`. Probed with `beam` on 2026-11-11: a 2,846-token prompt reported the same `prompt_eval_count` with `num_ctx` 256 as with no `num_ctx`, with no error. `num_ctx` 4,000,000 was accepted for a tiny prompt. Because of this, the clamp to the model's maximum still matters for cloud models.
- **Still to check:**
  - Repeat the probe with another cloud model (for example `minimax-m3.1-flash`).
  - Check whether a prompt larger than the model's maximum is refused, and with what message. An Ollama issue (#16598, reported on a 358,007-token prompt against a 262,144 model) quotes `The prompt is too long: N, model maximum context length: M`. Not reproduced here.
- **How:** the same two calls as C-003, with `"model"` set to the cloud model, sent to `https://ollama.com/api/chat` with the `Authorization: Bearer <key>` header. Take the key from the owner's `config.json` (provider `ollama-cloud`) and do not write it anywhere else.
- **Caution:** a prompt above the model's maximum costs tokens. Ask the owner before running it.

### C-005 — Cause of the sub-agent's HTTP 400 "invalid params, context window exceeds limit"

- **Status:** Unexplained.
- **Observed:** 2026-11-11, a sub-agent on Ollama Cloud (`minimax-m3.1-flash`, session 522 in the owner's production copy). Its window was configured at 1,000,000 and the model advertises 1,000,000. `num_ctx` cannot be the cause (C-004). The Ollama path does not log the 400 body, so the real message is not on record.
- **How to confirm:** do action A-001 (log the 400 body on the Ollama path), then read the body the next time it happens, or reproduce it.
- **Needs:** the owner's logs or a reproduction on the owner's Ollama Cloud account.

### C-006 — NVIDIA NIM: its over-limit error text, and the real maximum of `nemotron-3-ultra`

- **Status:** Unconfirmed.
- **Claim:**
  - NVIDIA's `/v1/models` lists no context length.
  - OpenRouter lists `nvidia/nemotron-3-ultra-550b-a55b` at 262,144 tokens, and its `:free` variant at 1,000,000.
  - The owner's NVIDIA provider setting is 300,000 and is trusted until the API says otherwise.
  - The 400 parser (`src/services/llmContextLimit.ts`) recognises only `maximum context length is N tokens` and `exceeds the available context size (N tokens)`. NVIDIA's error text is unknown. If it matches neither, the learning path never fires.
- **How to confirm:** capture the body of the first context-size 400 from the NVIDIA provider (after A-001), and compare it with the two patterns. To check the real limit, send a request just above 262,144 tokens. That costs tokens, so ask the owner first.
- **Needs:** an NVIDIA API key (in `config.json`, provider `nvidia-openai`; do not copy it elsewhere).

### C-007 — Reasoning tokens count against `max_output_tokens`

- **Status:** Documented by OpenAI, not measured here.
- **Claim:** The OpenAI reference says the Responses output cap covers both visible and reasoning tokens. On a reasoning model, a summary or digest cap could be spent on reasoning, leaving little or no visible text.
- **How to confirm:** send a reasoning model a request with `max_output_tokens` set to 64 and a prompt that needs thought. Check `usage.output_tokens_details.reasoning_tokens` and whether `output_text` is empty or cut off.
- **Needs:** a reasoning-capable model on any provider that serves `/v1/responses`.

### C-008 — Retry and mid-turn switching work as designed, live

- **Status:** Unit checks pass (`scripts/test-context-window.mjs`). Not run live.
- **Claim:** Retry rebuilds `numCtx` from the setting as it is now. A mid-turn model switch reads the saved config for the window and ignores the turn's body value.
- **How to confirm:**
  1. Send a message with the setting at 1,000,000 on a provider that will fail (for example, a stopped local server). Lower the setting to 300,000 and press Retry. In DevTools, the replayed `/api/chat` request's payload should say `numCtx: 300000`.
  2. Start a turn and switch model in the status bar. The status event's `tokenLimit` should match the saved setting.

### C-009 — The `config_unavailable` diagnostic and the page warning fire

- **Status:** Coded, not run.
- **Claim:** The server logs a `config_unavailable` diagnostic when it cannot read the config, and the page warns in the console when `/api/config` fails. Neither has been exercised.
- **How to confirm:** on a scratch copy of the project (never the production copy), make `config.json` unreadable and send a chat request. Expect a `config_unavailable` line in `logs/locopilot-debug.log`. For the page, block `/api/config` in DevTools and reload; expect the console warning.

### C-010 — A saved session never shows 131,072 during load

- **Status:** Proven at reducer level (`scripts/test-context-window.mjs`), not forced in a browser.
- **Claim:** The earlier `276922/131072` display came from the load order: the session's saved count arrives before the config. The fix means the window stays unknown until the config arrives.
- **How to confirm:** in DevTools, block `/api/config`, then reload a saved session (`?session=<id>`). The status bar should show the count with the window unknown (`—`), never 131072. Unblock the request; the bar should then show the configured setting.

### C-011 — Cause of the stale-tab freeze

- **Status:** Root cause unknown.
- **Claim:** An open browser tab stopped updating while the server kept streaming. Sub-agent output stopped rendering, and no error appeared in the tab. The server log shows the work continued, and the database later persisted a sub-agent error the tab never showed. Separately, a page refresh cancelled the running turn on the server (2026-11-11, about 00:34–00:52 UTC). The browser-side cause is not established. Session 712's tab was in the background at the time.
- **How to confirm:** the next time it happens, before refreshing, in DevTools: is the `/api/chat` request still pending, and is its EventStream still receiving frames? Check `document.visibilityState`. Compare the last frame's `seq` with the server's log.
- **Note:** a refresh cancels the running turn on the server. Don't refresh a stuck tab if the turn is still needed.

### C-012 — Title length does not depend on `numCtx`

- **Status:** Verified by reading the code; not run.
- **Claim:** The title route sets the input window to `min(window, 4096 or 8192)` and sends no output cap. Title length comes from the prompt's wording ("3 to 6 words", "under 55 characters"), temperature 0.2, and a hard cut at 80 characters (`src/services/titleGeneration.ts`).
- **How to confirm:** generate titles for the same conversation with two different windows (for example 8,192 and 1,000,000). Compare lengths and how often the 80-character cut applies. Expect no systematic change.

---

## Pending actions

### A-001 — Log the response body for 400 errors on the Ollama path

- **Status:** Not done.
- **Why:** the OpenAI-compatible path logs a debug dump of every 400 body, but the Ollama path logs none. Without the body, C-005 and C-006 cannot be explained.
- **Where:** the Ollama adapter's error handling (`src/services/adapters/ollamaAdapter.ts`), and the sub-agent error path (`src/tools/impl/subAgentTool.ts`).

### A-002 — Deploy the recent commits to the production copy

- **Status:** Not done.
- **Why:** the production copy at `C:\git\Locopilot - HeylonHome` is still on `e7429a4`. Commits `96adf4f` (stop inventing a context window) and `b36a272` (retry and mid-turn switches use the current setting) are not there yet.
- **How:** on that machine, pull `dev`, rebuild, restart, and check the status bar on a reloaded session.

### A-003 — Phase 2: the server owns the window

- **Status:** Decided, not built.
- **Decisions:** a provider's own `numCtx` applies to chat, and a provider without one takes the global setting. There is no Settings control for provider windows; they are set by editing `config.json`.
- **Scope:** one server resolver for `(provider, model)`; a `GET /api/numctx` endpoint; the page stops sending `numCtx`; `/api/config` probes the selected model rather than the provider's default; probes get timeouts; failures are cached for 30 to 60 seconds; `/api/ps` is no longer used as a cap; compaction is resolved against its own model's maximum.
- **Keep:** each caller keeps its own output cap at its call site. The title route's `min(window, 8192)` stays where it is.

### A-004 — Phase 3: robustness

- **Status:** Decided, not built.
- **Scope:** the config save writes the 131072 default only when it creates a fresh config file (saving an existing file writes only the fields the user changed); compaction on a numberless context-limit 400; removal of the server's `DEFAULT_NUM_CTX` fallbacks; resolver tests with a fake adapter.

---

## Confirmed

- **OpenAI output-cap field.** `max_output_tokens` is the cap on the Responses API (`/v1/responses`) and covers visible and reasoning tokens. Chat Completions uses `max_completion_tokens`. Source: OpenAI API reference, read through a mirror on 2026-11-11 (`platform.openai.com` returned 403). The installed `openai` SDK (6.48.0) types agree.
- **The adapter's field.** The OpenAI-compatible adapter calls only `/v1/responses` and sends `max_output_tokens` (`openaiCompatibleAdapter.ts`). Verified in code on 2026-11-11.
- **Ollama and NVIDIA documentation.** Ollama's compatibility page and NVIDIA NIM's troubleshooting page both name `max_output_tokens` for `/v1/responses` (read 2026-11-11, medium to medium-high confidence). OpenRouter's docs do the same.
- **Ollama Cloud context lengths** from `/api/show`, 2026-11-11: `beam` 1,048,576; `minimax-m3.1-flash` 1,000,000.
- **`sessions.num_ctx`.** The column exists in the production database, every row is NULL, and nothing in `src` reads or writes it (verified 2026-11-11).
- **`/api/ps` as a cap.** Used only when the static `/api/show` probe returns nothing (`src/services/capResolver.ts`, step 3a). Verified in code on 2026-11-11.
