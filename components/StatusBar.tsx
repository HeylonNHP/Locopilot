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

  // Use authoritative stats when available, otherwise fall back to estimate
  const totalTokens = tokenStats?.totalTokens ?? estimatedTokens;
  const tokenLimit = tokenStats?.tokenLimit ?? state.numCtx;

  const pct = tokenLimit > 0 ? Math.round((totalTokens / tokenLimit) * 100) : 0;

  let color = '#4ade80'; // green
  if (pct >= 90) color = '#f87171'; // red
  else if (pct >= 75) color = '#facc15'; // yellow

  // Mark whether we're showing an estimate or authoritative count
  const isEstimated = tokenStats === null;
  const sourceLabel = isEstimated ? '(est)' : '';

  return (
    <div style={{
      padding: '6px 16px',
      borderTop: '1px solid #333',
      background: 'var(--bg-secondary)',
      fontSize: '12px',
      color: 'var(--text-secondary)',
      display: 'flex',
      gap: '16px',
      alignItems: 'center',
    }}>
      {isStreaming && (
        <span style={{ color: 'var(--accent)' }}>● Streaming</span>
      )}
      <span style={{ color }}>
        {totalTokens}/{tokenLimit} tokens ({pct}%) {sourceLabel}
      </span>
      {model && <span>Model: {model}</span>}
      <span>{messages.length} messages</span>
    </div>
  );
}
