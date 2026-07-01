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

/** Prepend the stamp to the user message body, with a single newline separator. */
export function stampUserContent(content: string, now: Date = new Date()): string {
  return `${buildUserMessageStamp(now)}\n${content}`;
}
