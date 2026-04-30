'use client';

import { useChat } from '@/app/lib/chatStore';

export default function StatusBar() {
  const { state } = useChat();
  
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
      {state.isStreaming && (
        <span style={{ color: 'var(--accent)' }}>● Streaming</span>
      )}
      {state.model && <span>Model: {state.model}</span>}
      <span>{state.messages.length} messages</span>
    </div>
  );
}
