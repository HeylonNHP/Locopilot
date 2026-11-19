import { constants as bufferConstants } from 'node:buffer';
import { type FileHandle, open, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import type { ToolSchema } from '@/tools/toolSchema';

import { MAX_TIMEOUT_SECONDS, parsePositiveTimeoutMs } from '@/tools/commandHelpers';
import { compileFileGlob, FILE_GLOB_SYNTAX_SENTENCE } from '@/tools/fileGlob';
import {
  DEFAULT_LINE_READ_SIZES,
  FileReadError,
  LineReader,
  type LineReadSizes,
} from '@/tools/lineReader';
import { type LineHit, LineScanner, PatternTimeoutError } from '@/tools/lineScanner';
import { resolveAgentPath, type WorkingDirectoryScope } from '@/tools/workingDirectory';

/** Matching lines returned before the search stops. */
export const SEARCH_FILES_DEFAULT_MAX_RESULTS = 100;
/** Seconds a search may run before it stops and says so. */
export const SEARCH_FILES_DEFAULT_TIMEOUT_SECONDS = 30;
/** A matching line longer than this is cut around the match, and marked. */
export const SEARCH_FILES_MAX_LINE_CHARS = 300;
/** How many names of each kind of entry the result did not read it lists. */
export const SEARCH_FILES_DEFAULT_MAX_LISTED = 5;
/** The largest whole number JavaScript holds exactly. */
const MAX_WHOLE_NUMBER = Number.MAX_SAFE_INTEGER;
/** The longest text JavaScript holds in one string: the most one line can hold. */
const MAX_STRING_CHARS = bufferConstants.MAX_STRING_LENGTH;

const SEARCH_FILES_DESCRIPTION = String.raw`Searches the text of files for a pattern and returns every matching line with its file and line number, like grep. The pattern is a regular expression (JavaScript syntax) unless you set literal=true, which searches for the exact text instead. It is case-sensitive unless you set case_insensitive=true. It is matched against one line at a time, so it cannot span lines; a trailing \r is removed from each line before matching (so $ works in Windows files), and the empty piece after a file's final line break is not a line. Lines are numbered from 1, split at \n, as in read_file. It searches the folder in path (default: the agent working directory) and every subfolder, or only that file if path is a file. file_filter limits which files are searched, as a glob: with no / in it, it is matched against the file name at any depth (*.ts, *.{ts,tsx}); with a /, against the path relative to the searched folder (src/**/*.rs). Glob syntax: ${FILE_GLOB_SYNTAX_SENTENCE} It stops after max_results matching lines (default ${SEARCH_FILES_DEFAULT_MAX_RESULTS}) and the result says so, and says whether more matches exist. max_results is the limit on how many lines are returned; it can be changed in the call, up to ${MAX_WHOLE_NUMBER.toLocaleString('en-US')}, the largest whole number JavaScript holds exactly. Files are searched folder by folder, each folder's entries sorted by character code (so A–Z come before a–z), so a stop at the limit leaves the later files unsearched. It also stops after timeout_seconds (default ${SEARCH_FILES_DEFAULT_TIMEOUT_SECONDS}) and says so. That limit covers the whole search, matching included: it is checked between files, between pieces of a file as it is read, and between batches of lines as they are matched. A folder listing is one call and is not cut off. A pattern that is too slow on some lines (nested repetition such as (a+)+ can be) also stops the search, within the same limit. The longest timeout accepted is ${MAX_TIMEOUT_SECONDS} seconds, the largest delay the runtime's timers accept. When the search stops partway through a file, the result names that file and the last line searched in it; the lines after that were not searched. No file is excluded by its name or type: every file under the folder is searched, including hidden files, .git, node_modules and binary files, so a search of a whole project can be slow and can match build output; narrow it with path, file_filter or the pattern. A file is read in pieces, so a file of any length is searched. The one limit no parameter changes is JavaScript's limit on the length of a single line (${MAX_STRING_CHARS.toLocaleString('en-US')} characters on this Node version): a line longer than that cannot be matched, so its file is listed as unreadable, and the matches found before that line are kept. .gitignore is not read. Files are read as UTF-8 (bytes that are not valid UTF-8 appear as U+FFFD). Symbolic links are followed; a folder already searched under its real path is not searched again, and the result lists it. A file or folder that cannot be read is listed in the result with its error, and so is a file that fails partway through, whose matches found before the failure are kept. Entries that are neither files nor folders (sockets, pipes, devices) are not read, and are listed too. For each kind of entry the result gives the count and names the first max_listed (default ${SEARCH_FILES_DEFAULT_MAX_LISTED}). Only the matching line is returned: a line longer than max_line_chars (default ${SEARCH_FILES_MAX_LINE_CHARS}) is cut around the match, keeping a third of max_line_chars before the match, and marked. Use read_file with start_line to see the lines around it.`;

export const searchFilesToolSchema: ToolSchema = {
  name: 'search_files',
  description: SEARCH_FILES_DESCRIPTION,
  parameters: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description:
          'What to look for. A regular expression (JavaScript syntax), or exact text when literal=true. Matched against one line at a time, so it must not contain a line break.',
      },
      path: {
        type: 'string',
        description:
          'The folder to search (all its subfolders are searched too), or one file to search. Absolute, or relative to the agent working directory. Defaults to the agent working directory.',
      },
      file_filter: {
        type: 'string',
        description: `A glob that limits which files are searched, for example "*.ts", "*.{ts,tsx}" or "src/**/*.rs". With no / it is matched against the file name at any depth; with a / against the path relative to the searched folder. ${FILE_GLOB_SYNTAX_SENTENCE} Not allowed when path is a file.`,
      },
      literal: {
        type: 'boolean',
        description:
          'true: search for the pattern as exact text, with no regular-expression syntax. false (the default): the pattern is a regular expression.',
      },
      case_insensitive: {
        type: 'boolean',
        description:
          'true: ignore upper/lower case when matching. false (the default): the match is case-sensitive.',
      },
      max_results: {
        type: 'number',
        description: `The most matching lines to return before stopping, a whole number of 1 or more. Default ${SEARCH_FILES_DEFAULT_MAX_RESULTS}. Up to ${MAX_WHOLE_NUMBER.toLocaleString('en-US')}, the largest whole number JavaScript holds exactly. The result says when it stopped here and whether more matches exist.`,
      },
      timeout_seconds: {
        type: 'number',
        description: `Seconds the whole search may run before it stops and reports where it got to. Reading and matching are both cut off at this limit; a file is read in pieces, so a long file cannot run far past it. Default ${SEARCH_FILES_DEFAULT_TIMEOUT_SECONDS}; at most ${MAX_TIMEOUT_SECONDS}.`,
      },
      max_line_chars: {
        type: 'number',
        description: `The most characters of a matching line to show. A longer line is cut around the match, keeping a third of this many characters before the match, and marked. A whole number of 1 or more. Default ${SEARCH_FILES_MAX_LINE_CHARS}; there is no upper limit, so a large number shows whole lines.`,
      },
      max_listed: {
        type: 'number',
        description: `How many names the result lists for each kind of entry it did not read or did not search again. A whole number of 0 or more; 0 gives the counts only. Default ${SEARCH_FILES_DEFAULT_MAX_LISTED}. The counts are always given in full, and there is no upper limit.`,
      },
    },
    required: ['pattern'],
  },
};

