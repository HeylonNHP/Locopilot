# Compaction refactor plan (`src/services/compact/`)

Status: **Phases 0 and 1 done** (2026-11-12, branch `refactor/compaction`); Phases 2-5 not started. Built from four read-only reviews of the code and the tests; the claims the plan depends on were re-checked by hand.

Line numbers are as of commit `40f214d`. They are hints and shift as each step lands; the **symbol names are authoritative**.

## Progress

| Step                  | Commit      | Notes                                                                                                                                                                                         |
| --------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0.1 fake provider     | `c68cdf8`   | `tests/helpers/fakeOllama.mjs` (+ `enterScratchCwd`)                                                                                                                                          |
| 0.2 golden prompts    | `6740197`   | 23 prompts; a one-character prompt edit fails 13 cases                                                                                                                                        |
| 0.3 summary pipeline  | `3f27502`   | the round cap is reached through `reduceSummaryGroups` with 300 parts (302 requests); its transcript is too long to store, so it asserts the request count and the closing line               |
| 0.4 distill shell     | `2d1a198`   | also added `tests/helpers/compactionHarness.mjs`, shared by 0.3-0.5 (not in the plan)                                                                                                         |
| 0.5 orchestrate       | `b81b4c3`   | 16 scenarios at a 4096-token window; five breakages of `orchestrate.ts` each fail; the stub scenarios mask path-dependent token counts; the dead check in `compact-trim.test.mjs` is repaired |
| 0.6 unverified claims | this commit | `CONFIRMATIONS.md` C-015, C-016, C-017                                                                                                                                                        |
| 1.1 prompt overhead | `1edfabd` | `countPromptOverhead` replaces four copies; two orphaned docs merged |
| 1.2 recent files | `46488a2` | `computeRecentFilesBudget` removed (11 test call sites use `tests/helpers/recentFilesBudget.mjs`); comparator, path forms, `countLines` |
| 1.3 distill | `4af9c11` | the token-count fallback removed; alias locals; `largestFirst` |
| 1.4 owner walk | `9199d04` | `findOwningAssistantIndex` in `split.ts`, used by the split and the distiller |
| 1.5 fallback ladder | `802d597` | `planCompactionSplit` and `makeHistorySplit` in `split.ts`; `tests/compact-split-plan.test.mjs` |

What Phase 0 found that the plan did not expect:

- **The tiktoken "524,288 characters" claim is not reproduced** (C-016): ordinary text up to 4,000,000 characters counted without an error. Step 1.3 still holds, because it rests on the distiller's 112,000-character cap, and the invariant test from 0.4 pins that bound; but the claim in the `distill.ts` comment is now unexplained.
- **Counting a long run of one repeated character is quadratic** (C-017): 13.9 s at 160,000 characters. Out of scope for the refactor; it is a tokenizer change.
- **A retry whose pass gets a summary as big as the first one fails** with "failed to reduce history size" (the recursion re-summarises an already-compacted array). The retry scenarios therefore script a small answer for the retry's pass; the plan's retry rules are unchanged.
- **Some tests keep source-text checks that still pass** (for example `compact-budget:1391-1465`, `compact-focus:195-205`, `token-calibration:629-645`). Phase 3 and 4 replace them with the behavioural scenarios as the code they read moves.

What Phase 1 found that the plan did not expect:

