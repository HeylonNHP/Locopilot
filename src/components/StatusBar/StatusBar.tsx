'use client';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useChat } from '@/app/lib/chatStore';
import CompletionModeSelector from '@/components/CompletionModeSelector';
import ModelSelector from '@/components/ModelSelector';
import ReasoningEffortSelector from '@/components/ReasoningEffortSelector';

import './StatusBar.scss';

export default function StatusBar() {
  const { state } = useChat();
  const {
    tokenStats,
    model,
    compactionModel,
    messages,
    effectiveNumCtx,
    requestedNumCtx,
    currentTps,
    completionMode,
    maxPromptLoopIterations,
    currentSessionId,
    streamingSessions,
    models,
    modelsLoading,
    reasoningEffort,
    providers,
    activeProviderId,
    modelSwitchPending,
  } = state;
  const [showSelector, setShowSelector] = useState(false);
  const [showCompactionSelector, setShowCompactionSelector] = useState(false);
  const [isDark, setIsDark] = useState(false);
  const modelRef = useRef<HTMLSpanElement>(null);
  const compactionRef = useRef<HTMLSpanElement>(null);
  const modeRef = useRef<HTMLSpanElement>(null);
  const reasoningRef = useRef<HTMLSpanElement>(null);
  const lastClickRef = useRef<{ x: number; y: number } | null>(null);
  const [showModeSelector, setShowModeSelector] = useState(false);
  const [showReasoningSelector, setShowReasoningSelector] = useState(false);

  // Sync isDark with the current data-theme attribute (set by FOUC script or toggle)
  useEffect(() => {
    const { dataset } = document.documentElement;
    setIsDark(dataset.theme === 'dark');
  }, []);

  useEffect(() => {
    if (modelsLoading) {
      setShowSelector(false);
      setShowCompactionSelector(false);
    }
  }, [modelsLoading]);

  const handleOpenSelector = useCallback(
    ({ clientX, clientY }: { clientX: number; clientY: number }) => {
      if (!modelsLoading && models.length > 0 && model) {
        // Snapshot the click coordinates so the dropdown can anchor to the
        // exact point the user clicked, even if the anchor ref re-renders.
        lastClickRef.current = { x: clientX, y: clientY };
        setShowSelector(true);
      }
    },
    [modelsLoading, models.length, model]
  );

  const handleCloseSelector = useCallback(() => {
    setShowSelector(false);
  }, []);

  const handleOpenCompactionSelector = useCallback(
    ({ clientX, clientY }: { clientX: number; clientY: number }) => {
      if (models.length > 0) {
        lastClickRef.current = { x: clientX, y: clientY };
        setShowCompactionSelector(true);
      }
    },
    [models.length]
  );

  const handleCloseCompactionSelector = useCallback(() => {
    setShowCompactionSelector(false);
  }, []);

  const handleOpenModeSelector = useCallback(
    ({ clientX, clientY }: { clientX: number; clientY: number }) => {
      lastClickRef.current = { x: clientX, y: clientY };
      setShowModeSelector(true);
    },
    []
  );

  const handleCloseModeSelector = useCallback(() => {
    setShowModeSelector(false);
  }, []);

  const handleOpenReasoningSelector = useCallback(
    ({ clientX, clientY }: { clientX: number; clientY: number }) => {
      // Both providers support reasoning levels (Ollama via its `think`
      // level, OpenAI-compatible via `reasoning.effort`), so any resolved
      // provider qualifies.
      const activeProvider = providers?.find((p) => p.id === activeProviderId) ?? providers?.[0];
      if (
        activeProvider?.provider === 'ollama' ||
        activeProvider?.provider === 'openai-compatible'
      ) {
        lastClickRef.current = { x: clientX, y: clientY };
        setShowReasoningSelector(true);
      }
    },
    [providers, activeProviderId]
  );

  const handleCloseReasoningSelector = useCallback(() => {
    setShowReasoningSelector(false);
  }, []);

  const handleThemeToggle = useCallback(() => {
    const next = isDark ? 'frutiger-aero' : 'dark';
    document.documentElement.dataset.theme = next;
    // Persist via cookie so the server-rendered <html data-theme=...> matches
    // on the next navigation. localStorage is also kept as a fallback for any
    // client-only reads (none today, but harmless).
    try {
      document.cookie = `locopilot-theme=${next}; path=/; max-age=31536000; SameSite=Lax`;
      localStorage.setItem('locopilot-theme', next);
    } catch {
      /* ignore */
    }
    setIsDark(!isDark);
  }, [isDark]);

  // Use the backend-provided token count. If we haven't received one yet
  // (briefly before the first SSE event) show 0 instead of a local guess.
  const totalTokens = tokenStats?.totalTokens ?? 0;
  // Prefer the per-turn tokenLimit reported by the server (already
  // clamped to the model's cap). Fall back to state.effectiveNumCtx
  // for the brief window before the first SSE event arrives; if
  // that is also null (no server response yet), fall back to the
  // user's requested value as a last resort. We never invent a
  // default like DEFAULT_NUM_CTX here — using the requested value
  // means the percentage is at most 100% even before the server
  // speaks, which is the right display behaviour.
  const tokenLimit = tokenStats?.tokenLimit ?? effectiveNumCtx ?? requestedNumCtx;

  const pct = tokenLimit > 0 ? Math.round((totalTokens / tokenLimit) * 100) : 0;

  let tokenColorClass = 'statusbar-token-green';
  if (pct >= 90) tokenColorClass = 'statusbar-token-red';
  else if (pct >= 75) tokenColorClass = 'statusbar-token-yellow';

  // Mark whether we're showing an estimate or authoritative count.
  // Backend-driven estimates carry isEstimated=true; absent stats mean
  // we haven't heard from the backend yet (briefly before first SSE event).
  const isEstimated = tokenStats?.isEstimated ?? tokenStats === null;
  const sourceLabel = isEstimated ? '(est)' : '';

  // Tokens-per-second display: live rough estimate during streaming,
  // accurate Ollama-calculated value after the turn finishes.
  const tpsValue = currentTps ?? tokenStats?.evalTps ?? tokenStats?.promptTps;
  const tpsLabel = tpsValue === null || tpsValue === undefined ? null : `${tpsValue} t/s`;

  // "Model max" hint. The cap is the GGUF training context for Ollama
  // (or the provider's advertised cap for OpenAI-compatible). When the
  // user has asked for less than the cap, the requested value is
  // already shown in the token display. When the user has asked for
  // more, show a small label so it's clear that the displayed
  // tokenLimit is the model's actual ceiling, not a transient state.
  const modelMax =
    tokenStats?.modelContextLimit ??
    (effectiveNumCtx !== null && effectiveNumCtx < requestedNumCtx ? effectiveNumCtx : null);
  const modelMaxLabel =
    modelMax !== null && modelMax > 0 && modelMax < requestedNumCtx
      ? `(model max: ${modelMax.toLocaleString()})`
      : null;

  const normalizedCompletionMode = (completionMode || 'normal') as string;
  const iterations = maxPromptLoopIterations ?? 4;
  const maxLabel = iterations === 0 ? '∞' : String(iterations);
  const modeLabel =
    normalizedCompletionMode === 'prompt-loop' ? `Prompt loop (${maxLabel})` : 'Normal';

  const reasoningLabel = reasoningEffort.charAt(0).toUpperCase() + reasoningEffort.slice(1);

  return (
    <div className="statusbar">
      {currentSessionId !== null && streamingSessions.has(currentSessionId) && (
        <span className="statusbar-streaming">● Streaming</span>
      )}
      <span className={tokenColorClass}>
        {totalTokens}/{tokenLimit} tokens ({pct}%) {sourceLabel}
        {modelMaxLabel && <span className="statusbar-model-max"> {modelMaxLabel}</span>}
      </span>
      {tpsLabel && <span>{tpsLabel}</span>}
      <span>
        {modelsLoading ? (
          <span
            className="statusbar-model-loading"
            aria-live="polite"
            aria-label="Loading models"
            aria-busy="true"
          >
            <span className="statusbar-model-loading-dot" aria-hidden="true" />
            <span>Loading models…</span>
          </span>
        ) : (
          model && (
            <span
              ref={modelRef}
              className="statusbar-model"
              onClick={handleOpenSelector}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  // Keyboard activation: pass the anchor element's centre
                  // as the click point so the dropdown anchors sensibly.
                  if (modelRef.current) {
                    const rect = modelRef.current.getBoundingClientRect();
                    handleOpenSelector({
                      clientX: rect.left + rect.width / 2,
                      clientY: rect.top,
                    });
                  } else {
                    handleOpenSelector({ clientX: 0, clientY: 0 });
                  }
                }
              }}
            >
              Model: {model}
              {modelSwitchPending && (
                <span className="statusbar-model-switching" title="Applies at the next tool step">
                  {' '}
                  (switching…)
                </span>
              )}
            </span>
          )
        )}
        {model && !modelsLoading && (
          <span
            ref={compactionRef}
            className="statusbar-compaction"
            onClick={handleOpenCompactionSelector}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                if (compactionRef.current) {
                  const rect = compactionRef.current.getBoundingClientRect();
                  handleOpenCompactionSelector({
                    clientX: rect.left + rect.width / 2,
                    clientY: rect.top,
                  });
                } else {
                  handleOpenCompactionSelector({ clientX: 0, clientY: 0 });
                }
              }
            }}
          >
            / {compactionModel || 'Same as main'}
          </span>
        )}
      </span>
      <span>
        <span
          ref={reasoningRef}
          className="statusbar-reasoning"
          onClick={handleOpenReasoningSelector}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              if (reasoningRef.current) {
                const rect = reasoningRef.current.getBoundingClientRect();
                handleOpenReasoningSelector({
                  clientX: rect.left + rect.width / 2,
                  clientY: rect.top,
                });
              } else {
                handleOpenReasoningSelector({ clientX: 0, clientY: 0 });
              }
            }
          }}
        >
          Reasoning: {reasoningLabel}
        </span>
      </span>
      <span>{messages.length} messages</span>
      <span>
        <span
          ref={modeRef}
          className="statusbar-mode"
          onClick={handleOpenModeSelector}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              // Keyboard activation: pass the anchor element's centre
              // as the click point so the dropdown anchors sensibly.
              if (modeRef.current) {
                const rect = modeRef.current.getBoundingClientRect();
                handleOpenModeSelector({
                  clientX: rect.left + rect.width / 2,
                  clientY: rect.top,
                });
              } else {
                handleOpenModeSelector({ clientX: 0, clientY: 0 });
              }
            }
          }}
        >
          Mode: {modeLabel}
        </span>
      </span>

      <ModelSelector
        anchorRef={modelRef}
        lastClickRef={lastClickRef}
        isOpen={showSelector}
        onClose={handleCloseSelector}
      />

      <ModelSelector
        anchorRef={compactionRef}
        lastClickRef={lastClickRef}
        isOpen={showCompactionSelector}
        onClose={handleCloseCompactionSelector}
        mode="compaction"
      />

      <CompletionModeSelector
        anchorRef={modeRef}
        lastClickRef={lastClickRef}
        isOpen={showModeSelector}
        onClose={handleCloseModeSelector}
      />

      <ReasoningEffortSelector
        anchorRef={reasoningRef}
        lastClickRef={lastClickRef}
        isOpen={showReasoningSelector}
        onClose={handleCloseReasoningSelector}
      />

      <button
        className="statusbar-theme-toggle"
        onClick={handleThemeToggle}
        title={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
        aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
      >
        {isDark ? '☀' : '🌙'}
      </button>
    </div>
  );
}
