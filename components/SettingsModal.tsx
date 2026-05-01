'use client';

import { useState } from 'react';
import { useChat } from '@/app/lib/chatStore';

interface Props {
  onClose: () => void;
}

export default function SettingsModal({ onClose }: Props) {
  const { state, dispatch } = useChat();
  const [model, setModel] = useState(state.model);
  const [baseUrl, setBaseUrl] = useState(state.baseUrl);
  const [numCtx, setNumCtx] = useState(String(state.numCtx));
  const [yolo, setYolo] = useState(state.yolo);
  const [thinkingEnabled, setThinkingEnabled] = useState(state.thinkingEnabled);
  const [compactionModel, setCompactionModel] = useState(state.compactionModel || '');
  const [chatTimeoutMs, setChatTimeoutMs] = useState(String(state.chatTimeoutMs));
  const [webMaxQueries, setWebMaxQueries] = useState(String(state.webSearch.maxQueries));
  const [webResultsPerQuery, setWebResultsPerQuery] = useState(String(state.webSearch.resultsPerQuery));
  const [webPerPageCharLimit, setWebPerPageCharLimit] = useState(String(state.webSearch.perPageCharLimit));
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const handleSave = async () => {
    setSaveError(null);

    const parsedNumCtx = parseInt(numCtx) || 131072;
    const parsedChatTimeoutMs = parseInt(chatTimeoutMs) || 720_000;
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
                    dispatch({ type: 'SET_MODEL_CONTEXT_LIMIT', limit: data.contextLimit ?? null });
                  }
                } catch {
                  // Silently ignore
                }
              }}
              className="settings-input"
            >
              <option value="">Select a model...</option>
              {state.models.map((m) => (
                <option key={m.name} value={m.name}>
                  {m.name}
                </option>
              ))}
            </select>
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

          <div className="settings-row">
            <label className="settings-label">Context Size</label>
            <input
              type="number"
              value={numCtx}
              onChange={(e) => setNumCtx(e.target.value)}
              className="settings-input"
            />
          </div>

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

          <div className="settings-row">
            <label className="settings-label">Chat Timeout (ms)</label>
            <input
              type="number"
              value={chatTimeoutMs}
              onChange={(e) => setChatTimeoutMs(e.target.value)}
              className="settings-input"
            />
          </div>

          <div className="settings-row">
            <label className="settings-label">Compaction Model</label>
            <select
              value={compactionModel}
              onChange={(e) => setCompactionModel(e.target.value)}
              className="settings-input"
            >
              <option value="">Same as main model</option>
              {state.models.map((m) => (
                <option key={m.name} value={m.name}>
                  {m.name}
                </option>
              ))}
            </select>
          </div>

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
