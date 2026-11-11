/**
 * Tests for the compaction receipt — the line the transcript shows after a
 * compaction (`src/services/compact/receipt.ts`).
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

import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { formatCompactionReceipt, formatTokenCount } from '../src/services/compact/receipt.ts';

describe('the token count', () => {
  test('counts are rounded and grouped with commas', () => {
    expect(formatTokenCount(181204)).toBe('181,204');
    expect(formatTokenCount(999)).toBe('999');
    expect(formatTokenCount(1000)).toBe('1,000');
    expect(formatTokenCount(0)).toBe('0');
  });

  test('a fractional estimate is rounded, not truncated', () => {
    // The counts are estimates produced by arithmetic (sums, ratios), so they
    // arrive fractional; `Math.round` keeps 2.5 and 2.4 from both printing "2".
    expect(formatTokenCount(12.4)).toBe('12');
    expect(formatTokenCount(12.5)).toBe('13');
    expect(formatTokenCount(1234.6)).toBe('1,235');
  });
});

describe('a compaction that reduced the history', () => {
  test('the status line names both counts and the percentage saved', () => {
    const { text, warning } = formatCompactionReceipt({
      oldTokenCount: 181204,
      newTokenCount: 12880,
    });
    expect(text).toBe('⚡ Conversation compacted: 181,204 → 12,880 tokens (~93% smaller).');
    expect(warning).toBeNull();
  });

  test('the automatic path says auto-compacted', () => {
    const { text } = formatCompactionReceipt({
      oldTokenCount: 181204,
      newTokenCount: 12880,
      automatic: true,
    });
    expect(text).toBe('⚡ Conversation auto-compacted: 181,204 → 12,880 tokens (~93% smaller).');
  });

  test('the percentage is whole and prefixed with a tilde', () => {
    // 100 → 50 is 50 %. A receipt that printed 50.0 % would claim a precision
    // the estimate does not have.
    const { text } = formatCompactionReceipt({ oldTokenCount: 100, newTokenCount: 50 });
    expect(text).toBe('⚡ Conversation compacted: 100 → 50 tokens (~50% smaller).');
  });

  test('a saving that rounds to nothing is reported as under one percent', () => {
    // 10,000 → 9,999 is a real (if tiny) reduction: 0.01 %, which rounds to 0.
    // "~0% smaller" reads as "nothing happened", which is wrong — something did.
    const { text } = formatCompactionReceipt({ oldTokenCount: 10000, newTokenCount: 9999 });
    expect(text).toBe('⚡ Conversation compacted: 10,000 → 9,999 tokens (<1% smaller).');
  });

  test('a hundred percent reduction does not divide by zero or read oddly', () => {
    const { text } = formatCompactionReceipt({ oldTokenCount: 500, newTokenCount: 0 });
    expect(text).toBe('⚡ Conversation compacted: 500 → 0 tokens (~100% smaller).');
  });
});

describe('a compaction that achieved nothing', () => {
  test('equal counts are reported as a failure to reduce, not as a success', () => {
    const { text, warning } = formatCompactionReceipt({
      oldTokenCount: 181204,
      newTokenCount: 181204,
    });
    expect(text).toBe('⚠️ Compaction could not reduce the context: 181,204 → 181,204 tokens.');
    expect(warning).toBeNull();
  });

  test('a result LARGER than its input is reported the same way', () => {
    // `compactHistory` aborts that case, so the receipt should never see it —
    // but a formatter that divided the two counts would print a negative
    // percentage, and one that took the absolute value would call it a success.
    const { text } = formatCompactionReceipt({ oldTokenCount: 100, newTokenCount: 140 });
    expect(text).toBe('⚠️ Compaction could not reduce the context: 100 → 140 tokens.');
  });
});

describe('a compaction with no usable counts', () => {
  test('missing counts fall back to a bare line rather than a made-up ratio', () => {
    expect(formatCompactionReceipt({}).text).toBe('⚡ Conversation compacted.');
    expect(formatCompactionReceipt({ oldTokenCount: 500 }).text).toBe('⚡ Conversation compacted.');
    expect(formatCompactionReceipt({ newTokenCount: 100 }).text).toBe('⚡ Conversation compacted.');
    expect(formatCompactionReceipt({ oldTokenCount: null, newTokenCount: null }).text).toBe(
      '⚡ Conversation compacted.'
    );
  });

  test('the automatic path says auto-compacted here too', () => {
    expect(formatCompactionReceipt({ automatic: true }).text).toBe(
      '⚡ Conversation auto-compacted.'
    );
  });

  test('an empty old history is not divided by zero', () => {
    const { text } = formatCompactionReceipt({ oldTokenCount: 0, newTokenCount: 0 });
    expect(text).toBe('⚡ Conversation compacted.');
  });
});

describe('a result that is still over the window', () => {
  test('a result over the window carries a warning naming both counts', () => {
    const { text, warning } = formatCompactionReceipt({
      oldTokenCount: 181204,
      newTokenCount: 93400,
      tokenLimit: 65536,
    });
    expect(text).toBe('⚡ Conversation compacted: 181,204 → 93,400 tokens (~48% smaller).');
    expect(warning).toBe(
      '⚠️ The compacted history is still over the context window (93,400 of 65,536 tokens, estimated). The next turn may fail.'
    );
  });

  test('a result EXACTLY at the limit fits, so there is no warning', () => {
    // Strictly greater, on purpose: a history of exactly `tokenLimit` tokens is
    // a request the provider accepts, and warning about it would be noise the
    // user cannot act on.
    const { warning } = formatCompactionReceipt({
      oldTokenCount: 100000,
      newTokenCount: 65536,
      tokenLimit: 65536,
    });
    expect(warning).toBeNull();
  });

  test('one token over the limit does warn', () => {
    const { warning } = formatCompactionReceipt({
      oldTokenCount: 100000,
      newTokenCount: 65537,
      tokenLimit: 65536,
    });
    expect(warning).not.toBeNull();
  });

  test('a missing or zero limit never warns', () => {
    // A caller that could not resolve a window must not turn every compaction
    // into a warning; 0 is "unknown", not "no room at all".
    for (const tokenLimit of [undefined, null, 0, -1, Number.NaN]) {
      const { warning } = formatCompactionReceipt({
        oldTokenCount: 100000,
        newTokenCount: 93400,
        tokenLimit,
      });
      expect(warning).toBeNull();
    }
  });

  test('the warning is separate from the status line', () => {
    // Two bubbles, one line each: a status line that swallowed the warning would
    // be a paragraph nobody reads.
    const { text } = formatCompactionReceipt({
      oldTokenCount: 181204,
      newTokenCount: 93400,
      tokenLimit: 65536,
    });
    expect(text).not.toContain('\n');
    expect(text).not.toContain('still over the context window');
  });
});

describe('the focus note', () => {
  test('the note is quoted back so the user can see which one was used', () => {
    const { text } = formatCompactionReceipt({
      oldTokenCount: 181204,
      newTokenCount: 12880,
      focus: 'keep the auth refactor details',
    });
    expect(text).toBe(
      '⚡ Conversation compacted: 181,204 → 12,880 tokens (~93% smaller). Kept what you asked for: “keep the auth refactor details”.'
    );
  });

  test('a long note is elided at 60 characters', () => {
    const focus = `${'a'.repeat(59)}b${'c'.repeat(500)}`;
    const { text } = formatCompactionReceipt({ oldTokenCount: 100, newTokenCount: 50, focus });
    expect(text.endsWith(`Kept what you asked for: “${'a'.repeat(59)}b…”.`)).toBeTruthy();
  });

  test('a note of exactly 60 characters is not elided', () => {
    const focus = 'a'.repeat(60);
    const { text } = formatCompactionReceipt({ oldTokenCount: 100, newTokenCount: 50, focus });
    expect(text.endsWith(`“${focus}”.`)).toBeTruthy();
  });

  test('a blank note adds nothing', () => {
    for (const focus of [undefined, '', '   ']) {
      const { text } = formatCompactionReceipt({ oldTokenCount: 100, newTokenCount: 50, focus });
      expect(text).toBe('⚡ Conversation compacted: 100 → 50 tokens (~50% smaller).');
    }
  });

  test('the token badge uses the SAME limit as the receipt', () => {
    // The receipt prefers `compactData.tokenLimit`; the badge used to ignore it
    // and show the client's own `effectiveNumCtx`. When the two disagree the
    // screen contradicts itself: a badge reading "8,192" next to a warning
    // saying the history is over 4,096 tokens. Both now read the server's value
    // first and fall back to the server's last resolved window only when it is
    // absent. The user's SETTING is no longer a fallback for the badge: written
    // into the stats it was promoted into `effectiveNumCtx` as if the server had
    // reported it (the status bar derives the window from the setting itself),
    // so a frame without a window now leaves the limit unknown instead.
    const source = readFileSync(
      fileURLToPath(new URL('../src/app/hooks/useSlashCommands.ts', import.meta.url)),
      'utf8'
    ).replaceAll('\r\n', '\n');
    const badgeIndex = source.indexOf('const badgeLimit =');
    expect(badgeIndex).not.toBe(-1);
    const badgeLimit = source.slice(badgeIndex, source.indexOf(';', badgeIndex));
    expect(badgeLimit).toContain('compactData.tokenLimit');
    expect(badgeLimit.indexOf('compactData.tokenLimit')).toBeLessThan(
      badgeLimit.indexOf('effectiveForLimit')
    );
    expect(badgeLimit).not.toContain('requestedNumCtxRef');
    const setStatsIndex = source.indexOf("type: 'SET_TOKEN_STATS'");
    expect(setStatsIndex).not.toBe(-1);
    const block = source.slice(setStatsIndex, source.indexOf('});', setStatsIndex));
    expect(block).toContain('badgeLimit === null ? {} : { tokenLimit: badgeLimit }');
    // And the receipt a few lines later still prefers the server value, so the
    // two cannot drift apart again.
    const receiptIndex = source.indexOf('formatCompactionReceipt({');
    expect(receiptIndex).not.toBe(-1);
    expect(source.slice(receiptIndex)).toContain('compactData.tokenLimit');
  });
});
