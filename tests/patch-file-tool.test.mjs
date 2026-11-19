/**
 * patch_file: where a patch lands, what it leaves alone, and `replace_all`.
 *
 * The whitespace-tolerant fallback used to map a match back to the file
 * without counting a line's trimmed indentation, so a match that began or
 * ended inside an indented line (a nested markdown bullet, say) landed a few
 * characters off: text was left behind, indentation was stripped, and an
 * astral character (an emoji) threw the whole map out. Each case below pins
 * one of those, plus line-ending preservation and `replace_all`.
 */
import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PatchFileTool } from '../src/tools/impl/patchFileTool.ts';

let dir;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'patch-file-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function patch(content, patches) {
  const file = path.join(dir, 'f.md');
  writeFileSync(file, content);
  const out = await new PatchFileTool().run({ path: file, patches });
  return { out, result: readFileSync(file, 'utf8') };
}

describe('whitespace-tolerant matching lands exactly where the text is', () => {
  test('a patch with its own indent replaces an indented block (trailing space forces the fallback)', async () => {
    const { result } = await patch('a\n    - one  \n    - two\nz\n', [
      { old: '    - one\n    - two', new: '    - 1\n    - 2' },
    ]);
    expect(result).toBe('a\n    - 1\n    - 2\nz\n');
  });

  test('a match that ends inside an indented line leaves the rest of that line alone', async () => {
    const { result } = await patch('a\n  - one\n  - two  \nz\n', [
      { old: '  - one\n  - tw', new: '  - one\n  - X' },
    ]);
    expect(result).toBe('a\n  - one\n  - Xo  \nz\n');
  });

  test('a patch written without the indent keeps the file’s indent on its first line', async () => {
    const { result } = await patch('a\n    - one  \nz\n', [{ old: '- one\nz', new: '- 1\nz' }]);
    expect(result).toBe('a\n    - 1\nz\n');
  });

  test('a match that ends at a line break does not eat the next line’s indent', async () => {
    const { result } = await patch('a\n- one  \n    - two\nz\n', [
      { old: '- one\n', new: '- 1\n' },
    ]);
    expect(result).toBe('a\n- 1\n    - two\nz\n');
  });

  test('an astral character earlier in the line does not shift the match', async () => {
    const { result } = await patch('a\n  \u{1F600} x  \n  - two\nz\n', [
      { old: 'x\n- tw', new: 'Y\n- W' },
    ]);
    expect(result).toBe('a\n  \u{1F600} Y\n- Wo\nz\n');
  });
});

describe('line endings', () => {
  test('inserted lines use the file’s CRLF, not a bare LF', async () => {
    const { result } = await patch('- a\r\n  - b\r\n  - c\r\n', [
      { old: '  - b\n  - c', new: '  - b\n  - new\n  - c' },
    ]);
    expect(result).toBe('- a\r\n  - b\r\n  - new\r\n  - c\r\n');
  });

  test('an LF file stays LF', async () => {
    const { result } = await patch('- a\n- b\n', [{ old: '- a\n', new: '- a\n- x\n' }]);
    expect(result).toBe('- a\n- x\n- b\n');
  });
});

describe('replace_all', () => {
  const twice = 'x: fb.clone(),\ny: 1\nx: fb.clone(),\n';

  test('without it, several matches are rejected, the file is untouched and the error offers replace_all', async () => {
    const { out, result } = await patch(twice, [{ old: 'x: fb.clone(),', new: 'x: fb,' }]);
    expect(out).toContain('matched multiple locations exactly');
    expect(out).toContain('replace_all');
    expect(out).toContain('2 places');
    expect(result).toBe(twice);
  });

  test('with it, every exact match is replaced', async () => {
    const { out, result } = await patch(twice, [
      { old: 'x: fb.clone(),', new: 'x: fb,', replace_all: true },
    ]);
    expect(result).toBe('x: fb,\ny: 1\nx: fb,\n');
    expect(out).toContain('patches_applied: 1');
    expect(out).toContain('replacements_made: 2');
  });

  test('with it, every whitespace-tolerant match is replaced', async () => {
    const { result } = await patch('  x: 1  \ny\n    x: 1\n', [
      { old: 'x: 1\ny', new: 'Q\ny', replace_all: true },
    ]);
    // only the first "x: 1" is followed by "y"; the second is not a match
    expect(result).toBe('  Q\ny\n    x: 1\n');
  });

  test('a single match behaves the same with or without it', async () => {
    const { result } = await patch('one\ntwo\n', [{ old: 'two', new: '2', replace_all: true }]);
    expect(result).toBe('one\n2\n');
  });
});
