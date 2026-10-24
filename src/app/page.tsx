'use client';

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';

import ApprovalModal from '@/components/ApprovalModal';
import ConfirmDialog from '@/components/ConfirmDialog';
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
import { useScrollManager } from './hooks/useScrollManager';
import { useSendHandler } from './hooks/useSendHandler';
import { useSessionActions } from './hooks/useSessionActions';
import { useSessionUrlParam } from './hooks/useSessionUrlParam';
import { COMPACTION_ABORT_KEY, useSlashCommands } from './hooks/useSlashCommands';
import { useStableRefs } from './hooks/useStableRefs';
import { useSyncRefs } from './hooks/useSyncRefs';
import { useChat } from './lib/chatStore';
import { streamKeyFor } from './lib/streamKey';

/** Inner component — uses useSearchParams so must live inside Suspense. */
function HomeInner() {
  // The per-session AbortController map lives on the chat-store context (the
  // single source of truth, created in ChatProvider) so the stream lifecycle
  // below and out-of-tree consumers (ModelSelector, SettingsModal) all share
  // one instance.
  const { state, dispatch, abortControllersRef } = useChat();
  const [showSettings, setShowSettings] = useState(false);
  // Session staged for deletion — the confirmation dialog is the only thing
  // gating handleDeleteSession, which stays the single delete executor.
  const [pendingDeleteId, setPendingDeleteId] = useState<number | null>(null);
  const [isCompacting, setIsCompacting] = useState(false);
  const [isGeneratingTitle, setIsGeneratingTitle] = useState(false);

  const { isCompactingRef, isGeneratingTitleRef } = useSyncRefs(isCompacting, isGeneratingTitle);

  const refs = useStableRefs(state);
  const { loadSessions, loadSessionMessages, loadModels, loadConfig } = useDataLoaders(refs);

  // Derive both the "is the visible session streaming" flag and the Stop
  // handler's key from the same helper: a brand-new chat has no id yet, so
  // its turn is registered under NEW_SESSION_KEY.
  const isCurrentSessionStreaming = state.streamingSessions.has(
    streamKeyFor(state.currentSessionId)
  );

  const { showScrollToLatest, scrollToLatest, messagesAreaRef, messagesEndRef } = useScrollManager({
    messages: state.messages,
    currentSessionId: state.currentSessionId,
    isStreaming: isCurrentSessionStreaming,
  });

  // ── URL param: restore session from ?session=<id> on mount; keep URL in sync ──
  useSessionUrlParam({ onLoadSessionMessages: loadSessionMessages });

  const { sendChatMessage, retry, replayBufferedEvents } = useChatStream(
    refs,
    abortControllersRef,
    loadSessions,
    loadSessionMessages
  );

  const handleOpenSettings = useCallback(() => setShowSettings(true), []);
  const handleCloseSettings = useCallback(() => setShowSettings(false), []);

  const {
    handleApprove,
    handleReject,
    isSubmitting,
    error: approvalError,
  } = useApproval({
    dispatch,
    pendingApprovalId: state.pendingApprovalId,
  });

  const {
    handleNewSession,
    handleSelectSession,
    handleDeleteSession,
    handleDeletePrompt,
    isDeletingPrompt,
    handleSearchSessions,
  } = useSessionActions({
    dispatch,
    sessionIdRef: refs.sessionIdRef,
    loadSessions,
    loadSessionMessages,
    replayBufferedEvents,
    model: state.model,
  });

  const handleDeletePromptCallback = useCallback(
    (messageId: number) => {
      if (state.currentSessionId === null || isCurrentSessionStreaming || isDeletingPrompt) return;
      void handleDeletePrompt(state.currentSessionId, messageId);
    },
    [handleDeletePrompt, isDeletingPrompt, state.currentSessionId, isCurrentSessionStreaming]
  );

  // ── Session deletion: stage → confirm → execute ──
  // The sidebar's × (and its Enter/Space keys) funnel through
  // handleRequestDeleteSession, which only stages the id; handleDeleteSession
  // remains the single, untouched delete executor.
  const pendingDelete =
    pendingDeleteId === null
      ? null
      : (state.sessions.find((s) => s.id === pendingDeleteId) ?? null);

  const handleRequestDeleteSession = useCallback((id: number) => setPendingDeleteId(id), []);

  const handleConfirmDeleteSession = useCallback(() => {
    if (pendingDeleteId === null) return;
    // Kill any in-flight stream for the doomed session before its row vanishes.
    abortControllersRef.current.get(pendingDeleteId)?.abort();
    void handleDeleteSession(pendingDeleteId);
    setPendingDeleteId(null);
  }, [abortControllersRef, handleDeleteSession, pendingDeleteId]);

  const handleCancelDeleteSession = useCallback(() => setPendingDeleteId(null), []);

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

  // The set of abort-controller map keys that `handleStop` must NOT
  // touch. Reserved for non-session work (compact / title / dump) so
  // the user can keep using these in a background tab while pressing
  // Stop in the foreground.
  const reservedAbortKeys = useRef<ReadonlySet<number>>(new Set<number>([COMPACTION_ABORT_KEY]));

  const { handleStop, handleSkillPrompt } = useActionHandlers(
    abortControllersRef,
    isCurrentSessionStreaming,
    handleSend,
    dispatch,
    // `state`, not `refs.sessionIdRef`: the ref is updated optimistically
    // before SET_CURRENT_SESSION commits, so reading it could target a
    // session the UI is not showing yet.
    state.currentSessionId,
    reservedAbortKeys.current
  );

  useEffect(() => {
    loadSessions();
    // Apply config before fetching models so the reconciler sees the
    // persisted model/activeProviderId first and never briefly adopts a
    // wrong default from the model list. Sessions are independent and stay
    // parallel.
    void (async () => {
      await loadConfig();
      await loadModels();
    })();
  }, []);

  return (
    <PageLayout
      sidebar={
        <SessionSidebar
          onNewSession={handleNewSession}
          onSelectSession={handleSelectSession}
          onDeleteSession={handleRequestDeleteSession}
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
            onDeletePrompt={handleDeletePromptCallback}
            isDeletingPrompt={isDeletingPrompt}
          />

          <div className="input-area">
            {state.lastDoneReason === 'length' &&
              !isCurrentSessionStreaming &&
              state.messages.length > 0 && (
                <div className="truncation-notice" role="status">
                  ⚠ Response truncated — the model hit its output-token limit. The reply above may
                  be incomplete.
                </div>
              )}
            <InputArea
              isStreaming={isCurrentSessionStreaming}
              isCompacting={isCompacting}
              isGeneratingTitle={isGeneratingTitle}
              isDeletingPrompt={isDeletingPrompt}
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
            isSubmitting={isSubmitting}
            error={approvalError}
            onApprove={handleApprove}
            onReject={handleReject}
          />
        ) : null
      }
      skillsPanel={<SkillsPanel onPromptAI={handleSkillPrompt} />}
      settingsModal={showSettings ? <SettingsModal onClose={handleCloseSettings} /> : null}
      confirmDialog={
        pendingDeleteId === null ? null : (
          <ConfirmDialog
            title="Delete conversation?"
            message={
              `“${pendingDelete?.name || `Session ${pendingDeleteId}`}” will be permanently ` +
              'deleted. This cannot be undone.'
            }
            confirmLabel="Delete"
            cancelLabel="Cancel"
            onConfirm={handleConfirmDeleteSession}
            onCancel={handleCancelDeleteSession}
          />
        )
      }
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
