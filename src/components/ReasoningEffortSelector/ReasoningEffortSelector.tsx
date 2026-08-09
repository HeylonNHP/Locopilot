'use client';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import type { ProviderConfig, ReasoningEffort } from '@/types/chatConfig';

import { useClickOutsideEscape } from '@/app/hooks/useClickOutsideEscape';
import { useChat } from '@/app/lib/chatStore';

import './ReasoningEffortSelector.scss';

interface ReasoningEffortSelectorProps {
  anchorRef: React.RefObject<HTMLElement | null>;
  lastClickRef: React.RefObject<{ x: number; y: number } | null>;
  isOpen: boolean;
  onClose: () => void;
}

const LEVELS: ReadonlyArray<{ value: ReasoningEffort; label: string }> = [
  { value: 'off', label: 'Off' },
  { value: 'none', label: 'None' },
  { value: 'minimal', label: 'Minimal' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'XHigh' },
  { value: 'max', label: 'Max' },
];

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
    yolo,
    thinkingEnabled,
    compactionModel,
    compactionProviderId,
    chatTimeoutMs,
    webSearch,
    reasoningEffort,
    compactionReasoningEffort,
    providers,
    activeProviderId,
    models,
  } = state;

  // Resolve the active provider for the main model from `providers[]` +
  // `activeProviderId` (the legacy top-level `state.provider` field is stale
  // in multi-provider configs — see SettingsModal). The compaction model may
  // live on a different provider via `compactionProviderId`; fall back to the
  // main provider when unset ("Same as main model").
  const mainProvider = providers?.find((p) => p.id === activeProviderId) ?? providers?.[0];
  const compactionProvider =
    (compactionProviderId && providers?.find((p) => p.id === compactionProviderId)) || mainProvider;

  const mainLevels = levelsForProvider(mainProvider?.provider);
  const compactionLevels = levelsForProvider(compactionProvider?.provider);

  const mainSupported = isReasoningSupported(mainProvider, model, models);
  const effectiveCompactionModel = compactionModel || model;
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

  const persist = useCallback(
    async (config: Record<string, unknown>) => {
      dispatch({ type: 'SET_CONFIG', config });

      try {
        await fetch('/api/config', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
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
    },
    [dispatch, model, yolo, thinkingEnabled, compactionModel, chatTimeoutMs, webSearch]
  );

  const handleChangeMain = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      void persist({ reasoningEffort: e.target.value as ReasoningEffort });
    },
    [persist]
  );

  const handleChangeCompaction = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      void persist({ compactionReasoningEffort: e.target.value as ReasoningEffort });
    },
    [persist]
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
              value={reasoningEffort}
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
              value={compactionReasoningEffort}
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
