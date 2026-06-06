'use client';
import './CompletionModeSelector.scss';

import { useState, useRef, useEffect, useCallback } from 'react';
import { useChat } from '@/app/lib/chatStore';

interface CompletionModeSelectorProps {
  anchorRef: React.RefObject<HTMLElement | null>;
  isOpen: boolean;
  onClose: () => void;
}

const MODES = [
  { value: 'normal', label: 'Normal', description: 'Turn ends after the LLM\'s first response.' },
  { value: 'prompt-loop', label: 'Prompt loop', description: 'Auto-continues until the task is fully done.' },
] as const;

export default function CompletionModeSelector({
  anchorRef,
  isOpen,
  onClose,
}: CompletionModeSelectorProps) {
  const { state, dispatch } = useChat();
  const [position, setPosition] = useState({ left: 0, bottom: 0 });
  const [iterationsInput, setIterationsInput] = useState('');
  const panelRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const completionMode = (state.completionMode || 'normal') as string;
  const maxIterations = state.maxPromptLoopIterations ?? 4;

  // Position the dropdown above the anchor
  useEffect(() => {
    if (isOpen && anchorRef.current) {
      const rect = anchorRef.current.getBoundingClientRect();
      const dropdownWidth = 320;
      let left = rect.left + rect.width / 2 - dropdownWidth / 2;
      if (left < 16) left = 16;
      else if (left + dropdownWidth > window.innerWidth - 16)
        left = window.innerWidth - dropdownWidth - 16;
      setPosition({ left, bottom: window.innerHeight - rect.top + 8 });
    }
  }, [isOpen, anchorRef]);

  // Reset iterations input when opened
  useEffect(() => {
    if (isOpen) {
      setIterationsInput(maxIterations === 0 ? '' : String(maxIterations));
    }
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

  const {
    baseUrl,
    model,
    yolo,
    thinkingEnabled,
    compactionModel,
    chatTimeoutMs,
    webSearch,
  } = state;

  const persist = useCallback(
    (config: Record<string, unknown>) => {
      dispatch({ type: 'SET_CONFIG', config });

      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(async () => {
        try {
          await fetch('/api/config', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              baseUrl,
              model,
              yolo,
              thinkingEnabled,
              compactionModel,
              chatTimeoutMs,
              webSearch,
              ...config,
            }),
          });
        } catch { /* ignore */ }
      }, 300);
    },
    [dispatch, baseUrl, model, yolo, thinkingEnabled, compactionModel, chatTimeoutMs, webSearch],
  );

  const handleSelectMode = useCallback(
    (mode: string) => {
      if (mode === completionMode) {
        onClose();
        return;
      }
      persist({ completionMode: mode });
      onClose();
    },
    [completionMode, persist, onClose],
  );

  const handleIterationsChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const raw = e.target.value;
      setIterationsInput(raw);

      const num = parseInt(raw, 10);
      if (raw === '' || (isNaN(num) && raw !== '')) return;
      const value = (raw === '' || num === 0) ? 0 : Math.max(0, num);
      persist({ maxPromptLoopIterations: value });
    },
    [persist],
  );

  if (!isOpen) return null;

  return (
    <div
      ref={panelRef}
      className="completion-mode-selector"
      style={{
        position: 'fixed',
        left: position.left,
        bottom: position.bottom,
      }}
    >
      <div className="completion-mode-selector-header">
        Completion mode
      </div>
      <div className="completion-mode-selector-list">
        {MODES.map((m) => (
          <button
            key={m.value}
            className={`completion-mode-selector-item ${m.value === completionMode ? 'completion-mode-selector-item-active' : ''}`}
            onClick={() => handleSelectMode(m.value)}
          >
            <span className="completion-mode-selector-check">
              {m.value === completionMode && (
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
            <span className="completion-mode-selector-content">
              <span className="completion-mode-selector-name">{m.label}</span>
              <span className="completion-mode-selector-desc">{m.description}</span>
            </span>
          </button>
        ))}
      </div>
      {completionMode === 'prompt-loop' && (
        <div className="completion-mode-selector-settings">
          <label className="completion-mode-selector-setting-label">
            Max iterations:
            <input
              type="number"
              className="completion-mode-selector-setting-input"
              min="0"
              placeholder="0 = unlimited"
              value={iterationsInput}
              onChange={handleIterationsChange}
            />
          </label>
          <span className="completion-mode-selector-setting-hint">
            0 = unlimited
          </span>
        </div>
      )}
    </div>
  );
}
