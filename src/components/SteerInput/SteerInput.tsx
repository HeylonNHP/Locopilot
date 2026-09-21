'use client';

import { useCallback, useEffect, useState } from 'react';

import { useChat } from '@/app/lib/chatStore';
import { requestSteerMessage } from '@/app/lib/steerClient';

/**
 * Slim, always-mounted text input shown alongside the Stop button while a
 * turn is streaming, so the user can steer the conversation without
 * stopping it. The message is picked up at the next tool-call loop
 * boundary (main loop, or the currently-running sub-agent's loop) rather
 * than interrupting the stream.
 *
 * When `activeSubagentId` is set (a `run_subagents` batch is currently
 * running one agent), a target toggle lets the user choose between
 * steering that sub-agent or the main agent, defaulting to the sub-agent
 * since it's the thing actively doing work.
 */
export default function SteerInput() {
  const { state, dispatch, abortControllersRef } = useChat();
  const { currentSessionId, streamingSessions, activeSubagentId, pendingSteerDraft } = state;

  const streamingSessionId =
    currentSessionId !== null && streamingSessions.has(currentSessionId) ? currentSessionId : null;

  const [text, setText] = useState('');
  const [target, setTarget] = useState<'main' | 'subagent'>(activeSubagentId ? 'subagent' : 'main');

  // Track a newly-active sub-agent by defaulting the toggle to it; once no
  // sub-agent is running, fall back to 'main' (there's nothing else to pick).
  useEffect(() => {
    setTarget(activeSubagentId ? 'subagent' : 'main');
  }, [activeSubagentId]);

  const sending = pendingSteerDraft !== null;

  const handleSend = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed || streamingSessionId === null || sending) return;

    const chosenTarget = activeSubagentId ? target : 'main';
    const signal = abortControllersRef.current.get(streamingSessionId)?.signal;
    const id = await requestSteerMessage(
      streamingSessionId,
      {
        text: trimmed,
        target: chosenTarget,
        ...(chosenTarget === 'subagent' && activeSubagentId ? { agentId: activeSubagentId } : {}),
      },
      signal
    );

    if (id === null) {
      // Not accepted (no active turn, or the request failed) — leave the
      // text in the box rather than pretend it was sent.
      return;
    }

    dispatch({
      type: 'SET_CONFIG',
      config: {
        pendingSteerDraft: {
          id,
          text: trimmed,
          target: chosenTarget,
          ...(chosenTarget === 'subagent' && activeSubagentId ? { agentId: activeSubagentId } : {}),
        },
      },
    });
    setText('');
  }, [text, streamingSessionId, sending, activeSubagentId, target, abortControllersRef, dispatch]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  if (streamingSessionId === null) return null;

  return (
    <div className="steer-input">
      {activeSubagentId && (
        <div className="steer-input-target" role="radiogroup" aria-label="Send steering message to">
          <button
            type="button"
            role="radio"
            aria-checked={target === 'subagent'}
            className={`steer-input-target-btn ${target === 'subagent' ? 'steer-input-target-btn-active' : ''}`}
            onClick={() => setTarget('subagent')}
          >
            Sub-agent
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={target === 'main'}
            className={`steer-input-target-btn ${target === 'main' ? 'steer-input-target-btn-active' : ''}`}
            onClick={() => setTarget('main')}
          >
            Main agent
          </button>
        </div>
      )}
      <input
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={sending ? 'Sending…' : 'Steer the conversation…'}
        disabled={sending}
        className="steer-input-field"
        aria-label="Steering message"
      />
      <button
        type="button"
        onClick={() => void handleSend()}
        disabled={sending || !text.trim()}
        className="steer-input-send-btn"
      >
        Send
      </button>
    </div>
  );
}
