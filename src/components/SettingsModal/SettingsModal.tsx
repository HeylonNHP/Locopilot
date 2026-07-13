'use client';
import { useState } from 'react';

import type { ReasoningEffort } from '@/types/chatConfig';

import { useChat } from '@/app/lib/chatStore';
import { DEFAULT_NUM_CTX, DEFAULT_OLLAMA_CHAT_TIMEOUT_MS } from '@/constants';

import './SettingsModal.scss';

interface Props {
  onClose: () => void;
}

export default function SettingsModal({ onClose }: Props) {
  const { state } = useChat();
  const [model, setModel] = useState(state.model);
  const [baseUrl, setBaseUrl] = useState(state.baseUrl);
  const [numCtx, setNumCtx] = useState(String(state.requestedNumCtx));
  const [yolo, setYolo] = useState(state.yolo);
  const [thinkingEnabled, setThinkingEnabled] = useState(state.thinkingEnabled);
  const [reasoningEffort, setReasoningEffort] = useState(state.reasoningEffort);
  const [promptTimestamps, setPromptTimestamps] = useState(state.promptTimestamps ?? true);
  const [compactionModel, setCompactionModel] = useState(state.compactionModel || '');
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

  const handleSave = async () => {
    setSaveError(null);

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
      baseUrl,
      model,
      yolo,
      thinkingEnabled,
      reasoningEffort,
      promptTimestamps,
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

      onClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to save config.';
      setSaveError(message);
    }
  };

  return (
    <div
      className="settings-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
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
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="settings-input"
              >
                <option value="">Select a model...</option>
                {(state.models ?? []).map((m) => (
                  <option key={m.name} value={m.name}>
                    {m.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="settings-row">
              <label className="settings-label">Compaction Model</label>
              <select
                value={compactionModel}
                onChange={(e) => setCompactionModel(e.target.value)}
                className="settings-input"
              >
                <option value="">Same as main model</option>
                {(state.models ?? []).map((m) => (
                  <option key={m.name} value={m.name}>
                    {m.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="settings-row">
            <label className="settings-label">Ollama Base URL</label>
            <input
              type="text"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              className="settings-input"
            />
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

            {state.provider === 'openai-compatible' && (
              <div className="settings-row">
                <label className="settings-label" htmlFor="reasoning-effort-select">
                  Reasoning Effort
                </label>
                <select
                  id="reasoning-effort-select"
                  value={reasoningEffort}
                  onChange={(e) =>
                    setReasoningEffort(e.target.value as ReasoningEffort)
                  }
                  className="settings-input"
                >
                  <option value="off">Off (none)</option>
                  <option value="none">None</option>
                  <option value="minimal">Minimal</option>
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                  <option value="xhigh">XHigh</option>
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
                Adds a [Sent YYYY-MM-DD HH:MM] header to each prompt the LLM sees. The
                wall-clock time of every message is always recorded, so toggling this
                back on later reveals the date for past messages.
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
            <button onClick={onClose} className="settings-btn-cancel">
              Cancel
            </button>
            <button onClick={handleSave} className="settings-btn-save">
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
