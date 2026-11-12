/**
 * Tests for how the tool-output distillation names the tool a digest came from
 * (`findOwningToolCall` and `distillToolMessages` in
 * src/services/compact/distill.ts).
 *
 * WHY these tests exist: the name used to be the FIRST call of the owning
 * assistant turn, so when one turn made several tool calls every output was
 * labelled with the first call's name. That name reaches the distiller's
 * request (`Tool name: X`), the progress lines and the digest header
 * (`[Distilled tool output from X; ...]`), which is persisted for the preserved
 * window and read by the main model on every later turn.
 *
 * The fake provider is a plain `http.createServer` on 127.0.0.1 with an
 * ephemeral port: no network egress, no model.
 */

import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';

import { distillToolMessages, findOwningToolCall } from '../src/services/compact/distill.ts';
import { startFakeOllama } from './helpers/fakeOllama.mjs';

const MODEL = 'test-model';

const call = (id, name) => ({ id, type: 'function', function: { name, arguments: '{}' } });
const assistant = (...calls) => ({ role: 'assistant', content: '', tool_calls: calls });
const output = (id, text = 'x'.repeat(5000)) => ({ role: 'tool', content: text, tool_call_id: id });

/**
 * One turn, three calls, the results in a DIFFERENT order (c, a, b): matching
 * by the first call and matching by position both get it wrong.
 */
const multiCallHistory = () => [
  { role: 'user', content: 'look around' },
  assistant(call('c-a', 'read_file'), call('c-b', 'run_command'), call('c-c', 'web_fetch')),
  output('c-c'),
  output('c-a'),
  output('c-b'),
];

describe('findOwningToolCall', () => {
  test.each([
    [2, 'web_fetch'],
    [3, 'read_file'],
    [4, 'run_command'],
  ])('row %p answers %p', (index, name) => {
    expect(findOwningToolCall(multiCallHistory(), index)?.function.name).toBe(name);
  });

  test('a reused id is owned by the NEAREST turn', () => {
    const history = [
      assistant(call('c-1', 'read_file')),
      output('c-1'),
      { role: 'user', content: 'again' },
      assistant(call('c-1', 'run_command')),
      output('c-1'),
    ];
    expect(findOwningToolCall(history, 4)?.function.name).toBe('run_command');
  });

  test.each([
    ['no tool_call_id', [assistant(call('c-a', 'read_file')), output('')]],
    ['an id the block never issued', [assistant(call('c-a', 'read_file')), output('c-z')]],
    [
      'an owner outside the tool block',
      [assistant(call('c-a', 'read_file')), { role: 'user', content: 'u' }, output('c-a')],
    ],
  ])('%s is an orphan', (_label, history) => {
    expect(findOwningToolCall(history, history.length - 1)).toBeUndefined();
  });
});

describe('a digest names the call it answers', () => {
  let fake;

  // No promptEvalCount, so no calibration sample is recorded.
  beforeAll(async () => {
    fake = await startFakeOllama(() => ({ text: 'digest' }));
  });

  afterAll(() => fake.close());

  test('every output of a multi-call turn is labelled with its own tool', async () => {
    const result = await distillToolMessages(
      { baseUrl: fake.baseUrl },
      multiCallHistory(),
      32768,
      MODEL,
      3
    );
    expect(result.distilledCount).toBe(3);

    const expected = ['web_fetch', 'read_file', 'run_command'];
    const headerNames = result.messages
      .slice(2)
      .map((message) => /^\[Distilled tool output from (\S+);/.exec(message.content)?.[1]);
    expect(headerNames).toStrictEqual(expected);

    const requestNames = fake.requests.map(
      (request) => /^Tool name: (.+)$/m.exec(request.body.messages.at(-1).content)?.[1]
    );
    expect(requestNames).toStrictEqual(expected);
    expect(fake.unexpected).toStrictEqual([]);
  });
});
