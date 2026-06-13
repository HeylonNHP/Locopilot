'use client';

import { useCallback, useEffect, useState } from 'react';

import type { ToolApiItem } from '@/app/api/tools/route';

function formatToolName(name: string): string {
  return name.replaceAll('_', ' ').replaceAll(/\b\w/g, (c) => c.toUpperCase());
}

interface ToolSectionProps {
  label: string;
  tools: ToolApiItem[];
  target: 'main' | 'subagent';
  onToggle: (name: string, target: 'main' | 'subagent', disabled: boolean) => void;
}

function ToolSection({ label, tools, target, onToggle }: ToolSectionProps) {
  const field = target === 'main' ? 'disabledMain' : 'disabledSubAgent';

  return (
    <div className="skills-panel-tool-section">
      <div className="skills-panel-tool-section-label">{label}</div>
      {tools.map((tool) => (
        <div key={tool.name} className="skills-panel-tool-item">
          <span className="skills-panel-tool-item-name">{formatToolName(tool.name)}</span>
          <label
            className="skills-panel-toggle-switch"
            htmlFor={`tool-${target}-${tool.name}`}
            aria-label={`${tool[field] ? 'Enable' : 'Disable'} ${tool.name} for ${label}`}
          >
            <input
              id={`tool-${target}-${tool.name}`}
              type="checkbox"
              checked={!tool[field]}
              onChange={() => onToggle(tool.name, target, tool[field])}
            />
            <span className="skills-panel-toggle-switch-slider" />
          </label>
        </div>
      ))}
    </div>
  );
}

export default function ToolsTab() {
  const [tools, setTools] = useState<ToolApiItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchTools = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await fetch('/api/tools');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { tools: ToolApiItem[] };
      setTools(data.tools ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load tools');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTools();
  }, [fetchTools]);

  const toggleTool = useCallback(
    async (name: string, target: 'main' | 'subagent', currentDisabled: boolean) => {
      const action = currentDisabled ? 'enable' : 'disable';
      const field = target === 'main' ? 'disabledMain' : 'disabledSubAgent';
      setTools((prev) =>
        prev.map((t) => (t.name === name ? { ...t, [field]: !currentDisabled } : t))
      );
      try {
        const res = await fetch('/api/tools', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, target, action }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { tools: ToolApiItem[] };
        setTools(data.tools ?? []);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to update tool');
        await fetchTools();
      }
    },
    [fetchTools]
  );

  const subAgentTools = tools.filter((t) => t.name !== 'run_subagents');

  return (
    <>
      <div className="skills-panel-header">
        <div className="skills-panel-header-title">Tools</div>
        <div className="skills-panel-header-actions">
          <button
            className="skills-panel-header-btn"
            onClick={fetchTools}
            aria-label="Refresh tools"
            title="Refresh"
          >
            ⟳
          </button>
        </div>
      </div>

      {loading && tools.length === 0 ? (
        <div className="skills-panel-empty">Loading tools…</div>
      ) : error ? (
        <div className="skills-panel-error" style={{ margin: '12px' }}>
          <span className="skills-panel-error-text">{error}</span>
          <button className="skills-panel-error-retry" onClick={fetchTools}>
            Retry
          </button>
        </div>
      ) : (
        <div className="skills-panel-body">
          <ToolSection label="Main LLM" tools={tools} target="main" onToggle={toggleTool} />
          <ToolSection
            label="Sub-agents"
            tools={subAgentTools}
            target="subagent"
            onToggle={toggleTool}
          />
        </div>
      )}
    </>
  );
}
