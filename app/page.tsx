'use client';

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useChat } from './lib/chatStore';
import { useStableRefs } from './hooks/useStableRefs';
import { useDataLoaders } from './hooks/useDataLoaders';
import { useChatStream } from './hooks/useChatStream';
import { useSlashCommands } from './hooks/useSlashCommands';
import { useSessionUrlParam } from './hooks/useSessionUrlParam';
import ChatMessageBubble from '@/components/ChatMessageBubble';
import ChatInput from '@/components/ChatInput';
import ScrollToLatestButton from '@/components/ScrollToLatestButton';
import { SessionSidebar, SkillsPanel } from '@/components/sidebar';
import ApprovalModal from '@/components/ApprovalModal';
import StatusBar from '@/components/StatusBar';
import SettingsModal from '@/components/SettingsModal';

/** Inner component — uses useSearchParams so must live inside Suspense. */
function HomeInner() {
  const { state, dispatch } = useChat();
  const [showSettings, setShowSettings] = useState(false);
  const [isCompacting, setIsCompacting] = useState(false);
  const [isGeneratingTitle, setIsGeneratingTitle] = useState(false);
  const [showErrorDetails, setShowErrorDetails] = useState(false);
  const [showScrollToLatest, setShowScrollToLatest] = useState(false);

  const abortControllersRef = useRef<Map<number, AbortController>>(new Map());
  const messagesAreaRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  const programmaticScrollUntilRef = useRef(0);
  const currentSessionIdRef = useRef<number | null>(state.currentSessionId);
  const previousSessionIdRef = useRef<number | null | undefined>(undefined);
  const isCompactingRef = useRef(false);
  const isGeneratingTitleRef = useRef(false);
  const sessionSwitchIdRef = useRef<number | null>(null);
  const currentSearchQueryRef = useRef('');

  useEffect(() => { isCompactingRef.current = isCompacting; }, [isCompacting]);
  useEffect(() => { isGeneratingTitleRef.current = isGeneratingTitle; }, [isGeneratingTitle]);
  useEffect(() => { currentSessionIdRef.current = state.currentSessionId; }, [state.currentSessionId]);

  const handleMessagesAreaScroll = useCallback(() => {
    const container = messagesAreaRef.current;
    if (!container) return;

    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    const isAtBottom = distanceFromBottom <= 32;

    isAtBottomRef.current = isAtBottom;

    const isProgrammatic = Date.now() < programmaticScrollUntilRef.current;
    if (isProgrammatic && !isAtBottom) {
      return;
    }

    if (isAtBottom) {
      programmaticScrollUntilRef.current = 0;
    }

    setShowScrollToLatest(!isAtBottom && container.scrollHeight > container.clientHeight + 1);
  }, []);

  const scrollMessagesToLatest = useCallback((behavior: ScrollBehavior = 'smooth') => {
    programmaticScrollUntilRef.current = Date.now() + 400;
    messagesEndRef.current?.scrollIntoView({ behavior, block: 'end' });
    isAtBottomRef.current = true;
    setShowScrollToLatest(false);
  }, []);

  const refs = useStableRefs(state);
  const { loadSessions, loadSessionMessages, loadModels, loadConfig } = useDataLoaders(refs);

  // ── URL param: restore session from ?session=<id> on mount; keep URL in sync ──
  useSessionUrlParam({ onLoadSessionMessages: loadSessionMessages });

  const { sendChatMessage, retry, replayBufferedEvents } = useChatStream(
    refs,
    abortControllersRef,
    loadSessions,
  );

  const isCurrentSessionStreaming = state.currentSessionId !== null
    ? state.streamingSessions.has(state.currentSessionId)
    : state.streamingSessions.has(-1);

  const handleOpenSettings = useCallback(() => setShowSettings(true), []);

  const handleSearchSessions = useCallback(async (query: string) => {
    currentSearchQueryRef.current = query;
    if (query.trim()) {
      await loadSessions(query);
    } else {
      await loadSessions();
    }
  }, [loadSessions]);
  const handleCloseSettings = useCallback(() => setShowSettings(false), []);

  const { handleSlashCommand } = useSlashCommands({
    refs,
    isCurrentSessionStreaming,
    isCompactingRef,
    isGeneratingTitleRef,
    setIsCompacting,
    setIsGeneratingTitle,
    onOpenSettings: handleOpenSettings,
    loadSessions,
    sendChatMessage,
  });

  useEffect(() => {
    loadSessions();
    loadModels();
    loadConfig();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Initialise scroll-state from real DOM after first paint so a long
  // conversation that loads above the fold immediately shows the Latest button.
  useEffect(() => {
    const container = messagesAreaRef.current;
    if (!container) return;
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    const isAtBottom = distanceFromBottom <= 32;
    isAtBottomRef.current = isAtBottom;
    setShowScrollToLatest(!isAtBottom && container.scrollHeight > container.clientHeight + 1);
  }, []);

  useEffect(() => {
    const currentSessionId = currentSessionIdRef.current;
    const sessionChanged = previousSessionIdRef.current !== currentSessionId;

    if (!sessionChanged && !isAtBottomRef.current) {
      return;
    }

    // Immediate scroll handles streaming tokens well, but when a whole
    // conversation is loaded at once (session switch) the DOM keeps growing
    // as markdown/images settle. Fire a second deferred scroll to land at
    // the true bottom after layout stabilises.
    scrollMessagesToLatest('smooth');
    const timer = setTimeout(() => {
      scrollMessagesToLatest('smooth');
    }, 120);

    previousSessionIdRef.current = currentSessionId;
    return () => clearTimeout(timer);
  }, [state.messages, scrollMessagesToLatest]);

  const handleSend = useCallback(
    async (message: string) => {
      const trimmed = message.trim();
      if (!trimmed) return;
      dispatch({ type: 'CLEAR_COMPACT_PROGRESS' });
      if (trimmed.startsWith('/')) await handleSlashCommand(trimmed);
      else await sendChatMessage(message);
    },
    [dispatch, handleSlashCommand, sendChatMessage],
  );

  const handleStop = useCallback(() => {
    const controller = abortControllersRef.current.get(state.currentSessionId ?? -1);
    controller?.abort();
  }, [state.currentSessionId]);

  const handleSkillPrompt = useCallback(
    (message: string) => {
      if (isCurrentSessionStreaming) {
        dispatch({ type: 'ADD_MESSAGE', message: { role: 'system', content: 'Cannot manage skills while the AI is responding. Stop the response first.' } });
        return;
      }
      handleSend(message);
    },
    [isCurrentSessionStreaming, handleSend, dispatch],
  );

  const handleApprove = useCallback(async () => {
    const requestId = state.pendingApprovalId;
    if (requestId) {
      try {
        await fetch('/api/approve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requestId, approved: true }),
        });
      } catch {
        // Keep modal open on failure so the user can retry
        return;
      }
    }
    dispatch({ type: 'SHOW_APPROVAL', command: null });
  }, [dispatch, state.pendingApprovalId]);

  const handleReject = useCallback(async () => {
    const requestId = state.pendingApprovalId;
    if (requestId) {
      try {
        await fetch('/api/approve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requestId, approved: false }),
        });
      } catch {
        // Keep modal open on failure so the user can retry
        return;
      }
    }
    dispatch({ type: 'SHOW_APPROVAL', command: null });
  }, [dispatch, state.pendingApprovalId]);

  const handleNewSession = useCallback(async () => {
    // SET_CURRENT_SESSION with null auto-saves old state and restores new-session defaults
    dispatch({ type: 'SET_CURRENT_SESSION', id: null });
    await loadSessions();
  }, [dispatch, loadSessions]);

  const handleSelectSession = useCallback(
    async (sessionId: number) => {
      sessionSwitchIdRef.current = sessionId;
      // SET_CURRENT_SESSION auto-saves old state and restores target state
      dispatch({ type: 'SET_CURRENT_SESSION', id: sessionId });
      await loadSessionMessages(sessionId);
      if (sessionSwitchIdRef.current !== sessionId) return;
      replayBufferedEvents(sessionId);
    },
    [dispatch, loadSessionMessages, replayBufferedEvents],
  );

  const handleDeleteSession = useCallback(
    async (id: number) => {
      try {
        await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
        const q = currentSearchQueryRef.current;
        if (q.trim()) {
          await loadSessions(q);
        } else {
          await loadSessions();
        }
        dispatch({ type: 'DISCARD_SESSION', sessionId: id });
        if (refs.sessionIdRef.current === id) {
          dispatch({ type: 'CLEAR_MESSAGES' });
          dispatch({ type: 'SET_CURRENT_SESSION', id: null });
        }
      } catch {
        // Silently ignore
      }
    },
    [refs, dispatch, loadSessions],
  );

  return (
    <div className="app-root">
      <SessionSidebar
        onNewSession={handleNewSession}
        onSelectSession={handleSelectSession}
        onDeleteSession={handleDeleteSession}
        onSettings={handleOpenSettings}
        onSearchSessions={handleSearchSessions}
      />

      <div className="main-area">
        <div className="messages-shell">
          <div
            ref={messagesAreaRef}
            className={`messages-area ${showScrollToLatest ? 'messages-area--has-scroll-button' : ''}`}
            onScroll={handleMessagesAreaScroll}
          >
            {state.messages.length === 0 ? (
              <div className="empty-state">
                <h1 className="font-24 font-normal m-0">Locopilot</h1>
                <p className="m-0">Local, Private, Safe AI Assistant</p>
                {state.models.length > 0 && (
                  <p className="font-13 m-0">
                    {state.models.length} model{state.models.length !== 1 ? 's' : ''} available
                  </p>
                )}
              </div>
            ) : (
              state.messages.map((msg, i) => (
                <ChatMessageBubble key={msg.id ?? i} message={msg} />
              ))
            )}

            {state.error && (
              <div className="error-banner">
                <div className="error-header">
                  <span className="error-message">Something went wrong.</span>
                  <button
                    className="error-details-toggle"
                    onClick={() => setShowErrorDetails(!showErrorDetails)}
                  >
                    {showErrorDetails ? 'Hide details ▲' : 'Details ▼'}
                  </button>
                </div>
                {showErrorDetails && (
                  <pre className="error-details">{state.error}</pre>
                )}
                <div className="error-actions">
                  <button onClick={retry} className="error-retry-btn" disabled={isCurrentSessionStreaming}>
                    Retry
                  </button>
                  <button
                    onClick={() => dispatch({ type: 'SET_ERROR', error: null })}
                    className="error-dismiss-btn"
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          <ScrollToLatestButton
            visible={showScrollToLatest && state.messages.length > 0}
            onClick={() => scrollMessagesToLatest('smooth')}
          />
        </div>

        <div className="input-area">
          {isCurrentSessionStreaming ? (
            <div className="streaming-indicator">
              <span className="text-accent font-14">
                ● {state.compactingPhases.length > 0
                  ? state.compactingPhases[state.compactingPhases.length - 1]
                  : 'Streaming...'}
              </span>
              <button onClick={handleStop} className="stop-btn">Stop</button>
            </div>
          ) : isCompacting ? (
            <div className="streaming-indicator">
              <span className="text-accent font-14">
                ● {state.compactingPhases.length > 0
                  ? state.compactingPhases[state.compactingPhases.length - 1]
                  : 'Compacting conversation...'}
              </span>
            </div>
          ) : isGeneratingTitle ? (
            <div className="streaming-indicator">
              <span className="text-accent font-14">● Generating session title...</span>
            </div>
          ) : (
            <ChatInput onSend={handleSend} disabled={false} />
          )}
        </div>

        <StatusBar />
      </div>

      {state.showApproval && state.pendingCommand && (
        <ApprovalModal
          command={state.pendingCommand}
          onApprove={handleApprove}
          onReject={handleReject}
        />
      )}

      <SkillsPanel onPromptAI={handleSkillPrompt} />

      {showSettings && <SettingsModal onClose={handleCloseSettings} />}
    </div>
  );
}

export default function Home() {
  return (
    <Suspense fallback={null}>
      <HomeInner />
    </Suspense>
  );
}
