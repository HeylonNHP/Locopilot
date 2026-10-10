import type { Session } from '@/app/lib/chatStore';

const APP_TITLE = 'Locopilot';

/**
 * Resolves the browser tab title for the active conversation.
 *
 * Title format:
 *   - No active session → "Locopilot"
 *   - Active session with a name → "{session.name} — Locopilot"
 *   - Active session without a name → "Session {id} — Locopilot"
 *
 * The value is rendered as a React-managed `<title>` (see `DocumentHead`)
 * rather than assigned to `document.title`, so it survives the `<head>`
 * re-commits Next.js performs after hydration.
 */
export function resolveDocumentTitle(currentSessionId: number | null, sessions: Session[]): string {
  if (currentSessionId === null) return APP_TITLE;

  const session = sessions.find((s) => s.id === currentSessionId);
  const name = session?.name?.trim();

  return name ? `${name} — ${APP_TITLE}` : `Session ${currentSessionId} — ${APP_TITLE}`;
}
