'use client';

import { useMemo } from 'react';
import { useChat } from '@/app/lib/chatStore';
import { estimateMessagesTokens } from '@/app/lib/tokenEstimator';

export default function StatusBar() {
  const { state } = useChat();
  const { tokenStats, isStreaming, model, messages } = state;

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

  return (
    <div className="statusbar">
      {isStreaming && (
        <span className="statusbar-streaming">● Streaming</span>
      )}
      <span className={tokenColorClass}>
        {totalTokens}/{tokenLimit} tokens ({pct}%) {sourceLabel}
      </span>
      {model && <span>Model: {model}</span>}
      <span>{messages.length} messages</span>
    </div>
  );
}
