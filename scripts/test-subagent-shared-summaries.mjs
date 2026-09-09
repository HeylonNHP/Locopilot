#!/usr/bin/env node
/**
 * Regression checks for the run_subagents shared-summary guidance.
 *
 * Run with: npx tsx scripts/test-subagent-shared-summaries.mjs
 *
 * These checks are network-free. They verify that the schema and both prompt
 * surfaces consistently recommend sharing for dependent workflows while
 * preserving an explicit opt-out for genuinely independent work.
 */

import assert from 'node:assert/strict';

const {
  SHARED_SUMMARIES_GUIDANCE,
  getToolPrompt: getSubAgentPrompt,
  subAgentToolSchema,
} = await import('../src/tools/impl/subAgentTool.ts');
const { getToolSystemPrompt } = await import('../src/tools/tools.ts');

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

const schemaGuidance = subAgentToolSchema.parameters.properties.share_summaries?.description;
const subAgentPrompt = getSubAgentPrompt();
const toolSystemPrompt = getToolSystemPrompt(true);

console.log('run_subagents shared-summary guidance');

check('schema exposes the shared guidance', () => {
  assert.equal(schemaGuidance, SHARED_SUMMARIES_GUIDANCE);
});

check('schema recommends sharing for dependent workflows', () => {
  assert.match(schemaGuidance ?? '', /dependent workflows/i);
  assert.match(schemaGuidance ?? '', /research.*implementation.*review/i);
  assert.match(schemaGuidance ?? '', /omit share_summaries or set it to true/i);
});

check('schema preserves an explicit independent-work opt-out', () => {
  assert.match(schemaGuidance ?? '', /set share_summaries to false/i);
  assert.match(schemaGuidance ?? '', /genuinely independent/i);
  assert.match(schemaGuidance ?? '', /blind reviews/i);
});

check('generated sub-agent prompt uses the schema guidance', () => {
  assert.ok(subAgentPrompt.includes(`- share_summaries: ${SHARED_SUMMARIES_GUIDANCE}`));
});

check('global tool policy repeats the default-on recommendation', () => {
  assert.ok(toolSystemPrompt.includes(`- ${SHARED_SUMMARIES_GUIDANCE}`));
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
