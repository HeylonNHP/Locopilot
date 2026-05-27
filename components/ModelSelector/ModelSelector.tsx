'use client';
import './ModelSelector.scss';

import { useState, useRef, useEffect, useCallback } from 'react';
import { useChat } from '@/app/lib/chatStore';

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
    if (key === 'tools') {
      normalized.add('tools');
    } else if (key === 'vision' || key === 'multimodal' || key === 'image') {
      normalized.add('vision');
    } else if (key === 'thinking') {
      normalized.add('thinking');
    } else if (key === 'audio') {
      normalized.add('audio');
    }
  }

  const capabilityOrder = ['tools', 'vision', 'thinking', 'audio'] as const;

  return capabilityOrder
    .filter((capability) => normalized.has(capability))
    .map((capability) => CAPABILITY_LABELS[capability]!);
}

interface ModelSelectorProps {
  anchorRef: React.RefObject<HTMLElement | null>;
  isOpen: boolean;
  onClose: () => void;
}

export default function ModelSelector({ anchorRef, isOpen, onClose }: ModelSelectorProps) {
  const { state, dispatch } = useChat();
  const [search, setSearch] = useState('');
  const [position, setPosition] = useState({ left: 0, bottom: 0 });
  const panelRef = useRef<HTMLDivElement>(null);

  const filteredModels = state.models.filter((m) =>
    m.name.toLowerCase().includes(search.toLowerCase()),
  );

  // Position the dropdown above the anchor when opened, centred horizontally
  useEffect(() => {
    if (isOpen && anchorRef.current) {
      const rect = anchorRef.current.getBoundingClientRect();
      const dropdownWidth = 320;
      // Centre the popup over the anchor button
      let left = rect.left + rect.width / 2 - dropdownWidth / 2;
      // Keep dropdown within viewport
      if (left < 16) {
        left = 16;
      } else if (left + dropdownWidth > window.innerWidth - 16) {
        left = window.innerWidth - dropdownWidth - 16;
      }
      setPosition({
        left,
        bottom: window.innerHeight - rect.top + 8,
      });
    }
  }, [isOpen, anchorRef]);

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

  // Destructure only the fields used by handleSelect so the callback
  // does not depend on the entire state object (which changes on every
  // render during streaming, defeating useCallback).
  const {
    model,
    baseUrl,
    yolo,
    thinkingEnabled,
    compactionModel,
    chatTimeoutMs,
    webSearch,
  } = state;

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
    [dispatch, onClose, model, baseUrl, yolo, thinkingEnabled, compactionModel, chatTimeoutMs, webSearch],
  );

  if (!isOpen) return null;

  return (
    <div
      ref={panelRef}
      className="model-selector"
      style={{
        position: 'fixed',
        left: position.left,
        bottom: position.bottom,
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
                className={`model-selector-item ${m.name === state.model ? 'model-selector-item-active' : ''}`}
                onClick={() => handleSelect(m.name)}
                title={capabilityBadges.length > 0 ? `${m.name} (${capabilityBadges.join(', ')})` : m.name}
              >
                <span className="model-selector-check">
                  {m.name === state.model && (
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
                    <span className="model-selector-badges" aria-label={`Capabilities: ${capabilityBadges.join(', ')}`}>
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
    </div>
  );
}