/** Fields are `unknown`: they come from a model, so each is checked, never assumed. */
export interface SearchFilesToolArgs {
  pattern?: unknown;
  path?: unknown;
  file_filter?: unknown;
  literal?: unknown;
  case_insensitive?: unknown;
  max_results?: unknown;
  timeout_seconds?: unknown;
  max_line_chars?: unknown;
  max_listed?: unknown;
}

export interface SearchFilesToolOptions {
  scope?: WorkingDirectoryScope | undefined;
  /** Clock in milliseconds; tests replace it to move time without waiting. */
  now?: () => number;
  /** The sizes a file is read and matched in; tests make them small to reach the edges. */
  readSizes?: LineReadSizes;
}

interface SearchParameters {
  pattern: string;
  literal: boolean;
  caseInsensitive: boolean;
  matcher: RegExp;
  pathInput: string | undefined;
  fileFilter: { source: string; regex: RegExp; target: 'name' | 'path' } | undefined;
  maxResults: number;
  timeoutSeconds: number;
  timeoutMs: number;
  maxLineChars: number;
  maxListed: number;
}

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

type StopReason = 'cancelled' | 'limit' | 'timeout';

/** How far into a file a search that stopped partway through it had got: lines 1 to `line` were searched. */
interface StopPoint {
  file: string;
  line: number;
}

