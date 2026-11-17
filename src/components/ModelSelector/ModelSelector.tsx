'use client';
import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { useClickOutsideEscape } from '@/app/hooks/useClickOutsideEscape';
import { type LLmModel, useChat } from '@/app/lib/chatStore';
import { saveDefaultsPatch, saveSessionPatch } from '@/app/lib/sessionSelectionClient';
import {
  buildMidTurnSwitch,
  isEmptyMidTurnSwitch,
  type MidTurnModelSwitch,
  requestMidTurnModelSwitch,
} from '@/app/lib/switchModelClient';
import { resolveCompactionRule } from '@/services/compactionRule';
import {
  compactionSelectionForModel,
  compactionSelectionToPair,
  type SessionDefaults,
  type SessionDefaultsPatch,
  type SessionSelection,
  type SessionSelectionPatch,
} from '@/services/sessionSelection';

import { toggleProviderCollapsed, useCollapsedProviders } from './collapsedProviders';

import './ModelSelector.scss';

const CAPABILITY_LABELS: Record<string, string> = {
  tools: 'Tools',
  vision: 'Vision',
  thinking: 'Thinking',
  audio: 'Audio',
};

function getCapabilityBadges(capabilities?: string[]): string[] {
  if (!Array.isArray(capabilities) || capabilities.length === 0) {
    return [];
  }

  const normalized = new Set<string>();

  for (const capability of capabilities) {
    const key = capability.toLowerCase().trim();
    switch (key) {
      case 'tools': {
        normalized.add('tools');
        break;
      }
      case 'vision':
      case 'multimodal':
      case 'image': {
        normalized.add('vision');
        break;
      }
      case 'thinking': {
        normalized.add('thinking');
        break;
      }
      case 'audio': {
        normalized.add('audio');
        break;
      }
      default: {
        // Preserve any capability the backend reports that we don't have a
        // canonical alias for. This prevents unknown model features from
        // being silently dropped in the selector badge list.
        normalized.add(key);
        break;
      }
    }
  }

  const capabilityOrder = ['tools', 'vision', 'thinking', 'audio'] as const;
  const known = capabilityOrder.filter((capability) => normalized.has(capability));
  const knownSet = new Set(known);
  const unknown = [...normalized]
    .filter((capability) => !knownSet.has(capability as (typeof capabilityOrder)[number]))
    .sort()
    .map(
      (capability) =>
        CAPABILITY_LABELS[capability] ?? capability.charAt(0).toUpperCase() + capability.slice(1)
    );

  return [...known.map((capability) => CAPABILITY_LABELS[capability]!), ...unknown];
}

interface ModelSelectorProps {
  anchorRef: React.RefObject<HTMLElement | null>;
  lastClickRef: React.RefObject<{ x: number; y: number } | null>;
  isOpen: boolean;
  onClose: () => void;
  /** Whether this selector updates the main chat model or the compaction model. */
  mode?: 'model' | 'compaction';
}

/**
 * Group models by provider display name, preserving the order in which
 * providers first appear (a Map keeps insertion order, and duplicate
 * display names merge into one section - matching the previous grouping).
 */
function groupModelsByProvider(models: LLmModel[]): Array<[string, LLmModel[]]> {
  const byProvider = new Map<string, LLmModel[]>();
  for (const model of models) {
    const group = byProvider.get(model.providerName);
    if (group) {
      group.push(model);
    } else {
      byProvider.set(model.providerName, [model]);
    }
  }
  return [...byProvider.entries()];
}

interface ModelItemProps {
  model: LLmModel;
  active: boolean;
  onSelect: (modelName: string, providerId?: string) => void;
}

