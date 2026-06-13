'use client';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

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
    // No default
    }
  }

  const capabilityOrder = ['tools', 'vision', 'thinking', 'audio'] as const;

  return capabilityOrder
    .filter((capability) => normalized.has(capability))
    .map((capability) => CAPABILITY_LABELS[capability]!);
}

interface ModelSelectorProps {
  anchorRef: React.RefObject<HTMLElement | null>;
  lastClickRef: React.MutableRefObject<{ x: number; y: number } | null>;
  isOpen: boolean;
  onClose: () => void;
}

export default function ModelSelector({
  anchorRef,
  lastClickRef,
  isOpen,
  onClose,
}: ModelSelectorProps) {
  const { state, dispatch } = useChat();

  // Destructure only the fields used by this component so callbacks do not
  // depend on the entire state object (which changes on every render during
  // streaming, defeating useCallback).
  const { models, model, baseUrl, yolo, thinkingEnabled, compactionModel, chatTimeoutMs, webSearch } =
    state;

  const [search, setSearch] = useState('');
  const [position, setPosition] = useState({ left: 0, bottom: 0, maxHeight: 420 });
  const panelRef = useRef<HTMLDivElement>(null);

  const filteredModels = models.filter((m) =>
    m.name.toLowerCase().includes(search.toLowerCase())
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
  useEffect(() => {
    if (!isOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [isOpen, onClose]);

  const handleSelect = useCallback(
    async (modelName: string) => {
      if (modelName === model) {
        onClose();
        return;
      }

      dispatch({ type: 'SET_CONFIG', config: { model: modelName } });

      try {
        // Only persist the model change; do NOT send numCtx so the user's
        // configured maximum context size is preserved in config.json.
        // The effective (clamped) limit is applied in-memory via
        // SET_MODEL_CONTEXT_LIMIT after fetching the model's info.
        const config = {
          baseUrl,
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

        const res = await fetch(`/api/models/${encodeURIComponent(modelName)}/info`);
        if (res.ok) {
          const data = await res.json();
          dispatch({ type: 'SET_MODEL_CONTEXT_LIMIT', limit: data.contextLimit ?? null });
        }
      } catch {
        // Silently ignore
      }

      onClose();
    },
    [
      dispatch,
      onClose,
      model,
      baseUrl,
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
        {filteredModels.length === 0 ? (
          <div className="model-selector-empty">No models found</div>
        ) : (
          filteredModels.map((m) => {
            const capabilityBadges = getCapabilityBadges(m.capabilities);

            return (
              <button
                key={m.name}
                className={`model-selector-item ${m.name === model ? 'model-selector-item-active' : ''}`}
                onClick={() => handleSelect(m.name)}
                title={
                  capabilityBadges.length > 0
                    ? `${m.name} (${capabilityBadges.join(', ')})`
                    : m.name
                }
              >
                <span className="model-selector-check">
                  {m.name === model && (
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
          })
        )}
      </div>
    </div>,
    document.body
  );
}
