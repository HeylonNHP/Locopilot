#!/usr/bin/env node
/**
 * Characterisation tests for SSE event routing (src/app/lib/sseRouting.ts).
 *
 * Run with: npx tsx scripts/test-sse-routing.mjs
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
 */

import assert from 'node:assert/strict';

import { frameOwner, routeSseEvent } from '../src/app/lib/sseRouting.ts';

let pass = 0;
let fail = 0;

function check(label, fn) {
  try {
    fn();
    console.log(`  PASS  ${label}`);
    pass += 1;
  } catch (err) {
    console.error(`  FAIL  ${label}\n        ${err.message.split('\n').join('\n        ')}`);
    fail += 1;
  }
}

const OWNED = { targetSessionId: 7 };
const UNOWNED = {};

/** The action sequence a routing call produced. */
function actionsFor(event, data, ctx = OWNED) {
  return routeSseEvent(event, data, ctx).actions;
}

// ── content deltas ──────────────────────────────────────────────────────────
check('chunk targets the owning session', () => {
  assert.deepEqual(actionsFor('chunk', { content: 'hello' }), [
    { type: 'APPLY_ASSISTANT_DELTA', content: 'hello', targetSessionId: 7 },
  ]);
});

check('chunk without an owner omits targetSessionId entirely', () => {
  assert.deepEqual(actionsFor('chunk', { content: 'hello' }, UNOWNED), [
    { type: 'APPLY_ASSISTANT_DELTA', content: 'hello' },
  ]);
});

check('chunk without content produces an empty delta', () => {
  assert.deepEqual(actionsFor('chunk', {}, UNOWNED), [{ type: 'APPLY_ASSISTANT_DELTA' }]);
});

check('thinking targets the owning session', () => {
  assert.deepEqual(actionsFor('thinking', { content: 'hmm' }), [
    { type: 'APPLY_ASSISTANT_DELTA', thinking: 'hmm', targetSessionId: 7 },
  ]);
});

check('clear_assistant removes the last assistant message', () => {
  assert.deepEqual(actionsFor('clear_assistant', {}), [
    { type: 'REMOVE_LAST_ASSISTANT', targetSessionId: 7 },
  ]);
});

