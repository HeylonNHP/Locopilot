'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { hasLiveTranscript, useChat } from '@/app/lib/chatStore';
import { isStaleNumCtxAnswer, positiveInteger } from '@/app/lib/contextWindow';
import { createLatestGate } from '@/app/lib/latestGate';

import type { StableRefs } from './useStableRefs';

/**
 * Provides stable data-loading helpers for sessions, models, and config.
 *
 * - loadSessions / loadSessionMessages are stable (safe in useCallback deps).
 * - loadModels / loadConfig are called only on mount so they don't need to be stable.
 */
export function useDataLoaders(refs: StableRefs) {
  const { state, dispatch } = useChat();
  // The loader's identity must stay stable (it is in dependency arrays), so
  // it reads the store through a ref rather than closing over `state`.
  const stateRef = useRef(state);
  stateRef.current = state;
  // The order of the user's navigations. Opening a conversation takes a token
  // from it, and so does starting a new chat (`useSessionActions`), so the
  // LAST click wins: a conversation that is still loading when the user
  // clicks something else is stale when it arrives and cannot take the view
  // back.
  const [sessionNavigation] = useState(createLatestGate);
  // View-neutral refreshes (the end-of-turn reload) get their own
  // "latest wins" token, per session. Sharing the session-load token with
  // them would let a background refresh discard the user's own in-flight
  // session switch, and a single shared token would let two background
  // refreshes discard each other.
  const backgroundLoadRequestIdRef = useRef(new Map<number, number>());
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
  /**
   * The token limit already known for a session.
   *
   * The server resolves the effective size (the requested size clamped to
   * the model's ceiling) and reports it on every turn. A reload must not
   * replace that with the user's REQUESTED size: the badge's denominator
   * and the 75 %/90 % thresholds would then be computed against a limit the
   * model does not have.
   *
   * Only server-resolved values are used. The client must not apply the
   * clamp itself (`src/services/capResolver.ts`): a limit derived here from
   * the CURRENT requested size could contradict the turn that actually ran
   * — if the user lowers the context size while a turn is streaming, the
   * denominator would drop below the token count that turn produced.
   *
   * `undefined` means "the server has not told us yet". Callers OMIT the
   * `tokenLimit` key in that case — they never write a stand-in. A stand-in
   * (the requested size, or before the config had loaded the 131 072
   * default) was promoted by the reducer into `effectiveNumCtx` as if the
   * server had reported it, which is how a reloaded session came to show
   * "276922/131072 tokens (211%)" for a 1 000 000-token model.
   */
  const knownTokenLimit = useCallback((sessionId: number): number | undefined => {
    const current = stateRef.current;
    // The window the server last reported for the selected model: it is what
    // the next turn will run in, and it survives a session switch (the
    // top-level token stats do not). It comes first because a session's own
    // snapshot describes the turn that session last ran, which may predate a
    // change of the setting or of the model.
    const effective = current.effectiveNumCtx;
    if (typeof effective === 'number' && effective > 0) {
      return effective;
    }
    const stats =
      sessionId === current.currentSessionId
        ? current.tokenStats
        : current.sessionStates.get(sessionId)?.tokenStats;
    const limit = stats?.tokenLimit;
    return typeof limit === 'number' && limit > 0 ? limit : undefined;
  }, []);

  const loadSessionMessages = useCallback(
    async (
      sessionId: number,
      allowEmptyWhileStreaming = false,
      options?: { keepCurrentSession?: boolean }
    ) => {
      const background = options?.keepCurrentSession === true;
      const requestId = background
        ? (backgroundLoadRequestIdRef.current.get(sessionId) ?? 0) + 1
        : sessionNavigation.begin();
      if (background) {
        backgroundLoadRequestIdRef.current.set(sessionId, requestId);
      }
      // Whether this load is still the one the user is waiting for. A
      // view-neutral refresh has its own token, per session, so it can
      // neither discard the user's in-flight navigation nor be discarded by
      // it, and two background refreshes of different sessions do not
      // invalidate each other.
      const isLatest = () =>
        background
          ? backgroundLoadRequestIdRef.current.get(sessionId) === requestId
          : sessionNavigation.isLatest(requestId);

      // A session that is still streaming already has a live copy on the
      // client — the top-level fields if it is on screen, its slot if it is
      // not — that holds every event of the turn so far. The database only
      // has the steps the server has flushed: reloading would duplicate the
      // reply being typed, hide the tool call still running, and drop
      // whatever streams in while the fetch is in flight. So the view is
      // switched (the token above has already invalidated any older load)
      // and nothing is fetched; the turn's end reloads it from the database.
      //
      // Covers every way in: the sidebar, browser back/forward, and clicking
      // the conversation that is already on screen. The end-of-turn reload
      // is a background load and is never skipped.
      if (!background && hasLiveTranscript(stateRef.current, sessionId)) {
        if (refs.sessionIdRef.current !== sessionId) {
          refs.sessionIdRef.current = sessionId;
          dispatch({ type: 'SET_CURRENT_SESSION', id: sessionId });
        }
        return;
      }

      try {
        const res = await fetch(`/api/sessions/${sessionId}`);
        // Stale check: the user has navigated again (or another load of the
        // same kind has been requested) since this one started.
        if (!isLatest()) return;

        if (!res.ok) {
          // Session was deleted (e.g. in another tab). Only clear if the
          // user hasn't already moved on to a different session — the
          // caller's earlier click on session B will have updated
          // refs.sessionIdRef.current, so this guard prevents the A 404
          // from clobbering B's state.
          //
          // A view-neutral refresh never changes the view: it is a
          // background reconciliation, and clearing the session the user is
          // reading (and the error banner with it) is the caller's call.
          if (!background && res.status === 404 && refs.sessionIdRef.current === sessionId) {
            refs.sessionIdRef.current = null;
            dispatch({ type: 'SET_CURRENT_SESSION', id: null });
            dispatch({ type: 'CLEAR_MESSAGES' });
          }
          return;
        }
        const data = await res.json();
        if (!isLatest()) return;

        // Commit the session change now that we have data. The caller
        // typically already dispatched SET_CURRENT_SESSION optimistically,
        // so this is usually a no-op; the guard avoids a redundant dispatch.
        //
        // `keepCurrentSession` skips it entirely: reloading a session that
        // finished in the background must not pull the user back to it.
        if (!options?.keepCurrentSession && refs.sessionIdRef.current !== sessionId) {
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
        // The window is the server's: `loadNumCtx` fetches it and every
        // turn's status event refreshes it (both land in
        // state.effectiveNumCtx through SET_TOKEN_STATS).
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
          // The COUNT comes from the database; the limit is only carried
          // over when the server has already reported one. Otherwise the
          // `tokenLimit` key is left out of the merge (never written as 0 or
          // as the user's setting) and the status bar derives the window
          // from the setting and the model maximum — see contextWindow.ts.
          const knownLimit = knownTokenLimit(sessionId);
          dispatch({
            type: 'SET_TOKEN_STATS',
            stats: {
              promptEvalCount: explicitStats.promptEvalCount,
              evalCount: explicitStats.evalCount,
              totalTokens: explicitStats.totalTokens,
              ...(knownLimit === undefined ? {} : { tokenLimit: knownLimit }),
              isEstimated: false,
            },
            targetSessionId: sessionId,
          });
        } else if (hasSessionStats) {
          const knownLimit = knownTokenLimit(sessionId);
          dispatch({
            type: 'SET_TOKEN_STATS',
            stats: {
              promptEvalCount: sessionStats.last_prompt_eval_count,
              evalCount: sessionStats.last_eval_count,
              totalTokens: sessionStats.last_total_tokens,
              ...(knownLimit === undefined ? {} : { tokenLimit: knownLimit }),
              isEstimated: false,
            },
            targetSessionId: sessionId,
          });
        } else if (data.estimatedTokens !== null && data.estimatedTokens !== undefined) {
          const knownLimit = knownTokenLimit(sessionId);
          dispatch({
            type: 'SET_TOKEN_STATS',
            stats: {
              promptEvalCount: 0,
              evalCount: data.estimatedTokens,
              totalTokens: data.estimatedTokens,
              ...(knownLimit === undefined ? {} : { tokenLimit: knownLimit }),
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
    [dispatch, knownTokenLimit, sessionNavigation]
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

  /**
   * Ask the server for the context window of the model that is selected now
   * and store what it says: the window it will use, and the model's maximum
   * (null when it does not know one). Nothing is computed here.
   *
   * Stable (it is in the dependency array of the effect that calls it). The
   * answer is dropped when the selection changed while it was in flight, or
   * when it fails — the display then keeps showing "—" rather than a guess.
   * The dispatch seeds ONLY the cap fields and never touches the token count,
   * which `loadSessionMessages` and the chat stream own.
   */
  const loadNumCtx = useCallback(async (): Promise<void> => {
    const model = refs.modelRef.current;
    if (!model) {
      return;
    }
    const providerId = refs.activeProviderIdRef.current;
    const params = new URLSearchParams({ model });
    if (providerId) {
      params.set('providerId', providerId);
    }
    try {
      const res = await fetch(`/api/numctx?${params.toString()}`);
      if (!res.ok) {
        console.warn(`The context window could not be loaded (HTTP ${res.status}).`);
        return;
      }
      const data = await res.json();
      if (
        isStaleNumCtxAnswer(
          { model, providerId },
          { model: refs.modelRef.current, providerId: refs.activeProviderIdRef.current }
        )
      ) {
        return;
      }
      const effective = positiveInteger(data.effective);
      dispatch({
        type: 'SET_TOKEN_STATS',
        stats: {
          ...(effective === null ? {} : { tokenLimit: effective }),
          modelContextLimit: positiveInteger(data.modelMax),
        },
      });
    } catch (err) {
      console.warn('The context window could not be loaded:', err);
    }
  }, [dispatch, refs]);

  // Called only on mount — no stability guarantee needed.
  const loadConfig = async () => {
    try {
      const res = await fetch('/api/config');
      if (!res.ok) {
        console.warn(
          `Config could not be loaded (HTTP ${res.status}); the context window stays unknown until it loads.`
        );
      }
      if (res.ok) {
        const data = await res.json();
        const config = data.config ?? data;
        // The persisted context size, or null. There is no stand-in: when
        // the config carries none, `requestedNumCtx` stays `null` (shown as
        // "—", omitted from request bodies) rather than being re-asserted
        // from the mount-time `state` closure, which could be a default.
        const persistedNumCtx = positiveInteger(config.numCtx);
        dispatch({
          type: 'SET_CONFIG',
          config: {
            providers: config.providers ?? state.providers,
            activeProviderId: config.activeProviderId ?? state.activeProviderId,
            ...(persistedNumCtx === null ? {} : { requestedNumCtx: persistedNumCtx }),
            model: config.model || config.lastModel || refs.modelRef.current,
            yolo: config.yolo ?? state.yolo,
            thinkingEnabled: config.thinkingEnabled ?? state.thinkingEnabled,
            reasoningEffort: config.reasoningEffort ?? state.reasoningEffort,
            compactionReasoningEffort:
              config.compactionReasoningEffort ?? state.compactionReasoningEffort,
            promptTimestamps: config.promptTimestamps ?? state.promptTimestamps,
            citeSources: config.citeSources ?? state.citeSources,
            redactSecrets: config.redactSecrets ?? state.redactSecrets,
            compactionModel: config.compactionModel ?? state.compactionModel,
            chatTimeoutMs: config.chatTimeoutMs ?? state.chatTimeoutMs,
            webSearch: config.webSearch ?? state.webSearch,
            completionMode: config.completionMode ?? state.completionMode,
            maxPromptLoopIterations:
              config.maxPromptLoopIterations ?? state.maxPromptLoopIterations,
          },
        });
      }
    } catch (err) {
      console.warn('Config could not be loaded:', err);
    }
  };

  return {
    loadSessions,
    loadSessionMessages,
    loadModels,
    loadConfig,
    loadNumCtx,
    sessionNavigation,
  };
}
