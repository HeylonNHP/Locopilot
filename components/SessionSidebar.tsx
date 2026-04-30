'use client';

import { useChat, type Session } from '@/app/lib/chatStore';

interface Props {
  onNewSession: () => void;
  onSelectSession: (id: number) => void;
  onDeleteSession: (id: number) => void;
  onSettings: () => void;
}

export default function SessionSidebar({ onNewSession, onSelectSession, onDeleteSession, onSettings }: Props) {
  const { state } = useChat();
  
  return (
    <div style={{
      width: '260px',
      background: 'var(--bg-secondary)',
      borderRight: '1px solid #333',
      display: 'flex',
      flexDirection: 'column',
      height: '100vh',
    }}>
      <div style={{ padding: '16px', borderBottom: '1px solid #333' }}>
        <h2 style={{ fontSize: '18px', margin: '0 0 12px 0' }}>Locopilot</h2>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button
            onClick={onNewSession}
            style={{
              flex: 1,
              padding: '8px 12px',
              borderRadius: '8px',
              border: '1px dashed #555',
              background: 'transparent',
              color: 'var(--text-secondary)',
              cursor: 'pointer',
              fontSize: '13px',
            }}
          >
            + New chat
          </button>
          <button
            onClick={onSettings}
            title="Settings"
            style={{
              padding: '8px 12px',
              borderRadius: '8px',
              border: '1px solid #555',
              background: 'transparent',
              color: 'var(--text-secondary)',
              cursor: 'pointer',
              fontSize: '13px',
            }}
          >
            ⚙
          </button>
        </div>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '8px' }}>
        {state.sessions.length === 0 ? (
          <p style={{ color: 'var(--text-secondary)', fontSize: '13px', padding: '8px', textAlign: 'center' }}>
            No sessions yet
          </p>
        ) : (
          state.sessions.map((session) => (
            <div
              key={session.id}
              onClick={() => onSelectSession(session.id)}
              style={{
                padding: '10px 12px',
                borderRadius: '8px',
                cursor: 'pointer',
                marginBottom: '4px',
                background: state.currentSessionId === session.id ? 'var(--bg-tertiary)' : 'transparent',
                fontSize: '13px',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <span style={{
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                flex: 1,
              }}>
                {session.name || `Session ${session.id}`}
              </span>
              <button
                onClick={(e) => { e.stopPropagation(); onDeleteSession(session.id); }}
                title="Delete session"
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--text-secondary)',
                  cursor: 'pointer',
                  fontSize: '14px',
                  padding: '2px 4px',
                  opacity: 0.5,
                }}
              >
                ×
              </button>
            </div>
          ))
        )}
      </div>
      <div
        onClick={onSettings}
        style={{
          padding: '12px 16px',
          borderTop: '1px solid #333',
          fontSize: '12px',
          color: 'var(--text-secondary)',
          cursor: 'pointer',
        }}
        title="Click to open settings"
      >
        {state.model && <div>Model: {state.model}</div>}
        {!state.model && <div>No model selected</div>}
      </div>
    </div>
  );
}
