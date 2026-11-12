/**
 * distill.ts
 *
 * Tool-output distillation for the compaction pipeline. Large tool results are
 * sent to the LLM one message at a time and replaced with a compact digest so
 * they do not dominate the summarisation input.
 *
 * Every distillation call is bounded three ways: by the SIZE of what it may
 * carry ({@link computeDistillInputMaxChars}), by the TIME it may take
 * ({@link computeDistillTimeoutMs}), and by the TOTAL prefill one compaction
 * may spend ({@link DistillBudget}). The NUMBER of calls is bounded too
 * ({@link planDistillation} + the caller's `computeDistillCallCap`): the
 * largest results get the budget, everything else is passed through verbatim.
 */

import type { ReasoningEffort } from '@/types/chatConfig';

import { TPS_STATUS_MIN_INTERVAL_MS } from '@/constants';
import {
  type ChatMessage,
  getLlmTurnStats,
  type LlmRequestContext,
  sendLlmChat,
  type ToolCall,
} from '@/services/llm';
import { recordTokenCalibrationSample } from '@/services/tokenCalibration';
import { countRawMessagesTokens } from '@/services/tokenizer';
import { LiveThroughputMeter } from '@/services/tokenThroughput';
import { isAbortError } from '@/util/error';

import {
  computeDistillDigestMaxChars,
  computeDistillInputMaxChars,
  computeDistillNumPredict,
  computeDistillPrefillBudgetTokens,
  computeDistillTimeoutMs,
  estimateDistillPrefillTokens,
} from './budget';
import {
  TOOL_DISTILL_CHAR_THRESHOLD,
  TOOL_DISTILL_INPUT_OVERHEAD_TOKENS,
  TOOL_DISTILL_SYSTEM_PROMPT,
  TOOL_DISTILL_TRUNCATION_MARKER,
} from './constants';
import { toolCallName, UNKNOWN_TOOL_NAME } from './serialize';

/**
 * Cuts `text` to `maxChars` characters and marks the cut when there was one.
 *
 * The marker counts towards the limit, so the result never exceeds
 * `maxChars`. A text that fits is returned unchanged — no marker, because a
 * marker on an intact digest would tell the summariser that a complete
 * digest was cut.
 */
function cutWithMarker(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const room = Math.max(0, maxChars - TOOL_DISTILL_TRUNCATION_MARKER.length);
  return `${text.slice(0, room)}${TOOL_DISTILL_TRUNCATION_MARKER}`;
}

/**
 * The marker that says how much of a tool output the distiller actually saw.
 *
 * WHY it has to be exact: the summariser's prompt tells the model to report a
 * value that was cut as cut, and the distiller is the only place that knows
 * what the summariser will never see. A marker that said "truncated" and
 * nothing else leaves the summariser unable to tell a whole value from a
 * fragment, so it copies a fragment as if it were the whole thing.
 *
 * @param kept  - how many characters of the output were sent.
 * @param total - how many characters the output has in all.
 */
function formatDistillInputTruncationMarker(kept: number, total: number): string {
  return (
    `\n\n[...truncated: only the first ${kept} of ${total} characters of this tool ` +
    `output were sent to the distiller; the remaining ${total - kept} characters were NOT included]`
  );
}

/**
 * Cuts a tool output to the distiller's input cap and says how much was cut.
 *
 * WHY the kept count is SOLVED for rather than guessed: the marker has to fit
 * INSIDE the cap, so the kept text is the cap minus the marker — and the
 * marker's own length depends on the numbers it quotes. Each pass renders the
 * marker for the current guess and shrinks the guess by the marker's length;
 * the marker only ever gets shorter as the count shrinks (fewer digits), so
 * this converges in one or two passes. The result never exceeds the cap.
 *
 * The kept count is the length of the SLICE, never the raw length: the
 * marker says how much of the output the distiller will see, and that is the
 * slice, not the whole thing.
 *
 * @param content  - the tool output.
 * @param maxChars - the largest number of characters the request may carry.
 */