interface MatchGroup {
  file: string;
  lines: Array<{ lineNumber: number; text: string }>;
}

interface SearchState {
  params: SearchParameters;
  reader: LineReader;
  root: string;
  rootIsFile: boolean;
  deadline: number;
  stop: StopReason | null;
  /** Set when the search stops partway through a file. */
  stopPoint: StopPoint | undefined;
  groups: MatchGroup[];
  matchCount: number;
  filesSearched: number;
  filteredOut: number;
  /** Real path of every folder entered, with the path it was first reached by. */
  searchedFolders: Map<string, string>;
  /** Folders not entered because their real path was already searched. */
  repeatedFolders: Array<{ folder: string; firstReachedAs: string }>;
  unreadable: Array<{ file: string; code: string }>;
  /** Entries that are neither a file nor a folder (sockets, pipes, devices): not read. */
  notFileOrFolder: string[];
  lastFile: string | undefined;
  /** The file on which the pattern ran out of time, when that is why the search stopped. */
  slowFile: string | undefined;
  scanner: LineScanner;
}

function refusal(message: string): { ok: false; error: string } {
  return { ok: false, error: `[search_files error: ${message} Nothing was searched.]` };
}

function describeValue(value: unknown): string {
  const text = typeof value === 'string' ? JSON.stringify(value) : String(value);
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

function readBoolean(value: unknown, name: string): Parsed<boolean> {
  if (value === undefined) return { ok: true, value: false };
  if (typeof value === 'boolean') return { ok: true, value };
  return refusal(`"${name}" must be true or false (got ${describeValue(value)}).`);
}

function escapeForRegExp(text: string): string {
  return text.replaceAll(/[$()*+.?[\\\]^{|}]/g, String.raw`\$&`);
}

/** A whole number from `minimum` up, or the default when the argument was not sent. */
function readWholeNumber(
  value: unknown,
  name: string,
  fallback: number,
  minimum: number
): Parsed<number> {
  if (value === undefined) return { ok: true, value: fallback };
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    return refusal(
      `"${name}" must be a whole number of ${minimum} or more (got ${describeValue(value)}).`
    );
  }
  return { ok: true, value };
}

function readTimeout(value: unknown): Parsed<{ seconds: number; ms: number }> {
  if (value === undefined) {
    return {
      ok: true,
      value: {
        seconds: SEARCH_FILES_DEFAULT_TIMEOUT_SECONDS,
        ms: SEARCH_FILES_DEFAULT_TIMEOUT_SECONDS * 1000,
      },
    };
  }
  const ms = typeof value === 'number' ? parsePositiveTimeoutMs(value) : null;
  if (ms === null || typeof value !== 'number') {
    return refusal(
      `"timeout_seconds" must be a positive number of seconds, at most ${MAX_TIMEOUT_SECONDS} (got ${describeValue(value)}).`
    );
  }
  return { ok: true, value: { seconds: value, ms } };
}

function readPattern(args: SearchFilesToolArgs, literal: boolean, caseInsensitive: boolean) {
  if (typeof args.pattern !== 'string' || args.pattern.length === 0) {
    return refusal('missing required argument "pattern" (a non-empty string).');
  }
  if (/[\n\r]/.test(args.pattern)) {
    return refusal(
      'the pattern contains a line break, but search_files matches one line at a time. Search for a single line of it.'
    );
  }
  try {
    const matcher = new RegExp(
      literal ? escapeForRegExp(args.pattern) : args.pattern,
      caseInsensitive ? 'i' : ''
    );
    return { ok: true as const, value: { matcher, pattern: args.pattern } };
  } catch (err) {
    return refusal(
      `"pattern" is not a valid regular expression (${err instanceof Error ? err.message : String(err)}). If you meant plain text, send literal=true.`
    );
  }
}

