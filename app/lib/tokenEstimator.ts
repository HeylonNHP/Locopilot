'use client';

import type { ChatMessage } from '@/app/lib/chatStore';
import {
  estimateMessagesTokens as estimateMessagesTokensHeuristic,
  estimateTextTokens as estimateTextTokensHeuristic,
} from '@/services/tokenHeuristics';

/**
 * Rough client-side token estimator that doesn't require tiktoken/WASM.
 * Uses the same ~4 chars/token heuristic as the tokenizer fallback.
 * This ensures the StatusBar ALWAYS shows a token count even when
 * authoritative SSE stats haven't arrived yet.
 */
export function estimateTextTokens(text: string): number {
  return estimateTextTokensHeuristic(text);
}

export function estimateMessagesTokens(messages: ChatMessage[]): number {
  return estimateMessagesTokensHeuristic(messages);
}