export function truncateToolOutputForDistillation(
  content: string,
  maxChars: number
): { text: string; keptChars: number; totalChars: number; truncated: boolean } {
  const totalChars = content.length;
  if (totalChars <= maxChars) {
    return { text: content, keptChars: totalChars, totalChars, truncated: false };
  }
  let kept = Math.max(0, maxChars);
  let marker = formatDistillInputTruncationMarker(kept, totalChars);
  for (let pass = 0; pass < 8 && kept + marker.length > maxChars; pass += 1) {
    kept = Math.max(0, maxChars - marker.length);
    marker = formatDistillInputTruncationMarker(kept, totalChars);
  }
  // A cap smaller than the marker itself cannot hold the marker. The text is
  // cut to the cap and left unmarked, which is the lesser evil next to
  // sending more than the cap allows.
  if (kept + marker.length > maxChars) {
    return { text: content.slice(0, maxChars), keptChars: maxChars, totalChars, truncated: true };
  }
  return {
    text: `${content.slice(0, kept)}${marker}`,
    keptChars: kept,
    totalChars,
    truncated: true,
  };
}

/**
 * The tool call that the tool message at `toolIndex` answers, matched by
 * `tool_call_id` against the assistant row that heads its contiguous tool
 * block; `undefined` for an orphan (no id, or no call in that block has it).
 *
 * WHY the CALL and not the assistant row: one assistant turn can make several
 * calls, and a digest must name the call it answers, not the turn's first.
 *
 * Exported for unit tests.
 */
export function findOwningToolCall(
  messages: ChatMessage[],
  toolIndex: number
): ToolCall | undefined {
  if (toolIndex <= 0) return undefined;
  const toolCallId = messages[toolIndex]?.tool_call_id;
  if (!toolCallId) return undefined;
  for (let i = toolIndex - 1; i >= 0; i -= 1) {
    const candidate = messages[i];
    if (candidate?.role === 'assistant') {
      return candidate.tool_calls?.find((tc) => tc?.id === toolCallId);
    }
    if (candidate?.role !== 'tool') break;
  }
  return undefined;
}

/**
 * The distillation PREFILL budget of ONE compaction.
 *
 * WHY the total has to be bounded and not only the NUMBER of calls: the call
 * cap saturates at 8, but the per-call input grew 40x (50 000 characters to
 * 2 000 000). Eight calls at 500k tokens each is ~4M tokens of prefill
 * inside ONE compaction — several times the window the compaction is trying
 * to shrink, and the reason a compaction at a 1M-token window became about
 * three times as expensive as it had been.
 *
 * The budget is spent LARGEST FIRST: the biggest tool outputs are the ones
 * that decide whether the compacted history fits, and they are also the most
 * expensive to distil, so they are the ones worth the budget.
 */
export interface DistillBudget {
  /** The prefill tokens this compaction may spend on distillation in total. */
  totalTokens: number;
  /** The prefill tokens the earlier passes of this compaction already spent. */
  usedTokens: number;
}

/**
 * The prefill budget of a compaction with the given window.
 *
 * @param numCtx - the model's context window.
 */
export function createDistillBudget(numCtx: number): DistillBudget {
  return { totalTokens: computeDistillPrefillBudgetTokens(numCtx), usedTokens: 0 };
}

/**
 * How many prefill tokens are left in a budget.
 *
 * WHY a missing budget means "unlimited": a caller that does not pass one
 * (the old behaviour) keeps its old semantics — the calls it asks for are the
 * calls it gets.
 *
 * @param budget - the compaction's budget, if it has one.
 */
export function remainingDistillBudgetTokens(budget?: DistillBudget): number {
  if (!budget) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.max(0, budget.totalTokens - budget.usedTokens);
}

/** One planned distillation call. */
export interface DistillCall {
  /** The index of the tool message to distil. */
  index: number;
  /** The prefill tokens the call is charged against the budget. */
  prefillTokens: number;
}

/** The calls one pass will make, and what the budget left out. */
export interface DistillCallPlan {
  /** The calls to make, in the order the history is walked (ascending index). */
  calls: DistillCall[];
  /** How many of the selected candidates the budget could not pay for. */
  budgetSkipped: number;
  /** The prefill tokens the plan spends. */
  prefillTokens: number;
}

/** Largest output first; the same size is ordered by index, so the plan is deterministic. */
function largestFirst(
  left: { index: number; length: number },
  right: { index: number; length: number }
): number {
  return right.length - left.length || left.index - right.index;
}

