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
} from '@/services/llm';
import { recordTokenCalibrationSample } from '@/services/tokenCalibration';
import { countRawMessagesTokens } from '@/services/tokenizer';
import { LiveThroughputMeter } from '@/services/tokenThroughput';
import { isAbortError } from '@/util/error';

import {
  computeDistillDigestMaxChars,
  computeDistillInputMaxChars,
  computeDistillNumPredict,
  computeDistillTimeoutMs,
} from './budget';
import { TOOL_DISTILL_SYSTEM_PROMPT } from './constants';
import {
  cutWithMarker,
  describeDistillFailure,
  type DistillBudget,
  findOwningToolCall,
  planDistillPass,
  remainingDistillBudgetTokens,
  truncateToolOutputForDistillation,
} from './distillPlan';
import { toolCallName, UNKNOWN_TOOL_NAME } from './serialize';

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
    const {
      text: distillInputContent,
      keptChars,
      totalChars,
      truncated,
    } = truncateToolOutputForDistillation(message.content, inputMaxChars);

    const input =
      `Tool name: ${toolName}\n` +
      `Tool output length: ${totalChars} chars${
        truncated ? ` (only the first ${keptChars} chars were sent to the distiller)` : ''
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
