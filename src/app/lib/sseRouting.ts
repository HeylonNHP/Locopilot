import type { ChatAction, DoneReason } from '@/app/lib/chatStore';
import type { SseEventPayloadMap } from '@/types/sse';

import { positiveInteger } from '@/app/lib/contextWindow';
import { formatCompactionReceipt } from '@/services/compact/receipt';

/**
 * Routing of one SSE event into the store actions it produces.
 *
 * The switch that used to live inside `useChatStream` is here as a pure
 * function: it reads only its arguments and returns the actions to dispatch
 * plus the few side effects the caller has to perform (coalescing a
 * sub-agent chunk, marking a failed turn, clearing a t/s read-out). Keeping
 * it free of refs and timers is what makes the routing testable — the
 * characterisation suite in `tests/sse-routing.test.mjs` asserts the exact
 * action sequence for every event type.
 *
 * Ownership (which session an event belongs to) is decided by the caller and
 * passed in through `SseRouteContext`, because the four events that route
 * differently — `approval_request`, `compact`, `done` and `subagent_chunk` —
 * each have their own rule.
 */

type SseEventPayload = SseEventPayloadMap[keyof SseEventPayloadMap];

type UnionToIntersection<U> = (U extends unknown ? (k: U) => void : never) extends (
  k: infer I
) => void
  ? I
  : never;

/**
 * The identity the server stamps on every frame.
 *
 * `sessionId` is the session the turn belongs to, which is null until the
 * server has created one for a brand-new chat.
 */
export interface SseFrameEnvelope {
  /** The turn that produced the frame. */
  streamId?: string;
  /** The session the frame belongs to. */
  sessionId?: number | null;
  /** Frame counter within the turn. */
  seq?: number;
}

/** Parsed SSE event payload — the permissive bag shape the wire delivers. */
export type SseEventData = Partial<UnionToIntersection<SseEventPayload>> & SseFrameEnvelope;

const DONE_REASONS = ['stop', 'length', 'load', 'unload', 'unknown'] as const;

export function isDoneReason(value: string): value is DoneReason {
  return (DONE_REASONS as readonly string[]).includes(value);
}

/**
 * Everything the router needs to know about the world outside the event.
 *
 * Every field is resolved by the caller, which is the only place that knows
 * about the ownership maps, the visible session and the held steer draft.
 */
export interface SseRouteContext {
  /** Owner for ordinary dispatches. `undefined` keeps the legacy path where the action lands on whichever session is visible. */
  targetSessionId?: number | undefined;
  /** Owner for `approval_request`. */
  approvalOwner?: number | undefined;
  /** Owner for `compact`. */
  compactOwner?: number | undefined;
  /** Owner for the `done` reason. */
  doneOwner?: number | undefined;
  /** Owner for a sub-agent chunk, so its buffered text is flushed against the right session. */
  subagentOwner?: number | undefined;
  /** The steer draft of the OWNING session, which the server may have applied. */
  pendingSteerDraft?: { id: string; text: string } | null | undefined;
}

/** What the caller has to do after routing an event. */
export interface SseRouteOutcome {
  /** Store actions to dispatch, in order. */
  actions: ChatAction[];
  /** Sub-agent text that must be coalesced and flushed by the caller. */
  subagentChunk?: { agentId: string; text: string; owner?: number };
  /**
   * The sub-agent whose streamed output was dropped by the server (its
   * turn failed with a transient provider error and is re-issued). The
   * caller owns the coalescing buffer, so it has to drop that agent's
   * pending text too — otherwise the pending flush timer would append
   * the failed attempt's text to the bubble the store just emptied.
   */
  clearedSubagentId?: string;
  /** The turn failed, so its retry payload must be preserved. */
  markFailed?: boolean;
  /** The live t/s read-out for the routed owner must be cleared. */
  clearTps?: boolean;
  /**
   * The end-of-turn rate fields must be cleared as well — for a turn that
   * failed, the previous turn's rates must not keep displaying as if they
   * belonged to it.
   */
  clearRates?: boolean;
}

const trace = (label: string, data?: Record<string, unknown>) => {
  if (process.env.NODE_ENV === 'development') {
    console.warn(`[trace] ${label}`, data ?? {});
  }
};

