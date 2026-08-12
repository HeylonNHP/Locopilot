'use client';

import { useCallback, useEffect, useRef } from 'react';

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

  // Session selection is committed AFTER the fetch resolves so a 404 from a
  // previously-selected session can't wipe a more recently-loaded session's
  // messages (the user rapidly clicked A then B; if A returns 404 after B
  // succeeds, the old code would dispatch SET_CURRENT_SESSION(null) +
  // CLEAR_MESSAGES and clobber B's state). The caller (useSessionActions /
  // useSessionUrlParam) is expected to have already optimistically updated
  // refs.sessionIdRef.current to sessionId so guard checks see the right
  // value during the in-flight request.
  const loadSessionMessages = useCallback(
    async (sessionId: number, allowEmptyWhileStreaming = false) => {
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

        if (Array.isArray(data.messages)) {
          dispatch({
            type: 'SET_MESSAGES',
            messages: data.messages,
            targetSessionId: sessionId,
            ...(allowEmptyWhileStreaming ? { allowEmptyWhileStreaming: true } : {}),
          });
        }
        // Cap discovery is server-driven; the chat route's first
        // status event on the next turn will populate
        // state.effectiveNumCtx via SET_TOKEN_STATS. Until then, the
        // status bar uses the user's requested value as the
        // tokenLimit display, with the actual cap resolution
        // happening on the server.
        // Prefer actual provider token stats persisted on the session;
        // only fall back to the heuristic estimate when no real stats exist.
        const explicitStats = data.lastTokenStats;
        const hasExplicitStats =
          explicitStats &&
          explicitStats.totalTokens !== undefined &&
          explicitStats.totalTokens !== null &&
          explicitStats.promptEvalCount !== undefined &&
          explicitStats.promptEvalCount !== null &&
          explicitStats.evalCount !== undefined &&
          explicitStats.evalCount !== null;

        const sessionStats = data.session;
        const hasSessionStats =
          sessionStats &&
          sessionStats.last_total_tokens !== undefined &&
          sessionStats.last_total_tokens !== null &&
          sessionStats.last_prompt_eval_count !== undefined &&
          sessionStats.last_prompt_eval_count !== null &&
          sessionStats.last_eval_count !== undefined &&
          sessionStats.last_eval_count !== null;

        if (hasExplicitStats) {
          // Until the next chat turn's status event arrives, display
          // the user's requested value as the tokenLimit. The
          // chat route's `resolveEffectiveNumCtx` will re-resolve the
          // real cap on the next request and emit it via SSE.
          const tokenLimit = refs.requestedNumCtxRef.current;
          dispatch({
            type: 'SET_TOKEN_STATS',
            stats: {
              promptEvalCount: explicitStats.promptEvalCount,
              evalCount: explicitStats.evalCount,
              totalTokens: explicitStats.totalTokens,
              tokenLimit,
              isEstimated: false,
            },
            targetSessionId: sessionId,
          });
        } else if (hasSessionStats) {
          const tokenLimit = refs.requestedNumCtxRef.current;
          dispatch({
            type: 'SET_TOKEN_STATS',
            stats: {
              promptEvalCount: sessionStats.last_prompt_eval_count,
              evalCount: sessionStats.last_eval_count,
              totalTokens: sessionStats.last_total_tokens,
              tokenLimit,
              isEstimated: false,
            },
            targetSessionId: sessionId,
          });
        } else if (data.estimatedTokens !== null && data.estimatedTokens !== undefined) {
          dispatch({
            type: 'SET_TOKEN_STATS',
            stats: {
              promptEvalCount: 0,
              evalCount: data.estimatedTokens,
              totalTokens: data.estimatedTokens,
              tokenLimit: refs.requestedNumCtxRef.current,
              isEstimated: true,
            },
            targetSessionId: sessionId,
          });
        } else {
          dispatch({ type: 'CLEAR_TOKEN_STATS', targetSessionId: sessionId });
        }
      } catch {
        // Silently ignore
      }
    },
    [dispatch]
  );

  // Called only on mount — no stability guarantee needed. Populates the
  // model list only; selecting a default model / active provider is the
  // reconciler effect's job (see below), so it stays correct regardless of
  // whether /api/models or /api/config resolves first.
  const loadModels = async () => {
    dispatch({ type: 'SET_MODELS_LOADING', modelsLoading: true });
    try {
      const res = await fetch('/api/models');
      if (res.ok) {
        const data = await res.json();
        const models = data.models ?? data ?? [];
        const modelList = Array.isArray(models) ? models : [];
        dispatch({ type: 'SET_MODELS', models: modelList });
      }
    } catch {
      // Silently ignore – models will be empty
    } finally {
      dispatch({ type: 'SET_MODELS_LOADING', modelsLoading: false });
    }
  };

  // Reconcile the active provider against the loaded model list. This runs
  // reactively (keyed on state, not refs) so it converges correctly no matter
  // which mount fetch finishes first:
  //   - No model selected yet → adopt the first model and its provider.
  //   - Model selected but no active provider (e.g. a legacy config migrated
  //     with `model` but no `activeProviderId`) → derive the provider from
  //     the selected model so the next turn uses the right credentials.
  useEffect(() => {
    if (state.models.length === 0) return;
    if (!state.model) {
      const first = state.models[0];
      if (first?.name) {
        dispatch({ type: 'SET_MODEL', model: first.name });
        if (first.providerId) {
          dispatch({ type: 'SET_ACTIVE_PROVIDER', providerId: first.providerId });
        }
      }
      return;
    }
    const selectedModelMatchesProvider = state.models.some(
      (m) => m.name === state.model && m.providerId === state.activeProviderId
    );
    if (!selectedModelMatchesProvider) {
      const match = state.models.find((m) => m.name === state.model && m.providerId);
      if (match?.providerId && match.providerId !== state.activeProviderId) {
        dispatch({ type: 'SET_ACTIVE_PROVIDER', providerId: match.providerId });
      }
    }
  }, [state.models, state.model, state.activeProviderId, dispatch]);

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
            providers: config.providers ?? state.providers,
            activeProviderId: config.activeProviderId ?? state.activeProviderId,
            requestedNumCtx: config.numCtx ?? state.requestedNumCtx,
            model: config.model || config.lastModel || refs.modelRef.current,
            yolo: config.yolo ?? state.yolo,
            thinkingEnabled: config.thinkingEnabled ?? state.thinkingEnabled,
            reasoningEffort: config.reasoningEffort ?? state.reasoningEffort,
            compactionReasoningEffort:
              config.compactionReasoningEffort ?? state.compactionReasoningEffort,
            promptTimestamps: config.promptTimestamps ?? state.promptTimestamps,
            compactionModel: config.compactionModel ?? state.compactionModel,
            chatTimeoutMs: config.chatTimeoutMs ?? state.chatTimeoutMs,
            webSearch: config.webSearch ?? state.webSearch,
            completionMode: config.completionMode ?? state.completionMode,
            maxPromptLoopIterations:
              config.maxPromptLoopIterations ?? state.maxPromptLoopIterations,
          },
        });
        // The server also returns the cap for the persisted default
        // model (best-effort; null when unresolved). Seed
        // tokenStats with it so the Settings modal can show
        // "capped by model limit" before the first chat turn. We
        // only seed when we have a real cap; if the server
        // reports null, leave tokenStats alone.
        //
        // This dispatch seeds ONLY the cap-related fields and must
        // not touch the count (totalTokens / promptEvalCount /
        // evalCount): the count is owned by `loadSessionMessages`
        // (for restored sessions) and the chat stream's SSE
        // `status` events (for live turns). The reducer's merge
        // ({...base, ...action.stats}) would otherwise clobber
        // whichever count was set first when both this and
        // `loadSessionMessages` fire concurrently on mount — making
        // restored sessions show `0 tokens` in the status bar
        // until the first prompt overrides the count.
        const reportedCap = data.modelContextLimit;
        if (typeof reportedCap === 'number' && Number.isFinite(reportedCap) && reportedCap > 0) {
          dispatch({
            type: 'SET_TOKEN_STATS',
            stats: {
              tokenLimit: Math.min(config.numCtx ?? state.requestedNumCtx, reportedCap),
              modelContextLimit: reportedCap,
            },
          });
        }
      }
    } catch {
      // Silently ignore
    }
  };

  return { loadSessions, loadSessionMessages, loadModels, loadConfig };
}
