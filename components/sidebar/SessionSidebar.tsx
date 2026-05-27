'use client';
import './SessionSidebar.scss';

import { useChat } from '@/app/lib/chatStore';
import { useState, useEffect, useRef, type KeyboardEvent } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

interface Props {
  onNewSession: () => void;
  onSelectSession: (id: number) => void;
  onDeleteSession: (id: number) => void;
  onSettings: () => void;
  onSearchSessions: (query: string) => void;
}

export default function SessionSidebar({
  onNewSession,
  onSelectSession,
  onDeleteSession,
  onSettings,
  onSearchSessions,
}: Props) {
  const { state } = useChat();
  const [searchQuery, setSearchQuery] = useState('');
  const isFirstRender = useRef(true);

  // Debounced search: skip first render (page.tsx already loads on mount)
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    const timer = setTimeout(() => {
      onSearchSessions(searchQuery);
    }, 200);
    return () => clearTimeout(timer);
  }, [searchQuery, onSearchSessions]);

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

  const isSearching = searchQuery.trim().length > 0;

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

      <div className="sidebar-search-wrap">
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search sessions…"
          className="sidebar-search"
          aria-label="Search sessions"
        />
        {isSearching && (
          <button
            type="button"
            onClick={() => setSearchQuery('')}
            className="sidebar-search-clear"
            aria-label="Clear search"
            title="Clear search"
          >
            ×
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-8">
        {state.sessions.length === 0 ? (
          <p className="sidebar-empty">
            {isSearching ? 'No sessions match your search' : 'No sessions yet'}
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
                  <div className="flex items-center w-full">
                    <span className="block text-overflow-ellipsis flex-1 min-w-0">
                      {session.name || `Session ${session.id}`}
                    </span>
                    {state.streamingSessions.has(session.id) && (
                      <span className="session-streaming-indicator ml-12" aria-label="Streaming">●</span>
                    )}
                  </div>
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
