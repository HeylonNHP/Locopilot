'use client';

import { useChat, type Session } from '@/app/lib/chatStore';
import type { KeyboardEvent } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

interface Props {
  onNewSession: () => void;
  onSelectSession: (id: number) => void;
  onDeleteSession: (id: number) => void;
  onSettings: () => void;
}

export default function SessionSidebar({ onNewSession, onSelectSession, onDeleteSession, onSettings }: Props) {
  const { state } = useChat();

  const handleActionKeyDown = (
    event: KeyboardEvent<HTMLDivElement>,
    action: () => void,
  ) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      action();
    }
  };

  const clearPointerFocus = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.blur();
  };
  
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
          state.sessions.map((session) => {
            const isSelected = state.currentSessionId === session.id;

            return (
              <div
                key={session.id}
                className="session-row"
                data-selected={isSelected ? 'true' : undefined}
              >
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => onSelectSession(session.id)}
                  onKeyDown={(event) => handleActionKeyDown(event, () => onSelectSession(session.id))}
                  onPointerUp={clearPointerFocus}
                  title={session.name || `Session ${session.id}`}
                  className="session-row__action"
                  style={{
                    flex: 1,
                    minWidth: 0,
                    padding: '10px 12px',
                    color: 'var(--text-primary)',
                    cursor: 'pointer',
                    fontSize: '13px',
                    textAlign: 'left',
                  }}
                >
                  <span style={{
                    display: 'block',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}>
                    {session.name || `Session ${session.id}`}
                  </span>
                </div>
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => onDeleteSession(session.id)}
                  onKeyDown={(event) => handleActionKeyDown(event, () => onDeleteSession(session.id))}
                  onPointerUp={clearPointerFocus}
                  title="Delete session"
                  className="session-row__action"
                  style={{
                    color: 'var(--text-secondary)',
                    cursor: 'pointer',
                    fontSize: '14px',
                    padding: '10px 12px 10px 4px',
                    opacity: 0.5,
                    flexShrink: 0,
                  }}
                >
                  ×
                </div>
              </div>
            );
          })
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
