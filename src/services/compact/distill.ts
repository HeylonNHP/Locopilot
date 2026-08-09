/**
 * distill.ts
 *
 * Tool-output distillation for the compaction pipeline. Large tool results are
 * sent to the LLM one message at a time and replaced with a compact digest so
 * they do not dominate the summarisation input. Each distillation call is
 * individually bounded so it can never exceed the model context window.
 */

import type { ReasoningEffort } from '@/types/chatConfig';

import { type ChatMessage, type LlmRequestContext, sendLlmChat } from '@/services/llm';

import {
  TOOL_DISTILL_CHAR_THRESHOLD,
  TOOL_DISTILL_MAX_CHARS,
  TOOL_DISTILL_NUM_PREDICT,
  TOOL_DISTILL_SYSTEM_PROMPT,
} from './constants';

function getToolMessageName(message: ChatMessage): string {
  const firstToolCall = message.tool_calls?.[0];
  const name = firstToolCall?.function?.name;
  return typeof name === 'string' && name.trim().length > 0 ? name.trim() : 'unknown_tool';
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
 * Replaces large tool outputs with lossy, bounded digests produced by the LLM.
 * Each oversized tool message becomes its own bounded request, so the number of
 * requests scales with the number of large tool messages but no single request
 * grows without limit.
 */
export async function distillToolMessages(
  ctx: LlmRequestContext,
  historyMessages: ChatMessage[],
  numCtx: number,
  model: string,
  onProgress?: (message: string) => void,
  signal?: AbortSignal,
  reasoningEffort?: ReasoningEffort
): Promise<ChatMessage[]> {
  const distilledMessages: ChatMessage[] = [];

  for (let index = 0; index < historyMessages.length; index += 1) {
    const message = historyMessages[index];
    if (!message) {
      continue;
    }

    const shouldDistill =
      message.role === 'tool' && (message.content?.length ?? 0) >= TOOL_DISTILL_CHAR_THRESHOLD;

    if (!shouldDistill) {
      distilledMessages.push(message);
      continue;
    }

    const matchingAssistantIndex = findMatchingAssistantIndex(historyMessages, index);
    if (matchingAssistantIndex < 0) {
      // The matching assistant is not in this message slice (possible if the
      // history was split across an assistant/tool block). Preserve the tool
      // result verbatim to avoid orphan-conversion issues.
      distilledMessages.push(message);
      continue;
    }

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
    const distillResponse = await sendLlmChat(
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
          onProgress?.(
            `Distilling tool output ${index + 1}/${historyMessages.length} (${toolName})... (${distilledContent.length} chars)`
          );
        }
      },
      undefined,
      signal
    );

    const rawDigest = (distillResponse.message?.content ?? '').trim();
    const digest =
      rawDigest.length > 0
        ? rawDigest.slice(0, TOOL_DISTILL_MAX_CHARS)
        : message.content.slice(0, TOOL_DISTILL_MAX_CHARS);

    distilledMessages.push({
      ...message,
      content: `[Distilled tool output from ${toolName}; original length ${message.content.length} chars]\n${digest}`,
    });

    onProgress?.(
      `Distilled tool output ${distilledMessages.length}/${historyMessages.length} (${toolName})`
    );
  }

  return distilledMessages;
}
