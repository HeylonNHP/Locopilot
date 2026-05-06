'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { useChat } from '@/app/lib/chatStore';

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

  // Position the dropdown above the anchor when opened
  useEffect(() => {
    if (isOpen && anchorRef.current) {
      const rect = anchorRef.current.getBoundingClientRect();
      const dropdownWidth = 320;
      let left = rect.left;
      // Keep dropdown within viewport
      if (left + dropdownWidth > window.innerWidth - 16) {
        left = Math.max(16, window.innerWidth - dropdownWidth - 16);
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

  const handleSelect = useCallback(
    async (modelName: string) => {
      if (modelName === state.model) {
        onClose();
        return;
      }

      dispatch({ type: 'SET_CONFIG', config: { model: modelName } });

      try {
        const config = {
          baseUrl: state.baseUrl,
          numCtx: state.numCtx,
          model: modelName,
          yolo: state.yolo,
          thinkingEnabled: state.thinkingEnabled,
          compactionModel: state.compactionModel,
          chatTimeoutMs: state.chatTimeoutMs,
          webSearch: state.webSearch,
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
    [dispatch, onClose, state],
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
          filteredModels.map((m) => (
            <button
              key={m.name}
              className={`model-selector-item ${m.name === state.model ? 'model-selector-item-active' : ''}`}
              onClick={() => handleSelect(m.name)}
              title={m.name}
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
              <span className="model-selector-name">{m.name}</span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