/**
 * Turns the selected candidates into the calls that can be AFFORDED.
 *
 * WHY the budget is spent largest first: the biggest outputs are the ones
 * that decide whether the compacted history fits, and they are the most
 * expensive to distil — so they are the ones worth the budget, and a small
 * output that still fits in what is left is a better use of it than
 * nothing.
 *
 * WHY a candidate the budget cannot pay for is skipped rather than allowed
 * to overshoot: the budget is what keeps one compaction's distillation from
 * costing several windows' worth of prefill.
 *
 * @param historyMessages - the slice being distilled.
 * @param selectedIndices - the candidates the call cap chose.
 * @param perCallMaxChars - the largest number of characters one call may carry.
 * @param budgetTokens    - the prefill tokens the pass may spend.
 */
export function planDistillCalls(
  historyMessages: ChatMessage[],
  selectedIndices: number[],
  perCallMaxChars: number,
  budgetTokens: number
): DistillCallPlan {
  const candidates = selectedIndices
    .map((index) => ({ index, length: historyMessages[index]?.content?.length ?? 0 }))
    .sort(largestFirst);

  let remaining = budgetTokens;
  let budgetSkipped = 0;
  let prefillTokens = 0;
  const calls: DistillCall[] = [];
  for (const candidate of candidates) {
    const sentChars = Math.min(candidate.length, perCallMaxChars);
    const cost = estimateDistillPrefillTokens(sentChars) + TOOL_DISTILL_INPUT_OVERHEAD_TOKENS;
    if (cost > remaining) {
      budgetSkipped += 1;
      continue;
    }
    remaining -= cost;
    prefillTokens += cost;
    calls.push({ index: candidate.index, prefillTokens: cost });
  }
  calls.sort((left, right) => left.index - right.index);
  return { calls, budgetSkipped, prefillTokens };
}

/**
 * The plan for ONE distillation pass: which rows to digest, what the calls
 * cost, and what the caps left behind.
 *
 * WHY it is a single function: the candidate selection ({@link planDistillation})
 * and the affordability ({@link planDistillCalls}) are two halves of ONE
 * decision, and the EXTRA spend (the second pass over the preserved window,
 * once the trim has proved not to be enough) has to make exactly the same
 * decision with exactly the same rules — only over the rows the first pass
 * never touched. A separate code path for the extra spend would be a second
 * place for the two to drift apart, and the drift would be invisible: both
 * would look right.
 */
export interface DistillPassPlan {
  /** The calls to make, in the order the history is walked (ascending index). */
  calls: DistillCall[];
  /** How many eligible outputs the call cap left behind. */
  capSkipped: number;
  /** How many eligible outputs the prefill budget could not pay for. */
  budgetSkipped: number;
  /** How many eligible outputs there were in this slice. */
  candidateCount: number;
  /** How many oversized rows had no owning assistant row in this slice. */
  orphanCount: number;
  /** The prefill tokens the plan spends. */
  prefillTokens: number;
}

/**
 * Plans ONE distillation pass.
 *
 * The plan is PURE: it touches no model and no filesystem, and it is the
 * whole of the extra-spend decision — how many calls are affordable, and
 * which outputs they are spent on.
 *
 * @param historyMessages - the slice being distilled.
 * @param maxCalls        - how many model calls the pass may make.
 * @param perCallMaxChars - the largest number of characters one call may carry.
 * @param budgetTokens    - the prefill tokens the pass may spend.
 * @param thresholdChars  - the smallest output that is worth a call.
 * @param excludeIndices  - rows an earlier pass already dealt with.
 */
export function planDistillPass(params: {
  historyMessages: ChatMessage[];
  maxCalls: number;
  perCallMaxChars: number;
  budgetTokens: number;
  thresholdChars?: number;
  excludeIndices?: ReadonlySet<number>;
}): DistillPassPlan {
  const selection = planDistillation(
    params.historyMessages,
    params.maxCalls,
    params.thresholdChars,
    params.excludeIndices
  );
  const callPlan = planDistillCalls(
    params.historyMessages,
    selection.selected,
    params.perCallMaxChars,
    params.budgetTokens
  );
  return {
    calls: callPlan.calls,
    capSkipped: selection.skipped,
    budgetSkipped: callPlan.budgetSkipped,
    candidateCount: selection.selected.length + selection.skipped,
    orphanCount: selection.orphans,
    prefillTokens: callPlan.prefillTokens,
  };
}

