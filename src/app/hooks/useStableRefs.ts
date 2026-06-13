'use client';

import { useRef, useEffect } from 'react';
import type { ChatMessage, LLmModel, Session, WebSearchConfig } from '@/app/lib/chatStore';
import type { CompletionMode } from '@/types/chatConfig';

/** A mutable ref container (the writable counterpart to React 19's read-only RefObject). */
export type WritableRef<T> = { current: T };

/**
 * A stable container of refs that mirror the most recently rendered state values.
 * Used to avoid stale closures inside SSE callbacks and async handlers.
 */
export interface StableRefs {
  messagesRef: WritableRef<ChatMessage[]>;
  modelRef: WritableRef<string>;
  numCtxRef: WritableRef<number>;
  baseUrlRef: WritableRef<string>;
  sessionIdRef: WritableRef<number | null>;
  sessionsRef: WritableRef<Session[]>;
  modelsRef: WritableRef<LLmModel[]>;
  yoloRef: WritableRef<boolean>;
  thinkingEnabledRef: WritableRef<boolean>;
  compactionModelRef: WritableRef<string>;
  chatTimeoutMsRef: WritableRef<number>;
  webSearchRef: WritableRef<WebSearchConfig>;
  completionModeRef: WritableRef<CompletionMode>;
  maxPromptLoopIterationsRef: WritableRef<number>;
}

interface StableRefsInput {
  messages: ChatMessage[];
  model: string;
  numCtx: number;
  baseUrl: string;
  currentSessionId: number | null;
  sessions: Session[];
  models: LLmModel[];
  yolo: boolean;
  thinkingEnabled: boolean;
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
  const numCtxRef = useRef(state.numCtx);
  const baseUrlRef = useRef(state.baseUrl);
  const sessionIdRef = useRef(state.currentSessionId);
  const sessionsRef = useRef(state.sessions);
  const modelsRef = useRef(state.models);
  const yoloRef = useRef(state.yolo);
  const thinkingEnabledRef = useRef(state.thinkingEnabled);
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

  useEffect(() => { messagesRef.current = state.messages; }, [state.messages]);
  useEffect(() => { modelRef.current = state.model; }, [state.model]);
  useEffect(() => { numCtxRef.current = state.numCtx; }, [state.numCtx]);
  useEffect(() => { baseUrlRef.current = state.baseUrl; }, [state.baseUrl]);
  useEffect(() => { sessionsRef.current = state.sessions; }, [state.sessions]);
  useEffect(() => { modelsRef.current = state.models; }, [state.models]);
  useEffect(() => { yoloRef.current = state.yolo; }, [state.yolo]);
  useEffect(() => { thinkingEnabledRef.current = state.thinkingEnabled; }, [state.thinkingEnabled]);
  useEffect(() => { compactionModelRef.current = state.compactionModel; }, [state.compactionModel]);
  useEffect(() => { chatTimeoutMsRef.current = state.chatTimeoutMs; }, [state.chatTimeoutMs]);
  useEffect(() => { webSearchRef.current = state.webSearch; }, [state.webSearch]);
  useEffect(() => { completionModeRef.current = state.completionMode; }, [state.completionMode]);
  useEffect(() => { maxPromptLoopIterationsRef.current = state.maxPromptLoopIterations; }, [state.maxPromptLoopIterations]);


  // Return a stable container so the same object identity is returned every render.
  // Individual ref objects (created by useRef above) are already stable; only the
  // container wrapper is stabilised here.
  const containerRef = useRef<StableRefs | null>(null);
  if (!containerRef.current) {
    containerRef.current = {
      messagesRef,
      modelRef,
      numCtxRef,
      baseUrlRef,
      sessionIdRef,
      sessionsRef,
      modelsRef,
      yoloRef,
      thinkingEnabledRef,
      compactionModelRef,
      chatTimeoutMsRef,
      webSearchRef,
      completionModeRef,
      maxPromptLoopIterationsRef,
    };
  }
  return containerRef.current;
}