function readFileFilter(args: SearchFilesToolArgs): Parsed<SearchParameters['fileFilter']> {
  if (args.file_filter === undefined) return { ok: true, value: undefined };
  if (typeof args.file_filter !== 'string' || args.file_filter.trim().length === 0) {
    return refusal(
      `"file_filter" must be a non-empty glob string (got ${describeValue(args.file_filter)}).`
    );
  }
  const compiled = compileFileGlob(args.file_filter);
  if (!compiled.ok) return refusal(compiled.error);
  return {
    ok: true,
    value: { source: args.file_filter, regex: compiled.regex, target: compiled.target },
  };
}

function parseArguments(args: SearchFilesToolArgs): Parsed<SearchParameters> {
  const literal = readBoolean(args.literal, 'literal');
  if (!literal.ok) return literal;
  const caseInsensitive = readBoolean(args.case_insensitive, 'case_insensitive');
  if (!caseInsensitive.ok) return caseInsensitive;
  const pattern = readPattern(args, literal.value, caseInsensitive.value);
  if (!pattern.ok) return pattern;
  const maxResults = readWholeNumber(
    args.max_results,
    'max_results',
    SEARCH_FILES_DEFAULT_MAX_RESULTS,
    1
  );
  if (!maxResults.ok) return maxResults;
  const timeout = readTimeout(args.timeout_seconds);
  if (!timeout.ok) return timeout;
  const maxLineChars = readWholeNumber(
    args.max_line_chars,
    'max_line_chars',
    SEARCH_FILES_MAX_LINE_CHARS,
    1
  );
  if (!maxLineChars.ok) return maxLineChars;
  const maxListed = readWholeNumber(
    args.max_listed,
    'max_listed',
    SEARCH_FILES_DEFAULT_MAX_LISTED,
    0
  );
  if (!maxListed.ok) return maxListed;
  const fileFilter = readFileFilter(args);
  if (!fileFilter.ok) return fileFilter;
  if (args.path !== undefined && (typeof args.path !== 'string' || args.path.trim().length === 0)) {
    return refusal(`"path" must be a non-empty string (got ${describeValue(args.path)}).`);
  }
  return {
    ok: true,
    value: {
      pattern: pattern.value.pattern,
      literal: literal.value,
      caseInsensitive: caseInsensitive.value,
      matcher: pattern.value.matcher,
      pathInput: typeof args.path === 'string' ? args.path.trim() : undefined,
      fileFilter: fileFilter.value,
      maxResults: maxResults.value,
      timeoutSeconds: timeout.value.seconds,
      timeoutMs: timeout.value.ms,
      maxLineChars: maxLineChars.value,
      maxListed: maxListed.value,
    },
  };
}

function plural(count: number, singular: string): string {
  return `${count.toLocaleString('en-US')} ${singular}${count === 1 ? '' : 's'}`;
}

function errorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  // V8 gives a string longer than its limit no code of its own; label it as Node labels its own.
  if (error instanceof RangeError && error.message === 'Invalid string length') {
    return 'ERR_STRING_TOO_LONG';
  }
  return error instanceof Error ? error.message : String(error);
}

/** The line as shown: cut around the match when longer than `maxChars`, and marked when cut. */
function showLine(line: string, matchIndex: number, maxChars: number): string {
  if (line.length <= maxChars) return line;
  const start = Math.max(0, matchIndex - Math.floor(maxChars / 3));
  const end = Math.min(line.length, start + maxChars);
  const shown = `${start > 0 ? '...' : ''}${line.slice(start, end)}${end < line.length ? '...' : ''}`;
  return `${shown} [line is ${line.length.toLocaleString('en-US')} characters; showing characters ${start + 1}-${end}]`;
}

function byName(a: { name: string }, b: { name: string }): number {
  if (a.name < b.name) return -1;
  return a.name > b.name ? 1 : 0;
}

/** Where a search that stopped partway through a file had got to, as the status line says it. */
function describeStopPoint(point: StopPoint): string {
  return point.line === 0
    ? `${point.file} was not searched`
    : `${point.file} was searched only up to line ${point.line.toLocaleString('en-US')}`;
}

