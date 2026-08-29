#!/usr/bin/env node
/**
 * Unit tests for the openai-compat tool-call fallback ID pairing.
 *
 * Run with: npx tsx scripts/test-tool-call-fallback-ids.mjs
 *
 * Regression coverage for the "No tool output found for function call
 * call_fallback_N" pairing bug that an OpenAI-compatible gateway
 * (Airia in the original report) rejects with. The bug was a
 * mismatch between the synthetic `call_id` emitted by the assistant's
 * `function_call` item and the `call_id` emitted by the matching
 * tool-result's `function_call_output` item when:
 *
 *   1. The assistant's `tool_calls[i].id` is missing/empty, AND
 *   2. The tool result's `tool_call_id` is missing/empty, AND
 *   3. The assistant issued multiple tool calls in parallel — the
 *      tool-result block then has multiple `tool`-role messages
 *      between the assistant and any given tool result, so the
 *      "originating assistant" is no longer at `i - 1`.
 *
 * The fix derives the synthetic ID from the originating assistant's
 * true index (walking backward past contiguous tool messages) and the
 * position of the tool result within that assistant's `tool_calls`
 * array. Both sides use the same `toolCallFallbackId(idx, pos)`
 * helper, so the strings always agree.
 *
 * Mirrors the `scripts/test-sampling-params-cache.mjs` style exactly:
 * pure-function imports, assertEq/assertDeepEq helpers, PASS/FAIL per
 * case, exit 1 on any failure.
 */

import {
  toolCallFallbackId,
  toResponseInputItems,
} from '../src/services/adapters/openaiCompatibleAdapter.ts';

let pass = 0;
let fail = 0;

function assertEq(actual, expected, label) {
  if (actual === expected) {
    console.log(`  PASS  ${label}`);
    pass += 1;
  } else {
    console.error(`  FAIL  ${label}\n        expected: ${expected}\n        actual:   ${actual}`);
    fail += 1;
  }
}

