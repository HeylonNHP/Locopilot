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

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '8px 12px',
    borderRadius: '6px',
    border: '1px solid #444',
    background: 'var(--bg-tertiary)',
    color: 'var(--text-primary)',
    fontSize: '14px',
    boxSizing: 'border-box',
  };

  const labelStyle: React.CSSProperties = {
    display: 'block',
    marginBottom: '4px',
    fontSize: '13px',
    color: 'var(--text-secondary)',
  };

  const rowStyle: React.CSSProperties = {
    marginBottom: '16px',
  };

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: 'rgba(0,0,0,0.6)',
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          background: 'var(--bg-secondary)',
          borderRadius: '12px',
          width: '480px',
          maxWidth: '90%',
          maxHeight: '90vh',
          border: '1px solid #444',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div
          style={{
            padding: '24px',
            overflowY: 'auto',
            flex: 1,
          }}
        >
        <h3 style={{ margin: '0 0 16px 0', fontSize: '18px' }}>Settings</h3>

        {saveError && (
          <div
            role="alert"
            style={{
              marginBottom: '16px',
              padding: '10px 12px',
              borderRadius: '8px',
              border: '1px solid #e94560',
              background: '#3d1f1f',
              color: '#ffb3c1',
              fontSize: '13px',
              lineHeight: 1.5,
            }}
          >
            {saveError}
          </div>
        )}

        <div style={rowStyle}>
          <label style={labelStyle}>Model</label>
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            style={inputStyle}
          >
            <option value="">Select a model...</option>
            {state.models.map((m) => (
              <option key={m.name} value={m.name}>
                {m.name}
              </option>
            ))}
          </select>
        </div>

        <div style={rowStyle}>
          <label style={labelStyle}>Ollama Base URL</label>
          <input
            type="text"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            style={inputStyle}
          />
        </div>

        <div style={rowStyle}>
          <label style={labelStyle}>Context Size</label>
          <input
            type="number"
            value={numCtx}
            onChange={(e) => setNumCtx(e.target.value)}
            style={inputStyle}
          />
        </div>

        <div style={rowStyle}>
          <label style={labelStyle}>Execution Mode</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <input
              id="yolo-toggle"
              type="checkbox"
              checked={yolo}
              onChange={(e) => setYolo(e.target.checked)}
            />
            <label htmlFor="yolo-toggle" style={{ fontSize: '14px', color: 'var(--text-primary)' }}>
              {yolo ? 'YOLO (Automatic execution)' : 'Standard (Confirm commands)'}
            </label>
          </div>
        </div>

        <div style={rowStyle}>
          <label style={labelStyle}>Thinking</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <input
              id="thinking-toggle"
              type="checkbox"
              checked={thinkingEnabled}
              onChange={(e) => setThinkingEnabled(e.target.checked)}
            />
            <label htmlFor="thinking-toggle" style={{ fontSize: '14px', color: 'var(--text-primary)' }}>
              {thinkingEnabled ? 'Enabled' : 'Disabled'}
            </label>
          </div>
        </div>

        <div style={rowStyle}>
          <label style={labelStyle}>Chat Timeout (ms)</label>
          <input
            type="number"
            value={chatTimeoutMs}
            onChange={(e) => setChatTimeoutMs(e.target.value)}
            style={inputStyle}
          />
        </div>

        <div style={rowStyle}>
          <label style={labelStyle}>Compaction Model</label>
          <select
            value={compactionModel}
            onChange={(e) => setCompactionModel(e.target.value)}
            style={inputStyle}
          >
            <option value="">Same as main model</option>
            {state.models.map((m) => (
              <option key={m.name} value={m.name}>
                {m.name}
              </option>
            ))}
          </select>
        </div>

        <div style={rowStyle}>
          <label style={labelStyle}>Web Search: Max Queries</label>
          <input
            type="number"
            value={webMaxQueries}
            onChange={(e) => setWebMaxQueries(e.target.value)}
            style={inputStyle}
          />
        </div>

        <div style={rowStyle}>
          <label style={labelStyle}>Web Search: Results Per Query</label>
          <input
            type="number"
            value={webResultsPerQuery}
            onChange={(e) => setWebResultsPerQuery(e.target.value)}
            style={inputStyle}
          />
        </div>

        <div style={rowStyle}>
          <label style={labelStyle}>Web Search: Page Char Limit (0 = unlimited)</label>
          <input
            type="number"
            value={webPerPageCharLimit}
            onChange={(e) => setWebPerPageCharLimit(e.target.value)}
            style={inputStyle}
          />
        </div>

        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
          <button
            onClick={onClose}
            style={{
              padding: '8px 16px',
              borderRadius: '6px',
              border: '1px solid #555',
              background: 'transparent',
              color: 'var(--text-primary)',
              cursor: 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={isSaving}
            style={{
              padding: '8px 16px',
              borderRadius: '6px',
              border: 'none',
              background: isSaving ? '#7a4a56' : 'var(--accent)',
              color: 'white',
              cursor: isSaving ? 'progress' : 'pointer',
              fontWeight: 'bold',
            }}
          >
            {isSaving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
    </div>
  );
}
