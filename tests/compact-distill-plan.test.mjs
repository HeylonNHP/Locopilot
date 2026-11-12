/**
 * The pure core of the tool-output distillation pass
 * (src/services/compact/distillPlan.ts): the request a tool output becomes, the
 * message its digest becomes, how a pass's result is assembled from its outcomes
 * and the notices printed after it.
 *
 * Every expected string is written out by hand from the text the pass produced
 * before these steps moved out of `distillToolMessages`; the end-to-end
 * transcripts in `compact-distill-shell.test.mjs` pin the same output in context.
 *
 * No network, no model.
 */

import { describe, expect, test } from '@jest/globals';

import {
  TOOL_DISTILL_SYSTEM_PROMPT,
  TOOL_DISTILL_TRUNCATION_MARKER,
} from '../src/services/compact/constants.ts';
import {
  assembleDistillResult,
  buildDistilledMessage,
  buildDistillRequest,
  computeDistillLimits,
  distillToolName,
  formatDistillPassNotices,
} from '../src/services/compact/distillPlan.ts';

const call = (id, name) => ({ id, type: 'function', function: { name, arguments: '{}' } });
const tool = (id, content) => ({ role: 'tool', content, tool_call_id: id });

describe('the limits of a pass', () => {
  test('are the three window-scaled caps', () => {
    expect(computeDistillLimits(32_768)).toStrictEqual({
      inputMaxChars: expect.any(Number),
      digestMaxChars: expect.any(Number),
      numPredict: 1024,
    });
  });
});

describe('the tool name of a row', () => {
  const history = [
    {
      role: 'assistant',
      content: '',
      tool_calls: [call('a', 'read_file'), call('b', 'run_command')],
    },
    tool('b', 'x'),
    tool('a', 'y'),
    tool('zz', 'orphan'),
  ];

  test.each([
    [1, 'run_command'],
    [2, 'read_file'],
    [3, 'unknown_tool'],
  ])('row %p is %p', (index, expected) => {
    expect(distillToolName(history, index)).toBe(expected);
  });
});

describe('the request a tool output becomes', () => {
  test('carries the tool name, the length and the output, behind the distiller prompt', () => {
    const request = buildDistillRequest(tool('a', 'line one\nline two'), 'read_file', 1000);
    expect(request).toStrictEqual({
      toolName: 'read_file',
      messages: [
        { role: 'system', content: TOOL_DISTILL_SYSTEM_PROMPT },
        {
          role: 'user',
          content:
            'Tool name: read_file\nTool output length: 17 chars\n\nTool output:\nline one\nline two',
        },
      ],
      totalChars: 17,
      keptChars: 17,
      truncated: false,
    });
  });

  test('says how much was sent when the output is cut to the per-call cap', () => {
    const request = buildDistillRequest(tool('a', 'word '.repeat(2000)), 'run_command', 600);
    expect(request.truncated).toBe(true);
    expect(request.totalChars).toBe(10_000);
    expect(request.keptChars).toBeLessThan(600);
    expect(request.messages[1].content).toContain(
      `Tool output length: 10000 chars (only the first ${request.keptChars} chars were sent to the distiller)`
    );
  });
});

