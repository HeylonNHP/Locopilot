'use client';

import { useRef, useEffect } from 'react';
import type { MutableRefObject } from 'react';
import type { ChatMessage, LLmModel, WebSearchConfig } from '@/app/lib/chatStore';

/**
 * A stable container of refs that mirror the most recently rendered state values.
 * Used to avoid stale closures inside SSE callbacks and async handlers.
 */
export interface StableRefs {
  messagesRef: MutableRefObject<ChatMessage[]>;
  modelRef: MutableRefObject<string>;
  numCtxRef: MutableRefObject<number>;
  baseUrlRef: MutableRefObject<string>;
  sessionIdRef: MutableRefObject<number | null>;
  modelsRef: MutableRefObject<LLmModel[]>;
  yoloRef: MutableRefObject<boolean>;
  thinkingEnabledRef: MutableRefObject<boolean>;
  compactionModelRef: MutableRefObject<string>;
  chatTimeoutMsRef: MutableRefObject<number>;
  webSearchRef: MutableRefObject<WebSearchConfig>;
}

interface StableRefsInput {
  messages: ChatMessage[];
  model: string;
  numCtx: number;
  baseUrl: string;
  currentSessionId: number | null;
  models: LLmModel[];
  yolo: boolean;
  thinkingEnabled: boolean;
  compactionModel: string;
  chatTimeoutMs: number;
  webSearch: WebSearchConfig;
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
  const modelsRef = useRef(state.models);
  const yoloRef = useRef(state.yolo);
  const thinkingEnabledRef = useRef(state.thinkingEnabled);
  const compactionModelRef = useRef(state.compactionModel);
  const chatTimeoutMsRef = useRef(state.chatTimeoutMs);
  const webSearchRef = useRef(state.webSearch);

  useEffect(() => { messagesRef.current = state.messages; }, [state.messages]);
  useEffect(() => { modelRef.current = state.model; }, [state.model]);
  useEffect(() => { numCtxRef.current = state.numCtx; }, [state.numCtx]);
  useEffect(() => { baseUrlRef.current = state.baseUrl; }, [state.baseUrl]);
  useEffect(() => { sessionIdRef.current = state.currentSessionId; }, [state.currentSessionId]);
  useEffect(() => { modelsRef.current = state.models; }, [state.models]);
  useEffect(() => { yoloRef.current = state.yolo; }, [state.yolo]);
  useEffect(() => { thinkingEnabledRef.current = state.thinkingEnabled; }, [state.thinkingEnabled]);
  useEffect(() => { compactionModelRef.current = state.compactionModel; }, [state.compactionModel]);
  useEffect(() => { chatTimeoutMsRef.current = state.chatTimeoutMs; }, [state.chatTimeoutMs]);
  useEffect(() => { webSearchRef.current = state.webSearch; }, [state.webSearch]);

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
      modelsRef,
      yoloRef,
      thinkingEnabledRef,
      compactionModelRef,
      chatTimeoutMsRef,
      webSearchRef,
    };
  }
  return containerRef.current;
}
