import type { ChatAction } from '@/app/lib/chatStore';
import type { ReasoningEffort } from '@/types/chatConfig';

import { saveFailureMessage, type SaveResult } from '@/app/lib/sessionSelectionClient';
import {
  danglingCompactionProviderId,
  inheritDefaultCompactionSelection,
  type SessionSelection,
  type SessionSelectionPatch,
} from '@/services/sessionSelection';

/** The part of the store the repair decision reads. */
export interface CompactionRepairInput {
  currentSessionId: number | null;
  compaction: SessionSelection['compaction'];
  providers: readonly { id: string }[];
  model: string;
  activeProviderId: string | null;
  reasoningEffort: ReasoningEffort | null | undefined;
  compactionReasoningEffort: ReasoningEffort | null | undefined;
}

export interface CompactionRepair {
  sessionId: number;
  /** The provider id the conversation was pinned to and that no longer exists. */
  missingProviderId: string;
  /** The conversation's selection with its compaction reset to the default. */
  selection: SessionSelection;
}

/**
 * What to do about a conversation whose compaction pin names a provider that
 * is no longer configured — or `null` when nothing is wrong.
 *
 * Only a saved conversation is repaired (a new chat has no pin to lose), and
 * everything but the compaction selection is carried over unchanged, so the
 * repair cannot move the model or either reasoning level.
 */
export function planCompactionRepair(input: CompactionRepairInput): CompactionRepair | null {
  if (input.currentSessionId === null) return null;
  const missingProviderId = danglingCompactionProviderId(input.compaction, input.providers);
  if (missingProviderId === null) return null;
  return {
    sessionId: input.currentSessionId,
    missingProviderId,
    selection: {
      model: input.model,
      providerId: input.activeProviderId,
      compaction: inheritDefaultCompactionSelection(),
      reasoningEffort: input.reasoningEffort ?? null,
      compactionReasoningEffort: input.compactionReasoningEffort ?? null,
    },
  };
}

/** What the repair needs from its surroundings; injected so it can be tested. */
export interface CompactionRepairDeps {
  dispatch: (action: ChatAction) => void;
  save: (sessionId: number, patch: SessionSelectionPatch) => Promise<SaveResult>;
  /**
   * The conversation a repair is in flight for. A repair that is already
   * running for a conversation is not started a second time.
   */
  inFlight: { current: number | null };
}

/** The sentence shown after a repair that was saved. */
export function compactionRepairNotice(missingProviderId: string): string {
  return `This conversation's compaction provider "${missingProviderId}" is no longer configured, so it now uses the default compaction model. Pick a compaction model in the model menu if you want a different one.`;
}

/** The sentence shown after a repair that was applied on screen but not saved. */
export function compactionRepairSaveFailure(missingProviderId: string, saved: SaveResult): string {
  return saveFailureMessage(
    `This conversation's compaction provider "${missingProviderId}" is no longer configured. It now uses the default compaction model on screen, but that could not be saved.`,
    saved
  );
}

/**
 * Carry out a planned repair: put the reset on screen, save it to the
 * conversation's row, and tell the user.
 *
 * The reset is dispatched BEFORE the save, so the screen is right at once and
 * the next plan sees an inherited compaction and does nothing; the row is
 * written after, and a failed write is reported with the server's reason
 * instead of being swallowed. Returns `true` when it acted.
 */
export async function applyCompactionRepair(
  repair: CompactionRepair | null,
  deps: CompactionRepairDeps
): Promise<boolean> {
  if (repair === null || deps.inFlight.current === repair.sessionId) return false;
  const { sessionId, missingProviderId, selection } = repair;
  deps.inFlight.current = sessionId;
  deps.dispatch({ type: 'APPLY_SESSION_SELECTION', sessionId, selection });
  try {
    const saved = await deps.save(sessionId, { compaction: selection.compaction });
    deps.dispatch({
      type: 'SET_ERROR',
      error: saved.ok
        ? compactionRepairNotice(missingProviderId)
        : compactionRepairSaveFailure(missingProviderId, saved),
    });
  } finally {
    deps.inFlight.current = null;
  }
  return true;
}