/**
 * What a failed distillation call failed WITH, in words a progress line can
 * show.
 *
 * WHY the failure has to be NAMED: a failed call leaves the tool output
 * VERBATIM — the thing the distillation existed to prevent — so the progress
 * line has to say that it happened and why, or the compaction silently
 * returns a history that is as big as it was.
 *
 * @param err - the thrown value.
 */
function describeDistillFailure(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/timed?\s?out/i.test(message)) {
    return 'the request timed out';
  }
  if (/abort/i.test(message)) {
    return 'the request was aborted';
  }
  return 'the provider returned an error';
}

/**
 * The result of one {@link distillToolMessages} pass.
 *
 * `skippedCount` is what the call cap left verbatim — it is reported so the
 * orchestrator can say so once, in a single progress line, instead of the
 * caller having to diff the arrays to find out. `orphanCount` and `failedCount`
 * are the OTHER reasons a large output stayed at full size, and they are kept
 * apart on purpose: the cap did not choose to leave an orphan (distillation
 * cannot legally touch it) and it did not choose to leave a failed row (the
 * call was made and did not return).
 *
 * `distilledIndices` and `failedIndices` are the ROWS the pass dealt with, in
 * the index space of the array it was given. They are what lets a SECOND pass
 * over the same slice know which rows are already digests (`distilledIndices`)
 * and which rows already had their one attempt (`failedIndices`) — so the
 * extra spend can target exactly the rows that were NEVER attempted, instead
 * of re-digesting a digest or burning another call on a known failure.
 */
export interface DistillResult {
  messages: ChatMessage[];
  /** How many messages were replaced with a digest. */
  distilledCount: number;
  /** How many eligible messages the call cap left verbatim. */
  skippedCount: number;
  /** How many oversized tool rows have no owning assistant row in this slice. */
  orphanCount: number;
  /** How many distillation calls threw and left their message verbatim. */
  failedCount: number;
  /** How many model calls this pass made, the failed ones included. */
  attemptedCount: number;
  /** How many eligible outputs the prefill budget could not pay for. */
  budgetSkippedCount: number;
  /** How many eligible outputs there were in this slice. */
  candidateCount: number;
  /** The prefill tokens this pass charged against the budget. */
  prefillTokens: number;
  /** The indices (in the input array) of the rows this pass replaced. */
  distilledIndices: number[];
  /** The indices (in the input array) of the rows whose call failed. */
  failedIndices: number[];
}

/**
 * Chooses WHICH oversized tool outputs are worth a distillation call.
 *
 * Candidate = a `tool` row whose content reaches `thresholdChars` AND that has
 * a matching assistant row in this slice. The orphan guard lives here (it used
 * to live in the loop) so an unmatched row is neither selected nor counted as
 * skipped: it is not something the cap chose to leave alone, it is something
 * distillation could not legally touch.
 *
 * Selection is by SIZE, largest first, ties broken by position. WHY not
 * positional (oldest first, or newest first):
 *
 * - Every call costs roughly the same and saves roughly `length − 2400`
 *   characters, so a positional policy spends calls on 1.3 KB results and
 *   leaves the 40 KB ones in place — the exact outputs that decide whether the
 *   compacted history fits.
 * - Never NEWEST first: distillation is lossy, and the newest results are the
 *   ones the model is actively reasoning about.
 *
 * The returned indices are ascending, so the caller can rebuild the history in
 * one pass.
 *
 * @param historyMessages - The slice that will be distilled.
 * @param maxCalls        - How many model calls the caller can afford.
 * @param thresholdChars  - Minimum content length that makes a row a candidate.
 * @param excludeIndices  - Rows that must NOT be distilled again — the ones an
 *                          earlier pass already turned into digests, and the
 *                          ones whose one attempt already failed. They are
 *                          neither selected nor counted as skipped: the cap
 *                          did not leave them behind, an earlier pass dealt
 *                          with them.
 * @returns the selected (ascending) indices, how many candidates the cap left
 *          behind, and how many oversized rows were orphans (not candidates at
 *          all).
 */
