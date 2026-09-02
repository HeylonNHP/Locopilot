'use client';
import { useMemo, useState } from 'react';

import { useChat } from '@/app/lib/chatStore';
import { requestMidTurnModelSwitch } from '@/app/lib/switchModelClient';
import { DEFAULT_NUM_CTX, DEFAULT_OLLAMA_CHAT_TIMEOUT_MS } from '@/constants';
import {
  REASONING_EFFORT_LABELS,
  REASONING_EFFORTS,
  type ReasoningEffort,
} from '@/types/chatConfig';

import './SettingsModal.scss';

interface Props {
  onClose: () => void;
}

export default function SettingsModal({ onClose }: Props) {
  const { state, dispatch } = useChat();
  const [model, setModel] = useState(state.model);
  const [numCtx, setNumCtx] = useState(String(state.requestedNumCtx));
  const [yolo, setYolo] = useState(state.yolo);
  const [thinkingEnabled, setThinkingEnabled] = useState(state.thinkingEnabled);
  const [reasoningEffort, setReasoningEffort] = useState(state.reasoningEffort);
  const [promptTimestamps, setPromptTimestamps] = useState(state.promptTimestamps ?? true);
  const [citeSources, setCiteSources] = useState(state.citeSources ?? true);
  const [compactionModel, setCompactionModel] = useState(state.compactionModel || '');
  // The provider that owns the selected main model / compaction model. These
  // are tracked separately so the user can run the main chat on one provider
  // and compaction on a different one. `compactionProviderId` is transient
  // (in-memory + request body, not persisted to config.json), mirroring the
  // ModelSelector contract.
  const [mainProviderId, setMainProviderId] = useState<string | null>(state.activeProviderId);
  const [compactionProviderId, setCompactionProviderId] = useState<string | null>(
    state.compactionProviderId
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
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

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

  const handleSave = async () => {
    setSaveError(null);
    setIsSaving(true);

    const parsedNumCtx = Number.parseInt(numCtx) || DEFAULT_NUM_CTX;
    const parsedHours = Number.parseInt(chatTimeoutHours) || 0;
    const parsedMinutes = Number.parseInt(chatTimeoutMinutes) || 0;
    const parsedSeconds = Number.parseInt(chatTimeoutSeconds) || 0;
    const totalTimeoutSeconds = parsedHours * 3600 + parsedMinutes * 60 + parsedSeconds;
    const parsedChatTimeoutMs = totalTimeoutSeconds * 1000;
    const parsedWebMaxQueries = Number.parseInt(webMaxQueries) || 3;
    const parsedWebResultsPerQuery = Number.parseInt(webResultsPerQuery) || 3;
    const parsedWebPerPageCharLimit = Number.parseInt(webPerPageCharLimit) || 5000;

    // The cap is now the server's responsibility. We only include
    // numCtx in the PUT body when the user actually changed it in
    // this modal session; otherwise we omit it so two tabs racing on
    // save don't clobber each other's setting. (If the user just
    // edited, say, the chat timeout, sending the unchanged numCtx
    // back would be a no-op write that could still overwrite a value
    // another tab had just persisted.)
    const numCtxChanged = parsedNumCtx !== state.requestedNumCtx;
    const clientConfig: Record<string, unknown> = {
      model,
      // Persist the selected model's provider so the next request is sent to
      // the right endpoint/credentials. Omitting it (the old behaviour) let a
      // model that belongs to a non-active provider be saved against a stale
      // activeProviderId, sending the turn to the wrong provider.
      ...(mainProviderId ? { activeProviderId: mainProviderId } : {}),
      yolo,
      thinkingEnabled,
      reasoningEffort,
      promptTimestamps,
      citeSources,
      compactionModel,
      chatTimeoutMs: parsedChatTimeoutMs,
      webSearch: {
        maxQueries: parsedWebMaxQueries,
        resultsPerQuery: parsedWebResultsPerQuery,
        perPageCharLimit: parsedWebPerPageCharLimit,
      },
    };
    if (numCtxChanged) {
      clientConfig.numCtx = parsedNumCtx;
    }

    try {
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
          model,
          yolo,
          thinkingEnabled,
          reasoningEffort,
          promptTimestamps,
          citeSources,
          compactionModel,
          // Transient: captured here so the compaction route can resolve the
          // compaction provider even when it differs from the main model's.
          compactionProviderId,
          chatTimeoutMs: parsedChatTimeoutMs,
          webSearch: {
            maxQueries: parsedWebMaxQueries,
            resultsPerQuery: parsedWebResultsPerQuery,
            perPageCharLimit: parsedWebPerPageCharLimit,
          },
          ...(numCtxChanged ? { requestedNumCtx: parsedNumCtx } : {}),
        },
      });

      // Sync the chosen main-model provider into the store (mirrors the
      // ModelSelector main-model branch).
      if (mainProviderId) {
        dispatch({ type: 'SET_ACTIVE_PROVIDER', providerId: mainProviderId });
      }

      // Carry a model change into a turn that is already streaming, so the
      // running turn (and its sub-agents) switch at their next tool step
      // rather than only the next turn. Mirrors the ModelSelector path.
      const streamingSessionId =
        state.currentSessionId !== null && state.streamingSessions.has(state.currentSessionId)
          ? state.currentSessionId
          : null;
      const modelChanged = model !== state.model;
      const compactionChanged = compactionModel !== state.compactionModel;
      if (streamingSessionId !== null && (modelChanged || compactionChanged)) {
        dispatch({ type: 'SET_CONFIG', config: { modelSwitchPending: true } });
        const accepted = await requestMidTurnModelSwitch(streamingSessionId, {
          ...(modelChanged ? { model } : {}),
          ...(modelChanged && mainProviderId ? { providerId: mainProviderId } : {}),
          ...(compactionChanged ? { compactionModel } : {}),
          ...(compactionChanged && compactionProviderId ? { compactionProviderId } : {}),
        });
        if (!accepted) {
          dispatch({ type: 'SET_CONFIG', config: { modelSwitchPending: false } });
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

  return (
    <div
      className="settings-overlay"
      onClick={(e) => {
        if (!isSaving && e.target === e.currentTarget) onClose();
      }}
    >
      <div className="settings-panel">
        <div className="settings-scroll">
          <h3 className="settings-heading">Settings</h3>

          {saveError && (
            <div className="settings-error" role="alert">
              {saveError}
            </div>
          )}

          <div className="settings-grid">
            <div className="settings-row">
              <label className="settings-label">Model</label>
              <select
                value={selectedMainValue}
                onChange={(e) => handleMainModelChange(e.target.value)}
                className="settings-input"
              >
                <option value="">Select a model...</option>
                {renderModelOptions()}
              </select>
            </div>

            <div className="settings-row">
              <label className="settings-label">Compaction Model</label>
              <select
                value={selectedCompactionValue}
                onChange={(e) => handleCompactionModelChange(e.target.value)}
                className="settings-input"
              >
                <option value="">Same as main model</option>
                {renderModelOptions()}
              </select>
            </div>
          </div>

          <div className="settings-grid">
            <div className="settings-row">
              <label className="settings-label">Context Size</label>
              <input
                type="number"
                value={numCtx}
                onChange={(e) => setNumCtx(e.target.value)}
                className="settings-input"
              />
            </div>

            {(() => {
              // Show the "Effective Context Size" row only when the
              // server has reported a real cap that is smaller than
              // the user's requested value. Before the first chat
              // turn (or if the server could not resolve a cap),
              // `tokenStats.modelContextLimit` is null and we hide
              // the row entirely — the user only sees their
              // requested value. Comparing
              // state.effectiveNumCtx to state.requestedNumCtx
              // would conflate the pre-response default with a
              // genuine cap, which is the bug this row guards
              // against.
              const reportedCap = state.tokenStats?.modelContextLimit;
              const isCapped =
                typeof reportedCap === 'number' &&
                Number.isFinite(reportedCap) &&
                reportedCap > 0 &&
                reportedCap < state.requestedNumCtx;
              if (!isCapped) return <div />;
              return (
                <div className="settings-row">
                  <label className="settings-label">Effective Context Size</label>
                  <span
                    className="settings-input text-secondary"
                    style={{ display: 'inline-flex', alignItems: 'center' }}
                  >
                    {reportedCap.toLocaleString()} (capped by model limit)
                  </span>
                </div>
              );
            })()}
          </div>

          <div className="settings-grid">
            <div className="settings-row">
              <label className="settings-label">Execution Mode</label>
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
                <label className="settings-label">Thinking</label>
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
                  Reasoning Effort
                </label>
                <select
                  id="reasoning-effort-select"
                  value={reasoningEffort}
                  onChange={(e) => setReasoningEffort(e.target.value as ReasoningEffort)}
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
            <label className="settings-label">Prompt Timestamps</label>
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
            <label className="settings-label">Cite Web Sources</label>
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
                list is always shown to the model; this toggle controls whether it is instructed
                to cite them.
              </span>
            </div>
          </div>

          <div className="settings-row">
            <label className="settings-label">Chat Timeout</label>
            <div className="flex items-center gap-12">
              <input
                type="number"
                min="0"
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
              <label className="settings-label">Web Search: Max Queries</label>
              <input
                type="number"
                value={webMaxQueries}
                onChange={(e) => setWebMaxQueries(e.target.value)}
                className="settings-input"
              />
            </div>

            <div className="settings-row">
              <label className="settings-label">Web Search: Results Per Query</label>
              <input
                type="number"
                value={webResultsPerQuery}
                onChange={(e) => setWebResultsPerQuery(e.target.value)}
                className="settings-input"
              />
            </div>
          </div>

          <div className="settings-row">
            <label className="settings-label">Web Search: Page Char Limit (0 = unlimited)</label>
            <input
              type="number"
              value={webPerPageCharLimit}
              onChange={(e) => setWebPerPageCharLimit(e.target.value)}
              className="settings-input"
            />
          </div>

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
    </div>
  );
}
