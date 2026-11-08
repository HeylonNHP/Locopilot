/**
 * orchestrate.ts
 *
 * Top-level compaction flow. Wires history splitting, tool distillation,
 * summary generation (single-shot or map-reduce) and result validation into the
 * public `compactHistory` entry point used by the web route, the chat route and
 * the sub-agent auto-compactor.
 */

import type { RecentFileRow } from '@/services/history';
import type { ChatMessage, LlmRequestContext } from '@/services/llm';
import type { ReasoningEffort } from '@/types/chatConfig';

import { debugLog } from '@/app/lib/debugLogger';
import { pinTokenCalibration, unpinTokenCalibration } from '@/services/tokenCalibration';
import { countMessagesTokens, countMessageTokens } from '@/services/tokenizer';
import { getAgentWorkingDirectory } from '@/tools/workingDirectory';

import type { CompactResult, CompactStats } from './types';

import { computeDistillCallCap, evaluateCompactionSizes } from './budget';
import {
  COMPACT_ACCEPTANCE_HEADROOM,
  formatWindowTrimNotice,
  MIN_SUMMARISE_TOKENS,
  SUMMARY_PREAMBLE,
  TOOL_DISTILL_EXTRA_CALLS_MAX,
} from './constants';
import { createDistillBudget, distillToolMessages, remainingDistillBudgetTokens } from './distill';
import { measureConversationTokens } from './measure';
import {
  attachRecentFilesMessage,
  buildRecentFilesMessage,
  computeBudgetForResult,
  pathsNamedInToolCalls,
  readRecentFileFromDisk,
  type RecentFileReader,
  type RecentFilesPlan,
} from './recentFiles';
import { produceConversationSummary } from './reduce';
import { buildToolNameMap } from './serialize';
import { findLatestUserMessageIndex, splitHistoryForCompaction } from './split';
import { computePreservedWindowBudget, planWindowTrim, type WindowTrimPlan } from './windowTrim';

/**
 * Compacts the provided conversation history by asking the LLM to summarise it.
 * Returns the new message array and stats comparing old vs new sizes.
 *
 * Large older histories are processed with a bounded map-reduce pipeline so no
 * single summarisation request can exceed the model's context window.
 *
 * @param ctx             - Per-request LLM context (provider, baseUrl, apiKey).
 *                          Threaded through every nested call so concurrent
 *                          compaction requests cannot clobber each other.
 * @param model           - Model name to use for summarisation.
 * @param messages        - Current conversation history (should include system prompt).
 * @param numCtx          - Context length to pass to the API.
 * @param onProgress      - Optional callback for live progress updates.
 * @param aggressiveFactor - >1 to force stronger compression.
 * @param remainingRetries - How many aggressive retry passes remain.
 * @param onStats         - Optional callback for token stats.
 * @param signal          - Optional AbortSignal.
 * @param reasoningEffort - Optional reasoning effort level forwarded to the
 *                          provider adapters for every compaction LLM call.
 * @param onTps           - Optional live tokens-per-second reporter, invoked
 *                          while the distillation and summarisation LLM calls
 *                          stream, so the UI can show compaction speed. Not
 *                          wired to the token-measurement call (it generates
 *                          at most one token, so it has no meaningful rate).
 * @param redactSecrets  - Whether secrets are redacted out of the tool
 *                          arguments AND the tool results that reach the
 *                          summariser. Defaults to true — the same default as
 *                          `Config.redactSecrets`, which the callers pass in.
 * @param focus          - The user's `/compact` note about what to keep —
 *                          text typed after the command, already normalised
 *                          to one line by `normaliseCompactionFocus`.
 *                          `undefined` on every automatic path, where it
 *                          adds nothing to the prompt.
 * @param systemPromptTokens - The tokens of the system prompt this history
 *                          will be sent with (`resolvedSystemPromptTokens`
 *                          inside the body, once it has been derived). It exists because the RETRY
 *                          recursion deliberately passes a history WITHOUT
 *                          the system row: `newMessages` is an assistant
 *                          summary plus preserved turns, and the caller
 *                          re-prepends its own system prompt afterwards. The
 *                          inner pass therefore cannot derive the number from
 *                          `messages` (it would compute 0 and understate the
 *                          real request by the whole system prompt — measured
 *                          at numCtx 32768 with a 12k system prompt: an inner
 *                          result of 22k passed the 29,491-token acceptance
 *                          budget while the true request was 34k, so the
 *                          route's overflow warning never fired). When absent,
 *                          the number is computed from the `system` rows of
 *                          `messages`.
 * @param recentFiles    - The files this session touched most recently, newest
 *                          first (usually `loadRecentFiles(sessionId, 12)`).
 *                          Their paths — and, when a file fits WHOLE in its
 *                          per-file budget, its contents — are re-injected as
 *                          an assistant message right after the summary, so
 *                          the model does not re-read the files it was working
 *                          on. The stub is built ONCE, after the size verdict
 *                          and after any retry, against the FINAL history's
 *                          budget, so it can neither cause a retry nor be lost
 *                          to one. `undefined` means "no stub" and is what
 *                          every sub-agent passes: their tool calls bypass
 *                          `fileTouchRecorder`, and the only session id in
 *                          reach there is the PARENT's — stamping the parent's
 *                          working set onto a sub-agent's prompt would be a
 *                          confident lie about files the sub-agent never
 *                          touched.
 * @param recentFilesRoot - The directory the excerpt reader is confined to.
 *                          The caller supplies it because only the caller can:
 *                          the confinement is the request's agent working
 *                          directory (`getAgentWorkingDirectory(scope)`), and
 *                          a stored path is absolute but says nothing about
 *                          which scope resolved it. Defaults to the process's
 *                          default working directory.
 *
 * The model's TOKEN CALIBRATION FACTOR is pinned for the whole compaction: the
 * before/after counts have to be measured with the SAME factor, or "did the
 * history shrink?" can flip mid-compaction — a second tab that finished a
 * request in between would move the factor between the two counts and the
 * verdict would compare two different scales. The pin nests (the retry pass
 * re-enters this function), and the samples the compaction's own requests
 * produce are queued and applied when the LAST pin is released.
 */