export function planDistillation(
  historyMessages: ChatMessage[],
  maxCalls: number,
  thresholdChars: number = TOOL_DISTILL_CHAR_THRESHOLD,
  excludeIndices?: ReadonlySet<number>
): { selected: number[]; skipped: number; orphans: number } {
  const limit = Number.isFinite(maxCalls) ? Math.max(0, Math.floor(maxCalls)) : 0;

  const candidates: { index: number; length: number }[] = [];
  let orphans = 0;
  for (let index = 0; index < historyMessages.length; index += 1) {
    const message = historyMessages[index];
    if (!message || message.role !== 'tool') {
      continue;
    }
    if (excludeIndices?.has(index)) {
      continue;
    }
    const length = message.content?.length ?? 0;
    if (length < thresholdChars) {
      continue;
    }
    if (findOwningToolCall(historyMessages, index) === undefined) {
      orphans += 1;
      continue;
    }
    candidates.push({ index, length });
  }

  candidates.sort(largestFirst);

  const selected = candidates
    .slice(0, limit)
    .map((candidate) => candidate.index)
    .sort((left, right) => left - right);

  return { selected, skipped: candidates.length - selected.length, orphans };
}

/**
 * Replaces large tool outputs with lossy, bounded digests produced by the LLM.
 *
 * Only the messages {@link planDistillation} selects are sent to the model —
 * at most `maxCalls` of them, the largest first — and everything else passes
 * through verbatim. Each call is individually bounded, so no single request
 * can exceed the model context window.
 *
 * A call that FAILS does not abort the pass. One 400, timeout or dropped
 * stream used to throw out of `compactHistory` and discard every summary the
 * pass (and the previous chunk summaries) had already produced; with up to
 * eight calls per pass, one bad tool output could cost the whole compaction.
 * The message is now kept VERBATIM, counted in `failedCount`, and the pass
 * continues — an undistilled output costs tokens, a lost compaction costs the
 * conversation. ABORT errors are the exception and still propagate: the
 * caller's signal is a user decision, not a failure, so it is checked first
 * and re-thrown (see `isAbortError` in `util/error.ts`, the same convention the
 * rest of the repo uses).
 *
 * @param maxCalls - How many distillation calls this pass may make.
 * @param budget   - The compaction's prefill budget; the calls this pass
 *                   cannot pay for are left verbatim.
 * @param skipIndices - Rows this pass must not digest again: the ones an
 *                   earlier pass already turned into digests, and the ones
 *                   whose one attempt already failed. They are the rows the
 *                   EXTRA spend skips, so the second pass never re-digests a
 *                   digest and never spends another call on a known failure.
 */
