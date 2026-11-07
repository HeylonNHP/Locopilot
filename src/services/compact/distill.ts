/**
 * distill.ts
 *
 * Tool-output distillation for the compaction pipeline. Large tool results are
 * sent to the LLM one message at a time and replaced with a compact digest so
 * they do not dominate the summarisation input. Each distillation call is
 * individually bounded so it can never exceed the model context window, and
 * the NUMBER of calls is bounded too (`planDistillation` + the caller's
 * `computeDistillCallCap`): the largest results get the budget, everything
 * else is passed through verbatim.
 */

import type { ReasoningEffort } from '@/types/chatConfig';

import { TPS_STATUS_MIN_INTERVAL_MS } from '@/constants';
import { type ChatMessage, type LlmRequestContext, sendLlmChat } from '@/services/llm';
import { LiveThroughputMeter } from '@/services/tokenThroughput';
import { isAbortError } from '@/util/error';

import {
  TOOL_DISTILL_CHAR_THRESHOLD,
  TOOL_DISTILL_MAX_CHARS,
  TOOL_DISTILL_NUM_PREDICT,
  TOOL_DISTILL_SYSTEM_PROMPT,
  TOOL_DISTILL_TRUNCATION_MARKER,
} from './constants';
function getToolMessageName(message: ChatMessage): string {
  const firstToolCall = message.tool_calls?.[0];
  const name = firstToolCall?.function?.name;
  return typeof name === 'string' && name.trim().length > 0 ? name.trim() : 'unknown_tool';
}

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
 * Returns the index of the assistant message that owns the tool message at
 * `toolIndex`, or -1 if no matching assistant is found in the same contiguous
 * tool block.
 */
function findMatchingAssistantIndex(messages: ChatMessage[], toolIndex: number): number {
  if (toolIndex <= 0) return -1;
  const toolCallId = messages[toolIndex]?.tool_call_id;
  if (!toolCallId) return -1;
  for (let i = toolIndex - 1; i >= 0; i -= 1) {
    const candidate = messages[i];
    if (
      candidate?.role === 'assistant' &&
      candidate?.tool_calls?.some((tc) => tc.id === toolCallId)
    ) {
      return i;
    }
    if (candidate?.role !== 'tool') {
      break;
    }
  }
  return -1;
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
 * @returns the selected (ascending) indices, how many candidates the cap left
 *          behind, and how many oversized rows were orphans (not candidates at
 *          all).
 */
export function planDistillation(
  historyMessages: ChatMessage[],
  maxCalls: number,
  thresholdChars: number = TOOL_DISTILL_CHAR_THRESHOLD
): { selected: number[]; skipped: number; orphans: number } {
  const limit = Number.isFinite(maxCalls) ? Math.max(0, Math.floor(maxCalls)) : 0;

  const candidates: { index: number; length: number }[] = [];
  let orphans = 0;
  for (let index = 0; index < historyMessages.length; index += 1) {
    const message = historyMessages[index];
    if (!message || message.role !== 'tool') {
      continue;
    }
    const length = message.content?.length ?? 0;
    if (length < thresholdChars) {
      continue;
    }
    if (findMatchingAssistantIndex(historyMessages, index) < 0) {
      orphans += 1;
      continue;
    }
    candidates.push({ index, length });
  }

  candidates.sort((left, right) => right.length - left.length || left.index - right.index);

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
  onTps?: (tps: number) => void
): Promise<DistillResult> {
  const plan = planDistillation(historyMessages, maxCalls);
  const selectedIndices = new Set(plan.selected);
  const distilledMessages: ChatMessage[] = [];
  let distilledCount = 0;
  let failedCount = 0;

  for (let index = 0; index < historyMessages.length; index += 1) {
    const message = historyMessages[index];
    if (!message) {
      continue;
    }

    if (!selectedIndices.has(index)) {
      distilledMessages.push(message);
      continue;
    }

    const matchingAssistantIndex = findMatchingAssistantIndex(historyMessages, index);
    const previous = historyMessages[matchingAssistantIndex];
    const toolName = previous ? getToolMessageName(previous) : 'unknown_tool';

    // Guard against sending massive tool outputs to the distillation LLM.
    // A single tool output can exceed numCtx, causing the distillation call
    // itself to fail with a 400.
    const DISTILL_INPUT_MAX_CHARS = Math.min(50_000, numCtx * 8);
    const distillInputContent =
      message.content.length > DISTILL_INPUT_MAX_CHARS
        ? `${message.content.slice(
            0,
            DISTILL_INPUT_MAX_CHARS
          )}\n\n[...truncated ${message.content.length - DISTILL_INPUT_MAX_CHARS} chars for distillation]`
        : message.content;

    const input =
      `Tool name: ${toolName}\n` +
      `Tool output length: ${message.content.length} chars${
        message.content.length > DISTILL_INPUT_MAX_CHARS ? ' (truncated for distillation)' : ''
      }\n\n` +
      `Tool output:\n${distillInputContent}`;

    let distilledContent = '';
    // Live t/s meter so the UI can show generation speed while the
    // distillation requests run (same shared policy as the main loop).
    const liveMeter = new LiveThroughputMeter(model, TPS_STATUS_MIN_INTERVAL_MS);
    let distillResponse: Awaited<ReturnType<typeof sendLlmChat>>;
    try {
      distillResponse = await sendLlmChat(
        ctx,
        {
          model,
          messages: [
            { role: 'system', content: TOOL_DISTILL_SYSTEM_PROMPT },
            { role: 'user', content: input },
          ],
          tools: [],
          numCtx,
          maxOutputTokens: TOOL_DISTILL_NUM_PREDICT,
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
        undefined,
        signal
      );
    } catch (err) {
      // An abort is the caller's decision, not a failure of this call: it has
      // to reach the route, which turns it into a `client_abort` error event.
      if (signal?.aborted === true || isAbortError(err)) {
        throw err;
      }
      failedCount += 1;
      distilledMessages.push(message);
      continue;
    }

    const rawDigest = (distillResponse.message?.content ?? '').trim();
    // A digest that was cut is MARKED as cut. The summariser's prompt asks
    // the model to copy names "character for character" and to report a
    // value that was cut as cut — but a digest that simply stops mid-sentence
    // carries no such signal, so the model cannot tell a complete sentence
    // from a cut one and copies a truncated value as if it were whole.
    const digest = cutWithMarker(
      rawDigest.length > 0 ? rawDigest : message.content,
      TOOL_DISTILL_MAX_CHARS
    );

    distilledMessages.push({
      ...message,
      content: `[Distilled tool output from ${toolName}; original length ${message.content.length} chars]\n${digest}`,
    });
    distilledCount += 1;

    onProgress?.(`Distilled tool output ${distilledCount}/${plan.selected.length} (${toolName})`);
  }

  if (failedCount > 0) {
    onProgress?.(
      `${failedCount} tool distillation call(s) failed — those tool output(s) stay verbatim.`
    );
  }

  return {
    messages: distilledMessages,
    distilledCount,
    skippedCount: plan.skipped,
    orphanCount: plan.orphans,
    failedCount,
  };
}
