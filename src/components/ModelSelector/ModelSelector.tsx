'use client';
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { useClickOutsideEscape } from '@/app/hooks/useClickOutsideEscape';
import { useChat } from '@/app/lib/chatStore';

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

export default function ModelSelector({
  anchorRef,
  lastClickRef,
  isOpen,
  onClose,
  mode = 'model',
}: ModelSelectorProps) {
  const { state, dispatch } = useChat();

  // Destructure only the fields used by this component so callbacks do not
  // depend on the entire state object (which changes on every render during
  // streaming, defeating useCallback).
  const {
    models,
    model,
    activeProviderId,
    baseUrl,
    yolo,
    thinkingEnabled,
    compactionModel,
    compactionProviderId,
    chatTimeoutMs,
    webSearch,
  } = state;

  const activeModel = mode === 'compaction' ? compactionModel : model;

  const [search, setSearch] = useState('');
  const [position, setPosition] = useState({ left: 0, bottom: 0, maxHeight: 420 });
  const panelRef = useRef<HTMLDivElement>(null);

  const filteredModels = models.filter((m) => m.name.toLowerCase().includes(search.toLowerCase()));

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
              baseUrl,
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
          baseUrl,
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

      onClose();
    },
    [
      dispatch,
      onClose,
      activeModel,
      activeProviderId,
      mode,
      baseUrl,
      model,
      yolo,
      thinkingEnabled,
      compactionModel,
      chatTimeoutMs,
      webSearch,
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
          (() => {
            const byProvider: Record<string, typeof filteredModels> = {};
            for (const m of filteredModels) {
              const group = byProvider[m.providerName] ?? [];
              group.push(m);
              byProvider[m.providerName] = group;
            }
            return Object.entries(byProvider).flatMap(([providerName, providerModels]) => [
              <div key={`__header__${providerName}`} className="model-selector-provider-header">
                {providerName}
              </div>,
              ...providerModels.map((m) => {
                const capabilityBadges = getCapabilityBadges(m.capabilities);
                // For compaction mode, match on the compaction-specific
                // provider id (transient) instead of the active chat
                // provider id.
                const isActive =
                  mode === 'compaction'
                    ? m.name === activeModel && m.providerId === compactionProviderId
                    : m.name === activeModel && m.providerId === activeProviderId;

                return (
                  <button
                    key={`${m.providerId}::${m.name}`}
                    className={`model-selector-item ${isActive ? 'model-selector-item-active' : ''}`}
                    onClick={() => handleSelect(m.name, m.providerId)}
                    title={
                      capabilityBadges.length > 0
                        ? `${m.name} (${capabilityBadges.join(', ')})`
                        : m.name
                    }
                  >
                <span className="model-selector-check">
                  {isActive && (
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
                  <span className="model-selector-name">{m.name}</span>
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
              }),
            ]);
          })()
        )}
      </div>
    </div>,
    document.body
  );
}