export async function compactHistory(
  ctx: LlmRequestContext,
  model: string,
  messages: ChatMessage[],
  numCtx: number,
  onProgress?: (message: string) => void,
  aggressiveFactor: number = 1,
  remainingRetries: number = 2,
  onStats?: (stats: CompactStats) => void,
  signal?: AbortSignal,
  reasoningEffort?: ReasoningEffort,
  onTps?: (tps: number) => void,
  redactSecrets: boolean = true,
  focus?: string,
  systemPromptTokens?: number,
  recentFiles?: RecentFileRow[],
  recentFilesRoot?: string
): Promise<CompactResult> {
  pinTokenCalibration(model);
  try {
    return await compactHistoryPinned(
      ctx,
      model,
      messages,
      numCtx,
      onProgress,
      aggressiveFactor,
      remainingRetries,
      onStats,
      signal,
      reasoningEffort,
      onTps,
      redactSecrets,
      focus,
      systemPromptTokens,
      recentFiles,
      recentFilesRoot
    );
  } finally {
    unpinTokenCalibration(model);
  }
}

/**
 * The compaction itself — the body of {@link compactHistory}, split out so
 * the calibration pin can wrap it.
 *
 * WHY it is a separate function: the pin has to be held across the WHOLE
 * pass, and a `try`/`finally` around this body would have meant re-indenting
 * several hundred lines — a diff in which a changed indent hides a changed
 * line. The pin lives in the thin exported wrapper above instead.
 */
