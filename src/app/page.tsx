'use client';

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';

import ApprovalModal from '@/components/ApprovalModal';
import { InputArea } from '@/components/InputArea';
import { MessagesArea } from '@/components/MessagesArea';
import { PageLayout } from '@/components/PageLayout';
import SettingsModal from '@/components/SettingsModal';
import { SessionSidebar, SkillsPanel } from '@/components/sidebar';
import StatusBar from '@/components/StatusBar';

import { useActionHandlers } from './hooks/useActionHandlers';
import { useApproval } from './hooks/useApproval';
import { useChatStream } from './hooks/useChatStream';
import { useDataLoaders } from './hooks/useDataLoaders';
import { useDocumentTitle } from './hooks/useDocumentTitle';
import { useScrollManager } from './hooks/useScrollManager';
import { useSendHandler } from './hooks/useSendHandler';
import { useSessionActions } from './hooks/useSessionActions';
import { useSessionUrlParam } from './hooks/useSessionUrlParam';
import { useSlashCommands } from './hooks/useSlashCommands';
import { useStableRefs } from './hooks/useStableRefs';
import { useSyncRefs } from './hooks/useSyncRefs';
import { useChat } from './lib/chatStore';

/** Inner component — uses useSearchParams so must live inside Suspense. */
function HomeInner() {
  const { state, dispatch } = useChat();
  const [showSettings, setShowSettings] = useState(false);
  const [isCompacting, setIsCompacting] = useState(false);
  const [isGeneratingTitle, setIsGeneratingTitle] = useState(false);

  const abortControllersRef = useRef<Map<number, AbortController>>(new Map());

  const { isCompactingRef, isGeneratingTitleRef } = useSyncRefs(
    isCompacting,
    isGeneratingTitle,
    state.currentSessionId
  );

  const refs = useStableRefs(state);
  const { loadSessions, loadSessionMessages, loadModels, loadConfig } = useDataLoaders(refs);

  const isCurrentSessionStreaming =
    state.currentSessionId === null
      ? state.streamingSessions.has(-1)
      : state.streamingSessions.has(state.currentSessionId);

  const { showScrollToLatest, scrollToLatest, messagesAreaRef, messagesEndRef } = useScrollManager({
    messages: state.messages,
    currentSessionId: state.currentSessionId,
    isStreaming: isCurrentSessionStreaming,
  });

  // ── Keep the browser tab title in sync with the active conversation ──
  useDocumentTitle(state.currentSessionId, state.sessions);

  // ── URL param: restore session from ?session=<id> on mount; keep URL in sync ──
  useSessionUrlParam({ onLoadSessionMessages: loadSessionMessages });

  const { sendChatMessage, retry, replayBufferedEvents } = useChatStream(
    refs,
    abortControllersRef,
    loadSessions
  );

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
    abortControllersRef,
    setIsCompacting,
    setIsGeneratingTitle,
    onOpenSettings: handleOpenSettings,
    loadSessions,
    sendChatMessage,
  });

  const handleSend = useSendHandler(dispatch, handleSlashCommand, sendChatMessage);

  const { handleStop, handleSkillPrompt } = useActionHandlers(
    abortControllersRef,
    isCurrentSessionStreaming,
    handleSend,
    dispatch
  );

  useEffect(() => {
    loadSessions();
    loadModels();
    loadConfig();
  }, []);

  return (
    <PageLayout
      sidebar={
        <SessionSidebar
          onNewSession={handleNewSession}
          onSelectSession={handleSelectSession}
          onDeleteSession={handleDeleteSession}
          onSettings={handleOpenSettings}
          onSearchSessions={handleSearchSessions}
        />
      }
      mainArea={
        <>
          <MessagesArea
            messages={state.messages}
            error={state.error}
            isCurrentSessionStreaming={isCurrentSessionStreaming}
            modelCount={state.models.length}
            showScrollToLatest={showScrollToLatest}
            messagesAreaRef={messagesAreaRef}
            messagesEndRef={messagesEndRef}
            onRetry={retry}
            onDismissError={() => dispatch({ type: 'SET_ERROR', error: null })}
            onScrollToLatest={scrollToLatest}
          />

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
        </>
      }
      approvalModal={
        state.showApproval && state.pendingCommand ? (
          <ApprovalModal
            command={state.pendingCommand}
            onApprove={handleApprove}
            onReject={handleReject}
          />
        ) : null
      }
      skillsPanel={<SkillsPanel onPromptAI={handleSkillPrompt} />}
      settingsModal={showSettings ? <SettingsModal onClose={handleCloseSettings} /> : null}
    />
  );
}

export default function Home() {
  return (
    <Suspense fallback={null}>
      <HomeInner />
    </Suspense>
  );
}
