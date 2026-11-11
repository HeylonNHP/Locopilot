/**
 * Characterisation tests for SSE event routing (src/app/lib/sseRouting.ts).
 *
 * No network, no live server, no React. The router is a pure function, so the
 * exact store actions it produces for every event type can be pinned here.
 *
 * Regression focus: the routing used to live inside the `useChatStream` hook,
 * where it was untestable and where four different events (`approval_request`,
 * `compact`, `done`, `subagent_chunk`) each resolved "which session owns this"
 * by a different rule. These tests pin the action sequence for each event in
 * both the targeted and the untargeted (legacy "whatever is visible") shape,
 * so the ownership rules can be changed deliberately instead of accidentally.
 *
 * `clear_subagent` is the newest of them: the server dropped a sub-agent’s
 * streamed output (its turn failed with a transient provider error and is
 * re-issued), so the client has to REPLACE the agent’s bubble with the text
 * the server kept AND drop the text that is still coalescing for that
 * agent.
 */

import { describe, expect, test } from '@jest/globals';

import { frameOwner, routeSseEvent } from '../src/app/lib/sseRouting.ts';

const OWNED = { targetSessionId: 7 };
const UNOWNED = {};

/** The action sequence a routing call produced. */
function actionsFor(event, data, ctx = OWNED) {
  return routeSseEvent(event, data, ctx).actions;
}

describe('content deltas', () => {
  test('chunk targets the owning session', () => {
    expect(actionsFor('chunk', { content: 'hello' })).toStrictEqual([
      { type: 'APPLY_ASSISTANT_DELTA', content: 'hello', targetSessionId: 7 },
    ]);
  });

  test('chunk without an owner omits targetSessionId entirely', () => {
    expect(actionsFor('chunk', { content: 'hello' }, UNOWNED)).toStrictEqual([
      { type: 'APPLY_ASSISTANT_DELTA', content: 'hello' },
    ]);
  });

  test('chunk without content produces an empty delta', () => {
    expect(actionsFor('chunk', {}, UNOWNED)).toStrictEqual([{ type: 'APPLY_ASSISTANT_DELTA' }]);
  });

  test('thinking targets the owning session', () => {
    expect(actionsFor('thinking', { content: 'hmm' })).toStrictEqual([
      { type: 'APPLY_ASSISTANT_DELTA', thinking: 'hmm', targetSessionId: 7 },
    ]);
  });

  test('clear_assistant removes the last assistant message', () => {
    expect(actionsFor('clear_assistant', {})).toStrictEqual([
      { type: 'REMOVE_LAST_ASSISTANT', targetSessionId: 7 },
    ]);
  });
});

describe('tool events', () => {
  test('tool_call renders the tool bubble', () => {
    expect(
      actionsFor('tool_call', { name: 'read_file', arguments: { path: 'a.ts' } })
    ).toStrictEqual([
      {
        type: 'ADD_MESSAGE',
        message: {
          role: 'tool',
          content: '🔧 **read_file**\n```json\n{\n  "path": "a.ts"\n}\n```',
          name: 'read_file',
        },
        targetSessionId: 7,
      },
    ]);
  });

  test('tool_result renders the result bubble', () => {
    expect(
      actionsFor('tool_result', { name: 'read_file', result: 'ok', duration: 12 })
    ).toStrictEqual([
      {
        type: 'ADD_MESSAGE',
        message: {
          role: 'tool',
          content: '✅ **read_file** (12ms)\n\n```\nok\n```',
          name: 'read_file',
        },
        targetSessionId: 7,
      },
    ]);
  });

  test('a finished run_subagents batch clears the steer-target toggle of ITS session', () => {
    const actions = actionsFor('tool_result', {
      name: 'run_subagents',
      result: 'done',
      duration: 5,
    });
    expect(actions).toHaveLength(2);
    expect(actions[1]).toStrictEqual({
      type: 'SET_ACTIVE_SUBAGENT',
      agentId: null,
      targetSessionId: 7,
    });
  });

  test('tool_progress appends to the running tool', () => {
    expect(actionsFor('tool_progress', { name: 'read_file', message: 'reading' })).toStrictEqual([
      { type: 'APPEND_TOOL_PROGRESS', name: 'read_file', content: 'reading', targetSessionId: 7 },
    ]);
  });
});

