#!/usr/bin/env node
/**
 * Tests for the compaction receipt — the line the transcript shows after a
 * compaction (`src/services/compact/receipt.ts`).
 *
 * Run with: npx tsx scripts/test-compact-receipt.mjs
 *
 * WHY the strings are pinned EXACTLY. The receipt is the only place the user
 * is told what a compaction did, and it is easy to make it lie in a way no one
 * notices:
 *
 *   - a percentage with no `~` implies a precision a local tokenizer estimate
 *     does not have;
 *   - "0% smaller" for a saving that rounded down to nothing reads as "nothing
 *     happened", when the history did shrink;
 *   - an equal-size result reported as a success hides the fact that the pass
 *     achieved nothing;
 *   - and silence about a result that is STILL over the window hides the one
 *     outcome the user has to act on — the next turn may fail.
 *
 * Both paths (manual `/compact` and automatic) now go through this one
 * function, so pinning it here pins both.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { formatCompactionReceipt, formatTokenCount } from '../src/services/compact/receipt.ts';

let passed = 0;
let failed = 0;

/**
 * Runs one check and records the result.
 *
 * @param {string} label - what the check asserts.
 * @param {() => void} fn - the check.
 */
function check(label, fn) {
  try {
    fn();
    console.log(`  PASS  ${label}`);
    passed += 1;
  } catch (err) {
    console.error(`  FAIL  ${label}`);
    console.error(`        ${err instanceof Error ? err.message : String(err)}`);
    failed += 1;
  }
}

console.log('the token count');

check('counts are rounded and grouped with commas', () => {
  assert.equal(formatTokenCount(181204), '181,204');
  assert.equal(formatTokenCount(999), '999');
  assert.equal(formatTokenCount(1000), '1,000');
  assert.equal(formatTokenCount(0), '0');
});

check('a fractional estimate is rounded, not truncated', () => {
  // The counts are estimates produced by arithmetic (sums, ratios), so they
  // arrive fractional; `Math.round` keeps 2.5 and 2.4 from both printing "2".
  assert.equal(formatTokenCount(12.4), '12');
  assert.equal(formatTokenCount(12.5), '13');
  assert.equal(formatTokenCount(1234.6), '1,235');
});

console.log('a compaction that reduced the history');

check('the status line names both counts and the percentage saved', () => {
  const { text, warning } = formatCompactionReceipt({
    oldTokenCount: 181204,
    newTokenCount: 12880,
  });
  assert.equal(text, '⚡ Conversation compacted: 181,204 → 12,880 tokens (~93% smaller).');
  assert.equal(warning, null);
});

check('the automatic path says auto-compacted', () => {
  const { text } = formatCompactionReceipt({
    oldTokenCount: 181204,
    newTokenCount: 12880,
    automatic: true,
  });
  assert.equal(text, '⚡ Conversation auto-compacted: 181,204 → 12,880 tokens (~93% smaller).');
});

check('the percentage is whole and prefixed with a tilde', () => {
  // 100 → 50 is 50 %. A receipt that printed 50.0 % would claim a precision
  // the estimate does not have.
  const { text } = formatCompactionReceipt({ oldTokenCount: 100, newTokenCount: 50 });
  assert.equal(text, '⚡ Conversation compacted: 100 → 50 tokens (~50% smaller).');
});

check('a saving that rounds to nothing is reported as under one percent', () => {
  // 10,000 → 9,999 is a real (if tiny) reduction: 0.01 %, which rounds to 0.
  // "~0% smaller" reads as "nothing happened", which is wrong — something did.
  const { text } = formatCompactionReceipt({ oldTokenCount: 10000, newTokenCount: 9999 });
  assert.equal(text, '⚡ Conversation compacted: 10,000 → 9,999 tokens (<1% smaller).');
});

check('a hundred percent reduction does not divide by zero or read oddly', () => {
  const { text } = formatCompactionReceipt({ oldTokenCount: 500, newTokenCount: 0 });
  assert.equal(text, '⚡ Conversation compacted: 500 → 0 tokens (~100% smaller).');
});

console.log('a compaction that achieved nothing');

check('equal counts are reported as a failure to reduce, not as a success', () => {
  const { text, warning } = formatCompactionReceipt({
    oldTokenCount: 181204,
    newTokenCount: 181204,
  });
  assert.equal(text, '⚠️ Compaction could not reduce the context: 181,204 → 181,204 tokens.');
  assert.equal(warning, null);
});

check('a result LARGER than its input is reported the same way', () => {
  // `compactHistory` aborts that case, so the receipt should never see it —
  // but a formatter that divided the two counts would print a negative
  // percentage, and one that took the absolute value would call it a success.
  const { text } = formatCompactionReceipt({ oldTokenCount: 100, newTokenCount: 140 });
  assert.equal(text, '⚠️ Compaction could not reduce the context: 100 → 140 tokens.');
});

console.log('a compaction with no usable counts');

check('missing counts fall back to a bare line rather than a made-up ratio', () => {
  assert.equal(formatCompactionReceipt({}).text, '⚡ Conversation compacted.');
  assert.equal(formatCompactionReceipt({ oldTokenCount: 500 }).text, '⚡ Conversation compacted.');
  assert.equal(formatCompactionReceipt({ newTokenCount: 100 }).text, '⚡ Conversation compacted.');
  assert.equal(
    formatCompactionReceipt({ oldTokenCount: null, newTokenCount: null }).text,
    '⚡ Conversation compacted.'
  );
});

check('the automatic path says auto-compacted here too', () => {
  assert.equal(
    formatCompactionReceipt({ automatic: true }).text,
    '⚡ Conversation auto-compacted.'
  );
});

