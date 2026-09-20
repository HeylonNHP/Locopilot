#!/usr/bin/env node
/**
 * Regression checks for loud sub-agent failure reporting.
 *
 * Run with: npx tsx scripts/test-subagent-failure-reporting.mjs
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

import assert from 'node:assert/strict';

const { formatAgentFailure, formatCombinedResults, formatPriorResultsBlock } =
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

const REASON =
  '400 request (326517 tokens) exceeds the available context size (262144 tokens), try increasing it';

console.log('formatAgentFailure — wording');
check('names the agent', () => {
  assert.match(formatAgentFailure('odometer-location', REASON), /odometer-location/);
});
check('says no summary was returned', () => {
  assert.match(formatAgentFailure('a', REASON), /returned no summary/i);
});
check('says the work is missing, not empty', () => {
  assert.match(formatAgentFailure('a', REASON), /missing, not empty/i);
});
check('includes the underlying reason verbatim', () => {
  assert.ok(formatAgentFailure('a', REASON).includes(REASON));
});
check('tells the parent how to recover', () => {
  assert.match(formatAgentFailure('a', REASON), /re-run this agent with run_subagents/i);
});
check('is not a salvaged partial-summary format', () => {
  assert.doesNotMatch(formatAgentFailure('a', REASON), /final_response|partial/i);
});

console.log('');
console.log('formatCombinedResults — failure banner');
const failedRun = formatCombinedResults(
  [
    { id: 'gt5-save-structure', content: '# A very long report…' },
    { id: 'odometer-location', content: '', failure: REASON },
  ],
  false
);

check('banner leads the tool result', () => {
  assert.ok(failedRun.startsWith('[⚠'), `starts with: ${failedRun.slice(0, 40)}`);
});
check('banner counts failures against total', () => {
  assert.match(failedRun, /1 of 2 sub-agent\(s\) returned NO summary/);
});
check('banner names the failed agent', () => {
  assert.match(failedRun, /"odometer-location"/);
});
check('banner forbids treating the gap as empty', () => {
  assert.match(failedRun, /MISSING, not empty/);
});
check('banner suggests the recovery action', () => {
  assert.match(failedRun, /re-run those agents with run_subagents/);
});
check('banner precedes the successful agent report', () => {
  assert.ok(failedRun.indexOf('[⚠') < failedRun.indexOf('gt5-save-structure'));
});
check('successful agent still renders normally', () => {
  assert.match(failedRun, /sub_agent: gt5-save-structure\nfinal_response:\n# A very long report…/);
});
check('failed agent renders the loud notice, not an empty body', () => {
  const section = failedRun.slice(failedRun.indexOf('sub_agent: odometer-location'));
  assert.match(section, /returned NO summary/);
  assert.doesNotMatch(section, /completed without a final text response/);
});

console.log('');
console.log('formatCombinedResults — no failures');
const cleanRun = formatCombinedResults([{ id: 'a', content: 'report' }], false);
check('no banner when every agent returned a summary', () => {
  assert.doesNotMatch(cleanRun, /⚠/);
});
check('clean output is unchanged in shape', () => {
  assert.equal(cleanRun, 'sub_agent: a\nfinal_response:\nreport');
});
check('interrupted suffix is preserved', () => {
  assert.match(formatCombinedResults([{ id: 'a', content: 'r' }], true), /interrupted by user/);
});
check('all-failed run still reports the interruption and the failures', () => {
  const all = formatCombinedResults([{ id: 'x', content: '', failure: 'boom' }], true);
  assert.match(all, /1 of 1 sub-agent\(s\) returned NO summary/);
  assert.match(all, /interrupted by user/);
});

console.log('');
console.log('formatPriorResultsBlock — failures are not trusted context');
const prior = formatPriorResultsBlock([
  { id: 'good-agent', content: '## findings\nstuff' },
  { id: 'dead-agent', content: '', failure: REASON },
]);

check('failed agent is NOT listed as a prior result', () => {
  assert.doesNotMatch(prior, /### sub-agent "dead-agent"/);
});
check('its findings text never appears (there is none to trust)', () => {
  assert.ok(!prior.includes(REASON));
});
check('a missing-work note names it', () => {
  assert.match(prior, /1 earlier sub-agent in this batch returned no summary \("dead-agent"\)/);
});
check('the note says the work is missing, not done', () => {
  assert.match(prior, /missing, not done/);
});
check('successful sibling is still shared', () => {
  assert.match(prior, /### sub-agent "good-agent"\n## findings\nstuff/);
});
check('no note when every sibling succeeded', () => {
  const ok = formatPriorResultsBlock([{ id: 'a', content: 'x' }]);
  assert.doesNotMatch(ok, /missing, not done/);
});

console.log('');
console.log(`Results: ${pass} pass, ${fail} fail`);
if (fail > 0) {
  process.exit(1);
}
