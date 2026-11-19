/**
 * How tool calls with awkward arguments are answered.
 *
 * Found in production sessions 726 and 728, where a model:
 *  - sent patch_file's `patches` as a JSON-encoded string, once with a stray
 *    `]`, and was told the argument was "missing" four times running;
 *  - sent `timeout_ms` to run_command, which then had only `timeout_seconds`;
 *    the unknown argument was ignored without a word, so every call ran on the
 *    30-second default. Both are in the schema now; `timeout_ms` is always
 *    milliseconds.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { findUnknownArguments, withUnknownArgumentNote } from '../src/tools/argumentCheck.ts';
import { parsePositiveTimeoutMsFromMs } from '../src/tools/commandHelpers.ts';
import { parsePatchesArgument, patchFileToolSchema } from '../src/tools/impl/patchFileTool.ts';
import { enterRequestScope, runCommandToolSchema } from '../src/tools/impl/runCommandTool.ts';

let toolRegistry;
beforeAll(async () => {
  // The registry reaches jsdom only through the web tools, which these tests
  // never call; jsdom's ESM-only dependency cannot be required on Node < 24.9.
  // Same stub as tests/chat-route-pair-gates.test.mjs, registered before the import.
  jest.unstable_mockModule('jsdom', () => ({ JSDOM: class {}, VirtualConsole: class {} }));
  ({ toolRegistry } = await import('../src/tools/toolRegistry.ts'));
}, 60_000);

describe('parsePatchesArgument', () => {
  const one = [{ old: 'a', new: 'b' }];

  test('an array passes straight through', () => {
    expect(parsePatchesArgument(one)).toEqual({ patches: one });
  });

  test('a JSON-encoded array is accepted', () => {
    expect(parsePatchesArgument(JSON.stringify(one))).toEqual({ patches: one });
  });

  test('a single patch object, or a JSON string of one, is wrapped in an array', () => {
    expect(parsePatchesArgument(one[0])).toEqual({ patches: one });
    expect(parsePatchesArgument(JSON.stringify(one[0]))).toEqual({ patches: one });
  });

  test('a string with a stray bracket says it is not valid JSON, never "missing"', () => {
    const result = parsePatchesArgument(`${JSON.stringify(one)}]`);
    expect(result).toHaveProperty('error');
    expect(result.error).toContain('not valid JSON');
    expect(result.error).not.toContain('missing');
  });

  test.each([
    [undefined, 'missing required argument "patches"'],
    [null, 'missing required argument "patches"'],
    [[], 'empty array'],
    ['[]', 'empty array'],
    [42, 'got number'],
    ['"text"', 'got string'],
    ['null', 'got null'],
  ])('%j is explained', (raw, fragment) => {
    const result = parsePatchesArgument(raw);
    expect(result.error).toContain(fragment);
  });
});

describe('patch_file through the registry', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tool-args-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('patches sent as a JSON string are applied', async () => {
    const file = path.join(dir, 'f.txt');
    writeFileSync(file, 'one\ntwo\n');
    const { content } = await toolRegistry.get('patch_file').execute({
      path: file,
      patches: JSON.stringify([{ old: 'two', new: '2' }]),
    });
    expect(content).toContain('patches_applied: 1');
    expect(readFileSync(file, 'utf8')).toBe('one\n2\n');
  });

  test('a malformed string leaves the file alone and names the problem', async () => {
    const file = path.join(dir, 'f.txt');
    writeFileSync(file, 'one\ntwo\n');
    const { content } = await toolRegistry.get('patch_file').execute({
      path: file,
      patches: '[{"old":"two","new":"2"}]]',
    });
    expect(content).toContain('not valid JSON');
    expect(readFileSync(file, 'utf8')).toBe('one\ntwo\n');
  });

  test('an argument the tool does not have is reported after the result', async () => {
    const file = path.join(dir, 'f.txt');
    writeFileSync(file, 'one\n');
    const { content } = await toolRegistry.get('patch_file').execute({
      path: file,
      patches: [{ old: 'one', new: '1' }],
      dry_run: true,
    });
    expect(content).toContain('patches_applied: 1');
    expect(content).toContain('ignored unknown argument for patch_file: dry_run');
  });
});

describe('unknown-argument note', () => {
  test('names every unknown argument and lists the valid ones', () => {
    const note = withUnknownArgumentNote(
      'result',
      { command: 'x', foo: 1, bar: 2 },
      runCommandToolSchema
    );
    expect(note.startsWith('result\n')).toBe(true);
    expect(note).toContain('ignored unknown arguments for run_command: foo, bar');
    expect(note).toContain('command, shell, timeout_seconds, timeout_ms, cwd');
  });

  test('says nothing when every argument is known, or listed as accepted', () => {
    expect(withUnknownArgumentNote('r', { command: 'x', cwd: '.' }, runCommandToolSchema)).toBe(
      'r'
    );
    expect(findUnknownArguments({ legacy: 5 }, runCommandToolSchema, ['legacy'])).toEqual([]);
    expect(findUnknownArguments({ timeout_ms: 5 }, runCommandToolSchema)).toEqual([]);
    expect(findUnknownArguments({ path: 'p', patches: [] }, patchFileToolSchema)).toEqual([]);
  });
});

describe('parsePositiveTimeoutMsFromMs', () => {
  test.each([
    [400_000, 400_000],
    [60_000, 60_000],
    [1500.9, 1500],
    [120, 120], // always milliseconds: no unit guessing for small values
    [1, 1],
    [99_999_999, 3_600_000], // the same ceiling as timeout_seconds
  ])('%j ms -> %d ms', (raw, expected) => {
    expect(parsePositiveTimeoutMsFromMs(raw)).toBe(expected);
  });

  test.each([0, -5, 0.5, 'soon', '60000', '', null, undefined, {}, Number.NaN, Infinity])(
    '%j is rejected',
    (raw) => {
      expect(parsePositiveTimeoutMsFromMs(raw)).toBeNull();
    }
  );
});

describe('run_command timeout arguments', () => {
  test('both timeout arguments are in the schema, so the model can see either exists', () => {
    const props = runCommandToolSchema.parameters.properties;
    expect(props.timeout_seconds.description).toContain('timeout_ms');
    expect(props.timeout_ms.type).toBe('number');
    expect(props.timeout_ms.description).toMatch(/always milliseconds/);
    expect(props.timeout_ms.description).toContain('timeout_seconds');
    expect(runCommandToolSchema.parameters.required).toEqual(['command']);
  });

  const run = (args) => {
    enterRequestScope();
    return toolRegistry.get('run_command').execute(args, undefined, undefined, { yoloMode: true });
  };
  const echo = 'node -e "console.log(12345)"';

  test('timeout_ms is accepted and adds nothing to the result', async () => {
    const { content } = await run({ command: echo, timeout_ms: 60000 });
    expect(content).toContain('12345');
    expect(content).not.toContain('[Note');
  });

  test('timeout_seconds still works and adds nothing to the result', async () => {
    const { content } = await run({ command: echo, timeout_seconds: 60 });
    expect(content).toContain('12345');
    expect(content).not.toContain('[Note');
  });

  test('sending both is refused, and nothing is run', async () => {
    const { content } = await run({ command: echo, timeout_seconds: 60, timeout_ms: 60000 });
    expect(content).toContain('either "timeout_seconds" or "timeout_ms", not both');
    expect(content).not.toContain('12345');
  });

  test('a small timeout_ms is milliseconds, not seconds: the wait is cut short, the command is not lost', async () => {
    const { content } = await run({
      command: 'node -e "setTimeout(() => console.log(12345), 1500)"',
      timeout_ms: 120,
    });
    // 120 ms: returns before the command prints; the process keeps running.
    expect(content).not.toContain('12345');
    expect(content).toContain('process_id');
  });

  test.each([['soon'], ['60000'], [0], [-1]])(
    'a bad timeout_ms (%j) is refused by name',
    async (bad) => {
      const { content } = await run({ command: 'node -e "1"', timeout_ms: bad });
      expect(content).toContain('invalid argument "timeout_ms"');
    }
  );

  test('a misnamed argument is still reported rather than silently ignored', async () => {
    const { content } = await run({ command: echo, timeout: 5 });
    expect(content).toContain('12345');
    expect(content).toContain('ignored unknown argument for run_command: timeout');
  });
});