function ModelItem({ model, active, onSelect }: ModelItemProps) {
  const capabilityBadges = getCapabilityBadges(model.capabilities);
  return (
    <button
      type="button"
      className={`model-selector-item ${active ? 'model-selector-item-active' : ''}`}
      onClick={() => onSelect(model.name, model.providerId)}
      title={
        capabilityBadges.length > 0
          ? `${model.displayName ?? model.name} (${capabilityBadges.join(', ')})`
          : (model.displayName ?? model.name)
      }
    >
      <span className="model-selector-check">
        {active && (
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path
              d="M3 8.5L6.5 12L13 5"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
      </span>
      <span className="model-selector-content">
        <span className="model-selector-name">{model.displayName ?? model.name}</span>
        {capabilityBadges.length > 0 && (
          <span
            className="model-selector-badges"
            aria-label={`Capabilities: ${capabilityBadges.join(', ')}`}
          >
            {capabilityBadges.map((badge) => (
              <span key={badge} className="model-selector-badge">
                {badge}
              </span>
            ))}
          </span>
        )}
      </span>
    </button>
  );
}

interface ProviderSectionProps {
  providerName: string;
  models: LLmModel[];
  /** Whether this section is collapsed in browsing mode. */
  collapsed: boolean;
  /**
   * While a search term is active every matching model must be visible, so
   * sections render expanded and the header degrades to an inert label -
   * a toggle with no visible effect would be a dead affordance.
   */
  searching: boolean;
  isModelActive: (model: LLmModel) => boolean;
  onSelect: (modelName: string, providerId?: string) => void;
  onToggle: (providerName: string) => void;
}

function ProviderSection({
  providerName,
  models,
  collapsed,
  searching,
  isModelActive,
  onSelect,
  onToggle,
}: ProviderSectionProps) {
  const contentId = useId();
  const expanded = searching || !collapsed;
  const containsActive = models.some(isModelActive);

  const header = searching ? (
    <div className="model-selector-provider-header">
      <span className="model-selector-provider-name">{providerName}</span>
      <span className="model-selector-provider-count">{models.length}</span>
    </div>
  ) : (
    <button
      type="button"
      className="model-selector-provider-header"
      onClick={() => onToggle(providerName)}
      aria-expanded={expanded}
      aria-controls={contentId}
      title={expanded ? `Collapse ${providerName}` : `Expand ${providerName}`}
    >
      <span className="model-selector-provider-name">{providerName}</span>
      {collapsed && containsActive && (
        <span
          className="model-selector-provider-active-dot"
          title="Contains the active model"
          aria-hidden="true"
        />
      )}
      <span className="model-selector-provider-count">{models.length}</span>
      <svg
        className="model-selector-provider-chevron"
        width="12"
        height="12"
        viewBox="0 0 16 16"
        fill="none"
        aria-hidden="true"
      >
        <path
          d="M4 6l4 4 4-4"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );

  return (
    <div className="model-selector-provider-section">
      {header}
      {expanded && (
        <div id={contentId} className="model-selector-provider-items">
          {models.map((m) => (
            <ModelItem
              key={`${m.providerId}::${m.name}`}
              model={m}
              active={isModelActive(m)}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default function ModelSelector({
  anchorRef,
  lastClickRef,
  isOpen,
  onClose,
  mode = 'model',
}: ModelSelectorProps) {
  const { state, dispatch, abortControllersRef } = useChat();

  // Destructure only the fields used by this component so callbacks do not
  // depend on the entire state object (which changes on every render during
  // streaming, defeating useCallback).
  const {
    models,
    model,
    activeProviderId,
    compaction,
    defaultModel,
    defaultProviderId,
    defaultCompactionModel,
    defaultCompactionProviderId,
    reasoningEffort,
    compactionReasoningEffort,
    defaultReasoningEffort,
    defaultCompactionReasoningEffort,
    currentSessionId,
    streamingSessions,
  } = state;

  // The conversation's OWN compaction model, which is `null` when it
  // inherits the global default and `''` when it compacts with its own main
  // model. The pickers show what the conversation chose; the status bar
  // shows what is actually used.
  const activeModel = mode === 'compaction' ? compactionSelectionToPair(compaction).model : model;

  const inheritedCompactionName = defaultCompactionModel || model || 'the main model';

  // What this conversation will ACTUALLY compact with: its own pinned
  // pair, else the global pair, else its own main model on the main
  // provider. This is the SERVER's rule (`src/services/compactionRule.ts`),
  // read here so the highlight cannot disagree with what the server does —
  // the module has no imports precisely so both sides can share it.
  const effectiveCompaction = resolveCompactionRule({
    mainModel: model,
    sessionCompaction: compaction,
    globalCompactionModel: defaultCompactionModel,
    globalCompactionProviderId: defaultCompactionProviderId,
  });
  // A `null` provider in the rule means "the main chat provider", which is
  // the conversation's own provider here.
  const effectiveCompactionProviderId = effectiveCompaction.providerId ?? activeProviderId;

  // The session whose turn can still take a model switch on board, or null
  // when nothing is streaming and the config update alone is enough.
  const streamingSessionId =
    currentSessionId !== null && streamingSessions.has(currentSessionId) ? currentSessionId : null;

  const switchMidTurn = useCallback(
    async (payload: MidTurnModelSwitch) => {
      if (streamingSessionId === null) return;
      // Nothing to switch: the route refuses an empty body with HTTP 400,
      // and there is no request to make. The "(switching...)" badge must
      // not appear for a switch that does not exist.
      if (isEmptyMidTurnSwitch(payload)) return;
      dispatch({
        type: 'SET_MODEL_SWITCH_PENDING',
        sessionId: streamingSessionId,
        pending: true,
      });
      // Attach the mid-turn fetch to the signal of the turn it is switching
      // — looked up per session from the shared abort map, i.e. the SAME
      // controller the Stop button aborts. If the user clicks Stop while the
      // request is in flight, the fetch is aborted client-side and the
      // server-side `pendingSwitches[sessionId]` is cleared by the route's
      // `unregisterActiveTurn` rather than being silently dropped after the
      // turn's finally runs.
      const result = await requestMidTurnModelSwitch(
        streamingSessionId,
        payload,
        abortControllersRef.current.get(streamingSessionId)?.signal
      );
      if (!result.accepted) {
        dispatch({
          type: 'SET_MODEL_SWITCH_PENDING',
          sessionId: streamingSessionId,
          pending: false,
        });
      }
      // A refusal is REPORTED. The server's message names the cause, and
      // the error banner is where the rest of the app says what went
      // wrong. A switch that was refused and not shown is a switch the
      // user believes happened.
      //
      // Aimed at the conversation whose turn was asked to switch: the user
      // may have moved to another one while the request was in flight.
      if (result.message !== null) {
        dispatch({
          type: 'SET_ERROR',
          error: result.message,
          targetSessionId: streamingSessionId,
        });
      }
    },
    [dispatch, streamingSessionId, abortControllersRef]
  );

  const [search, setSearch] = useState('');
  const [position, setPosition] = useState({ left: 0, bottom: 0, maxHeight: 420 });
  const panelRef = useRef<HTMLDivElement>(null);

  // Provider-section collapse state: shared between the main-model and
  // compaction selector instances and persisted across reloads (see
  // collapsedProviders.ts for why this lives outside chatStore).
  const collapsedProviders = useCollapsedProviders();

  // While searching, all matching models are shown regardless of collapse
  // state - hiding matches behind a collapsed section would make the search
  // feel broken.
  const searching = search.trim().length > 0;

  const filteredModels = models.filter((m) => {
    const term = search.toLowerCase();
    return (
      m.name.toLowerCase().includes(term) || (m.displayName ?? '').toLowerCase().includes(term)
    );
  });

  // For compaction mode, match on the compaction-specific provider id
  // (transient) instead of the active chat provider id.
  const isModelActive = useCallback(
    (m: LLmModel) => {
      if (mode !== 'compaction') {
        return m.name === activeModel && m.providerId === activeProviderId;
      }
      // "Same as main model" and "Use the default" are represented by their
      // own rows at the top of the list; highlighting a model row as well
      // would say two different things at once.
      if (typeof activeModel !== 'string' || activeModel === '') return false;
      // The EFFECTIVE pair, not the raw pin: a conversation that pinned a
      // model without a provider of its own still runs on a provider, and
      // highlighting by the raw pin would match nothing at all.
      return m.name === effectiveCompaction.model && m.providerId === effectiveCompactionProviderId;
    },
    [mode, activeModel, activeProviderId, effectiveCompaction.model, effectiveCompactionProviderId]
  );

  // Position the dropdown above the anchor when opened, centred horizontally.
  // We measure in a layout effect to avoid a flash of wrong position, and
  // re-measure on window resize so it stays aligned.
  //
  // Primary positioning source is the recorded mouse click coordinates
  // (lastClickRef), which always reflects the exact point the user clicked.
  // The anchor ref is used as a fallback for keyboard activation (Enter/Space)
  // where no click coordinates exist.
  useLayoutEffect(() => {
    if (!isOpen) return;

    const updatePosition = () => {
      const click = lastClickRef.current;
      const anchor = anchorRef.current;
      const dropdownWidth = 320;
      const panelPadding = 8;
      const margin = 16;

      // Determine the anchor point: prefer click coordinates (X), fall back
      // to the anchor ref's centre (for keyboard activation).
      const anchorX =
        click?.x ??
        (anchor
          ? anchor.getBoundingClientRect().left + anchor.getBoundingClientRect().width / 2
          : window.innerWidth / 2);
      const anchorTopY =
        click?.y ?? (anchor ? anchor.getBoundingClientRect().top : window.innerHeight);

      let left = anchorX - dropdownWidth / 2;
      if (left < margin) {
        left = margin;
      } else if (left + dropdownWidth > window.innerWidth - margin) {
        left = window.innerWidth - dropdownWidth - margin;
      }

      // Anchor the dropdown's bottom just above the click point so the panel
      // visually emerges from where the user clicked.
      const bottom = window.innerHeight - anchorTopY + panelPadding;

      // Cap the dropdown height so it never extends above the viewport top.
      // Leave 16px margin at the top for breathing room.
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

  // Reset search when opened
  useEffect(() => {
    if (isOpen) setSearch('');
  }, [isOpen]);

  // Close on outside click and Escape
  useClickOutsideEscape(panelRef, { isOpen, onClose });

  /**
   * Apply a pick to the conversation on screen.
   *
   * Only the fields the picker changed are written (the conversation's row
   * first, then the global defaults), so this control cannot erase a value
   * another control or tab just set. The conversation's own row is written
   * before anything changes on screen: a selection the server does not know
   * about is a selection that is lost on the next reload.
   */
  const applySelection = useCallback(
    async (
      selectionPatch: SessionSelectionPatch,
      defaultsPatch: SessionDefaultsPatch,
      midTurn: MidTurnModelSwitch
    ) => {
      // The reducer states the complete selection: the conversation's own
      // with the pick applied, and the current defaults with the pick
      // applied.
      const selection: SessionSelection = {
        model: selectionPatch.model ?? model,
        providerId:
          selectionPatch.providerId === undefined ? activeProviderId : selectionPatch.providerId,
        // The compaction selection is ONE value: a patch states the whole
        // selection or none of it.
        compaction: selectionPatch.compaction ?? compaction,
        reasoningEffort,
        compactionReasoningEffort,
      };
      const defaults: SessionDefaults = {
        model: defaultsPatch.model ?? defaultModel,
        providerId:
          defaultsPatch.providerId === undefined ? defaultProviderId : defaultsPatch.providerId,
        compactionModel: defaultsPatch.compactionModel ?? defaultCompactionModel,
        // `undefined` means "the global provider is unchanged"; `null` means
        // "clear it" (the compaction then runs on the main chat provider).
        // `??` would collapse the two, so the check is explicit.
        compactionProviderId:
          defaultsPatch.compactionProviderId === undefined
            ? defaultCompactionProviderId
            : defaultsPatch.compactionProviderId,
        reasoningEffort: defaultsPatch.reasoningEffort ?? defaultReasoningEffort,
        compactionReasoningEffort:
          defaultsPatch.compactionReasoningEffort ?? defaultCompactionReasoningEffort,
      };

      if (!(await saveSessionPatch(currentSessionId, selectionPatch))) {
        dispatch({
          type: 'SET_ERROR',
          error: 'The model could not be saved for this conversation.',
        });
        onClose();
        return;
      }
      if (!(await saveDefaultsPatch(defaultsPatch))) {
        // The conversation's row IS saved, so the screen follows it (the
        // server's row is the truth) and only the global default is behind.
        // The default stays as the server has it, which is what the store
        // keeps.
        if (currentSessionId !== null) {
          dispatch({ type: 'APPLY_SESSION_SELECTION', sessionId: currentSessionId, selection });
        }
        dispatch({
          type: 'SET_ERROR',
          error: 'The model was saved for this conversation, but not for new chats.',
        });
        onClose();
        return;
      }

      dispatch({ type: 'SET_SESSION_SELECTION', selection, defaults });
      await switchMidTurn(midTurn);
      onClose();
    },
    [
      activeProviderId,
      compaction,
      compactionReasoningEffort,
      currentSessionId,
      defaultCompactionModel,
      defaultCompactionProviderId,
      defaultCompactionReasoningEffort,
      defaultModel,
      defaultProviderId,
      defaultReasoningEffort,
      dispatch,
      model,
      onClose,
      reasoningEffort,
      switchMidTurn,
    ]
  );

  const handleSelectModel = useCallback(
    (modelName: string, providerId?: string | null) =>
      applySelection(
        { model: modelName, providerId: providerId ?? null },
        // The main model changed; the default compaction model and both
        // reasoning defaults are not touched.
        { model: modelName, providerId: providerId ?? null },
        buildMidTurnSwitch({ model: modelName, providerId })
      ),
    [applySelection]
  );

  const handleSelectCompaction = useCallback(
    (nextCompactionModel: string | null, providerId?: string | null) => {
      // A named model that names no provider cannot be pinned: the model
      // says nothing about which endpoint serves it. The pick is refused
      // here rather than stored — a half-pair is exactly the state the
      // union exists to make unrepresentable.
      const picked = compactionSelectionForModel(nextCompactionModel, providerId ?? null);
      if (picked === null) {
        dispatch({
          type: 'SET_ERROR',
          error:
            'That model does not name a provider, so it cannot be used for compaction. Pick a model of a configured provider.',
        });
        onClose();
        return;
      }
      void applySelection(
        {
          // ONE value: the conversation's own compaction selection. A model
          // and the provider that serves it travel together, so a pick can
          // never be a half-pair.
          compaction: picked,
        },
        // "Use the default" (`null`) leaves the default alone.
        nextCompactionModel === null
          ? {}
          : {
              compactionModel: nextCompactionModel,
              // The global pair travels together: a global compaction model
              // with no provider of its own would be sent to whichever
              // provider the main chat uses, which is how a cloud-only
              // compaction model ended up at the wrong endpoint (a 404).
              // "Same as main model" clears the provider, because the global
              // pair then means "the main model on the main provider".
              compactionProviderId: providerId ?? null,
            },
        // The compaction selection travels WHOLE, in every state.
        //
        // "Use the default" travels too: the union can say it, so the
        // running turn resolves the GLOBAL pair at its next tool step,
        // exactly like the next turn would. Before the union existed the
        // switch could not express it (the flat pair had no spelling for
        // it), so the pick was dropped - and what was left was an EMPTY
        // request, which the route refuses with HTTP 400 while the client
        // threw the refusal away.
        buildMidTurnSwitch({ compaction: picked })
      );
    },
    [applySelection, dispatch, onClose]
  );

  const handleSelect: (modelName: string, providerId?: string) => void =
    mode === 'compaction' ? handleSelectCompaction : handleSelectModel;

  if (!isOpen) return null;

  return createPortal(
    <div
      ref={panelRef}
      className="model-selector"
      style={{
        position: 'fixed',
        left: position.left,
        bottom: position.bottom,
        maxHeight: position.maxHeight,
      }}
    >
      <div className="model-selector-header">
        <input
          type="text"
          placeholder="Search models..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="model-selector-search"
          autoFocus
        />
      </div>
      <div className="model-selector-list">
        {mode === 'compaction' && (
          <button
            key="__same-as-main__"
            className={`model-selector-item ${activeModel === '' ? 'model-selector-item-active' : ''}`}
            onClick={() => handleSelectCompaction('', null)}
            title="Use the currently selected chat model for compaction"
          >
            <span className="model-selector-check">
              {activeModel === '' && (
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                  <path
                    d="M3 8.5L6.5 12L13 5"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              )}
            </span>
            <span className="model-selector-content">
              <span className="model-selector-name">Same as main model</span>
            </span>
          </button>
        )}
        {mode === 'compaction' && (
          <button
            key="__use-the-default__"
            className={`model-selector-item ${activeModel === null ? 'model-selector-item-active' : ''}`}
            onClick={() => handleSelectCompaction(null, null)}
            title={`Use the default compaction model (${inheritedCompactionName})`}
          >
            <span className="model-selector-check">
              {activeModel === null && (
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                  <path
                    d="M3 8.5L6.5 12L13 5"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              )}
            </span>
            <span className="model-selector-content">
              <span className="model-selector-name">Use the default</span>
            </span>
          </button>
        )}
        {filteredModels.length === 0 ? (
          <div className="model-selector-empty">No models found</div>
        ) : (
          groupModelsByProvider(filteredModels).map(([providerName, providerModels]) => (
            <ProviderSection
              key={providerName}
              providerName={providerName}
              models={providerModels}
              collapsed={collapsedProviders[providerName] === true}
              searching={searching}
              isModelActive={isModelActive}
              onSelect={handleSelect}
              onToggle={toggleProviderCollapsed}
            />
          ))
        )}
      </div>
    </div>,
    document.body
  );
}