async function compactHistoryPinned(
  ctx: LlmRequestContext,
  model: string,
  messages: ChatMessage[],
  numCtx: number,
  onProgress?: (message: string) => void,
  aggressiveFactor: number = 1,
  remainingRetries: number = 2,
  onStats?: (stats: CompactStats) => void,
  signal?: AbortSignal,
  reasoningEffort?: ReasoningEffort,
  onTps?: (tps: number) => void,
  redactSecrets: boolean = true,
  focus?: string,
  systemPromptTokens?: number,
  recentFiles?: RecentFileRow[],
  recentFilesRoot?: string
): Promise<CompactResult> {
  // The system prompt is NOT part of the compacted array (the caller injects
  // its own), but it IS part of every request the history is sent in — so it
  // is charged to the OLD count as well as the NEW one. `messages` carries its
  // own `system` rows, which `countMessagesTokens` already counts; only a
  // BORROWED count (the retry pass, whose array has no system row) has to be
  // added here. Doing it on both sides keeps the `aborted` verdict
  // (new >= old) comparing like with like: on the retry pass the history has no
  // `system` row, and charging the system prompt to the new count alone could
  // make a genuinely smaller history look like it did not shrink at all.
  //
  // ONE UNIT SYSTEM: both counts are CALIBRATED counts (the tokenizer's own
  // count is never compared against a token budget), and both are in the
  // `chat` class — the compacted history is the MAIN chat request's content,
  // so it is measured the way a chat request is shaped. The acceptance
  // boundary below is a share of the model's context window, which is
  // denominated in provider tokens, so the estimate has to be in provider
  // tokens too. (The summariser's own requests are measured in the
  // `summarise` class, in `reduce.ts`.)
  const systemMessages = messages.filter((message) => message.role === 'system');
  const resolvedSystemPromptTokens =
    systemPromptTokens ?? countMessagesTokens(systemMessages, model);

  // Both counts are LOCAL tokenizer estimates, never live requests: the
  // tokenizer is free (one cached encoder per model) and counts the same
  // bytes the request will carry. A live measurement is now only paid for
  // where it can change the outcome — see the size decision below.
  const oldTokenCount =
    countMessagesTokens(messages, model) +
    (systemMessages.length === 0 ? resolvedSystemPromptTokens : 0);

  // Filter out system messages — the system prompt is injected on-the-fly by
  // the caller and should not be preserved through compaction.
  const historyMessages = messages.filter((m) => m.role !== 'system');
  if (historyMessages.length === 0) {
    throw new Error('Cannot compact: conversation has no content beyond the system prompt.');
  }

  // Tool-call id → tool name, built from the FULL conversation (system rows
  // included: they never carry tool calls, so this is a superset of the
  // summarised slice). A tool result can outlive the assistant row that issued
  // it — the history split may bisect an assistant+tool block — so the name
  // has to be resolvable even when the owning assistant is not part of the
  // summarised slice.
  const toolNames = buildToolNameMap(messages);

  // ── Guard against degenerate empty-summary crash ─────────────────────────
  // Subagents (and any short-history code path) can reach this point with
  // messages === [system] — i.e. zero history beyond the system prompt.
  // splitHistoryForCompaction would then return an empty messagesToSummarise,
  // and the downstream estimate collapses to a tiny value. Callers already
  // refuse to compact when fewer than 4 messages exist; this guard is the
  // final safety net against a confusing near-zero-token estimate.

  let historySplit = splitHistoryForCompaction(historyMessages, model, numCtx, aggressiveFactor);

  // If the split leaves too little content to summarize, expand the summarised
  // section only when there is pre-anchor history to include. Otherwise keep
  // the anchored split and let the too-short guard abort compaction.
  const splitEstimate = countMessagesTokens(historySplit.messagesToSummarise, model);
  if (splitEstimate < MIN_SUMMARISE_TOKENS && historySplit.preservedRecentMessages.length > 0) {
    const anchorIndex = findLatestUserMessageIndex(historyMessages);
    if (anchorIndex > 0) {
      historySplit = {
        messagesToSummarise: historyMessages.slice(0, anchorIndex),
        preservedRecentMessages: historyMessages.slice(anchorIndex),
        preservedRecentTokens: countMessagesTokens(historyMessages.slice(anchorIndex), model),
      };
    } else if (anchorIndex < 0) {
      // No user anchor found — fall back to summarising the full history as a
      // last resort.
      historySplit = {
        messagesToSummarise: historyMessages,
        preservedRecentMessages: [],
        preservedRecentTokens: 0,
      };
    } else {
      // anchorIndex === 0: the first history message is the latest user prompt.
      // There is no pre-anchor history, but if the split left nothing to
      // summarise, fall back to summarising the whole history so we don't abort
      // with a confusing near-zero token estimate.
      if (historySplit.messagesToSummarise.length === 0) {
        historySplit = {
          messagesToSummarise: historyMessages,
          preservedRecentMessages: [],
          preservedRecentTokens: 0,
        };
      }
    }
  }

  const fullEstimate = countMessagesTokens(historySplit.messagesToSummarise, model);
  if (fullEstimate < MIN_SUMMARISE_TOKENS) {
    throw new Error(
      `The conversation history is too short to compact (~${fullEstimate} tokens). ` +
        'Continue the conversation and try /compact again when there is more context.'
    );
  }

  onProgress?.(
    `Preparing compaction: summarizing ${historySplit.messagesToSummarise.length} messages, preserving ${historySplit.preservedRecentMessages.length} recent messages`
  );

  // ── Distillation, PRESERVED WINDOW FIRST ────────────────────────────────
  //
  // WHY the window goes first: the window is what decides whether the
  // compacted result FITS. `newMessages` keeps it verbatim, so its oversized
  // tool outputs land in the result at full size; the older slice is already
  // bounded by the serialiser's per-result character cap and is only sent to
  // the summariser. Spending the call budget on the window is therefore what
  // turns the budget into a smaller RESULT, not just a cheaper summary
  // request.
  const distillCallCap = computeDistillCallCap(numCtx);
  // The PREFILL budget of this compaction: the total number of tokens its
  // distillation calls may read, across BOTH passes. The call cap bounds how
  // MANY calls there are; the budget bounds what they may COST — eight calls
  // at half a million tokens each is several windows' worth of prefill
  // inside one compaction.
  const distillBudget = createDistillBudget(numCtx);
  const recentDistill = await distillToolMessages(
    ctx,
    historySplit.preservedRecentMessages,
    numCtx,
    model,
    distillCallCap,
    onProgress,
    signal,
    reasoningEffort,
    onTps,
    distillBudget
  );
  distillBudget.usedTokens += recentDistill.prefillTokens;
  const preparedRecentMessages = recentDistill.messages;

  // The older slice gets whatever the window did not spend — the CALL budget
  // and the PREFILL budget, both of them.
  //
  // WHY the CALLS MADE and not the calls that succeeded: a call that failed
  // still cost a model call (and its prefill), so it spends the cap. Counting
  // only the successes would let a flaky provider push the compaction past
  // its call budget.
  const historyDistill = await distillToolMessages(
    ctx,
    historySplit.messagesToSummarise,
    numCtx,
    model,
    Math.max(0, distillCallCap - recentDistill.attemptedCount),
    onProgress,
    signal,
    reasoningEffort,
    onTps,
    distillBudget
  );
  distillBudget.usedTokens += historyDistill.prefillTokens;
  const preparedHistoryMessages = historyDistill.messages;

  const skippedDistillations = recentDistill.skippedCount + historyDistill.skippedCount;
  const orphanDistillations = recentDistill.orphanCount + historyDistill.orphanCount;
  const budgetStoppedDistillations =
    recentDistill.budgetSkippedCount + historyDistill.budgetSkippedCount;
  const failedDistillations = recentDistill.failedCount + historyDistill.failedCount;
  const candidateDistillations = recentDistill.candidateCount + historyDistill.candidateCount;
  const distilledTotal = recentDistill.distilledCount + historyDistill.distilledCount;
  const prefillTokens = recentDistill.prefillTokens + historyDistill.prefillTokens;

  // The summary line is ALWAYS emitted, not only when something was left
  // behind: these numbers are the only record of what the distillation cost
  // and of what it did NOT manage to do, and a compaction whose distillation
  // silently did nothing is the case that has to be visible.
  onProgress?.(
    `Tool distillation: distilled ${distilledTotal} of ${candidateDistillations} oversized tool ` +
      `output(s) (~${prefillTokens} tokens of prefill of a ${distillBudget.totalTokens}-token budget; ` +
      `${failedDistillations} call(s) failed and stay verbatim)`
  );

  if (skippedDistillations > 0 || orphanDistillations > 0 || budgetStoppedDistillations > 0) {
    // WHY the orphan clause: `skippedCount` is what the CALL CAP left verbatim,
    // and a `tool` row whose owning assistant is not in the slice is never a
    // candidate for the cap — it is passed through because distillation could
    // not legally touch it. Reporting only `skippedCount` as "what stays
    // verbatim" was therefore untrue of the window as a whole.
    const verbatimParts: string[] = [];
    if (skippedDistillations > 0) {
      verbatimParts.push(
        `${skippedDistillations} oversized tool output(s) the call cap left verbatim ` +
          `(${recentDistill.skippedCount} in the preserved window, ${historyDistill.skippedCount} in the older history)`
      );
    }
    if (orphanDistillations > 0) {
      verbatimParts.push(
        `${orphanDistillations} oversized tool result(s) left verbatim because their assistant call is not in the same slice`
      );
    }
    if (budgetStoppedDistillations > 0) {
      verbatimParts.push(
        `${budgetStoppedDistillations} oversized tool output(s) left verbatim because the compaction's ` +
          `distillation prefill budget ran out`
      );
    }
    onProgress?.(
      `Tool distillation is capped at ${distillCallCap} model call(s) for a ${numCtx}-token context — ` +
        `${verbatimParts.join('; ')}.`
    );
  }

  // Generate the summary: single-shot when it fits, bounded map-reduce when the
  // older history exceeds the safe input budget.
  //
  // The REAL preserved-recent token count goes down with it: the summariser
  // used to be told "0 estimated tokens" while the prompt also claimed that
  // the summary was the only record of the older turns — a prompt that
  // contradicts itself, and that misinforms the model about what it has to
  // write down.
  //
  // The count is the RAW one: it is measured by the splitter, BEFORE the
  // distiller has replaced the large tool outputs of the preserved window
  // with digests, so it OVERSTATES the window. The prompt says exactly that
  // ("the count is measured before tool outputs are distilled, so it can
  // overstate the window") and does not claim the preserved turns are
  // verbatim — their large tool outputs arrive as digests.
  const summary = await produceConversationSummary(
    ctx,
    model,
    numCtx,
    aggressiveFactor,
    preparedHistoryMessages,
    onProgress,
    signal,
    reasoningEffort,
    onTps,
    toolNames,
    redactSecrets,
    historySplit.preservedRecentTokens,
    focus
  );

  // Rebuild the message history: a single assistant message holds the preamble
  // + summary, followed by the distilled recent messages.
  const summaryMessage: ChatMessage = {
    role: 'assistant',
    content: `${SUMMARY_PREAMBLE}\n\n${summary}`,
  };

  // The acceptance boundary is PURE — `floor(numCtx * headroom)` — and the
  // recent-files stub needs it BEFORE the result is assembled (the stub is only
  // allowed to spend what is left below it), so it is computed here and used
  // again further down for the retry/trim decision.
  const acceptanceBudget = Math.floor(numCtx * COMPACT_ACCEPTANCE_HEADROOM);

  // ── The result, WITHOUT the recent-files stub ─────────────────────
  //
  // The stub is re-attached BELOW, once, against the FINAL history. It is
  // deliberately not an input to anything that decides what the result is:
  //
  //   - The retry decision is taken on this array, so the stub can never be the
  //     reason a compaction re-summarises itself.
  //   - The retry recursion receives this array, which has no stub in it — so
  //     the summariser never sees a few thousand tokens of file heads as prose
  //     to compress, and the recursion does not have to know the stub exists.
  //   - The progress line is emitted only after the stub is IN the array that
  //     is returned, so "the files were re-attached" and "the returned messages
  //     carry them" cannot disagree.
  //
  // That ordering is the fix for a stub built too early. It used to be
  // assembled before the size verdict, and on a tight window one of two things
  // happened: a stub big enough to matter pushed the verdict into a retry — and
  // the retry, which deliberately did not forward the rows, came back with NO
  // stub at all after the user had been told the files were re-attached; or the
  // trim paid for the stub's tokens out of the preserved window, dropping turns
  // to fund a convenience.
  // The summary message the result carries, and the preserved window beside
  // it. The result is always `[summary, ...window]`, and BOTH halves are
  // reassembled whenever the window changes — the trimmer drops messages
  // from it, the extra distillation pass replaces rows in it.
  let resultSummary = summaryMessage;
  let resultWindow = preparedRecentMessages;
  // The index each row of `resultWindow` came from in the ORIGINAL preserved
  // window. The trimmer cuts a PREFIX of the window (and may hoist the anchor
  // to the front), so the two index spaces are NOT the same — and the extra
  // distillation pass has to know which rows are already digests IN THE INDEX
  // SPACE OF THE ARRAY IT IS ABOUT TO WALK.
  let resultWindowSources: number[] = preparedRecentMessages.map((_, index) => index);

  let newMessages: ChatMessage[] = [resultSummary, ...resultWindow];

  // The NEW count is a local estimate too — with ONE correction: the system
  // prompt is added to it. `newMessages` deliberately excludes the system
  // prompt (the caller re-prepends its own), while `messages` includes it, so
  // comparing the two raw counts made every compaction look smaller than it
  // really is by the size of the system prompt. That asymmetry is also why the
  // route's `stats.newTokenCount > effectiveNumCtx` overflow check
  // under-reports, so the stats stay on this corrected estimate and never mix
  // in a live measurement.
  //
  // The count comes from `resolvedSystemPromptTokens`, which the caller may
  // have PROVIDED: the retry recursion passes a history with no `system` row,
  // so deriving it here would compute 0 for the inner pass.
  let newTokenCount = countMessagesTokens(newMessages, model) + resolvedSystemPromptTokens;

  const verdict = evaluateCompactionSizes(oldTokenCount, newTokenCount, numCtx);

  if (verdict.aborted) {
    throw new Error(
      `Compaction failed to reduce history size (old: ${oldTokenCount}, new: ${newTokenCount} tokens). ` +
        'Aborting to avoid increasing context usage.'
    );
  }

  // If the compacted result still exceeds the context window (with headroom),
  // retry with a stronger factor that shrinks preservation budgets and summary
  // targets, forcing more aggressive compression. Bounded by remainingRetries.
  //
  // The estimate alone decides this UNLESS it lands inside the confirmation
  // band around the acceptance boundary, where a tokenizer's few-percent error
  // could flip the answer: only then is ONE live measurement paid for. The
  // measured figure is used for the decision only — `stats.newTokenCount`
  // stays the estimate, so the number the UI shows is always reproducible from
  // the stored history.
  //
  // WHAT the measurement actually measures — not the request shape, an
  // APPROXIMATION of it: the same messages, with `tools: []` and with NO
  // post-compaction nudge (the caller appends that after compaction), so it
  // can under-count by the size of the tool schemas. It is a prompt-eval
  // count of the conversation text only; it exists to break a tie the local
  // tokenizer cannot, not to certify the next request.
  let shouldRetry = verdict.retry;
  let confirmedTokenCount: number | undefined;
  if (verdict.confirm) {
    // A borrowed system prompt (the retry pass) cannot be sent with the
    // measurement — the text is not in this array — so its tokens are added to
    // whatever the provider (or the fallback estimate) reports.
    const borrowedSystemPromptTokens = systemMessages.length === 0 ? resolvedSystemPromptTokens : 0;
    confirmedTokenCount =
      (await measureConversationTokens(
        ctx,
        [...systemMessages, ...newMessages],
        model,
        numCtx,
        onProgress,
        signal,
        reasoningEffort
      )) + borrowedSystemPromptTokens;
    shouldRetry = numCtx > 0 && confirmedTokenCount > acceptanceBudget;
  }

  // ── Drop the oldest preserved messages BEFORE re-summarising ──────────────
  //
  // WHY this comes before the retry: the retry re-enters `compactHistory` on
  // the ALREADY-compacted array, so its summary is a summary of a summary —
  // the first pass's paraphrase, compressed again, with no dialogue left to
  // check it against. The preserved window is the cheap way out: it is only
  // older recent turns, dropping its oldest end costs context but not
  // FIDELITY, it costs no model call, and it works when `remainingRetries` is
  // already 0.
  //
  // The budget for the window is what the acceptance boundary leaves once
  // everything the result can NOT drop has been paid for: the summary message
  // (preamble + summary + notice) and — the part that used to be missing — the
  // SYSTEM PROMPT. The post-trim total below INCLUDES the system prompt and is
  // what `shouldRetry` compares against `acceptanceBudget`; a planner that
  // never paid for it trimmed until the WINDOW fitted, the total stayed over by
  // exactly the system prompt, and the summary-of-a-summary recursion fired
  // anyway. See `computePreservedWindowBudget` for the measurement.
  //
  // The notice is charged at its WORST CASE (every
  // preserved message dropped), so the budget is fixed before the planner runs
  // instead of depending on how much it ends up dropping — a notice that only
  // shows up after the trim would otherwise push the result a few tokens back
  // over the boundary and trigger the re-summary this whole block exists to
  // avoid.
  let trim: WindowTrimPlan | undefined;
  if (shouldRetry) {
    // The header the trim charges is the SUMMARY alone. The stub is attached
    // afterwards, out of whatever room the trimmed result leaves — so it can
    // never cause a preserved turn to be dropped to fund it, and the planner
    // is still not allowed to drop anything it cannot see.
    const headerTokens = countMessagesTokens([summaryMessage], model);
    const noticeTokens = countMessageTokens(
      {
        role: 'assistant',
        content: formatWindowTrimNotice(preparedRecentMessages.length),
      },
      model
    );
    const windowBudget = computePreservedWindowBudget({
      acceptanceBudget,
      headerTokens,
      noticeTokens,
      systemPromptTokens: resolvedSystemPromptTokens,
    });
    const trimPlan = planWindowTrim(preparedRecentMessages, windowBudget, model);
    if (trimPlan.droppedCount > 0) {
      resultSummary = {
        ...summaryMessage,
        content: `${summaryMessage.content}${formatWindowTrimNotice(trimPlan.droppedCount)}`,
      };
      resultWindow = trimPlan.messages;
      resultWindowSources = trimPlan.keptIndices;
      newMessages = [resultSummary, ...resultWindow];
      newTokenCount = countMessagesTokens(newMessages, model) + resolvedSystemPromptTokens;
      shouldRetry = numCtx > 0 && newTokenCount > acceptanceBudget;
      trim = trimPlan;
      onProgress?.(
        `Dropped the ${trimPlan.droppedCount} oldest preserved message(s) (~${trimPlan.droppedTokens} tokens) ` +
          `to make room — the history was trimmed rather than re-summarised.${
            shouldRetry
              ? ` Still ${newTokenCount} tokens against a ${acceptanceBudget}-token target.`
              : ''
          }`
      );
    }
  }

  // ── Spend the leftover distillation budget BEFORE re-summarising ─────────
  //
  // WHY here, and nowhere else: this is the one point where the compaction
  // KNOWS the result does not fit — the trim has been tried and was not
  // enough — and the only lever left that does not cost FIDELITY. The retry
  // recursion re-summarises the ALREADY-compacted array (a summary of a
  // summary, the worst quality leak in the pipeline) and the trim has already
  // dropped everything it may drop.
  //
  // WHY the WINDOW and not the older slice: the preserved window is kept
  // VERBATIM in the result, so digesting its tool outputs shrinks the result
  // DIRECTLY and needs NO extra summariser call. Digesting the older slice
  // would shrink the SUMMARY's input instead — which would need a whole extra
  // summarisation pass, the exact cost this block exists to avoid.
  //
  // WHY the leftover budget is worth spending: the call cap saturates at 8,
  // but the prefill budget is ONE WINDOW. At a 262 144-token window the two
  // bind together (eight calls at ~32 000 tokens each is the whole budget),
  // but at a 1 048 576-token window the CAP binds FIRST — eight calls spend
  // ~258 000 of 1 048 576 tokens, so ~790 000 tokens of the budget went
  // UNSPENT while the oversized outputs that were not digested stayed
  // VERBATIM in the window. A verbatim tool output in the result is exactly
  // what makes it too big, so the leftover budget is worth more spent than
  // idle.
  //
  // THE BUDGET IS THE SAME BUDGET: `distillBudget.usedTokens` is charged with
  // the extra calls, so the total prefill of ONE compaction still respects
  // `computeDistillPrefillBudgetTokens(numCtx)`. The call ceiling
  // (`TOOL_DISTILL_EXTRA_CALLS_MAX`) is the other bound — it keeps the
  // latency of the extra spend finite.
  let extraDistillSummary: { distilledCount: number; prefillTokens: number } | undefined;
  if (shouldRetry) {
    // The rows the FIRST window pass already dealt with, in the index space
    // of the window that is about to be walked:
    //
    // - the ones it turned into DIGESTS: a digest must never be distilled
    //   again — a digest is the model's own answer about the output and can
    //   be LONGER than the output it replaced, so distilling it again would
    //   make the window BIGGER.
    // - the ones whose call FAILED: a failure is not retried here. The
    //   provider that just refused the request will refuse it again, and the
    //   extra spend may make up to 32 calls — a failing provider would cost
    //   32 more failures for nothing.
    //
    // What is left is exactly the set the extra spend targets: the oversized
    // outputs the call cap or the prefill budget never ATTEMPTED.
    const digestedRows = new Set<number>();
    const failedRows = new Set<number>();
    const sourcePositions = new Map<number, number>();
    resultWindowSources.forEach((source, position) => {
      sourcePositions.set(source, position);
    });
    for (const source of recentDistill.distilledIndices) {
      const position = sourcePositions.get(source);
      if (position !== undefined) {
        digestedRows.add(position);
      }
    }
    for (const source of recentDistill.failedIndices) {
      const position = sourcePositions.get(source);
      if (position !== undefined) {
        failedRows.add(position);
      }
    }
    const handledRows = new Set([...digestedRows, ...failedRows]);

    const leftoverBudgetTokens = remainingDistillBudgetTokens(distillBudget);
    const extraDistill = await distillToolMessages(
      ctx,
      resultWindow,
      numCtx,
      model,
      TOOL_DISTILL_EXTRA_CALLS_MAX,
      onProgress,
      signal,
      reasoningEffort,
      onTps,
      distillBudget,
      handledRows
    );
    // The SAME budget: the extra calls are charged against it, so the total
    // prefill of this compaction never exceeds
    // `computeDistillPrefillBudgetTokens(numCtx)`.
    distillBudget.usedTokens += extraDistill.prefillTokens;
    extraDistillSummary = {
      distilledCount: extraDistill.distilledCount,
      prefillTokens: extraDistill.prefillTokens,
    };

    if (extraDistill.distilledCount > 0) {
      // The digests are only KEPT when they made the result SMALLER: a digest
      // is the model's own answer about the output, and on a small output it
      // can be longer than the output itself. Spending the budget must never
      // make the result bigger.
      const digestedMessages = [resultSummary, ...extraDistill.messages];
      const distilledTokens =
        countMessagesTokens(digestedMessages, model) + resolvedSystemPromptTokens;
      if (distilledTokens < newTokenCount) {
        resultWindow = extraDistill.messages;
        newMessages = digestedMessages;
        newTokenCount = distilledTokens;
        shouldRetry = numCtx > 0 && newTokenCount > acceptanceBudget;
        onProgress?.(
          `Spent the leftover distillation budget on ${extraDistill.distilledCount} more oversized tool ` +
            `output(s) of the preserved window (~${extraDistill.prefillTokens} tokens of prefill) — the ` +
            `compacted history is ${
              shouldRetry
                ? `still over budget (${newTokenCount} tokens against a ${acceptanceBudget}-token budget)`
                : `now within budget (${newTokenCount} tokens against a ${acceptanceBudget}-token budget)`
            }.`
        );
      } else {
        onProgress?.(
          `Spent the leftover distillation budget on ${extraDistill.distilledCount} more oversized tool ` +
            `output(s) of the preserved window (~${extraDistill.prefillTokens} tokens of prefill) — but the ` +
            `digests were no smaller than the outputs they replace, so the window is unchanged.`
        );
      }
    } else if (extraDistill.candidateCount === 0) {
      // NOTHING LEFT TO SPEND ON. Two shapes reach this line: the window has
      // no oversized output at all, or every oversized output in it was
      // already distilled or already attempted (and failed).
      onProgress?.(
        failedRows.size > 0
          ? `No un-digested oversized tool output(s) left in the preserved window that the leftover ` +
              `distillation budget (~${leftoverBudgetTokens} tokens) may spend on — the only oversized ` +
              `output(s) left are ${failedRows.size} whose distillation call(s) failed, and a failure is not ` +
              `retried here.`
          : `No un-digested oversized tool output(s) left in the preserved window — the leftover ` +
              `distillation budget (~${leftoverBudgetTokens} tokens) has nothing to spend on.`
      );
    } else if (extraDistill.attemptedCount === 0) {
      // The leftover budget cannot pay for even ONE call — the candidates are
      // all bigger than what is left of the budget.
      onProgress?.(
        `The leftover distillation budget (~${leftoverBudgetTokens} tokens) cannot pay for another ` +
          `distillation call — ${extraDistill.candidateCount} un-digested oversized tool output(s) stay ` +
          `verbatim in the preserved window.`
      );
    } else {
      onProgress?.(
        `All ${extraDistill.attemptedCount} extra distillation call(s) failed — ${extraDistill.candidateCount} ` +
          `un-digested oversized tool output(s) stay verbatim in the preserved window.`
      );
    }
  }

  let retried = false;
  if (shouldRetry && remainingRetries > 0) {
    const retryFactor = Math.max(1.5, newTokenCount / (numCtx * 0.75));
    onProgress?.(
      `Compacted to ${newTokenCount} tokens but limit is ${numCtx} — ` +
        `retrying with ${retryFactor.toFixed(1)}x stronger compression (${remainingRetries} attempt(s) left)...`
    );
    // The recursion is handed the STUB-LESS array, and it does not receive the
    // rows: a second stub would be built on top of a first one, charged twice,
    // and — worse — the summariser would read a few thousand tokens of file
    // heads as part of the history it is compressing. The stub is attached
    // once, below, to whatever this returns.
    const retryResult = await compactHistory(
      ctx,
      model,
      newMessages,
      numCtx,
      onProgress,
      retryFactor,
      remainingRetries - 1,
      onStats,
      signal,
      reasoningEffort,
      onTps,
      redactSecrets,
      // The note survives the retry: a second pass re-summarises the
      // already-compacted array, which is exactly where a note the user cares
      // about would otherwise be lost — the retry's summary becomes the ONLY
      // record of the older turns, so it has to be told what matters too.
      focus,
      // The inner pass sees a history WITHOUT the `system` row, so it cannot
      // work the system prompt out for itself: pass the number through, or its
      // retry/confirm decision, its trim budget and its `stats.newTokenCount`
      // would all be short by the whole system prompt.
      resolvedSystemPromptTokens
    );
    retried = true;
    newMessages = retryResult.newMessages;
    newTokenCount = retryResult.stats.newTokenCount;
  }

  // ── The recent-files stub: built ONCE, against the FINAL history ──────
  //
  // WHY a stub at all: the summary replaces every `read_file` /
  // `patch_file` / `write_file` call of the summarised turns, so the model
  // loses the one cheap fact it had — WHICH files this session is working on —
  // and pays a full round of tool calls to get it back. `session_recent_files`
  // already remembers it (see `fileTouchRecorder.ts`), and the files are still
  // on disk, so the stub re-states the working set and — when a file fits WHOLE
  // in the per-file budget — reproduces it.
  //
  // WHY an ASSISTANT message between the summary and the window:
  //
  //   - NEVER a `user`-role row. `findLatestUserMessageIndex` anchors the next
  //     compaction on the latest real user message; a user-role stub would
  //     become that anchor, and on a second compaction in the same turn the
  //     REAL prompt (which sits earlier) would be summarised away.
  //   - Between the summary and the window it reads as one unit with the
  //     summary — "this is what came before" — and chronologically it is right
  //     (the excerpts are the files as they were at compaction time). After the
  //     window it would read as the newest event in the conversation, which
  //     invites the model to answer the content of a file instead of the user's
  //     request.
  //
  // The budget is charged against `newTokenCount` — everything the finished
  // result already carries, system prompt included — and capped by
  // `min(acceptanceBudget, oldTokenCount - 1)`, so the stub can never push the
  // result past the acceptance boundary, and never back to (or past) the size
  // of the history it replaced: that would trip the `aborted` verdict above and
  // throw "failed to reduce history".
  let recentFilesPlan: RecentFilesPlan | undefined;
  let recentFilesMessage: ChatMessage | undefined;
  if (recentFiles !== undefined && recentFiles.length > 0) {
    const budgetTokens = computeBudgetForResult({
      numCtx,
      acceptanceBudget,
      oldTokenCount,
      resultTokens: newTokenCount,
    });
    if (budgetTokens > 0) {
      // The reader is confined to the agent's working directory: the rows carry
      // absolute paths, but a path is only safe to READ if it is inside the
      // directory the session is allowed to work in (see
      // `readRecentFileFromDisk`).
      const root = recentFilesRoot ?? getAgentWorkingDirectory();
      const readExcerpt: RecentFileReader = (absPath) => readRecentFileFromDisk(absPath, root);
      const plan = await buildRecentFilesMessage({
        files: recentFiles,
        budgetTokens,
        model,
        redactSecrets,
        readExcerpt,
        // The files the preserved window ALREADY carries verbatim are named but
        // not reproduced: the window is several turns and usually contains the
        // `read_file` result the model itself asked for, so a second copy of
        // the same head is pure waste.
        inContextPaths: [...pathsNamedInToolCalls(newMessages, root)],
      });
      if (plan.text !== '') {
        recentFilesPlan = plan;
        recentFilesMessage = { role: 'assistant', content: recentFilesPlan.text };
        // The attach is a CHECKED step, not a `splice`: it returns `null` when
        // the stub would un-shrink the history or push it past the acceptance
        // boundary, and `null` is the only path on which nothing is claimed.
        const stubbedMessages = attachRecentFilesMessage({
          messages: newMessages,
          message: recentFilesMessage,
          model,
          systemPromptTokens: resolvedSystemPromptTokens,
          oldTokenCount,
          acceptanceBudget,
        });
        if (stubbedMessages === null) {
          recentFilesPlan = undefined;
          recentFilesMessage = undefined;
        } else {
          newMessages = stubbedMessages;
          newTokenCount = countMessagesTokens(newMessages, model) + resolvedSystemPromptTokens;
          const attached = recentFilesPlan;
          const included = attached.included.length;
          const filesSubject = included === 1 ? 'file' : 'files';
          // The line says WHAT was re-attached, because "paths only" and "with
          // excerpts" are very different amounts of context for the same count —
          // and it is emitted HERE, after the stub is in the array that is
          // returned, so the claim and the result cannot disagree.
          const shape =
            attached.dropped === 'none'
              ? 'with whole-file excerpts'
              : attached.dropped === 'unreadable'
                ? 'as paths only (none could be read)'
                : attached.dropped === 'oversize'
                  ? 'as paths only (too large to include whole)'
                  : attached.dropped === 'in-context'
                    ? 'as paths only (already in the preserved window)'
                    : 'as paths only (no room for excerpts)';
          onProgress?.(
            `Re-attached the ${included} most recently touched ${filesSubject} ${shape} (~${attached.tokensUsed} tokens).`
          );
        }
      }
    }
  }

  // Which method decided the retry is a diagnostic, not a stat: `CompactStats`
  // is what the UI shows and it must stay reproducible from the stored history.
  debugLog.diagnostic({
    layer: 'compact',
    phase: 'compaction_size',
    method: confirmedTokenCount === undefined ? 'local-estimate' : 'live-confirmed',
    numCtx,
    acceptanceBudget,
    oldTokenCount,
    estimatedNewTokens: newTokenCount,
    systemPromptTokens: resolvedSystemPromptTokens,
    ...(confirmedTokenCount === undefined ? {} : { confirmedNewTokens: confirmedTokenCount }),
    ...(recentFilesPlan === undefined
      ? {}
      : {
          recentFiles: {
            included: recentFilesPlan.included.length,
            tokens: recentFilesPlan.tokensUsed,
            dropped: recentFilesPlan.dropped,
          },
        }),
    ...(trim === undefined
      ? {}
      : {
          windowTrim: {
            droppedCount: trim.droppedCount,
            droppedTokens: trim.droppedTokens,
            stopReason: trim.stopReason,
          },
        }),
    ...(extraDistillSummary === undefined
      ? {}
      : {
          extraDistill: {
            distilledCount: extraDistillSummary.distilledCount,
            prefillTokens: extraDistillSummary.prefillTokens,
          },
        }),
    retried,
    retry: shouldRetry,
  });

  onStats?.({
    oldTokenCount,
    newTokenCount,
  });

  return {
    newMessages,
    stats: {
      oldTokenCount,
      newTokenCount,
    },
  };
}
