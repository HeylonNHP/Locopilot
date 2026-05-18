'use client';

import { useState, useRef, useCallback } from 'react';
import { useChat } from '@/app/lib/chatStore';
import ModelSelector from './ModelSelector';

export default function StatusBar() {
  const { state } = useChat();
  const { tokenStats, model, messages } = state;
  const [showSelector, setShowSelector] = useState(false);
  const modelRef = useRef<HTMLSpanElement>(null);

  const handleOpenSelector = useCallback(() => {
    if (state.models.length > 0 && model) {
      setShowSelector(true);
    }
  }, [state.models.length, model]);

  const handleCloseSelector = useCallback(() => {
    setShowSelector(false);
  }, []);

  // Use the backend-provided token count. If we haven't received one yet
  // (briefly before the first SSE event) show 0 instead of a local guess.
  const totalTokens = tokenStats?.totalTokens ?? 0;
  const tokenLimit = state.numCtx;

  const pct = tokenLimit > 0 ? Math.round((totalTokens / tokenLimit) * 100) : 0;

  let tokenColorClass = 'statusbar-token-green';
  if (pct >= 90) tokenColorClass = 'statusbar-token-red';
  else if (pct >= 75) tokenColorClass = 'statusbar-token-yellow';

  // Mark whether we're showing an estimate or authoritative count.
  // Backend-driven estimates carry isEstimated=true; absent stats mean
  // we haven't heard from the backend yet (briefly before first SSE event).
  const isEstimated = tokenStats?.isEstimated ?? (tokenStats === null);
  const sourceLabel = isEstimated ? '(est)' : '';

  // Tokens-per-second display: live rough estimate during streaming,
  // accurate Ollama-calculated value after the turn finishes.
  const tpsValue = state.currentTps ?? tokenStats?.evalTps ?? tokenStats?.promptTps;
  const tpsLabel = tpsValue != null ? `${tpsValue} t/s` : null;

  return (
    <div className="statusbar">
      {state.currentSessionId !== null && state.streamingSessions.has(state.currentSessionId) && (
        <span className="statusbar-streaming">● Streaming</span>
      )}
      <span className={tokenColorClass}>
        {totalTokens}/{tokenLimit} tokens ({pct}%) {sourceLabel}
      </span>
      {tpsLabel && <span>{tpsLabel}</span>}
      <span ref={modelRef}>
        {model && (
          <span
            className="statusbar-model"
            onClick={handleOpenSelector}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                handleOpenSelector();
              }
            }}
          >
            Model: {model}
          </span>
        )}
      </span>
      <span>{messages.length} messages</span>

      <ModelSelector
        anchorRef={modelRef}
        isOpen={showSelector}
        onClose={handleCloseSelector}
      />
    </div>
  );
}