- **The net saving in `src/` is small: 24 lines** (229 added, 253 removed, across seven files, counting the new helpers' doc comments). The plan's estimate for Phase 1 (about 100 lines) assumed the deletions would not be offset by the new shared helpers and their docs. The value of Phase 1 is fewer copies of the same logic (four prompt-overhead counts, two comparators, two path-form builders, two owner walks, seven hand-built splits) rather than fewer lines; the big line reductions are in Phases 2-4, where code leaves its files.
- **Decision 1 turned out to have no practical effect.** Sharing the owner walk makes a `null` entry in `tool_calls` "not the call" instead of a throw, but the tokenizer throws on a `null` tool call before the split runs, so the pipeline still fails there. The walk itself is tested.
- **The ladder's "anchor at index 0" case has one reachable sub-branch, not two.** The plain split never preserves index 0, so an anchor at 0 always triggers the anchor rescue, which leaves either nothing to summarise or at least `MIN_SUMMARISE_TOKENS`. The test for it uses the empty-slice case.
- **Counting `[]` is exactly 0**, so `makeHistorySplit` can always count; no special case for an empty window was needed.

## Goal and ground rules

Make the five large compaction files (`orchestrate.ts` 953 lines, `recentFiles.ts` 978, `summarize.ts` 852, `distill.ts` 790, `reduce.ts` 774) smaller and easier to change, **without changing what the compaction does**.

"Without changing" means, for every commit:

- the same requests reach the model (same system prompts **byte for byte**, same `num_predict`, same order of calls);
- the same passes run in the same order (preserved window distilled first, trim before retry, extra spend before retry, recent-files stub after the final verdict, one prefill budget shared across passes, the calibration factor pinned for the whole pass, the focus note carried into the retry);
- the same progress lines, diagnostics, receipts and returned messages.

Anything that would change behaviour is listed under [Out of scope](#out-of-scope-behaviour-changes-kept-for-later), even when it looks like an improvement.

Every commit must pass **full** `npm test` (not `npm test -- tests/compact`, which misses `tests/token-calibration.test.mjs` and its source checks on `distill.ts`, `summarize.ts` and `orchestrate.ts`), `npm run type-check`, and ESLint on the changed files, and add a `docs/CHANGELOG.md` entry (project rule). Work on a branch (`refactor/compaction`), one commit per numbered step.

## Where things stand (why the plan starts with tests)

- **`compactHistory` has no behavioural test.** Nothing calls it. `orchestrate.ts` is protected only by ~16 tests that read its source as text (`tests/compact-trim.test.mjs:605-833`, `tests/compact-budget.test.mjs:1391-1460`, `tests/compact-focus.test.mjs:195-205`, `tests/token-calibration.test.mjs:629-645`). They pin exact strings, call order and even indentation (`'\n    );'` slice terminators), so almost any move breaks them, and the "must not contain" ones pass silently once code leaves the file they read.
- **One of those checks already tests nothing.** `tests/compact-trim.test.mjs:813` slices from `'let newMessages: ChatMessage[] = [summaryMessage'`, which no longer exists (`orchestrate.ts:479` reads `[resultSummary, ...resultWindow]`); `indexOf` returns -1 and three "must not contain" assertions run on an empty string.
- **No test pins the summariser prompt bytes.** `tests/compact-prompt.test.mjs` compares the builder's output with itself (`PROMPT` is built by `buildCompactSystemPrompt`, line 196-199) plus substring checks; a changed space would pass.
- **Untested at runtime offline:** the map-reduce path (`reduceSummaryGroups`), `summariseMessages`/`streamSummary` (including the empty-answer retry), and the success path of the calibration sample. `distillToolMessages` is covered for failure (`compact-budget`) and tool names (`compact-distill-tool-name`), not for its request bodies or progress transcript.
- Every test imports compaction code by deep path (`../src/services/compact/X.ts`); none uses the barrel. Production imports go through `@/services/compact` (chat route, sub-agent tool, compact route, `types/sse.ts`) plus `/constants`, `/focus`, `/receipt`.
- Many `CLAUDE.md` line references into `orchestrate.ts` and `reduce.ts` are already a few lines stale (e.g. `orchestrate.ts:131` is 127, `orchestrate.ts:801` is 797, `reduce.ts:215` is 211, `reduce.ts:595` is 710-715).

## Rules that apply to every commit

1. **Source-text pins.** When a commit moves code that a source-text test reads, the same commit replaces that check with a behavioural assertion (Phase 0 adds the harnesses that make this possible) and deletes the text check. Any text check that survives gets a guard on its anchor (`expect(start).toBeGreaterThan(-1)`), so it can never pass on an empty slice again.
2. **Keep these literals where they are** (they are the subject of `tests/token-calibration.test.mjs:568-645`, and the calibration rule is safety-critical): the `recordTokenCalibrationSample(` call stays in `distill.ts` and in `summarize.ts`, inside its `try {`, with `class: 'summarise'` written inline in `summarize.ts`; `pinTokenCalibration(model)` / `unpinTokenCalibration(model)` stay in the `orchestrate.ts` wrapper with the `finally`. `candidate.splice(1, 0, params.message)` stays in `recentFiles.ts`.
3. **Imports.** A moved symbol is imported from its new home. The old module re-exports it only when a `src/` importer outside the folder needs the old path (none do today for the symbols that move). Tests update their import lines in the same commit. No duplicate import paths for one symbol.
4. **Comments.** The long WHY comments are part of the design record. Move them with the code; delete only rationale that is stated two or three times, keeping one copy per phase and treating `CLAUDE.md` as the canonical narrative.
5. `exactOptionalPropertyTypes` is on: keep the `...(x === undefined ? {} : { x })` spreads in request literals and diagnostics (a missing key and an `undefined` key differ to the adapters and to `toStrictEqual`).
6. Do not hoist calibrated token counts out of loops. They are only constant while `orchestrate.ts` holds the calibration pin; direct callers and tests run unpinned.

## Target layout

| File                         | Now | After (approx.) | Contents after                                                                                                                                                                                              |
| ---------------------------- | --- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `orchestrate.ts`             | 953 | ~280            | `CompactHistoryOptions`, `compactHistory` (pin wrapper), `runPinnedAttempt`, `compactOnce` (the phases in order)                                                                                            |
| `phases.ts` (new)            | —   | ~350            | `createPassEnv`, `distillPass`, `draftResult`, `confirmVerdict`, `trimPreservedWindow`, `planHandledWindowRows`, `spendLeftoverDistillBudget`, `attachRecentFilesStub`, `resultTokens`, `exceedsAcceptance` |
| `progressText.ts` (new)      | —   | ~90             | pure progress-line and diagnostic builders for the pass                                                                                                                                                     |
| `split.ts`                   | 339 | ~380            | + `makeHistorySplit`, `planCompactionSplit` (the "too short to summarise" ladder from `orchestrate.ts:250-293`), `findOwningAssistantIndex`                                                                 |
| `summarize.ts`               | 852 | ~300            | chunk summarisation, `streamSummary`, `summariseMessages`, `computeSummaryOutputAllowance`                                                                                                                  |
| `summaryPrompt.ts` (new)     | —   | ~330            | prompt text and builders (`summarize.ts:34-399`), pure                                                                                                                                                      |
| `reduce.ts`                  | 774 | ~330            | `produceConversationSummary`, `planSummarisationPrompt`, `reduceSummaryGroups` (loop)                                                                                                                       |
| `reductionParts.ts` (new)    | —   | ~240            | `ReductionPart`, batching, pairing, splitting, concatenation (pure)                                                                                                                                         |
| `distill.ts`                 | 790 | ~230            | IO shell: `distillOne`, calibration sample, `distillToolMessages`                                                                                                                                           |
| `distillPlan.ts` (new)       | —   | ~380            | budget, planners, truncation, request/digest builders, result assembly, notices (pure)                                                                                                                      |
| `recentFiles.ts`             | 978 | ~470            | selection, planner, budget, attach, path scan                                                                                                                                                               |
| `recentFilesRender.ts` (new) | —   | ~260            | rendering constants and renderers (pure)                                                                                                                                                                    |
| `recentFilesDisk.ts` (new)   | —   | ~130            | `readRecentFileFromDisk`, `isInsidePath`, binary extensions (the only real IO, security-sensitive)                                                                                                          |

Flat files, not sub-folders: the directory is flat today and every test imports by file name.

## Commit sequence

Phases 0-1 are independent of each other's files and can be reordered; Phases 2-4 depend on Phase 0.

### Phase 0: safety net (tests only, no `src/` change)

**0.1 Shared fake provider.** Add `tests/helpers/fakeOllama.mjs`: a `createServer` on `127.0.0.1:0` speaking Ollama `/api/chat`, which records each request body, routes by the system prompt (`TOOL_DISTILL_SYSTEM_PROMPT` → distil; `options.num_predict === 1` → measure; anything else → summary), and takes scripted replies (text, length, `prompt_eval_count`, HTTP 500, empty). Any other route gets a 404 that the helper records and the test asserts is empty, so an unexpected request fails loudly instead of hanging. Move `tests/compact-distill-tool-name.test.mjs` onto it. Follow the `process.chdir` into a `mkdtemp` directory pattern from `tests/subagent-transient-retry.test.mjs:21-25` so `debugLog` writes there, not into `logs/`.

**0.2 Golden prompts.** `tests/compact-prompt-golden.test.mjs` + `tests/fixtures/compact-prompts.golden.json`, generated at HEAD and compared with `toBe`; regenerate only with `LOCOPILOT_TEST_WRITE_GOLDEN=1` (mirrors the existing `LOCOPILOT_TEST_LIVE_WRITE_FIXTURE` pattern). Matrix: full prompt × `preservedRecentTokens` undefined/0/1234 × chunked or not × focus or none (12); short prompt ± focus; `buildReductionCombineSystemPrompt` ± focus; `buildSummarisationInput(...).messages` full and short; the web `buildCompactionPrompt` for attempts 1-3.

**0.3 Summary pipeline characterisation.** `tests/compact-summary-pipeline.test.mjs` on the fake provider (no `prompt_eval_count`; `resetTokenCalibration()` in `beforeEach`). Cases: one pass; chunked + reduction (server echoes its input so the pairing fallback and the `MAX_REDUCTION_ROUNDS` concatenation are reached); one empty answer (retry prefix and "Empty response — retrying…"); two empty answers (the error). Records request `messages`, `options.num_predict`/`num_ctx`/`temperature`, and every progress line, as a golden file. Each case must prove it took its branch: the chunked case asserts more than one chunk request and at least one reduction round; the round-cap case asserts the concatenation progress line.

**0.4 Distill shell characterisation.** `tests/compact-distill-shell.test.mjs`: one call succeeds with `prompt_eval_count` ≥ 1.2 × the estimate on a request of ≥ 2000 estimated tokens (otherwise the calibration rejects the sample and the check proves nothing), one returns 500. Pin the request bodies (`Tool name:` / `Tool output length:` header), the digest wrapper including the "only the first K chars were distilled" and empty-digest variants, the ordered progress transcript, and that `getTokenCalibration(model, 'distill')` moved after the success. Add the invariant `computeDistillInputMaxChars(n) + TOOL_DISTILL_SYSTEM_PROMPT.length + 512 < 524_288` over a table of windows (it guards step 1.3).

**0.5 Orchestrate characterisation.** `tests/compact-orchestrate.test.mjs` calling `compactHistory` against the fake provider, with `jest.spyOn(debugLog, 'diagnostic')`. Record, in order: request bodies, progress lines, every `compaction_size` payload (inner and outer pass), `newMessages`, `stats`. Scenarios: fits first time; confirm band (one measure call); trim only; extra digests kept / rejected (not smaller) / nothing to spend on / budget too small / all calls failed; retry carrying a focus note (the retry's summary request contains the focus line; the retry pass gets no recent files); recent-files stub attached and refused (files in a `mkdtemp` root); "too short to compact"; "failed to reduce".

- **Every scenario must prove it took its branch**, or it can pass as vacuously as the text checks it replaces (a "trim only" fixture with slightly wrong sizes would fit first time and still pass). Each asserts something only that branch produces: the `compaction_size` verdict and trim fields, the presence or absence of the measure request, and that branch's progress line.
- **Tuning the fixtures is the expensive part of Phase 0.** Window sizes, history sizes and scripted reply lengths have to be chosen so each branch is reached; Phases 2.5-4.2 depend on these scenarios, so do not skip any.
- **Determinism.** The stub renders relative ages (`formatRelativeAge`) and paths under the `mkdtemp` root: freeze the clock (`tests/helpers/fakeClock.mjs` or a `Date.now` spy), give the file rows fixed timestamps, and replace the temp root with a placeholder before comparing.

Fix the dead anchor at `compact-trim.test.mjs:813` and add `> -1` guards to every slice-based source check that remains.

**0.6 Record unverified claims** in `CONFIRMATIONS.md` (project rule), each with a way to check: (a) `reduce.ts:439` measures the reduction overhead with `numCtx: 200000` and the reduction prefix, not the real retry prefix, which may under-count at large windows; (b) the summariser's calibration sample (`summarize.ts:~528`) counts one blob of up to 0.6 × the window with no fallback, and a comment in `distill.ts:~363` says tiktoken throws above ~524,288 characters, so samples may be silently skipped at large windows.

### Phase 1: small deletions in the leaf modules

**1.1 `summarize.ts`.** Delete the two orphaned JSDoc blocks (`:350-372`, and `:603-616`, a copy of `:631-644`). Add `countPromptOverhead(system, userPrefix, model)` and use it in `countSummarisationPromptTokens`, `countRetryPromptTokens` and both halves of `reduce.ts`'s `countReductionRequestOverhead` (same inputs, same counts). Covered by `compact-budget` 140-290 and 0.2.

**1.2 `recentFiles.ts`.** Delete `computeRecentFilesBudget` (`:562-608`; no `src/` caller, production uses `computeBudgetForResult`): fold its `old − 1` rationale into `computeBudgetForResult`'s doc, rewrite its 11 test call sites through a local `budgetFor(...)` helper that sums the charges into `resultTokens` (a NaN sum still yields 0), and fix the doc links at `recentFiles.ts:21`, `:86` and `constants.ts:581`. Also: one `byRecencyThenPath` comparator (`:343-346`, `:369-370`), one `addPathForms(set, raw, root?)` (`:716-720`, `:784-789`), and the dead marker strip in `countLines` (`:434-441`). Covered by `compact-recent-files` and `compact-budget:1470-1580`.

**1.3 `distill.ts`.** Replace `countDistillRequestTokens` (`:359-386`, a fallback for a tokenizer failure the 112,000-character input cap makes unreachable) with `countRawMessagesTokens`; the surrounding `try` keeps the sample best-effort, and 0.4's invariant guards the assumption. Remove the alias locals (`:613-615`) and share one `largestFirst` comparator (`:244`, `:494`). Keep the empty-output guard (`:600-606`): it is defensive and cheap.

**1.4 `split.ts`: one owner walk.** Add `findOwningAssistantIndex(messages, toolIndex)`; `findOwningToolCall` (`distill.ts`) and `adjustSplitForToolBlockIntegrity` (`split.ts:70-84`) use it. Note: `split.ts` uses `tc.id`, so a `null` entry in a persisted `tool_calls` array throws there today; the shared helper uses `tc?.id` and treats it as "no owner" (see [Decisions](#decisions-for-you)). Add a test for that row.

**1.5 `split.ts`: the "too short to summarise" ladder.** Move `orchestrate.ts:250-293` into `planCompactionSplit(history, model, numCtx, factor)` with `makeHistorySplit(summarise, preserved, model)`; the "summarise everything" object built three times becomes one, and the slice is counted once instead of twice (same slice, same pinned factor). This is a move plus a merge of two identical branches, not a deletion of the rule. Unit tests: anchor > 0, anchor < 0, anchor = 0 with an empty and a non-empty slice, empty window.

### Phase 2: pure modules out (moves)

**2.1 `summaryPrompt.ts`.** Move `summarize.ts:34-399` plus a named `SUMMARY_RETRY_USER_PREFIX` (now inline at `:828`). Replace repeated rule text with `dataNotInstructionsRule(subject, container)`, `noInventionRule(subject)` and `RETURN_PLAIN_TEXT_LINE`, following the existing `exactnessRule(subject)` pattern; the "Target approximately…" and "Write ONE summary…" sentences differ by clause and stay as written. Proof: 0.2 stays green. Update `compact-prompt.test.mjs:81` imports.

**2.2 `reductionParts.ts`.** Move `reduce.ts:382-402` and `:471-634` verbatim (keep the `model` parameter). Extract `computeSummaryOutputAllowance(budget, numCtx)` from `summarize.ts:782-788` verbatim. Update `compact-budget.test.mjs:88-92` imports.

**2.3 `recentFilesDisk.ts`, then `recentFilesRender.ts`.** Disk: `:210-234`, `:867-978`. Render: `:142-197`, `:236-275`, the `ChosenFile` type, `:374-521`, plus a `describeRecentFilesShape(dropped)` `Record` over all six `RecentFilesDroppedReason` values that replaces the ternary at `orchestrate.ts:876-884` (`no-budget` and `no-files` both map to "as paths only (no room for excerpts)"). Covered by `compact-recent-files` (including the symlink test at `:1075`) and 0.5.

**2.4 `distillPlan.ts`.** Move `distill.ts:47-357` and `:430-502` (truncation, owner lookup, budget, planners, failure description, `planDistillation`). Point `compact-prompt.test.mjs:748-760` (`TOOL_DISTILL_TRUNCATION_MARKER`, no `rawDigest.slice(...)`) at `distillPlan.ts`, where `cutWithMarker` now lives. Update `compact-budget.test.mjs:85` imports.

**2.5 `progressText.ts`.** Move the pass's progress strings and the `compaction_size` diagnostic payload into pure builders (`formatPreparingLine`, `formatDistillationReport`, `formatTrimLine`, `formatExtraDistillOutcome`, `formatRetryLine`, `formatStubLine`, `buildSizeDiagnostic`). First add literal-string tests copied from today's templates. Replace the `'Re-attached the '` source check (`compact-trim:802`) with 0.5's progress transcript.

### Phase 3: options objects instead of long positional lists

**3.1 `CompactionLlmCall`** in `types.ts` (`ctx`, `model`, `numCtx`, `onProgress?`, `signal?`, `reasoningEffort?`, `onTps?`). `streamSummary`, `summariseMessages`, `summariseChunk` and `reduceSummaryGroups` take it; `SummariseChunkParams` extends it (keep `toolNames`, which the opt-in live test at `compact-prompt.test.mjs:1300` passes). `reduceSummaryGroups` + `reduceSummaryGroupsAtRound` (two 11-parameter lists, recursion) become one `while (summaries.length !== 1)` loop that checks the round cap first; `!== 1` keeps today's result for an empty list, and termination still comes from `batchReductionParts`' pairing fallback, unchanged. Covered by 0.3 and `compact-budget:296-400`.

**3.2 `produceConversationSummary(params: ConversationSummaryParams)`** (13 positional parameters today). The two identical nine-option bundles (`reduce.ts:296-312`, `:341-363`) become one `chunkBase`; `countSerializedHistoryTokens` replaces `:251-255` and `:334-338` (not `estimateSerializedMessageTokens`, which adds a separator and returns 0 for empty text); the short branch of `planSummarisationPrompt` (`:157-171`) calls `countRetryPromptTokens` (the builder reads the same fields, so the bytes are identical). Keep the identifiers `numCtx`, `aggressiveFactor`, `serializedEstimate`, `chunkSerializedEstimate` by destructuring. Update the call at `orchestrate.ts:416` and `compact-budget.test.mjs:240`; replace the source checks at `compact-summary.test.mjs:362-379` and `compact-focus.test.mjs:201` with 0.3/0.5 assertions.

**3.3 `distillToolMessages(options: DistillPassOptions)` and its pure core.** In `distillPlan.ts`: `computeDistillLimits`, `buildDistillRequest`, `buildDistilledMessage` (wrapper, cut marker, empty-digest fallback), `assembleDistillResult` (derives the counts from the index arrays), `formatDistillPassNotices`. In `distill.ts`: `distillOne(request, prefillTokens, deps)` (the call, the live t/s meter, the timeout, abort rethrow vs failure) and the calibration sample, still a literal `recordTokenCalibrationSample(` inside `try` with no `class` (default `'distill'`). The shell runs calls one at a time in plan order, emits "Distilled tool output k/N" after each success, then the failure and budget notices in today's order. Update the three call sites in `orchestrate.ts` (`:315`, `:337`, `:676`) and the five test call sites; replace the `'\n    );'` slice checks at `compact-trim:659-725` with 0.5 scenarios.

**3.4 `compactHistory(options: CompactHistoryOptions)`.** Public options: `llm`, `model`, `messages`, `numCtx`, `onProgress?`, `signal?`, `reasoningEffort?`, `onTps?`, `redactSecrets?`, `focus?`, `recentFiles?: { rows, root }`. Remove `onStats` (no caller supplies it, and the retry forwards it, so it would fire twice). `aggressiveFactor`, `remainingRetries` and `systemPromptTokens` leave the public API (every caller passes `1`, `2`, `undefined`) and become a private `CompactionAttempt` used by the retry; the retry calls `runPinnedAttempt(req, draft.messages, next)` with no files, so "the retry never re-reads files" holds by construction. Grouping `rows` with `root` removes the unused `?? getAgentWorkingDirectory()` default and orchestrate's `@/tools` import (the compact route already passes `getAgentWorkingDirectory()` itself). Update the three callers (`chat/route.ts:1646`, `compact/route.ts:307`, `subAgentTool.ts:516`). Keep `const { model } = req` inside the pin wrapper and a `systemPromptTokens` field name. Replace the source checks at `compact-budget:1391-1405`, `compact-focus:183-205` and `compact-trim:781` with 0.5 assertions; the caller regexes at `compact-summary.test.mjs:252-260` must still match (they check `redactSecrets ?? true`).

### Phase 4: orchestrate becomes a pipeline of named phases

**4.1 In place, inside `orchestrate.ts`:** `PassEnv` (read-only: request, system messages and tokens, old token count, acceptance budget, distill call cap, and the one deliberately mutable `DistillBudget`) from `createPassEnv`; `distillPass` (the call plus `usedTokens +=`, written three times today); `resultTokens(env, messages)` (`countMessagesTokens(...) + resolvedSystemPromptTokens`, four times); `exceedsAcceptance(env, tokens)` (`numCtx > 0 && tokens > acceptanceBudget`, three times; `budget.ts:189` uses a different finite check and is NOT merged, see Out of scope); `draftResult`. Each phase that tries to make the result fit returns a new `ResultDraft` (`{ summary, window, windowSources, messages, tokens, overBudget }`) instead of reassigning six `let`s. Replace the remaining literal checks (`compact-budget:1405`, `token-calibration:642`, `compact-trim:686-725`) with unit tests of `resultTokens` and `distillPass` plus 0.5's keep-only-if-smaller scenario.

**4.2 Move the phases to `phases.ts`.** `confirmVerdict` (`orchestrate.ts:521-539`), `trimPreservedWindow` (`:566-607`), `planHandledWindowRows` (`:655-673`, pure: remaps indices after a trim and for a moved anchor), `spendLeftoverDistillBudget` (`:639-754`), `attachRecentFilesStub` (`:797-897`). `orchestrate.ts` keeps `compactHistory`, `runPinnedAttempt` and `compactOnce`, which reads as the order: env → split → distil window → distil older slice → summary → draft → verdict → confirm → trim → spend → retry → stub → diagnostic. Replace the remaining ordering checks in `compact-trim` and the one-measure-call check (`compact-budget:1451`) with 0.5 scenarios and phase unit tests. Optionally keep one guarded ordering check on `compactOnce` (`trimPreservedWindow(` < `spendLeftoverDistillBudget(` < `runPinnedAttempt(` < `attachRecentFilesStub(`).

**4.3 Comments.** One WHY comment per phase; remove rationale repeated two or three times across `orchestrate.ts:445-465`, `:541-565`, `:609-616`, `:763-767`, `:797-825` (≈70 comment lines). The parameter JSDoc (`:46-126`) moves onto `CompactHistoryOptions`.

### Phase 5: docs

**5.1 `CLAUDE.md`.** In "How conversation compaction works", replace `file:line` references with symbol names (`compactOnce`, `distillPass`, `spendLeftoverDistillBudget`, `attachRecentFilesStub`, `produceConversationSummary`, `computeSummaryOutputAllowance`, `concatenateReductionParts`, ...) so they stop going stale, and mention the new modules. References into `budget.ts`, `split.ts`, `windowTrim.ts` and `constants.ts` are accurate today and can stay. `docs/CHANGELOG.md` gets one entry per commit as it lands.

## Expected outcome

|                                                     | Net lines deleted (approx.)        | Largest compaction file after |
| --------------------------------------------------- | ---------------------------------- | ----------------------------- |
| `orchestrate.ts` (+ `phases.ts`, `progressText.ts`) | ~140 (≈70 of it repeated comments) | `orchestrate.ts` ~280         |
| `summarize.ts` + `reduce.ts`                        | ~150-200                           | `reduce.ts` ~330              |
| `recentFiles.ts` + `distill.ts`                     | ~100                               | `recentFiles.ts` ~470         |
| **Total**                                           | **~390-440 of 7,307**              | no file above ~470            |

Most of the gain is structure, not line count: about half of each big file is design comments, which stay. The source shrinks by roughly 5-6 %; the five files over 770 lines become a set of modules none of which is above ~470, the pure parts become directly unit-testable, and the four functions with 11-16 positional parameters take options objects. The test suite grows (four new test files and a shared fake provider), and replaces about 25 brittle source-text checks with behavioural ones.

## Out of scope (behaviour changes, kept for later)

Each of these looks like duplication or a defect but would change what the compaction does; handle them as separate, deliberately behaviour-changing commits after the refactor:

- **Merging the two acceptance predicates.** `orchestrate.ts` uses `numCtx > 0 && t > acceptanceBudget`; `budget.ts:189` uses `Number.isFinite && > 0`. They differ for `Infinity`.
- **One streaming / tokens-per-second helper** for distill, summarize and the web content compactor. The three do not share a shape: summarize reports on every chunk (`sendLlmChatStream`), distill only on content chunks (`sendLlmChat` with a callback and a timeout), and the content compactor has no meter or calibration at all. Merging moves when `onTps` fires.
- **One calibration-recording helper.** The two blocks differ (class, counter, where the stats come from), the gain is ~12 lines, and it breaks the deliberate `token-calibration` source checks.
- **The `numCtx: 200000` overhead measurement** in `reduce.ts:439` and the summariser's large-window calibration sample: see step 0.6; fix after confirming.
- **Re-tokenising after attach** (`orchestrate.ts:~858` recounts what `attachRecentFilesMessage` just counted): fixing it changes attach's return type, which tests assert on.
- **`findOwningToolCall` runs twice per row** (planner and shell): harmless; pass the owner through the plan later if wanted.
- **A tool call id repeated inside one assistant turn:** `find` takes the first, `serialize.ts`'s map takes the last.

## Decisions for you

1. **`split.ts` and a `null` tool call (step 1.4).** Sharing the owner walk turns "throws on a malformed persisted `tool_calls` entry" into "treated as no owner". Recommended: accept it (it is the only behaviour change in the plan, and it can only turn a crash into a normal compaction); the alternative is to keep two walks.
2. **Source-text checks.** Recommended: replace them with behavioural tests as each move lands (rule 1). The alternative, re-pointing them at the new files, keeps them brittle and is more churn over the whole sequence.
3. **Commit granularity.** Recommended: the 24 numbered steps above as separate commits on `refactor/compaction`, merged to `dev` after Phase 4. Phases 0-2 are useful on their own if you want to stop early.