/** One kind of entry the result did not read: its count, and the first `maxListed` names. */
function listKind<T>(
  label: string,
  items: readonly T[],
  maxListed: number,
  show: (item: T) => string
): string {
  const count = items.length.toLocaleString('en-US');
  if (maxListed === 0) return `${label}: ${count}`;
  const shown = items.slice(0, maxListed).map(show).join(', ');
  return `${label}: ${count}: ${shown}${items.length > maxListed ? ', ...' : ''}`;
}

export class SearchFilesTool {
  private readonly scope: WorkingDirectoryScope | undefined;
  private readonly now: () => number;
  private readonly readSizes: LineReadSizes;

  constructor(options: SearchFilesToolOptions = {}) {
    this.scope = options.scope;
    this.now = options.now ?? Date.now;
    this.readSizes = options.readSizes ?? DEFAULT_LINE_READ_SIZES;
  }

  async run(args: SearchFilesToolArgs, signal?: AbortSignal): Promise<string> {
    const parsed = parseArguments(args);
    if (!parsed.ok) return parsed.error;
    const params = parsed.value;

    const root = resolveAgentPath(this.scope, params.pathInput ?? '.');
    let rootStat;
    try {
      rootStat = await stat(root, { signal });
    } catch (err) {
      return `[search_files error: unable to access "${root}": ${err instanceof Error ? err.message : String(err)} Nothing was searched.]`;
    }
    const rootIsFile = rootStat.isFile();
    if (!rootIsFile && !rootStat.isDirectory()) {
      return `[search_files error: "${root}" is neither a folder nor a regular file. Nothing was searched.]`;
    }
    if (rootIsFile && params.fileFilter) {
      return '[search_files error: "file_filter" cannot be used when "path" is a file. Nothing was searched.]';
    }

    const state: SearchState = {
      params,
      reader: new LineReader(this.readSizes),
      root,
      rootIsFile,
      deadline: this.now() + params.timeoutMs,
      stop: null,
      stopPoint: undefined,
      groups: [],
      matchCount: 0,
      filesSearched: 0,
      filteredOut: 0,
      searchedFolders: new Map(),
      repeatedFolders: [],
      unreadable: [],
      notFileOrFolder: [],
      lastFile: undefined,
      slowFile: undefined,
      scanner: new LineScanner(params.matcher),
    };

    await (rootIsFile
      ? this.searchFile(root, state, signal)
      : this.searchFolder(root, state, signal));
    return this.format(state);
  }

  private shouldStop(state: SearchState, signal: AbortSignal | undefined): boolean {
    if (state.stop) return true;
    if (signal?.aborted) {
      state.stop = 'cancelled';
    } else if (this.now() > state.deadline) {
      state.stop = 'timeout';
    }
    return state.stop !== null;
  }

