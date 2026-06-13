'use client';
import './SettingsModal.scss';

import { useState } from 'react';
import { useChat } from '@/app/lib/chatStore';
import { DEFAULT_OLLAMA_CHAT_TIMEOUT_MS } from '@/constants';

interface Props {
  onClose: () => void;
}

export default function SettingsModal({ onClose }: Props) {
  const { state, dispatch } = useChat();
  const [model, setModel] = useState(state.model);
  const [baseUrl, setBaseUrl] = useState(state.baseUrl);
  const [numCtx, setNumCtx] = useState(String(state.requestedNumCtx));
  const [yolo, setYolo] = useState(state.yolo);
  const [thinkingEnabled, setThinkingEnabled] = useState(state.thinkingEnabled);
  const [compactionModel, setCompactionModel] = useState(state.compactionModel || '');
  const totalSeconds = Math.floor((state.chatTimeoutMs ?? DEFAULT_OLLAMA_CHAT_TIMEOUT_MS) / 1000);
  const [chatTimeoutHours, setChatTimeoutHours] = useState(String(Math.floor(totalSeconds / 3600)));
  const [chatTimeoutMinutes, setChatTimeoutMinutes] = useState(String(Math.floor((totalSeconds % 3600) / 60)));
  const [chatTimeoutSeconds, setChatTimeoutSeconds] = useState(String(totalSeconds % 60));
  const [webMaxQueries, setWebMaxQueries] = useState(String(state.webSearch?.maxQueries ?? 3));
  const [webResultsPerQuery, setWebResultsPerQuery] = useState(String(state.webSearch?.resultsPerQuery ?? 3));
  const [webPerPageCharLimit, setWebPerPageCharLimit] = useState(String(state.webSearch?.perPageCharLimit ?? 5000));
  const [modelContextLimit, setModelContextLimit] = useState(state.modelContextLimit);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const handleSave = async () => {
    setSaveError(null);

    const parsedNumCtx = parseInt(numCtx) || 131072;
    const parsedHours = parseInt(chatTimeoutHours) || 0;
    const parsedMinutes = parseInt(chatTimeoutMinutes) || 0;
    const parsedSeconds = parseInt(chatTimeoutSeconds) || 0;
    const totalTimeoutSeconds = (parsedHours * 3600) + (parsedMinutes * 60) + parsedSeconds;
    const parsedChatTimeoutMs = totalTimeoutSeconds * 1000;
    const parsedWebMaxQueries = parseInt(webMaxQueries) || 3;
    const parsedWebResultsPerQuery = parseInt(webResultsPerQuery) || 3;
    const parsedWebPerPageCharLimit = parseInt(webPerPageCharLimit) || 5000;

    const config = {
      baseUrl,
      numCtx: parsedNumCtx,
      model,
      yolo,
      thinkingEnabled,
      compactionModel,
      chatTimeoutMs: parsedChatTimeoutMs,
      webSearch: {
        maxQueries: parsedWebMaxQueries,
        resultsPerQuery: parsedWebResultsPerQuery,
        perPageCharLimit: parsedWebPerPageCharLimit,
      },
    };

    dispatch({ type: 'SET_CONFIG', config });
    setIsSaving(true);

    try {
      const response = await fetch('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
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

      dispatch({ type: 'SET_MODEL_CONTEXT_LIMIT', limit: modelContextLimit });
      dispatch({ type: 'SET_CONFIG', config });
      onClose();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to save config.';
      setSaveError(message);
    } finally {
      setIsSaving(false);
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
                onChange={async (e) => {
                  const newModel = e.target.value;
                  setModel(newModel);
                  // Fetch the model's actual context limit from Ollama
                  try {
                    const res = await fetch(`/api/models/${encodeURIComponent(newModel)}/info`);
                    if (res.ok) {
                      const data = await res.json();
                      setModelContextLimit(data.contextLimit ?? null);
                    }
                  } catch {
                    // Silently ignore
                  }
                }}
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

            {state.numCtx !== state.requestedNumCtx ? (
              <div className="settings-row">
                <label className="settings-label">Effective Context Size</label>
                <span className="settings-input text-secondary" style={{ display: 'inline-flex', alignItems: 'center' }}>
                  {state.numCtx.toLocaleString()} (capped by model limit)
                </span>
              </div>
            ) : (
              <div />
            )}
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
            <button
              onClick={handleSave}
              disabled={isSaving}
              className={'settings-btn-save ' + (isSaving ? 'settings-btn-save-disabled' : 'settings-btn-save-active')}
            >
              {isSaving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
