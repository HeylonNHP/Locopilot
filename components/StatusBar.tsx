'use client';

import { useMemo, useState, useRef, useCallback } from 'react';
import { useChat } from '@/app/lib/chatStore';
import { estimateMessagesTokens } from '@/app/lib/tokenEstimator';
import ModelSelector from './ModelSelector';

export default function StatusBar() {
  const { state } = useChat();
  const { tokenStats, isStreaming, model, messages } = state;
  const [showSelector, setShowSelector] = useState(false);
  const modelRef = useRef<HTMLSpanElement>(null);

  const handleOpenSelector = useCallback(() => {
    if (state.models.length > 0) {
      setShowSelector(true);
    }
  }, [state.models.length]);

  const handleCloseSelector = useCallback(() => {
    setShowSelector(false);
  }, []);

  // Compute a client-side estimate so we ALWAYS show something.
  // When authoritative SSE stats arrive they override this.
  const estimatedTokens = useMemo(() => estimateMessagesTokens(messages), [messages]);

  // Always use state.numCtx as the token limit — it's the user's current
  // setting and what the backend actually uses. tokenStats may contain a
  // stale tokenLimit from a previous turn.
  const totalTokens = tokenStats?.totalTokens ?? estimatedTokens;
  const tokenLimit = state.numCtx;

  const pct = tokenLimit > 0 ? Math.round((totalTokens / tokenLimit) * 100) : 0;

  let tokenColorClass = 'statusbar-token-green';
  if (pct >= 90) tokenColorClass = 'statusbar-token-red';
  else if (pct >= 75) tokenColorClass = 'statusbar-token-yellow';

  // Mark whether we're showing an estimate or authoritative count
  const isEstimated = tokenStats === null;
  const sourceLabel = isEstimated ? '(est)' : '';

  // Tokens-per-second display: live rough estimate during streaming,
  // accurate Ollama-calculated value after the turn finishes.
  const tpsValue = state.currentTps ?? tokenStats?.evalTps ?? tokenStats?.promptTps;
  const tpsLabel = tpsValue != null ? `${tpsValue} t/s` : null;

  return (
    <div className="statusbar">
      {isStreaming && (
        <span className="statusbar-streaming">● Streaming</span>
      )}
      <span className={tokenColorClass}>
        {totalTokens}/{tokenLimit} tokens ({pct}%) {sourceLabel}
      </span>
      {tpsLabel && <span>{tpsLabel}</span>}
      {model && (
        <span
          ref={modelRef}
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
      <span>{messages.length} messages</span>

      <ModelSelector
        anchorRef={modelRef}
        isOpen={showSelector}
        onClose={handleCloseSelector}
      />
    </div>
  );
}
