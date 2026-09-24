import type { ChatMessage } from '@/services/adapters/llmAdapter';

/**
 * Builds the bracketed date stamp prepended to user-typed messages before
 * they are sent to the LLM and persisted to the conversation history.
 *
 * Format: `[Sent YYYY-MM-DD HH:MM]` in the local timezone. The bracket form
 * is chosen so the LLM can distinguish it from markdown and so the UI bubble
 * renders it as a clearly demarcated first line.
 *
 * Used only at the client-side point of capture (see
 * useChatStream.sendChatMessage). Synthetic messages (prompt-loop nudges,
 * sub-agent prompts) must NOT call this.
 */
export function buildUserMessageStamp(now: Date = new Date()): string {
  const yyyy = now.getFullYear().toString().padStart(4, '0');
  const mm = (now.getMonth() + 1).toString().padStart(2, '0');
  const dd = now.getDate().toString().padStart(2, '0');
  const HH = now.getHours().toString().padStart(2, '0');
  const MM = now.getMinutes().toString().padStart(2, '0');
  return `[Sent ${yyyy}-${mm}-${dd} ${HH}:${MM}]`;
}

/**
 * Returns the LLM-bound copy of a user message.
 *
 * When `promptTimestampsEnabled` is true and the message carries a string
 * `createdAt`, prepend the `[Sent YYYY-MM-DD HH:MM]` stamp. The stamp is
 * derived from `createdAt` rather than from the current clock, so it is
 * byte-stable across turns and across process restarts - which is what keeps
 * the prompt prefix cacheable. `createdAt` itself is stripped from the result
 * so it does not leak into the LLM payload as an unknown JSON key.
 *
 * Returns the message unchanged when the toggle is off, the role is not
 * `user`, or no `createdAt` is available.
 */
export function maybeInjectPromptTimestamp(
  message: ChatMessage,
  promptTimestampsEnabled: boolean
): ChatMessage {
  if (!promptTimestampsEnabled) return message;
  if (message.role !== 'user') return message;
  if (typeof message.createdAt !== 'string') return message;

  const stamp = buildUserMessageStamp(new Date(message.createdAt));
  if (message.content.startsWith(stamp)) return message;

  const { createdAt: _createdAt, ...rest } = message;
  void _createdAt;
  return { ...rest, content: `${stamp}\n${message.content}` };
}
