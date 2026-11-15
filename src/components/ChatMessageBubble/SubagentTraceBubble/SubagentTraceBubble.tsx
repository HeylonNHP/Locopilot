'use client';
import React, { useEffect, useRef, useState } from 'react';

import './SubagentTraceBubble.scss';

interface Props {
  /** The agent's canonical id, shown on the toggle. */
  agentId: string;
  /** Everything the agent printed, as one text. */
  content: string;
}

/** One sub-agent's transcript: a collapsible block that follows its output as it streams. */
export function SubagentTraceBubble({ agentId, content }: Props) {
  const [subagentCollapsed, setSubagentCollapsed] = useState(false);
  const traceRef = useRef<HTMLPreElement>(null);

  // Auto-scroll the subagent log to the bottom as new lines arrive.
  useEffect(() => {
    if (!subagentCollapsed && traceRef.current) {
      traceRef.current.scrollTop = traceRef.current.scrollHeight;
    }
  }, [content, subagentCollapsed]);

  return (
    <div className="bubble-subagent-wrap">
      <div className="bubble-subagent">
        <button
          onClick={() => setSubagentCollapsed((c) => !c)}
          className={
            subagentCollapsed
              ? 'bubble-subagent-toggle'
              : 'bubble-subagent-toggle bubble-subagent-toggle-open'
          }
        >
          <span>{subagentCollapsed ? '▶' : '▼'}</span>
          <span>🤖 {agentId || 'unknown'}</span>
        </button>
        {!subagentCollapsed && (
          <pre ref={traceRef} className="bubble-subagent-log">
            {content || 'Waiting...'}
          </pre>
        )}
      </div>
    </div>
  );
}
