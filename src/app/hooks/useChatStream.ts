'use client';

import { useCallback, useRef, useState } from 'react';

import { type ChatAction, type ChatMessage, useChat } from '@/app/lib/chatStore';
import { retryBodyForSession, streamChatTurn } from '@/app/lib/chatTurn';
import { frameOwner, routeSseEvent, type SseEventData } from '@/app/lib/sseRouting';
import { NEW_SESSION_KEY, streamKeyFor } from '@/app/lib/streamKey';
import {
  beginRequest,
  createStreamState,
  endRequest,
  markRequestFailed,
  migrateSessionKey,
  ownerOf,
  type StreamState,
} from '@/app/lib/streamMachine';
import { type Attachment, langFromFilename } from '@/components/ChatInput';
import { DEFAULT_SESSION_NAME } from '@/constants';

import type { StableRefs, WritableRef } from './useStableRefs';

const trace = (label: string, data?: Record<string, unknown>) => {
  if (process.env.NODE_ENV === 'development') {
    console.warn(`[trace] ${label}`, data ?? {});
  }
};

/**
 * Sub-agent text that is still being coalesced before it is flushed to the
 * store. Keyed by session AND agent: the agent ids are names the model picks
 * ("researcher"), so two conversations running batches at once can use the
 * same one, and one conversation's text must never be flushed into the
 * other's bubble.
 */
interface PendingSubagentText {
  agentId: string;
  sessionId: number | undefined;
  text: string;
  timer: ReturnType<typeof setTimeout> | null;
}

function subagentBufferKey(sessionId: number | undefined, agentId: string): string {
  return `${sessionId ?? ''}\u0000${agentId}`;
}

/** The error a failed turn shows, from whatever its stream threw. */
function turnErrorMessage(err: unknown): string {
  if (!(err instanceof Error)) {
    return 'Unknown error';
  }
  if (
    err.message.includes('input stream') ||
    err.message.includes('network') ||
    err.message.includes('fetch') ||
    err.name === 'TypeError'
  ) {
    return 'Connection lost. The stream was interrupted — try again if the response seems incomplete.';
  }
  return err.message;
}

