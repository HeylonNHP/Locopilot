'use client';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { useChat } from '@/app/lib/chatStore';

import './CompletionModeSelector.scss';

interface CompletionModeSelectorProps {
  anchorRef: React.RefObject<HTMLElement | null>;
  lastClickRef: React.MutableRefObject<{ x: number; y: number } | null>;
  isOpen: boolean;
  onClose: () => void;
}

const MODES = [
  { value: 'normal', label: 'Normal', description: "Turn ends after the LLM's first response." },
  {
    value: 'prompt-loop',
    label: 'Prompt loop',
    description: 'Auto-continues until the task is fully done.',
  },
] as const;

export default function CompletionModeSelector({
  anchorRef,
  lastClickRef,
  isOpen,
  onClose,
}: CompletionModeSelectorProps) {
  const { state, dispatch } = useChat();
  const [position, setPosition] = useState({ left: 0, bottom: 0, maxHeight: 420 });
  const [iterationsInput, setIterationsInput] = useState('');
  const panelRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const completionMode = (state.completionMode || 'normal') as string;
  const maxIterations = state.maxPromptLoopIterations ?? 4;

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

  const { baseUrl, model, yolo, thinkingEnabled, compactionModel, chatTimeoutMs, webSearch } =
    state;

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
        } catch {
          /* ignore */
        }
      }, 300);
    },
    [dispatch, baseUrl, model, yolo, thinkingEnabled, compactionModel, chatTimeoutMs, webSearch]
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
    [completionMode, persist, onClose]
  );

  const handleIterationsChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const raw = e.target.value;
      setIterationsInput(raw);

      const num = Number.parseInt(raw, 10);
      if (raw === '' || (Number.isNaN(num) && raw !== '')) return;
      const value = raw === '' || num === 0 ? 0 : Math.max(0, num);
      persist({ maxPromptLoopIterations: value });
    },
    [persist]
  );

  if (!isOpen) return null;

  return createPortal(
    <div
      ref={panelRef}
      className="completion-mode-selector"
      style={{
        position: 'fixed',
        left: position.left,
        bottom: position.bottom,
        maxHeight: position.maxHeight,
      }}
    >
      <div className="completion-mode-selector-header">Completion mode</div>
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
          <span className="completion-mode-selector-setting-hint">0 = unlimited</span>
        </div>
      )}
    </div>,
    document.body
  );
}
