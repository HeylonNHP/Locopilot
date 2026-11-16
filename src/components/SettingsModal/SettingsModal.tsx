'use client';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { useModalOverlay } from '@/app/hooks/useModalOverlay';
import { useChat } from '@/app/lib/chatStore';
import { describeContextWindow, interpretNumCtxInput } from '@/app/lib/contextWindow';
import { saveSessionPatch } from '@/app/lib/sessionSelectionClient';
import { requestMidTurnModelSwitch } from '@/app/lib/switchModelClient';
import { timeoutPartsToMs } from '@/app/lib/timeoutParts';
import { DEFAULT_OLLAMA_CHAT_TIMEOUT_MS, DEFAULT_WEB_SEARCH_REQUEST_TIMEOUT_MS } from '@/constants';
import {
  compactionSelectionEquals,
  compactionSelectionForModel,
  compactionSelectionToPair,
  type SessionSelectionPatch,
} from '@/services/sessionSelection';
import {
  REASONING_EFFORT_LABELS,
  REASONING_EFFORTS,
  type ReasoningEffort,
} from '@/types/chatConfig';

import ProviderSection from './ProviderSection';

import './SettingsModal.scss';

/**
 * The dropdown value that means "inherit the default compaction model".
 * The empty string already means "same as the main model", so the two
 * choices need two values.
 */
const INHERIT_COMPACTION_VALUE = '__inherit__';

interface Props {
  onClose: () => void;
}

