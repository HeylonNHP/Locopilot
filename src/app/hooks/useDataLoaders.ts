'use client';

import { useCallback, useRef } from 'react';

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
  const sessionSearchRequestIdRef = useRef(0);

  const loadSessions = useCallback(
    async (query?: string) => {
      const requestId = sessionSearchRequestIdRef.current + 1;
      sessionSearchRequestIdRef.current = requestId;

      try {
        const url = query ? `/api/sessions?q=${encodeURIComponent(query)}` : '/api/sessions';
        const res = await fetch(url);
        if (!res.ok || sessionSearchRequestIdRef.current !== requestId) return;
        const data = await res.json();
        if (sessionSearchRequestIdRef.current !== requestId) return;
        dispatch({ type: 'SET_SESSIONS', sessions: data.sessions ?? [] });
      } catch (err) {
        console.error('Failed to load sessions:', err);
      }
    },
    [dispatch]
  );

  /**
   * Fetches the model's actual context limit from Ollama and applies the clamp.
   */
  const loadModelContextLimit = async (modelName: string) => {
    try {
      const res = await fetch(`/api/models/${encodeURIComponent(modelName)}/info`);
      if (res.ok) {
        const data = await res.json();
        dispatch({ type: 'SET_MODEL_CONTEXT_LIMIT', limit: data.contextLimit ?? null });
      }
    } catch {
      // Silently ignore – model context limit will remain null
    }
  };

  // Session selection is committed AFTER the fetch resolves so a 404 from a
  // previously-selected session can't wipe a more recently-loaded session's
  // messages (the user rapidly clicked A then B; if A returns 404 after B
  // succeeds, the old code would dispatch SET_CURRENT_SESSION(null) +
  // CLEAR_MESSAGES and clobber B's state). The caller (useSessionActions /
  // useSessionUrlParam) is expected to have already optimistically updated
  // refs.sessionIdRef.current to sessionId so guard checks see the right
  // value during the in-flight request.
  const loadSessionMessages = useCallback(
    async (sessionId: number) => {
      const requestId = sessionLoadRequestIdRef.current + 1;
      sessionLoadRequestIdRef.current = requestId;

      try {
        const res = await fetch(`/api/sessions/${sessionId}`);
        // Stale check: another load has been requested since this one started.
        if (sessionLoadRequestIdRef.current !== requestId) return;

        if (!res.ok) {
          // Session was deleted (e.g. in another tab). Only clear if the
          // user hasn't already moved on to a different session — the
          // caller's earlier click on session B will have updated
          // refs.sessionIdRef.current, so this guard prevents the A 404
          // from clobbering B's state.
          if (res.status === 404 && refs.sessionIdRef.current === sessionId) {
            refs.sessionIdRef.current = null;
            dispatch({ type: 'SET_CURRENT_SESSION', id: null });
            dispatch({ type: 'CLEAR_MESSAGES' });
          }
          return;
        }
        const data = await res.json();
        if (sessionLoadRequestIdRef.current !== requestId) return;

        // Commit the session change now that we have data. The caller
        // typically already dispatched SET_CURRENT_SESSION optimistically,
        // so this is usually a no-op; the guard avoids a redundant dispatch.
        if (refs.sessionIdRef.current !== sessionId) {
          refs.sessionIdRef.current = sessionId;
          dispatch({ type: 'SET_CURRENT_SESSION', id: sessionId });
        }

        if (data.messages?.length > 0) {
          dispatch({ type: 'SET_MESSAGES', messages: data.messages, targetSessionId: sessionId });
        }
        if (data.session?.model) {
          await loadModelContextLimit(data.session.model);
          // The outer requestId check above already gated entry to this
          // branch, so a second re-check after the await is unnecessary.
        }
        if (data.estimatedTokens !== null && data.estimatedTokens !== undefined) {
          dispatch({
            type: 'SET_TOKEN_STATS',
            stats: {
              promptEvalCount: 0,
              evalCount: data.estimatedTokens,
              totalTokens: data.estimatedTokens,
              tokenLimit: refs.numCtxRef.current,
              isEstimated: true,
            },
            targetSessionId: sessionId,
          });
        } else if (
          data.session?.last_total_tokens &&
          data.session?.last_prompt_eval_count !== undefined &&
          data.session?.last_eval_count !== undefined
        ) {
          // Use the session's own persisted context limit if available, otherwise
          // fall back to the currently-displayed one. This prevents restored
          // sessions from showing wrong percentages after model/context switches.
          const tokenLimit = data.session.num_ctx ?? refs.numCtxRef.current;
          dispatch({
            type: 'SET_TOKEN_STATS',
            stats: {
              promptEvalCount: data.session.last_prompt_eval_count ?? 0,
              evalCount: data.session.last_eval_count ?? 0,
              totalTokens: data.session.last_total_tokens ?? 0,
              tokenLimit,
            },
            targetSessionId: sessionId,
          });
        } else {
          dispatch({ type: 'CLEAR_TOKEN_STATS' });
        }
      } catch {
        // Silently ignore
      }
    },
    [dispatch]
  );

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
          const firstModel =
            typeof modelList[0] === 'string' ? modelList[0] : (modelList[0].name ?? '');
          if (firstModel) {
            dispatch({ type: 'SET_MODEL', model: firstModel });
            await loadModelContextLimit(firstModel);
          }
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
            promptTimestamps: config.promptTimestamps ?? state.promptTimestamps,
            compactionModel: config.compactionModel ?? state.compactionModel,
            chatTimeoutMs: config.chatTimeoutMs ?? state.chatTimeoutMs,
            webSearch: config.webSearch ?? state.webSearch,
            completionMode: config.completionMode ?? state.completionMode,
            maxPromptLoopIterations:
              config.maxPromptLoopIterations ?? state.maxPromptLoopIterations,
          },
        });
        // Fetch and apply model context limit after config is loaded
        const modelName = config.model || config.lastModel || refs.modelRef.current;
        if (modelName) {
          await loadModelContextLimit(modelName);
        }
      }
    } catch {
      // Silently ignore
    }
  };

  return { loadSessions, loadSessionMessages, loadModels, loadConfig };
}