// ── tool events ─────────────────────────────────────────────────────────────
check('tool_call renders the tool bubble', () => {
  assert.deepEqual(actionsFor('tool_call', { name: 'read_file', arguments: { path: 'a.ts' } }), [
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

check('tool_result renders the result bubble', () => {
  assert.deepEqual(actionsFor('tool_result', { name: 'read_file', result: 'ok', duration: 12 }), [
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

check('a finished run_subagents batch clears the steer-target toggle', () => {
  const actions = actionsFor('tool_result', { name: 'run_subagents', result: 'done', duration: 5 });
  assert.equal(actions.length, 2);
  assert.deepEqual(actions[1], { type: 'SET_CONFIG', config: { activeSubagentId: null } });
});

check('tool_progress appends to the running tool', () => {
  assert.deepEqual(actionsFor('tool_progress', { name: 'read_file', message: 'reading' }), [
    { type: 'APPEND_TOOL_PROGRESS', name: 'read_file', content: 'reading', targetSessionId: 7 },
  ]);
});

// ── sub-agent events ────────────────────────────────────────────────────────
check('subagent_output emits the output and marks the agent active', () => {
  assert.deepEqual(actionsFor('subagent_output', { agentId: 'research', message: 'done' }), [
    { type: 'SUBAGENT_OUTPUT', agentId: 'research', message: 'done', targetSessionId: 7 },
    { type: 'SET_CONFIG', config: { activeSubagentId: 'research' } },
  ]);
});

check('subagent_chunk is handed back for coalescing, not dispatched', () => {
  const outcome = routeSseEvent(
    'subagent_chunk',
    { agentId: 'research', text: 'part' },
    {
      targetSessionId: 7,
      subagentOwner: 9,
    }
  );
  assert.deepEqual(outcome.actions, [
    { type: 'SET_CONFIG', config: { activeSubagentId: 'research' } },
  ]);
  assert.deepEqual(outcome.subagentChunk, { agentId: 'research', text: 'part', owner: 9 });
});

check('subagent_chunk without an owner omits the owner', () => {
  const outcome = routeSseEvent(
    'subagent_chunk',
    { agentId: 'research', text: 'part' },
    {
      targetSessionId: 7,
    }
  );
  assert.deepEqual(outcome.subagentChunk, { agentId: 'research', text: 'part' });
});

// ── approvals ───────────────────────────────────────────────────────────────
check('approval_request routes to the approval owner', () => {
  assert.deepEqual(
    actionsFor(
      'approval_request',
      { requestId: 'r1', toolName: 'run_command', args: { command: 'ls' } },
      { targetSessionId: 7, approvalOwner: 9 }
    ),
    [
      {
        type: 'SHOW_APPROVAL',
        command: { name: 'run_command', args: { command: 'ls' } },
        requestId: 'r1',
        targetSessionId: 9,
      },
    ]
  );
});

check('approval_request without an owner stays on the visible session', () => {
  const [action] = actionsFor(
    'approval_request',
    { requestId: 'r1', toolName: 'run_command', args: {} },
    { targetSessionId: 7 }
  );
  assert.equal('targetSessionId' in action, false);
});

// ── status ──────────────────────────────────────────────────────────────────
check('status with tokens updates the stats and the live rate', () => {
  assert.deepEqual(actionsFor('status', { tokensUsed: 120, tokenLimit: 4096, tps: 30 }), [
    {
      type: 'SET_TOKEN_STATS',
      stats: {
        totalTokens: 120,
        tokenLimit: 4096,
        promptEvalCount: 0,
        evalCount: 120,
        isEstimated: false,
        modelContextLimit: null,
      },
      targetSessionId: 7,
    },
    { type: 'SET_CURRENT_TPS', tps: 30, targetSessionId: 7 },
  ]);
});

check('status without tokens leaves the stats alone', () => {
  assert.deepEqual(actionsFor('status', { tps: 12 }), [
    { type: 'SET_CURRENT_TPS', tps: 12, targetSessionId: 7 },
  ]);
});

check('vision_unsupported marks the model as not vision capable', () => {
  assert.deepEqual(actionsFor('status', { phase: 'vision_unsupported' }), [
    { type: 'SET_VISION_STATE', state: 'unsupported' },
  ]);
});

check('model_switched clears the pending switch and re-asks about vision', () => {
  assert.deepEqual(actionsFor('status', { phase: 'model_switched' }), [
    { type: 'SET_CONFIG', config: { modelSwitchPending: false } },
    { type: 'SET_VISION_STATE', state: 'unknown' },
  ]);
});

check('steer_applied echoes the held draft and releases it', () => {
  assert.deepEqual(
    actionsFor(
      'status',
      { phase: 'steer_applied', steerId: 'draft-1' },
      { targetSessionId: 7, pendingSteerDraft: { id: 'draft-1', text: 'go on' } }
    ),
    [
      {
        type: 'ADD_MESSAGE',
        message: { role: 'user', content: 'go on' },
        targetSessionId: 7,
      },
      { type: 'SET_CONFIG', config: { pendingSteerDraft: null } },
    ]
  );
});

check('steer_applied for a different draft is ignored', () => {
  assert.deepEqual(
    actionsFor(
      'status',
      { phase: 'steer_applied', steerId: 'draft-2' },
      { targetSessionId: 7, pendingSteerDraft: { id: 'draft-1', text: 'go on' } }
    ),
    []
  );
});

// ── compaction ──────────────────────────────────────────────────────────────
check('compact_progress reports the phase', () => {
  assert.deepEqual(actionsFor('compact_progress', { message: 'compacting' }), [
    { type: 'COMPACT_PROGRESS', message: 'compacting', targetSessionId: 7 },
  ]);
});

check('compact clears the phase and applies the new history to the owner', () => {
  assert.deepEqual(
    actionsFor(
      'compact',
      {
        messages: [{ role: 'assistant', content: 'short' }],
        stats: { oldTokenCount: 500, newTokenCount: 100 },
        tokenLimit: 4096,
      },
      { targetSessionId: 7, compactOwner: 9 }
    ),
    [
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
          content: '⚡ Conversation auto-compacted (500 → 100 tokens)',
        },
        targetSessionId: 9,
      },
    ]
  );
});

check('compact without stats clears the token stats for the owner', () => {
  const actions = actionsFor('compact', { messages: [] }, { targetSessionId: 7, compactOwner: 9 });
  assert.deepEqual(actions[2], { type: 'CLEAR_TOKEN_STATS', targetSessionId: 9 });
});

// ── terminal events ─────────────────────────────────────────────────────────
check('done applies the final stats and the reason, and clears the live rate', () => {
  const outcome = routeSseEvent(
    'done',
    { doneReason: 'length', tokenStats: { totalTokens: 10 } },
    { targetSessionId: 7, doneOwner: 9 }
  );
  assert.deepEqual(outcome.actions, [
    { type: 'SET_TOKEN_STATS', stats: { totalTokens: 10 }, targetSessionId: 7 },
    { type: 'SET_DONE_REASON', reason: 'length', targetSessionId: 9 },
  ]);
  assert.equal(outcome.clearTps, true);
});

check('done with an unknown reason is normalised', () => {
  const outcome = routeSseEvent(
    'done',
    { doneReason: 'nonsense' },
    { targetSessionId: 7, doneOwner: 9 }
  );
  assert.deepEqual(outcome.actions, [
    { type: 'SET_DONE_REASON', reason: 'unknown', targetSessionId: 9 },
  ]);
});

check("done's reason follows the done owner, not the general target", () => {
  // The reason is applied to the session that owns the turn. When the turn
  // is replayed there is no owner, so the action stays untargeted and lands
  // on whichever session is visible — the historical behaviour.
  const replayed = routeSseEvent('done', { doneReason: 'stop' }, { targetSessionId: 7 });
  assert.deepEqual(replayed.actions, [{ type: 'SET_DONE_REASON', reason: 'stop' }]);
});

check('error marks the turn failed and clears the live rate', () => {
  const outcome = routeSseEvent('error', { message: 'boom' }, { targetSessionId: 7 });
  assert.deepEqual(outcome.actions, [{ type: 'SET_ERROR', error: 'boom', targetSessionId: 7 }]);
  assert.equal(outcome.markFailed, true);
  assert.equal(outcome.clearTps, true);
});

check('an error whose session is gone is not marked as failed', () => {
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
  assert.equal(outcome.markFailed, false);
  assert.deepEqual(outcome.actions, [
    {
      type: 'SET_ERROR',
      error: 'Session not found. It may have been deleted in another tab.',
      targetSessionId: 7,
    },
  ]);
});

check('an ordinary error still marks the turn as failed', () => {
  const outcome = routeSseEvent('error', { message: 'boom' }, { targetSessionId: 7 });
  assert.equal(outcome.markFailed, true);
});

check('a done event keeps the end-of-turn rates', () => {
  // The server's authoritative rates arrive with `done`; only the live
  // read-out is cleared, so the numbers survive the turn.
  const outcome = routeSseEvent('done', { doneReason: 'stop' }, { targetSessionId: 7 });
  assert.equal(outcome.clearTps, true);
  assert.equal(outcome.clearRates, undefined);
});

check('an error clears the end-of-turn rates as well', () => {
  // A failed turn must not leave the previous turn's rate on screen.
  const outcome = routeSseEvent('error', { message: 'boom' }, { targetSessionId: 7 });
  assert.equal(outcome.clearTps, true);
  assert.equal(outcome.clearRates, true);
});

check('write_error prefixes the message and marks the turn failed', () => {
  const outcome = routeSseEvent('write_error', { message: 'disk full' }, { targetSessionId: 7 });
  assert.deepEqual(outcome.actions, [
    {
      type: 'SET_ERROR',
      error: 'Failed to save message to database: disk full',
      targetSessionId: 7,
    },
  ]);
  assert.equal(outcome.markFailed, true);
});

check('an unknown event produces no actions', () => {
  assert.deepEqual(actionsFor('something_else', { content: 'x' }), []);
});

// ── frame ownership ────────────────────────────────────────────────────────
check("the server's session id wins over the client's record", () => {
  assert.equal(frameOwner(7, 3), 7);
});

check('a frame without a session id falls back to the client record', () => {
  assert.equal(frameOwner(null, 3), 3);
  assert.equal(frameOwner(undefined, 3), 3);
});

check('a frame without a session id and without a fallback has no owner', () => {
  assert.equal(frameOwner(null, undefined), undefined);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  process.exitCode = 1;
}