  private async searchFolder(
    folder: string,
    state: SearchState,
    signal: AbortSignal | undefined
  ): Promise<void> {
    if (this.shouldStop(state, signal)) return;
    let entries;
    try {
      // Symbolic links are followed, so a folder is identified by its real path:
      // one that leads back to a folder already searched is not entered again.
      const real = await realpath(folder);
      const firstReachedAs = state.searchedFolders.get(real);
      if (firstReachedAs !== undefined) {
        state.repeatedFolders.push({ folder, firstReachedAs });
        return;
      }
      state.searchedFolders.set(real, folder);
      entries = await readdir(folder, { withFileTypes: true });
    } catch (err) {
      state.unreadable.push({ file: folder, code: errorCode(err) });
      return;
    }
    entries.sort(byName);

    for (const entry of entries) {
      if (this.shouldStop(state, signal)) return;
      const full = path.join(folder, entry.name);
      let isDirectory = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          const target = await stat(full);
          isDirectory = target.isDirectory();
          isFile = target.isFile();
        } catch (err) {
          state.unreadable.push({ file: full, code: errorCode(err) });
          continue;
        }
      }
      if (isDirectory) {
        await this.searchFolder(full, state, signal);
      } else if (isFile) {
        if (this.passesFilter(full, entry.name, state)) {
          await this.searchFile(full, state, signal);
        } else {
          state.filteredOut++;
        }
      } else {
        state.notFileOrFolder.push(full);
      }
    }
  }

  private passesFilter(file: string, name: string, state: SearchState): boolean {
    const filter = state.params.fileFilter;
    if (!filter) return true;
    if (filter.target === 'name') return filter.regex.test(name);
    const relative = path.relative(state.root, file).split(path.sep).join('/');
    return filter.regex.test(relative);
  }

  private async searchFile(
    file: string,
    state: SearchState,
    signal: AbortSignal | undefined
  ): Promise<void> {
    let handle: FileHandle;
    try {
      handle = await open(file, 'r');
    } catch (err) {
      this.recordUnreadable(file, err, state, signal);
      return;
    }
    try {
      if (await this.searchLines(file, handle, state, signal)) {
        state.filesSearched++;
        state.lastFile = file;
      }
    } catch (err) {
      if (!(err instanceof FileReadError)) throw err;
      this.recordUnreadable(file, err.reason, state, signal);
    } finally {
      await handle.close();
    }
  }

  private recordUnreadable(
    file: string,
    err: unknown,
    state: SearchState,
    signal: AbortSignal | undefined
  ): void {
    // A read cut short by a cancel is not an unreadable file.
    if (!signal?.aborted) state.unreadable.push({ file, code: errorCode(err) });
  }

  /**
   * Matches one open file, a batch of lines at a time. Returns true when the
   * whole file was searched. Matches found before a stop are kept, and the
   * stop point says how far into the file the search got.
   */
  private async searchLines(
    file: string,
    handle: FileHandle,
    state: SearchState,
    signal: AbortSignal | undefined
  ): Promise<boolean> {
    /** Lines before the batch being matched. */
    let offset = 0;
    let group: MatchGroup | undefined;
    const batches = state.reader.batches(handle, () => !this.shouldStop(state, signal));
    for await (const lines of batches) {
      const remainingMs = state.deadline - this.now();
      if (remainingMs <= 0) {
        state.stop = 'timeout';
        break;
      }
      let hits: LineHit[];
      try {
        hits = state.scanner.scan(
          lines,
          state.params.maxResults - state.matchCount + 1,
          remainingMs
        );
      } catch (err) {
        if (!(err instanceof PatternTimeoutError)) throw err;
        state.stop = 'timeout';
        state.slowFile = file;
        break;
      }
      for (const { lineIndex, matchIndex } of hits) {
        if (state.matchCount >= state.params.maxResults) {
          // One match past the limit proves the list is incomplete.
          state.stop = 'limit';
          state.stopPoint = { file, line: offset + lineIndex + 1 };
          return false;
        }
        const rawLine = lines[lineIndex]!;
        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
        if (!group) {
          group = { file, lines: [] };
          state.groups.push(group);
        }
        group.lines.push({
          lineNumber: offset + lineIndex + 1,
          text: showLine(line, matchIndex, state.params.maxLineChars),
        });
        state.matchCount++;
      }
      offset += lines.length;
    }
    if (state.stop === null) return true;
    state.stopPoint ??= { file, line: offset };
    return false;
  }

  private format(state: SearchState): string {
    const filesWithMatches = state.groups.length;
    const out = [
      'search_files_result:',
      `${state.rootIsFile ? 'file' : 'folder'}: ${state.root}`,
      `pattern: ${state.params.pattern} (${state.params.literal ? 'exact text' : 'regular expression'}, ${state.params.caseInsensitive ? 'case-insensitive' : 'case-sensitive'})`,
      `file_filter: ${
        state.params.fileFilter
          ? `${state.params.fileFilter.source} (matched against the ${state.params.fileFilter.target === 'name' ? 'file name' : 'path relative to the folder'})`
          : 'none'
      }`,
      `matches: ${state.matchCount.toLocaleString('en-US')} in ${plural(filesWithMatches, 'file')}`,
      `status: ${this.describeStatus(state)}`,
    ];

    for (const group of state.groups) {
      out.push('', group.file);
      for (const { lineNumber, text } of group.lines) {
        out.push(`  ${lineNumber}: ${text}`);
      }
    }

    const notSearched = this.describeNotSearched(state);
    if (notSearched.length > 0) {
      out.push('', 'not searched:', ...notSearched.map((note) => `  ${note}`));
    }
    return out.join('\n');
  }

  private describeStatus(state: SearchState): string {
    const searched = plural(state.filesSearched, 'file');
    const last = state.lastFile ? ` (the last was ${state.lastFile})` : '';
    const point = state.stopPoint ? describeStopPoint(state.stopPoint) : '';
    const partway = point ? `; ${point}` : '';
    switch (state.stop) {
      case 'limit': {
        return `STOPPED at max_results=${state.params.maxResults}; more matches exist, so this list is incomplete. ${searched} searched before stopping${last}${partway}; the files after it were not searched. Raise max_results, or narrow the search with path or file_filter.`;
      }
      case 'timeout': {
        if (state.slowFile) {
          const reached = point ? `: ${point}` : '';
          return `STOPPED after timeout_seconds=${state.params.timeoutSeconds}; time ran out while matching the pattern${reached}, so the search is incomplete (there may be more matches). ${searched} searched before it${last}. If the pattern is the cause, a pattern with nested repetition such as (a+)+ can be this slow; try a simpler pattern or literal=true, or raise timeout_seconds.`;
        }
        return `STOPPED after timeout_seconds=${state.params.timeoutSeconds}; the search is incomplete, so there may be more matches. ${searched} searched${last}${partway}. Raise timeout_seconds, or narrow the search with path or file_filter.`;
      }
      case 'cancelled': {
        return `STOPPED; the search was cancelled before it finished, so there may be more matches. ${searched} searched${last}${partway}.`;
      }
      default: {
        const filtered =
          state.params.fileFilter === undefined
            ? ''
            : `; ${plural(state.filteredOut, 'other file')} did not match file_filter`;
        const notRead = state.unreadable.length + state.notFileOrFolder.length;
        if (notRead > 0) {
          const entries = `${notRead.toLocaleString('en-US')} ${notRead === 1 ? 'entry' : 'entries'}`;
          return `complete, except for ${entries} not read (see "not searched" below). ${searched} searched${filtered}.`;
        }
        return `complete. ${searched} searched${filtered}.`;
      }
    }
  }

  private describeNotSearched(state: SearchState): string[] {
    const { maxListed } = state.params;
    const notes: string[] = [];
    if (state.repeatedFolders.length > 0) {
      notes.push(
        listKind(
          'folders not searched again, already searched under their real path',
          state.repeatedFolders,
          maxListed,
          ({ folder, firstReachedAs }) => `${folder} (same as ${firstReachedAs})`
        )
      );
    }
    if (state.unreadable.length > 0) {
      notes.push(
        listKind(
          'could not be read',
          state.unreadable,
          maxListed,
          ({ file, code }) => `${file} (${code})`
        )
      );
    }
    if (state.notFileOrFolder.length > 0) {
      notes.push(
        listKind(
          'neither files nor folders (sockets, pipes, devices), not read',
          state.notFileOrFolder,
          maxListed,
          (name) => name
        )
      );
    }
    return notes;
  }
}

export function getToolPrompt(): string {
  const s = searchFilesToolSchema;
  const p = s.parameters.properties;
  return (
    `16. ${s.name}(pattern, path?, file_filter?, literal?, case_insensitive?, max_results?, timeout_seconds?, max_line_chars?, max_listed?)\n` +
    `   ${s.description}\n\n` +
    `   - pattern: ${p.pattern!.description}\n` +
    `   - path: ${p.path!.description}\n` +
    `   - file_filter: ${p.file_filter!.description}\n` +
    `   - literal: ${p.literal!.description}\n` +
    `   - case_insensitive: ${p.case_insensitive!.description}\n` +
    `   - max_results: ${p.max_results!.description}\n` +
    `   - timeout_seconds: ${p.timeout_seconds!.description}\n` +
    `   - max_line_chars: ${p.max_line_chars!.description}\n` +
    `   - max_listed: ${p.max_listed!.description}\n\n`
  );
}