export async function distillToolMessages(
  ctx: LlmRequestContext,
  historyMessages: ChatMessage[],
  numCtx: number,
  model: string,
  maxCalls: number,
  onProgress?: (message: string) => void,
  signal?: AbortSignal,
  reasoningEffort?: ReasoningEffort,
  onTps?: (tps: number) => void,
  budget?: DistillBudget,
  skipIndices?: ReadonlySet<number>
): Promise<DistillResult> {
  const distilledMessages: ChatMessage[] = [];
  let distilledCount = 0;
  let failedCount = 0;
  /** How many model calls this pass actually SENT. */
  let attemptedCount = 0;
  /** The rows this pass replaced with a digest (input index). */
  const distilledIndices: number[] = [];
  /** The rows whose call failed and that therefore stayed verbatim. */
  const failedIndices: number[] = [];
  /** Why the failed calls failed, so the progress line can name the reason. */
  const failureReasons = new Set<string>();

  // Three caps, all of them window-scaled:
  //
  // - the INPUT cap is the share of the window the tool output may take
  //   (`computeDistillInputMaxChars`), bounded by an ABSOLUTE ceiling so a
  //   single call can never exceed what a typical provider accepts;
  // - the DIGEST cap is the model's output capacity and the window's share
  //   (`computeDistillDigestMaxChars`) — it never cuts the model's answer;
  // - the OUTPUT limit (`computeDistillNumPredict`) is what the model may
  //   write, and it is what actually decides the digest's size.
  const inputMaxChars = computeDistillInputMaxChars(numCtx);
  const digestMaxChars = computeDistillDigestMaxChars(numCtx);
  const numPredict = computeDistillNumPredict(numCtx);

  // The calls that can be AFFORDED: the call cap chooses the candidates, the
  // prefill budget decides which of them this pass can actually pay for.
  const plan = planDistillPass({
    historyMessages,
    maxCalls,
    perCallMaxChars: inputMaxChars,
    budgetTokens: remainingDistillBudgetTokens(budget),
    ...(skipIndices === undefined ? {} : { excludeIndices: skipIndices }),
  });
  const plannedCalls = new Map(plan.calls.map((call) => [call.index, call]));

  for (let index = 0; index < historyMessages.length; index += 1) {
    const message = historyMessages[index];
    if (!message) {
      continue;
    }

    // Not selected by the call cap, or selected but not affordable: either
    // way the output passes through verbatim.
    const planned = plannedCalls.get(index);
    if (!planned) {
      distilledMessages.push(message);
      continue;
    }

    // Planned rows always have an owner (orphans are never planned), so the
    // fallback is defensive only.
    const owningCall = findOwningToolCall(historyMessages, index);
    const toolName = owningCall ? toolCallName(owningCall) : UNKNOWN_TOOL_NAME;

    // An empty tool output has nothing to distil: the call would be a
    // request whose answer is an empty digest wrapped in a header that claims
    // a length of zero. It is passed through verbatim.
    if (message.content.length === 0) {
      distilledMessages.push(message);
      continue;
    }

    // Guard against sending massive tool outputs to the distillation LLM.
    // A single tool output can exceed numCtx, causing the distillation call
    // itself to fail with a 400 — and a failed call leaves the output
    // VERBATIM, which is the thing the distillation existed to avoid.
    const { text: distillInputContent, keptChars, totalChars, truncated } = truncateToolOutputForDistillation(
      message.content,
      inputMaxChars
    );

    const input =
      `Tool name: ${toolName}\n` +
      `Tool output length: ${totalChars} chars${
        truncated
          ? ` (only the first ${keptChars} chars were sent to the distiller)`
          : ''
      }\n\n` +
      `Tool output:\n${distillInputContent}`;

    let distilledContent = '';
    // The exact pair of messages the distiller receives. Hoisted out of the
    // request literal so the calibration sample below can count EXACTLY what
    // was sent — the system prompt plus the one user message carrying the
    // tool output.
    const distillRequestMessages: ChatMessage[] = [
      { role: 'system', content: TOOL_DISTILL_SYSTEM_PROMPT },
      { role: 'user', content: input },
    ];
    // Live t/s meter so the UI can show generation speed while the
    // distillation requests run (same shared policy as the main loop).
    const liveMeter = new LiveThroughputMeter(model, TPS_STATUS_MIN_INTERVAL_MS);
    // The call's DEADLINE. The request used to carry NO timeout at all, so a
    // slow prefill (a 32k-token tool output against a loaded provider) could
    // hang the compaction for ever: the request neither failed nor returned.
    // The timeout scales with the size of the request — the prefill it has to
    // read and the answer it has to write — and it is enforced by the
    // adapter: Ollama treats it as the socket's silence timeout, the
    // OpenAI-compatible client as the time to the first response byte (the
    // prefill), which is exactly the phase that used to hang.
    const timeoutMs = computeDistillTimeoutMs(planned.prefillTokens, numPredict);
    let distillResponse: Awaited<ReturnType<typeof sendLlmChat>>;
    attemptedCount += 1;
    try {
      distillResponse = await sendLlmChat(
        ctx,
        {
          model,
          messages: distillRequestMessages,
          tools: [],
          numCtx,
          maxOutputTokens: numPredict,
          options: {
            temperature: 0,
          },
          ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
        },
        (chunk) => {
          if (chunk.message?.content) {
            distilledContent += chunk.message.content;
            liveMeter.onText(chunk.message.content);
            liveMeter.maybeReport((tps) => onTps?.(tps));
            onProgress?.(
              `Distilling tool output ${index + 1}/${historyMessages.length} (${toolName})... (${distilledContent.length} chars)`
            );
          }
        },
        timeoutMs,
        signal
      );
    } catch (err) {
      // An abort is the caller's decision, not a failure of this call: it has
      // to reach the route, which turns it into a `client_abort` error event.
      //
      // A TIMEOUT is NOT an abort: it is a failure of this call, and it falls
      // through to the failure path below — the tool output stays verbatim,
      // the pass continues, and the progress line says what happened. (The
      // adapters report a timeout as a connection timeout, not as an abort:
      // axios raises `ECONNABORTED`, the OpenAI client raises
      // `APIConnectionTimeoutError`.)
      if (signal?.aborted === true || isAbortError(err)) {
        throw err;
      }
      failedCount += 1;
      failureReasons.add(describeDistillFailure(err));
      // The row is remembered as ATTEMPTED: a second pass over the same slice
      // must not spend another call on a failure that already happened.
      failedIndices.push(index);
      distilledMessages.push(message);
      continue;
    }

    // ── Calibration sample (the distillation request) ──
    //
    // A CLEAN sample: the request carries `tools: []`, so the provider's
    // prompt count and our own count describe the SAME thing — the two
    // messages above — and nothing has to be subtracted from the provider's
    // side. The PROMPT count only; `eval_count` is the generated digest and
    // is not part of the request's cost.
    //
    // Best-effort: a calibration that cannot be recorded must never break a
    // distillation pass.
    try {
      const stats = getLlmTurnStats(ctx, distillResponse);
      if (stats) {
        recordTokenCalibrationSample({
          model,
          provider: ctx.provider ?? 'ollama',
          // The request is capped at `computeDistillInputMaxChars` (at most
          // 112 000 characters), far below any size the counter has failed at
          // (see CONFIRMATIONS.md C-016), and the surrounding `try` keeps the
          // sample best-effort anyway.
          estimatedTokens: countRawMessagesTokens(distillRequestMessages, model),
          authoritativeTokens: stats.promptEvalCount,
          overheadTokens: 0,
          hasImages: false,
        });
      }
    } catch {
      // Calibration is best-effort: a failure here must not fail the pass.
    }

    const rawDigest = (distillResponse.message?.content ?? '').trim();
    // A digest that was cut is MARKED as cut. The summariser's prompt asks
    // the model to copy names "character for character" and to report a
    // value that was cut as cut — but a digest that simply stops mid-sentence
    // carries no such signal, so the model cannot tell a complete sentence
    // from a cut one and copies a truncated value as if it were whole.
    const digest = cutWithMarker(
      rawDigest.length > 0 ? rawDigest : message.content,
      digestMaxChars
    );

    // The wrapper says what the digest is made of, and — when the INPUT was
    // cut — what the distiller never saw. A digest of a PARTIAL output looks
    // exactly like a digest of a whole one otherwise, and the summariser
    // would report the missing part as if it had been in the history.
    const wrapper = `[Distilled tool output from ${toolName}; original length ${totalChars} chars${
      truncated ? `; only the first ${keptChars} chars were distilled` : ''
    }]`;

    distilledMessages.push({
      ...message,
      content: `${wrapper}\n${digest}`,
    });
    distilledCount += 1;
    // The row is remembered as DIGESTED: a second pass over the same slice
    // must not distil a digest again (a digest can be longer than the output
    // it replaced, so re-distilling it would make the history BIGGER).
    distilledIndices.push(index);

    onProgress?.(`Distilled tool output ${distilledCount}/${plan.calls.length} (${toolName})`);
  }

  if (failedCount > 0) {
    // WHY the reason is named: a failed call leaves the tool output
    // VERBATIM — the very thing the distillation existed to prevent — so a
    // progress line that only said "N calls failed" left the user (and the
    // compaction's own log) unable to tell a rejected request from a
    // timeout. The compaction CONTINUES either way: an undistilled output
    // costs tokens, a lost compaction costs the conversation.
    const reasons = [...failureReasons].join('; ');
    onProgress?.(
      `${failedCount} of ${attemptedCount} tool distillation call(s) failed (${reasons}) — ` +
        `those tool output(s) stay verbatim and the compaction continues.`
    );
  }

  if (plan.budgetSkipped > 0) {
    onProgress?.(
      `${plan.budgetSkipped} oversized tool output(s) were left verbatim: the compaction's ` +
        `distillation prefill budget ran out.`
    );
  }

  return {
    messages: distilledMessages,
    distilledCount,
    skippedCount: plan.capSkipped,
    orphanCount: plan.orphanCount,
    failedCount,
    attemptedCount,
    budgetSkippedCount: plan.budgetSkipped,
    candidateCount: plan.candidateCount,
    prefillTokens: plan.prefillTokens,
    distilledIndices,
    failedIndices,
  };
}
