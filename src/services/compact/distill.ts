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

import { TPS_STATUS_MIN_INTERVAL_MS } from '@/constants';
import { type ChatMessage, getLlmTurnStats, sendLlmChat } from '@/services/llm';
import { recordTokenCalibrationSample } from '@/services/tokenCalibration';
import { countRawMessagesTokens } from '@/services/tokenizer';
import { LiveThroughputMeter } from '@/services/tokenThroughput';
import { isAbortError } from '@/util/error';

import type { CompactionLlmCall } from './types';

import { computeDistillTimeoutMs } from './budget';
import {
  assembleDistillResult,
  buildDistilledMessage,
  buildDistillRequest,
  computeDistillLimits,
  describeDistillFailure,
  type DistillBudget,
  type DistillOutcome,
  type DistillRequest,
  type DistillResult,
  distillToolName,
  formatDistillPassNotices,
  planDistillPass,
  remainingDistillBudgetTokens,
} from './distillPlan';

/** The inputs of {@link distillToolMessages}. */
export interface DistillPassOptions extends CompactionLlmCall {
  /** The slice being distilled. */
  historyMessages: ChatMessage[];
  /** How many distillation calls this pass may make. */
  maxCalls: number;
  /** The compaction's prefill budget; the calls this pass cannot pay for are left verbatim. */
  budget?: DistillBudget | undefined;
  /**
   * Rows this pass must not digest again: the ones an earlier pass already turned
   * into digests, and the ones whose one attempt already failed. They are the rows
   * the EXTRA spend skips, so the second pass never re-digests a digest and never
   * spends another call on a known failure.
   */
  skipIndices?: ReadonlySet<number> | undefined;
}

/** What one distillation call produced: the model's digest, or why the call failed. */
type DistillAnswer = { ok: true; rawDigest: string } | { ok: false; reason: string };

/**
 * Sends ONE distillation request and records its calibration sample.
 *
 * A call that FAILS is not thrown: it comes back as `{ ok: false, reason }`, so
 * the pass can keep the output verbatim and go on. ABORT errors are the exception
 * and still propagate: the caller's signal is a user decision, not a failure.
 */
