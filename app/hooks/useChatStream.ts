'use client';

import { useCallback, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import { useChat, type ChatMessage } from '@/app/lib/chatStore';
import type { StableRefs } from './useStableRefs';
import { EventSourceParserStream } from 'eventsource-parser/stream';

/**
 * Owns the SSE event dispatcher and the sendChatMessage driver that runs a
 * full streaming chat turn (fetch → SSE parse → dispatch → finally loadSessions).
 */
export function useChatStream(
  refs: StableRefs,
  abortControllersRef: MutableRefObject<Map<number, AbortController>>,
  loadSessions: () => Promise<void>,
) {
  const { state, dispatch } = useChat();

  // --- Background-stream buffering ------------------------------------------
  // When the user switches to a different session while a stream is active,
  // events are buffered instead of dispatched so they don't bleed into the
  // wrong session's message list.  Switching back replays the buffer on top
  // of the freshly-loaded DB messages so live output resumes seamlessly.
  const [streamingSessions, setStreamingSessions] = useState<Set<number>>(new Set());
  const nextRequestIdRef = useRef(0);
  const bufferOwnerMapRef = useRef<Map<number, number>>(new Map());
  const bufferedEventsRef = useRef<Map<number, Array<{ event: string; data: any }>>>(new Map());
  const subagentBufferRef = useRef<Map<string, { text: string; timer: ReturnType<typeof setTimeout> | null }>>(new Map());
  const retryPayloadRef = useRef<{ body: string } | null>(null);
  const requestFailedRef = useRef(false);
  // --------------------------------------------------------------------------

  const handleEvent = useCallback(
    (event: string, data: any) => {
      // ── session_created must ALWAYS be processed first ──────────────────
      // It syncs bufferOwnerMapRef and refs.sessionIdRef to the real
      // session ID.  If the buffer guard below intercepted it, the guard
      // would see size 0 (no active streams), buffer session_created, and
      // the sync would never happen — causing ALL subsequent chunks to be
      // buffered and ultimately discarded by the finally block.
      if (event === 'session_created' && typeof data.sessionId === 'number') {
        const realId: number = data.sessionId;
        if (abortControllersRef.current.has(-1)) {
          const ctrl = abortControllersRef.current.get(-1)!;
          abortControllersRef.current.delete(-1);
          abortControllersRef.current.set(realId, ctrl);
          setStreamingSessions(prev => {
            const next = new Set(prev);
            next.delete(-1);
            next.add(realId);
            return next;
          });
          dispatch({ type: 'STOP_STREAMING', sessionId: -1 });
          dispatch({ type: 'START_STREAMING', sessionId: realId });
        }
        // Migrate any buffered events from placeholder -1 to the real session ID
        const oldBuffer = bufferedEventsRef.current.get(-1);
        if (oldBuffer && oldBuffer.length > 0) {
          const existing = bufferedEventsRef.current.get(realId) ?? [];
          bufferedEventsRef.current.set(realId, [...existing, ...oldBuffer]);
          bufferedEventsRef.current.delete(-1);
        }
        // Update ALL map entries set with -1 (placeholder for new sessions) to the real ID
        for (const [reqId, sessId] of bufferOwnerMapRef.current.entries()) {
          if (sessId === -1) {
            bufferOwnerMapRef.current.set(reqId, realId);
          }
        }
        refs.sessionIdRef.current = realId;
        dispatch({ type: 'SET_CURRENT_SESSION', id: realId });
        loadSessions();
        return;
      }

      // If a stream is active and the user has navigated to a different session,
      // buffer this event so it doesn't land in the wrong message list.
      if (
        bufferOwnerMapRef.current.size > 0 &&
        !new Set(bufferOwnerMapRef.current.values()).has(refs.sessionIdRef.current ?? -1)
      ) {
        // Find which session owns this stream and buffer there
        for (const [reqId, sessId] of bufferOwnerMapRef.current) {
          if (!bufferedEventsRef.current.has(sessId)) {
            bufferedEventsRef.current.set(sessId, []);
          }
          bufferedEventsRef.current.get(sessId)!.push({ event, data });
        }
        return;
      }

      switch (event) {

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

        case 'subagent_chunk': {
          const agentId = typeof data.agentId === 'string' ? data.agentId : '__subagent__';
          const text = typeof data.text === 'string' ? data.text : String(data.text ?? '');
          const buffer = subagentBufferRef.current.get(agentId);
          if (buffer) {
            buffer.text += text;
            if (buffer.timer) clearTimeout(buffer.timer);
          } else {
            subagentBufferRef.current.set(agentId, { text, timer: null });
          }
          const entry = subagentBufferRef.current.get(agentId)!;
          entry.timer = setTimeout(() => {
            dispatch({
              type: 'SUBAGENT_CHUNK',
              agentId,
              text: entry.text,
            });
            subagentBufferRef.current.delete(agentId);
          }, 50);
          break;
        }

        case 'status':
          if (data.tokensUsed !== undefined && data.tokensUsed !== null) {
            dispatch({
              type: 'SET_TOKEN_STATS',
              stats: {
                totalTokens: data.tokensUsed,
                tokenLimit: data.tokenLimit,
                promptEvalCount: 0,
                evalCount: data.tokensUsed,
              },
            });
          }
          if (typeof data.tps === 'number') {
            dispatch({ type: 'SET_CURRENT_TPS', tps: data.tps });
          }
          break;

        case 'compact_progress':
          if (typeof data.message === 'string') {
            dispatch({ type: 'COMPACT_PROGRESS', message: data.message });
          }
          break;

        case 'compact':
          if (Array.isArray(data.messages)) {
            dispatch({ type: 'SET_MESSAGES', messages: data.messages });
          }
          if (typeof data.stats?.newTokenCount === 'number') {
            dispatch({
              type: 'SET_TOKEN_STATS',
              stats: {
                promptEvalCount: data.stats.newTokenCount,
                evalCount: 0,
                totalTokens: data.stats.newTokenCount,
                tokenLimit: data.tokenLimit ?? refs.numCtxRef.current ?? state.numCtx,
              },
            });
          } else {
            dispatch({ type: 'CLEAR_TOKEN_STATS' });
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
            dispatch({ type: 'SET_CURRENT_SESSION', id: data.sessionId });
          }
          if (data.tokenStats) dispatch({ type: 'SET_TOKEN_STATS', stats: data.tokenStats });
          dispatch({ type: 'SET_CURRENT_TPS', tps: null });
          break;

        case 'error':
          requestFailedRef.current = true;
          dispatch({ type: 'SET_ERROR', error: data.message ?? 'Unknown error' });
          dispatch({ type: 'SET_CURRENT_TPS', tps: null });
          break;

        case 'clear_assistant':
          dispatch({ type: 'REMOVE_LAST_ASSISTANT' });
          break;

        default:
          break;
      }
    },
    [dispatch, loadSessions],
  );

  /**
   * Retry a failed chat turn using the originally-stored request payload.
   */
  const retry = useCallback(
    async () => {
      const sessionId = refs.sessionIdRef.current ?? -1;
      if (!retryPayloadRef.current || streamingSessions.has(sessionId)) return;

      const { body } = retryPayloadRef.current;
      dispatch({ type: 'SET_ERROR', error: null });

      const abortController = new AbortController();
      abortControllersRef.current.set(sessionId, abortController);
      setStreamingSessions(prev => new Set(prev).add(sessionId));
      dispatch({ type: 'START_STREAMING', sessionId });

      const requestId = nextRequestIdRef.current++;
      bufferOwnerMapRef.current.set(requestId, sessionId);
      bufferedEventsRef.current.delete(sessionId);

      try {
        const response = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          signal: abortController.signal,
        });

        if (!response.ok) {
          const errorText = await response.text().catch(() => 'Unknown error');
          let parsedError: Record<string, unknown> | null = null;
          try {
            parsedError = JSON.parse(errorText) as Record<string, unknown>;
          } catch {
            const dataLines: string[] = [];
            for (const line of errorText.split('\n')) {
              if (line.startsWith('data:')) {
                dataLines.push(line.slice(5).trim());
              }
            }
            if (dataLines.length > 0) {
              try {
                parsedError = JSON.parse(dataLines.join('\n')) as Record<string, unknown>;
              } catch {}
            }
          }
          if (parsedError) {
            const msg = (parsedError.message ?? parsedError.error) as unknown;
            if (typeof msg === 'string' && msg.length > 0) {
              throw new Error(`HTTP ${response.status}: ${msg}`);
            }
          }
          throw new Error(`HTTP ${response.status}: ${errorText.length > 200 ? errorText.slice(0, 200) + '...' : errorText}`);
        }

        if (!response.body) throw new Error('No response body stream');

        const eventStream = response.body
          .pipeThrough(new TextDecoderStream())
          .pipeThrough(new EventSourceParserStream());

        const reader = eventStream.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          try {
            const parsed = JSON.parse(value.data);
            handleEvent(value.event || 'message', parsed);
          } catch {
            handleEvent(value.event || 'message', value.data);
          }
        }
      } catch (err: any) {
        if (err.name === 'AbortError') {
          // User clicked Stop — silently ignore
        } else if (
          err.message?.includes('input stream') ||
          err.message?.includes('network') ||
          err.message?.includes('fetch') ||
          err.name === 'TypeError'
        ) {
          requestFailedRef.current = true;
          dispatch({ type: 'SET_ERROR', error: 'Connection lost. The stream was interrupted — try again if the response seems incomplete.' });
        } else {
          requestFailedRef.current = true;
          dispatch({ type: 'SET_ERROR', error: err.message });
        }
      } finally {
        for (const [agentId, entry] of subagentBufferRef.current.entries()) {
          if (entry.timer) clearTimeout(entry.timer);
          dispatch({ type: 'SUBAGENT_CHUNK', agentId, text: entry.text });
        }
        subagentBufferRef.current.clear();

        // Use bufferOwnerMapRef (updated by session_created) instead of
        // the captured sessionId, which may still be -1 for new sessions.
        const ownerId = bufferOwnerMapRef.current.get(requestId);
        if (ownerId !== undefined) {
          abortControllersRef.current.delete(ownerId);
          setStreamingSessions(prev => {
            const next = new Set(prev);
            next.delete(ownerId);
            return next;
          });
          dispatch({ type: 'STOP_STREAMING', sessionId: ownerId });
          bufferOwnerMapRef.current.delete(requestId);
          bufferedEventsRef.current.delete(ownerId);
        }
        loadSessions();
        if (!requestFailedRef.current) {
          retryPayloadRef.current = null;
        }
      }
    },
    [dispatch, handleEvent, refs, abortControllersRef, loadSessions, streamingSessions],
  );

  /**
   * Call this after loading a session's messages to replay any SSE events that
   * were buffered while the user was viewing a different session.  No-op when
   * no stream is active or the target session doesn't own the active stream.
   */
  const DELTA_EVENTS = new Set(['chunk', 'thinking', 'tool_progress', 'subagent_chunk', 'status', 'compact_progress']);

  const replayBufferedEvents = useCallback(
    (targetSessionId: number | null) => {
      const sessionKey = targetSessionId ?? -1;
      const buffered = bufferedEventsRef.current.get(sessionKey) ?? [];
      bufferedEventsRef.current.delete(sessionKey);
      for (const { event, data } of buffered) {
        // Only replay "delta" events that append to existing messages.
        // "Creation" events (tool_call, tool_result, subagent_output, compact, done)
        // are skipped because mid-stream DB flushes (Phase 2) already persisted
        // those messages to SQLite. Replaying them would create duplicates.
        if (DELTA_EVENTS.has(event)) {
          handleEvent(event, data);
        }
      }
    },
    [handleEvent],
  );

  const sendChatMessage = useCallback(
    async (message: string) => {
      const sessionId = refs.sessionIdRef.current ?? -1;
      if (streamingSessions.has(sessionId)) return;

      if (!refs.modelRef.current.trim()) {
        dispatch({ type: 'SET_ERROR', error: 'Please select a model first' });
        return;
      }

      const currentMessages = refs.messagesRef.current;
      const userMessage: ChatMessage = { role: 'user', content: message };

      dispatch({ type: 'ADD_MESSAGE', message: userMessage });
      dispatch({ type: 'SET_ERROR', error: null });
      dispatch({ type: 'SET_CURRENT_TPS', tps: null });

      const abortController = new AbortController();
      abortControllersRef.current.set(sessionId, abortController);
      setStreamingSessions(prev => new Set(prev).add(sessionId));
      dispatch({ type: 'START_STREAMING', sessionId });

      // Record which session owns this stream so events can be buffered when
      // the user navigates away and replayed when they switch back.
      const requestId = nextRequestIdRef.current++;
      bufferOwnerMapRef.current.set(requestId, sessionId);
      bufferedEventsRef.current.delete(sessionId);

      const bodyObj = {
        messages: [...currentMessages, userMessage].filter((m) => m.role !== 'system'),
        model: refs.modelRef.current,
        numCtx: refs.numCtxRef.current,
        baseUrl: refs.baseUrlRef.current,
        sessionId: refs.sessionIdRef.current,
        yolo: refs.yoloRef.current,
        think: refs.thinkingEnabledRef.current,
        compactionModel: refs.compactionModelRef.current,
        chatTimeoutMs: refs.chatTimeoutMsRef.current,
        webSearch: refs.webSearchRef.current,
      };
      retryPayloadRef.current = { body: JSON.stringify(bodyObj) };
      requestFailedRef.current = false;

      try {
        const response = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: retryPayloadRef.current!.body,
          signal: abortController.signal,
        });

        if (!response.ok) {
          const errorText = await response.text().catch(() => 'Unknown error');

          let parsedError: Record<string, unknown> | null = null;
          try {
            parsedError = JSON.parse(errorText) as Record<string, unknown>;
          } catch {
            // Not plain JSON — try SSE format
          }

          if (!parsedError) {
            const dataLines: string[] = [];
            for (const line of errorText.split('\n')) {
              if (line.startsWith('data:')) {
                dataLines.push(line.slice(5).trim());
              }
            }
            if (dataLines.length > 0) {
              try {
                const sseData = dataLines.join('\n');
                parsedError = JSON.parse(sseData) as Record<string, unknown>;
              } catch {
                // Invalid JSON in SSE data — fall through
              }
            }
          }

          if (parsedError) {
            const msg = (
              parsedError.message ??
              parsedError.error ??
              parsedError.status ??
              parsedError.detail ??
              parsedError.title
            ) as unknown;
            if (typeof msg === 'string' && msg.length > 0) {
              throw new Error(`HTTP ${response.status}: ${msg}`);
            }
            const values = Object.values(parsedError).filter((v): v is string => typeof v === 'string');
            if (values.length > 0) {
              throw new Error(`HTTP ${response.status}: ${values[0]}`);
            }
          }

          const truncated = errorText.length > 200 ? errorText.slice(0, 200) + '...' : errorText;
          throw new Error(`HTTP ${response.status}: ${truncated}`);
        }

        if (!response.body) throw new Error('No response body stream');

        const eventStream = response.body
          .pipeThrough(new TextDecoderStream())
          .pipeThrough(new EventSourceParserStream());

        const reader = eventStream.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          try {
            const parsed = JSON.parse(value.data);
            handleEvent(value.event || 'message', parsed);
          } catch {
            handleEvent(value.event || 'message', value.data);
          }
        }
      } catch (err: any) {
        if (err.name === 'AbortError') {
          // User clicked Stop — silently ignore
        } else if (
          err.message?.includes('input stream') ||
          err.message?.includes('network') ||
          err.message?.includes('fetch') ||
          err.name === 'TypeError'
        ) {
          requestFailedRef.current = true;
          dispatch({ type: 'SET_ERROR', error: 'Connection lost. The stream was interrupted — try again if the response seems incomplete.' });
        } else {
          requestFailedRef.current = true;
          dispatch({ type: 'SET_ERROR', error: err.message });
        }
      } finally {
        for (const [agentId, entry] of subagentBufferRef.current.entries()) {
          if (entry.timer) clearTimeout(entry.timer);
          dispatch({ type: 'SUBAGENT_CHUNK', agentId, text: entry.text });
        }
        subagentBufferRef.current.clear();

        // Use bufferOwnerMapRef (updated by session_created) instead of
        // the captured sessionId, which may still be -1 for new sessions.
        const ownerId = bufferOwnerMapRef.current.get(requestId);
        if (ownerId !== undefined) {
          abortControllersRef.current.delete(ownerId);
          setStreamingSessions(prev => {
            const next = new Set(prev);
            next.delete(ownerId);
            return next;
          });
          dispatch({ type: 'STOP_STREAMING', sessionId: ownerId });
          bufferOwnerMapRef.current.delete(requestId);
          bufferedEventsRef.current.delete(ownerId);
        }
        loadSessions();
        if (!requestFailedRef.current) {
          retryPayloadRef.current = null;
        }
      }
    },
    [dispatch, handleEvent, refs, abortControllersRef, loadSessions, streamingSessions],
  );

  return { sendChatMessage, retry, handleEvent, replayBufferedEvents };
}