/**
 * Owns the SSE event dispatcher and the sendChatMessage driver that runs a
 * full streaming chat turn (fetch → SSE parse → dispatch → finally loadSessions).
 *
 * Every event is applied to the session that owns it the moment it arrives.
 * The store routes an action for a session that is not on screen into that
 * session's slot, so a conversation the user comes back to is already
 * exactly what they would have seen had they never left — nothing is held
 * back and replayed. (It used to be: the held events were replayed on top of
 * a fresh database copy that already contained part of them, which
 * duplicated text, lost what streamed in during the reload, swallowed the
 * errors of background turns, and hid the tool call that was still running.)
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
  const { state, dispatch, dispatchBackground } = useChat();

  const nextRequestIdRef = useRef(0);
  // The ownership rules (which turn belongs to which session, which turns
  // failed) live in `streamMachine.ts` as pure functions over one state
  // object.
  const streamStateRef = useRef<StreamState>(createStreamState());
  const subagentBufferRef = useRef<Map<string, PendingSubagentText>>(new Map());

  // ── Retry payloads, one per conversation ───────────────────────────────
  // A failed turn keeps the request it sent so the banner's Retry can send
  // it again. They are kept PER SESSION: a single shared payload let the
  // Retry button in one conversation re-run another conversation's turn, and
  // let any other conversation's successful turn throw it away.
  const retryPayloadsRef = useRef<Map<number, string>>(new Map());
  // Which sessions have one, as state so the banner re-renders when it
  // changes. A turn whose session has been deleted is dropped (the server
  // says so on its error), so the banner never offers a Retry that fails the
  // same way.
  const [retryableSessions, setRetryableSessions] = useState<ReadonlySet<number>>(() => new Set());
  const setRetryPayload = useCallback((sessionKey: number, body: string | null) => {
    if (body === null) {
      if (!retryPayloadsRef.current.delete(sessionKey)) return;
    } else {
      retryPayloadsRef.current.set(sessionKey, body);
    }
    setRetryableSessions(new Set(retryPayloadsRef.current.keys()));
  }, []);
  const canRetry = retryableSessions.has(streamKeyFor(state.currentSessionId));

  // --------------------------------------------------------------------------

  /**
   * Apply an action that belongs to `owner`'s turn.
   *
   * A conversation that is not on screen is updated through the background
   * queue — its updates are applied together once per interval instead of
   * re-rendering the conversation the user is reading for every piece of
   * text that arrives behind it. Everything else is dispatched now, which
   * applies whatever is queued first, so order is preserved either way. The
   * reducer routes by the session on screen at APPLY time, so a conversation
   * that was in the background when its update was queued and on screen by
   * the time it is applied still lands in the right place.
   */
  const dispatchOwned = useCallback(
    (action: ChatAction, owner: number | undefined) => {
      if (owner !== undefined && owner !== streamKeyFor(refs.sessionIdRef.current)) {
        dispatchBackground(action);
      } else {
        dispatch(action);
      }
    },
    [dispatch, dispatchBackground, refs]
  );

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
      dispatchOwned(
        {
          type: 'SET_CURRENT_TPS',
          tps: null,
          ...(targetSessionId === undefined ? {} : { targetSessionId }),
        },
        targetSessionId
      );
    },
    [dispatchOwned]
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
      dispatchOwned(
        {
          type: 'SET_TOKEN_STATS',
          stats: { evalTps: null, promptTps: null, evalTpsEstimated: false },
          ...(targetSessionId === undefined ? {} : { targetSessionId }),
        },
        targetSessionId
      );
    },
    [clearTpsReadout, dispatchOwned]
  );

  /** Push a session's coalesced sub-agent text into the store. */
  const flushSubagentText = useCallback(
    (entry: PendingSubagentText) => {
      if (entry.timer) clearTimeout(entry.timer);
      subagentBufferRef.current.delete(subagentBufferKey(entry.sessionId, entry.agentId));
      dispatchOwned(
        {
          type: 'SUBAGENT_CHUNK',
          agentId: entry.agentId,
          text: entry.text,
          ...(entry.sessionId === undefined ? {} : { targetSessionId: entry.sessionId }),
        },
        entry.sessionId
      );
    },
    [dispatchOwned]
  );

  const handleEvent = useCallback(
    (event: string, data: SseEventData, requestId: number) => {
      // ── session_created moves the turn to its real session id ──────────
      // in every registry at once: the abort controller, the streaming set,
      // the ownership map, the retry payload, the pending sub-agent text and
      // the visible session.
      if (event === 'session_created' && typeof data.sessionId === 'number') {
        const realId: number = data.sessionId;
        if (abortControllersRef.current.has(NEW_SESSION_KEY)) {
          const ctrl = abortControllersRef.current.get(NEW_SESSION_KEY)!;
          abortControllersRef.current.delete(NEW_SESSION_KEY);
          abortControllersRef.current.set(realId, ctrl);
          // The store's streaming set is the single record of which
          // sessions are streaming. The rename is one step: a STOP followed
          // by a START would leave the set momentarily empty, and an empty
          // set clears the pending model switch and the held steer draft.
          // It also moves a new chat the user navigated away from out of
          // the new-chat mirror and into its real session's slot.
          dispatch({
            type: 'RENAME_STREAMING',
            fromSessionId: NEW_SESSION_KEY,
            toSessionId: realId,
          });
        }
        streamStateRef.current = migrateSessionKey(streamStateRef.current, realId);
        for (const entry of subagentBufferRef.current.values()) {
          if (entry.sessionId === NEW_SESSION_KEY || entry.sessionId === undefined) {
            subagentBufferRef.current.delete(subagentBufferKey(entry.sessionId, entry.agentId));
            entry.sessionId = realId;
            subagentBufferRef.current.set(subagentBufferKey(realId, entry.agentId), entry);
          }
        }
        // The stored retry payload has to point at the session this turn was
        // saved to. It was sent without a session id — the server assigned
        // one just now — so a retry would otherwise make the server create a
        // second session for the same chat.
        const pendingRetry = retryPayloadsRef.current.get(NEW_SESSION_KEY);
        if (pendingRetry !== undefined) {
          retryPayloadsRef.current.delete(NEW_SESSION_KEY);
          setRetryPayload(realId, retryBodyForSession(pendingRetry, realId));
        }
        refs.sessionIdRef.current = realId;
        dispatch({ type: 'SET_CURRENT_SESSION', id: realId, adoptNewChat: true });
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
      //
      // Every dispatch carries that owner, and the reducer routes it: the
      // top-level fields when the owner is on screen, its slot otherwise. A
      // `chunk` from stream A can therefore never touch stream B's session,
      // and nothing has to be held back while the user is elsewhere.
      const owner = frameOwner(data.sessionId, ownerOf(streamStateRef.current, requestId));

      // Routing an event into store actions is a pure function, so it can be
      // characterised by tests (scripts/test-sse-routing.mjs). This callback
      // keeps only the parts that need the ownership maps and the timers.
      const outcome = routeSseEvent(event, data, {
        targetSessionId: owner,
        approvalOwner: owner,
        compactOwner: owner,
        doneOwner: owner,
        subagentOwner: owner,
        // The draft of the session this frame belongs to — never another
        // conversation's, so an ack cannot release the wrong draft.
        pendingSteerDraft: owner === undefined ? undefined : refs.steerDraftsRef.current.get(owner),
      });

      if (outcome.markFailed) {
        streamStateRef.current = markRequestFailed(streamStateRef.current, requestId);
      }

      for (const action of outcome.actions) {
        dispatchOwned(action, owner);
      }

      if (outcome.clearedSubagentId) {
        // The server dropped a sub-agent's streamed output because its turn
        // failed and is re-issued. The store action above REPLACED the
        // bubble with the text the server kept, but the text that is still
        // COALESCING for that agent lives here — so its pending flush timer
        // has to be cancelled and the entry dropped, or the failed attempt's
        // text would be appended to the bubble AFTER the clear.
        //
        // Dropping it loses nothing: the server's replacement content
        // already includes those characters (the server counted them when
        // it truncated its own bucket).
        const key = subagentBufferKey(owner, outcome.clearedSubagentId);
        const pending = subagentBufferRef.current.get(key);
        if (pending) {
          if (pending.timer) clearTimeout(pending.timer);
          subagentBufferRef.current.delete(key);
        }
      }

      if (outcome.subagentChunk) {
        const { agentId, text, owner: chunkOwner } = outcome.subagentChunk;
        const key = subagentBufferKey(chunkOwner, agentId);
        let entry = subagentBufferRef.current.get(key);
        if (entry) {
          entry.text += text;
          if (entry.timer) clearTimeout(entry.timer);
        } else {
          entry = { agentId, sessionId: chunkOwner, text, timer: null };
          subagentBufferRef.current.set(key, entry);
        }
        // The timer reads the entry it was given, not a captured session id,
        // so a placeholder entry that was re-pointed at its real session by
        // `session_created` flushes into the real session.
        const pendingEntry = entry;
        pendingEntry.timer = setTimeout(() => flushSubagentText(pendingEntry), 50);
      }

      if (outcome.clearRates) {
        // Clears the live read-out as well.
        clearTokenRates(owner);
      } else if (outcome.clearTps) {
        clearTpsReadout(owner);
      }
    },
    [dispatch, dispatchOwned, clearTokenRates, clearTpsReadout, flushSubagentText, setRetryPayload]
  );

  /**
   * Finish a turn: release everything the turn held, reconcile the
   * transcript with the database, and refresh the session list.
   *
   * Sending a message and retrying a failed one used to end with two copies
   * of this block, and they had drifted. Both drivers go through `runTurn`,
   * which calls this, so the two cannot drift apart again.
   */
  const finishTurn = useCallback(
    async (requestId: number) => {
      const ownerId = ownerOf(streamStateRef.current, requestId);

      // Flush the sub-agent text that is still coalescing, against the
      // session that owns it.
      for (const entry of subagentBufferRef.current.values()) {
        if (entry.sessionId === ownerId || entry.sessionId === undefined) {
          flushSubagentText(entry);
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
      // Only THIS session's retry payload is settled by this turn.
      if (!requestFailed && ownerId !== undefined) {
        setRetryPayload(ownerId, null);
      }
    },
    [
      dispatch,
      abortControllersRef,
      clearTokenRates,
      clearTpsReadout,
      flushSubagentText,
      loadSessionMessages,
      loadSessions,
      setRetryPayload,
    ]
  );

  /**
   * Run one streaming turn for `sessionKey` with an already-built request
   * body, from registering it to releasing it.
   *
   * Every store write a failure makes is aimed at the session that owns the
   * turn — read from the ownership record, so a new chat that the server
   * saved mid-turn is addressed by its real id. A connection that drops
   * while the user is reading another conversation therefore shows its
   * error in its own conversation, not in the one on screen.
   */
  const runTurn = useCallback(
    async (sessionKey: number, body: string, onAccepted?: (owner: number) => void) => {
      const abortController = new AbortController();
      abortControllersRef.current.set(sessionKey, abortController);
      dispatch({ type: 'START_STREAMING', sessionId: sessionKey });

      const requestId = nextRequestIdRef.current++;
      streamStateRef.current = beginRequest(streamStateRef.current, requestId, sessionKey);
      const currentOwner = () => ownerOf(streamStateRef.current, requestId) ?? sessionKey;

      try {
        await streamChatTurn({
          body,
          signal: abortController.signal,
          onEvent: (event, data) => handleEvent(event, data, requestId),
          ...(onAccepted ? { onAccepted: () => onAccepted(currentOwner()) } : {}),
        });
      } catch (err: unknown) {
        const owner = currentOwner();
        if (!(err instanceof Error && err.name === 'AbortError')) {
          streamStateRef.current = markRequestFailed(streamStateRef.current, requestId);
          dispatch({ type: 'SET_ERROR', error: turnErrorMessage(err), targetSessionId: owner });
        }
        // A turn that was stopped or failed never completed, so the t/s
        // read-out must not keep displaying the previous turn's rate as if
        // it belonged to this one.
        clearTokenRates(owner);
      } finally {
        await finishTurn(requestId);
      }
    },
    [dispatch, handleEvent, clearTokenRates, finishTurn, abortControllersRef]
  );

  /**
   * Retry the visible conversation's failed turn using the request payload
   * it stored.
   */
  const retry = useCallback(async () => {
    const sessionKey = streamKeyFor(refs.sessionIdRef.current);
    const stored = retryPayloadsRef.current.get(sessionKey);
    if (stored === undefined || state.streamingSessions.has(sessionKey)) return;
    // The stored body is replayed as it was. It carries no context window:
    // the server decides the window itself, from the setting as it is when
    // the retry arrives, so a setting lowered since cannot be undone by a replay.
    const body = stored;

    // The previous turn's rate described that turn — retire it (see the
    // note in sendChatMessage).
    clearTokenRates(sessionKey);
    dispatch({ type: 'SET_DONE_REASON', reason: undefined, targetSessionId: sessionKey });

    // Clear the banner only once the retry has actually been accepted. If we
    // cleared it optimistically the banner would unmount on click and its
    // own in-flight state would never be visible (cold model loads take
    // seconds). A failure re-dispatches SET_ERROR into the same session. The
    // clear is aimed at the retried session: the user may have moved on to
    // another conversation by the time the server accepts it.
    await runTurn(sessionKey, body, (owner) =>
      dispatch({ type: 'SET_ERROR', error: null, targetSessionId: owner })
    );
  }, [dispatch, clearTokenRates, runTurn, refs, state.streamingSessions]);

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
      // ── Pin the turn to the conversation it was typed in ──────────────
      // Everything that identifies the turn is read NOW, before the first
      // `await`. Uploading a large text file or a PDF takes seconds, and the
      // user can switch conversations meanwhile; reading the session id
      // after the upload sent the first conversation's history under the
      // second conversation's id, so the server saved it into — and the
      // model answered in — the wrong conversation.
      const originSessionId = refs.sessionIdRef.current;
      const sessionKey = streamKeyFor(originSessionId);
      if (state.streamingSessions.has(sessionKey)) return;

      if (!refs.modelRef.current.trim()) {
        dispatch({ type: 'SET_ERROR', error: 'Choose a model in Settings to start chatting.' });
        return;
      }

      const currentMessages = refs.messagesRef.current;
      const settings = {
        model: refs.modelRef.current,
        providerId: refs.activeProviderIdRef.current,
        baseUrl: refs.baseUrlRef.current,
        sessionId: originSessionId,
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

      // Every write below is aimed at the origin conversation, which may no
      // longer be the one on screen.
      dispatch({ type: 'ADD_MESSAGE', message: userMessage, targetSessionId: sessionKey });
      dispatch({ type: 'SET_ERROR', error: null, targetSessionId: sessionKey });
      // The previous turn's rate described THAT turn. It stays on screen
      // between turns, but a new turn starting must retire it — otherwise
      // the badge shows the last reply's rate as if it were live, for the
      // whole prompt-processing phase.
      clearTokenRates(sessionKey);
      // A new turn must not inherit the previous turn's completion reason, or
      // a stale 'length' would flash the truncation notice over the new reply.
      dispatch({ type: 'SET_DONE_REASON', reason: undefined, targetSessionId: sessionKey });

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
      const body = JSON.stringify({ messages: filteredMessages, ...settings });
      setRetryPayload(sessionKey, body);

      await runTurn(sessionKey, body);
    },
    [dispatch, clearTokenRates, runTurn, setRetryPayload, refs, state.streamingSessions]
  );
  return { sendChatMessage, retry, canRetry };
}