async function distillOne(
  call: CompactionLlmCall,
  request: DistillRequest,
  options: {
    numPredict: number;
    prefillTokens: number;
    /** Called with the digest's length so far, as it streams. */
    onText: (charsSoFar: number) => void;
  }
): Promise<DistillAnswer> {
  const { ctx, model, numCtx, signal, reasoningEffort, onTps } = call;
  let streamed = '';
  // Live t/s meter so the UI can show generation speed while the distillation
  // requests run (same shared policy as the main loop).
  const liveMeter = new LiveThroughputMeter(model, TPS_STATUS_MIN_INTERVAL_MS);
  // The call's DEADLINE. The request used to carry NO timeout at all, so a slow
  // prefill (a 32k-token tool output against a loaded provider) could hang the
  // compaction for ever: the request neither failed nor returned. The timeout
  // scales with the size of the request — the prefill it has to read and the
  // answer it has to write — and it is enforced by the adapter: Ollama treats it
  // as the socket's silence timeout, the OpenAI-compatible client as the time to
  // the first response byte (the prefill), which is exactly the phase that used
  // to hang.
  const timeoutMs = computeDistillTimeoutMs(options.prefillTokens, options.numPredict);
  let response: Awaited<ReturnType<typeof sendLlmChat>>;
  try {
    response = await sendLlmChat(
      ctx,
      {
        model,
        messages: request.messages,
        tools: [],
        numCtx,
        maxOutputTokens: options.numPredict,
        options: {
          temperature: 0,
        },
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      },
      (chunk) => {
        if (chunk.message?.content) {
          streamed += chunk.message.content;
          liveMeter.onText(chunk.message.content);
          liveMeter.maybeReport((tps) => onTps?.(tps));
          options.onText(streamed.length);
        }
      },
      timeoutMs,
      signal
    );
  } catch (err) {
    // An abort is the caller's decision, not a failure of this call: it has to
    // reach the route, which turns it into a `client_abort` error event.
    //
    // A TIMEOUT is NOT an abort: it is a failure of this call, and it is reported
    // as one — the tool output stays verbatim, the pass continues, and the
    // progress line says what happened. (The adapters report a timeout as a
    // connection timeout, not as an abort: axios raises `ECONNABORTED`, the
    // OpenAI client raises `APIConnectionTimeoutError`.)
    if (signal?.aborted === true || isAbortError(err)) {
      throw err;
    }
    return { ok: false, reason: describeDistillFailure(err) };
  }

  // ── Calibration sample (the distillation request) ──
  //
  // A CLEAN sample: the request carries `tools: []`, so the provider's prompt
  // count and our own count describe the SAME thing — the two messages above —
  // and nothing has to be subtracted from the provider's side. The PROMPT count
  // only; `eval_count` is the generated digest and is not part of the request's
  // cost.
  //
  // Best-effort: a calibration that cannot be recorded must never break a
  // distillation pass.
  try {
    const stats = getLlmTurnStats(ctx, response);
    if (stats) {
      recordTokenCalibrationSample({
        model,
        provider: ctx.provider ?? 'ollama',
        // The request is capped at `computeDistillInputMaxChars` (at most 112 000
        // characters), far below any size the counter has failed at (see
        // CONFIRMATIONS.md C-016), and the surrounding `try` keeps the sample
        // best-effort anyway.
        estimatedTokens: countRawMessagesTokens(request.messages, model),
        authoritativeTokens: stats.promptEvalCount,
        overheadTokens: 0,
        hasImages: false,
      });
    }
  } catch {
    // Calibration is best-effort: a failure here must not fail the pass.
  }

  return { ok: true, rawDigest: (response.message?.content ?? '').trim() };
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
 */
export async function distillToolMessages(options: DistillPassOptions): Promise<DistillResult> {
  const { historyMessages, numCtx, maxCalls, onProgress, budget, skipIndices } = options;
  const limits = computeDistillLimits(numCtx);

  // The calls that can be AFFORDED: the call cap chooses the candidates, the
  // prefill budget decides which of them this pass can actually pay for.
  const plan = planDistillPass({
    historyMessages,
    maxCalls,
    perCallMaxChars: limits.inputMaxChars,
    budgetTokens: remainingDistillBudgetTokens(budget),
    ...(skipIndices === undefined ? {} : { excludeIndices: skipIndices }),
  });
  const plannedCalls = new Map(plan.calls.map((call) => [call.index, call]));

  const outcomes: DistillOutcome[] = [];
  let distilledCount = 0;
  for (const [index, message] of historyMessages.entries()) {
    // Not selected by the call cap, or selected but not affordable: either way
    // the output passes through verbatim.
    const planned = message ? plannedCalls.get(index) : undefined;
    if (!message || !planned) {
      continue;
    }

    // An empty tool output has nothing to distil: the call would be a request
    // whose answer is an empty digest wrapped in a header that claims a length of
    // zero. It is passed through verbatim.
    if (message.content.length === 0) {
      continue;
    }

    const toolName = distillToolName(historyMessages, index);
    const request = buildDistillRequest(message, toolName, limits.inputMaxChars);
    const answer = await distillOne(options, request, {
      numPredict: limits.numPredict,
      prefillTokens: planned.prefillTokens,
      onText: (chars) =>
        onProgress?.(
          `Distilling tool output ${index + 1}/${historyMessages.length} (${toolName})... (${chars} chars)`
        ),
    });
    if (!answer.ok) {
      // The row is remembered as ATTEMPTED (see `assembleDistillResult`).
      outcomes.push({ index, kind: 'failed', reason: answer.reason });
      continue;
    }

    outcomes.push({
      index,
      kind: 'digest',
      message: buildDistilledMessage(message, request, answer.rawDigest, limits.digestMaxChars),
    });
    distilledCount += 1;
    onProgress?.(`Distilled tool output ${distilledCount}/${plan.calls.length} (${toolName})`);
  }

  for (const line of formatDistillPassNotices(outcomes, plan.budgetSkipped)) {
    onProgress?.(line);
  }

  return assembleDistillResult(historyMessages, plan, outcomes);
}
