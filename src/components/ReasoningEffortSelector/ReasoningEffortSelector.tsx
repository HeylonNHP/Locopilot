'use client';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { useClickOutsideEscape } from '@/app/hooks/useClickOutsideEscape';
import { useChat } from '@/app/lib/chatStore';
import {
  saveDefaultsPatch,
  saveFailureMessage,
  saveSessionPatch,
} from '@/app/lib/sessionSelectionClient';
import { resolveCompactionRule } from '@/services/compactionRule';
import { type SessionDefaults, type SessionSelection } from '@/services/sessionSelection';
import {
  type ProviderConfig,
  REASONING_EFFORT_LABELS,
  REASONING_EFFORTS,
  type ReasoningEffort,
} from '@/types/chatConfig';

import './ReasoningEffortSelector.scss';

interface ReasoningEffortSelectorProps {
  anchorRef: React.RefObject<HTMLElement | null>;
  lastClickRef: React.RefObject<{ x: number; y: number } | null>;
  isOpen: boolean;
  onClose: () => void;
}

const LEVELS: ReadonlyArray<{ value: ReasoningEffort; label: string }> = REASONING_EFFORTS.map(
  (value) => ({ value, label: REASONING_EFFORT_LABELS[value] })
);

/**
 * Returns the levels appropriate for a provider. Ollama's reasoning ceiling is
 * `max` (the adapter maps `xhigh` → `max` anyway), so the `xhigh` option is
 * hidden for Ollama providers. OpenAI-compatible providers show every level.
 */
function levelsForProvider(provider: string | undefined) {
  if (provider === 'ollama') {
    return LEVELS.filter((l) => l.value !== 'xhigh');
  }
  return LEVELS;
}

/**
 * Ollama models expose a capabilities list; a model without the 'thinking'
 * capability cannot reason. OpenAI-compatible providers return no capabilities
 * from /v1/models, so treat those models as always reasoning-capable. When the
 * model is unknown (or carries no capability data) default to supported.
 */
function isReasoningSupported(
  provider: ProviderConfig | undefined,
  modelName: string | undefined,
  models: ReturnType<typeof useChat>['state']['models']
): boolean {
  if (provider?.provider !== 'ollama') return true;
  if (!modelName) return true;
  const entry = models.find((m) => m.name === modelName && m.providerId === provider.id);
  if (!entry) return true;
  return entry.capabilities?.includes('thinking') ?? true;
}