describe('the message a digest becomes', () => {
  const original = { ...tool('a', 'the whole output '.repeat(10)), extra: 'kept' };
  const request = buildDistillRequest(original, 'read_file', 1000);

  test('is the wrapper, then the digest, on the same row', () => {
    expect(buildDistilledMessage(original, request, 'DIGEST', 500)).toStrictEqual({
      ...original,
      content: '[Distilled tool output from read_file; original length 170 chars]\nDIGEST',
    });
  });

  test('says what the distiller never saw when the input was cut', () => {
    const cut = buildDistillRequest(tool('a', 'word '.repeat(2000)), 'read_file', 600);
    const message = buildDistilledMessage(tool('a', 'word '.repeat(2000)), cut, 'D', 500);
    expect(message.content).toBe(
      `[Distilled tool output from read_file; original length 10000 chars; only the first ${cut.keptChars} chars were distilled]\nD`
    );
  });

  test('marks a digest that is cut instead of letting it stop mid-sentence', () => {
    const message = buildDistilledMessage(original, request, 'word '.repeat(200), 100);
    expect(message.content.endsWith(TOOL_DISTILL_TRUNCATION_MARKER)).toBe(true);
  });

  test('an empty digest is replaced by the (cut) original', () => {
    const message = buildDistilledMessage(original, request, '', 100);
    expect(
      message.content.startsWith(
        '[Distilled tool output from read_file; original length 170 chars]\nthe whole output'
      )
    ).toBe(true);
    expect(message.content.endsWith(TOOL_DISTILL_TRUNCATION_MARKER)).toBe(true);
  });
});

describe('a pass assembled from its outcomes', () => {
  const history = [
    { role: 'user', content: 'go' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [call('a', 'x'), call('b', 'x'), call('c', 'x')],
    },
    tool('a', 'A'),
    tool('b', 'B'),
    tool('c', 'C'),
  ];
  const plan = {
    calls: [],
    capSkipped: 1,
    orphanCount: 2,
    budgetSkipped: 3,
    candidateCount: 6,
    prefillTokens: 4242,
  };
  const digested = { ...history[2], content: 'DIGEST A' };
  const outcomes = [
    { index: 2, kind: 'digest', message: digested },
    { index: 3, kind: 'failed', reason: 'the provider returned an error' },
  ];

  test('replaces the digested row, keeps every other row, and counts what happened', () => {
    expect(assembleDistillResult(history, plan, outcomes)).toStrictEqual({
      messages: [history[0], history[1], digested, history[3], history[4]],
      distilledCount: 1,
      skippedCount: 1,
      orphanCount: 2,
      failedCount: 1,
      attemptedCount: 2,
      budgetSkippedCount: 3,
      candidateCount: 6,
      prefillTokens: 4242,
      distilledIndices: [2],
      failedIndices: [3],
    });
  });

  test('a pass with no outcome passes everything through', () => {
    const result = assembleDistillResult(history, plan, []);
    expect(result.messages).toStrictEqual(history);
    expect(result.attemptedCount).toBe(0);
    expect(result.distilledIndices).toStrictEqual([]);
    expect(result.failedIndices).toStrictEqual([]);
  });

  test('a hole in the history is skipped, as it always was', () => {
    // eslint-disable-next-line no-sparse-arrays
    const sparse = [history[0], , history[2]];
    expect(assembleDistillResult(sparse, plan, []).messages).toStrictEqual([
      history[0],
      history[2],
    ]);
  });
});

describe('the notices after a pass', () => {
  const failed = (index, reason) => ({ index, kind: 'failed', reason });
  const digest = (index) => ({ index, kind: 'digest', message: tool('x', 'D') });

  test('are empty when every call succeeded and the budget sufficed', () => {
    expect(formatDistillPassNotices([digest(1), digest(2)], 0)).toStrictEqual([]);
  });

  test('name the failures with their reasons, once each', () => {
    expect(
      formatDistillPassNotices(
        [
          failed(1, 'the request timed out'),
          digest(2),
          failed(3, 'the request timed out'),
          failed(4, 'the provider returned an error'),
        ],
        0
      )
    ).toStrictEqual([
      '3 of 4 tool distillation call(s) failed (the request timed out; the provider returned an error) — those tool output(s) stay verbatim and the compaction continues.',
    ]);
  });

  test('say when the prefill budget ran out, after the failure line', () => {
    expect(formatDistillPassNotices([failed(1, 'the request timed out')], 2)).toStrictEqual([
      '1 of 1 tool distillation call(s) failed (the request timed out) — those tool output(s) stay verbatim and the compaction continues.',
      "2 oversized tool output(s) were left verbatim: the compaction's distillation prefill budget ran out.",
    ]);
  });
});