describe('sub-agent events', () => {
  test('subagent_output emits the output and marks the agent active', () => {
    expect(actionsFor('subagent_output', { agentId: 'research', message: 'done' })).toStrictEqual([
      { type: 'SUBAGENT_OUTPUT', agentId: 'research', message: 'done', targetSessionId: 7 },
      { type: 'SET_ACTIVE_SUBAGENT', agentId: 'research', targetSessionId: 7 },
    ]);
  });

  test('subagent_chunk is handed back for coalescing, not dispatched', () => {
    const outcome = routeSseEvent(
      'subagent_chunk',
      { agentId: 'research', text: 'part' },
      {
        targetSessionId: 7,
        subagentOwner: 9,
      }
    );
    expect(outcome.actions).toStrictEqual([
      { type: 'SET_ACTIVE_SUBAGENT', agentId: 'research', targetSessionId: 9 },
    ]);
    expect(outcome.subagentChunk).toStrictEqual({ agentId: 'research', text: 'part', owner: 9 });
  });

  test('subagent_chunk without an owner omits the owner', () => {
    const outcome = routeSseEvent(
      'subagent_chunk',
      { agentId: 'research', text: 'part' },
      {
        targetSessionId: 7,
      }
    );
    expect(outcome.subagentChunk).toStrictEqual({ agentId: 'research', text: 'part' });
  });

  test('clear_subagent replaces the agent’s bubble with the text that remains', () => {
    // A sub-agent’s turn that failed with a transient provider error is
    // re-issued, so the text the failed attempt streamed has to go — but the
    // text of the agent’s EARLIER turns stays, and the server is the one
    // that knows what remains. It sends that text with the event, so the
    // client REPLACES the bubble with it.
    expect(actionsFor('clear_subagent', { agentId: 'research', content: 'KEPT' })).toStrictEqual([
      { type: 'CLEAR_SUBAGENT_CONTENT', agentId: 'research', content: 'KEPT', targetSessionId: 7 },
      { type: 'SET_ACTIVE_SUBAGENT', agentId: 'research', targetSessionId: 7 },
    ]);
  });

  test('clear_subagent without an owner omits targetSessionId entirely', () => {
    expect(
      actionsFor('clear_subagent', { agentId: 'research', content: 'KEPT' }, UNOWNED)
    ).toStrictEqual([
      { type: 'CLEAR_SUBAGENT_CONTENT', agentId: 'research', content: 'KEPT' },
      { type: 'SET_ACTIVE_SUBAGENT', agentId: 'research' },
    ]);
  });

  test('clear_subagent without content clears the bubble to nothing', () => {
    // A frame from an older server carries no content: the bubble is emptied
    // rather than left as it was.
    expect(actionsFor('clear_subagent', { agentId: 'research' })).toStrictEqual([
      { type: 'CLEAR_SUBAGENT_CONTENT', agentId: 'research', content: '', targetSessionId: 7 },
      { type: 'SET_ACTIVE_SUBAGENT', agentId: 'research', targetSessionId: 7 },
    ]);
  });

  test('clear_subagent reports the cleared agent so the caller can drop its buffer', () => {
    // The caller owns the coalescing buffer: the store action alone would
    // leave the failed attempt’s pending text to be flushed AFTER the clear.
    const outcome = routeSseEvent(
      'clear_subagent',
      { agentId: 'research', content: 'KEPT' },
      OWNED
    );
    expect(outcome.clearedSubagentId).toBe('research');
  });
});

