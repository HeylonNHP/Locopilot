'use client';

import type { ChatMessage } from '@/app/lib/chatStore';

/**
 * Rough client-side token estimator that doesn't require tiktoken/WASM.
 * Uses the same ~4 chars/token heuristic as the tokenizer fallback.
 * This ensures the StatusBar ALWAYS shows a token count even when
 * authoritative SSE stats haven't arrived yet.
 */
export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  // Typical GPT-like tokenizers: ~4 chars per token on average
  return Math.max(1, Math.ceil(text.length / 4));
}

export function estimateMessagesTokens(messages: ChatMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    total += 4; // per-message overhead
    total += estimateTextTokens(msg.role);
    total += estimateTextTokens(msg.content ?? '');
    total += estimateTextTokens(msg.thinking ?? '');
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      for (const tc of msg.tool_calls) {
        total += estimateTextTokens(tc.function?.name ?? '');
        total += estimateTextTokens(JSON.stringify(tc.function?.arguments ?? {}));
      }
    }
  }
  return total + 2;
}
