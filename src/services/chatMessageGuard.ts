/**
 * Runtime check for a conversation message that arrives in a request body.
 *
 * The chat and compact routes both accept the page's copy of the conversation,
 * which is untrusted input that is later sanitised and written to the database.
 * One guard keeps the two routes' rules identical, and checks the nested
 * `subagentTraces` list too: a malformed list would otherwise throw deep inside
 * the sanitiser instead of being refused up front.
 */

import type { ChatMessage, SubagentTrace } from '@/services/adapters/llmAdapter';

const ROLES: ReadonlySet<string> = new Set(['system', 'user', 'assistant', 'tool']);

function isSubagentTrace(value: unknown): value is SubagentTrace {
  if (typeof value !== 'object' || value === null) return false;
  const trace = value as Record<string, unknown>;
  return typeof trace.agentId === 'string' && typeof trace.content === 'string';
}

/** True when `value` has the shape of a `ChatMessage` the routes can safely process. */
export function isChatMessage(value: unknown): value is ChatMessage {
  if (typeof value !== 'object' || value === null) return false;
  const message = value as Record<string, unknown>;
  if (typeof message.role !== 'string' || !ROLES.has(message.role)) return false;
  if (typeof message.content !== 'string') return false;
  if (message.subagentTraces !== undefined) {
    return Array.isArray(message.subagentTraces) && message.subagentTraces.every(isSubagentTrace);
  }
  return true;
}
