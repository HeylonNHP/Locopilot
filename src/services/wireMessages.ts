/**
 * The one place a conversation's messages become what a model is sent.
 *
 * A message carries more than the protocol knows about. The fields in
 * `UI_ONLY_FIELDS` exist for the page (and for the database), and must not
 * reach a provider: they cost bytes on every request, and a provider that
 * validates its input strictly would reject the unknown key.
 *
 * Every LLM request goes through `sendLlmChat` / `sendLlmChatStream`
 * (src/services/llm.ts), and both call `toWireMessages`, so the rule holds
 * for the main chat, sub-agents, compaction, title generation and the prompt
 * loop without any of them knowing about it. A new UI-only field is added HERE
 * and nowhere else.
 */

import type { ChatMessage } from './adapters/llmAdapter';

/** Message fields that are for the page and the database, never for a model. */
const UI_ONLY_FIELDS = ['subagentTraces'] as const;

/** True when the message carries a field that must not be sent. */
function hasUiOnlyField(message: ChatMessage): boolean {
  return UI_ONLY_FIELDS.some((field) => message[field] !== undefined);
}

/**
 * The messages as a model should receive them.
 *
 * Returns the SAME array when no message carries a UI-only field (the common
 * case), and copies only the messages that do. The input is never mutated: the
 * caller's array is the conversation's own history.
 */
export function toWireMessages(messages: ChatMessage[]): ChatMessage[] {
  if (!messages.some(hasUiOnlyField)) {
    return messages;
  }
  return messages.map((message) => {
    if (!hasUiOnlyField(message)) {
      return message;
    }
    const wire: ChatMessage = { ...message };
    for (const field of UI_ONLY_FIELDS) {
      delete wire[field];
    }
    return wire;
  });
}
