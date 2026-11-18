import type { ReasoningEffort } from '@/types/chatConfig';

import {
  danglingCompactionProviderId,
  inheritDefaultCompactionSelection,
  type SessionSelection,
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
