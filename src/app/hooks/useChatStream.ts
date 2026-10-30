'use client';

import { useCallback, useRef, useState } from 'react';

import { type ChatMessage, useChat } from '@/app/lib/chatStore';
import { retryBodyForSession, streamChatTurn } from '@/app/lib/chatTurn';
import { isReplayableEvent } from '@/app/lib/sseEvents';
import { frameOwner, isDoneReason, routeSseEvent, type SseEventData } from '@/app/lib/sseRouting';
import { NEW_SESSION_KEY, streamKeyFor } from '@/app/lib/streamKey';
import {
  beginRequest,
  bufferEvent,
  createStreamState,
  discardBufferedEvents,
  endRequest,
  findBufferedDone,
  markRequestFailed,
  migrateSessionKey,
  ownerOf,
  type StreamState,
  takeBufferedEvents,
} from '@/app/lib/streamMachine';
import { type Attachment, langFromFilename } from '@/components/ChatInput';
import { DEFAULT_SESSION_NAME } from '@/constants';

import type { StableRefs, WritableRef } from './useStableRefs';

const trace = (label: string, data?: Record<string, unknown>) => {
  if (process.env.NODE_ENV === 'development') {
    console.warn(`[trace] ${label}`, data ?? {});
  }
};

interface StreamErrorDetails {
  name: string;
  message: string;
}

function getStreamErrorDetails(err: unknown): StreamErrorDetails | null {
  return err instanceof Error ? { name: err.name, message: err.message } : null;
}

/**
 * Owns the SSE event dispatcher and the sendChatMessage driver that runs a
 * full streaming chat turn (fetch → SSE parse → dispatch → finally loadSessions).
 */
