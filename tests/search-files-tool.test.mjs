/**
 * search_files: what its description promises is what it does.
 *
 * Every rule the tool applies (regular expression by default, case-sensitive,
 * a stop at the result limit, folders and files it does not search) is stated
 * in the description and in the result, so each statement is checked here
 * against the real tool on a real folder.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from '@jest/globals';
import { constants as bufferConstants } from 'node:buffer';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { compileFileGlob } from '../src/tools/fileGlob.ts';
import {
  getToolPrompt,
  SEARCH_FILES_DEFAULT_MAX_RESULTS,
  SEARCH_FILES_DEFAULT_TIMEOUT_SECONDS,
  SEARCH_FILES_MAX_LINE_CHARS,
  SearchFilesTool,
  searchFilesToolSchema,
} from '../src/tools/impl/searchFilesTool.ts';
import { setAgentWorkingDirectory, WorkingDirectoryScope } from '../src/tools/workingDirectory.ts';

let dir;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'search-files-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Writes `content` to `relative` under the temp folder, making folders as needed. */
const put = (relative, content = '') => {
  const file = path.join(dir, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
};

const search = (args, options) => new SearchFilesTool(options).run({ path: dir, ...args });

/** The `  12: text` lines of a result, as `12: text`. */
const matchLines = (result) =>
  result
    .split('\n')
    .filter((line) => /^ {2}\d+: /.test(line))
    .map((line) => line.trim());

describe('the description', () => {
  const { description, parameters } = searchFilesToolSchema;

  test('says the pattern is a regular expression unless literal=true, and that it is case-sensitive', () => {
    expect(description).toContain(
      'is a regular expression (JavaScript syntax) unless you set literal=true'
    );
    expect(description).toContain('case-sensitive unless you set case_insensitive=true');
    expect(parameters.properties.literal.description).toContain('false (the default)');
    expect(parameters.properties.case_insensitive.description).toContain('false (the default)');
  });

  test('states the result limit and what happens at it, using the constants', () => {
    expect(description).toContain(`(default ${SEARCH_FILES_DEFAULT_MAX_RESULTS})`);
    expect(description).toContain('the result says so, and says whether more matches exist');
    expect(parameters.properties.max_results.description).toContain(
      `Up to ${Number.MAX_SAFE_INTEGER.toLocaleString('en-US')}`
    );
    expect(description).toContain('max_results is the limit on how many lines are returned');
    expect(description).toContain('it can be changed in the call');
  });

  test('states the time limit, what it covers, and what the pattern guard does when it fires', () => {
    expect(description).toContain(`(default ${SEARCH_FILES_DEFAULT_TIMEOUT_SECONDS})`);
    expect(description).toContain('That limit covers the whole search, matching included');
    expect(description).toContain('between pieces of a file as it is read');
    expect(description).toContain('A folder listing is one call and is not cut off');
    expect(description).toContain(
      'A pattern that is too slow on some lines (nested repetition such as (a+)+ can be) also stops the search, within the same limit.'
    );
    expect(description).toContain(
      'the result names that file and the last line searched in it; the lines after that were not searched.'
    );
    expect(parameters.properties.timeout_seconds.description).toContain(
      'Reading and matching are both cut off at this limit'
    );
  });

  test('states the unreadable-file listing and that no file is excluded, and that only the matching line is returned', () => {
    expect(description).toContain(
      'For each kind of entry the result gives the count and names the first max_listed (default 5).'
    );
    expect(description).toContain(
      'Entries that are neither files nor folders (sockets, pipes, devices) are not read, and are listed too.'
    );
    expect(description).toContain(
      "each folder's entries sorted by character code (so A–Z come before a–z)"
    );
    expect(description).toContain(`(default ${SEARCH_FILES_DEFAULT_TIMEOUT_SECONDS})`);
    expect(description).toContain('No file is excluded by its name or type');
    expect(description).toContain('including hidden files, .git, node_modules and binary files');
    expect(description).toContain('A file is read in pieces, so a file of any length is searched.');
    expect(description).toContain(
      `(${bufferConstants.MAX_STRING_LENGTH.toLocaleString('en-US')} characters on this Node version)`
    );
    expect(description).toContain(
      'its file is listed as unreadable, and the matches found before that line are kept'
    );
    expect(description).toContain('Symbolic links are followed');
    expect(description).toContain('.gitignore is not read');
    expect(Object.keys(parameters.properties)).not.toContain('include_skipped_folders');
    expect(description).toContain(
      `a line longer than max_line_chars (default ${SEARCH_FILES_MAX_LINE_CHARS}) is cut around the match, keeping a third of max_line_chars before the match, and marked`
    );
    expect(description).toContain('Use read_file with start_line');
  });

  test('describes the file_filter glob and its syntax', () => {
    expect(description).toContain('matched against the file name at any depth');
    expect(parameters.properties.file_filter.description).toContain('{a,b}');
    expect(parameters.properties.file_filter.description).toContain('does not support [abc] sets');
  });

  test('requires only the pattern, and the system-prompt section carries the same text', () => {
    expect(parameters.required).toEqual(['pattern']);
    expect(getToolPrompt()).toContain(description);
    expect(getToolPrompt()).toContain('16. search_files(pattern, path?');
  });
});

describe('matching', () => {
  test('returns file, line number and the matching line, grouped by file', async () => {
    const a = put('a.txt', 'one\nneedle here\nthree\nneedle again\n');
    put('b.txt', 'nothing\n');
    const result = await search({ pattern: 'needle' });
    expect(result).toContain(a);
    expect(matchLines(result)).toEqual(['2: needle here', '4: needle again']);
    expect(result).toContain('matches: 2 in 1 file');
    expect(result).toContain('status: complete. 2 files searched.');
    expect(result).toContain('pattern: needle (regular expression, case-sensitive)');
  });

  test('the pattern is a regular expression by default', async () => {
    put('a.txt', 'abc\na.c\n');
    expect(matchLines(await search({ pattern: 'a.c' }))).toEqual(['1: abc', '2: a.c']);
  });

  test('literal=true searches for the exact text', async () => {
    put('a.txt', 'abc\na.c\nfoo(bar\n');
    expect(matchLines(await search({ pattern: 'a.c', literal: true }))).toEqual(['2: a.c']);
    const result = await search({ pattern: 'foo(bar', literal: true });
    expect(matchLines(result)).toEqual(['3: foo(bar']);
    expect(result).toContain('(exact text, case-sensitive)');
  });

  test('is case-sensitive unless case_insensitive=true', async () => {
    put('a.txt', 'Hello\nhello\nHELLO\n');
    expect(matchLines(await search({ pattern: 'hello' }))).toEqual(['2: hello']);
    const result = await search({ pattern: 'hello', case_insensitive: true });
    expect(matchLines(result)).toEqual(['1: Hello', '2: hello', '3: HELLO']);
    expect(result).toContain('case-insensitive');
  });

  test('an invalid regular expression is refused and the message points to literal=true', async () => {
    const result = await search({ pattern: 'foo(bar' });
    expect(result).toMatch(/^\[search_files error: "pattern" is not a valid regular expression/);
    expect(result).toContain('send literal=true');
    expect(result).toContain('Nothing was searched');
  });

  test('a pattern with a line break is refused, not silently never matched', async () => {
    put('a.txt', 'a\nb\n');
    const result = await search({ pattern: 'a\nb' });
    expect(result).toContain('one line at a time');
    expect(result).toContain('Nothing was searched');
  });

  test(
    String.raw`a trailing \r is removed before matching, so $ works in a Windows file`,
    async () => {
      put('win.txt', 'alpha\r\nbeta\r\n');
      const result = await search({ pattern: 'beta$' });
      expect(matchLines(result)).toEqual(['2: beta']);
      expect(result).not.toContain('\r');
    }
  );

  test('the empty piece after a final line break is not a line', async () => {
    put('a.txt', 'one\n\ntwo\n');
    // ^$ matches the one empty line (line 2), not a phantom line 4.
    expect(matchLines(await search({ pattern: '^$' }))).toEqual(['2:']);
  });

  test(String.raw`line numbers agree with read_file (split at \n, from 1)`, async () => {
    put('a.txt', 'x\r\ny\r\nneedle\r\n');
    expect(matchLines(await search({ pattern: 'needle' }))).toEqual(['3: needle']);
  });

  test('a long line is cut around the match and marked with the real numbers', async () => {
    const line = `${'a'.repeat(500)}NEEDLE${'b'.repeat(500)}`;
    put('a.txt', `${line}\n`);
    const result = await search({ pattern: 'NEEDLE' });
    const shown = matchLines(result)[0];
    expect(shown).toContain('NEEDLE');
    expect(shown).toContain('[line is 1,006 characters; showing characters 401-700]');
    expect(shown.length).toBeLessThan(500);
  });

  test('a short line is returned whole and unmarked', async () => {
    put('a.txt', `${'x'.repeat(SEARCH_FILES_MAX_LINE_CHARS)}\n`);
    expect(await search({ pattern: 'x' })).not.toContain('[line is');
  });

  test('no match is reported as complete with 0 matches', async () => {
    put('a.txt', 'nothing\n');
    const result = await search({ pattern: 'zzz' });
    expect(result).toContain('matches: 0 in 0 files');
    expect(result).toContain('status: complete. 1 file searched.');
  });
});

describe('where it searches', () => {
  test('searches every subfolder, hidden files included, in folder-by-folder name order', async () => {
    put('b/two.txt', 'hit\n');
    put('a/one.txt', 'hit\n');
    put('.hidden/zero.txt', 'hit\n');
    put('top.txt', 'hit\n');
    const result = await search({ pattern: 'hit' });
    const files = result.split('\n').filter((line) => line.startsWith(dir));
    expect(files.map((file) => path.relative(dir, file).replaceAll('\\', '/'))).toEqual([
      '.hidden/zero.txt',
      'a/one.txt',
      'b/two.txt',
      'top.txt',
    ]);
  });

  test('path may be a single file', async () => {
    const file = put('a.txt', 'hit\n');
    put('b.txt', 'hit\n');
    const result = await new SearchFilesTool().run({ pattern: 'hit', path: file });
    expect(result).toContain(`file: ${file}`);
    expect(matchLines(result)).toEqual(['1: hit']);
    expect(result).toContain('1 file searched');
  });

  test('a relative path is resolved against the agent working directory, which is the default', async () => {
    put('sub/a.txt', 'hit\n');
    put('other.txt', 'hit\n');
    const scope = new WorkingDirectoryScope();
    setAgentWorkingDirectory(scope, dir);
    const tool = new SearchFilesTool({ scope });
    const whole = await tool.run({ pattern: 'hit' });
    expect(whole).toContain(`folder: ${dir}`);
    expect(whole).toContain('matches: 2 in 2 files');
    const sub = await tool.run({ pattern: 'hit', path: 'sub' });
    expect(sub).toContain(`folder: ${path.join(dir, 'sub')}`);
    expect(sub).toContain('matches: 1 in 1 file');
  });

  test('a path that does not exist is an error naming it', async () => {
    const missing = path.join(dir, 'nope');
    const result = await new SearchFilesTool().run({ pattern: 'x', path: missing });
    expect(result).toContain('[search_files error: unable to access');
    expect(result).toContain(missing);
    expect(result).toContain('Nothing was searched');
  });
});

describe('file_filter', () => {
  beforeEach(() => {
    put('a.ts', 'hit\n');
    put('src/b.ts', 'hit\n');
    put('src/deep/c.tsx', 'hit\n');
    put('src/deep/d.rs', 'hit\n');
    put('e.md', 'hit\n');
  });
  const filesIn = (result) =>
    result
      .split('\n')
      .filter((line) => line.startsWith(dir))
      .map((file) => path.relative(dir, file).replaceAll('\\', '/'));

  test('a glob with no / is matched against the file name at any depth', async () => {
    const result = await search({ pattern: 'hit', file_filter: '*.ts' });
    expect(filesIn(result)).toEqual(['a.ts', 'src/b.ts']);
    expect(result).toContain('file_filter: *.ts (matched against the file name)');
    expect(result).toContain('3 other files did not match file_filter');
  });

  test('braces give alternatives', async () => {
    const result = await search({ pattern: 'hit', file_filter: '*.{ts,tsx}' });
    expect(filesIn(result)).toEqual(['a.ts', 'src/b.ts', 'src/deep/c.tsx']);
  });

  test('a glob with a / is matched against the path relative to the searched folder', async () => {
    const result = await search({ pattern: 'hit', file_filter: 'src/**/*.rs' });
    expect(filesIn(result)).toEqual(['src/deep/d.rs']);
    expect(result).toContain('(matched against the path relative to the folder)');
  });

  test('** followed by / also matches zero folders', async () => {
    expect(filesIn(await search({ pattern: 'hit', file_filter: 'src/**/*.ts' }))).toEqual([
      'src/b.ts',
    ]);
    expect(filesIn(await search({ pattern: 'hit', file_filter: '**/*.ts' }))).toEqual([
      'a.ts',
      'src/b.ts',
    ]);
  });

  test('* does not cross a /, and the glob is case-sensitive', async () => {
    expect(filesIn(await search({ pattern: 'hit', file_filter: 'src/*.tsx' }))).toEqual([]);
    expect(filesIn(await search({ pattern: 'hit', file_filter: '*.TS' }))).toEqual([]);
  });

  test('a filter that matches nothing says so, so a typo is visible', async () => {
    const result = await search({ pattern: 'hit', file_filter: '*.nope' });
    expect(result).toContain('matches: 0 in 0 files');
    expect(result).toContain(
      'status: complete. 0 files searched; 5 other files did not match file_filter.'
    );
  });

  test.each([
    ['[ab].ts', 'character sets'],
    ['!*.ts', 'leading !'],
    [String.raw`src\*.ts`, 'backslash'],
    ['./*.ts', '"./" or "/"'],
    ['/abs/*.ts', '"./" or "/"'],
    ['{a,b', 'no matching }'],
    ['a,b}', 'no matching {'],
    ['{a,{b,c}}', 'nested'],
  ])('unsupported glob %s is refused, naming the problem', async (glob, fragment) => {
    const result = await search({ pattern: 'hit', file_filter: glob });
    expect(result).toMatch(/^\[search_files error: /);
    expect(result).toContain(fragment);
    expect(result).toContain('Nothing was searched');
  });

  test('file_filter with a file as path is refused', async () => {
    const file = path.join(dir, 'a.ts');
    const result = await new SearchFilesTool().run({
      pattern: 'hit',
      path: file,
      file_filter: '*.ts',
    });
    expect(result).toContain('"file_filter" cannot be used when "path" is a file');
  });

  test('compileFileGlob: the dialect, directly', () => {
    const matches = (glob, text) => compileFileGlob(glob).regex.test(text);
    expect(matches('*.{ts,tsx}', 'x.tsx')).toBe(true);
    expect(matches('a?c', 'abc')).toBe(true);
    expect(matches('a?c', 'a/c')).toBe(false);
    expect(matches('a.c', 'abc')).toBe(false); // . is a literal dot, not a wildcard
    expect(compileFileGlob('a/b').target).toBe('path');
    expect(compileFileGlob('ab').target).toBe('name');
  });
});

describe('the result limit', () => {
  const manyMatches = (files, perFile) => {
    for (let index = 0; index < files; index++) {
      put(`f${index}.txt`, Array.from({ length: perFile }, () => 'hit').join('\n'));
    }
  };

  test('stops at max_results, says so, and says more matches exist', async () => {
    manyMatches(3, 4); // 12 matches
    const result = await search({ pattern: 'hit', max_results: 5 });
    expect(matchLines(result)).toHaveLength(5);
    expect(result).toContain('matches: 5 in 2 files');
    expect(result).toContain(
      'status: STOPPED at max_results=5; more matches exist, so this list is incomplete.'
    );
    expect(result).toContain('Raise max_results, or narrow the search with path or file_filter');
    expect(result).toContain('the files after it were not searched');
  });

  test('exactly max_results matches is complete, not stopped', async () => {
    manyMatches(1, 5);
    const result = await search({ pattern: 'hit', max_results: 5 });
    expect(matchLines(result)).toHaveLength(5);
    expect(result).toContain('status: complete.');
    expect(result).not.toContain('STOPPED');
  });

  test(`the default limit is ${SEARCH_FILES_DEFAULT_MAX_RESULTS}`, async () => {
    manyMatches(1, SEARCH_FILES_DEFAULT_MAX_RESULTS + 20);
    const result = await search({ pattern: 'hit' });
    expect(matchLines(result)).toHaveLength(SEARCH_FILES_DEFAULT_MAX_RESULTS);
    expect(result).toContain(`STOPPED at max_results=${SEARCH_FILES_DEFAULT_MAX_RESULTS}`);
  });

  test('raising max_results returns the rest', async () => {
    manyMatches(1, 150);
    const result = await search({ pattern: 'hit', max_results: 1000 });
    expect(matchLines(result)).toHaveLength(150);
    expect(result).toContain('status: complete.');
  });
});

describe('no file is excluded', () => {
  test('.git and node_modules are searched, at any depth', async () => {
    put('.git/config', 'hit\n');
    put('node_modules/x/index.js', 'hit\n');
    put('pkg/node_modules/y.js', 'hit\n');
    put('src/a.txt', 'hit\n');
    const result = await search({ pattern: 'hit' });
    expect(result).toContain('matches: 4 in 4 files');
    expect(result).toContain('status: complete. 4 files searched.');
    expect(result).not.toContain('not searched:');
  });

  test('a binary file is searched, and bytes that are not UTF-8 show as U+FFFD', async () => {
    writeFileSync(path.join(dir, 'bin.dat'), Buffer.from([104, 105, 116, 0, 255, 1, 10]));
    writeFileSync(path.join(dir, 'utf16.txt'), Buffer.from('hit\n', 'utf16le'));
    const result = await search({ pattern: 'hit' });
    // UTF-16 text has a NUL between letters, so only the first file matches as text.
    expect(result).toContain('matches: 1 in 1 file');
    expect(result).toContain('hit\u0000�');
    expect(result).toContain('status: complete. 2 files searched.');
    expect(await search({ pattern: 'h.i.t', file_filter: 'utf16.txt' })).toContain(
      'matches: 1 in 1 file'
    );
  });

  test('a large file is searched whole, with no size limit', async () => {
    const filler = `${'x'.repeat(99)}\n`.repeat(130_000); // about 13 MB
    put('big.txt', `${filler}the hit is here\n`);
    const result = await search({ pattern: 'the hit is here' });
    expect(matchLines(result)).toEqual(['130001: the hit is here']);
    expect(result).toContain('status: complete. 1 file searched.');
  }, 30_000);

  test('a symbolic link is followed, even to a folder outside the searched one', async () => {
    const outside = mkdtempSync(path.join(os.tmpdir(), 'search-files-outside-'));
    try {
      writeFileSync(path.join(outside, 'o.txt'), 'hit outside\n');
      try {
        symlinkSync(outside, path.join(dir, 'link'), 'junction');
      } catch {
        return; // this machine does not allow creating one; nothing to check
      }
      const result = await search({ pattern: 'hit' });
      expect(result).toContain('matches: 1 in 1 file');
      expect(result).toContain('hit outside');
      expect(result).toContain(path.join(dir, 'link', 'o.txt'));
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('a folder reached twice is searched once, and the result names the repeat', async () => {
    put('real/a.txt', 'hit\n');
    try {
      symlinkSync(path.join(dir, 'real'), path.join(dir, 'link'), 'junction');
    } catch {
      return;
    }
    const result = await search({ pattern: 'hit' });
    expect(result).toContain('matches: 1 in 1 file');
    expect(result).toContain('not searched:');
    expect(result).toContain(
      'folders not searched again, already searched under their real path: 1'
    );
    expect(result).toContain(`${path.join(dir, 'real')} (same as ${path.join(dir, 'link')})`);
  });

  test('a link that leads back to a parent folder does not loop', async () => {
    put('a/file.txt', 'hit\n');
    try {
      symlinkSync(dir, path.join(dir, 'a', 'back'), 'junction');
    } catch {
      return;
    }
    const result = await search({ pattern: 'hit' });
    expect(result).toContain('matches: 1 in 1 file');
    expect(result).toContain('status: complete.');
    expect(result).toContain('folders not searched again');
  });
});

describe('time and cancellation', () => {
  const ticking = () => {
    let time = 0;
    return () => {
      const value = time;
      time += 1000;
      return value;
    };
  };

  test('stops at timeout_seconds, reports where it got to, and says the search is incomplete', async () => {
    for (let index = 0; index < 12; index++) put(`f${String(index).padStart(2, '0')}.txt`, 'hit\n');
    const result = await search({ pattern: 'hit', timeout_seconds: 12 }, { now: ticking() });
    expect(result).toContain('status: STOPPED after timeout_seconds=12; the search is incomplete');
    expect(result).toContain('there may be more matches');
    expect(result).toContain('Raise timeout_seconds');
    expect(result).toMatch(/\(the last was .*f0\d\.txt\)/);
    expect(result).not.toContain('matches: 12');
  });

  test('a pattern that backtracks without end is stopped at the timeout, not allowed to freeze the process', async () => {
    put('a.txt', `${'a'.repeat(60)}b\n`);
    put('z.txt', 'a\n');
    const started = Date.now();
    const result = await search({ pattern: '(a+)+$', timeout_seconds: 1 });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(result).toContain(
      `STOPPED after timeout_seconds=1; time ran out while matching the pattern: ${path.join(dir, 'a.txt')} was not searched`
    );
    expect(result).toContain('try a simpler pattern or literal=true');
  }, 20_000);

  test('a normal pattern is not slowed down or stopped by the guard', async () => {
    put('a.txt', `${'a'.repeat(60)}b\n`);
    const result = await search({ pattern: 'a+b', timeout_seconds: 1 });
    expect(result).toContain('status: complete.');
    expect(matchLines(result)).toHaveLength(1);
  });

  test('a cancel stops the search, says so, and is not reported as an unreadable file', async () => {
    for (let index = 0; index < 10; index++) put(`f${index}.txt`, 'hit\n');
    const controller = new AbortController();
    let calls = 0;
    const now = () => {
      calls++;
      if (calls === 4) controller.abort();
      return 0;
    };
    const result = await new SearchFilesTool({ now }).run(
      { pattern: 'hit', path: dir },
      controller.signal
    );
    expect(result).toContain('status: STOPPED; the search was cancelled');
    expect(result).not.toContain('could not be read');
  });
});

describe('argument checking', () => {
  test.each([
    [{}, 'missing required argument "pattern"'],
    [{ pattern: '' }, 'missing required argument "pattern"'],
    [{ pattern: 5 }, 'missing required argument "pattern"'],
    [{ pattern: 'x', literal: 'true' }, '"literal" must be true or false (got "true")'],
    [{ pattern: 'x', case_insensitive: 1 }, '"case_insensitive" must be true or false (got 1)'],
    [{ pattern: 'x', max_results: 0 }, '"max_results" must be a whole number of 1 or more'],
    [{ pattern: 'x', max_results: 2.5 }, '"max_results" must be a whole number of 1 or more'],
    [
      { pattern: 'x', max_results: '5' },
      '"max_results" must be a whole number of 1 or more (got "5")',
    ],
    [
      { pattern: 'x', timeout_seconds: 0 },
      '"timeout_seconds" must be a positive number of seconds',
    ],
    [
      { pattern: 'x', timeout_seconds: '30' },
      '"timeout_seconds" must be a positive number of seconds',
    ],
    [{ pattern: 'x', max_results: 2 ** 53 }, '"max_results" must be a whole number of 1 or more'],
    [{ pattern: 'x', max_line_chars: 0 }, '"max_line_chars" must be a whole number of 1 or more'],
    [
      { pattern: 'x', max_line_chars: '40' },
      '"max_line_chars" must be a whole number of 1 or more',
    ],
    [{ pattern: 'x', max_listed: -1 }, '"max_listed" must be a whole number of 0 or more'],
    [{ pattern: 'x', max_listed: 1.5 }, '"max_listed" must be a whole number of 0 or more'],
    [{ pattern: 'x', file_filter: '' }, '"file_filter" must be a non-empty glob string'],
    [{ pattern: 'x', file_filter: 3 }, '"file_filter" must be a non-empty glob string'],
    [{ pattern: 'x', path: '  ' }, '"path" must be a non-empty string'],
  ])('%j is refused by name and nothing is searched', async (args, fragment) => {
    put('a.txt', 'x\n');
    const result = await new SearchFilesTool().run({
      path: dir,
      ...args,
      ...(args.path ? { path: args.path } : {}),
    });
    expect(result).toMatch(/^\[search_files error: /);
    expect(result).toContain(fragment);
    expect(result).toContain('Nothing was searched');
  });
});

describe('reading a file in pieces', () => {
  /** A tool that reads and matches in very small pieces, so every edge is reached in a tiny file. */
  const small = (pieceBytes, batchLines = 3) =>
    new SearchFilesTool({ readSizes: { pieceBytes, batchLines, batchChars: 1_000_000 } });

  test('a line that spans two pieces is one line, with its own number', async () => {
    put('a.txt', 'alpha\nbe needle ta\ngamma\n');
    const result = await small(3).run({ path: dir, pattern: 'needle' });
    expect(matchLines(result)).toEqual(['2: be needle ta']);
  });

  test('the same result whatever the piece and batch sizes are', async () => {
    put('a.txt', 'one\r\nneedle here\r\nété needle\n\nlast needle');
    const whole = await search({ pattern: 'needle' });
    expect(whole).toContain('matches: 3 in 1 file');
    for (const pieceBytes of [1, 2, 3, 5, 7, 64]) {
      expect(await small(pieceBytes, 1).run({ path: dir, pattern: 'needle' })).toBe(whole);
    }
  });

  test('a multi-byte character split between pieces comes out whole', async () => {
    put('a.txt', 'café needle\n');
    const result = await small(4).run({ path: dir, pattern: 'café needle' });
    expect(matchLines(result)).toEqual(['1: café needle']);
  });

  test('a byte order mark is kept, as a whole-file read kept it', async () => {
    put('a.txt', '﻿needle\n');
    const result = await small(2).run({ path: dir, pattern: 'needle' });
    expect(result).toContain('\n  1: ﻿needle');
  });

  test('an empty file and a file of one line break each have one empty line, as before', async () => {
    put('empty.txt', '');
    put('nl.txt', '\n');
    put('one.txt', 'x\n');
    const result = await small(1).run({ path: dir, pattern: '^$' });
    expect(result).toContain('matches: 2 in 2 files');
    expect(result).not.toMatch(/^ {2}2: /m);
  });

  test('line numbers carry across batch boundaries', async () => {
    const lines = Array.from({ length: 10 }, (_, index) =>
      index % 3 === 0 ? `hit ${index + 1}` : `row ${index + 1}`
    );
    put('a.txt', `${lines.join('\n')}\n`);
    const result = await small(5, 3).run({ path: dir, pattern: 'hit' });
    expect(matchLines(result)).toEqual(['1: hit 1', '4: hit 4', '7: hit 7', '10: hit 10']);
  });

  test('a file of several megabytes is read to its end, at the default sizes', async () => {
    const rows = Array.from({ length: 300_000 }, () => 'row of text');
    put('big.txt', `${rows.join('\n')}\nneedle at the end\n`);
    const result = await search({ pattern: 'needle' });
    expect(result).toContain('matches: 1 in 1 file');
    expect(matchLines(result)).toEqual(['300001: needle at the end']);
    expect(result).toContain('status: complete. 1 file searched.');
  }, 60_000);

  test('a stop at max_results says how far into the file it got', async () => {
    const file = put('a.txt', Array.from({ length: 10 }, () => 'hit').join('\n'));
    const result = await new SearchFilesTool({
      readSizes: { pieceBytes: 4, batchLines: 3, batchChars: 1_000_000 },
    }).run({ path: dir, pattern: 'hit', max_results: 4 });
    expect(matchLines(result)).toEqual(['1: hit', '2: hit', '3: hit', '4: hit']);
    expect(result).toContain(
      `${file} was searched only up to line 5; the files after it were not searched.`
    );
  });

  test('a timeout in the middle of a file keeps the lines before it, and says how far it got', async () => {
    put('a.txt', Array.from({ length: 40 }, () => 'hit').join('\n'));
    let time = 0;
    const tool = new SearchFilesTool({
      now: () => {
        time += 1000;
        return time;
      },
      readSizes: { pieceBytes: 8, batchLines: 4, batchChars: 1_000_000 },
    });
    const result = await tool.run({ path: dir, pattern: 'hit', timeout_seconds: 6 });
    const reached = /a\.txt was searched only up to line (\d+)/.exec(result);
    expect(reached).not.toBeNull();
    const line = Number(reached[1]);
    expect(line).toBeGreaterThan(0);
    expect(line).toBeLessThan(40);
    expect(result).toContain('STOPPED after timeout_seconds=6; the search is incomplete');
    expect(matchLines(result)).toHaveLength(line);
  });
});

describe('the limits the call can change', () => {
  test('max_line_chars sets how much of a long line is shown, a third of it before the match', async () => {
    const line = `${'x'.repeat(150)}needle${'y'.repeat(44)}`;
    put('a.txt', `${line}\n`);
    const result = await search({ pattern: 'needle', max_line_chars: 40 });
    // The match is at character 150; a third of 40 is 13 characters before it, so 137 to 176 are shown.
    expect(result).toContain(
      `...${'x'.repeat(13)}needle${'y'.repeat(21)}... [line is 200 characters; showing characters 138-177]`
    );
  });

  test('a large max_line_chars shows a whole long line, with no cut', async () => {
    const line = `${'a'.repeat(500)}needle${'b'.repeat(500)}`;
    put('a.txt', `${line}\n`);
    const result = await search({ pattern: 'needle', max_line_chars: 5000 });
    expect(result).toContain(`  1: ${line}`);
    expect(result).not.toContain('[line is');
  });

  test('max_listed sets how many names are listed, and 0 gives the counts only', async () => {
    put('real/a.txt', 'hit\n');
    try {
      symlinkSync(path.join(dir, 'real'), path.join(dir, 'l1'), 'junction');
      symlinkSync(path.join(dir, 'real'), path.join(dir, 'l2'), 'junction');
      symlinkSync(path.join(dir, 'real'), path.join(dir, 'l3'), 'junction');
    } catch {
      return; // this machine does not allow creating one; nothing to check
    }
    const one = await search({ pattern: 'hit', max_listed: 1 });
    expect(one).toContain(
      `folders not searched again, already searched under their real path: 3: ${path.join(dir, 'l2')} (same as ${path.join(dir, 'l1')}), ...`
    );
    const none = await search({ pattern: 'hit', max_listed: 0 });
    expect(none).toContain('folders not searched again, already searched under their real path: 3');
    expect(none).not.toContain('(same as');
  });

  test('max_results accepts the largest safe whole number, and timeout_seconds above 300', async () => {
    put('a.txt', 'hit\n');
    const result = await search({
      pattern: 'hit',
      max_results: Number.MAX_SAFE_INTEGER,
      timeout_seconds: 3600,
    });
    expect(result).toContain('status: complete. 1 file searched.');
    expect(result).toContain('matches: 1 in 1 file');
  });
});

describe('through the tool registry', () => {
  let toolRegistry;
  beforeAll(async () => {
    // The registry reaches jsdom only through the web tools.
    jest.unstable_mockModule('jsdom', () => ({ JSDOM: class {}, VirtualConsole: class {} }));
    ({ toolRegistry } = await import('../src/tools/toolRegistry.ts'));
  }, 60_000);
  afterAll(() => {
    jest.resetModules();
  });

  test('search_files is registered and runs', async () => {
    put('a.txt', 'needle\n');
    const { content } = await toolRegistry
      .get('search_files')
      .execute({ pattern: 'needle', path: dir });
    expect(content).toContain('matches: 1 in 1 file');
  });

  test('an unknown argument is reported, not silently dropped', async () => {
    put('a.txt', 'needle\n');
    const { content } = await toolRegistry
      .get('search_files')
      .execute({ pattern: 'needle', path: dir, timeout_ms: 5000 });
    expect(content).toContain('matches: 1 in 1 file');
    expect(content).toContain('[Note: ignored unknown argument for search_files: timeout_ms.');
  });

  test('the removed include_skipped_folders argument is reported as unknown, not silently ignored', async () => {
    put('a.txt', 'needle\n');
    const { content } = await toolRegistry
      .get('search_files')
      .execute({ pattern: 'needle', path: dir, include_skipped_folders: true });
    expect(content).toContain(
      '[Note: ignored unknown argument for search_files: include_skipped_folders.'
    );
  });

  test('max_line_chars and max_listed reach the tool, and are not reported as unknown', async () => {
    put('a.txt', `${'x'.repeat(100)}needle${'y'.repeat(100)}\n`);
    const { content } = await toolRegistry
      .get('search_files')
      .execute({ pattern: 'needle', path: dir, max_line_chars: 40, max_listed: 0 });
    expect(content).toContain('[line is 206 characters; showing characters');
    expect(content).not.toContain('ignored unknown argument');
  });

  test('a skill that does not allow search_files blocks it, by name', async () => {
    const { content } = await toolRegistry
      .get('search_files')
      .execute({ pattern: 'x' }, undefined, undefined, { allowedTools: ['read_file'] });
    expect(content).toContain('tool "search_files" is not allowed by the currently active skills');
  });

  test('it is in the model-facing tool list and the tool-name list', async () => {
    const { TOOLS, getToolSystemPrompt } = await import('../src/tools/tools.ts');
    const { TOOL_NAMES } = await import('../src/tools/toolNames.ts');
    expect(TOOLS.map((tool) => tool.function.name)).toContain('search_files');
    expect(TOOL_NAMES).toContain('search_files');
    const prompt = getToolSystemPrompt(false);
    expect(prompt).toContain('16. search_files(');
    expect(prompt).toContain('use search_files rather than writing a script');
  });
});