describe('approvals', () => {
  test('approval_request routes to the approval owner', () => {
    expect(
      actionsFor(
        'approval_request',
        { requestId: 'r1', toolName: 'run_command', args: { command: 'ls' } },
        { targetSessionId: 7, approvalOwner: 9 }
      )
    ).toStrictEqual([
      {
        type: 'SHOW_APPROVAL',
        command: { name: 'run_command', args: { command: 'ls' } },
        requestId: 'r1',
        targetSessionId: 9,
      },
    ]);
  });

  test('approval_request without an owner stays on the visible session', () => {
    const [action] = actionsFor(
      'approval_request',
      { requestId: 'r1', toolName: 'run_command', args: {} },
      { targetSessionId: 7 }
    );
    expect('targetSessionId' in action).toBe(false);
  });
});

describe('status', () => {
  test('status with tokens updates the stats and the live rate', () => {
    expect(actionsFor('status', { tokensUsed: 120, tokenLimit: 4096, tps: 30 })).toStrictEqual([
      {
        type: 'SET_TOKEN_STATS',
        stats: {
          totalTokens: 120,
          tokenLimit: 4096,
          promptEvalCount: 0,
          evalCount: 120,
          isEstimated: false,
        },
        targetSessionId: 7,
      },
      { type: 'SET_CURRENT_TPS', tps: 30, targetSessionId: 7 },
    ]);
  });

  test('a status without a model maximum says nothing about it; an explicit null says "none"', () => {
    const stats = (data) => actionsFor('status', data)[0].stats;
    expect('modelContextLimit' in stats({ tokensUsed: 1, tokenLimit: 4096 })).toBeFalsy();
    expect(
      stats({ tokensUsed: 1, tokenLimit: 4096, modelContextLimit: null }).modelContextLimit
    ).toBeNull();
    expect(
      stats({ tokensUsed: 1, tokenLimit: 4096, modelContextLimit: 8192 }).modelContextLimit
    ).toBe(8192);
  });

  test('status without tokens leaves the stats alone', () => {
    expect(actionsFor('status', { tps: 12 })).toStrictEqual([
      { type: 'SET_CURRENT_TPS', tps: 12, targetSessionId: 7 },
    ]);
  });

  test('vision_unsupported marks the model as not vision capable', () => {
    expect(actionsFor('status', { phase: 'vision_unsupported' })).toStrictEqual([
      { type: 'SET_VISION_STATE', state: 'unsupported' },
    ]);
  });

  test('model_switched clears the pending switch of ITS session and re-asks about vision', () => {
    expect(actionsFor('status', { phase: 'model_switched' })).toStrictEqual([
      { type: 'SET_MODEL_SWITCH_PENDING', sessionId: 7, pending: false },
      { type: 'SET_VISION_STATE', state: 'unknown' },
    ]);
  });

  test('model_switched with no owning session clears no session’s pending switch', () => {
    expect(actionsFor('status', { phase: 'model_switched' }, UNOWNED)).toStrictEqual([
      { type: 'SET_VISION_STATE', state: 'unknown' },
    ]);
  });

  test('steer_applied echoes the held draft and releases it', () => {
    expect(
      actionsFor(
        'status',
        { phase: 'steer_applied', steerId: 'draft-1' },
        { targetSessionId: 7, pendingSteerDraft: { id: 'draft-1', text: 'go on' } }
      )
    ).toStrictEqual([
      {
        type: 'ADD_MESSAGE',
        message: { role: 'user', content: 'go on' },
        targetSessionId: 7,
      },
      { type: 'SET_STEER_DRAFT', sessionId: 7, draft: null },
    ]);
  });

  test('steer_applied without an owning session releases nothing', () => {
    // The draft is looked up by the owning session, so a frame that names no
    // session can neither match nor release one.
    expect(
      actionsFor(
        'status',
        { phase: 'steer_applied', steerId: 'draft-1' },
        { pendingSteerDraft: { id: 'draft-1', text: 'go on' } }
      )
    ).toStrictEqual([]);
  });

  test('steer_applied for a different draft is ignored', () => {
    expect(
      actionsFor(
        'status',
        { phase: 'steer_applied', steerId: 'draft-2' },
        { targetSessionId: 7, pendingSteerDraft: { id: 'draft-1', text: 'go on' } }
      )
    ).toStrictEqual([]);
  });
});

