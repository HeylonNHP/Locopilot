'use client';

import { useCallback, useRef } from 'react';
import type { MutableRefObject } from 'react';
import { useChat, type ChatMessage } from '@/app/lib/chatStore';
import type { StableRefs } from './useStableRefs';

/**
 * Owns the SSE event dispatcher and the sendChatMessage driver that runs a
 * full streaming chat turn (fetch → SSE parse → dispatch → finally loadSessions).
 */
export function useChatStream(
  refs: StableRefs,
  abortRef: MutableRefObject<AbortController | null>,
  loadSessions: () => Promise<void>,
) {
  const { state, dispatch } = useChat();

  // --- Background-stream buffering ------------------------------------------
  // When the user switches to a different session while a stream is active,
  // events are buffered instead of dispatched so they don't bleed into the
  // wrong session's message list.  Switching back replays the buffer on top
  // of the freshly-loaded DB messages so live output resumes seamlessly.
  const streamingSessionIdRef = useRef<number | null | undefined>(undefined);
  const bufferOwnerSessionIdRef = useRef<number | null | undefined>(undefined);
  const bufferedEventsRef = useRef<Array<{ event: string; data: any }>>([]);
  const streamActiveRef = useRef(false);
  // --------------------------------------------------------------------------

  const handleEvent = useCallback(
    (event: string, data: any) => {
      // If a stream is active and the user has navigated to a different session,
      // buffer this event so it doesn't land in the wrong message list.
      if (
        streamActiveRef.current &&
        streamingSessionIdRef.current !== undefined &&
        refs.sessionIdRef.current !== streamingSessionIdRef.current
      ) {
        bufferedEventsRef.current.push({ event, data });
        return;
      }

      switch (event) {
        case 'session_created':
          // The server created a new session before the agent loop started.
          // Update the buffer-owner ref so events are routed to the right session
          // if the user navigates away before the turn completes.
          if (typeof data.sessionId === 'number') {
            streamingSessionIdRef.current = data.sessionId;
            bufferOwnerSessionIdRef.current = data.sessionId;
            dispatch({ type: 'SET_CURRENT_SESSION', id: data.sessionId });
          }
          loadSessions();
          break;

        case 'thinking':
          dispatch({ type: 'APPLY_ASSISTANT_DELTA', thinking: data.content ?? data });
          break;

        case 'chunk':
          dispatch({ type: 'APPLY_ASSISTANT_DELTA', content: data.content ?? data });
          break;

        case 'tool_call':
          dispatch({
            type: 'ADD_MESSAGE',
            message: {
              role: 'tool',
              content: `🔧 **${data.name}**\n\`\`\`json\n${JSON.stringify(data.arguments, null, 2)}\n\`\`\``,
              name: data.name,
            },
          });
          break;

        case 'approval_request':
          // The backend is paused waiting for the user to approve or reject
          // the run_command request.  Show the ApprovalModal.
          dispatch({
            type: 'SHOW_APPROVAL',
            command: { name: data.toolName ?? data.name, args: data.args },
            requestId: data.requestId,
          });
          break;

        case 'tool_result':
          dispatch({
            type: 'ADD_MESSAGE',
            message: {
              role: 'tool',
              content: `✅ **${data.name}** (${data.duration ?? 0}ms)\n\n\`\`\`\n${data.result ?? ''}\n\`\`\``,
              name: data.name,
            },
          });
          break;

        case 'tool_progress':
          dispatch({
            type: 'APPEND_TOOL_PROGRESS',
            name: data.name,
            content: data.message ?? data.content ?? String(data),
          });
          break;

        case 'subagent_output':
          dispatch({
            type: 'SUBAGENT_OUTPUT',
            agentId: typeof data.agentId === 'string' ? data.agentId : '__subagent__',
            message: typeof data.message === 'string' ? data.message : String(data.message ?? ''),
          });
          break;

        case 'compact':
          if (Array.isArray(data.messages)) {
            dispatch({ type: 'SET_MESSAGES', messages: data.messages });
          }
          dispatch({
            type: 'ADD_MESSAGE',
            message: {
              role: 'system',
              content: `⚡ Conversation auto-compacted (${data.stats?.oldTokenCount ?? '?'} → ${data.stats?.newTokenCount ?? '?'} tokens)`,
            },
          });
          break;

        case 'done':
          if (data.sessionId) {
            // Sync refs so switch-back replay uses the server-assigned session ID.
            streamingSessionIdRef.current = data.sessionId;
            bufferOwnerSessionIdRef.current = data.sessionId;
            dispatch({ type: 'SET_CURRENT_SESSION', id: data.sessionId });
          }
          break;

        case 'error':
          dispatch({ type: 'SET_ERROR', error: data.message ?? 'Unknown error' });
          break;

        default:
          break;
      }
    },
    [dispatch],
  );

  /**
   * Call this after loading a session's messages to replay any SSE events that
   * were buffered while the user was viewing a different session.  No-op when
   * no stream is active or the target session doesn't own the active stream.
   */
  const replayBufferedEvents = useCallback(
    (targetSessionId: number | null) => {
      if (!streamActiveRef.current) {
        // Stream already finished; DB copy loaded by loadSessionMessages is
        // authoritative — clear any stale buffer and return.
        bufferedEventsRef.current = [];
        return;
      }
      if (bufferOwnerSessionIdRef.current !== targetSessionId) {
        return;
      }
      const events = [...bufferedEventsRef.current];
      bufferedEventsRef.current = [];
      // We are now on the owning session so handleEvent will dispatch normally.
      for (const { event, data } of events) {
        handleEvent(event, data);
      }
    },
    [handleEvent],
  );

  const sendChatMessage = useCallback(
    async (message: string) => {
      if (state.isStreaming) return;

      if (!refs.modelRef.current.trim()) {
        dispatch({ type: 'SET_ERROR', error: 'Please select a model first' });
        return;
      }

      const currentMessages = refs.messagesRef.current;
      const userMessage: ChatMessage = { role: 'user', content: message };

      dispatch({ type: 'ADD_MESSAGE', message: userMessage });
      dispatch({ type: 'SET_STREAMING', isStreaming: true });
      dispatch({ type: 'SET_ERROR', error: null });

      const abortController = new AbortController();
      abortRef.current = abortController;

      // Record which session owns this stream so events can be buffered when
      // the user navigates away and replayed when they switch back.
      streamingSessionIdRef.current = refs.sessionIdRef.current;
      bufferOwnerSessionIdRef.current = refs.sessionIdRef.current;
      streamActiveRef.current = true;
      bufferedEventsRef.current = [];

      try {
        const response = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: [...currentMessages, userMessage],
            model: refs.modelRef.current,
            numCtx: refs.numCtxRef.current,
            baseUrl: refs.baseUrlRef.current,
            sessionId: refs.sessionIdRef.current,
            yolo: refs.yoloRef.current,
            think: refs.thinkingEnabledRef.current,
            compactionModel: refs.compactionModelRef.current,
            chatTimeoutMs: refs.chatTimeoutMsRef.current,
            webSearch: refs.webSearchRef.current,
          }),
          signal: abortController.signal,
        });

        if (!response.ok) {
          const errorText = await response.text().catch(() => 'Unknown error');
          throw new Error(`HTTP ${response.status}: ${errorText}`);
        }

        const reader = response.body?.getReader();
        if (!reader) throw new Error('No response body stream');

        const decoder = new TextDecoder();
        let buffer = '';
        let currentEvent = '';
        let currentDataLines: string[] = [];

        const flushEvent = () => {
          if (!currentEvent || currentDataLines.length === 0) {
            currentEvent = '';
            currentDataLines = [];
            return;
          }

          const currentData = currentDataLines.join('\n');
          try {
            const parsed = JSON.parse(currentData);
            handleEvent(currentEvent, parsed);
          } catch {
            handleEvent(currentEvent, currentData);
          }

          currentEvent = '';
          currentDataLines = [];
        };

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            if (line.startsWith('event: ')) {
              currentEvent = line.slice(7).trim();
            } else if (line.startsWith('data:')) {
              const value = line.slice(5).replace(/^ /, '');
              currentDataLines.push(value);
            } else if (line === '') {
              flushEvent();
            }
          }
        }

        flushEvent();
      } catch (err: any) {
        if (err.name !== 'AbortError') {
          dispatch({ type: 'SET_ERROR', error: err.message });
        }
      } finally {
        // Mark stream inactive and clear the buffer.  If the stream ended while
        // the user was on another session, loadSessionMessages will load the
        // completed turn from DB — the buffer is no longer needed.
        streamActiveRef.current = false;
        bufferedEventsRef.current = [];
        streamingSessionIdRef.current = undefined;
        bufferOwnerSessionIdRef.current = undefined;
        dispatch({ type: 'SET_STREAMING', isStreaming: false });
        abortRef.current = null;
        loadSessions();
      }
    },
    [state.isStreaming, dispatch, handleEvent, refs, abortRef, loadSessions],
  );

  return { sendChatMessage, handleEvent, replayBufferedEvents };
}
