'use client';
import {
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from 'react';

import { useChat } from '@/app/lib/chatStore';
import { NEW_SESSION_KEY } from '@/app/lib/streamKey';
import { DEFAULT_SESSION_NAME } from '@/constants';

import './SessionSidebar.scss';

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
  // The query `onSearchSessions` was last called with, so a synchronous clear
  // can short-circuit the debounce instead of firing a second fetch 200 ms
  // later. Without it, clearing the box left the filtered list on screen for
  // one debounce interval — showing "No sessions yet" while rows still
  // existed on the server.
  const appliedQueryRef = useRef('');

  // Debounced search: skip first render (page.tsx already loads on mount)
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    if (searchQuery === appliedQueryRef.current) return;
    const timer = setTimeout(() => {
      appliedQueryRef.current = searchQuery;
      onSearchSessions(searchQuery);
    }, 200);
    return () => clearTimeout(timer);
  }, [searchQuery, onSearchSessions]);

  const handleClearSearch = () => {
    // Mark the empty query as already applied BEFORE setState so the effect
    // above sees no pending change and does not schedule a duplicate fetch.
    appliedQueryRef.current = '';
    setSearchQuery('');
    onSearchSessions('');
  };

  const handleActionKeyDown = (event: KeyboardEvent<HTMLDivElement>, action: () => void) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      action();
    }
  };

  const clearPointerFocus = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.blur();
  };

  const isSearching = searchQuery.trim().length > 0;

  // A turn started from a brand-new chat is streaming under NEW_SESSION_KEY
  // until the server reports the real id, so no persisted row can show it.
  // Project it as a transient, non-interactive row (no select/delete: those
  // would address `GET /api/sessions/-1`). It disappears in the same render
  // that adds the real row, because `currentSessionId` leaves `null`.
  const showUnsavedRow =
    state.currentSessionId === null && state.streamingSessions.has(NEW_SESSION_KEY);

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <h2 className="sidebar-title">Locopilot</h2>
        <div className="flex gap-8">
          <button onClick={onNewSession} className="sidebar-btn-new">
            + {DEFAULT_SESSION_NAME}
          </button>
          <button onClick={onSettings} title="Settings" className="sidebar-btn-settings">
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
            onClick={handleClearSearch}
            className="sidebar-search-clear"
            aria-label="Clear search"
            title="Clear search"
          >
            ×
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-8">
        {state.sessions.length === 0 && !showUnsavedRow ? (
          <p className="sidebar-empty">
            {isSearching ? 'No sessions match your search' : 'No sessions yet'}
          </p>
        ) : (
          <>
            {showUnsavedRow && (
              <div className="session-row" data-selected="true">
                <div className="session-row__action flex-1 min-w-0 px-12 py-10 text-primary font-13 text-left">
                  <div className="flex items-center w-full">
                    <span className="block text-overflow-ellipsis flex-1 min-w-0">
                      {DEFAULT_SESSION_NAME}
                    </span>
                    <span
                      className="session-streaming-indicator ml-12"
                      role="img"
                      aria-label="Streaming"
                    >
                      ●
                    </span>
                  </div>
                </div>
              </div>
            )}
            {state.sessions.map((session) => {
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
                    onKeyDown={(event) =>
                      handleActionKeyDown(event, () => onSelectSession(session.id))
                    }
                    onPointerUp={clearPointerFocus}
                    title={session.name || `Session ${session.id}`}
                    className="session-row__action flex-1 min-w-0 px-12 py-10 text-primary cursor-pointer font-13 text-left"
                  >
                    <div className="flex items-center w-full">
                      <span className="block text-overflow-ellipsis flex-1 min-w-0">
                        {session.name || `Session ${session.id}`}
                      </span>
                      {state.streamingSessions.has(session.id) && (
                        <span
                          className="session-streaming-indicator ml-12"
                          role="img"
                          aria-label="Streaming"
                        >
                          ●
                        </span>
                      )}
                    </div>
                  </div>
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => onDeleteSession(session.id)}
                    onKeyDown={(event) =>
                      handleActionKeyDown(event, () => onDeleteSession(session.id))
                    }
                    onPointerUp={clearPointerFocus}
                    title="Delete session"
                    className="session-row__action text-secondary cursor-pointer font-14 py-10 px-12 flex-shrink-0 opacity-50"
                  >
                    ×
                  </div>
                </div>
              );
            })}
          </>
        )}
      </div>
      <div onClick={onSettings} className="sidebar-footer" title="Click to open settings">
        {state.model && (
          <div>
            Model: {state.models.find((m) => m.name === state.model)?.displayName ?? state.model}
          </div>
        )}
        {!state.model && <div>No model selected</div>}
      </div>
    </div>
  );
}
