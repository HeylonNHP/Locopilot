'use client';
import React from 'react';

import { type ChatMessage } from '@/app/lib/chatStore';
import { SubagentTraceBubble } from '@/components/ChatMessageBubble/SubagentTraceBubble';

import './ToolMessageBubble.scss';

interface Props {
  message: ChatMessage;
}

/**
 * A tool message: what the call printed or returned, plus — for a
 * `run_subagents` call — what its sub-agents printed.
 *
 * The traces belong to the call, so they are drawn WITH it. On a saved result
 * (`tool_call_id`) they come first, because the agents ran before they reported;
 * on the live card that announces the call they come after its arguments.
 */
export function ToolMessageBubble({ message }: Props) {
  const traces = message.subagentTraces ?? [];
  const tracesFirst = message.tool_call_id !== undefined;
  const traceBlocks = traces.map((trace) => (
    <SubagentTraceBubble key={trace.agentId} agentId={trace.agentId} content={trace.content} />
  ));
  const bubble = (
    <div className="bubble-tool-wrap">
      <div className="bubble-tool">
        <div className="bubble-tool-content">{message.content}</div>
      </div>
    </div>
  );
  if (traces.length === 0) {
    return bubble;
  }
  return (
    <>
      {tracesFirst && traceBlocks}
      {bubble}
      {!tracesFirst && traceBlocks}
    </>
  );
}
