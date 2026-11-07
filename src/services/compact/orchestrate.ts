/**
 * orchestrate.ts
 *
 * Top-level compaction flow. Wires history splitting, tool distillation,
 * summary generation (single-shot or map-reduce) and result validation into the
 * public `compactHistory` entry point used by the web route, the chat route and
 * the sub-agent auto-compactor.
 */

import type { ChatMessage, LlmRequestContext } from '@/services/llm';
import type { ReasoningEffort } from '@/types/chatConfig';

import { debugLog } from '@/app/lib/debugLogger';
import { countMessagesTokens, countMessageTokens } from '@/services/tokenizer';

import type { CompactResult, CompactStats } from './types';

import { computeDistillCallCap, evaluateCompactionSizes } from './budget';
import {
  COMPACT_ACCEPTANCE_HEADROOM,
  formatWindowTrimNotice,
  MIN_SUMMARISE_TOKENS,
  SUMMARY_PREAMBLE,
} from './constants';
import { distillToolMessages } from './distill';
import { measureConversationTokens } from './measure';
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
  systemPromptTokens?: number
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
  const recentDistill = await distillToolMessages(
    ctx,
    historySplit.preservedRecentMessages,
    numCtx,
    model,
    distillCallCap,
    onProgress,
    signal,
    reasoningEffort,
    onTps
  );
  const preparedRecentMessages = recentDistill.messages;

  // The older slice gets whatever the window did not spend.
  const historyDistill = await distillToolMessages(
    ctx,
    historySplit.messagesToSummarise,
    numCtx,
    model,
    Math.max(0, distillCallCap - recentDistill.distilledCount),
    onProgress,
    signal,
    reasoningEffort,
    onTps
  );
  const preparedHistoryMessages = historyDistill.messages;

  const skippedDistillations = recentDistill.skippedCount + historyDistill.skippedCount;
  const orphanDistillations = recentDistill.orphanCount + historyDistill.orphanCount;
  if (skippedDistillations > 0 || orphanDistillations > 0) {
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
  let newMessages: ChatMessage[] = [summaryMessage, ...preparedRecentMessages];

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
  const acceptanceBudget = Math.floor(numCtx * COMPACT_ACCEPTANCE_HEADROOM);
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
      newMessages = [
        {
          ...summaryMessage,
          content: `${summaryMessage.content}${formatWindowTrimNotice(trimPlan.droppedCount)}`,
        },
        ...trimPlan.messages,
      ];
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
    ...(trim === undefined
      ? {}
      : {
          windowTrim: {
            droppedCount: trim.droppedCount,
            droppedTokens: trim.droppedTokens,
            stopReason: trim.stopReason,
          },
        }),
    retry: shouldRetry,
  });

  if (shouldRetry && remainingRetries > 0) {
    const retryFactor = Math.max(1.5, newTokenCount / (numCtx * 0.75));
    onProgress?.(
      `Compacted to ${newTokenCount} tokens but limit is ${numCtx} — ` +
        `retrying with ${retryFactor.toFixed(1)}x stronger compression (${remainingRetries} attempt(s) left)...`
    );
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
    // Report stats relative to the original pre-compaction history.
    return {
      newMessages: retryResult.newMessages,
      stats: {
        oldTokenCount,
        newTokenCount: retryResult.stats.newTokenCount,
      },
    };
  }

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
