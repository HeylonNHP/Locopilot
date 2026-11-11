/**
 * Regression checks for structured sub-agent output attribution.
 *
 * The web UI must route output by the structured agent ID rather than by
 * embedding and later parsing a display-only '[sub-agent: id]' text prefix.
 */

import { describe, expect, test } from '@jest/globals';

const { executeNestedToolCall, makeAgentSink } = await import('../src/tools/impl/subAgentTool.ts');

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

describe('Structured sub-agent output attribution', () => {
  test('multiline output keeps the structured agent ID', () => {
    expect(structuredLines).toStrictEqual([
      { agentId: 'primex-auth-context', message: 'first' },
      { agentId: 'primex-auth-context', message: 'second' },
      { agentId: 'primex-auth-context', message: '' },
    ]);
  });

  test('structured output contains no textual routing prefix', () => {
    expect(structuredLines.some(({ message }) => message.includes('[sub-agent:'))).toBe(false);
  });

  const fallbackLines = [];
  const fallbackSink = {
    writeLine(message) {
      fallbackLines.push(message);
    },
  };

  makeAgentSink(fallbackSink, 'legacy-agent').writeLine('approval\nresult');

  test('non-web fallback receives plain unprefixed lines', () => {
    expect(fallbackLines).toStrictEqual(['approval', 'result']);
  });

  test('approval status lines contain no display-only agent prefix', () => {
    expect(deniedCommand.content).toBe('[Command rejected by user]');
    expect(approvalLines.some((line) => line.includes('[Sub-agent:'))).toBe(false);
    expect(approvalLines.some((line) => line.includes('Requesting a command'))).toBeTruthy();
    expect(approvalLines.some((line) => line.includes('Request denied by user'))).toBeTruthy();
  });
});
