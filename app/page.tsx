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
  const { loadSessions, loadSessionMessages, loadModels, loadConfig } = useDataLoaders(refs);

  // SSE streaming
  const { sendChatMessage } = useChatStream(refs, abortRef, loadSessions);

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
    dispatch({ type: 'CLEAR_MESSAGES' });
    dispatch({ type: 'SET_CURRENT_SESSION', id: null });
    await loadSessions();
  }, [dispatch, loadSessions]);

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
    <div
      style={{
        display: 'flex',
        height: '100vh',
        width: '100vw',
        overflow: 'hidden',
      }}
    >
      {/* Sidebar */}
      <SessionSidebar
        onNewSession={handleNewSession}
        onSelectSession={loadSessionMessages}
        onDeleteSession={handleDeleteSession}
        onSettings={handleOpenSettings}
      />

      {/* Main chat area */}
      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          minWidth: 0,
        }}
      >
        {/* Messages area */}
        <div
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '16px',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          {state.messages.length === 0 ? (
            <div
              style={{
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--text-secondary)',
                flexDirection: 'column',
                gap: '8px',
              }}
            >
              <h1 style={{ fontSize: '24px', fontWeight: 'normal', margin: 0 }}>
                Locopilot
              </h1>
              <p style={{ margin: 0 }}>Local, Private, Safe AI Assistant</p>
              {state.models.length > 0 && (
                <p style={{ fontSize: '13px', margin: 0 }}>
                  {state.models.length} model{state.models.length !== 1 ? 's' : ''} available
                </p>
              )}
            </div>
          ) : (
            state.messages.map((msg, i) => (
              <ChatMessageBubble key={i} message={msg} />
            ))
          )}

          {/* Error banner */}
          {state.error && (
            <div
              style={{
                padding: '12px',
                marginTop: '8px',
                background: '#3d1f1f',
                border: '1px solid #e94560',
                borderRadius: '8px',
                color: '#ff6b81',
                fontSize: '13px',
              }}
            >
              {state.error}
              <button
                onClick={() => dispatch({ type: 'SET_ERROR', error: null })}
                style={{
                  marginLeft: '12px',
                  background: 'none',
                  border: 'none',
                  color: '#ff6b81',
                  cursor: 'pointer',
                  textDecoration: 'underline',
                  fontSize: '13px',
                }}
              >
                Dismiss
              </button>
            </div>
          )}

          {/* Scroll anchor */}
          <div ref={messagesEndRef} />
        </div>

        {/* Input area */}
        <div
          style={{
            padding: '16px',
            borderTop: '1px solid #333',
            background: 'var(--bg-secondary)',
          }}
        >
          {state.isStreaming ? (
            <div
              style={{
                display: 'flex',
                gap: '8px',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <span style={{ color: 'var(--accent)', fontSize: '14px' }}>
                ● Streaming...
              </span>
              <button
                onClick={handleStop}
                style={{
                  padding: '8px 20px',
                  borderRadius: '8px',
                  border: '1px solid #e94560',
                  background: 'transparent',
                  color: '#e94560',
                  cursor: 'pointer',
                  fontSize: '13px',
                }}
              >
                Stop
              </button>
            </div>
          ) : isCompacting ? (
            <div
              style={{
                display: 'flex',
                gap: '8px',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <span style={{ color: 'var(--accent)', fontSize: '14px' }}>
                ● Compacting conversation...
              </span>
            </div>
          ) : isGeneratingTitle ? (
            <div
              style={{
                display: 'flex',
                gap: '8px',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <span style={{ color: 'var(--accent)', fontSize: '14px' }}>
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
