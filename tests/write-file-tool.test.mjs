/**
 * write_file: what its description promises is what it does.
 *
 * The description listed three modes but never said which one applies when
 * `mode` is left out (it is overwrite, which replaces a file with no check),
 * and never said missing parent folders are created. Both are now stated;
 * each claim below is checked against the real tool.
 */
import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  getToolPrompt,
  WriteFileTool,
  writeFileToolSchema,
} from '../src/tools/impl/writeFileTool.ts';

let dir;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'write-file-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const write = (args) => new WriteFileTool().run(args);

describe('the description', () => {
  const { description, parameters } = writeFileToolSchema;
  const mode = parameters.properties.mode;

  test('says the default mode is overwrite, with no check and no backup', () => {
    expect(description).toContain('When mode is left out it is overwrite');
    expect(description).toContain('no check and no backup');
    expect(mode.description).toContain('Defaults to overwrite');
  });

  test('says missing parent folders are created', () => {
    expect(description).toContain('Missing parent folders are created');
  });

  test('lists the modes as an enum and says what create does when the file exists', () => {
    expect(mode.enum).toEqual(['overwrite', 'append', 'create']);
    expect(mode.description).toMatch(/create: write only if the file does not already exist/);
    expect(mode.description).toContain('writing nothing');
  });

  test('the system-prompt section carries the same text', () => {
    const prompt = getToolPrompt();
    expect(prompt).toContain('When mode is left out it is overwrite');
    expect(prompt).toContain('Defaults to overwrite');
  });
});

describe('the behaviour the description states', () => {
  test('with no mode, an existing file is replaced', async () => {
    const file = path.join(dir, 'a.txt');
    writeFileSync(file, 'old contents');
    const result = await write({ path: file, content: 'new' });
    expect(result).toContain('action: overwrite');
    expect(readFileSync(file, 'utf8')).toBe('new');
  });

  test('missing parent folders are created', async () => {
    const file = path.join(dir, 'x', 'y', 'z.txt');
    await write({ path: file, content: 'deep' });
    expect(readFileSync(file, 'utf8')).toBe('deep');
  });

  test('create writes nothing, and warns, when the file exists', async () => {
    const file = path.join(dir, 'a.txt');
    writeFileSync(file, 'keep me');
    const result = await write({ path: file, content: 'new', mode: 'create' });
    expect(result).toContain('write_file_warning');
    expect(readFileSync(file, 'utf8')).toBe('keep me');
  });

  test('create writes the file when it is missing', async () => {
    const file = path.join(dir, 'fresh.txt');
    await write({ path: file, content: 'hi', mode: 'create' });
    expect(existsSync(file)).toBe(true);
  });

  test('append adds to the end, and creates the file when it is missing', async () => {
    const file = path.join(dir, 'log.txt');
    await write({ path: file, content: 'one\n', mode: 'append' });
    await write({ path: file, content: 'two\n', mode: 'append' });
    expect(readFileSync(file, 'utf8')).toBe('one\ntwo\n');
  });

  test('a mode outside the three is refused and nothing is written', async () => {
    const file = path.join(dir, 'a.txt');
    const result = await write({ path: file, content: 'x', mode: 'truncate' });
    expect(result).toContain('invalid "mode"');
    expect(existsSync(file)).toBe(false);
  });
});
