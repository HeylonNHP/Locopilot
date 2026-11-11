/**
 * Regression checks for loud sub-agent failure reporting.
 *
 * No network, no live server: the two renderers under test are pure string
 * functions.
 *
 * Policy under test (deliberate product decision): when a sub-agent dies before
 * returning its final summary, the orchestrator is told LOUDLY that the work is
 * missing. There is no partial-summary salvage — a truncated report is
 * unverifiable, and `share_summaries` would feed it to sibling agents as trusted
 * context. The failure must (a) lead the tool result, and (b) never be described
 * as a completed agent with an empty report.
 */

import { describe, expect, test } from '@jest/globals';

const { formatAgentFailure, formatCombinedResults, formatPriorResultsBlock } =
  await import('../src/tools/impl/subAgentTool.ts');

const REASON =
  '400 request (326517 tokens) exceeds the available context size (262144 tokens), try increasing it';

describe('formatAgentFailure — wording', () => {
  test('names the agent', () => {
    expect(formatAgentFailure('odometer-location', REASON)).toMatch(/odometer-location/);
  });
  test('says no summary was returned', () => {
    expect(formatAgentFailure('a', REASON)).toMatch(/returned no summary/i);
  });
  test('says the work is missing, not empty', () => {
    expect(formatAgentFailure('a', REASON)).toMatch(/missing, not empty/i);
  });
  test('includes the underlying reason verbatim', () => {
    expect(formatAgentFailure('a', REASON)).toContain(REASON);
  });
  test('tells the parent how to recover', () => {
    expect(formatAgentFailure('a', REASON)).toMatch(/re-run this agent with run_subagents/i);
  });
  test('is not a salvaged partial-summary format', () => {
    expect(formatAgentFailure('a', REASON)).not.toMatch(/final_response|partial/i);
  });
});

describe('formatCombinedResults — failure banner', () => {
  const failedRun = formatCombinedResults(
    [
      { id: 'gt5-save-structure', content: '# A very long report…' },
      { id: 'odometer-location', content: '', failure: REASON },
    ],
    false
  );

  test('banner leads the tool result', () => {
    expect(failedRun.startsWith('[⚠')).toBeTruthy();
  });
  test('banner counts failures against total', () => {
    expect(failedRun).toMatch(/1 of 2 sub-agent\(s\) returned NO summary/);
  });
  test('banner names the failed agent', () => {
    expect(failedRun).toMatch(/"odometer-location"/);
  });
  test('banner forbids treating the gap as empty', () => {
    expect(failedRun).toMatch(/MISSING, not empty/);
  });
  test('banner suggests the recovery action', () => {
    expect(failedRun).toMatch(/re-run those agents with run_subagents/);
  });
  test('banner precedes the successful agent report', () => {
    expect(failedRun.indexOf('[⚠')).toBeLessThan(failedRun.indexOf('gt5-save-structure'));
  });
  test('successful agent still renders normally', () => {
    expect(failedRun).toMatch(
      /sub_agent: gt5-save-structure\nfinal_response:\n# A very long report…/
    );
  });
  test('failed agent renders the loud notice, not an empty body', () => {
    const section = failedRun.slice(failedRun.indexOf('sub_agent: odometer-location'));
    expect(section).toMatch(/returned NO summary/);
    expect(section).not.toMatch(/completed without a final text response/);
  });
});

describe('formatCombinedResults — no failures', () => {
  const cleanRun = formatCombinedResults([{ id: 'a', content: 'report' }], false);
  test('no banner when every agent returned a summary', () => {
    expect(cleanRun).not.toMatch(/⚠/);
  });
  test('clean output is unchanged in shape', () => {
    expect(cleanRun).toBe('sub_agent: a\nfinal_response:\nreport');
  });
  test('interrupted suffix is preserved', () => {
    expect(formatCombinedResults([{ id: 'a', content: 'r' }], true)).toMatch(/interrupted by user/);
  });
  test('all-failed run still reports the interruption and the failures', () => {
    const all = formatCombinedResults([{ id: 'x', content: '', failure: 'boom' }], true);
    expect(all).toMatch(/1 of 1 sub-agent\(s\) returned NO summary/);
    expect(all).toMatch(/interrupted by user/);
  });
});

describe('formatPriorResultsBlock — failures are not trusted context', () => {
  const prior = formatPriorResultsBlock([
    { id: 'good-agent', content: '## findings\nstuff' },
    { id: 'dead-agent', content: '', failure: REASON },
  ]);

  test('failed agent is NOT listed as a prior result', () => {
    expect(prior).not.toMatch(/### sub-agent "dead-agent"/);
  });
  test('its findings text never appears (there is none to trust)', () => {
    expect(prior).not.toContain(REASON);
  });
  test('a missing-work note names it', () => {
    expect(prior).toMatch(/1 earlier sub-agent in this batch returned no summary \("dead-agent"\)/);
  });
  test('the note says the work is missing, not done', () => {
    expect(prior).toMatch(/missing, not done/);
  });
  test('successful sibling is still shared', () => {
    expect(prior).toMatch(/### sub-agent "good-agent"\n## findings\nstuff/);
  });
  test('no note when every sibling succeeded', () => {
    const ok = formatPriorResultsBlock([{ id: 'a', content: 'x' }]);
    expect(ok).not.toMatch(/missing, not done/);
  });
});
