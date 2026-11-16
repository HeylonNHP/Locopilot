'use client';

import { useEffect, useRef } from 'react';

import type {
  ChatMessage,
  ChatState,
  LLmModel,
  Session,
  WebSearchConfig,
} from '@/app/lib/chatStore';
import type { CompactionSelection } from '@/services/sessionSelection';
import type { CompletionMode, ProviderConfig, ReasoningEffort } from '@/types/chatConfig';

/** A mutable ref container (the writable counterpart to React 19's read-only RefObject). */
export type WritableRef<T> = { current: T };

/**
 * A stable container of refs that mirror the most recently rendered state values.
 * Used to avoid stale closures inside SSE callbacks and async handlers.
 */
export interface StableRefs {
  messagesRef: WritableRef<ChatMessage[]>;
  modelRef: WritableRef<string>;
  /**
   * Effective context-window size — the value the server actually sent
   * to the LLM. Kept for client-side display only; never used to
   * build request bodies. The clamp itself is the server's
   * responsibility. `null` until the server has reported a value
   * for the active model.
   */
  effectiveNumCtxRef: WritableRef<number | null>;
  baseUrlRef: WritableRef<string>;
  sessionIdRef: WritableRef<number | null>;
  sessionsRef: WritableRef<Session[]>;
  modelsRef: WritableRef<LLmModel[]>;
  providersRef: WritableRef<ProviderConfig[]>;
  activeProviderIdRef: WritableRef<string | null>;
  yoloRef: WritableRef<boolean>;
  thinkingEnabledRef: WritableRef<boolean>;
  reasoningEffortRef: WritableRef<ReasoningEffort | null>;
  compactionReasoningEffortRef: WritableRef<ReasoningEffort | null>;
  /**
   * The conversation on screen's compaction selection — ONE value, so a
   * compaction model can never travel without the provider that serves it.
   */
  compactionRef: WritableRef<CompactionSelection>;
  /**
   * The compaction model a NEW conversation starts with, and the one a
   * conversation that has not pinned a compaction model of its own inherits.
   * A pick of the main model does not change it.
   */
  defaultCompactionModelRef: WritableRef<string>;
  /**
   * The provider that serves {@link defaultCompactionModel} — the global
   * half of the compaction pair. `null` means "the main chat provider".
   *
   * It travels with the model because a model and the endpoint that serves
   * it are one choice: a compaction model named without its provider is what
   * sent a cloud model to the wrong endpoint and came back 404.
   */
  defaultCompactionProviderIdRef: WritableRef<string | null>;
  /** The global reasoning defaults a new conversation starts with. */
  defaultReasoningEffortRef: WritableRef<ReasoningEffort>;
  defaultCompactionReasoningEffortRef: WritableRef<ReasoningEffort>;
  chatTimeoutMsRef: WritableRef<number>;
  webSearchRef: WritableRef<WebSearchConfig>;
  completionModeRef: WritableRef<CompletionMode>;
  maxPromptLoopIterationsRef: WritableRef<number>;
  /**
   * Mirrors `state.steerDrafts` so the SSE `status` handler in
   * `useChatStream.ts` can read the steering-message draft of the session a
   * frame belongs to (to match a `steer_applied` ack and echo its text)
   * without widening `handleEvent`'s dependency array to the whole store
   * state.
   */
  steerDraftsRef: WritableRef<ChatState['steerDrafts']>;
}

interface StableRefsInput {
  messages: ChatMessage[];
  model: string;
  effectiveNumCtx: number | null;
  baseUrl: string;
  currentSessionId: number | null;
  sessions: Session[];
  models: LLmModel[];
  providers: ProviderConfig[];
  activeProviderId: string | null;
  yolo: boolean;
  thinkingEnabled: boolean;
  reasoningEffort: ReasoningEffort | null;
  compactionReasoningEffort: ReasoningEffort | null;
  compaction: CompactionSelection;
  defaultCompactionModel: string;
  defaultCompactionProviderId: string | null;
  defaultReasoningEffort: ReasoningEffort;
  defaultCompactionReasoningEffort: ReasoningEffort;
  chatTimeoutMs: number;
  webSearch: WebSearchConfig;
  completionMode: CompletionMode;
  maxPromptLoopIterations: number;
  steerDrafts: ChatState['steerDrafts'];
}

/**
 * Maintains a stable set of refs kept in sync with the given state values.
 * Returns the same container object reference on every render so it is safe
 * to include in useCallback / useEffect dependency arrays.
 */
