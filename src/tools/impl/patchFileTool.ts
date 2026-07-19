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

function normalizeForMatching(content: string): NormalizedText {
  let text = '';
  const map: number[] = [];
  let index = 0;

  while (index < content.length) {
    const lineStart = index;
    while (index < content.length && content[index] !== '\r' && content[index] !== '\n') {
      index += 1;
    }

    const trimmedLine = content.slice(lineStart, index).trim();
    let offset = 0;
    for (const char of trimmedLine) {
      text += char;
      map.push(lineStart + offset);
      offset += 1;
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

  lines.push(
    'The patch text did not match the current file exactly, even after normalizing line endings and trimming whitespace.',
    'Use read_file to refresh the surrounding lines and try again.'
  );
  return lines.join('\n');
}

function resolvePatchMatch(
  content: string,
  patch: PatchFilePatch
): MatchRange | { error: string; matches?: MatchRange[] } {
  const exactMatches = findAllOccurrences(content, patch.old).map((match) => ({
    ...match,
    mode: 'exact' as const,
  }));

  if (exactMatches.length === 1) {
    const [exactMatch] = exactMatches;
    if (exactMatch !== undefined) {
      return exactMatch;
    }
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
    const start = normalizedHaystack.map[match.start];
    const end = normalizedHaystack.map[match.end];
    if (start === undefined || end === undefined) {
      return { error: 'encountered an internal index mapping failure' };
    }

    normalizedMatches.push({
      start,
      end,
      mode: 'normalized',
    });
  }

  if (normalizedMatches.length === 1) {
    const [normalizedMatch] = normalizedMatches;
    if (normalizedMatch !== undefined) {
      return normalizedMatch;
    }
  }

  if (normalizedMatches.length > 1) {
    return {
      error: 'matched multiple locations after whitespace normalization',
      matches: normalizedMatches,
    };
  }

  return { error: 'was not found' };
}

function applyPatch(content: string, match: PatchMatch): string {
  return content.slice(0, match.start) + match.patch.new + content.slice(match.end);
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

      const resolved = resolvePatchMatch(content, patch);
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

      patchMatches.push({
        index,
        patch,
        ...resolved,
      });
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

    let updatedContent = content;
    for (const match of [...orderedMatches].sort((left, right) => right.start - left.start)) {
      updatedContent = applyPatch(updatedContent, match);
    }

    if (updatedContent !== content) {
      await writeFile(absPath, updatedContent, { encoding: 'utf8', signal });
    }

    const result = [
      'patch_file_result:',
      `path: ${absPath}`,
      'action: patch',
      `patches_applied: ${patchMatches.length}`,
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
