/**
 * read_file: what its description says about the bytes and the size.
 *
 * The description did not say that the file comes back exactly as it is on
 * disk (a Windows file keeps the `\r` of every line, in whole-file and in
 * line mode), that a file ending in a line break has a final empty line, or
 * that there is no size cap, only a notice at a share of the context window.
 * Each claim is checked against the real tool.
 */
import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { READ_FILE_TOKEN_CRITICAL_PCT, READ_FILE_TOKEN_WARN_PCT } from '../src/constants.ts';
import { countTextTokens } from '../src/services/tokenizer.ts';
import { ReadFileTool, readFileToolSchema } from '../src/tools/impl/readFileTool.ts';

let dir;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'read-file-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const fileWith = (name, content) => {
  const file = path.join(dir, name);
  writeFileSync(file, content);
  return file;
};

/** The part of a result after `contents:`. */
const contentsOf = (result) => result.slice(result.indexOf('contents:\n') + 'contents:\n'.length);

describe('the description', () => {
  const { description } = readFileToolSchema;

  test(String.raw`says the file is returned as it is, and that every line of a CRLF file keeps its \r`, () => {
    expect(description).toContain('read as UTF-8');
    expect(description).toContain('exactly as it is on disk');
    expect(description).toContain(String.raw`every line keeps its trailing \r`);
    expect(description).toContain(String.raw`(\r\n is not turned into \n)`);
  });

  test(String.raw`says lines are split at \n only and a final line break leaves an empty last line`, () => {
    expect(description).toContain(String.raw`Lines are split at \n only`);
    expect(description).toContain('final empty line');
  });

  test('says there is no size limit, and the thresholds of the notice, taken from the constants', () => {
    expect(description).toContain('There is no size limit');
    expect(description).toContain(
      `about ${READ_FILE_TOKEN_WARN_PCT}% or more of your context window`
    );
    expect(description).toContain(`at ${READ_FILE_TOKEN_CRITICAL_PCT}% or more a stronger warning`);
  });
});

describe('the bytes', () => {
  const crlf = 'one\r\ntwo\r\nthree\r\n';

  test(String.raw`a whole CRLF file comes back with its \r\n, unconverted`, async () => {
    const result = await new ReadFileTool().run({ path: fileWith('a.txt', crlf) });
    expect(contentsOf(result)).toBe(crlf);
  });

  test(String.raw`line mode keeps the \r on every line it returns`, async () => {
    const result = await new ReadFileTool().run({
      path: fileWith('a.txt', crlf),
      start_line: 1,
      end_line: 2,
    });
    expect(contentsOf(result)).toBe('one\r\ntwo\r');
  });

  test('a file ending in a line break has a final empty line, which line mode can address', async () => {
    const file = fileWith('b.txt', 'one\ntwo\n');
    const result = await new ReadFileTool().run({ path: file, start_line: 3, end_line: 3 });
    expect(result).toContain('lines 3 to 3');
    expect(contentsOf(result)).toBe('(empty)');
    const beyond = await new ReadFileTool().run({ path: file, start_line: 4 });
    expect(beyond).toContain('exceeds file line count (3)');
  });

  test('a file with no final line break has no empty last line', async () => {
    const beyond = await new ReadFileTool().run({
      path: fileWith('c.txt', 'one\ntwo'),
      start_line: 3,
    });
    expect(beyond).toContain('exceeds file line count (2)');
  });
});

describe('the size rule', () => {
  test('there is no cap: a multi-megabyte file comes back whole', async () => {
    const big = 'x'.repeat(3 * 1024 * 1024);
    const result = await new ReadFileTool().run({ path: fileWith('big.txt', big) });
    expect(contentsOf(result)).toHaveLength(big.length);
  });

  test('the notice appears from the warn share of the window, and the stronger one from the critical share', async () => {
    const model = 'test-model';
    const text = 'word '.repeat(400);
    const file = fileWith('t.txt', text);
    const tokens = countTextTokens(text, model);

    const quiet = await new ReadFileTool({ model, numCtx: tokens * 10 }).run({ path: file });
    expect(quiet).not.toContain('Token Notice');
    expect(quiet).not.toContain('Token Warning');

    const notice = await new ReadFileTool({ model, numCtx: Math.ceil(tokens / 0.3) }).run({
      path: file,
    });
    expect(notice).toContain('Token Notice');
    expect(notice).not.toContain('Token Warning');

    const warning = await new ReadFileTool({ model, numCtx: Math.ceil(tokens / 0.6) }).run({
      path: file,
    });
    expect(warning).toContain('Token Warning');
    // Either way the file itself is returned in full.
    expect(contentsOf(warning)).toBe(text);
  });
});
