'use client';

import { useEffect, useRef } from 'react';

import type { ChatMessage, LLmModel, Session, WebSearchConfig } from '@/app/lib/chatStore';
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
  /**
   * User's requested context-window size — sent in the request body so
   * the server can resolve it against the model's runtime cap. The
   * server's clamp result lands back in `effectiveNumCtxRef` via the
   * `status` SSE event.
   */
  requestedNumCtxRef: WritableRef<number>;
  baseUrlRef: WritableRef<string>;
  sessionIdRef: WritableRef<number | null>;
  sessionsRef: WritableRef<Session[]>;
  modelsRef: WritableRef<LLmModel[]>;
  providersRef: WritableRef<ProviderConfig[]>;
  activeProviderIdRef: WritableRef<string | null>;
  yoloRef: WritableRef<boolean>;
  thinkingEnabledRef: WritableRef<boolean>;
  reasoningEffortRef: WritableRef<ReasoningEffort>;
  compactionModelRef: WritableRef<string>;
  chatTimeoutMsRef: WritableRef<number>;
  webSearchRef: WritableRef<WebSearchConfig>;
  completionModeRef: WritableRef<CompletionMode>;
  maxPromptLoopIterationsRef: WritableRef<number>;
}

interface StableRefsInput {
  messages: ChatMessage[];
  model: string;
  effectiveNumCtx: number | null;
  requestedNumCtx: number;
  baseUrl: string;
  currentSessionId: number | null;
  sessions: Session[];
  models: LLmModel[];
  providers: ProviderConfig[];
  activeProviderId: string | null;
  yolo: boolean;
  thinkingEnabled: boolean;
  reasoningEffort: ReasoningEffort;
  compactionModel: string;
  chatTimeoutMs: number;
  webSearch: WebSearchConfig;
  completionMode: CompletionMode;
  maxPromptLoopIterations: number;
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
  const requestedNumCtxRef = useRef(state.requestedNumCtx);
  const baseUrlRef = useRef(state.baseUrl);
  const sessionIdRef = useRef(state.currentSessionId);
  const sessionsRef = useRef(state.sessions);
  const modelsRef = useRef(state.models);
  const providersRef = useRef(state.providers);
  const activeProviderIdRef = useRef(state.activeProviderId);
  const yoloRef = useRef(state.yolo);
  const thinkingEnabledRef = useRef(state.thinkingEnabled);
  const reasoningEffortRef = useRef(state.reasoningEffort);
  const compactionModelRef = useRef(state.compactionModel);
  const chatTimeoutMsRef = useRef(state.chatTimeoutMs);
  const webSearchRef = useRef(state.webSearch);
  const completionModeRef = useRef(state.completionMode);
  const maxPromptLoopIterationsRef = useRef(state.maxPromptLoopIterations);

  // sessionIdRef must be updated synchronously during render (not in a useEffect)
  // so the buffer guard in useChatStream.ts sees the new session immediately after
  // a SET_CURRENT_SESSION dispatch. A useEffect update runs after the browser paint,
  // creating a ~16–50ms window in which SSE events from the old session bypass the
  // guard and contaminate the new session's message list.
  sessionIdRef.current = state.currentSessionId;

  useEffect(() => {
    messagesRef.current = state.messages;
  }, [state.messages]);
  useEffect(() => {
    modelRef.current = state.model;
  }, [state.model]);
  useEffect(() => {
    effectiveNumCtxRef.current = state.effectiveNumCtx;
  }, [state.effectiveNumCtx]);
  useEffect(() => {
    requestedNumCtxRef.current = state.requestedNumCtx;
  }, [state.requestedNumCtx]);
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
    activeProviderIdRef.current = state.activeProviderId;
  }, [state.activeProviderId]);
  useEffect(() => {
    yoloRef.current = state.yolo;
  }, [state.yolo]);
  useEffect(() => {
    thinkingEnabledRef.current = state.thinkingEnabled;
  }, [state.thinkingEnabled]);
  useEffect(() => {
    reasoningEffortRef.current = state.reasoningEffort;
  }, [state.reasoningEffort]);
  useEffect(() => {
    compactionModelRef.current = state.compactionModel;
  }, [state.compactionModel]);
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

  // Return a stable container so the same object identity is returned every render.
  // Individual ref objects (created by useRef above) are already stable; only the
  // container wrapper is stabilised here.
  const containerRef = useRef<StableRefs | null>(null);
  if (!containerRef.current) {
    containerRef.current = {
      messagesRef,
      modelRef,
      effectiveNumCtxRef,
      requestedNumCtxRef,
      baseUrlRef,
      sessionIdRef,
      sessionsRef,
      modelsRef,
      providersRef,
      activeProviderIdRef,
      yoloRef,
      thinkingEnabledRef,
      reasoningEffortRef,
      compactionModelRef,
      chatTimeoutMsRef,
      webSearchRef,
      completionModeRef,
      maxPromptLoopIterationsRef,
    };
  }
  return containerRef.current;
}
