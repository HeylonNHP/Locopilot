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
    <div className="sidebar">
      <div className="sidebar-header">
        <h2 className="sidebar-title">Locopilot</h2>
        <div className="flex gap-8">
          <button
            onClick={onNewSession}
            className="sidebar-btn-new"
          >
            + New chat
          </button>
          <button
            onClick={onSettings}
            title="Settings"
            className="sidebar-btn-settings"
          >
            ⚙
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-8">
        {state.sessions.length === 0 ? (
          <p className="sidebar-empty">
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
                  className="session-row__action flex-1 min-w-0 px-12 py-10 text-primary cursor-pointer font-13 text-left"
                >
                  <span className="block text-overflow-ellipsis">
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
                  className="session-row__action text-secondary cursor-pointer font-14 py-10 px-12 flex-shrink-0 opacity-50"
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
        className="sidebar-footer"
        title="Click to open settings"
      >
        {state.model && <div>Model: {state.model}</div>}
        {!state.model && <div>No model selected</div>}
      </div>
    </div>
  );
}
