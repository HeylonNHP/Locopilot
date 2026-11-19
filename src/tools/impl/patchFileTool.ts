import { readFile, stat, writeFile } from 'node:fs/promises';

import type { ToolSchema } from '@/tools/tools';

import { noopToolOutputSink, type ToolOutputSink } from '@/tools/toolOutput';
import { resolveAgentPath, type WorkingDirectoryScope } from '@/tools/workingDirectory';

export const patchFileToolSchema: ToolSchema = {
  name: 'patch_file',
  description:
    'Applies targeted replacements to an existing file. Each patch must provide an exact "old" string and a new string. The tool first tries an exact match, then tolerates line-ending, trailing-whitespace, and leading-whitespace (indentation) differences. Prefer this for small edits to an existing file; use write_file when creating a file or replacing the full contents.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'A file path to patch, absolute or relative to the agent working directory.',
      },
      patches: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            old: {
              type: 'string',
              description:
                'The exact text to replace. Include enough surrounding context to make the match unique.',
            },
            new: { type: 'string', description: 'The replacement text.' },
            replace_all: {
              type: 'boolean',
              description:
                'Optional. Set true to replace EVERY place "old" matches. Without it, a patch that matches more than one place is rejected so nothing is changed by accident.',
            },
          },
          required: ['old', 'new'],
        },
        description: 'An array of targeted replacements to apply atomically.',
      },
    },
    required: ['path', 'patches'],
  },
};

export interface PatchFilePatch {
  old: string;
  new: string;
  /** Replace every match instead of failing when "old" matches more than one place. */
  replace_all?: boolean;
}

export type PatchesArgument = { patches: PatchFilePatch[] } | { error: string };

function describeJsonType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * Turns the raw `patches` argument into a list of patches, or says exactly
 * what is wrong with it.
 *
 * Models sometimes send the array as a JSON-encoded string, and a string with
 * a stray bracket used to be reported as "missing required argument", which
 * sent the model round the same call four times. A string that parses to an
 * array (or to a single patch object) is accepted; one that does not parse
 * reports the parser's own message, with the position when the engine gives
 * one.
 */
export function parsePatchesArgument(raw: unknown): PatchesArgument {
  if (raw === undefined || raw === null) {
    return { error: '[patch_file error: missing required argument "patches".]' };
  }

  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return {
        error: `[patch_file error: "patches" was sent as a string that is not valid JSON (${reason}). Send an array of {"old", "new"} objects, not a string.]`,
      };
    }
  }

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    value = [value];
  }

  if (!Array.isArray(value)) {
    return {
      error: `[patch_file error: "patches" must be an array of {"old", "new"} objects, but got ${describeJsonType(value)}.]`,
    };
  }
  if (value.length === 0) {
    return {
      error:
        '[patch_file error: "patches" is an empty array. Send at least one {"old", "new"} object.]',
    };
  }
  return { patches: value as PatchFilePatch[] };
}

export interface PatchFileToolArgs {
  path?: string;
  patches?: PatchFilePatch[];
}

export interface PatchFileToolOptions {
  output?: ToolOutputSink;
  scope?: WorkingDirectoryScope | undefined;
}

interface NormalizedText {
  text: string;
  map: number[];
}

interface MatchRange {
  start: number;
  end: number;
  mode: 'exact' | 'normalized';
}

interface PatchMatch extends MatchRange {
  index: number;
  patch: PatchFilePatch;
}

interface PreviewWindow {
  startLine: number;
  lines: string[];
  score: number;
}

function normalizeLineEndings(text: string): string {
  return text.replaceAll(/\r\n?/g, '\n');
}

/**
 * Collapses each line to its trimmed text so the two sides can be compared
 * without regard to indentation, trailing whitespace or line-ending style.
 *
 * `map[i]` is the offset in `content` of the character at UTF-16 index `i` of
 * the normalized text (one entry per UTF-16 unit, so an astral character keeps
 * the map aligned), and the final entry is `content.length`. The leading
 * whitespace that was trimmed is counted, so a character in the middle of an
 * indented line maps to where it really is.
 */
