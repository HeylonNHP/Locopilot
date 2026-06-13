'use client';

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';

import ApprovalModal from '@/components/ApprovalModal';
import { type Attachment } from '@/components/ChatInput';
import ChatMessageBubble from '@/components/ChatMessageBubble';
import { EmptyState } from '@/components/EmptyState';
import { ErrorBanner } from '@/components/ErrorBanner';
import { InputArea } from '@/components/InputArea';
import ScrollToLatestButton from '@/components/ScrollToLatestButton';
import SettingsModal from '@/components/SettingsModal';
import { SessionSidebar, SkillsPanel } from '@/components/sidebar';
import StatusBar from '@/components/StatusBar';

import { useApproval } from './hooks/useApproval';
import { useChatStream } from './hooks/useChatStream';
import { useDataLoaders } from './hooks/useDataLoaders';
import { useScrollManager } from './hooks/useScrollManager';
import { useSessionActions } from './hooks/useSessionActions';
import { useSessionUrlParam } from './hooks/useSessionUrlParam';
import { useSlashCommands } from './hooks/useSlashCommands';
import { useStableRefs } from './hooks/useStableRefs';
import { useChat } from './lib/chatStore';

/** Inner component — uses useSearchParams so must live inside Suspense. */
function HomeInner() {
  const { state, dispatch } = useChat();
  const [showSettings, setShowSettings] = useState(false);
  const [isCompacting, setIsCompacting] = useState(false);
  const [isGeneratingTitle, setIsGeneratingTitle] = useState(false);

  const abortControllersRef = useRef<Map<number, AbortController>>(new Map());
  const currentSessionIdRef = useRef<number | null>(state.currentSessionId);
  const isCompactingRef = useRef(false);
  const isGeneratingTitleRef = useRef(false);

  useEffect(() => {
    isCompactingRef.current = isCompacting;
  }, [isCompacting]);
  useEffect(() => {
    isGeneratingTitleRef.current = isGeneratingTitle;
  }, [isGeneratingTitle]);
  useEffect(() => {
    currentSessionIdRef.current = state.currentSessionId;
  }, [state.currentSessionId]);

  const refs = useStableRefs(state);
  const { loadSessions, loadSessionMessages, loadModels, loadConfig } = useDataLoaders(refs);

  const { showScrollToLatest, scrollToLatest, messagesAreaRef, messagesEndRef } = useScrollManager({
    messages: state.messages,
    currentSessionId: state.currentSessionId,
  });

  // ── URL param: restore session from ?session=<id> on mount; keep URL in sync ──
  useSessionUrlParam({ onLoadSessionMessages: loadSessionMessages });

  const { sendChatMessage, retry, replayBufferedEvents } = useChatStream(
    refs,
    abortControllersRef,
    loadSessions
  );

  const isCurrentSessionStreaming =
    state.currentSessionId === null
      ? state.streamingSessions.has(-1)
      : state.streamingSessions.has(state.currentSessionId);

  const handleOpenSettings = useCallback(() => setShowSettings(true), []);
  const handleCloseSettings = useCallback(() => setShowSettings(false), []);

  const { handleApprove, handleReject } = useApproval({
    dispatch,
    pendingApprovalId: state.pendingApprovalId,
  });

  const { handleNewSession, handleSelectSession, handleDeleteSession, handleSearchSessions } =
    useSessionActions({
      dispatch,
      sessionIdRef: refs.sessionIdRef,
      loadSessions,
      loadSessionMessages,
      replayBufferedEvents,
      model: state.model,
    });

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
  }, []);

  const handleSend = useCallback(
    async (message: string, attachments: Attachment[]) => {
      const trimmed = message.trim();
      const hasAttachments = attachments.length > 0;
      if (!trimmed && !hasAttachments) return;
      dispatch({ type: 'CLEAR_COMPACT_PROGRESS' });
      // Slash commands don't accept attachments — warn if the user had some pending.
      if (trimmed.startsWith('/')) {
        if (hasAttachments) {
          dispatch({
            type: 'ADD_MESSAGE',
            message: {
              role: 'system',
              content: `Attachments are not supported with slash commands. Your ${attachments.length} file(s) were not sent.`,
            },
          });
        }
        await handleSlashCommand(trimmed);
      } else {
        await sendChatMessage(message, attachments);
      }
    },
    [dispatch, handleSlashCommand, sendChatMessage]
  );

  const handleStop = useCallback(() => {
    const controller = abortControllersRef.current.get(state.currentSessionId ?? -1);
    controller?.abort();
  }, [state.currentSessionId]);

  const handleSkillPrompt = useCallback(
    (message: string) => {
      if (isCurrentSessionStreaming) {
        dispatch({
          type: 'ADD_MESSAGE',
          message: {
            role: 'system',
            content: 'Cannot manage skills while the AI is responding. Stop the response first.',
          },
        });
        return;
      }
      handleSend(message, []);
    },
    [isCurrentSessionStreaming, handleSend, dispatch]
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
          >
            {state.messages.length === 0 ? (
              <EmptyState modelCount={state.models.length} />
            ) : (
              state.messages.map((msg, i) => <ChatMessageBubble key={msg.id ?? i} message={msg} />)
            )}

            {state.error && (
              <ErrorBanner
                error={state.error}
                isRetrying={isCurrentSessionStreaming}
                onRetry={retry}
                onDismiss={() => dispatch({ type: 'SET_ERROR', error: null })}
              />
            )}

            <div ref={messagesEndRef} />
          </div>

          <ScrollToLatestButton
            visible={showScrollToLatest && state.messages.length > 0}
            onClick={() => scrollToLatest('smooth')}
          />
        </div>

        <div className="input-area">
          <InputArea
            isStreaming={isCurrentSessionStreaming}
            isCompacting={isCompacting}
            isGeneratingTitle={isGeneratingTitle}
            compactingPhases={state.compactingPhases}
            onStop={handleStop}
            onSend={handleSend}
          />
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
