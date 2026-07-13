'use client';

import { useEffect } from 'react';

import type { Session } from '@/app/lib/chatStore';

const APP_TITLE = 'Locopilot';

/**
 * Keeps the browser tab/window title in sync with the active conversation.
 *
 * Title format:
 *   - No active session → "Locopilot"
 *   - Active session with a name → "{session.name} — Locopilot"
 *   - Active session without a name → "Session {id} — Locopilot"
 */
export function useDocumentTitle(currentSessionId: number | null, sessions: Session[]): void {
  useEffect(() => {
    if (currentSessionId === null) {
      document.title = APP_TITLE;
      return;
    }

    const session = sessions.find((s) => s.id === currentSessionId);
    const name = session?.name?.trim();

    document.title = name ? `${name} — ${APP_TITLE}` : `Session ${currentSessionId} — ${APP_TITLE}`;
  }, [currentSessionId, sessions]);
}
