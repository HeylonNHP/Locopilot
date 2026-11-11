/**
 * Tests for the web-page compaction prompt (`buildCompactionPrompt` in
 * src/tools/impl/contentCompactor.ts) and the template helper it uses
 * (src/util/fillTemplate.ts).
 *
 * WHY these tests exist: the prompt used to be filled with chained
 * `String.replace('{name}', value)` calls, which has three defects.
 *
 * 1. A string pattern replaces only the FIRST occurrence. `{charLimit}` appears
 *    three times in the template and `{minCharLimit}` twice, so the model saw
 *    the tightened length target once and literal `{charLimit}` text twice.
 * 2. A string replacement is parsed for `$&`, `` $` ``, `$'` and `$$`, so page
 *    text containing them (shell `$$`, LaTeX `$$...$$`) was rewritten.
 * 3. A value containing a later placeholder would be substituted again.
 *
 * No network, no model call.
 */

import { describe, expect, test } from '@jest/globals';

import { buildCompactionPrompt } from '../src/tools/impl/contentCompactor.ts';
import { fillTemplate } from '../src/util/fillTemplate.ts';

const DOLLAR_SEQUENCES = ['$&', '$$', '$`', "$'", '$1', '$<n>'];

// 2400 characters with no digits and no braces, so number counts and
// leftover-placeholder checks are exact.
const PLAIN = 'lorem ipsum '.repeat(200);

describe('fillTemplate', () => {
  test('fills every occurrence of a placeholder', () => {
    expect(fillTemplate('{a}-{b}-{a}', { a: 1, b: 'x' })).toBe('1-x-1');
  });

  test.each(DOLLAR_SEQUENCES)('inserts %p literally', (sequence) => {
    expect(fillTemplate('[{v}]', { v: `a${sequence}b` })).toBe(`[a${sequence}b]`);
  });

  test('never re-scans inserted text', () => {
    expect(fillTemplate('{a}|{b}', { a: '{b}', b: 'B' })).toBe('{b}|B');
  });

  test.each(['{missing}', '{constructor}', '{toString}'])('throws on %p', (template) => {
    expect(() => fillTemplate(template, {})).toThrow(/has no value/);
  });

  test.each(['{}', '{ a }', '{1}', '{"k":1}'])('leaves %p alone', (template) => {
    expect(fillTemplate(template, {})).toBe(template);
  });
});

describe('the web compaction prompt', () => {
  test.each([
    [1, 950, 807],
    [2, 900, 765],
    [3, 800, 680],
  ])(
    'attempt %p states the target %p three times and the minimum %p twice',
    (attempt, target, minimum) => {
      const prompt = buildCompactionPrompt(PLAIN, 1000, attempt);
      expect(prompt.match(new RegExp(String.raw`\b${target}\b`, 'g'))).toHaveLength(3);
      expect(prompt.match(new RegExp(String.raw`\b${minimum}\b`, 'g'))).toHaveLength(2);
      // No placeholder is left behind.
      expect(prompt).not.toMatch(/{[A-Za-z]\w*}/);
    }
  );

  test.each(DOLLAR_SEQUENCES)('page content containing %p reaches the model verbatim', (seq) => {
    const content = `${PLAIN}price ${seq} end`;
    const control = `${PLAIN}price ${'x'.repeat(seq.length)} end`;
    const prompt = buildCompactionPrompt(content, 1000, 1);
    expect(prompt).toContain(content);
    // Same length as the control: nothing was expanded or collapsed.
    expect(prompt.length).toBe(buildCompactionPrompt(control, 1000, 1).length);
  });

  test('placeholder text inside the page content stays literal', () => {
    const content = `${PLAIN}{retryNote} {charLimit}`;
    const prompt = buildCompactionPrompt(content, 1000, 2);
    expect(prompt).toContain(content);
    expect(prompt.match(/Retry guidance/g)).toHaveLength(1);
  });
});
