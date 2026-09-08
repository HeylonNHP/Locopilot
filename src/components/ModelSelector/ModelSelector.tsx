'use client';
import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { useClickOutsideEscape } from '@/app/hooks/useClickOutsideEscape';
import { type LLmModel, useChat } from '@/app/lib/chatStore';
import { type MidTurnModelSwitch, requestMidTurnModelSwitch } from '@/app/lib/switchModelClient';

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
    yolo,
    thinkingEnabled,
    compactionModel,
    compactionProviderId,
    chatTimeoutMs,
    webSearch,
    currentSessionId,
    streamingSessions,
  } = state;

  const activeModel = mode === 'compaction' ? compactionModel : model;

  // The session whose turn can still take a model switch on board, or null
  // when nothing is streaming and the config update alone is enough.
  const streamingSessionId =
    currentSessionId !== null && streamingSessions.has(currentSessionId) ? currentSessionId : null;

  const switchMidTurn = useCallback(
    async (payload: MidTurnModelSwitch) => {
      if (streamingSessionId === null) return;
      dispatch({ type: 'SET_CONFIG', config: { modelSwitchPending: true } });
      // Attach the mid-turn fetch to the signal of the turn it is switching
      // — looked up per session from the shared abort map, i.e. the SAME
      // controller the Stop button aborts. If the user clicks Stop while the
      // request is in flight, the fetch is aborted client-side and the
      // server-side `pendingSwitches[sessionId]` is cleared by the route's
      // `unregisterActiveTurn` rather than being silently dropped after the
      // turn's finally runs.
      const accepted = await requestMidTurnModelSwitch(
        streamingSessionId,
        payload,
        abortControllersRef.current.get(streamingSessionId)?.signal
      );
      if (!accepted) {
        dispatch({ type: 'SET_CONFIG', config: { modelSwitchPending: false } });
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
    (m: LLmModel) =>
      mode === 'compaction'
        ? m.name === activeModel && m.providerId === compactionProviderId
        : m.name === activeModel && m.providerId === activeProviderId,
    [mode, activeModel, compactionProviderId, activeProviderId]
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

  const handleSelect = useCallback(
    async (modelName: string, providerId?: string) => {
      if (modelName === activeModel && (!providerId || providerId === activeProviderId)) {
        onClose();
        return;
      }

      if (mode === 'compaction') {
        // `compactionProviderId` is transient (in-memory + request bodies,
        // not persisted to config.json). It captures the picked model's
        // provider so the server's compaction route can resolve the
        // compaction provider precisely, even when the compaction model
        // belongs to a different provider than the active chat model.
        // "Same as main model" passes '' + null together.
        const nextCompactionProviderId = providerId ?? null;
        dispatch({
          type: 'SET_CONFIG',
          config: {
            compactionModel: modelName,
            compactionProviderId: nextCompactionProviderId,
          },
        });

        try {
          await fetch('/api/config', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model,
              yolo,
              thinkingEnabled,
              compactionModel: modelName,
              chatTimeoutMs,
              webSearch,
            }),
          });
        } catch {
          // Silently ignore
        }

        await switchMidTurn({
          compactionModel: modelName,
          ...(providerId ? { compactionProviderId: providerId } : {}),
        });

        onClose();
        return;
      }

      const selectedProviderId = providerId ?? null;
      dispatch({ type: 'SET_ACTIVE_PROVIDER', providerId: selectedProviderId });
      dispatch({ type: 'SET_CONFIG', config: { model: modelName } });

      try {
        // Only persist the model/provider change; do NOT send numCtx so the user's
        // configured maximum context size is preserved in config.json.
        // The effective (clamped) limit is now applied by the server
        // via the cap resolver and reported back on the next chat
        // turn's `status` event. The client no longer pre-fetches the
        // cap; the server is authoritative.
        const config = {
          activeProviderId: selectedProviderId,
          model: modelName,
          yolo,
          thinkingEnabled,
          compactionModel,
          chatTimeoutMs,
          webSearch,
        };
        await fetch('/api/config', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(config),
        });
      } catch {
        // Silently ignore
      }

      await switchMidTurn({
        model: modelName,
        ...(selectedProviderId ? { providerId: selectedProviderId } : {}),
      });

      onClose();
    },
    [
      dispatch,
      onClose,
      activeModel,
      activeProviderId,
      mode,
      model,
      yolo,
      thinkingEnabled,
      compactionModel,
      chatTimeoutMs,
      webSearch,
      switchMidTurn,
    ]
  );

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
            onClick={() => handleSelect('')}
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