function normalizeForMatching(content: string): NormalizedText {
  let text = '';
  const map: number[] = [];
  let index = 0;

  while (index < content.length) {
    const lineStart = index;
    while (index < content.length && content[index] !== '\r' && content[index] !== '\n') {
      index += 1;
    }

    const rawLine = content.slice(lineStart, index);
    const leading = rawLine.length - rawLine.trimStart().length;
    const trimmedLine = rawLine.trim();
    // Per UTF-16 unit, not per code point: `text` is indexed by UTF-16 unit.
    for (let offset = 0; offset < trimmedLine.length; offset += 1) {
      text += trimmedLine.charAt(offset);
      map.push(lineStart + leading + offset);
    }

    if (index < content.length) {
      const newlineStart = index;
      index += content[index] === '\r' && content[index + 1] === '\n' ? 2 : 1;

      text += '\n';
      map.push(newlineStart);
    }
  }

  map.push(content.length);
  return { text, map };
}

/**
 * Maps a match found in the normalized text back to a range of the real file.
 *
 * A match that starts at the beginning of a line keeps that line's own
 * indentation when the patch's "old" text had none, so a patch written without
 * the indent does not strip it. A match that ends at the start of a line ends
 * before that line's indentation, so the next line is left untouched.
 */
function mapNormalizedRange(
  content: string,
  haystack: NormalizedText,
  oldText: string,
  start: number,
  end: number
): { start: number; end: number } | undefined {
  const mappedStart = haystack.map[start];
  const mappedEnd = haystack.map[end];
  if (mappedStart === undefined || mappedEnd === undefined) {
    return undefined;
  }

  let realStart = mappedStart;
  const startsLine = start === 0 || haystack.text[start - 1] === '\n';
  if (startsLine) {
    const lineStart = lineStartOf(content, mappedStart);
    const oldFirstLine = normalizeLineEndings(oldText).split('\n')[0] ?? '';
    const oldHasIndent = oldFirstLine.length > 0 && oldFirstLine !== oldFirstLine.trimStart();
    realStart = oldHasIndent ? lineStart : mappedStart;
  }

  let realEnd = mappedEnd;
  const endsLine = end > 0 && haystack.text[end - 1] === '\n';
  if (endsLine) {
    realEnd = lineStartOf(content, mappedEnd);
  }

  return { start: realStart, end: realEnd };
}

function lineStartOf(content: string, index: number): number {
  let cursor = index;
  while (cursor > 0 && content[cursor - 1] !== '\n' && content[cursor - 1] !== '\r') {
    cursor -= 1;
  }
  return cursor;
}

/** The line ending the file mostly uses, so inserted text matches it. */
function dominantLineEnding(content: string): '\r\n' | '\n' {
  const crlf = (content.match(/\r\n/g) ?? []).length;
  const lf = (content.match(/\n/g) ?? []).length - crlf;
  return crlf > lf ? '\r\n' : '\n';
}

function withLineEnding(text: string, eol: '\r\n' | '\n'): string {
  const unified = normalizeLineEndings(text);
  return eol === '\n' ? unified : unified.replaceAll('\n', eol);
}

function findAllOccurrences(text: string, needle: string): Array<{ start: number; end: number }> {
  const matches: Array<{ start: number; end: number }> = [];
  let searchIndex = 0;

  while (searchIndex <= text.length - needle.length) {
    const found = text.indexOf(needle, searchIndex);
    if (found === -1) {
      break;
    }

    matches.push({ start: found, end: found + needle.length });
    searchIndex = found + 1;
  }

  return matches;
}

function toPreviewLines(text: string): string[] {
  return normalizeLineEndings(text)
    .split('\n')
    .map((line) => line.trimEnd());
}