export function useStableRefs(state: StableRefsInput): StableRefs {
  const messagesRef = useRef(state.messages);
  const modelRef = useRef(state.model);
  const effectiveNumCtxRef = useRef(state.effectiveNumCtx);
  const baseUrlRef = useRef(state.baseUrl);
  const sessionIdRef = useRef(state.currentSessionId);
  const sessionsRef = useRef(state.sessions);
  const modelsRef = useRef(state.models);
  const providersRef = useRef(state.providers);
  const activeProviderIdRef = useRef(state.activeProviderId);
  const yoloRef = useRef(state.yolo);
  const thinkingEnabledRef = useRef(state.thinkingEnabled);
  const reasoningEffortRef = useRef(state.reasoningEffort);
  const compactionReasoningEffortRef = useRef(state.compactionReasoningEffort);
  const compactionRef = useRef(state.compaction);
  const defaultCompactionModelRef = useRef(state.defaultCompactionModel);
  const defaultCompactionProviderIdRef = useRef(state.defaultCompactionProviderId);
  const defaultReasoningEffortRef = useRef(state.defaultReasoningEffort);
  const defaultCompactionReasoningEffortRef = useRef(state.defaultCompactionReasoningEffort);
  const chatTimeoutMsRef = useRef(state.chatTimeoutMs);
  const webSearchRef = useRef(state.webSearch);
  const completionModeRef = useRef(state.completionMode);
  const maxPromptLoopIterationsRef = useRef(state.maxPromptLoopIterations);
  const steerDraftsRef = useRef(state.steerDrafts);

  // sessionIdRef must be updated synchronously during render (not in a useEffect)
  // so the buffer guard in useChatStream.ts sees the new session immediately after
  // a SET_CURRENT_SESSION dispatch. A useEffect update runs after the browser paint,
  // creating a ~16–50ms window in which SSE events from the old session bypass the
  // guard and contaminate the new session's message list.
  sessionIdRef.current = state.currentSessionId;

  // The selection refs are updated the same way, for the same reason: the
  // request body is built from them, and switching conversations changes the
  // model (and reasoning levels) the next turn must run on. An effect would
  // leave a window in which a turn sent right after the switch carried the
  // previous conversation's values.
  modelRef.current = state.model;
  activeProviderIdRef.current = state.activeProviderId;
  compactionRef.current = state.compaction;
  defaultCompactionModelRef.current = state.defaultCompactionModel;
  defaultCompactionProviderIdRef.current = state.defaultCompactionProviderId;
  defaultReasoningEffortRef.current = state.defaultReasoningEffort;
  defaultCompactionReasoningEffortRef.current = state.defaultCompactionReasoningEffort;
  reasoningEffortRef.current = state.reasoningEffort;
  compactionReasoningEffortRef.current = state.compactionReasoningEffort;

  useEffect(() => {
    messagesRef.current = state.messages;
  }, [state.messages]);
  useEffect(() => {
    effectiveNumCtxRef.current = state.effectiveNumCtx;
  }, [state.effectiveNumCtx]);
  useEffect(() => {
    baseUrlRef.current = state.baseUrl;
  }, [state.baseUrl]);
  useEffect(() => {
    sessionsRef.current = state.sessions;
  }, [state.sessions]);
  useEffect(() => {
    modelsRef.current = state.models;
  }, [state.models]);
  useEffect(() => {
    providersRef.current = state.providers;
  }, [state.providers]);
  useEffect(() => {
    yoloRef.current = state.yolo;
  }, [state.yolo]);
  useEffect(() => {
    thinkingEnabledRef.current = state.thinkingEnabled;
  }, [state.thinkingEnabled]);
  useEffect(() => {
    chatTimeoutMsRef.current = state.chatTimeoutMs;
  }, [state.chatTimeoutMs]);
  useEffect(() => {
    webSearchRef.current = state.webSearch;
  }, [state.webSearch]);
  useEffect(() => {
    completionModeRef.current = state.completionMode;
  }, [state.completionMode]);
  useEffect(() => {
    maxPromptLoopIterationsRef.current = state.maxPromptLoopIterations;
  }, [state.maxPromptLoopIterations]);
  useEffect(() => {
    steerDraftsRef.current = state.steerDrafts;
  }, [state.steerDrafts]);

  // Return a stable container so the same object identity is returned every render.
  // Individual ref objects (created by useRef above) are already stable; only the
  // container wrapper is stabilised here.
  const containerRef = useRef<StableRefs | null>(null);
  if (!containerRef.current) {
    containerRef.current = {
      messagesRef,
      modelRef,
      effectiveNumCtxRef,
      baseUrlRef,
      sessionIdRef,
      sessionsRef,
      modelsRef,
      providersRef,
      activeProviderIdRef,
      yoloRef,
      thinkingEnabledRef,
      reasoningEffortRef,
      compactionReasoningEffortRef,
      compactionRef,
      defaultCompactionModelRef,
      defaultCompactionProviderIdRef,
      defaultReasoningEffortRef,
      defaultCompactionReasoningEffortRef,
      chatTimeoutMsRef,
      webSearchRef,
      completionModeRef,
      maxPromptLoopIterationsRef,
      steerDraftsRef,
    };
  }
  return containerRef.current;
}
