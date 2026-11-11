/**
 * Regression guard for prompt-cache prefix stability.
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

import { describe, expect, test } from '@jest/globals';
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

const NO_CLOCK = /\b\d{1,2}(?::\d{2}){1,2}\b/;

// ─── (a) formatPromptDate ────────────────────────────────────────────────────
describe('formatPromptDate', () => {
  const sameDayEarly = new Date(2026, 8, 24, 0, 0, 1);
  const sameDayLate = new Date(2026, 8, 24, 23, 59, 59);
  const nextDay = new Date(2026, 8, 25, 0, 0, 1);

  test('identical at 00:00:01 and 23:59:59 on the same local day', () => {
    expect(formatPromptDate(sameDayEarly)).toBe(formatPromptDate(sameDayLate));
  });

  test('differs across a local day boundary', () => {
    expect(formatPromptDate(sameDayEarly)).not.toBe(formatPromptDate(nextDay));
  });

  test('contains no time-of-day clock', () => {
    const s = formatPromptDate(sameDayEarly);
    expect(s).not.toMatch(NO_CLOCK);
    expect(s).not.toMatch(/\b(?:AM|PM)\b/);
  });

  test('reads as a calendar date', () => {
    expect(formatPromptDate(sameDayEarly)).toBe('Thursday, September 24, 2026');
  });
});

// ─── (b) buildUserMessageStamp / maybeInjectPromptTimestamp ──────────────────
// Deliberately far in the past and well separated from each other. A stamp taken
// from the current clock instead of from `createdAt` would render both as the
// same "now" string, which is exactly what the assertions below reject. (An
// earlier revision of this guard used `createdAt` values close to "now" and
// built both synthetic turns inside the same wall-clock minute, so a regression
// that ignored `createdAt` entirely still passed. The dates below close that.)
const fixedCreatedAt = new Date('2024-03-05T07:08:00.000Z').toISOString();

const otherCreatedAt = new Date('2021-11-30T21:42:00.000Z').toISOString();

describe('buildUserMessageStamp', () => {
  test('keeps the [Sent YYYY-MM-DD HH:MM] shape', () => {
    expect(buildUserMessageStamp(new Date(fixedCreatedAt))).toMatch(
      /^\[Sent \d{4}-\d{2}-\d{2} \d{2}:\d{2}]$/
    );
  });

  test('is deterministic for a fixed instant', () => {
    expect(buildUserMessageStamp(new Date(fixedCreatedAt))).toBe(
      buildUserMessageStamp(new Date(fixedCreatedAt))
    );
  });
});

const userMessage = { role: 'user', content: 'first question', createdAt: fixedCreatedAt };

const laterUserMessage = {
  role: 'user',
  content: 'second question',
  createdAt: new Date('2024-03-05T07:09:00.000Z').toISOString(),
};

describe('maybeInjectPromptTimestamp', () => {
  test('is deterministic for a fixed createdAt', () => {
    expect(maybeInjectPromptTimestamp(userMessage, true)).toStrictEqual(
      maybeInjectPromptTimestamp(userMessage, true)
    );
  });

  test('prepends the stamp and strips createdAt', () => {
    const result = maybeInjectPromptTimestamp(userMessage, true);
    expect('createdAt' in result).toBe(false);
    expect(result.content).toMatch(/^\[Sent \d{4}-\d{2}-\d{2} \d{2}:\d{2}]\nfirst question$/);
  });

  test('stamp is derived from createdAt, not from the current clock', () => {
    const result = maybeInjectPromptTimestamp(userMessage, true);
    expect(result.content).toBe(
      `${buildUserMessageStamp(new Date(fixedCreatedAt))}\nfirst question`
    );
    expect(result.content.startsWith(buildUserMessageStamp(new Date()))).toBe(false);
  });

  test('different createdAt values produce different stamps', () => {
    const a = maybeInjectPromptTimestamp(userMessage, true);
    const b = maybeInjectPromptTimestamp(
      { role: 'user', content: 'first question', createdAt: otherCreatedAt },
      true
    );
    expect(a.content.split('\n')[0]).not.toBe(b.content.split('\n')[0]);
  });

  test('is idempotent (does not double-stamp)', () => {
    const once = maybeInjectPromptTimestamp(userMessage, true);
    const twice = maybeInjectPromptTimestamp(once, true);
    expect(twice.content).toBe(once.content);
  });

  test('returns the message unchanged when the toggle is off', () => {
    expect(maybeInjectPromptTimestamp(userMessage, false)).toStrictEqual(userMessage);
  });

  test('returns non-user messages unchanged', () => {
    const assistant = { role: 'assistant', content: 'hi', createdAt: fixedCreatedAt };
    expect(maybeInjectPromptTimestamp(assistant, true)).toStrictEqual(assistant);
    expect('createdAt' in maybeInjectPromptTimestamp(assistant, true)).toBe(true);
  });

  test('returns a message without createdAt unchanged', () => {
    const bare = { role: 'user', content: 'no timestamp' };
    expect(maybeInjectPromptTimestamp(bare, true)).toStrictEqual(bare);
  });
});

// ─── (c) system prompts are stable across builds ─────────────────────────────
const t1 = new Date(2026, 8, 24, 10, 0, 0);

const t1b = new Date(2026, 8, 24, 10, 0, 59);

const t2 = new Date(2026, 8, 24, 10, 5, 0);

describe('createSystemPrompt', () => {
  const tNextDay = new Date(2026, 8, 25, 10, 0, 0);

  test('byte-identical across two builds 59 seconds apart (same day)', () => {
    expect(createSystemPrompt(undefined, false, true, t1)).toBe(
      createSystemPrompt(undefined, false, true, t1b)
    );
  });

  test('byte-identical across two builds 5 minutes apart (same day)', () => {
    expect(createSystemPrompt(undefined, false, true, t1)).toBe(
      createSystemPrompt(undefined, false, true, t2)
    );
  });

  test('still tracks the calendar day', () => {
    expect(createSystemPrompt(undefined, false, true, t1)).not.toBe(
      createSystemPrompt(undefined, false, true, tNextDay)
    );
  });

  test('states the date on the second line, with no clock', () => {
    const lines = createSystemPrompt(undefined, false, true, t1).split('\n');
    expect(lines[1]).toBe(`Current date: ${formatPromptDate(t1)}`);
    expect(lines[1]).not.toMatch(NO_CLOCK);
  });

  test('no longer emits the old per-second clock wording', () => {
    // Case-insensitive on purpose: a lower-cased "the current date and time:"
    // would still read as a live clock, and this is the exact phrase whose
    // reintroduction would undo the whole change.
    expect(createSystemPrompt(undefined, false, true, t1)).not.toMatch(/current date and time:/i);
  });
});

describe('buildSubAgentSystemPrompt', () => {
  test('byte-identical across two builds 59 seconds apart (same day)', () => {
    expect(buildSubAgentSystemPrompt(undefined, true, t1)).toBe(
      buildSubAgentSystemPrompt(undefined, true, t1b)
    );
  });

  test('states the date, with no clock and no old wording', () => {
    const prompt = buildSubAgentSystemPrompt(undefined, true, t1);
    expect(prompt.split('\n')[1]).toBe(`Current date: ${formatPromptDate(t1)}`);
    expect(prompt).not.toMatch(/current date and time:/i);
  });
});

// ─── (c2) sub-agent time grounding ───────────────────────────────────────────
describe('formatPromptDateTime', () => {
  test('is identical for two instants inside the same minute', () => {
    expect(formatPromptDateTime(new Date(2026, 8, 24, 11, 23, 0))).toBe(
      formatPromptDateTime(new Date(2026, 8, 24, 11, 23, 59))
    );
  });

  test('differs across minutes', () => {
    expect(formatPromptDateTime(new Date(2026, 8, 24, 11, 23, 0))).not.toBe(
      formatPromptDateTime(new Date(2026, 8, 24, 11, 24, 0))
    );
  });

  test('agrees with formatPromptDate on the date, and carries no seconds', () => {
    const d = new Date(2026, 8, 24, 11, 23, 0);
    const dateTime = formatPromptDateTime(d);
    expect(dateTime.startsWith(formatPromptDate(d))).toBe(true);
    expect(dateTime).not.toMatch(/\d{1,2}:\d{2}:\d{2}/);
  });
});

describe('buildSubAgentUserMessage', () => {
  const subAgentNow = new Date(2026, 8, 24, 11, 23, 0);
  const subAgentPrompt = 'Research the current state of quantum error correction.';

  test('leads with the sub-agent start-time header', () => {
    const content = buildSubAgentUserMessage(subAgentPrompt, '', subAgentNow);
    expect(content.split('\n')[0]).toBe(
      `Sub-agent start time (fixed; does not advance): ${formatPromptDateTime(subAgentNow)}`
    );
  });

  test('names the value as a start time and not as a live clock', () => {
    const firstLine = buildSubAgentUserMessage(subAgentPrompt, '', subAgentNow).split('\n')[0];
    expect(firstLine).toMatch(
      /^Sub-agent start time \(fixed; does not advance\): \w+day, \w+ \d{1,2}, \d{4} at \d{1,2}:\d{2} (?:AM|PM)/
    );
    // Regression guard: a value that reads as "now" is exactly the bug this
    // wording exists to avoid, because the value is frozen at agent start.
    expect(firstLine).not.toMatch(/current (?:date and time|time)/i);
  });

  test('tells the agent the start time is fixed and how to get the true time', () => {
    const prompt = buildSubAgentSystemPrompt(undefined, true, t1);
    expect(prompt).toMatch(/does not advance/);
    expect(prompt).toMatch(/Get-Date/);
    expect(prompt).toMatch(/may be earlier or later/);
    expect(prompt).toMatch(/say so if you had to assume/);
    // The rule must not resurrect the live-clock phrase in the shared prompt.
    // Case-insensitive, so a lower-cased variant cannot slip through.
    expect(prompt).not.toMatch(/current date and time:/i);
  });

  test('is byte-identical for a fixed start instant (the agent-lifetime property)', () => {
    expect(buildSubAgentUserMessage(subAgentPrompt, '', subAgentNow)).toBe(
      buildSubAgentUserMessage(subAgentPrompt, '', subAgentNow)
    );
  });

  test('is byte-identical for two instants inside the same minute', () => {
    expect(buildSubAgentUserMessage(subAgentPrompt, '', subAgentNow)).toBe(
      buildSubAgentUserMessage(subAgentPrompt, '', new Date(2026, 8, 24, 11, 23, 59))
    );
  });

  test('keeps the prior-results block and the task after the header', () => {
    const content = buildSubAgentUserMessage(
      subAgentPrompt,
      '## Prior results\n\nstuff\n\n---\n\n',
      subAgentNow
    );
    expect(content.endsWith(subAgentPrompt)).toBe(true);
    expect(content.includes('## Prior results')).toBe(true);
    const headerIndex = content.indexOf('Sub-agent start time');
    expect(headerIndex).toBe(0);
    expect(content.indexOf('## Prior results') > headerIndex).toBe(true);
  });

  test('the shared system prompt is unaffected, so cross-agent reuse survives', () => {
    // Two agents started five minutes apart must still share a byte-identical
    // system prompt; only their task messages differ.
    expect(buildSubAgentSystemPrompt(undefined, true, t1)).toBe(
      buildSubAgentSystemPrompt(undefined, true, t2)
    );
    expect(buildSubAgentUserMessage(subAgentPrompt, '', t1)).not.toBe(
      buildSubAgentUserMessage(subAgentPrompt, '', t2)
    );
  });
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
describe('two-turn prefix', () => {
  const buildTurn = (now, history) => [
    { role: 'system', content: createSystemPrompt(undefined, false, true, now) },
    ...history.map((m) => maybeInjectPromptTimestamp(m, true)),
  ];

  const assistantReply = { role: 'assistant', content: 'answer' };

  const turn1 = buildTurn(t1, [userMessage]);
  const turn2 = buildTurn(t2, [userMessage, assistantReply, laterUserMessage]);

  test('system prompt is unchanged between the two turns', () => {
    expect(turn2[0].content).toBe(turn1[0].content);
  });

  test("previous turn is an exact prefix of the next turn's messages", () => {
    expect(turn2.slice(0, turn1.length)).toStrictEqual(turn1);
  });

  test('the newest user message is the only new stamped content', () => {
    expect(turn2.slice(turn1.length)).toStrictEqual([
      assistantReply,
      maybeInjectPromptTimestamp(laterUserMessage, true),
    ]);
  });

  test('the two-turn stamps are createdAt-derived, not clock-derived', () => {
    expect(turn1[1].content).toBe(
      `${buildUserMessageStamp(new Date(fixedCreatedAt))}\nfirst question`
    );
  });
});

describe('loop-level wiring (source assertions)', () => {
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

  test('the start instant is captured once, before the tool-call loop', () => {
    expect(subAgentSource.includes('const agentStartDate = new Date();')).toBe(true);
    const declared = subAgentSource.indexOf('const agentStartDate = new Date();');
    const loop = subAgentSource.indexOf('while (!isInterruptOrAbort(signal))');
    expect(loop).not.toBe(-1);
    expect(declared < loop).toBe(true);
  });

  test('the task message is composed from the captured instant, not a fresh clock', () => {
    expect(
      subAgentSource.includes('buildSubAgentUserMessage(agent.prompt, priorBlock, agentStartDate)')
    ).toBe(true);
  });

  test('the task message is composed outside the loop, exactly once', () => {
    const calls = subAgentSource.match(/buildSubAgentUserMessage\(/g) ?? [];
    // One definition plus one call site. A second call site would mean a second
    // composition, which is the failure mode this guard exists to prevent.
    expect(calls).toHaveLength(2);
    const callSite = subAgentSource.indexOf('buildSubAgentUserMessage(agent.prompt');
    const loop = subAgentSource.indexOf('while (!isInterruptOrAbort(signal))');
    expect(callSite).not.toBe(-1);
    expect(callSite < loop).toBe(true);
  });
});
