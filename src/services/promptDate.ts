/**
 * promptDate.ts - Calendar date used by the stable system prompt.
 *
 * Returns a LOCAL calendar date with no time-of-day component, e.g.
 * `Thursday, September 24, 2026`.
 *
 * Deliberately excludes hours, minutes and seconds. The system prompt is the
 * most cacheable part of every request, and prompt caching only reuses an
 * identical prompt prefix - so a per-second clock near the top of the prompt
 * made the prefix unique every second and defeated reuse entirely. Day
 * resolution changes at most once per calendar day, which keeps the prefix
 * byte-stable for the whole working day.
 *
 * Time-of-day awareness is carried by the per-user-message `[Sent ...]` stamp
 * instead (see `buildUserMessageStamp`), which is derived from the persisted
 * message `createdAt` and is therefore byte-stable across turns.
 *
 * Pure and dependency-free so it is safe to import from anywhere, including
 * client-side bundles.
 */
export function formatPromptDate(now: Date = new Date()): string {
  return now.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

/**
 * Full LOCAL date and time including the timezone abbreviation, e.g.
 * `Thursday, September 24, 2026 at 11:23 AM GMT+10`.
 *
 * Minute resolution: seconds would add noise without adding meaning to a value
 * that is captured once and then treated as fixed.
 *
 * Use this ONLY where the value is computed once and then held constant for a
 * whole request, turn or agent lifetime - for example the sub-agent task
 * message. Never put it in the shared system prompt: a value that varies per
 * request defeats prefix caching, which is exactly why `formatPromptDate`
 * exists as the cacheable day-resolution alternative.
 */
export function formatPromptDateTime(now: Date = new Date()): string {
  return now.toLocaleString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}
