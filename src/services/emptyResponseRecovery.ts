/**
 * emptyResponseRecovery.ts
 *
 * Shared policy for detecting "empty" assistant responses and deciding
 * whether to retry them. Both the main chat loop (src/app/api/chat/route.ts)
 * and the sub-agent tool (src/tools/impl/subAgentTool.ts) use this module so
 * the detection rule, the attempt cap, and the recovery nudge wording can
 * never drift between the two surfaces.
 *
 * Detection: a reply is "empty" when, after stripping special LLM tokens, it
 * has no non-whitespace content or its entire content is a reasoning-channel
 * label ("thought" / "analysis" / "final" / "commentary"). Tool calls are
 * handled by the callers BEFORE consulting this module — a tool-call turn is
 * productive regardless of its text and resets the streak.
 *
 * Recovery action: inject a synthetic user-role nudge into the LLM context
 * and re-enter the loop. The nudge carries the shared SYNTHETIC_NUDGE_MARKER
 * so the compaction pipeline's verbatim anchor never latches onto it, in
 * either consumer. The nudge is LLM-context only — callers must NOT persist
 * it (see the route's post-compaction nudge for the rationale).
 */

import type { ChatMessage } from '@/services/llm';

import { SYNTHETIC_NUDGE_END, SYNTHETIC_NUDGE_MARKER } from '@/services/compact';
import { stripSpecialTokens } from '@/services/textUtils';

/** How many consecutive empty responses are retried before giving up. */
export const MAX_EMPTY_RESPONSE_RECOVERY_ATTEMPTS = 3;

/**
 * How many tool names the recovery nudge lists. The callers pass the tools
 * in the order they were sent to the provider, so the native tools come
 * first and this keeps all of them plus the first few MCP stubs; the rest
 * are reported as a count rather than dropped silently. The count matters:
 * a name the model invents is not a tool, so a list that quietly lost
 * entries would push the model back into guessing.
 */
export const MAX_RECOVERY_NUDGE_TOOL_NAMES = 24;

/**
 * Matches content that is nothing but a reasoning-channel label. Some
 * providers emit the bare channel name as the visible content while the real
 * text rides in a reasoning field; such content is not a meaningful reply.
 */
const CHANNEL_LABEL_ONLY_PATTERN = /^\s*(?:thought|analysis|final|commentary)\s*$/i;

/**
 * Clean a streamed/complete assistant text fragment for display or
 * meaningfulness checks: strip special LLM tokens and blank out content
 * that is only a channel label. Exported because the chat route also uses
 * it to sanitise streaming chunks before they reach the client.
 */
export function sanitizeAssistantTextFragment(text: string): string {
  const cleaned = stripSpecialTokens(text ?? '');
  return CHANNEL_LABEL_ONLY_PATTERN.test(cleaned.trim()) ? '' : cleaned;
}

/**
 * True when the assistant message carries a non-empty, non-channel-label
 * text body. Tool calls are deliberately NOT considered here — callers must
 * treat a tool-call turn as productive and reset their recovery streak
 * before consulting this function.
 */
export function hasMeaningfulAssistantContent(message: ChatMessage): boolean {
  const cleanedContent = sanitizeAssistantTextFragment(message.content ?? '').trim();
  if (cleanedContent.length === 0) {
    return false;
  }

  return !CHANNEL_LABEL_ONLY_PATTERN.test(cleanedContent);
}

/**
 * Format the tool names for the nudge. The list is capped so a large MCP
 * catalogue cannot flood the prompt, but a shortened list says how many
 * names were left out — a list that silently lost entries reads as a
 * complete one, and the model would then pick a name that is not in the
 * request's tool array (and such a call never runs).
 */
function formatToolNames(toolNames: readonly string[]): string {
  const unique = [...new Set(toolNames)];
  if (unique.length === 0) return '';
  const shown = unique.slice(0, MAX_RECOVERY_NUDGE_TOOL_NAMES);
  const omitted = unique.length - shown.length;
  return omitted > 0 ? `${shown.join(', ')} (+${omitted} more)` : shown.join(', ');
}

/**
 * Build the synthetic user-role nudge injected after an empty assistant
 * response. Returns a fresh object each call — never share one instance
 * across messages, since message arrays are mutated by their owning loops.
 *
 * The nudge is TOOL-CALL-PRESERVING. It leads with the tool call and names
 * the tools available in this turn, rather than leading with an instruction
 * to answer in prose: a model that reads "provide a direct answer" as its
 * next action stops calling tools and narrates the call instead ("I'll run
 * a quick live check now"), which yields another empty turn and spends an
 * attempt. Naming the tools is what keeps the next call inside the request's
 * tool array — a call whose name is not in that array never runs, so a model
 * that cannot see the names tends to invent one.
 *
 * `toolNames` must be the names of the tools actually sent to the provider
 * for this turn (the same array the request carries), not a static list.
 */
export function buildEmptyResponseRecoveryNudge(toolNames: readonly string[]): ChatMessage {
  const list = formatToolNames(toolNames);
  if (!list) {
    return {
      role: 'user',
      content:
        `${SYNTHETIC_NUDGE_MARKER}Your last response was empty. ` +
        `No tool is available in this turn, so reply with the answer itself.${SYNTHETIC_NUDGE_END}`,
    };
  }
  return {
    role: 'user',
    content:
      `${SYNTHETIC_NUDGE_MARKER}Your last response was empty. ` +
      `If the task needs a tool, call the tool now — make the call itself, do not describe what you would do in prose. ` +
      `The tools available in this turn are: ${list}. Call one of them by its exact name — a call whose name is not one of this turn's tools does not run. ` +
      `If the tool already ran and only its result is left to report, reply with a summary of that output and any errors instead.${
        SYNTHETIC_NUDGE_END
      }`,
  };
}

/**
 * Tracks the consecutive-empty-response streak for one agentic loop (one
 * chat request, or one sub-agent). The owning loop asks `shouldRecover()`
 * after each empty reply, calls `recordAttempt()` when it injects the nudge,
 * and calls `reset()` whenever a turn turned out to be productive (a
 * meaningful reply, or a tool-call turn) — mirroring the main loop's
 * established reset rules.
 */
export class EmptyResponseRecoveryTracker {
  private attempts = 0;

  /** True when at least one more retry is allowed for the current streak. */
  shouldRecover(): boolean {
    return this.attempts < MAX_EMPTY_RESPONSE_RECOVERY_ATTEMPTS;
  }

  /** Record that a recovery nudge is being injected for this streak. */
  recordAttempt(): void {
    this.attempts += 1;
  }

  /** Reset the streak — a productive turn (meaningful reply or tool calls). */
  reset(): void {
    this.attempts = 0;
  }

  /** Number of recovery attempts recorded since the last reset. */
  get attemptsUsed(): number {
    return this.attempts;
  }
}