describe('compaction', () => {
  test('compact_progress reports the phase', () => {
    expect(actionsFor('compact_progress', { message: 'compacting' })).toStrictEqual([
      { type: 'COMPACT_PROGRESS', message: 'compacting', targetSessionId: 7 },
    ]);
  });

  test('compact clears the phase and applies the new history to the owner', () => {
    expect(
      actionsFor(
        'compact',
        {
          messages: [{ role: 'assistant', content: 'short' }],
          stats: { oldTokenCount: 500, newTokenCount: 100 },
          tokenLimit: 4096,
        },
        { targetSessionId: 7, compactOwner: 9 }
      )
    ).toStrictEqual([
      { type: 'CLEAR_COMPACT_PROGRESS', targetSessionId: 7 },
      {
        type: 'SET_MESSAGES',
        messages: [{ role: 'assistant', content: 'short' }],
        targetSessionId: 9,
      },
      {
        type: 'SET_TOKEN_STATS',
        stats: {
          promptEvalCount: 100,
          evalCount: 0,
          totalTokens: 100,
          tokenLimit: 4096,
        },
        targetSessionId: 9,
      },
      {
        type: 'ADD_MESSAGE',
        message: {
          role: 'system',
          content: '⚡ Conversation auto-compacted: 500 → 100 tokens (~80% smaller).',
        },
        targetSessionId: 9,
      },
    ]);
  });

  test('compact reports a result that is still over the window in a second bubble', () => {
    // The receipt comes from one pure formatter (`formatCompactionReceipt`) on
    // both the manual and the automatic path; this pins the automatic path's
    // WARNING, which used to be missing entirely — a compaction that succeeded
    // and still did not make room is the one outcome the user has to act on.
    const actions = actionsFor(
      'compact',
      {
        messages: [{ role: 'assistant', content: 'short' }],
        stats: { oldTokenCount: 100000, newTokenCount: 90000 },
        tokenLimit: 65536,
      },
      { targetSessionId: 7, compactOwner: 9 }
    );
    expect(actions.slice(-2)).toStrictEqual([
      {
        type: 'ADD_MESSAGE',
        message: {
          role: 'system',
          content: '⚡ Conversation auto-compacted: 100,000 → 90,000 tokens (~10% smaller).',
        },
        targetSessionId: 9,
      },
      {
        type: 'ADD_MESSAGE',
        message: {
          role: 'system',
          content:
            '⚠️ The compacted history is still over the context window (90,000 of 65,536 tokens, estimated). The next turn may fail.',
        },
        targetSessionId: 9,
      },
    ]);
  });

  test('compact with no stats still says something and clears the token stats', () => {
    const actions = actionsFor(
      'compact',
      { messages: [] },
      { targetSessionId: 7, compactOwner: 9 }
    );
    expect(actions[2]).toStrictEqual({ type: 'CLEAR_TOKEN_STATS', targetSessionId: 9 });
    expect(actions[3]).toStrictEqual({
      type: 'ADD_MESSAGE',
      message: { role: 'system', content: '⚡ Conversation auto-compacted.' },
      targetSessionId: 9,
    });
  });
});

