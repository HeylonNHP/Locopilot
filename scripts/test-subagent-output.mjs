#!/usr/bin/env node
/**
 * Regression checks for structured sub-agent output attribution.
 *
 * Run with: npx tsx scripts/test-subagent-output.mjs
 *
 * The web UI must route output by the structured agent ID rather than by
 * embedding and later parsing a display-only '[sub-agent: id]' text prefix.
 */

import assert from 'node:assert/strict';

const { executeNestedToolCall, makeAgentSink } = await import('../src/tools/impl/subAgentTool.ts');

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

const structuredLines = [];
const structuredSink = {
  writeLine() {
    throw new Error('structured sink should receive writeAgentLine calls');
  },
  writeAgentLine(agentId, message) {
    structuredLines.push({ agentId, message });
  },
};

makeAgentSink(structuredSink, 'primex-auth-context').writeLine('first\r\nsecond\n');

console.log('Structured sub-agent output attribution');

check('multiline output keeps the structured agent ID', () => {
  assert.deepEqual(structuredLines, [
    { agentId: 'primex-auth-context', message: 'first' },
    { agentId: 'primex-auth-context', message: 'second' },
    { agentId: 'primex-auth-context', message: '' },
  ]);
});

check('structured output contains no textual routing prefix', () => {
  assert.equal(
    structuredLines.some(({ message }) => message.includes('[sub-agent:')),
    false
  );
});

const fallbackLines = [];
const fallbackSink = {
  writeLine(message) {
    fallbackLines.push(message);
  },
};

makeAgentSink(fallbackSink, 'legacy-agent').writeLine('approval\nresult');

check('non-web fallback receives plain unprefixed lines', () => {
  assert.deepEqual(fallbackLines, ['approval', 'result']);
});

const approvalLines = [];
const approvalSink = {
  writeLine(message) {
    approvalLines.push(message);
  },
};
const deniedCommand = await executeNestedToolCall(
  'approval-agent',
  {
    id: 'call_test',
    type: 'function',
    function: { name: 'run_command', arguments: { command: 'echo test' } },
  },
  approvalSink,
  undefined,
  {
    yoloMode: false,
    subAgent: {
      approvalRequester: async () => ({ approved: false }),
    },
  }
);

check('approval status lines contain no display-only agent prefix', () => {
  assert.equal(deniedCommand.content, '[Command rejected by user]');
  assert.equal(
    approvalLines.some((line) => line.includes('[Sub-agent:')),
    false
  );
  assert.ok(approvalLines.some((line) => line.includes('Requesting a command')));
  assert.ok(approvalLines.some((line) => line.includes('Request denied by user')));
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
