#!/usr/bin/env node
/**
 * Regression guard for prompt-cache prefix stability.
 *
 * Run with: npx tsx scripts/test-prompt-cache-stability.mjs
 *
 * Prompt caching only reuses an *identical* prompt prefix, so anything that
 * varies per turn near the top of the prompt defeats reuse for the whole
 * conversation. The system prompt used to embed a second-resolution clock
 * ("Current date and time: ... 04:06:24 PM"), which made the prefix unique
 * every second. These checks pin the fix:
 *
 *   (a) the shared date helper is day-resolution and clock-free;
 *   (b) the per-user-message `[Sent ...]` stamp stays deterministic because it
 *       is derived from the persisted `createdAt`, not from the current time;
 *   (c) the system prompts are byte-identical across builds minutes apart on
 *       the same local day, and the previous turn's messages remain an exact
 *       prefix of the next turn's.
 *
 * Network-free. Only the user-profile skill layer is neutralised (by pointing
 * LOCOPILOT_HOME at a temp dir); the project skill layer at `.locopilot/skills`
 * under the current working directory is still read, so this test is not fully
 * hermetic with respect to skills. That does not affect the assertions here,
 * which compare prompt builds against each other rather than against fixtures.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Must be set before skill discovery runs (src/services/skillManager.ts reads it
// lazily on each call, so setting it here is sufficient).
process.env.LOCOPILOT_HOME = path.join(os.tmpdir(), 'locopilot-prompt-cache-test');

const { formatPromptDate, formatPromptDateTime } = await import('../src/services/promptDate.ts');
const { buildUserMessageStamp, maybeInjectPromptTimestamp } =
  await import('../src/services/userMessageStamp.ts');
const { createSystemPrompt } = await import('../src/services/chatSession.ts');
const { buildSubAgentSystemPrompt, buildSubAgentUserMessage } =
  await import('../src/tools/impl/subAgentTool.ts');

let pass = 0;
let fail = 0;

function check(label, fn) {
  try {
    fn();
    console.log(`  PASS  ${label}`);
    pass += 1;
  } catch (err) {
    console.error(`  FAIL  ${label}\n        ${err instanceof Error ? err.message : String(err)}`);
    fail += 1;
  }
}

const NO_CLOCK = /\b\d{1,2}(?::\d{2}){1,2}\b/;

// ─── (a) formatPromptDate ────────────────────────────────────────────────────
console.log('formatPromptDate');

const sameDayEarly = new Date(2026, 8, 24, 0, 0, 1);
const sameDayLate = new Date(2026, 8, 24, 23, 59, 59);
const nextDay = new Date(2026, 8, 25, 0, 0, 1);

check('identical at 00:00:01 and 23:59:59 on the same local day', () => {
  assert.equal(formatPromptDate(sameDayEarly), formatPromptDate(sameDayLate));
});

check('differs across a local day boundary', () => {
  assert.notEqual(formatPromptDate(sameDayEarly), formatPromptDate(nextDay));
});

check('contains no time-of-day clock', () => {
  const s = formatPromptDate(sameDayEarly);
  assert.doesNotMatch(s, NO_CLOCK);
  assert.doesNotMatch(s, /\b(?:AM|PM)\b/);
});

check('reads as a calendar date', () => {
  assert.equal(formatPromptDate(sameDayEarly), 'Thursday, September 24, 2026');
});

// ─── (b) buildUserMessageStamp / maybeInjectPromptTimestamp ──────────────────
console.log('buildUserMessageStamp');

// Deliberately far in the past and well separated from each other. A stamp taken
// from the current clock instead of from `createdAt` would render both as the
// same "now" string, which is exactly what the assertions below reject. (An
// earlier revision of this guard used `createdAt` values close to "now" and
// built both synthetic turns inside the same wall-clock minute, so a regression
// that ignored `createdAt` entirely still passed. The dates below close that.)
const fixedCreatedAt = new Date('2024-03-05T07:08:00.000Z').toISOString();
const otherCreatedAt = new Date('2021-11-30T21:42:00.000Z').toISOString();

check('keeps the [Sent YYYY-MM-DD HH:MM] shape', () => {
  assert.match(
    buildUserMessageStamp(new Date(fixedCreatedAt)),
    /^\[Sent \d{4}-\d{2}-\d{2} \d{2}:\d{2}]$/
  );
});

check('is deterministic for a fixed instant', () => {
  assert.equal(
    buildUserMessageStamp(new Date(fixedCreatedAt)),
    buildUserMessageStamp(new Date(fixedCreatedAt))
  );
});

console.log('maybeInjectPromptTimestamp');

const userMessage = { role: 'user', content: 'first question', createdAt: fixedCreatedAt };
const laterUserMessage = {
  role: 'user',
  content: 'second question',
  createdAt: new Date('2024-03-05T07:09:00.000Z').toISOString(),
};

check('is deterministic for a fixed createdAt', () => {
  assert.deepEqual(
    maybeInjectPromptTimestamp(userMessage, true),
    maybeInjectPromptTimestamp(userMessage, true)
  );
});

check('prepends the stamp and strips createdAt', () => {
  const result = maybeInjectPromptTimestamp(userMessage, true);
  assert.equal('createdAt' in result, false);
  assert.match(result.content, /^\[Sent \d{4}-\d{2}-\d{2} \d{2}:\d{2}]\nfirst question$/);
});

check('stamp is derived from createdAt, not from the current clock', () => {
  const result = maybeInjectPromptTimestamp(userMessage, true);
  assert.equal(
    result.content,
    `${buildUserMessageStamp(new Date(fixedCreatedAt))}\nfirst question`
  );
  assert.equal(result.content.startsWith(buildUserMessageStamp(new Date())), false);
});

check('different createdAt values produce different stamps', () => {
  const a = maybeInjectPromptTimestamp(userMessage, true);
  const b = maybeInjectPromptTimestamp(
    { role: 'user', content: 'first question', createdAt: otherCreatedAt },
    true
  );
  assert.notEqual(a.content.split('\n')[0], b.content.split('\n')[0]);
});

check('is idempotent (does not double-stamp)', () => {
  const once = maybeInjectPromptTimestamp(userMessage, true);
  const twice = maybeInjectPromptTimestamp(once, true);
  assert.equal(twice.content, once.content);
});

check('returns the message unchanged when the toggle is off', () => {
  assert.deepEqual(maybeInjectPromptTimestamp(userMessage, false), userMessage);
});

check('returns non-user messages unchanged', () => {
  const assistant = { role: 'assistant', content: 'hi', createdAt: fixedCreatedAt };
  assert.deepEqual(maybeInjectPromptTimestamp(assistant, true), assistant);
  assert.equal('createdAt' in maybeInjectPromptTimestamp(assistant, true), true);
});

check('returns a message without createdAt unchanged', () => {
  const bare = { role: 'user', content: 'no timestamp' };
  assert.deepEqual(maybeInjectPromptTimestamp(bare, true), bare);
});

// ─── (c) system prompts are stable across builds ─────────────────────────────
console.log('createSystemPrompt');

const t1 = new Date(2026, 8, 24, 10, 0, 0);
const t1b = new Date(2026, 8, 24, 10, 0, 59);
const t2 = new Date(2026, 8, 24, 10, 5, 0);
const tNextDay = new Date(2026, 8, 25, 10, 0, 0);

check('byte-identical across two builds 59 seconds apart (same day)', () => {
  assert.equal(
    createSystemPrompt(undefined, false, true, t1),
    createSystemPrompt(undefined, false, true, t1b)
  );
});

check('byte-identical across two builds 5 minutes apart (same day)', () => {
  assert.equal(
    createSystemPrompt(undefined, false, true, t1),
    createSystemPrompt(undefined, false, true, t2)
  );
});

check('still tracks the calendar day', () => {
  assert.notEqual(
    createSystemPrompt(undefined, false, true, t1),
    createSystemPrompt(undefined, false, true, tNextDay)
  );
});

check('states the date on the second line, with no clock', () => {
  const lines = createSystemPrompt(undefined, false, true, t1).split('\n');
  assert.equal(lines[1], `Current date: ${formatPromptDate(t1)}`);
  assert.doesNotMatch(lines[1], NO_CLOCK);
});

check('no longer emits the old per-second clock wording', () => {
  assert.doesNotMatch(createSystemPrompt(undefined, false, true, t1), /Current date and time:/);
});

console.log('buildSubAgentSystemPrompt');

check('byte-identical across two builds 59 seconds apart (same day)', () => {
  assert.equal(
    buildSubAgentSystemPrompt(undefined, true, t1),
    buildSubAgentSystemPrompt(undefined, true, t1b)
  );
});

check('states the date, with no clock and no old wording', () => {
  const prompt = buildSubAgentSystemPrompt(undefined, true, t1);
  assert.equal(prompt.split('\n')[1], `Current date: ${formatPromptDate(t1)}`);
  assert.doesNotMatch(prompt, /Current date and time:/);
});

// ─── (c2) sub-agent time grounding ───────────────────────────────────────────
console.log('formatPromptDateTime');

check('is identical for two instants inside the same minute', () => {
  assert.equal(
    formatPromptDateTime(new Date(2026, 8, 24, 11, 23, 0)),
    formatPromptDateTime(new Date(2026, 8, 24, 11, 23, 59))
  );
});

check('differs across minutes', () => {
  assert.notEqual(
    formatPromptDateTime(new Date(2026, 8, 24, 11, 23, 0)),
    formatPromptDateTime(new Date(2026, 8, 24, 11, 24, 0))
  );
});

check('agrees with formatPromptDate on the date, and carries no seconds', () => {
  const d = new Date(2026, 8, 24, 11, 23, 0);
  const dateTime = formatPromptDateTime(d);
  assert.equal(dateTime.startsWith(formatPromptDate(d)), true);
  assert.doesNotMatch(dateTime, /\d{1,2}:\d{2}:\d{2}/);
});

console.log('buildSubAgentUserMessage');

const subAgentNow = new Date(2026, 8, 24, 11, 23, 0);
const subAgentPrompt = 'Research the current state of quantum error correction.';

check('leads with a wall-clock header', () => {
  const content = buildSubAgentUserMessage(subAgentPrompt, '', subAgentNow);
  assert.equal(
    content.split('\n')[0],
    `Current date and time: ${formatPromptDateTime(subAgentNow)}`
  );
});

check('grounds the agent in a real date and time, not an assumption', () => {
  const content = buildSubAgentUserMessage(subAgentPrompt, '', subAgentNow);
  assert.match(
    content,
    /Current date and time: \w+day, \w+ \d{1,2}, \d{4} at \d{1,2}:\d{2} (?:AM|PM)/
  );
});

check('is byte-identical for a fixed start instant (the agent-lifetime property)', () => {
  assert.equal(
    buildSubAgentUserMessage(subAgentPrompt, '', subAgentNow),
    buildSubAgentUserMessage(subAgentPrompt, '', subAgentNow)
  );
});

check('is byte-identical for two instants inside the same minute', () => {
  assert.equal(
    buildSubAgentUserMessage(subAgentPrompt, '', subAgentNow),
    buildSubAgentUserMessage(subAgentPrompt, '', new Date(2026, 8, 24, 11, 23, 59))
  );
});

check('keeps the prior-results block and the task after the header', () => {
  const content = buildSubAgentUserMessage(
    subAgentPrompt,
    '## Prior results\n\nstuff\n\n---\n\n',
    subAgentNow
  );
  assert.equal(content.endsWith(subAgentPrompt), true);
  assert.equal(content.includes('## Prior results'), true);
  const headerIndex = content.indexOf('Current date and time: ');
  assert.equal(headerIndex, 0);
  assert.equal(content.indexOf('## Prior results') > headerIndex, true);
});

check('the shared system prompt is unaffected, so cross-agent reuse survives', () => {
  // Two agents started five minutes apart must still share a byte-identical
  // system prompt; only their task messages differ.
  assert.equal(
    buildSubAgentSystemPrompt(undefined, true, t1),
    buildSubAgentSystemPrompt(undefined, true, t2)
  );
  assert.notEqual(
    buildSubAgentUserMessage(subAgentPrompt, '', t1),
    buildSubAgentUserMessage(subAgentPrompt, '', t2)
  );
});

// ─── (d) the two-turn prefix property ────────────────────────────────────────
// Models the append-only happy path that the real route implements: each turn
// re-derives `llmMessages` from a `currentMessages` array that only grows, so
// the previous turn's array is an exact prefix of the next turn's. It does NOT
// model the two mechanisms that legitimately truncate reuse further down the
// prompt - synthetic nudges, which are deliberately never persisted, and
// auto-compaction, which rewrites earlier messages - because those are
// pre-existing and unavoidable; they reset reuse from their insertion point,
// not from the start of the prompt, which is what this change is about.
console.log('two-turn prefix');

const buildTurn = (now, history) => [
  { role: 'system', content: createSystemPrompt(undefined, false, true, now) },
  ...history.map((m) => maybeInjectPromptTimestamp(m, true)),
];

const assistantReply = { role: 'assistant', content: 'answer' };

const turn1 = buildTurn(t1, [userMessage]);
const turn2 = buildTurn(t2, [userMessage, assistantReply, laterUserMessage]);

check('system prompt is unchanged between the two turns', () => {
  assert.equal(turn2[0].content, turn1[0].content);
});

check("previous turn is an exact prefix of the next turn's messages", () => {
  assert.deepEqual(turn2.slice(0, turn1.length), turn1);
});

check('the newest user message is the only new stamped content', () => {
  assert.deepEqual(turn2.slice(turn1.length), [
    assistantReply,
    maybeInjectPromptTimestamp(laterUserMessage, true),
  ]);
});

check('the two-turn stamps are createdAt-derived, not clock-derived', () => {
  assert.equal(
    turn1[1].content,
    `${buildUserMessageStamp(new Date(fixedCreatedAt))}\nfirst question`
  );
});

console.log('loop-level wiring (source assertions)');

// The checks above cover the pure helpers. What they CANNOT cover is the
// property the design actually rests on: that `runSingleAgent` composes the task
// message exactly ONCE, outside its tool-call loop. `runSingleAgent` is not
// exported and cannot be driven from a script, so this is asserted structurally
// against the source - the same source-wiring approach the MCP suites use.
// Without it, moving composition into the loop would pass every check above
// while the stamp drifted per tool-call iteration, defeating the sub-agent's own
// prompt caching.
const subAgentSource = readFileSync('src/tools/impl/subAgentTool.ts', 'utf8').replaceAll(
  /\s+/g,
  ' '
);

check('the start instant is captured once, before the tool-call loop', () => {
  assert.equal(subAgentSource.includes('const agentStartDate = new Date();'), true);
  const declared = subAgentSource.indexOf('const agentStartDate = new Date();');
  const loop = subAgentSource.indexOf('while (!isInterruptOrAbort(signal))');
  assert.notEqual(loop, -1);
  assert.equal(declared < loop, true);
});

check('the task message is composed from the captured instant, not a fresh clock', () => {
  assert.equal(
    subAgentSource.includes('buildSubAgentUserMessage(agent.prompt, priorBlock, agentStartDate)'),
    true
  );
});

check('the task message is composed outside the loop, exactly once', () => {
  const calls = subAgentSource.match(/buildSubAgentUserMessage\(/g) ?? [];
  // One definition plus one call site. A second call site would mean a second
  // composition, which is the failure mode this guard exists to prevent.
  assert.equal(calls.length, 2);
  const callSite = subAgentSource.indexOf('buildSubAgentUserMessage(agent.prompt');
  const loop = subAgentSource.indexOf('while (!isInterruptOrAbort(signal))');
  assert.notEqual(callSite, -1);
  assert.equal(callSite < loop, true);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
