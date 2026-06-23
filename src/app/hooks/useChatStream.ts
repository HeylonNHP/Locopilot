'use client';

import { EventSourceParserStream } from 'eventsource-parser/stream';
import { useCallback, useRef, useState } from 'react';

import type { SseEventPayloadMap } from '@/types/sse';

import { type ChatMessage, type DoneReason, useChat } from '@/app/lib/chatStore';
import { type Attachment, langFromFilename } from '@/components/ChatInput';
import { DEFAULT_NUM_CTX, DEFAULT_SESSION_NAME } from '@/constants';

import type { StableRefs, WritableRef } from './useStableRefs';

const DONE_REASONS = ['stop', 'length', 'load', 'unload', 'unknown'] as const;
function isDoneReason(s: string): s is DoneReason {
  return (DONE_REASONS as readonly string[]).includes(s);
}

interface StreamErrorDetails {
  name: string;
  message: string;
}

function getStreamErrorDetails(err: unknown): StreamErrorDetails | null {
  return err instanceof Error ? { name: err.name, message: err.message } : null;
}

/** Parsed SSE event payload. Defined as a union of the shared contract in
 *  src/types/sse.ts so the producer and consumer stay in sync. */
type SseEventPayload = SseEventPayloadMap[keyof SseEventPayloadMap];

type UnionToIntersection<U> = (U extends unknown ? (k: U) => void : never) extends (k: infer I) => void ? I : never;

type SseEventData = Partial<UnionToIntersection<SseEventPayload>>;

/** Coerce an unknown parsed JSON value into the shared SSE payload union.
 *  Non-object values are wrapped as a chunk/thinking payload so malformed
 *  frames still have a defined shape. */
function toSseEventData(value: unknown): SseEventData {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as SseEventData;
  }
  return { content: String(value) } as SseEventData;
}

/**
 * Owns the SSE event dispatcher and the sendChatMessage driver that runs a
 * full streaming chat turn (fetch → SSE parse → dispatch → finally loadSessions).
 */