check('an empty old history is not divided by zero', () => {
  const { text } = formatCompactionReceipt({ oldTokenCount: 0, newTokenCount: 0 });
  assert.equal(text, '⚡ Conversation compacted.');
});

console.log('a result that is still over the window');

check('a result over the window carries a warning naming both counts', () => {
  const { text, warning } = formatCompactionReceipt({
    oldTokenCount: 181204,
    newTokenCount: 93400,
    tokenLimit: 65536,
  });
  assert.equal(text, '⚡ Conversation compacted: 181,204 → 93,400 tokens (~48% smaller).');
  assert.equal(
    warning,
    '⚠️ The compacted history is still over the context window (93,400 of 65,536 tokens, estimated). The next turn may fail.'
  );
});

check('a result EXACTLY at the limit fits, so there is no warning', () => {
  // Strictly greater, on purpose: a history of exactly `tokenLimit` tokens is
  // a request the provider accepts, and warning about it would be noise the
  // user cannot act on.
  const { warning } = formatCompactionReceipt({
    oldTokenCount: 100000,
    newTokenCount: 65536,
    tokenLimit: 65536,
  });
  assert.equal(warning, null);
});

check('one token over the limit does warn', () => {
  const { warning } = formatCompactionReceipt({
    oldTokenCount: 100000,
    newTokenCount: 65537,
    tokenLimit: 65536,
  });
  assert.notEqual(warning, null);
});

check('a missing or zero limit never warns', () => {
  // A caller that could not resolve a window must not turn every compaction
  // into a warning; 0 is "unknown", not "no room at all".
  for (const tokenLimit of [undefined, null, 0, -1, Number.NaN]) {
    const { warning } = formatCompactionReceipt({
      oldTokenCount: 100000,
      newTokenCount: 93400,
      tokenLimit,
    });
    assert.equal(warning, null, `tokenLimit ${String(tokenLimit)} produced a warning`);
  }
});

check('the warning is separate from the status line', () => {
  // Two bubbles, one line each: a status line that swallowed the warning would
  // be a paragraph nobody reads.
  const { text } = formatCompactionReceipt({
    oldTokenCount: 181204,
    newTokenCount: 93400,
    tokenLimit: 65536,
  });
  assert.ok(!text.includes('\n'), 'the status line has a line break');
  assert.ok(
    !text.includes('still over the context window'),
    'the warning leaked into the status line'
  );
});

console.log('the focus note');

check('the note is quoted back so the user can see which one was used', () => {
  const { text } = formatCompactionReceipt({
    oldTokenCount: 181204,
    newTokenCount: 12880,
    focus: 'keep the auth refactor details',
  });
  assert.equal(
    text,
    '⚡ Conversation compacted: 181,204 → 12,880 tokens (~93% smaller). Kept what you asked for: “keep the auth refactor details”.'
  );
});

check('a long note is elided at 60 characters', () => {
  const focus = `${'a'.repeat(59)}b${'c'.repeat(500)}`;
  const { text } = formatCompactionReceipt({ oldTokenCount: 100, newTokenCount: 50, focus });
  assert.ok(
    text.endsWith(`Kept what you asked for: “${'a'.repeat(59)}b…”.`),
    `the note was not elided at 60 characters: ${JSON.stringify(text)}`
  );
});

check('a note of exactly 60 characters is not elided', () => {
  const focus = 'a'.repeat(60);
  const { text } = formatCompactionReceipt({ oldTokenCount: 100, newTokenCount: 50, focus });
  assert.ok(text.endsWith(`“${focus}”.`), `a 60-character note was cut: ${JSON.stringify(text)}`);
});

check('a blank note adds nothing', () => {
  for (const focus of [undefined, '', '   ']) {
    const { text } = formatCompactionReceipt({ oldTokenCount: 100, newTokenCount: 50, focus });
    assert.equal(text, '⚡ Conversation compacted: 100 → 50 tokens (~50% smaller).');
  }
});

check('the token badge uses the SAME limit as the receipt', () => {
  // The receipt prefers `compactData.tokenLimit`; the badge used to ignore it
  // and show the client's own `effectiveNumCtx`. When the two disagree the
  // screen contradicts itself: a badge reading "8,192" next to a warning
  // saying the history is over 4,096 tokens. Both now read the server's value
  // first and fall back to the resolved refs only when it is absent.
  const source = readFileSync(
    fileURLToPath(new URL('../src/app/hooks/useSlashCommands.ts', import.meta.url)),
    'utf8'
  );
  const setStatsIndex = source.indexOf("type: 'SET_TOKEN_STATS'");
  assert.notEqual(setStatsIndex, -1, 'useSlashCommands never dispatches SET_TOKEN_STATS');
  const block = source.slice(setStatsIndex, source.indexOf('});', setStatsIndex));
  const limitIndex = block.indexOf('tokenLimit:');
  assert.notEqual(limitIndex, -1, 'the badge carries no tokenLimit');
  const limit = block.slice(limitIndex);
  assert.ok(limit.includes('compactData.tokenLimit'), "the badge ignores the server's tokenLimit");
  assert.ok(
    limit.indexOf('compactData.tokenLimit') < limit.indexOf('effectiveForLimit'),
    'the badge prefers the client window over the server value'
  );
  assert.ok(
    limit.includes('refs.requestedNumCtxRef.current'),
    'the badge no longer falls back to the requested window'
  );
  // And the receipt a few lines later still prefers the server value, so the
  // two cannot drift apart again.
  const receiptIndex = source.indexOf('formatCompactionReceipt({');
  assert.notEqual(receiptIndex, -1, 'the client never builds the receipt');
  assert.ok(
    source.slice(receiptIndex).includes('compactData.tokenLimit'),
    'the receipt stopped preferring the server tokenLimit'
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