export function useChatStream(
  refs: StableRefs,
  abortControllersRef: WritableRef<Map<number, AbortController>>,
  loadSessions: () => Promise<void>,
  loadSessionMessages: (
    id: number,
    allowEmptyWhileStreaming?: boolean,
    options?: { keepCurrentSession?: boolean }
  ) => Promise<void>
) {
  const { state, dispatch } = useChat();

  // --- Background-stream buffering ------------------------------------------
  // When the user switches to a different session while a stream is active,
  // events are buffered instead of dispatched so they don't bleed into the
  // wrong session's message list.  Switching back replays the buffer on top
  // of the freshly-loaded DB messages so live output resumes seamlessly.
  // Whether the turn that failed can be retried at all. There is a stored
  // retry payload while a turn is in flight and after it fails, but a turn
  // whose session has been deleted cannot be retried into anything — the
  // banner must not offer a Retry that fails the same way.
  const [canRetry, setCanRetry] = useState(false);
  const nextRequestIdRef = useRef(0);
  // The ownership rules (which turn belongs to which session, what is held
  // while the user is away, which turns failed) live in `streamMachine.ts`
  // as pure functions over one state object.
  const streamStateRef = useRef<StreamState>(createStreamState());
  const subagentBufferRef = useRef<
    Map<string, { text: string; timer: ReturnType<typeof setTimeout> | null; sessionId?: number }>
  >(new Map());
  const retryPayloadRef = useRef<{ body: string } | null>(null);

  // --------------------------------------------------------------------------

  /**
   * Clear a session's live t/s read-out — the number the status bar shows
   * while a turn is running.
   *
   * The end-of-turn rates inside `tokenStats` are deliberately NOT touched
   * here: they are delivered once, on the `done` event, and they are the
   * numbers the user wants to see afterwards. A turn that ends successfully
   * must not have them wiped a moment after they arrive.
   */
  const clearTpsReadout = useCallback(
    (targetSessionId?: number) => {
      dispatch({
        type: 'SET_CURRENT_TPS',
        tps: null,
        ...(targetSessionId === undefined ? {} : { targetSessionId }),
      });
    },
    [dispatch]
  );

  /**
   * Clear the live read-out AND the end-of-turn rate fields.
   *
   * Used on error and abort paths: the store's SET_TOKEN_STATS merge
   * preserves rate fields that a payload omits, so without this the
   * PREVIOUS turn's evalTps would keep displaying as if it belonged to the
   * aborted or errored turn.
   */
  const clearTokenRates = useCallback(
    (targetSessionId?: number) => {
      clearTpsReadout(targetSessionId);
      dispatch({
        type: 'SET_TOKEN_STATS',
        stats: { evalTps: null, promptTps: null, evalTpsEstimated: false },
        ...(targetSessionId === undefined ? {} : { targetSessionId }),
      });
    },
    [clearTpsReadout, dispatch]
  );

  /**
   * Apply a terminal `done` event that was buffered while the stream's owner
   * session was a background session. The buffered `done` is the ONLY carrier
   * of the end-of-turn tokenStats (including the authoritative t/s rate) —
   * the buffer is discarded in the stream's `finally` without a full replay,
   * so without this flush the owner slot would keep showing its last live
   * mid-stream estimate forever after the user switches back. Returns true
   * when a buffered `done` was found and applied.
   */
  const flushBufferedDoneFor = useCallback(
    (sessionId: number): boolean => {
      const doneEntry = findBufferedDone(streamStateRef.current, sessionId);
      if (!doneEntry) return false;
      const data = doneEntry.data as SseEventData;
      if (data.tokenStats) {
        dispatch({ type: 'SET_TOKEN_STATS', stats: data.tokenStats, targetSessionId: sessionId });
      }
      if (typeof data.doneReason === 'string') {
        dispatch({
          type: 'SET_DONE_REASON',
          reason: isDoneReason(data.doneReason) ? data.doneReason : 'unknown',
          targetSessionId: sessionId,
        });
      }
      clearTpsReadout(sessionId);
      return true;
    },
    [dispatch, clearTpsReadout]
  );

  const handleEvent = useCallback(
    (event: string, data: SseEventData, requestId?: number, replayTargetSessionId?: number) => {
      // ── session_created must ALWAYS be processed first ──────────────────
      // It moves the turn from the placeholder key to the real session id,
      // in every registry at once: the abort controller, the streaming set,
      // the ownership map and the visible session. If the buffer guard below
      // intercepted it, the turn would stay filed under the placeholder and
      // every later chunk would be buffered and ultimately discarded.
      if (event === 'session_created' && typeof data.sessionId === 'number') {
        const realId: number = data.sessionId;
        if (abortControllersRef.current.has(NEW_SESSION_KEY)) {
          const ctrl = abortControllersRef.current.get(NEW_SESSION_KEY)!;
          abortControllersRef.current.delete(NEW_SESSION_KEY);
          abortControllersRef.current.set(realId, ctrl);
          // The store's streaming set is the single record of which
          // sessions are streaming. The rename is one step: a STOP followed
          // by a START would leave the set momentarily empty, and an empty
          // set clears the steer-target toggle, the pending model switch
          // and the held steer draft.
          dispatch({ type: 'RENAME_STREAMING', fromSessionId: -1, toSessionId: realId });
        }
        // Move every structure keyed by the placeholder over to the real id.
        streamStateRef.current = migrateSessionKey(streamStateRef.current, realId);
        // Migrate subagent buffer entries from placeholder -1 to the real session ID
        for (const [_agentId, entry] of subagentBufferRef.current.entries()) {
          if (entry.sessionId === -1 || entry.sessionId === undefined) {
            entry.sessionId = realId;
          }
        }
        refs.sessionIdRef.current = realId;
        // The stored retry payload has to point at the session this turn was
        // saved to. It was sent without a session id — the server assigned
        // one just now — so a retry would otherwise make the server create a
        // second session for the same chat, and the client would end up
        // looking at one session while the turn belonged to another.
        if (retryPayloadRef.current) {
          retryPayloadRef.current = {
            body: retryBodyForSession(retryPayloadRef.current.body, realId),
          };
        }
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

      // The server stamps every frame with the session the turn belongs to,
      // so that is where the owner comes from. The client's own record of
      // which session a turn belongs to is only the fallback, for frames that
      // arrive before the server has created the session.
      const frameSessionId = data.sessionId;

      // If this event belongs to a stream whose session is NOT the visible
      // session, buffer it so it doesn't land in the wrong message list.
      if (requestId !== undefined) {
        const ownerSessionId = frameOwner(
          frameSessionId,
          ownerOf(streamStateRef.current, requestId)
        );
        if (
          ownerSessionId !== undefined &&
          ownerSessionId !== streamKeyFor(refs.sessionIdRef.current)
        ) {
          streamStateRef.current = bufferEvent(streamStateRef.current, ownerSessionId, event, data);
          return;
        }
      }

      // ── Compute the owning session id for every dispatch ──────────────
      // The owning session is the turn's session if the server named it,
      // otherwise the client's record of it, otherwise the currently-visible
      // session. The reducer's
      // `targetSessionId` guard then routes the action to the correct
      // session slot when two streams are live. Passing `targetSessionId`
      // on every dispatch (instead of relying on a no-target default
      // that would always hit the current session) is what fixes the
      // cross-stream state contamination: a `chunk` from stream A no
      // longer mutates the message list for stream B's session.
      const ownerSessionId =
        requestId === undefined
          ? (refs.sessionIdRef.current ?? undefined)
          : frameOwner(frameSessionId, ownerOf(streamStateRef.current, requestId));
      const targetSessionId = ownerSessionId === undefined ? undefined : ownerSessionId;

      // Routing an event into store actions is a pure function, so it can be
      // characterised by tests (scripts/test-sse-routing.mjs). This callback
      // keeps only the parts that need the ownership maps and the timers.
      const outcome = routeSseEvent(event, data, {
        targetSessionId,
        approvalOwner:
          requestId === undefined
            ? (replayTargetSessionId ?? refs.sessionIdRef.current ?? undefined)
            : frameOwner(frameSessionId, ownerOf(streamStateRef.current, requestId)),
        compactOwner:
          requestId === undefined
            ? undefined
            : frameOwner(frameSessionId, ownerOf(streamStateRef.current, requestId)),
        doneOwner:
          requestId === undefined
            ? undefined
            : frameOwner(frameSessionId, ownerOf(streamStateRef.current, requestId)),
        subagentOwner:
          requestId === undefined
            ? replayTargetSessionId
            : frameOwner(frameSessionId, ownerOf(streamStateRef.current, requestId)),
        requestedNumCtx: refs.requestedNumCtxRef.current,
        pendingSteerDraft: refs.pendingSteerDraftRef.current,
      });

      if (outcome.markFailed && requestId !== undefined) {
        streamStateRef.current = markRequestFailed(streamStateRef.current, requestId);
      }

      for (const action of outcome.actions) {
        dispatch(action);
      }

      if (outcome.subagentChunk) {
        const { agentId, text, owner } = outcome.subagentChunk;
        const buffer = subagentBufferRef.current.get(agentId);
        if (buffer) {
          buffer.text += text;
          if (buffer.timer) clearTimeout(buffer.timer);
        } else {
          subagentBufferRef.current.set(agentId, {
            text,
            timer: null,
            ...(owner === undefined ? {} : { sessionId: owner }),
          });
        }
        const entry = subagentBufferRef.current.get(agentId)!;
        entry.timer = setTimeout(() => {
          dispatch({
            type: 'SUBAGENT_CHUNK',
            agentId,
            text: entry.text,
            ...(owner === undefined ? {} : { targetSessionId: owner }),
          });
          subagentBufferRef.current.delete(agentId);
        }, 50);
      }

      if (outcome.clearRates) {
        // Clears the live read-out as well.
        clearTokenRates(targetSessionId);
      } else if (outcome.clearTps) {
        clearTpsReadout(targetSessionId);
      }
    },
    [dispatch, clearTokenRates, clearTpsReadout]
  );

  /**
   * Finish a turn: release everything the turn held, reconcile the
   * transcript with the database, and refresh the session list.
   *
   * Sending a message and retrying a failed one used to end with two copies
   * of this block, and they had drifted: the send path reloaded the
   * transcript and the retry path did not, and the retry path refreshed the
   * title and the send path did not. The drift was not harmless — a retry
   * whose previous attempt had failed left the two attempts' partial
   * replies merged into a single bubble, and a retry of a turn that never
   * reached the server showed the answer with no question above it.
   *
   * Both drivers call this, so the two cannot drift apart again.
   */
  const finishTurn = useCallback(
    async (requestId: number) => {
      const ownerId = ownerOf(streamStateRef.current, requestId);

      // Flush the sub-agent text that is still coalescing, against the
      // session that owns it.
      for (const [agentId, entry] of subagentBufferRef.current.entries()) {
        if (entry.sessionId === ownerId || entry.sessionId === undefined) {
          if (entry.timer) clearTimeout(entry.timer);
          // Flush against the owning session so a background stream's
          // pending sub-agent bubble is not appended to the visible
          // session when the request lifecycle ends.
          dispatch({
            type: 'SUBAGENT_CHUNK',
            agentId,
            text: entry.text,
            ...(ownerId === undefined ? {} : { targetSessionId: ownerId }),
          });
          subagentBufferRef.current.delete(agentId);
        }
      }

      if (ownerId !== undefined) {
        abortControllersRef.current.delete(ownerId);
        // The database is the source of truth at the end of a turn: the
        // server persists the messages it accepted, while the client's copy
        // carries optimistic ids that the delete endpoint cannot use.
        // Reloading also gives the next attempt a clean slate instead of
        // appending to the failed attempt's bubble.
        //
        // The reload must not switch the view — the user may have moved to
        // another session while this turn was running.
        await loadSessionMessages(ownerId, true, { keepCurrentSession: true });
        dispatch({ type: 'STOP_STREAMING', sessionId: ownerId });
        // Apply a terminal `done` that was buffered while this stream's
        // owner was a background session: its tokenStats (including the
        // final t/s) must reach the owner slot before the buffer is
        // discarded, otherwise the slot would keep displaying a frozen
        // live estimate after the user switches back.
        flushBufferedDoneFor(ownerId);
        streamStateRef.current = discardBufferedEvents(streamStateRef.current, ownerId);
      }

      // The failure flag lives on the request record, so it has to be read
      // while the record still exists. Reading it afterwards always says
      // "did not fail", which would throw the turn's retry payload away and
      // leave the Retry button doing nothing.
      const { state: afterEnd, failed: requestFailed } = endRequest(
        streamStateRef.current,
        requestId
      );
      streamStateRef.current = afterEnd;

      // Clear the live value scoped to the OWNER (unscoped fallback when the
      // owner is unknown) — never wipe a different session's badge. A turn
      // that failed also drops the stale end-of-turn rates; a turn that
      // succeeded keeps the ones the server just delivered.
      if (requestFailed) {
        clearTokenRates(ownerId);
      } else {
        clearTpsReadout(ownerId);
      }
      loadSessions();
      // The server titles a new chat once its first turn ends; give it a
      // moment to arrive before refreshing the list again.
      setTimeout(() => loadSessions(), 2000);
      if (!requestFailed) {
        retryPayloadRef.current = null;
        setCanRetry(false);
      }
    },
    [
      dispatch,
      abortControllersRef,
      clearTokenRates,
      clearTpsReadout,
      flushBufferedDoneFor,
      loadSessionMessages,
      loadSessions,
    ]
  );

  /**
   * Retry a failed chat turn using the originally-stored request payload.
   */ const retry = useCallback(async () => {
    const sessionId = streamKeyFor(refs.sessionIdRef.current);
    if (!retryPayloadRef.current || state.streamingSessions.has(sessionId)) return;

    const { body } = retryPayloadRef.current;
    dispatch({ type: 'SET_CURRENT_TPS', tps: null });
    dispatch({ type: 'SET_DONE_REASON', reason: undefined });

    const abortController = new AbortController();
    abortControllersRef.current.set(sessionId, abortController);
    dispatch({ type: 'START_STREAMING', sessionId });

    const requestId = nextRequestIdRef.current++;
    streamStateRef.current = beginRequest(streamStateRef.current, requestId, sessionId);

    try {
      await streamChatTurn({
        body,
        signal: abortController.signal,
        onEvent: (event, data) => handleEvent(event, data, requestId),
        // Clear the banner only once the retry has actually been accepted. If we
        // cleared it optimistically the banner would unmount on click and its
        // own in-flight state would never be visible (cold model loads take
        // seconds). A failure re-dispatches SET_ERROR into the same instance.
        onAccepted: () => dispatch({ type: 'SET_ERROR', error: null }),
      });
    } catch (err: unknown) {
      const details = getStreamErrorDetails(err);
      if (!details) {
        streamStateRef.current = markRequestFailed(streamStateRef.current, requestId);
        dispatch({ type: 'SET_ERROR', error: 'Unknown error' });
      } else if (details.name === 'AbortError') {
        // User clicked Stop — the turn never completed, so the t/s read-out
        // must not keep displaying the previous turn's rate as if it
        // belonged to this one.
        clearTokenRates(ownerOf(streamStateRef.current, requestId));
      } else if (
        details.message.includes('input stream') ||
        details.message.includes('network') ||
        details.message.includes('fetch') ||
        details.name === 'TypeError'
      ) {
        streamStateRef.current = markRequestFailed(streamStateRef.current, requestId);
        dispatch({
          type: 'SET_ERROR',
          error:
            'Connection lost. The stream was interrupted — try again if the response seems incomplete.',
        });
        clearTokenRates(ownerOf(streamStateRef.current, requestId));
      } else {
        streamStateRef.current = markRequestFailed(streamStateRef.current, requestId);
        dispatch({ type: 'SET_ERROR', error: details.message });
        clearTokenRates(ownerOf(streamStateRef.current, requestId));
      }
    } finally {
      await finishTurn(requestId);
    }
  }, [
    dispatch,
    handleEvent,
    clearTokenRates,
    finishTurn,
    refs,
    abortControllersRef,
    state.streamingSessions,
  ]);
  /**
   * Call this after loading a session's messages to replay any SSE events that
   * were buffered while the user was viewing a different session.  No-op when
   * no stream is active or the target session doesn't own the active stream.
   */
  // Which events are replayed when the user switches back to a buffered
  // session is decided by `sseEvents.ts`, where every event the server can
  // send is classified — so a new event cannot silently fall out of the
  // replay set.
  //
  // Replayed:
  //   - Incremental content deltas (chunk, thinking, tool_progress, …)
  //   - done: applies the final authoritative token stats for the session
  //   - approval_request: re-surfaces the approval modal on return so the user
  //     can still approve/reject a pending run_command (the server waits up to
  //     120 s; if already timed out the POST to /api/approve is a harmless no-op)
  // Not replayed (tool_call / tool_result / subagent_output / compact): those
  // messages are flushed to SQLite mid-stream and are reloaded from the
  // database on a session switch — replaying them here would create
  // duplicates.

  const replayBufferedEvents = useCallback(
    (targetSessionId: number | null) => {
      const sessionKey = streamKeyFor(targetSessionId);
      const { state, events: buffered } = takeBufferedEvents(streamStateRef.current, sessionKey);
      streamStateRef.current = state;
      for (const { event, data } of buffered) {
        if (isReplayableEvent(event)) {
          // Pass `sessionKey` as `replayTargetSessionId` so the
          // `subagent_chunk` case can attribute its buffer entry to
          // the right session. Without this, replayed subagent chunks
          // would create orphan entries (sessionId === undefined) that
          // match any subsequent stream's owner in the `finally` block
          // and get flushed against the wrong session.
          handleEvent(event, data, undefined, sessionKey);
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

    const prefix = textBlocks.length > 0 ? `${textBlocks.join('\n\n')}\n\n` : '';
    return { content: prefix + message, images };
  }

  const sendChatMessage = useCallback(
    async (message: string, attachments?: Attachment[]) => {
      const sessionId = streamKeyFor(refs.sessionIdRef.current);
      if (state.streamingSessions.has(sessionId)) return;

      if (!refs.modelRef.current.trim()) {
        dispatch({ type: 'SET_ERROR', error: 'Please select a model first' });
        return;
      }

      const currentMessages = refs.messagesRef.current;

      // Process attachments into message content + images
      const { content, images } = await resolveAttachments(message, attachments ?? []);
      // Capture the wall-clock send time on the user message. The LLM-bound
      // copy of this content is stamped server-side based on the
      // promptTimestamps toggle; the DB row stores the verbatim content
      // plus this timestamp in messages.created_at, so flipping the toggle
      // back on later retroactively exposes the date to the LLM.
      const userMessage: ChatMessage = {
        role: 'user',
        content,
        ...(images.length > 0 ? { images } : {}),
        createdAt: new Date().toISOString(),
      };

      dispatch({ type: 'ADD_MESSAGE', message: userMessage });
      dispatch({ type: 'SET_ERROR', error: null });
      dispatch({ type: 'SET_CURRENT_TPS', tps: null });
      // A new turn must not inherit the previous turn's completion reason, or
      // a stale 'length' would flash the truncation notice over the new reply.
      dispatch({ type: 'SET_DONE_REASON', reason: undefined });

      const abortController = new AbortController();
      abortControllersRef.current.set(sessionId, abortController);
      dispatch({ type: 'START_STREAMING', sessionId });

      // Record which session owns this stream so events can be buffered when
      // the user navigates away and replayed when they switch back.
      const requestId = nextRequestIdRef.current++;
      streamStateRef.current = beginRequest(streamStateRef.current, requestId, sessionId);

      const allMessages = [...currentMessages, userMessage];
      const filteredMessages = allMessages.filter((m) => {
        if (m.role === 'system') return false;
        // Drop display-only tool messages created by the 'tool_call' and
        // 'tool_progress' SSE handlers. Those messages have no real
        // tool_call_id and are not part of the LLM protocol. Keep real tool
        // results that have a non-empty tool_call_id.
        if (
          m.role === 'tool' &&
          (m.tool_call_id === null || m.tool_call_id === undefined || m.tool_call_id === '')
        )
          return false;
        return true;
      });
      const toolMessages = filteredMessages.filter((m) => m.role === 'tool');
      const toolMessagesWithId = toolMessages.filter(
        (m) => m.tool_call_id !== null && m.tool_call_id !== undefined
      ).length;
      trace('sendChatMessage: body', {
        messageCount: filteredMessages.length,
        toolMessageCount: toolMessages.length,
        toolMessagesWithId,
        filteredOut: allMessages.length - filteredMessages.length,
      });
      const bodyObj = {
        messages: filteredMessages,
        model: refs.modelRef.current,
        providerId: refs.activeProviderIdRef.current,
        numCtx: refs.requestedNumCtxRef.current,
        baseUrl: refs.baseUrlRef.current,
        sessionId: refs.sessionIdRef.current,
        yolo: refs.yoloRef.current,
        think: refs.thinkingEnabledRef.current,
        reasoningEffort: refs.reasoningEffortRef.current,
        compactionModel: refs.compactionModelRef.current,
        compactionProviderId: refs.compactionProviderIdRef.current,
        chatTimeoutMs: refs.chatTimeoutMsRef.current,
        webSearch: refs.webSearchRef.current,
        completionMode: refs.completionModeRef.current,
        maxPromptLoopIterations: refs.maxPromptLoopIterationsRef.current,
      };
      retryPayloadRef.current = { body: JSON.stringify(bodyObj) };
      setCanRetry(true);

      try {
        await streamChatTurn({
          body: retryPayloadRef.current!.body,
          signal: abortController.signal,
          onEvent: (event, data) => handleEvent(event, data, requestId),
        });
      } catch (err: unknown) {
        const details = getStreamErrorDetails(err);
        if (!details) {
          streamStateRef.current = markRequestFailed(streamStateRef.current, requestId);
          dispatch({ type: 'SET_ERROR', error: 'Unknown error' });
          clearTokenRates(ownerOf(streamStateRef.current, requestId));
        } else if (details.name === 'AbortError') {
          // User clicked Stop — the turn never completed, so the t/s
          // read-out must not keep displaying the previous turn's rate as
          // if it belonged to this one.
          clearTokenRates(ownerOf(streamStateRef.current, requestId));
        } else if (
          details.message.includes('input stream') ||
          details.message.includes('network') ||
          details.message.includes('fetch') ||
          details.name === 'TypeError'
        ) {
          streamStateRef.current = markRequestFailed(streamStateRef.current, requestId);
          dispatch({
            type: 'SET_ERROR',
            error:
              'Connection lost. The stream was interrupted — try again if the response seems incomplete.',
          });
          clearTokenRates(ownerOf(streamStateRef.current, requestId));
        } else {
          streamStateRef.current = markRequestFailed(streamStateRef.current, requestId);
          dispatch({ type: 'SET_ERROR', error: details.message });
          clearTokenRates(ownerOf(streamStateRef.current, requestId));
        }
      } finally {
        await finishTurn(requestId);
      }
    },
    [
      dispatch,
      handleEvent,
      clearTokenRates,
      finishTurn,
      refs,
      abortControllersRef,
      state.streamingSessions,
    ]
  );
  return { sendChatMessage, retry, handleEvent, replayBufferedEvents, canRetry };
}
