/**
 * Status line helper for Locopilot's terminal UI.
 *
 * This module maintains a small live-line display while the assistant is
 * thinking or tools are executing. It shows the current phase, optional model
 * name, and token usage with a spinner. The status line is updated on a short
 * interval and cleared when the turn is complete.
 *
 * The backend is swappable via setStatusLineBackend(), allowing the web UI
 * to intercept status updates with its own rendering logic.
 */

type StatusSnapshot = {
    phase: string;
    tokensUsed: number;
    tokenLimit: number;
    model?: string;
    tokenSource?: 'estimated' | 'ollama';
    vramUsed?: number | undefined;
    cachedTokens?: number | undefined;
    cachedMessagesLen?: number | undefined;
    cachedModel?: string | undefined;
};

let state: StatusSnapshot | null = null;

// -------------------------------------------------------------------------
// Swappable backend
// -------------------------------------------------------------------------

export interface StatusLineBackend {
    update(snapshot: StatusSnapshot): void;
    clear(): void;
}

const noopBackend: StatusLineBackend = {
    update() {},
    clear() {},
};

let activeBackend: StatusLineBackend = noopBackend;

/**
 * Replace the active StatusLineBackend.
 * Pass a custom backend to intercept status updates (e.g., for the web UI).
 */
export function setStatusLineBackend(backend: StatusLineBackend): void {
    activeBackend = backend;
}

// -------------------------------------------------------------------------
// Public API (delegates to activeBackend)
// -------------------------------------------------------------------------

export function updateLiveStatus(next: StatusSnapshot) {
    activeBackend.update(next);
}

export function updatePhase(phase: string, stats?: Partial<Omit<StatusSnapshot, 'phase'>>) {
    state = {
        phase,
        tokensUsed: stats?.tokensUsed ?? state?.tokensUsed ?? 0,
        tokenLimit: stats?.tokenLimit ?? state?.tokenLimit ?? 0,
        model: stats?.model ?? state?.model ?? '',
        tokenSource: stats?.tokenSource ?? state?.tokenSource ?? 'estimated',
        vramUsed: stats?.vramUsed ?? (state?.vramUsed ?? undefined) as number | undefined,
        cachedTokens: stats?.cachedTokens ?? (state?.cachedTokens ?? undefined) as number | undefined,
        cachedMessagesLen: stats?.cachedMessagesLen ?? (state?.cachedMessagesLen ?? undefined) as number | undefined,
        cachedModel: stats?.cachedModel ?? (state?.cachedModel ?? undefined) as string | undefined,
    };
    activeBackend.update(state);
}

export function updateVram(usedBytes?: number) {
    if (!state) return;
    state.vramUsed = usedBytes;
    activeBackend.update(state);
}

export function clearLiveStatus() {
    activeBackend.clear();
}