describe('terminal events', () => {
  test('done applies the final stats and the reason, and clears the live rate', () => {
    const outcome = routeSseEvent(
      'done',
      { doneReason: 'length', tokenStats: { totalTokens: 10 } },
      { targetSessionId: 7, doneOwner: 9 }
    );
    expect(outcome.actions).toStrictEqual([
      { type: 'SET_TOKEN_STATS', stats: { totalTokens: 10 }, targetSessionId: 7 },
      { type: 'SET_DONE_REASON', reason: 'length', targetSessionId: 9 },
    ]);
    expect(outcome.clearTps).toBe(true);
  });

  test('done with an unknown reason is normalised', () => {
    const outcome = routeSseEvent(
      'done',
      { doneReason: 'nonsense' },
      { targetSessionId: 7, doneOwner: 9 }
    );
    expect(outcome.actions).toStrictEqual([
      { type: 'SET_DONE_REASON', reason: 'unknown', targetSessionId: 9 },
    ]);
  });

  test("done's reason follows the done owner, not the general target", () => {
    // The reason is applied to the session that owns the turn. When the turn
    // is replayed there is no owner, so the action stays untargeted and lands
    // on whichever session is visible — the historical behaviour.
    const replayed = routeSseEvent('done', { doneReason: 'stop' }, { targetSessionId: 7 });
    expect(replayed.actions).toStrictEqual([{ type: 'SET_DONE_REASON', reason: 'stop' }]);
  });

  test('error marks the turn failed and clears the live rate', () => {
    const outcome = routeSseEvent('error', { message: 'boom' }, { targetSessionId: 7 });
    expect(outcome.actions).toStrictEqual([
      { type: 'SET_ERROR', error: 'boom', targetSessionId: 7 },
    ]);
    expect(outcome.markFailed).toBe(true);
    expect(outcome.clearTps).toBe(true);
  });

  test('an error whose session is gone is not marked as failed', () => {
    // There is nothing to retry into — the session was deleted — so the turn
    // must not keep its retry payload.
    const outcome = routeSseEvent(
      'error',
      {
        message: 'Session not found. It may have been deleted in another tab.',
        sessionMissing: true,
      },
      { targetSessionId: 7 }
    );
    expect(outcome.markFailed).toBe(false);
    expect(outcome.actions).toStrictEqual([
      {
        type: 'SET_ERROR',
        error: 'Session not found. It may have been deleted in another tab.',
        targetSessionId: 7,
      },
    ]);
  });

  test('an ordinary error still marks the turn as failed', () => {
    const outcome = routeSseEvent('error', { message: 'boom' }, { targetSessionId: 7 });
    expect(outcome.markFailed).toBe(true);
  });

  test('a done event keeps the end-of-turn rates', () => {
    // The server's authoritative rates arrive with `done`; only the live
    // read-out is cleared, so the numbers survive the turn.
    const outcome = routeSseEvent('done', { doneReason: 'stop' }, { targetSessionId: 7 });
    expect(outcome.clearTps).toBe(true);
    expect(outcome.clearRates).toBeUndefined();
  });

  test('an error clears the end-of-turn rates as well', () => {
    // A failed turn must not leave the previous turn's rate on screen.
    const outcome = routeSseEvent('error', { message: 'boom' }, { targetSessionId: 7 });
    expect(outcome.clearTps).toBe(true);
    expect(outcome.clearRates).toBe(true);
  });

  test('write_error prefixes the message and marks the turn failed', () => {
    const outcome = routeSseEvent('write_error', { message: 'disk full' }, { targetSessionId: 7 });
    expect(outcome.actions).toStrictEqual([
      {
        type: 'SET_ERROR',
        error: 'Failed to save message to database: disk full',
        targetSessionId: 7,
      },
    ]);
    expect(outcome.markFailed).toBe(true);
  });

  test('an unknown event produces no actions', () => {
    expect(actionsFor('something_else', { content: 'x' })).toStrictEqual([]);
  });
});

describe('frame ownership', () => {
  test("the server's session id wins over the client's record", () => {
    expect(frameOwner(7, 3)).toBe(7);
  });

  test('a frame without a session id falls back to the client record', () => {
    expect(frameOwner(null, 3)).toBe(3);
    expect(frameOwner(undefined, 3)).toBe(3);
  });

  test('a frame without a session id and without a fallback has no owner', () => {
    expect(frameOwner(null, undefined)).toBeUndefined();
  });
});
