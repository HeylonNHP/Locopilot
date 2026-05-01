'use client';

import { useEffect, useRef, useCallback, useState } from 'react';
import { useChat } from './lib/chatStore';
import { useStableRefs } from './hooks/useStableRefs';
import { useDataLoaders } from './hooks/useDataLoaders';
import { useChatStream } from './hooks/useChatStream';
import { useSlashCommands } from './hooks/useSlashCommands';
import ChatMessageBubble from '@/components/ChatMessageBubble';
import ChatInput from '@/components/ChatInput';
import SessionSidebar from '@/components/SessionSidebar';
import ApprovalModal from '@/components/ApprovalModal';
import StatusBar from '@/components/StatusBar';
import SettingsModal from '@/components/SettingsModal';

export default function Home() {
  const { state, dispatch } = useChat();
  const [showSettings, setShowSettings] = useState(false);
  const [isCompacting, setIsCompacting] = useState(false);
  const [isGeneratingTitle, setIsGeneratingTitle] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const isCompactingRef = useRef(false);
  const isGeneratingTitleRef = useRef(false);

  // Keep isCompacting/isGeneratingTitle accessible as refs for async guards
  useEffect(() => { isCompactingRef.current = isCompacting; }, [isCompacting]);
  useEffect(() => { isGeneratingTitleRef.current = isGeneratingTitle; }, [isGeneratingTitle]);

  // Stable refs that mirror the latest state values (avoids stale closures)
  const refs = useStableRefs(state);

  // Data loading helpers
  const { loadSessions, loadSessionMessages, loadModels, loadConfig, loadModelContextLimit } = useDataLoaders(refs);

  // SSE streaming
  const { sendChatMessage, replayBufferedEvents } = useChatStream(refs, abortRef, loadSessions);

  // Settings opener — defined before useSlashCommands so it can be passed in
  const handleOpenSettings = useCallback(() => setShowSettings(true), []);
  const handleCloseSettings = useCallback(() => setShowSettings(false), []);

  // Slash command handling
  const { handleSlashCommand } = useSlashCommands({
    refs,
    abortRef,
    isCompactingRef,
    isGeneratingTitleRef,
    setIsCompacting,
    setIsGeneratingTitle,
    onOpenSettings: handleOpenSettings,
    loadSessions,
    sendChatMessage,
  });

  // ── Load initial data on mount ──────────────────────────────────
  useEffect(() => {
    loadSessions();
    loadModels();
    loadConfig();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Auto-scroll when messages change ────────────────────────────
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [state.messages]);

  // ── Send handler (routes slash commands or regular chat) ─────────
  const handleSend = useCallback(
    async (message: string) => {
      const trimmed = message.trim();
      if (!trimmed) return;
      if (trimmed.startsWith('/')) await handleSlashCommand(trimmed);
      else await sendChatMessage(message);
    },
    [handleSlashCommand, sendChatMessage],
  );

  // ── Stop streaming ────────────────────────────────────────────────
  const handleStop = useCallback(() => { abortRef.current?.abort(); }, []);

  // ── Approval modal ────────────────────────────────────────────────
  const handleApprove = useCallback(async () => {
    const requestId = state.pendingApprovalId;
    dispatch({ type: 'SHOW_APPROVAL', command: null });
    if (requestId) {
      await fetch('/api/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId, approved: true }),
      }).catch(() => { /* ignore – backend timeout already handles this */ });
    }
  }, [dispatch, state.pendingApprovalId]);

  const handleReject = useCallback(async () => {
    const requestId = state.pendingApprovalId;
    dispatch({ type: 'SHOW_APPROVAL', command: null });
    if (requestId) {
      await fetch('/api/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId, approved: false }),
      }).catch(() => { /* ignore – backend timeout already handles this */ });
    }
  }, [dispatch, state.pendingApprovalId]);

  // ── Session management ────────────────────────────────────────────
  const handleNewSession = useCallback(async () => {
    // Abort any in-flight stream so its events don't land in the new session.
    abortRef.current?.abort();
    dispatch({ type: 'CLEAR_MESSAGES' });
    dispatch({ type: 'CLEAR_TOKEN_STATS' });
    dispatch({ type: 'SET_CURRENT_SESSION', id: null });
    await loadSessions();
  }, [dispatch, loadSessions, abortRef]);

  // Keep the stream alive when switching to another session: the hook buffers
  // events while away and replays them when the user switches back, so live
  // subagent (and other) output resumes without bleed into the wrong session.
  const handleSelectSession = useCallback(
    async (sessionId: number) => {
      await loadSessionMessages(sessionId);
      replayBufferedEvents(sessionId);
    },
    [loadSessionMessages, replayBufferedEvents],
  );

  const handleDeleteSession = useCallback(
    async (id: number) => {
      try {
        await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
        loadSessions();
        if (state.currentSessionId === id) {
          dispatch({ type: 'CLEAR_MESSAGES' });
          dispatch({ type: 'SET_CURRENT_SESSION', id: null });
        }
      } catch {
        // Silently ignore
      }
    },
    [state.currentSessionId, dispatch, loadSessions],
  );

  // ── Render ──────────────────────────────────────────────────────
  return (
    <div className="app-root">
      {/* Sidebar */}
      <SessionSidebar
        onNewSession={handleNewSession}
        onSelectSession={handleSelectSession}
        onDeleteSession={handleDeleteSession}
        onSettings={handleOpenSettings}
      />

      {/* Main chat area */}
      <div className="main-area">
        {/* Messages area */}
        <div className="messages-area">
          {state.messages.length === 0 ? (
            <div className="empty-state">
              <h1 className="font-24 font-normal m-0">
                Locopilot
              </h1>
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

          {/* Error banner */}
          {state.error && (
            <div className="error-banner">
              {state.error}
              <button
                onClick={() => dispatch({ type: 'SET_ERROR', error: null })}
                className="error-dismiss-btn"
              >
                Dismiss
              </button>
            </div>
          )}

          {/* Scroll anchor */}
          <div ref={messagesEndRef} />
        </div>

        {/* Input area */}
        <div className="input-area">
          {state.isStreaming ? (
            <div className="streaming-indicator">
              <span className="text-accent font-14">
                ● Streaming...
              </span>
              <button
                onClick={handleStop}
                className="stop-btn"
              >
                Stop
              </button>
            </div>
          ) : isCompacting ? (
            <div className="streaming-indicator">
              <span className="text-accent font-14">
                ● Compacting conversation...
              </span>
            </div>
          ) : isGeneratingTitle ? (
            <div className="streaming-indicator">
              <span className="text-accent font-14">
                ● Generating session title...
              </span>
            </div>
          ) : (
            <ChatInput onSend={handleSend} disabled={false} />
          )}
        </div>

        {/* Status bar */}
        <StatusBar />
      </div>

      {/* Approval modal */}
      {state.showApproval && state.pendingCommand && (
        <ApprovalModal
          command={state.pendingCommand}
          onApprove={handleApprove}
          onReject={handleReject}
        />
      )}

      {/* Settings modal */}
      {showSettings && <SettingsModal onClose={handleCloseSettings} />}
    </div>
  );
}