export default function SettingsModal({ onClose }: Props) {
  const { state, dispatch, abortControllersRef } = useChat();
  const [model, setModel] = useState(state.model);
  // Empty until the config has loaded — there is no stand-in value. The field
  // follows the config's arrival only while the user has not edited it, so a
  // late-arriving config neither leaves it blank nor overwrites what they typed.
  const [numCtx, setNumCtx] = useState(
    state.requestedNumCtx === null ? '' : String(state.requestedNumCtx)
  );
  const [numCtxEdited, setNumCtxEdited] = useState(false);
  useEffect(() => {
    if (!numCtxEdited && state.requestedNumCtx !== null) {
      setNumCtx(String(state.requestedNumCtx));
    }
  }, [numCtxEdited, state.requestedNumCtx]);
  const [yolo, setYolo] = useState(state.yolo);
  const [thinkingEnabled, setThinkingEnabled] = useState(state.thinkingEnabled);
  // The GLOBAL default a new conversation starts with. The per-conversation
  // levels are edited from the StatusBar popover; this dropdown deliberately
  // does not move the conversation that happens to be open.
  const [reasoningEffort, setReasoningEffort] = useState(state.defaultReasoningEffort);
  // Only a field the user actually changed is written, so an unrelated save
  // cannot move the default another tab just set.
  const [reasoningEffortEdited, setReasoningEffortEdited] = useState(false);
  useEffect(() => {
    if (!reasoningEffortEdited) setReasoningEffort(state.defaultReasoningEffort);
  }, [reasoningEffortEdited, state.defaultReasoningEffort]);
  const [promptTimestamps, setPromptTimestamps] = useState(state.promptTimestamps ?? true);
  const [citeSources, setCiteSources] = useState(state.citeSources ?? true);
  const [redactSecrets, setRedactSecrets] = useState(state.redactSecrets ?? true);
  // The conversation's own compaction selection — ONE value. The two local
  // fields below are its loose projection (a model name and a provider id),
  // because the dropdown needs both; what is WRITTEN is the union, so the
  // pair can never be split.
  const [compactionModel, setCompactionModel] = useState<string | null>(
    compactionSelectionToPair(state.compaction).model
  );
  // Which of the two selection fields the user actually touched. Only a
  // field the user changed moves the global default a new conversation
  // starts with; saving the modal must not quietly repoint the default at
  // the model of the conversation that happens to be open.
  const [modelEdited, setModelEdited] = useState(false);
  const [compactionModelEdited, setCompactionModelEdited] = useState(false);
  // The provider that owns the selected main model / compaction model. These
  // are tracked separately so the user can run the main chat on one provider
  // and compaction on a different one. The compaction provider is part of the
  // compaction PAIR: it pins the conversation's own row and, when the user
  // picked a concrete compaction model, the global default pair in
  // config.json as well — a compaction model named without its provider is
  // what sent a cloud model to the wrong endpoint and came back 404.
  const [mainProviderId, setMainProviderId] = useState<string | null>(state.activeProviderId);
  const [compactionProviderId, setCompactionProviderId] = useState<string | null>(
    compactionSelectionToPair(state.compaction).providerId
  );
  const totalSeconds = Math.floor((state.chatTimeoutMs ?? DEFAULT_OLLAMA_CHAT_TIMEOUT_MS) / 1000);
  const [chatTimeoutHours, setChatTimeoutHours] = useState(String(Math.floor(totalSeconds / 3600)));
  const [chatTimeoutMinutes, setChatTimeoutMinutes] = useState(
    String(Math.floor((totalSeconds % 3600) / 60))
  );
  const [chatTimeoutSeconds, setChatTimeoutSeconds] = useState(String(totalSeconds % 60));
  const [webMaxQueries, setWebMaxQueries] = useState(String(state.webSearch?.maxQueries ?? 3));
  const [webResultsPerQuery, setWebResultsPerQuery] = useState(
    String(state.webSearch?.resultsPerQuery ?? 3)
  );
  const [webPerPageCharLimit, setWebPerPageCharLimit] = useState(
    String(state.webSearch?.perPageCharLimit ?? 5000)
  );
  const webRequestTimeoutSeconds = Math.floor(
    (state.webSearch?.requestTimeoutMs ?? DEFAULT_WEB_SEARCH_REQUEST_TIMEOUT_MS) / 1000
  );
  const [webTimeoutHours, setWebTimeoutHours] = useState(
    String(Math.floor(webRequestTimeoutSeconds / 3600))
  );
  const [webTimeoutMinutes, setWebTimeoutMinutes] = useState(
    String(Math.floor((webRequestTimeoutSeconds % 3600) / 60))
  );
  const [webTimeoutSeconds, setWebTimeoutSeconds] = useState(String(webRequestTimeoutSeconds % 60));
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const titleId = useId();
  const firstFieldRef = useRef<HTMLSelectElement>(null);
  const [isMounted, setIsMounted] = useState(false);
  useEffect(() => {
    setIsMounted(true);
  }, []);
  const handleDismiss = useCallback(() => {
    if (!isSaving) onClose();
  }, [isSaving, onClose]);
  const panelRef = useModalOverlay<HTMLDivElement>({
    onClose: handleDismiss,
    initialFocusRef: firstFieldRef,
    enabled: isMounted,
  });

  // The legacy `state.provider` field only tracks the original single-provider
  // config and is never updated when the user picks a different provider via
  // the multi-provider model selector. Resolve the active provider from
  // `providers[]` + `activeProviderId` so the Reasoning Effort dropdown (and any
  // future per-provider UI) gates on the actually-selected provider, not the
  // stale top-level field.
  const activeProvider =
    state.providers?.find((p) => p.id === state.activeProviderId) ?? state.providers?.[0];
  // Gate the Reasoning Effort dropdown on the actually-selected provider only.
  // The old `|| state.provider === 'openai-compatible'` clause leaked the stale
  // legacy top-level `provider` field, showing the dropdown for the wrong
  // (e.g. Ollama) provider in migrated multi-provider configs.
  const isOpenAICompatible = activeProvider?.provider === 'openai-compatible';
  const isOllama = activeProvider?.provider === 'ollama';
  // Both providers now support reasoning levels: OpenAI-compatible maps to
  // `reasoning_effort`, Ollama maps to its `think` level field.
  const supportsReasoningEffort = isOpenAICompatible || isOllama;

  // Group the (already provider-aggregated) model list by provider so each
  // dropdown can carry `providerId::modelName` composite values. This lets the
  // user pick a distinct provider for the main model vs. the compaction model,
  // and fixes the duplicate React keys caused by the old flat `key={m.name}`
  // list when two providers expose the same model name.
  const groupedModels = useMemo(() => {
    const map = new Map<string, Array<(typeof state.models)[number]>>();
    for (const m of state.models ?? []) {
      const key = m.providerName || m.providerId || 'Unknown';
      const list = map.get(key);
      if (list) {
        list.push(m);
      } else {
        map.set(key, [m]);
      }
    }
    return [...map.entries()];
  }, [state.models]);

  const renderModelOptions = () =>
    groupedModels.map(([providerName, ms]) => (
      <optgroup key={providerName} label={providerName}>
        {ms.map((m) => (
          <option
            key={`${m.providerId}::${m.name}`}
            value={`${m.providerId}::${m.name}`}
            title={m.displayName ?? m.name}
          >
            {m.displayName ?? m.name}
          </option>
        ))}
      </optgroup>
    ));

  const selectedMainValue = (() => {
    if (!model) return '';
    if (
      mainProviderId &&
      (state.models ?? []).some((m) => m.providerId === mainProviderId && m.name === model)
    ) {
      return `${mainProviderId}::${model}`;
    }
    // Fall back to the first provider that offers this model name so a stale
    // or legacy selection still renders (and saves) against a real provider.
    const match = (state.models ?? []).find((m) => m.name === model);
    return match ? `${match.providerId}::${match.name}` : '';
  })();

  const selectedCompactionValue = (() => {
    // `null` is the conversation's own "inherit the default" state; the
    // empty string is "same as the main model". They are different choices,
    // so the dropdown tells them apart.
    if (compactionModel === null) return INHERIT_COMPACTION_VALUE;
    if (!compactionModel) return '';
    if (
      compactionProviderId &&
      (state.models ?? []).some(
        (m) => m.providerId === compactionProviderId && m.name === compactionModel
      )
    ) {
      return `${compactionProviderId}::${compactionModel}`;
    }
    const match = (state.models ?? []).find((m) => m.name === compactionModel);
    return match ? `${match.providerId}::${match.name}` : '';
  })();

  const handleMainModelChange = (value: string) => {
    setModelEdited(true);
    if (!value) {
      setModel('');
      setMainProviderId(null);
      return;
    }
    const idx = value.indexOf('::');
    const providerId = idx === -1 ? value : value.slice(0, idx);
    const name = idx === -1 ? value : value.slice(idx + 2);
    setModel(name);
    setMainProviderId(providerId);
  };

  const handleCompactionModelChange = (value: string) => {
    setCompactionModelEdited(true);
    if (value === INHERIT_COMPACTION_VALUE) {
      setCompactionModel(null);
      setCompactionProviderId(null);
      return;
    }
    if (!value) {
      setCompactionModel('');
      setCompactionProviderId(null);
      return;
    }
    const idx = value.indexOf('::');
    const providerId = idx === -1 ? value : value.slice(0, idx);
    const name = idx === -1 ? value : value.slice(idx + 2);
    setCompactionModel(name);
    setCompactionProviderId(providerId);
  };

  // A provider was just added (it is already saved, and its models fetched).
  // Select its default model when it listed one and nothing is chosen yet, so
  // the dropdown starts on something usable; otherwise the user picks from the
  // new provider's group.
  const handleProviderAdded = (providerId: string, addedModel: string | undefined) => {
    if (addedModel !== undefined && model === '') {
      setModelEdited(true);
      setModel(addedModel);
      setMainProviderId(providerId);
    }
  };

  const handleSave = async () => {
    setSaveError(null);

    // A blank or malformed context size is an error to fix, not a value to
    // guess: it used to become the 131 072 default and be saved into
    // config.json. Nothing is sent for it either way.
    const numCtxInput = interpretNumCtxInput(numCtx, state.requestedNumCtx);
    if (numCtxInput.kind === 'invalid') {
      setSaveError('Context size must be a whole number greater than 0.');
      return;
    }

    setIsSaving(true);
    // The conversation's own compaction selection, as ONE value. A named
    // model with no provider of its own cannot be pinned — the model says
    // nothing about which endpoint serves it — so the save is refused rather
    // than storing half a pair.
    const pickedCompaction = compactionModelEdited
      ? compactionSelectionForModel(compactionModel, compactionProviderId)
      : state.compaction;
    if (pickedCompaction === null) {
      setSaveError(
        'That compaction model does not name a provider. Pick a model of a configured provider.'
      );
      setIsSaving(false);
      return;
    }
    const parsedHours = Number.parseInt(chatTimeoutHours) || 0;
    const parsedMinutes = Number.parseInt(chatTimeoutMinutes) || 0;
    const parsedSeconds = Number.parseInt(chatTimeoutSeconds) || 0;
    const totalTimeoutSeconds = parsedHours * 3600 + parsedMinutes * 60 + parsedSeconds;
    const parsedChatTimeoutMs = totalTimeoutSeconds * 1000;
    const parsedWebMaxQueries = Number.parseInt(webMaxQueries) || 3;
    const parsedWebResultsPerQuery = Number.parseInt(webResultsPerQuery) || 3;
    const parsedWebPerPageCharLimit = Number.parseInt(webPerPageCharLimit) || 5000;
    // An empty or zero duration falls back to the default, matching the other
    // web-search fields. Upper bound is enforced server-side.
    const parsedWebRequestTimeoutMs =
      timeoutPartsToMs(webTimeoutHours, webTimeoutMinutes, webTimeoutSeconds) ||
      DEFAULT_WEB_SEARCH_REQUEST_TIMEOUT_MS;

    // The cap is now the server's responsibility. We only include
    // numCtx in the PUT body when the user actually changed it in
    // this modal session; otherwise we omit it so two tabs racing on
    // save don't clobber each other's setting. (If the user just
    // edited, say, the chat timeout, sending the unchanged numCtx
    // back would be a no-op write that could still overwrite a value
    // another tab had just persisted.)
    const clientConfig: Record<string, unknown> = {
      yolo,
      thinkingEnabled,
      promptTimestamps,
      citeSources,
      redactSecrets,
      chatTimeoutMs: parsedChatTimeoutMs,
      webSearch: {
        maxQueries: parsedWebMaxQueries,
        resultsPerQuery: parsedWebResultsPerQuery,
        perPageCharLimit: parsedWebPerPageCharLimit,
        requestTimeoutMs: parsedWebRequestTimeoutMs,
      },
      // The global defaults. Only the fields the user edited are sent, so a
      // save of an unrelated setting does not re-assert a default another
      // tab has changed.
      ...(modelEdited && model.trim().length > 0
        ? { model, ...(mainProviderId ? { activeProviderId: mainProviderId } : {}) }
        : {}),
      // The GLOBAL compaction pair travels together: a compaction model
      // named without its provider would run on whatever provider the main
      // chat uses — the wrong endpoint that produced the 404s.
      //
      // "Use the default" (`null`) leaves the global pair ALONE: the
      // conversation inherits what the global default already is, so there
      // is nothing to write (and writing our stale copy would clobber a
      // default another tab has just changed). "Same as the main model"
      // (`''`) clears the provider, because the pair then means "the main
      // model on the main provider".
      ...(compactionModelEdited && compactionModel !== null
        ? {
            compactionModel,
            compactionProviderId: compactionProviderId ?? null,
          }
        : {}),
      ...(reasoningEffortEdited ? { reasoningEffort } : {}),
    };
    if (numCtxInput.kind === 'set') {
      clientConfig.numCtx = numCtxInput.value;
    }

    try {
      // The model selection belongs to the conversation on screen. Only the
      // field the user actually changed is written, so this modal cannot
      // erase a value another control or tab just set.
      const selectionPatch: SessionSelectionPatch = {
        ...(modelEdited && model.trim().length > 0 ? { model, providerId: mainProviderId } : {}),
        ...(compactionModelEdited ? { compaction: pickedCompaction } : {}),
      };
      // A conversation always has a model: the "Select a model..." option
      // cannot leave one without, so the conversation's own row is not
      // written. The DEFAULTS are still saved (in `clientConfig`), so an
      // edit of the compaction model is not lost and the rest of the modal
      // saves.
      if (model.trim().length > 0 && Object.keys(selectionPatch).length > 0) {
        const selectionSaved = await saveSessionPatch(state.currentSessionId, selectionPatch);
        if (!selectionSaved) {
          throw new Error('The model could not be saved for this conversation.');
        }
      }

      const response = await fetch('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(clientConfig),
      });

      if (!response.ok) {
        const responseText = await response.text();
        let message = `Failed to save config (${response.status})`;

        if (responseText) {
          try {
            const payload = JSON.parse(responseText) as { error?: unknown };
            if (typeof payload.error === 'string' && payload.error.trim()) {
              message = payload.error.trim();
            } else if (responseText.trim()) {
              message = responseText.trim();
            }
          } catch {
            if (responseText.trim()) {
              message = responseText.trim();
            }
          }
        }

        throw new Error(message);
      }

      // The server is the source of truth. Mirror the values it just
      // confirmed into the local store so subsequent reads (status
      // bar, model picker, modal reopens) reflect the new config
      // without a second /api/config fetch.
      dispatch({
        type: 'SET_CONFIG',
        config: {
          yolo,
          thinkingEnabled,
          // The GLOBAL default; the conversation on screen keeps its own
          // level.
          ...(reasoningEffortEdited ? { defaultReasoningEffort: reasoningEffort } : {}),
          // The global half of the compaction pair, mirrored from what was
          // just saved. "Use the default" leaves it alone (nothing was
          // written), so neither field is carried.
          ...(compactionModelEdited && compactionModel !== null
            ? {
                defaultCompactionModel: compactionModel,
                defaultCompactionProviderId: compactionProviderId ?? null,
              }
            : {}),
          promptTimestamps,
          citeSources,
          redactSecrets,
          chatTimeoutMs: parsedChatTimeoutMs,
          webSearch: {
            maxQueries: parsedWebMaxQueries,
            resultsPerQuery: parsedWebResultsPerQuery,
            perPageCharLimit: parsedWebPerPageCharLimit,
            requestTimeoutMs: parsedWebRequestTimeoutMs,
          },
          ...(numCtxInput.kind === 'set' ? { requestedNumCtx: numCtxInput.value } : {}),
        },
      });

      // The conversation on screen now runs on the selection that was just
      // saved; the global default follows the fields the user changed.
      if (model.trim().length > 0) {
        dispatch({
          type: 'SET_SESSION_SELECTION',
          selection: {
            model,
            providerId: mainProviderId,
            // The conversation's own compaction selection — ONE value.
            compaction: pickedCompaction,
            // The conversation's reasoning pins are untouched by this modal.
            reasoningEffort: state.reasoningEffort,
            compactionReasoningEffort: state.compactionReasoningEffort,
          },
          defaults: {
            model: modelEdited ? model : state.defaultModel,
            providerId: modelEdited ? mainProviderId : state.defaultProviderId,
            compactionModel: compactionModelEdited
              ? (compactionModel ?? state.defaultCompactionModel)
              : state.defaultCompactionModel,
            // The global provider follows the global model. "Use the default"
            // leaves the global pair alone; a concrete pick (or "same as the
            // main model") writes its provider along with its model.
            compactionProviderId: compactionModelEdited
              ? compactionModel === null
                ? state.defaultCompactionProviderId
                : (compactionProviderId ?? null)
              : state.defaultCompactionProviderId,
            reasoningEffort: reasoningEffortEdited ? reasoningEffort : state.defaultReasoningEffort,
            compactionReasoningEffort: state.defaultCompactionReasoningEffort,
          },
        });
      }

      // Carry a model change into a turn that is already streaming, so the
      // running turn (and its sub-agents) switch at their next tool step
      // rather than only the next turn. Mirrors the ModelSelector path.
      const streamingSessionId =
        state.currentSessionId !== null && state.streamingSessions.has(state.currentSessionId)
          ? state.currentSessionId
          : null;
      const modelChanged = model !== state.model;
      // A provider-only switch (same model name on a different
      // provider) must also be carried into a streaming turn, so the
      // running turn re-derives activeProvider / llmRequestContext /
      // numCtx / vision / sampling at its next tool step instead of
      // silently continuing to send requests to the stale provider.
      const providerChanged = mainProviderId !== state.activeProviderId;
      const compactionChanged = !compactionSelectionEquals(pickedCompaction, state.compaction);
      // The compaction selection travels as ONE value, so a switch can no
      // longer leave half a pair behind — the model and the provider that
      // serves it are always switched together.
      //
      // "Use the default" is still NOT carried: the running turn keeps the
      // compaction it has resolved until the next turn sends the resolved one.
      const compactionSwitch =
        pickedCompaction.kind === 'inherit-default' ? undefined : pickedCompaction;
      if (
        streamingSessionId !== null &&
        (modelChanged || providerChanged || compactionChanged)
      ) {
        dispatch({
          type: 'SET_MODEL_SWITCH_PENDING',
          sessionId: streamingSessionId,
          pending: true,
        });
        // providerId rides along whenever either the model or the
        // provider changed — not just modelChanged — so a pure
        // provider-only switch reaches the server. (The server's
        // /api/chat/switch-model already accepts providerId
        // independently of model.)
        const sendProviderId =
          (modelChanged || providerChanged) && mainProviderId ? mainProviderId : undefined;
        const accepted = await requestMidTurnModelSwitch(
          streamingSessionId,
          {
            ...(modelChanged ? { model } : {}),
            ...(sendProviderId ? { providerId: sendProviderId } : {}),
            ...(compactionChanged && compactionSwitch ? { compaction: compactionSwitch } : {}),
          },
          // Attach to the running turn's signal — looked up per session
          // from the shared abort map, so it is the SAME controller the
          // Stop button aborts. A Stop click while the switch request is in
          // flight cancels it client-side and lets the route's
          // `unregisterActiveTurn` clean the server-side
          // `pendingSwitches[sessionId]` entry.
          abortControllersRef.current.get(streamingSessionId)?.signal
        );
        if (!accepted) {
          dispatch({
            type: 'SET_MODEL_SWITCH_PENDING',
            sessionId: streamingSessionId,
            pending: false,
          });
        }
      }

      onClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to save config.';
      setSaveError(message);
    } finally {
      setIsSaving(false);
    }
  };

  if (!isMounted) return null;

  return createPortal(
    <div
      className="settings-overlay"
      onClick={(e) => {
        if (!isSaving && e.target === e.currentTarget) handleDismiss();
      }}
    >
      <div
        ref={panelRef}
        className="settings-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={isSaving || undefined}
      >
        <div className="settings-scroll">
          <h3 id={titleId} className="settings-heading">
            Settings
          </h3>

          <ProviderSection onProviderAdded={handleProviderAdded} />

          <div className="settings-grid">
            <div className="settings-row">
              <label className="settings-label" htmlFor="settings-model">
                Model
              </label>
              <select
                id="settings-model"
                ref={firstFieldRef}
                value={selectedMainValue}
                onChange={(e) => handleMainModelChange(e.target.value)}
                className="settings-input"
              >
                <option value="">Select a model...</option>
                {renderModelOptions()}
              </select>
            </div>

            <div className="settings-row">
              <label className="settings-label" htmlFor="settings-compaction-model">
                Compaction Model
              </label>
              <select
                id="settings-compaction-model"
                value={selectedCompactionValue}
                onChange={(e) => handleCompactionModelChange(e.target.value)}
                className="settings-input"
              >
                <option value={INHERIT_COMPACTION_VALUE}>Use the default</option>
                <option value="">Same as main model</option>
                {renderModelOptions()}
              </select>
            </div>
          </div>

          <div className="settings-grid">
            <div className="settings-row">
              <label className="settings-label" htmlFor="settings-context-size">
                Context Size
              </label>
              <input
                id="settings-context-size"
                type="number"
                value={numCtx}
                onChange={(e) => {
                  setNumCtxEdited(true);
                  setNumCtx(e.target.value);
                }}
                placeholder={state.requestedNumCtx === null ? 'Loading…' : undefined}
                className="settings-input"
              />
            </div>

            {(() => {
              // What the SERVER reports for the selected model: the window it
              // will use, and whether the model's maximum limits it. The row
              // is shown when the maximum is the limit, or when the server
              // does not know the maximum; before it has answered the user
              // sees only their own setting. Nothing is worked out here.
              const { limit, cappedAt, maxUnknown } = describeContextWindow({
                effective: state.effectiveNumCtx,
                modelMax: state.modelMaxNumCtx,
              });
              if (limit === null || (cappedAt === null && !maxUnknown)) return <div />;
              return (
                <div className="settings-row">
                  <span className="settings-label">Effective Context Size</span>
                  <span
                    className="settings-input text-secondary"
                    style={{ display: 'inline-flex', alignItems: 'center' }}
                  >
                    {cappedAt === null
                      ? `${limit.toLocaleString()} (model max unknown)`
                      : `${cappedAt.toLocaleString()} (capped by model limit)`}
                  </span>
                </div>
              );
            })()}
          </div>

          <div className="settings-grid">
            <div className="settings-row">
              <span className="settings-label">Execution Mode</span>
              <div className="flex items-center gap-12">
                <input
                  id="yolo-toggle"
                  type="checkbox"
                  checked={yolo}
                  onChange={(e) => setYolo(e.target.checked)}
                />
                <label htmlFor="yolo-toggle" className="font-14 text-primary">
                  {yolo ? 'YOLO (Automatic execution)' : 'Standard (Confirm commands)'}
                </label>
              </div>
            </div>

            {isOllama && (
              <div className="settings-row">
                <span className="settings-label">Thinking</span>
                <div className="flex items-center gap-12">
                  <input
                    id="thinking-toggle"
                    type="checkbox"
                    checked={thinkingEnabled}
                    onChange={(e) => setThinkingEnabled(e.target.checked)}
                  />
                  <label htmlFor="thinking-toggle" className="font-14 text-primary">
                    {thinkingEnabled ? 'Enabled' : 'Disabled'}
                  </label>
                </div>
              </div>
            )}

            {supportsReasoningEffort && (
              <div className="settings-row">
                <label className="settings-label" htmlFor="reasoning-effort-select">
                  Reasoning Effort (new chats)
                </label>
                <select
                  id="reasoning-effort-select"
                  value={reasoningEffort}
                  onChange={(e) => {
                    setReasoningEffortEdited(true);
                    setReasoningEffort(e.target.value as ReasoningEffort);
                  }}
                  className="settings-input"
                >
                  {REASONING_EFFORTS.map((value) => (
                    <option key={value} value={value}>
                      {REASONING_EFFORT_LABELS[value]}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          <div className="settings-row">
            <span className="settings-label">Prompt Timestamps</span>
            <div className="flex flex-col gap-4">
              <div className="flex items-center gap-12">
                <input
                  id="prompt-timestamps-toggle"
                  type="checkbox"
                  checked={promptTimestamps}
                  onChange={(e) => setPromptTimestamps(e.target.checked)}
                />
                <label htmlFor="prompt-timestamps-toggle" className="font-14 text-primary">
                  {promptTimestamps ? 'Sent to the model' : 'Hidden from the model'}
                </label>
              </div>
              <span className="font-12 text-secondary">
                Adds a [Sent YYYY-MM-DD HH:MM] header to each prompt the LLM sees. The wall-clock
                time of every message is always recorded, so toggling this back on later reveals the
                date for past messages.
              </span>
            </div>
          </div>

          <div className="settings-row">
            <span className="settings-label">Cite Web Sources</span>
            <div className="flex flex-col gap-4">
              <div className="flex items-center gap-12">
                <input
                  id="cite-sources-toggle"
                  type="checkbox"
                  checked={citeSources}
                  onChange={(e) => setCiteSources(e.target.checked)}
                />
                <label htmlFor="cite-sources-toggle" className="font-14 text-primary">
                  {citeSources ? 'On' : 'Off'}
                </label>
              </div>
              <span className="font-12 text-secondary">
                After web research (web_search / fetch_url), the model must cite its sources as
                numbered links with a Sources list at the end of its answer. The numbered source
                list is always shown to the model; this toggle controls whether it is instructed to
                cite them.
              </span>
            </div>
          </div>

          <div className="settings-row">
            <span className="settings-label">Redact Secrets in Command Output</span>
            <div className="flex flex-col gap-4">
              <div className="flex items-center gap-12">
                <input
                  id="redact-secrets-toggle"
                  type="checkbox"
                  checked={redactSecrets}
                  onChange={(e) => setRedactSecrets(e.target.checked)}
                />
                <label htmlFor="redact-secrets-toggle" className="font-14 text-primary">
                  {redactSecrets ? 'On (redacted)' : 'Off (raw output)'}
                </label>
              </div>
              <span className="font-12 text-secondary">
                Command output is scanned for tokens, keys and passwords and replaced with
                [REDACTED] before the model, the transcript or the browser see it. Turn this off for
                verbatim output, with local models or when a false positive mangles what you need.
                The text is also saved in this conversation's history. Terminal escape codes are
                always stripped.
              </span>
            </div>
          </div>

          <div className="settings-row">
            <span className="settings-label">Chat Timeout</span>
            <div className="flex items-center gap-12">
              <input
                type="number"
                min="0"
                aria-label="Timeout hours"
                value={chatTimeoutHours}
                onChange={(e) => setChatTimeoutHours(e.target.value)}
                className="settings-input"
                style={{ width: '80px' }}
              />
              <span className="font-14 text-primary">hours</span>
              <input
                type="number"
                min="0"
                max="59"
                aria-label="Timeout minutes"
                value={chatTimeoutMinutes}
                onChange={(e) => setChatTimeoutMinutes(e.target.value)}
                className="settings-input"
                style={{ width: '80px' }}
              />
              <span className="font-14 text-primary">minutes</span>
              <input
                type="number"
                min="0"
                max="59"
                aria-label="Timeout seconds"
                value={chatTimeoutSeconds}
                onChange={(e) => setChatTimeoutSeconds(e.target.value)}
                className="settings-input"
                style={{ width: '80px' }}
              />
              <span className="font-14 text-primary">seconds</span>
            </div>
          </div>

          <div className="settings-grid">
            <div className="settings-row">
              <label className="settings-label" htmlFor="settings-web-max-queries">
                Web Search: Max Queries
              </label>
              <input
                id="settings-web-max-queries"
                type="number"
                value={webMaxQueries}
                onChange={(e) => setWebMaxQueries(e.target.value)}
                className="settings-input"
              />
            </div>

            <div className="settings-row">
              <label className="settings-label" htmlFor="settings-web-results-per-query">
                Web Search: Results Per Query
              </label>
              <input
                id="settings-web-results-per-query"
                type="number"
                value={webResultsPerQuery}
                onChange={(e) => setWebResultsPerQuery(e.target.value)}
                className="settings-input"
              />
            </div>
          </div>

          <div className="settings-row">
            <label className="settings-label" htmlFor="settings-web-page-char-limit">
              Web Search: Page Char Limit (0 = unlimited)
            </label>
            <input
              id="settings-web-page-char-limit"
              type="number"
              value={webPerPageCharLimit}
              onChange={(e) => setWebPerPageCharLimit(e.target.value)}
              className="settings-input"
            />
          </div>

          <div className="settings-row">
            <label className="settings-label">Web Search: Compaction Timeout</label>
            <div className="flex flex-col gap-4">
              <div className="flex items-center gap-12">
                <input
                  type="number"
                  min="0"
                  value={webTimeoutHours}
                  onChange={(e) => setWebTimeoutHours(e.target.value)}
                  className="settings-input"
                  style={{ width: '80px' }}
                />
                <span className="font-14 text-primary">hours</span>
                <input
                  type="number"
                  min="0"
                  max="59"
                  value={webTimeoutMinutes}
                  onChange={(e) => setWebTimeoutMinutes(e.target.value)}
                  className="settings-input"
                  style={{ width: '80px' }}
                />
                <span className="font-14 text-primary">minutes</span>
                <input
                  type="number"
                  min="0"
                  max="59"
                  value={webTimeoutSeconds}
                  onChange={(e) => setWebTimeoutSeconds(e.target.value)}
                  className="settings-input"
                  style={{ width: '80px' }}
                />
                <span className="font-14 text-primary">seconds</span>
              </div>
              <span className="font-12 text-secondary">
                Maximum time allowed for each LLM call that compacts a fetched web page to the page
                char limit. Defaults to 60 seconds. Increase it if slow compaction models time out
                on large pages.
              </span>
            </div>
          </div>
          {saveError && (
            <div className="settings-error" role="alert">
              {saveError}
            </div>
          )}

          <div className="settings-actions">
            <button onClick={onClose} disabled={isSaving} className="settings-btn-cancel">
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={isSaving}
              className={`settings-btn-save ${
                isSaving ? 'settings-btn-save-disabled' : 'settings-btn-save-active'
              }`}
            >
              {isSaving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