export default function ReasoningEffortSelector({
  anchorRef,
  lastClickRef,
  isOpen,
  onClose,
}: ReasoningEffortSelectorProps) {
  const { state, dispatch } = useChat();
  const [position, setPosition] = useState({ left: 0, bottom: 0, maxHeight: 420 });
  const panelRef = useRef<HTMLDivElement>(null);

  // Destructure only the fields used by this component so callbacks do not
  // depend on the entire state object (which changes on every render during
  // streaming, defeating useCallback).
  const {
    model,
    currentSessionId,
    compaction,
    reasoningEffort,
    compactionReasoningEffort,
    defaultModel,
    defaultProviderId,
    defaultCompactionModel,
    defaultCompactionProviderId,
    defaultReasoningEffort,
    defaultCompactionReasoningEffort,
    providers,
    activeProviderId,
    models,
  } = state;

  // The level the conversation actually runs at: its own pin, or the global
  // default it inherits.
  const effectiveReasoningEffort = reasoningEffort ?? defaultReasoningEffort;
  const effectiveCompactionReasoningEffort =
    compactionReasoningEffort ?? defaultCompactionReasoningEffort;

  // Resolve the active provider for the main model from `providers[]` +
  // `activeProviderId` (the legacy top-level `state.provider` field is stale
  // in multi-provider configs — see SettingsModal).
  //
  // The compaction model may live on a different provider. WHICH provider
  // that is follows the shared rule (`src/services/compactionRule.ts`), not
  // the raw pin: a conversation that pinned a compaction model without a
  // provider of its own still runs on one, and asking the main provider
  // about it would report the wrong set of supported reasoning levels.
  const effectiveCompaction = resolveCompactionRule({
    mainModel: model,
    sessionCompaction: compaction,
    globalCompactionModel: defaultCompactionModel,
    globalCompactionProviderId: defaultCompactionProviderId,
  });
  const mainProvider = providers?.find((p) => p.id === activeProviderId) ?? providers?.[0];
  // A `null` provider in the rule means "the main chat provider".
  const effectiveCompactionProviderId = effectiveCompaction.providerId ?? activeProviderId;
  const compactionProvider =
    providers?.find((p) => p.id === effectiveCompactionProviderId) || mainProvider;

  const mainLevels = levelsForProvider(mainProvider?.provider);
  const compactionLevels = levelsForProvider(compactionProvider?.provider);

  const mainSupported = isReasoningSupported(mainProvider, model, models);
  const effectiveCompactionModel = effectiveCompaction.model;
  const compactionSupported = isReasoningSupported(
    compactionProvider,
    effectiveCompactionModel,
    models
  );

  // Position the dropdown above the anchor when opened. Prefer the recorded
  // click coordinates (which always reflect the exact point the user clicked)
  // and fall back to the anchor ref's rect for keyboard activation.
  useLayoutEffect(() => {
    if (!isOpen) return;

    const updatePosition = () => {
      const click = lastClickRef.current;
      const anchor = anchorRef.current;
      const dropdownWidth = 320;
      const margin = 16;

      const anchorX =
        click?.x ??
        (anchor
          ? anchor.getBoundingClientRect().left + anchor.getBoundingClientRect().width / 2
          : window.innerWidth / 2);
      const anchorTopY =
        click?.y ?? (anchor ? anchor.getBoundingClientRect().top : window.innerHeight);

      let left = anchorX - dropdownWidth / 2;
      if (left < margin) left = margin;
      else if (left + dropdownWidth > window.innerWidth - margin)
        left = window.innerWidth - dropdownWidth - margin;

      const bottom = window.innerHeight - anchorTopY + 8;

      // Cap height so it never extends above the viewport top
      const availableHeight = anchorTopY - margin;
      const maxHeight = Math.min(420, Math.max(200, availableHeight));

      setPosition({ left, bottom, maxHeight });
    };

    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [isOpen, anchorRef, lastClickRef]);

  // Close on outside click and Escape
  useClickOutsideEscape(panelRef, { isOpen, onClose });

  /**
   * Save one level.
   *
   * Only the level the user changed is written (the session row and the
   * global default for that field), so this control cannot move the other
   * default or any of the model fields. The conversation on screen follows
   * the pick only once the server has accepted it: a level the server does
   * not know about is a level that is lost on the next reload.
   */
  const persistLevel = useCallback(
    async (field: 'reasoningEffort' | 'compactionReasoningEffort', level: ReasoningEffort) => {
      const selectionPatch =
        field === 'reasoningEffort'
          ? { reasoningEffort: level }
          : { compactionReasoningEffort: level };
      // A pick is also what the next new conversation starts with.
      const defaultsPatch =
        field === 'reasoningEffort'
          ? { reasoningEffort: level }
          : { compactionReasoningEffort: level };

      const selection: SessionSelection = {
        model,
        providerId: activeProviderId,
        compaction,
        reasoningEffort: field === 'reasoningEffort' ? level : reasoningEffort,
        compactionReasoningEffort:
          field === 'compactionReasoningEffort' ? level : compactionReasoningEffort,
      };
      const defaults: SessionDefaults = {
        model: defaultModel,
        providerId: defaultProviderId,
        compactionModel: defaultCompactionModel,
        compactionProviderId: defaultCompactionProviderId,
        reasoningEffort: field === 'reasoningEffort' ? level : defaultReasoningEffort,
        compactionReasoningEffort:
          field === 'compactionReasoningEffort' ? level : defaultCompactionReasoningEffort,
      };

      const sessionSaved = await saveSessionPatch(currentSessionId, selectionPatch);
      if (!sessionSaved.ok) {
        dispatch({
          type: 'SET_ERROR',
          error: saveFailureMessage(
            'The reasoning level could not be saved for this conversation.',
            sessionSaved
          ),
        });
        return;
      }
      const defaultsSaved = await saveDefaultsPatch(defaultsPatch);
      if (!defaultsSaved.ok) {
        // The conversation's row IS saved, so the screen follows it (the
        // server's row is the truth) and only the global default is behind.
        if (currentSessionId !== null) {
          dispatch({ type: 'APPLY_SESSION_SELECTION', sessionId: currentSessionId, selection });
        }
        dispatch({
          type: 'SET_ERROR',
          error: saveFailureMessage(
            'The reasoning level was saved for this conversation, but not for new chats.',
            defaultsSaved
          ),
        });
        return;
      }

      dispatch({ type: 'SET_SESSION_SELECTION', selection, defaults });
    },
    [
      activeProviderId,
      compaction,
      compactionReasoningEffort,
      defaultCompactionModel,
      defaultCompactionProviderId,
      defaultCompactionReasoningEffort,
      defaultModel,
      defaultProviderId,
      defaultReasoningEffort,
      currentSessionId,
      dispatch,
      model,
      reasoningEffort,
    ]
  );

  const handleChangeMain = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      void persistLevel('reasoningEffort', e.target.value as ReasoningEffort);
    },
    [persistLevel]
  );

  const handleChangeCompaction = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      void persistLevel('compactionReasoningEffort', e.target.value as ReasoningEffort);
    },
    [persistLevel]
  );

  if (!isOpen) return null;

  return createPortal(
    <div
      ref={panelRef}
      className="reasoning-effort-selector"
      style={{
        position: 'fixed',
        left: position.left,
        bottom: position.bottom,
        maxHeight: position.maxHeight,
      }}
    >
      <div className="reasoning-effort-selector-header">Reasoning effort</div>
      <div className="reasoning-effort-selector-rows">
        <div className="reasoning-effort-selector-row">
          <label className="reasoning-effort-selector-label">
            Main model
            <select
              className="reasoning-effort-selector-select"
              value={effectiveReasoningEffort}
              onChange={handleChangeMain}
              disabled={!mainSupported}
            >
              {mainLevels.map((l) => (
                <option key={l.value} value={l.value}>
                  {l.label}
                </option>
              ))}
            </select>
          </label>
          {!mainSupported && (
            <span className="reasoning-effort-selector-hint">Not supported by this model</span>
          )}
        </div>
        <div className="reasoning-effort-selector-row">
          <label className="reasoning-effort-selector-label">
            Compaction model
            <select
              className="reasoning-effort-selector-select"
              value={effectiveCompactionReasoningEffort}
              onChange={handleChangeCompaction}
              disabled={!compactionSupported}
            >
              {compactionLevels.map((l) => (
                <option key={l.value} value={l.value}>
                  {l.label}
                </option>
              ))}
            </select>
          </label>
          {!compactionSupported && (
            <span className="reasoning-effort-selector-hint">Not supported by this model</span>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
