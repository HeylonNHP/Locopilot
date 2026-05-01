'use client';

import { useChat } from '@/app/lib/chatStore';

export default function StatusBar() {
  const { state } = useChat();

  const { tokenStats, isStreaming, model, messages } = state;

  let tokenText = null;
  if (tokenStats) {
    const pct = tokenStats.tokenLimit > 0
      ? Math.round((tokenStats.totalTokens / tokenStats.tokenLimit) * 100)
      : 0;
    let color = '#4ade80'; // green
    if (pct >= 90) color = '#f87171'; // red
    else if (pct >= 75) color = '#facc15'; // yellow

    tokenText = (
      <span style={{ color }}>
        {tokenStats.totalTokens}/{tokenStats.tokenLimit} tokens ({pct}%)
      </span>
    );
  }

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
      {tokenText}
      {model && <span>Model: {model}</span>}
      <span>{messages.length} messages</span>
    </div>
  );
}