function findBestPreviewWindow(content: string, oldText: string): PreviewWindow | null {
  const fileLines = toPreviewLines(content);
  const oldLines = toPreviewLines(oldText);

  if (fileLines.length === 0) {
    return null;
  }

  const windowSize = Math.max(1, Math.min(fileLines.length, oldLines.length));
  let bestScore = -1;
  let bestStart = 0;

  for (let start = 0; start <= fileLines.length - windowSize; start += 1) {
    let score = 0;
    for (let offset = 0; offset < windowSize; offset += 1) {
      if (fileLines[start + offset] === oldLines[offset]) {
        score += 1;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestStart = start;
    }
  }

  return {
    startLine: bestStart,
    lines: fileLines.slice(bestStart, bestStart + windowSize),
    score: bestScore,
  };
}

function indexToLineNumber(text: string, index: number): number {
  let line = 1;
  for (let cursor = 0; cursor < index && cursor < text.length; cursor += 1) {
    if (text[cursor] === '\n') {
      line += 1;
    }
  }
  return line;
}

function formatRequestedPatch(patch: Partial<PatchFilePatch>): string {
  const oldText = typeof patch.old === 'string' ? patch.old : '(missing old text)';
  const newText = typeof patch.new === 'string' ? patch.new : '(missing new text)';
  const oldLines = toPreviewLines(oldText);
  const newLines = toPreviewLines(newText);
  const lines = ['requested patch:', '--- old', '+++ new', '@@'];

  for (const line of oldLines) {
    lines.push(`-${line}`);
  }
  for (const line of newLines) {
    lines.push(`+${line}`);
  }

  return lines.join('\n');
}

function formatCurrentExcerpt(content: string, patch: Partial<PatchFilePatch>): string {
  const preview = findBestPreviewWindow(content, typeof patch.old === 'string' ? patch.old : '');
  if (!preview) {
    return 'closest current excerpt: (file is empty)';
  }

  const lines = [
    `closest current excerpt (line ${preview.startLine + 1}, score ${preview.score}):`,
    '@@',
  ];
  for (const line of preview.lines) {
    lines.push(`+${line}`);
  }
  return lines.join('\n');
}

function formatPatchError(
  path: string,
  patchIndex: number,
  patchCount: number,
  reason: string,
  patch?: Partial<PatchFilePatch>,
  content?: string,
  matches?: MatchRange[]
): string {
  const lines = [
    `[patch_file error: patch ${patchIndex + 1} of ${patchCount} ${reason}]`,
    `path: ${path}`,
  ];

  if (patch) {
    lines.push(formatRequestedPatch(patch));
  }

  if (matches && matches.length > 0) {
    lines.push('possible matches:');
    for (const match of matches.slice(0, 5)) {
      lines.push(`- line ${indexToLineNumber(content ?? '', match.start)} (${match.mode})`);
    }
  } else if (patch && content !== undefined) {
    lines.push(formatCurrentExcerpt(content, patch));
  }

  if (matches && matches.length > 1) {
    lines.push(
      `The "old" text matches ${matches.length} places. Either add more surrounding lines to make it unique, or set "replace_all": true on this patch to replace all ${matches.length}.`
    );
  } else {
    lines.push(
      'The patch text did not match the current file exactly, even after normalizing line endings and trimming whitespace.',
      'Use read_file to refresh the surrounding lines and try again.'
    );
  }
  return lines.join('\n');
}

/**
 * Finds where one patch applies. One match is the normal case. Several matches
 * are an error unless the patch sets `replace_all`, in which case every match
 * is replaced (exact matches when there are any, otherwise the
 * whitespace-tolerant ones).
 */
function resolvePatchMatches(
  content: string,
  patch: PatchFilePatch
): MatchRange[] | { error: string; matches?: MatchRange[] } {
  const replaceAll = patch.replace_all === true;
  const exactMatches = findAllOccurrences(content, patch.old).map((match) => ({
    ...match,
    mode: 'exact' as const,
  }));

  if (exactMatches.length === 1 || (exactMatches.length > 1 && replaceAll)) {
    return exactMatches;
  }

  if (exactMatches.length > 1) {
    return { error: 'matched multiple locations exactly', matches: exactMatches };
  }

  const normalizedNeedle = normalizeForMatching(patch.old);
  if (normalizedNeedle.text.length === 0) {
    return { error: 'became empty after whitespace normalization' };
  }

  const normalizedHaystack = normalizeForMatching(content);
  const normalizedMatches: MatchRange[] = [];
  for (const match of findAllOccurrences(normalizedHaystack.text, normalizedNeedle.text)) {
    const range = mapNormalizedRange(
      content,
      normalizedHaystack,
      patch.old,
      match.start,
      match.end
    );
    if (range === undefined) {
      return { error: 'encountered an internal index mapping failure' };
    }

    normalizedMatches.push({ ...range, mode: 'normalized' });
  }

  if (normalizedMatches.length === 1 || (normalizedMatches.length > 1 && replaceAll)) {
    return normalizedMatches;
  }

  if (normalizedMatches.length > 1) {
    return {
      error: 'matched multiple locations after whitespace normalization',
      matches: normalizedMatches,
    };
  }

  return { error: 'was not found' };
}

function applyPatch(content: string, match: PatchMatch, eol: '\r\n' | '\n'): string {
  return (
    content.slice(0, match.start) + withLineEnding(match.patch.new, eol) + content.slice(match.end)
  );
}

export class PatchFileTool {
  private readonly output: ToolOutputSink;
  private readonly scope: WorkingDirectoryScope | undefined;

  constructor(options: PatchFileToolOptions = {}) {
    this.output = options.output ?? noopToolOutputSink;
    this.scope = options.scope;
  }

  private log(message: string): void {
    this.output.writeLine(message);
  }

  async run(args: PatchFileToolArgs, signal?: AbortSignal): Promise<string> {
    const rawPath = (args.path ?? '').trim();
    if (!rawPath) {
      const errorMsg = '[patch_file error: missing required argument "path".]';
      return errorMsg;
    }

    const absPath = resolveAgentPath(this.scope, rawPath);

    if (!Array.isArray(args.patches) || args.patches.length === 0) {
      const errorMsg = '[patch_file error: missing required argument "patches".]';
      return errorMsg;
    }
    let fileStat;
    try {
      fileStat = await stat(absPath, { signal });
    } catch (err) {
      const errorMsg = `[patch_file error: unable to access file: ${err instanceof Error ? err.message : String(err)}]`;
      return errorMsg;
    }

    if (!fileStat || !fileStat.isFile()) {
      const errorMsg = '[patch_file error: target path is not a regular file.]';
      return errorMsg;
    }

    const content = await readFile(absPath, { encoding: 'utf8', signal });
    const patchMatches: PatchMatch[] = [];

    for (const [index, patch] of args.patches.entries()) {
      if (!patch || typeof patch !== 'object') {
        const errorMsg = formatPatchError(
          absPath,
          index,
          args.patches.length,
          'must be an object with "old" and "new" strings'
        );
        return errorMsg;
      }

      if (typeof patch.old !== 'string' || patch.old.length === 0) {
        const errorMsg = formatPatchError(
          absPath,
          index,
          args.patches.length,
          'is missing the required "old" string',
          patch,
          content
        );
        return errorMsg;
      }

      if (typeof patch.new !== 'string') {
        const errorMsg = formatPatchError(
          absPath,
          index,
          args.patches.length,
          'is missing the required "new" string',
          patch,
          content
        );
        return errorMsg;
      }

      const resolved = resolvePatchMatches(content, patch);
      if ('error' in resolved) {
        const errorMsg = formatPatchError(
          absPath,
          index,
          args.patches.length,
          resolved.error,
          patch,
          content,
          resolved.matches
        );
        return errorMsg;
      }

      for (const match of resolved) {
        patchMatches.push({ index, patch, ...match });
      }
    }

    const orderedMatches = [...patchMatches].sort((left, right) => left.start - right.start);
    for (let index = 1; index < orderedMatches.length; index += 1) {
      const previous = orderedMatches[index - 1]!;
      const current = orderedMatches[index]!;
      if (current.start < previous.end) {
        const errorMsg = `[patch_file error: patch ${previous.index + 1} overlaps patch ${current.index + 1}; apply non-overlapping patches in separate calls.]`;
        this.log(errorMsg);
        return errorMsg;
      }
    }

    const eol = dominantLineEnding(content);
    let updatedContent = content;
    for (const match of [...orderedMatches].sort((left, right) => right.start - left.start)) {
      updatedContent = applyPatch(updatedContent, match, eol);
    }

    if (updatedContent !== content) {
      await writeFile(absPath, updatedContent, { encoding: 'utf8', signal });
    }

    const result = [
      'patch_file_result:',
      `path: ${absPath}`,
      'action: patch',
      `patches_applied: ${args.patches.length}`,
      `replacements_made: ${patchMatches.length}`,
      `bytes_written: ${updatedContent === content ? 0 : Buffer.byteLength(updatedContent, 'utf8')}`,
    ].join('\n');

    return result;
  }
}

export function getToolPrompt(): string {
  const s = patchFileToolSchema;
  const p = s.parameters.properties;
  return (
    `7. ${s.name}(path, patches)\n` +
    `   ${s.description}\n\n` +
    `   - path: ${p.path!.description}\n` +
    `   - patches: ${p.patches!.description}\n`
  );
}