function assertDeepEq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  PASS  ${label}`);
    pass += 1;
  } else {
    console.error(`  FAIL  ${label}\n        expected: ${e}\n        actual:   ${a}`);
    fail += 1;
  }
}

/**
 * Collect every function_call `call_id` emitted by the assistant and
 * every function_call_output `call_id` emitted by tool results, in
 * the order they appear in the input array.
 */
function collectCallIds(input) {
  const calls = [];
  const outputs = [];
  for (const item of input) {
    const t = item.type;
    if (t === 'function_call') {
      calls.push(item.call_id);
    } else if (t === 'function_call_output') {
      outputs.push(item.call_id);
    }
  }
  return { calls, outputs };
}

/**
 * Build a minimal assistant message with N tool calls. Pass
 * `idFor` to give each call a specific id, or `idFor=null` to leave
 * them empty (the case the fix targets).
 */
function assistantWithCalls(tcList) {
  return {
    role: 'assistant',
    content: '',
    tool_calls: tcList.map((tc) => ({
      id: tc.id ?? '',
      function: { name: tc.name, arguments: tc.args ?? {} },
    })),
  };
}

function toolResult(callId, output) {
  return {
    role: 'tool',
    content: output,
    tool_call_id: callId ?? '',
  };
}

// ── Unit-level: the helper itself ─────────────────────────────────────

console.log('\n# toolCallFallbackId — deterministic shape');
assertEq(
  toolCallFallbackId(0, 1),
  'call_fallback_0_1',
  'indexes 0 and 1 produce call_fallback_0_1'
);
assertEq(toolCallFallbackId(7, 2), 'call_fallback_7_2', 'larger indexes round-trip');

// ── Single tool call, real ids on both sides — regression guard ──────

console.log('\n# single tool call, real ids — unchanged behaviour');
{
  const messages = [
    { role: 'user', content: 'hi' },
    assistantWithCalls([{ name: 'lookup', id: 'call_real_abc' }]),
    toolResult('call_real_abc', 'ok'),
  ];
  const { input } = toResponseInputItems(messages);
  const { calls, outputs } = collectCallIds(input);
  assertEq(calls.length, 1, 'one function_call emitted');
  assertEq(outputs.length, 1, 'one function_call_output emitted');
  assertEq(calls[0], 'call_real_abc', 'function_call uses real id');
  assertEq(outputs[0], 'call_real_abc', 'function_call_output uses real id');
  assertEq(calls[0], outputs[0], 'ids match end-to-end');
}

// ── Single tool call, no real ids — fallback synthesis ───────────────

console.log('\n# single tool call, both sides missing ids — fallback matches');
{
  const messages = [
    { role: 'user', content: 'hi' },
    assistantWithCalls([{ name: 'lookup' }]),
    toolResult('', 'ok'),
  ];
  const { input } = toResponseInputItems(messages);
  const { calls, outputs } = collectCallIds(input);
  assertEq(calls[0], toolCallFallbackId(1, 0), 'function_call falls back to call_fallback_1_0');
  assertEq(
    outputs[0],
    toolCallFallbackId(1, 0),
    'function_call_output derives the SAME fallback id'
  );
}

// ── THE BUG REGRESSION: parallel tool calls, no real ids ─────────────

console.log('\n# parallel tool calls, no real ids — the original bug');
{
  const messages = [
    { role: 'user', content: 'run two tools' },
    assistantWithCalls([{ name: 'lookup_weather' }, { name: 'lookup_news' }]),
    toolResult('', 'sunny'),
    toolResult('', 'trending'),
  ];
  const { input } = toResponseInputItems(messages);
  const { calls, outputs } = collectCallIds(input);
  assertEq(calls.length, 2, 'two function_call items');
  assertEq(outputs.length, 2, 'two function_call_output items');
  assertDeepEq(
    calls.sort(),
    [toolCallFallbackId(1, 0), toolCallFallbackId(1, 1)].sort(),
    'both function_call items use the assistant-indexed fallback pair'
  );
  assertDeepEq(
    outputs.sort(),
    [toolCallFallbackId(1, 0), toolCallFallbackId(1, 1)].sort(),
    'both function_call_output items use the SAME fallback pair'
  );
  assertDeepEq(
    [...calls].sort(),
    [...outputs].sort(),
    'every function_call has a matching function_call_output'
  );
}

// ── Triple parallel tool calls — boundary stress ──────────────────────

console.log('\n# triple parallel tool calls, no real ids');
{
  const messages = [
    { role: 'user', content: 'three tools' },
    assistantWithCalls([{ name: 'a' }, { name: 'b' }, { name: 'c' }]),
    toolResult('', 'a-out'),
    toolResult('', 'b-out'),
    toolResult('', 'c-out'),
  ];
  const { input } = toResponseInputItems(messages);
  const { calls, outputs } = collectCallIds(input);
  assertEq(calls.length, 3, 'three function_call items');
  assertEq(outputs.length, 3, 'three function_call_output items');
  assertDeepEq(
    [...calls].sort(),
    [...outputs].sort(),
    'triple-parallel: every call has a matching output'
  );
}

// ── Mixed real-id and missing-id — only the missing ones fall back ───

console.log('\n# parallel calls, one real id and one missing');
{
  const messages = [
    { role: 'user', content: 'mix' },
    assistantWithCalls([{ name: 'real_one', id: 'call_real_aaa' }, { name: 'missing_one' }]),
    toolResult('call_real_aaa', 'real out'),
    toolResult('', 'missing out'),
  ];
  const { input } = toResponseInputItems(messages);
  const { calls, outputs } = collectCallIds(input);
  assertEq(calls[0], 'call_real_aaa', 'first call uses its real id');
  assertEq(calls[1], toolCallFallbackId(1, 1), 'second call falls back to call_fallback_1_1');
  assertEq(outputs[0], 'call_real_aaa', 'first output uses real id');
  assertEq(outputs[1], toolCallFallbackId(1, 1), 'second output derives the SAME fallback id');
}

// ── Multi-turn conversation — assistant indices are NOT zero ─────────

console.log('\n# multi-turn conversation — assistant index shifts');
{
  const messages = [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'first reply' },
    { role: 'user', content: 'second' },
    { role: 'assistant', content: 'second reply' },
    { role: 'user', content: 'run a tool' },
    assistantWithCalls([{ name: 'lookup' }]),
    toolResult('', 'ok'),
  ];
  const { input } = toResponseInputItems(messages);
  const { calls, outputs } = collectCallIds(input);
  assertEq(
    calls[0],
    toolCallFallbackId(5, 0),
    'function_call uses the true assistant index (5), not 0'
  );
  assertEq(
    outputs[0],
    toolCallFallbackId(5, 0),
    'function_call_output derives the SAME assistant-indexed fallback'
  );
}

// ── Multi-turn with TWO parallel-tool-call blocks ────────────────────

console.log('\n# two consecutive parallel-tool-call blocks');
{
  const messages = [
    { role: 'user', content: 'q1' },
    assistantWithCalls([{ name: 'a1' }, { name: 'a2' }]),
    toolResult('', 'a1-out'),
    toolResult('', 'a2-out'),
    { role: 'assistant', content: 'thinking about it' },
    { role: 'user', content: 'q2' },
    assistantWithCalls([{ name: 'b1' }, { name: 'b2' }]),
    toolResult('', 'b1-out'),
    toolResult('', 'b2-out'),
  ];
  const { input } = toResponseInputItems(messages);
  const { calls, outputs } = collectCallIds(input);
  assertEq(calls.length, 4, 'four function_call items total');
  assertEq(outputs.length, 4, 'four function_call_output items total');
  assertDeepEq(
    [...calls].sort(),
    [...outputs].sort(),
    'both blocks paired end-to-end across the conversation'
  );
}

// ── Tool-call-only assistant (empty text) — empty-text skip preserves pairing

console.log('\n# tool-call-only assistant — empty text skipped, pairing intact');
{
  const messages = [
    { role: 'user', content: 'do it' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: '', function: { name: 'x', arguments: {} } },
        { id: '', function: { name: 'y', arguments: {} } },
      ],
    },
    { role: 'tool', content: 'x-out', tool_call_id: '' },
    { role: 'tool', content: 'y-out', tool_call_id: '' },
  ];
  const { input } = toResponseInputItems(messages);
  // No empty-text assistant message should precede the function_calls.
  const messageItems = input.filter((it) => it.type === 'message');
  assertEq(messageItems.length, 1, 'only the user message remains; no empty assistant text');
  const { calls, outputs } = collectCallIds(input);
  assertDeepEq(
    [...calls].sort(),
    [...outputs].sort(),
    'pairing holds when assistant text is omitted'
  );
}

// ── Orphan tool (no preceding assistant) — converted to user, no crash

console.log('\n# orphan tool message — converted to user');
{
  const messages = [
    { role: 'user', content: 'first' },
    { role: 'tool', content: 'orphaned', tool_call_id: '' },
    { role: 'assistant', content: 'reply' },
  ];
  const { input } = toResponseInputItems(messages);
  const types = new Set(input.map((it) => it.type));
  assertEq(types.has('function_call_output'), false, 'no function_call_output emitted for orphan');
  assertEq(types.has('function_call'), false, 'no function_call emitted (no assistant tool calls)');
}

// ── Assistant with text + tool call (mixed) — text preserved ─────────

console.log('\n# assistant with text and a tool call — text emitted, call paired');
{
  // Shape: user, assistant(text + 1 tool_call), tool_result for that call.
  // The empty-content placeholder is removed — we want text + tools together.
  const messages = [
    { role: 'user', content: 'go' },
    {
      role: 'assistant',
      content: 'Looking it up...',
      tool_calls: [{ id: '', function: { name: 'lookup', arguments: {} } }],
    },
    { role: 'tool', content: 'result', tool_call_id: '' },
  ];
  const { input } = toResponseInputItems(messages);
  const messageItems = input.filter((it) => it.type === 'message');
  assertEq(
    messageItems.some((m) => m.content === 'Looking it up...'),
    true,
    'assistant text message is emitted before function_call'
  );
  const { calls, outputs } = collectCallIds(input);
  assertEq(calls[0], outputs[0], 'function_call paired with its output');
}

// ── Real tc.id with empty-string tool_call_id — derived from assistant ──

console.log('\n# real tc.id + empty tool_call_id — output picks up the real id by position');
{
  const messages = [
    { role: 'user', content: 'q' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'real_aaa', function: { name: 'a', arguments: {} } },
        { id: '', function: { name: 'b', arguments: {} } },
      ],
    },
    { role: 'tool', content: 'a-out', tool_call_id: '' },
    { role: 'tool', content: 'b-out', tool_call_id: '' },
  ];
  const { input } = toResponseInputItems(messages);
  const { calls, outputs } = collectCallIds(input);
  assertEq(calls[0], 'real_aaa', 'first function_call uses its real id');
  assertEq(
    outputs[0],
    'real_aaa',
    'first output adopts the real id (no synthetic, since assistant had one)'
  );
  assertEq(calls[1], outputs[1], 'second call/output pair matches (fallback pair)');
}

// ── Empty input — graceful no-op ────────────────────────────────────

console.log('\n# empty input — graceful no-op');
{
  const r = toResponseInputItems([]);
  assertEq(r.input.length, 0, 'no input items');
  assertEq(r.instructions, null, 'no instructions');
}

// ── Empty tc.id and empty tool_call_id — fallback synthesises both sides ──

console.log('\n# explicit empty-string tc.id — handled identically to missing');
{
  const messages = [
    { role: 'user', content: 'q' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: '', function: { name: 'a', arguments: {} } }],
    },
    { role: 'tool', content: 'out', tool_call_id: '' },
  ];
  const { input } = toResponseInputItems(messages);
  const { calls, outputs } = collectCallIds(input);
  assertEq(
    calls[0],
    toolCallFallbackId(1, 0),
    'empty-string tc.id falls back to call_fallback_1_0'
  );
  assertEq(
    outputs[0],
    toolCallFallbackId(1, 0),
    'empty-string tool_call_id derives the SAME fallback id'
  );
}

// ── Assistant without tool_calls — plain message ──────────────────────

console.log('\n# assistant with no tool_calls — plain message, no synthetic ids');
{
  const messages = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
  ];
  const { input } = toResponseInputItems(messages);
  const { calls, outputs } = collectCallIds(input);
  assertEq(calls.length, 0, 'no function_call items');
  assertEq(outputs.length, 0, 'no function_call_output items');
}

// ── Two consecutive parallel-tool-call blocks with mixed ids ─────────

console.log('\n# two consecutive parallel-tool-call blocks — paired across blocks');
{
  const messages = [
    { role: 'user', content: 'q1' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: '', function: { name: 'a1', arguments: {} } },
        { id: '', function: { name: 'a2', arguments: {} } },
      ],
    },
    { role: 'tool', content: 'a1-out', tool_call_id: '' },
    { role: 'tool', content: 'a2-out', tool_call_id: '' },
    { role: 'assistant', content: 'thinking about it' },
    { role: 'user', content: 'q2' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: '', function: { name: 'b1', arguments: {} } },
        { id: '', function: { name: 'b2', arguments: {} } },
      ],
    },
    { role: 'tool', content: 'b1-out', tool_call_id: '' },
    { role: 'tool', content: 'b2-out', tool_call_id: '' },
  ];
  const { input } = toResponseInputItems(messages);
  const { calls, outputs } = collectCallIds(input);
  assertEq(calls.length, 4, 'four function_call items total');
  assertEq(outputs.length, 4, 'four function_call_output items total');
  const expectedA = new Set([toolCallFallbackId(1, 0), toolCallFallbackId(1, 1)]);
  const expectedB = new Set([toolCallFallbackId(6, 0), toolCallFallbackId(6, 1)]);
  const callsForA = calls.filter((c) => expectedA.has(c));
  const callsForB = calls.filter((c) => expectedB.has(c));
  assertEq(callsForA.length, 2, 'block A has both call ids');
  assertEq(callsForB.length, 2, 'block B has both call ids');
  const outputsForA = outputs.filter((o) => expectedA.has(o));
  const outputsForB = outputs.filter((o) => expectedB.has(o));
  assertEq(outputsForA.length, 2, 'block A outputs match block A calls');
  assertEq(outputsForB.length, 2, 'block B outputs match block B calls');
}

// ── Non-tool message interleaved between assistant and tool result ──
// Walks backward past tool messages only; if it hits a user/system
// message before an assistant, the tool message is a true orphan.

console.log('\n# user message interleaved between assistant and tool result');
{
  const messages = [
    { role: 'user', content: 'go' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: '', function: { name: 'a', arguments: {} } },
        { id: '', function: { name: 'b', arguments: {} } },
      ],
    },
    { role: 'tool', content: 'a-out', tool_call_id: '' },
    { role: 'user', content: 'oops, also tell me a joke' },
    { role: 'tool', content: 'b-out', tool_call_id: '' },
  ];
  const { input } = toResponseInputItems(messages);
  const { calls, outputs } = collectCallIds(input);
  // The user message breaks the assistant's chain, so the trailing
  // tool result is a true orphan and gets converted to a user
  // message instead of a function_call_output.
  assertEq(calls.length, 2, 'both function_call items survive (from the original assistant)');
  assertEq(outputs.length, 1, 'only the in-chain tool result survives');
  const userMessages = input.filter((it) => it.type === 'message' && it.role === 'user');
  assertEq(
    userMessages.some((m) => m.content === 'b-out'),
    true,
    'the broken-chain tool result is converted to a user message'
  );
}

// ── Text-only assistant between tool calls — second tool is orphaned ──

console.log('\n# text-only assistant between tool calls — second tool orphan');
{
  const messages = [
    { role: 'user', content: 'go' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: '', function: { name: 'a', arguments: {} } }],
    },
    { role: 'tool', content: 'a-out', tool_call_id: '' },
    { role: 'assistant', content: 'let me think' },
    { role: 'tool', content: 'should-be-orphan', tool_call_id: '' },
  ];
  const { input } = toResponseInputItems(messages);
  const { calls, outputs } = collectCallIds(input);
  assertEq(calls.length, 1, 'one function_call from the first assistant');
  assertEq(outputs.length, 1, 'only the in-chain tool result is a function_call_output');
  const userMessages = input.filter((it) => it.type === 'message' && it.role === 'user');
  assertEq(
    userMessages.some((m) => m.content === 'should-be-orphan'),
    true,
    'the orphan tool result is converted to a user message'
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