/**
 * The session a frame belongs to.
 *
 * The server stamps every frame with the session its turn belongs to, so
 * that answer wins. The client's own record of which session a turn belongs
 * to is the fallback, used only for frames that arrive before the server
 * has created the session.
 */
export function frameOwner(
  frameSessionId: number | null | undefined,
  fallback: number | undefined
): number | undefined {
  return typeof frameSessionId === 'number' ? frameSessionId : fallback;
}

/**
 * Route one SSE event into store actions.
 *
 * @param event  the SSE event name
 * @param data   the parsed payload
 * @param ctx    the ownership and ambient values the caller resolved
 */
export function routeSseEvent(
  event: string,
  data: SseEventData,
  ctx: SseRouteContext
): SseRouteOutcome {
  const actions: ChatAction[] = [];
  const {
    targetSessionId,
    approvalOwner,
    compactOwner,
    doneOwner,
    subagentOwner,
    pendingSteerDraft,
  } = ctx;

  switch (event) {
    case 'thinking': {
      actions.push({
        type: 'APPLY_ASSISTANT_DELTA',
        ...(typeof data.content === 'string' ? { thinking: data.content } : {}),
        ...(targetSessionId === undefined ? {} : { targetSessionId }),
      });
      break;
    }

    case 'chunk': {
      actions.push({
        type: 'APPLY_ASSISTANT_DELTA',
        ...(typeof data.content === 'string' ? { content: data.content } : {}),
        ...(targetSessionId === undefined ? {} : { targetSessionId }),
      });
      break;
    }

    case 'tool_call': {
      actions.push({
        type: 'ADD_MESSAGE',
        message: {
          role: 'tool',
          content: `🔧 **${data.name ?? ''}**\n\`\`\`json\n${JSON.stringify(data.arguments, null, 2)}\n\`\`\``,
          ...(data.name === undefined ? {} : { name: data.name }),
        },
        ...(targetSessionId === undefined ? {} : { targetSessionId }),
      });
      trace('tool_call event', { name: data.name, hasToolCallId: false });
      break;
    }

    case 'approval_request': {
      actions.push({
        type: 'SHOW_APPROVAL',
        command: {
          name: data.toolName ?? data.name ?? '',
          args: data.args ?? {},
          ...(typeof data.toolCallName === 'string' ? { toolCallName: data.toolCallName } : {}),
        },
        ...(data.requestId === undefined ? {} : { requestId: data.requestId }),
        ...(approvalOwner === undefined ? {} : { targetSessionId: approvalOwner }),
      });
      break;
    }

    case 'tool_result': {
      actions.push({
        type: 'ADD_MESSAGE',
        message: {
          role: 'tool',
          content: `✅ **${data.name ?? ''}** (${data.duration ?? 0}ms)\n\n\`\`\`\n${data.result ?? ''}\n\`\`\``,
          ...(data.name === undefined ? {} : { name: data.name }),
          ...(data.toolCallId === undefined ? {} : { tool_call_id: data.toolCallId }),
        },
        ...(targetSessionId === undefined ? {} : { targetSessionId }),
      });
      // The run_subagents batch this result closes out is no longer
      // running anything — clear the steer-target toggle's "sub-agent
      // is active" signal. Sub-agents run sequentially, so there is
      // never more than one to disambiguate.
      if (data.name === 'run_subagents') {
        actions.push({
          type: 'SET_ACTIVE_SUBAGENT',
          agentId: null,
          ...(targetSessionId === undefined ? {} : { targetSessionId }),
        });
      }
      trace('tool_result event', {
        name: data.name,
        toolCallId: data.toolCallId,
        contentLength: (data.result ?? '').length,
      });
      break;
    }

    case 'tool_progress': {
      actions.push({
        type: 'APPEND_TOOL_PROGRESS',
        ...(data.name === undefined ? {} : { name: data.name }),
        content: data.message ?? data.content ?? String(data),
        ...(targetSessionId === undefined ? {} : { targetSessionId }),
      });
      trace('tool_progress event', {
        name: data.name,
        contentPreview: (data.message ?? '').slice(0, 80),
      });
      break;
    }

    case 'subagent_output': {
      const outputAgentId = typeof data.agentId === 'string' ? data.agentId : '__subagent__';
      actions.push(
        {
          type: 'SUBAGENT_OUTPUT',
          agentId: outputAgentId,
          message: typeof data.message === 'string' ? data.message : String(data.message ?? ''),
          ...(targetSessionId === undefined ? {} : { targetSessionId }),
        },
        {
          type: 'SET_ACTIVE_SUBAGENT',
          agentId: outputAgentId,
          ...(targetSessionId === undefined ? {} : { targetSessionId }),
        }
      );
      break;
    }

    case 'subagent_chunk': {
      const agentId = typeof data.agentId === 'string' ? data.agentId : '__subagent__';
      const text = typeof data.text === 'string' ? data.text : String(data.text ?? '');
      actions.push({
        type: 'SET_ACTIVE_SUBAGENT',
        agentId,
        ...(subagentOwner === undefined ? {} : { targetSessionId: subagentOwner }),
      });
      // The text itself is coalesced by the caller, which owns the buffer
      // and the flush timer.
      return {
        actions,
        subagentChunk: {
          agentId,
          text,
          ...(subagentOwner === undefined ? {} : { owner: subagentOwner }),
        },
      };
    }

    case 'clear_subagent': {
      // The sub-agent's turn failed with a transient provider error and is
      // re-issued, so the text the failed attempt streamed must go — but the
      // text of the agent's EARLIER turns must STAY (a sub-agent is a
      // multi-turn loop and only the re-issued turn streams its text
      // again).
      //
      // The server already worked out what remains and sends it in the
      // event, so the client REPLACES the bubble's content with it. That
      // also makes the live bubble byte-identical to the text the server
      // persists for that agent.
      const agentId = typeof data.agentId === 'string' ? data.agentId : '__subagent__';
      const content = typeof data.content === 'string' ? data.content : String(data.content ?? '');
      actions.push(
        {
          type: 'CLEAR_SUBAGENT_CONTENT',
          agentId,
          content,
          ...(targetSessionId === undefined ? {} : { targetSessionId }),
        },
        {
          type: 'SET_ACTIVE_SUBAGENT',
          agentId,
          ...(targetSessionId === undefined ? {} : { targetSessionId }),
        }
      );
      // The caller owns the coalescing buffer, so it has to drop this
      // agent's pending text — the store action alone would leave the
      // failed attempt's partial text to be flushed AFTER the clear. The
      // text that is dropped is part of the `content` the server sent, so
      // nothing is lost by dropping it.
      return { actions, clearedSubagentId: agentId };
    }

    case 'status': {
      if (data.tokensUsed !== undefined && data.tokensUsed !== null) {
        actions.push({
          type: 'SET_TOKEN_STATS',
          stats: {
            totalTokens: data.tokensUsed,
            tokenLimit: data.tokenLimit ?? 0,
            promptEvalCount: 0,
            evalCount: data.tokensUsed,
            isEstimated: data.isEstimated ?? false,
            // The server reports the model's runtime cap on every
            // status event. Thread it through so the Settings
            // modal can decide whether to show the "capped by
            // model limit" row without conflating it with the
            // client's default-effective value before any server
            // response has arrived.
            // An absent field says nothing; only an explicit `null` is the
            // server saying it knows no maximum.
            ...(data.modelContextLimit === undefined
              ? {}
              : { modelContextLimit: data.modelContextLimit }),
          },
          ...(targetSessionId === undefined ? {} : { targetSessionId }),
        });
      }
      if (data.tps !== undefined) {
        actions.push({
          type: 'SET_CURRENT_TPS',
          tps: data.tps,
          ...(targetSessionId === undefined ? {} : { targetSessionId }),
        });
      }
      // The server emits a `vision_unsupported` status phase when
      // a 400 indicates the active model rejected image input. The
      // server has already folded the discovery into its
      // per-(baseUrl, modelName) vision cache, so the client only
      // needs to update its own display state for the warning UI.
      // Any other phase is left alone — visionState is initialized
      // to 'unknown' and updated only on this signal.
      const { phase } = data;
      if (phase === 'vision_unsupported') {
        actions.push({ type: 'SET_VISION_STATE', state: 'unsupported' });
      }
      // The running turn has taken a requested model switch on board.
      // The server re-resolved vision support for the new model, so the
      // previous model's verdict no longer applies — reset it to
      // 'unknown' and let the next 400-driven discovery speak.
      if (phase === 'model_switched') {
        // The pending flag belongs to the session whose turn took the switch.
        if (targetSessionId !== undefined) {
          actions.push({
            type: 'SET_MODEL_SWITCH_PENDING',
            sessionId: targetSessionId,
            pending: false,
          });
        }
        actions.push({ type: 'SET_VISION_STATE', state: 'unknown' });
      }
      // The server has spliced a queued steering message into the
      // conversation. Only now — not when the send was first accepted
      // — do we echo it into the transcript and release the held
      // draft, matching on `steerId` so a stale ack from an earlier
      // draft (e.g. after a fast-follow second steer) can't clear the
      // wrong one.
      if (phase === 'steer_applied') {
        const { steerId } = data;
        // The draft is the owning session's, so an ack can only ever release
        // the draft of the conversation whose turn sent it.
        if (
          pendingSteerDraft &&
          pendingSteerDraft.id === steerId &&
          targetSessionId !== undefined
        ) {
          actions.push(
            {
              type: 'ADD_MESSAGE',
              message: { role: 'user', content: pendingSteerDraft.text },
              targetSessionId,
            },
            { type: 'SET_STEER_DRAFT', sessionId: targetSessionId, draft: null }
          );
        }
      }
      break;
    }

    case 'compact_progress': {
      if (typeof data.message === 'string') {
        actions.push({
          type: 'COMPACT_PROGRESS',
          message: data.message,
          ...(targetSessionId === undefined ? {} : { targetSessionId }),
        });
      }
      break;
    }

    case 'compact': {
      // Clear stale compaction phases so the streaming indicator
      // switches back to "Streaming..." once compaction finishes
      // and the model resumes generating.
      actions.push({
        type: 'CLEAR_COMPACT_PROGRESS',
        ...(targetSessionId === undefined ? {} : { targetSessionId }),
      });

      // Guard SET_MESSAGES and SET_TOKEN_STATS with the owning session so a
      // compaction that completes after the user has switched sessions cannot
      // overwrite the newly-viewed session's message list or token stats.
      if (Array.isArray(data.messages)) {
        actions.push({
          type: 'SET_MESSAGES',
          messages: data.messages,
          ...(compactOwner === undefined ? {} : { targetSessionId: compactOwner }),
        });
      }
      // The window this history now has to fit. The server sends it with the
      // event (it is the window the NEXT turn runs with, which the client
      // cannot derive when a provider clamps the configured value). A frame
      // that carries none (an older server) leaves the limit UNKNOWN — the
      // client no longer substitutes its own setting or a default, because a
      // stand-in written here was promoted into `effectiveNumCtx` as if the
      // server had reported it.
      const tokenLimit = positiveInteger(data.tokenLimit);
      if (typeof data.stats?.newTokenCount === 'number') {
        actions.push({
          type: 'SET_TOKEN_STATS',
          stats: {
            promptEvalCount: data.stats.newTokenCount,
            evalCount: 0,
            totalTokens: data.stats.newTokenCount,
            ...(tokenLimit === null ? {} : { tokenLimit }),
          },
          ...(compactOwner === undefined ? {} : { targetSessionId: compactOwner }),
        });
      } else {
        actions.push({
          type: 'CLEAR_TOKEN_STATS',
          ...(compactOwner === undefined ? {} : { targetSessionId: compactOwner }),
        });
      }
      // The same receipt the manual `/compact` shows, built by the same pure
      // formatter — the two paths used to word this event differently.
      const receipt = formatCompactionReceipt({
        oldTokenCount: data.stats?.oldTokenCount ?? null,
        newTokenCount: data.stats?.newTokenCount ?? null,
        tokenLimit,
        automatic: true,
      });
      actions.push({
        type: 'ADD_MESSAGE',
        message: { role: 'system', content: receipt.text },
        ...(compactOwner === undefined ? {} : { targetSessionId: compactOwner }),
      });
      // A compaction that produced a history still too large for the window is
      // the one outcome the user has to act on, and it used to be silent here.
      // It goes in its OWN bubble so the status line stays one line.
      if (receipt.warning !== null) {
        actions.push({
          type: 'ADD_MESSAGE',
          message: { role: 'system', content: receipt.warning },
          ...(compactOwner === undefined ? {} : { targetSessionId: compactOwner }),
        });
      }
      break;
    }

    case 'done': {
      // Do NOT call SET_CURRENT_SESSION here. If the user switched sessions
      // while a stream was running, dispatching SET_CURRENT_SESSION(A) would
      // forcibly snap the UI back to session A against the user's will.
      // session_created already handles new-session ID assignment; for
      // existing sessions this dispatch was always a redundant no-op at best.
      // A background session's final tokenStats land in its slot and are on
      // screen when the user returns.
      if (data.tokenStats) {
        actions.push({
          type: 'SET_TOKEN_STATS',
          stats: data.tokenStats,
          ...(targetSessionId === undefined ? {} : { targetSessionId }),
        });
      }
      const doneToolCalls = (data as { tool_calls?: Array<{ id?: string }> }).tool_calls;
      trace('done event', {
        hasToolCalls: !!doneToolCalls?.length,
        toolCallCount: doneToolCalls?.length ?? 0,
        toolCallIds: doneToolCalls?.map((tc) => tc.id),
      });
      if (typeof data.doneReason === 'string') {
        // Normalize the server-side value to our DoneReason union. The server
        // coerces missing values to 'stop' and is the source of truth for
        // valid values; this is purely defensive.
        const { doneReason } = data;
        const reason: DoneReason = isDoneReason(doneReason) ? doneReason : 'unknown';
        actions.push({
          type: 'SET_DONE_REASON',
          reason,
          ...(doneOwner === undefined ? {} : { targetSessionId: doneOwner }),
        });
      }
      // The live rough estimate is superseded by the authoritative
      // tokenStats just applied. Clear it scoped to the owning session —
      // an unscoped clear would wipe the VISIBLE session's badge when a
      // background stream finishes.
      //
      // Only the live read-out is cleared: the end-of-turn rates in
      // `tokenStats` were just delivered by the server and are the numbers
      // the user wants to see.
      return { actions, clearTps: true };
    }

    case 'error': {
      // LLM / network failure during streaming. Mark the request
      // as failed (so the user's retry payload is preserved)
      // and surface the message to the owning session.
      const errorMessage = typeof data.message === 'string' ? data.message : 'Unknown error';
      if (targetSessionId === undefined) {
        actions.push({ type: 'SET_ERROR', error: errorMessage });
      } else {
        actions.push({ type: 'SET_ERROR', error: errorMessage, targetSessionId });
      }
      // An errored turn has no t/s of its own — clear both the live
      // value and any previous turn's end-of-turn rate (the store merge
      // would otherwise keep displaying the old rate).
      //
      // A turn whose session no longer exists is the exception: retrying
      // would fail exactly the same way, so the turn is not marked as
      // failed and its retry payload is dropped.
      return {
        actions,
        markFailed: !data.sessionMissing,
        clearTps: true,
        clearRates: true,
      };
    }

    case 'write_error': {
      // Persistence failure for a session-messages write. Surface the
      // message to the user; the DB and the LLM-observed in-memory
      // state have diverged. Marking the request as failed prevents
      // the retry payload from being cleared so the user can retry.
      const writeErrorMessage =
        typeof data.message === 'string'
          ? `Failed to save message to database: ${data.message}`
          : 'Failed to save message to database: Unknown error';
      if (targetSessionId === undefined) {
        actions.push({ type: 'SET_ERROR', error: writeErrorMessage });
      } else {
        actions.push({ type: 'SET_ERROR', error: writeErrorMessage, targetSessionId });
      }
      // A persistence failure is still a failed turn as far as the t/s
      // read-out is concerned — clear both the live value and any stale
      // end-of-turn rate.
      return { actions, markFailed: true, clearTps: true, clearRates: true };
    }

    case 'clear_assistant': {
      actions.push({
        type: 'REMOVE_LAST_ASSISTANT',
        ...(targetSessionId === undefined ? {} : { targetSessionId }),
      });
      break;
    }

    default: {
      break;
    }
  }

  return { actions };
}