export function useChatStream(
  refs: StableRefs,
  abortControllersRef: WritableRef<Map<number, AbortController>>,
  loadSessions: () => Promise<void>
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
  const bufferedEventsRef = useRef<Map<number, Array<{ event: string; data: SseEventData }>>>(new Map());
  const subagentBufferRef = useRef<
    Map<string, { text: string; timer: ReturnType<typeof setTimeout> | null; sessionId?: number }>
  >(new Map());
  const retryPayloadRef = useRef<{ body: string } | null>(null);
  const requestFailedMapRef = useRef<Map<number, boolean>>(new Map());
  // --------------------------------------------------------------------------

  const handleEvent = useCallback(
    (event: string, data: SseEventData, requestId?: number) => {
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
          setStreamingSessions((prev) => {
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
        // Migrate subagent buffer entries from placeholder -1 to the real session ID
        for (const [_agentId, entry] of subagentBufferRef.current.entries()) {
          if (entry.sessionId === -1 || entry.sessionId === undefined) {
            entry.sessionId = realId;
          }
        }
        refs.sessionIdRef.current = realId;
        dispatch({ type: 'SET_CURRENT_SESSION', id: realId });
        dispatch({
          type: 'ADD_SESSION',
          session: {
            id: realId,
            name: DEFAULT_SESSION_NAME,
            model: refs.modelRef.current,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
        });
        return;
      }

      // If this event belongs to a stream whose session is NOT the visible
      // session, buffer it so it doesn't land in the wrong message list.
      if (requestId !== undefined) {
        const ownerSessionId = bufferOwnerMapRef.current.get(requestId);
        if (ownerSessionId !== undefined && ownerSessionId !== (refs.sessionIdRef.current ?? -1)) {
          if (!bufferedEventsRef.current.has(ownerSessionId)) {
            bufferedEventsRef.current.set(ownerSessionId, []);
          }
          bufferedEventsRef.current.get(ownerSessionId)!.push({ event, data });
          return;
        }
      }

      switch (event) {
        case 'thinking': {
          dispatch({
            type: 'APPLY_ASSISTANT_DELTA',
            ...(typeof data.content === 'string' ? { thinking: data.content } : {}),
          });
          break;
        }

        case 'chunk': {
          dispatch({
            type: 'APPLY_ASSISTANT_DELTA',
            ...(typeof data.content === 'string' ? { content: data.content } : {}),
          });
          break;
        }

        case 'tool_call': {
          dispatch({
            type: 'ADD_MESSAGE',
            message: {
              role: 'tool',
              content: `🔧 **${data.name ?? ''}**\n\`\`\`json\n${JSON.stringify(data.arguments, null, 2)}\n\`\`\``,
              ...(data.name === undefined ? {} : { name: data.name }),
            },
          });
          break;
        }

        case 'approval_request': {
          dispatch({
            type: 'SHOW_APPROVAL',
            command: {
              name: data.toolName ?? data.name ?? '',
              args: data.args ?? {},
              ...(typeof data.toolCallName === 'string' ? { toolCallName: data.toolCallName } : {}),
            },
            ...(data.requestId === undefined ? {} : { requestId: data.requestId }),
          });
          break;
        }

        case 'tool_result': {
          dispatch({
            type: 'ADD_MESSAGE',
            message: {
              role: 'tool',
              content: `✅ **${data.name ?? ''}** (${data.duration ?? 0}ms)\n\n\`\`\`\n${data.result ?? ''}\n\`\`\``,
              ...(data.name === undefined ? {} : { name: data.name }),
            },
          });
          break;
        }

        case 'tool_progress': {
          dispatch({
            type: 'APPEND_TOOL_PROGRESS',
            ...(data.name === undefined ? {} : { name: data.name }),
            content: data.message ?? data.content ?? String(data),
          });
          break;
        }

        case 'subagent_output': {
          dispatch({
            type: 'SUBAGENT_OUTPUT',
            agentId: typeof data.agentId === 'string' ? data.agentId : '__subagent__',
            message: typeof data.message === 'string' ? data.message : String(data.message ?? ''),
          });
          break;
        }

        case 'subagent_chunk': {
          const agentId = typeof data.agentId === 'string' ? data.agentId : '__subagent__';
          const text = typeof data.text === 'string' ? data.text : String(data.text ?? '');
          const ownerSessionId =
            requestId === undefined ? undefined : bufferOwnerMapRef.current.get(requestId);
          const buffer = subagentBufferRef.current.get(agentId);
          if (buffer) {
            buffer.text += text;
            if (buffer.timer) clearTimeout(buffer.timer);
          } else {
            subagentBufferRef.current.set(agentId, {
              text,
              timer: null,
              ...(ownerSessionId === undefined ? {} : { sessionId: ownerSessionId }),
            });
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

        case 'status': {
          if (data.tokensUsed !== undefined && data.tokensUsed !== null) {
            dispatch({
              type: 'SET_TOKEN_STATS',
              stats: {
                totalTokens: data.tokensUsed,
                tokenLimit: data.tokenLimit ?? 0,
                promptEvalCount: 0,
                evalCount: data.tokensUsed,
                isEstimated: data.isEstimated ?? false,
              },
            });
          }
          if (data.tps !== undefined) {
            dispatch({ type: 'SET_CURRENT_TPS', tps: data.tps });
          }
          break;
        }

        case 'compact_progress': {
          if (typeof data.message === 'string') {
            dispatch({ type: 'COMPACT_PROGRESS', message: data.message });
          }
          break;
        }

        case 'compact': {
          // Clear stale compaction phases so the streaming indicator
          // switches back to "Streaming..." once compaction finishes
          // and the model resumes generating.
          dispatch({ type: 'CLEAR_COMPACT_PROGRESS' });

          // Guard SET_MESSAGES and SET_TOKEN_STATS with the owning session so a
          // compaction that completes after the user has switched sessions cannot
          // overwrite the newly-viewed session's message list or token stats.
          const compactOwner =
            requestId === undefined ? undefined : bufferOwnerMapRef.current.get(requestId);
          if (Array.isArray(data.messages)) {
            dispatch({
              type: 'SET_MESSAGES',
              messages: data.messages,
              ...(compactOwner === undefined ? {} : { targetSessionId: compactOwner }),
            });
          }
          if (typeof data.stats?.newTokenCount === 'number') {
            dispatch({
              type: 'SET_TOKEN_STATS',
              stats: {
                promptEvalCount: data.stats.newTokenCount,
                evalCount: 0,
                totalTokens: data.stats.newTokenCount,
                tokenLimit: data.tokenLimit ?? refs.numCtxRef.current ?? DEFAULT_NUM_CTX,
              },
              ...(compactOwner === undefined ? {} : { targetSessionId: compactOwner }),
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
        }

        case 'done': {
          // Do NOT call SET_CURRENT_SESSION here. If the user switched sessions
          // while a stream was running, dispatching SET_CURRENT_SESSION(A) would
          // forcibly snap the UI back to session A against the user's will.
          // session_created already handles new-session ID assignment; for
          // existing sessions this dispatch was always a redundant no-op at best.
          // This event is in DELTA_EVENTS so it is buffered when the user is away
          // and replayed (applying the final tokenStats) when they return.
          if (data.tokenStats) dispatch({ type: 'SET_TOKEN_STATS', stats: data.tokenStats });
          if (typeof data.doneReason === 'string') {
            // Normalize the server-side value to our DoneReason union. The server
            // coerces missing values to 'stop' and is the source of truth for
            // valid values; this is purely defensive.
            const reason: DoneReason = isDoneReason(data.doneReason) ? data.doneReason : 'unknown';
            const doneOwnerSessionId =
              requestId === undefined ? undefined : bufferOwnerMapRef.current.get(requestId);
            dispatch({
              type: 'SET_DONE_REASON',
              reason,
              ...(doneOwnerSessionId === undefined ? {} : { targetSessionId: doneOwnerSessionId }),
            });
          }
          dispatch({ type: 'SET_CURRENT_TPS', tps: null });
          break;
        }

        case 'error': {
          if (requestId !== undefined) requestFailedMapRef.current.set(requestId, true);
          dispatch({ type: 'SET_ERROR', error: data.message ?? 'Unknown error' });
          dispatch({ type: 'SET_CURRENT_TPS', tps: null });
          break;
        }

        case 'clear_assistant': {
          dispatch({ type: 'REMOVE_LAST_ASSISTANT' });
          break;
        }

        default: {
          break;
        }
      }
    },
    [dispatch]
  );

  /**
   * Retry a failed chat turn using the originally-stored request payload.
   */
  const retry = useCallback(async () => {
    const sessionId = refs.sessionIdRef.current ?? -1;
    if (!retryPayloadRef.current || streamingSessions.has(sessionId)) return;

    const { body } = retryPayloadRef.current;
    dispatch({ type: 'SET_ERROR', error: null });
    dispatch({ type: 'SET_CURRENT_TPS', tps: null });
    dispatch({ type: 'SET_DONE_REASON', reason: undefined });

    const abortController = new AbortController();
    abortControllersRef.current.set(sessionId, abortController);
    setStreamingSessions((prev) => new Set(prev).add(sessionId));
    dispatch({ type: 'START_STREAMING', sessionId });

    const requestId = nextRequestIdRef.current++;
    bufferOwnerMapRef.current.set(requestId, sessionId);
    bufferedEventsRef.current.delete(sessionId);
    requestFailedMapRef.current.set(requestId, false);

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
            } catch {
              /* ignore */
            }
          }
        }
        if (parsedError) {
          const msg = parsedError.message ?? parsedError.error;
          if (typeof msg === 'string' && msg.length > 0) {
            throw new Error(`HTTP ${response.status}: ${msg}`);
          }
        }
        throw new Error(
          `HTTP ${response.status}: ${errorText.length > 200 ? `${errorText.slice(0, 200)  }...` : errorText}`
        );
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
          const parsed = toSseEventData(JSON.parse(value.data));
          handleEvent(value.event || 'message', parsed, requestId);
        } catch {
          handleEvent(value.event || 'message', { content: value.data }, requestId);
        }
      }
    } catch (err: unknown) {
      const details = getStreamErrorDetails(err);
      if (!details) {
        requestFailedMapRef.current.set(requestId, true);
        dispatch({ type: 'SET_ERROR', error: 'Unknown error' });
      } else if (details.name === 'AbortError') {
        // User clicked Stop — silently ignore
      } else if (
        details.message.includes('input stream') ||
        details.message.includes('network') ||
        details.message.includes('fetch') ||
        details.name === 'TypeError'
      ) {
        requestFailedMapRef.current.set(requestId, true);
        dispatch({
          type: 'SET_ERROR',
          error:
            'Connection lost. The stream was interrupted — try again if the response seems incomplete.',
        });
      } else {
        requestFailedMapRef.current.set(requestId, true);
        dispatch({ type: 'SET_ERROR', error: details.message });
      }
    } finally {
      const ownerId = bufferOwnerMapRef.current.get(requestId);

      // Only flush subagent buffers belonging to this session
      for (const [agentId, entry] of subagentBufferRef.current.entries()) {
        if (entry.sessionId === ownerId || entry.sessionId === undefined) {
          if (entry.timer) clearTimeout(entry.timer);
          dispatch({ type: 'SUBAGENT_CHUNK', agentId, text: entry.text });
          subagentBufferRef.current.delete(agentId);
        }
      }

      if (ownerId !== undefined) {
        abortControllersRef.current.delete(ownerId);
        setStreamingSessions((prev) => {
          const next = new Set(prev);
          next.delete(ownerId);
          return next;
        });
        dispatch({ type: 'STOP_STREAMING', sessionId: ownerId });
        bufferOwnerMapRef.current.delete(requestId);
        bufferedEventsRef.current.delete(ownerId);
      }
      loadSessions();
      // Delayed refresh to pick up auto-generated title from background task
      setTimeout(() => loadSessions(), 2000);
      if (!requestFailedMapRef.current.get(requestId)) {
        retryPayloadRef.current = null;
      }
      requestFailedMapRef.current.delete(requestId);
      dispatch({ type: 'SET_CURRENT_TPS', tps: null });
    }
  }, [dispatch, handleEvent, refs, abortControllersRef, loadSessions, streamingSessions]);

  /**
   * Call this after loading a session's messages to replay any SSE events that
   * were buffered while the user was viewing a different session.  No-op when
   * no stream is active or the target session doesn't own the active stream.
   */
  // Events to replay when the user switches back to a buffered session.
  // Includes:
  //   - Incremental content deltas (chunk, thinking, tool_progress, …)
  //   - done: applies the final authoritative token stats for the session
  //   - approval_request: re-surfaces the approval modal on return so the user
  //     can still approve/reject a pending run_command (the server waits up to
  //     120 s; if already timed out the POST to /api/approve is a harmless no-op)
  // Excludes tool_call / tool_result / subagent_output / compact because those
  // messages are flushed to SQLite mid-stream (Phase 2) and are reloaded from
  // DB on session switch — replaying them here would create duplicates.
  const DELTA_EVENTS = new Set([
    'chunk',
    'thinking',
    'tool_progress',
    'subagent_chunk',
    'status',
    'compact_progress',
    'done',
    'approval_request',
  ]);

  const replayBufferedEvents = useCallback(
    (targetSessionId: number | null) => {
      const sessionKey = targetSessionId ?? -1;
      const buffered = bufferedEventsRef.current.get(sessionKey) ?? [];
      bufferedEventsRef.current.delete(sessionKey);
      for (const { event, data } of buffered) {
        if (DELTA_EVENTS.has(event)) {
          handleEvent(event, data);
        }
      }
    },
    [handleEvent]
  );

  // ---------------------------------------------------------------------------
  // Attachment resolution — converts Attachment[] into extra message content
  // and/or a base64 images array before sending to the LLM.
  // ---------------------------------------------------------------------------
  async function resolveAttachments(
    message: string,
    attachments: Attachment[]
  ): Promise<{ content: string; images: string[] }> {
    if (attachments.length === 0) return { content: message, images: [] };

    const images: string[] = [];
    const textBlocks: string[] = [];

    for (const att of attachments) {
      if (att.type === 'image' && typeof att.base64 === 'string' && att.base64.length > 0) {
        images.push(att.base64);
        continue;
      }

      if (att.type === 'text' && att.textContent !== undefined) {
        const TEXT_INLINE_LIMIT = 50_000;
        if (att.textContent.length <= TEXT_INLINE_LIMIT) {
          // Small file: inject inline
          const lang = langFromFilename(att.name);
          textBlocks.push(`**${att.name}**\n\`\`\`${lang}\n${att.textContent}\n\`\`\``);
        } else {
          // Large file: upload to server, inject partial + hint
          try {
            const form = new FormData();
            form.append(
              'file',
              att.file ?? new Blob([att.textContent ?? ''], { type: att.mimeType }),
              att.name
            );
            form.append('filename', att.name);
            const uploadAbort = new AbortController();
            const uploadTimer = setTimeout(() => uploadAbort.abort(), 60_000);
            const res = await fetch('/api/files/upload', {
              method: 'POST',
              body: form,
              signal: uploadAbort.signal,
            });
            clearTimeout(uploadTimer);
            if (res.ok) {
              const data = (await res.json()) as {
                text: string;
                totalChars: number;
                tempPath: string;
                truncated: boolean;
              };
              const lang = langFromFilename(att.name);
              const partial = data.text;
              const notice = data.truncated
                ? `\n\n_File truncated at ${TEXT_INLINE_LIMIT.toLocaleString()} of ${data.totalChars.toLocaleString()} chars. Full file saved at \`${data.tempPath}\` — use \`read_file\` with \`start_line\` or \`start\`/\`length\` to read more._`
                : '';
              textBlocks.push(`**${att.name}**\n\`\`\`${lang}\n${partial}\n\`\`\`${notice}`);
            } else {
              // Server error — fall back to inserting as much as we can inline
              const lang = langFromFilename(att.name);
              const safeFallback = (att.textContent ?? '').slice(0, TEXT_INLINE_LIMIT);
              textBlocks.push(
                `**${att.name}** _(upload failed — showing first ${TEXT_INLINE_LIMIT.toLocaleString()} chars)_\n\`\`\`${lang}\n${safeFallback}\n\`\`\``
              );
            }
          } catch {
            const lang = langFromFilename(att.name);
            const safeFallback = (att.textContent ?? '').slice(0, TEXT_INLINE_LIMIT);
            textBlocks.push(
              `**${att.name}** _(upload error — showing first ${TEXT_INLINE_LIMIT.toLocaleString()} chars)_\n\`\`\`${lang}\n${safeFallback}\n\`\`\``
            );
          }
        }
        continue;
      }

      if (att.type === 'pdf' && att.file) {
        try {
          const form = new FormData();
          form.append('file', att.file, att.name);
          form.append('filename', att.name);
          const uploadAbort = new AbortController();
          const uploadTimer = setTimeout(() => uploadAbort.abort(), 60_000);
          const res = await fetch('/api/files/upload', {
            method: 'POST',
            body: form,
            signal: uploadAbort.signal,
          });
          clearTimeout(uploadTimer);
          if (res.ok) {
            const data = (await res.json()) as {
              text: string;
              pageCount: number;
              tempPath: string;
              truncated: boolean;
            };
            const notice = data.truncated
              ? `\n\n_PDF has ${data.pageCount} total pages. Showing pages 1–50. Full file saved at \`${data.tempPath}\` — use \`read_pdf\` with \`start_page\`/\`end_page\` to read more._`
              : '';
            textBlocks.push(
              `**${att.name}** (PDF, ${data.pageCount} page${data.pageCount === 1 ? '' : 's'})\n\n${data.text}${notice}`
            );
          } else {
            textBlocks.push(
              `**${att.name}** _(PDF upload failed — provide the file path instead)_`
            );
          }
        } catch {
          textBlocks.push(`**${att.name}** _(PDF upload error — provide the file path instead)_`);
        }
        continue;
      }
    }

    const prefix = textBlocks.length > 0 ? `${textBlocks.join('\n\n')  }\n\n` : '';
    return { content: prefix + message, images };
  }

  const sendChatMessage = useCallback(
    async (message: string, attachments?: Attachment[]) => {
      const sessionId = refs.sessionIdRef.current ?? -1;
      if (streamingSessions.has(sessionId)) return;

      if (!refs.modelRef.current.trim()) {
        dispatch({ type: 'SET_ERROR', error: 'Please select a model first' });
        return;
      }

      const currentMessages = refs.messagesRef.current;

      // Process attachments into message content + images
      const { content, images } = await resolveAttachments(message, attachments ?? []);
      const userMessage: ChatMessage = {
        role: 'user',
        content,
        ...(images.length > 0 ? { images } : {}),
      };

      dispatch({ type: 'ADD_MESSAGE', message: userMessage });
      dispatch({ type: 'SET_ERROR', error: null });
      dispatch({ type: 'SET_CURRENT_TPS', tps: null });

      const abortController = new AbortController();
      abortControllersRef.current.set(sessionId, abortController);
      setStreamingSessions((prev) => new Set(prev).add(sessionId));
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
        completionMode: refs.completionModeRef.current,
        maxPromptLoopIterations: refs.maxPromptLoopIterationsRef.current,
      };
      retryPayloadRef.current = { body: JSON.stringify(bodyObj) };
      requestFailedMapRef.current.set(requestId, false);

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
            const msg =
              parsedError.message ??
              parsedError.error ??
              parsedError.status ??
              parsedError.detail ??
              parsedError.title;
            if (typeof msg === 'string' && msg.length > 0) {
              throw new Error(`HTTP ${response.status}: ${msg}`);
            }
            const values = Object.values(parsedError).filter(
              (v): v is string => typeof v === 'string'
            );
            if (values.length > 0) {
              throw new Error(`HTTP ${response.status}: ${values[0]}`);
            }
          }

          const truncated = errorText.length > 200 ? `${errorText.slice(0, 200)  }...` : errorText;
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
            const parsed = toSseEventData(JSON.parse(value.data));
            handleEvent(value.event || 'message', parsed, requestId);
          } catch {
            handleEvent(value.event || 'message', { content: value.data }, requestId);
          }
        }
      } catch (err: unknown) {
        const details = getStreamErrorDetails(err);
        if (!details) {
          requestFailedMapRef.current.set(requestId, true);
          dispatch({ type: 'SET_ERROR', error: 'Unknown error' });
        } else if (details.name === 'AbortError') {
          // User clicked Stop — silently ignore
        } else if (
          details.message.includes('input stream') ||
          details.message.includes('network') ||
          details.message.includes('fetch') ||
          details.name === 'TypeError'
        ) {
          requestFailedMapRef.current.set(requestId, true);
          dispatch({
            type: 'SET_ERROR',
            error:
              'Connection lost. The stream was interrupted — try again if the response seems incomplete.',
          });
        } else {
          requestFailedMapRef.current.set(requestId, true);
          dispatch({ type: 'SET_ERROR', error: details.message });
        }
      } finally {
        const ownerId = bufferOwnerMapRef.current.get(requestId);

        // Only flush subagent buffers belonging to this session
        for (const [agentId, entry] of subagentBufferRef.current.entries()) {
          if (entry.sessionId === ownerId || entry.sessionId === undefined) {
            if (entry.timer) clearTimeout(entry.timer);
            dispatch({ type: 'SUBAGENT_CHUNK', agentId, text: entry.text });
            subagentBufferRef.current.delete(agentId);
          }
        }

        if (ownerId !== undefined) {
          abortControllersRef.current.delete(ownerId);
          setStreamingSessions((prev) => {
            const next = new Set(prev);
            next.delete(ownerId);
            return next;
          });
          dispatch({ type: 'STOP_STREAMING', sessionId: ownerId });
          bufferOwnerMapRef.current.delete(requestId);
          bufferedEventsRef.current.delete(ownerId);
        }
        loadSessions();
        if (!requestFailedMapRef.current.get(requestId)) {
          retryPayloadRef.current = null;
        }
        requestFailedMapRef.current.delete(requestId);
        dispatch({ type: 'SET_CURRENT_TPS', tps: null });
      }
    },
    [dispatch, handleEvent, refs, abortControllersRef, loadSessions, streamingSessions]
  );

  return { sendChatMessage, retry, handleEvent, replayBufferedEvents };
}
