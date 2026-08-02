/**
 * Canonical chat-message roles.
 *
 * Roles were previously inlined at five+ sites: `chatStore.ts:19`,
 * `route.ts:111`, `compact/route.ts:26`, `history.ts` (including a SQL
 * `IN ('user','assistant')` clause at line 133), and across adapter
 * translation. Centralising the union and providing a tuple for SQL builders
 * removes the silent drift risk when a new role is added.
 */

/** String-literal-union of every chat-message role. */
export type ChatRole = 'user' | 'assistant' | 'tool' | 'system' | 'subagent_log';

/** `as const` tuple — drives the typed-array shape used by SQL `IN (…)` builders. */
export const CHAT_ROLES = [
  'user',
  'assistant',
  'tool',
  'system',
  'subagent_log',
] as const satisfies readonly ChatRole[];

/** Fast membership check. */
export const CHAT_ROLE_SET: ReadonlySet<string> = new Set(CHAT_ROLES);

/** Lower-case lookup helper for adapter boundaries. */
export function asChatRole(value: string): ChatRole | null {
  return CHAT_ROLE_SET.has(value) ? (value as ChatRole) : null;
}
