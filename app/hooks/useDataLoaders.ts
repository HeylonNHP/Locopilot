'use client';

import { useRef, useCallback } from 'react';
import { useChat } from '@/app/lib/chatStore';
import type { StableRefs } from './useStableRefs';

/**
 * Provides stable data-loading helpers for sessions, models, and config.
 *
 * - loadSessions / loadSessionMessages are stable (safe in useCallback deps).
 * - loadModels / loadConfig are called only on mount so they don't need to be stable.
 */
export function useDataLoaders(refs: StableRefs) {
  const { state, dispatch } = useChat();
  const sessionLoadRequestIdRef = useRef(0);

  const loadSessions = useCallback(async () => {
    try {
      const res = await fetch('/api/sessions');
      if (res.ok) {
        const data = await res.json();
        dispatch({ type: 'SET_SESSIONS', sessions: data.sessions ?? [] });
      }
    } catch {
      // Silently ignore – sessions will be empty
    }
  }, [dispatch]);

  // Optimistic selection: mark the session immediately and discard stale responses.
  const loadSessionMessages = useCallback(async (sessionId: number) => {
    const requestId = sessionLoadRequestIdRef.current + 1;
    sessionLoadRequestIdRef.current = requestId;
    dispatch({ type: 'SET_CURRENT_SESSION', id: sessionId });

    try {
      const res = await fetch(`/api/sessions/${sessionId}`);
      if (!res.ok || sessionLoadRequestIdRef.current !== requestId) return;
      const data = await res.json();
      if (sessionLoadRequestIdRef.current !== requestId) return;
      if (data.messages) dispatch({ type: 'SET_MESSAGES', messages: data.messages });
    } catch {
      // Silently ignore
    }
  }, [dispatch]);

  // Called only on mount — no stability guarantee needed.
  const loadModels = async () => {
    try {
      const res = await fetch('/api/models');
      if (res.ok) {
        const data = await res.json();
        const models = data.models ?? data ?? [];
        const modelList = Array.isArray(models) ? models : [];
        dispatch({ type: 'SET_MODELS', models: modelList });
        if (!refs.modelRef.current && modelList.length > 0) {
          const firstModel = typeof modelList[0] === 'string' ? modelList[0] : (modelList[0].name ?? '');
          if (firstModel) dispatch({ type: 'SET_MODEL', model: firstModel });
        }
      }
    } catch {
      // Silently ignore – models will be empty
    }
  };

  // Called only on mount — no stability guarantee needed.
  const loadConfig = async () => {
    try {
      const res = await fetch('/api/config');
      if (res.ok) {
        const data = await res.json();
        const config = data.config ?? data;
        dispatch({
          type: 'SET_CONFIG',
          config: {
            baseUrl: config.baseUrl ?? state.baseUrl,
            numCtx: config.numCtx ?? state.numCtx,
            model: config.model || config.lastModel || refs.modelRef.current,
            yolo: config.yolo ?? state.yolo,
            thinkingEnabled: config.thinkingEnabled ?? state.thinkingEnabled,
            compactionModel: config.compactionModel ?? state.compactionModel,
            chatTimeoutMs: config.chatTimeoutMs ?? state.chatTimeoutMs,
            webSearch: config.webSearch ?? state.webSearch,
          },
        });
      }
    } catch {
      // Silently ignore
    }
  };

  return { loadSessions, loadSessionMessages, loadModels, loadConfig };
}
