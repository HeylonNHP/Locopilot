import type { StatOptions } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';

import type { ToolSchema } from '../../tools/tools';

import { READ_FILE_TOKEN_CRITICAL_PCT, READ_FILE_TOKEN_WARN_PCT } from '../../constants';
import { countTextTokens } from '../../services/tokenizer';
import { noopToolOutputSink, type ToolOutputSink } from '../toolOutput';
import { resolveAgentPath, type WorkingDirectoryScope } from '../workingDirectory';

export const readFileToolSchema: ToolSchema = {
  name: 'read_file',
  description:
    'Reads a file from the host filesystem. Use head_chars to read the first N characters, tail_chars to read the last N characters, start/length to read a specific character range, or start_line/end_line to read by line number (1-based). Supports absolute paths, relative paths (resolved against the agent working directory), and ~/ paths.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description:
          'A file path to read from, absolute or relative to the agent working directory.',
      },
      head_chars: { type: 'number', description: 'Read only the first N characters of the file.' },
      tail_chars: { type: 'number', description: 'Read only the last N characters of the file.' },
      start: {
        type: 'number',
        description: 'Zero-based character index at which to begin reading.',
      },
      length: { type: 'number', description: 'Number of characters to read starting at start.' },
      start_line: {
        type: 'number',
        description:
          '1-based line number at which to begin reading. Use with end_line or line_count.',
      },
      end_line: {
        type: 'number',
        description:
          '1-based line number at which to end reading (inclusive). Defaults to the last line if omitted.',
      },
      line_count: {
        type: 'number',
        description:
          'Number of lines to read starting at start_line. Only valid when start_line is also provided.',
      },
    },
    required: ['path'],
  },
};

export interface ReadFileToolArgs {
  path?: string;
  head_chars?: number | undefined;
  tail_chars?: number | undefined;
  start?: number | undefined;
  length?: number | undefined;
  start_line?: number | undefined;
  end_line?: number | undefined;
  line_count?: number | undefined;
}

export interface ReadFileToolOptions {
  output?: ToolOutputSink;
  scope?: WorkingDirectoryScope | undefined;
  model?: string | undefined;
  numCtx?: number | undefined;
}

function isPositiveInteger(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isFinite(value) && Math.floor(value) === value && value >= 0
  );
}

function isStrictlyPositiveInteger(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isFinite(value) && Math.floor(value) === value && value >= 1
  );
}

export class ReadFileTool {
  private readonly output: ToolOutputSink;
  private readonly scope: WorkingDirectoryScope | undefined;
  private readonly model: string | undefined;
  private readonly numCtx: number | undefined;

  constructor(options: ReadFileToolOptions = {}) {
    this.output = options.output ?? noopToolOutputSink;
    this.scope = options.scope;
    this.model = options.model;
    this.numCtx = options.numCtx;
  }

  private log(message: string): void {
    this.output.writeLine(message);
  }

  async run(args: ReadFileToolArgs, signal?: AbortSignal): Promise<string> {
    const rawPath = (args.path ?? '').trim();
    if (!rawPath) {
      const errorMsg = '[read_file error: missing required argument "path".]';
      return errorMsg;
    }

    const absPath = resolveAgentPath(this.scope, rawPath);
    let fileStat;
    try {
      fileStat = await stat(absPath, { signal } as unknown as StatOptions);
    } catch (err) {
      const errorMsg = `[read_file error: unable to access file: ${err instanceof Error ? err.message : String(err)}]`;
      return errorMsg;
    }

    if (!fileStat || !fileStat.isFile()) {
      const errorMsg = '[read_file error: target path is not a regular file.]';
      return errorMsg;
    }

    const { head_chars, tail_chars, start, length, start_line, end_line, line_count } = args;

    // Detect which reading mode is in use and enforce mutual exclusivity.
    const isCharRange = start !== undefined || length !== undefined;
    const isHeadTail = head_chars !== undefined || tail_chars !== undefined;
    const isLineRange =
      start_line !== undefined || end_line !== undefined || line_count !== undefined;

    const activeModes = [isCharRange, isHeadTail, isLineRange].filter(Boolean).length;
    if (activeModes > 1) {
      const errorMsg =
        '[read_file error: specify only one reading mode — character range (start/length), head/tail (head_chars/tail_chars), or line range (start_line/end_line/line_count).]';
      this.log(errorMsg);
      return errorMsg;
    }

    // --- Validate character-range params ---
    if (start !== undefined && !isPositiveInteger(start)) {
      const errorMsg = '[read_file error: "start" must be a non-negative integer.]';
      this.log(errorMsg);
      return errorMsg;
    }
    if (length !== undefined && !isPositiveInteger(length)) {
      const errorMsg = '[read_file error: "length" must be a non-negative integer.]';
      this.log(errorMsg);
      return errorMsg;
    }
    if (head_chars !== undefined && !isPositiveInteger(head_chars)) {
      const errorMsg = '[read_file error: "head_chars" must be a non-negative integer.]';
      this.log(errorMsg);
      return errorMsg;
    }
    if (tail_chars !== undefined && !isPositiveInteger(tail_chars)) {
      const errorMsg = '[read_file error: "tail_chars" must be a non-negative integer.]';
      this.log(errorMsg);
      return errorMsg;
    }

    // --- Validate line-range params ---
    if (start_line !== undefined && !isStrictlyPositiveInteger(start_line)) {
      const errorMsg = '[read_file error: "start_line" must be a positive integer (1-based).]';
      this.log(errorMsg);
      return errorMsg;
    }
    if (end_line !== undefined && !isStrictlyPositiveInteger(end_line)) {
      const errorMsg = '[read_file error: "end_line" must be a positive integer (1-based).]';
      this.log(errorMsg);
      return errorMsg;
    }
    if (line_count !== undefined) {
      if (!isStrictlyPositiveInteger(line_count)) {
        const errorMsg = '[read_file error: "line_count" must be a positive integer.]';
        this.log(errorMsg);
        return errorMsg;
      }
      if (start_line === undefined) {
        const errorMsg =
          '[read_file error: "line_count" requires "start_line" to also be provided.]';
        this.log(errorMsg);
        return errorMsg;
      }
    }

    // Prevent reading past the end of the file without a bound.
    const effectiveEndLine =
      end_line ??
      (start_line !== undefined && line_count !== undefined
        ? start_line + line_count - 1
        : undefined);
    if (
      start_line !== undefined &&
      effectiveEndLine !== undefined &&
      effectiveEndLine < start_line
    ) {
      const errorMsg = '[read_file error: "end_line" must be >= "start_line".]';
      this.log(errorMsg);
      return errorMsg;
    }

    try {
      const fileContents = await readFile(absPath, { encoding: 'utf8', signal });
      let excerpt = fileContents;
      let rangeDescription = 'full file';

      if (isLineRange) {
        const lines = fileContents.split('\n');
        const startIdx = (start_line ?? 1) - 1; // 1-based → 0-based
        const endIdx =
          effectiveEndLine === undefined ? lines.length : Math.min(effectiveEndLine, lines.length);

        if (startIdx >= lines.length) {
          const errorMsg = `[read_file error: "start_line" ${start_line} exceeds file line count (${lines.length}).]`;
          this.log(errorMsg);
          return errorMsg;
        }

        excerpt = lines.slice(startIdx, endIdx).join('\n');
        rangeDescription = `lines ${startIdx + 1} to ${endIdx}`;
      } else if (head_chars !== undefined) {
        excerpt = fileContents.slice(0, head_chars);
        rangeDescription = `first ${head_chars} character${head_chars === 1 ? '' : 's'}`;
      } else if (tail_chars !== undefined) {
        excerpt = fileContents.slice(-tail_chars);
        rangeDescription = `last ${tail_chars} character${tail_chars === 1 ? '' : 's'}`;
      } else if (start !== undefined || length !== undefined) {
        const from = start ?? 0;
        const until = length === undefined ? fileContents.length : from + length;
        excerpt = fileContents.slice(from, until);
        rangeDescription = `characters ${from} to ${Math.max(from, until - 1)}`;
      }

      // --- Token-aware warning ---
      let tokenWarning = '';
      if (this.model && this.numCtx && excerpt.length > 0) {
        let tokenEstimate: number;
        try {
          tokenEstimate = countTextTokens(excerpt, this.model);
        } catch {
          // If tiktoken fails (e.g. unknown model), skip the warning.
          tokenEstimate = 0;
        }

        if (tokenEstimate > 0) {
          const pct = (tokenEstimate / this.numCtx) * 100;

          if (pct >= READ_FILE_TOKEN_CRITICAL_PCT) {
            tokenWarning =
              `\n\u{1F6A8}  Token Warning: This file excerpt is approximately ${tokenEstimate.toLocaleString()} tokens (~${pct.toFixed(2)}% of your ${this.numCtx.toLocaleString()}-token context window).\n` +
              `\u26A0\uFE0F  Reading this entire file into context is strongly discouraged. Use sub-agents to analyze it instead.\n` +
              `\u{1F4A1}  Sub-agents have isolated context and won't consume your working memory — send them the file path and ask them to answer your question.\n`;
          } else if (pct >= READ_FILE_TOKEN_WARN_PCT) {
            tokenWarning =
              `\n\u26A0\uFE0F  Token Notice: This file excerpt is approximately ${tokenEstimate.toLocaleString()} tokens (~${pct.toFixed(2)}% of your ${this.numCtx.toLocaleString()}-token context window).\n` +
              `\u{1F4A1}  Consider using sub-agents to process large files — they have isolated context and won't consume your working memory.\n`;
          }
        }
      }

      const result = [
        tokenWarning,
        'read_file_result:',
        `path: ${absPath}`,
        `range: ${rangeDescription}`,
        'contents:',
        excerpt.length > 0 ? excerpt : '(empty)',
      ]
        .filter(Boolean)
        .join('\n');

      return result;
    } catch (err) {
      const errorMsg = `[read_file error: failed to read file: ${err instanceof Error ? err.message : String(err)}]`;
      return errorMsg;
    }
  }
}

export function getToolPrompt(): string {
  const s = readFileToolSchema;
  const p = s.parameters.properties;
  return (
    `6. ${s.name}(path, head_chars?, tail_chars?, start?, length?, start_line?, end_line?, line_count?)\n` +
    `   ${s.description}\n\n` +
    `   - path: ${p.path!.description}\n` +
    `   - head_chars: ${p.head_chars!.description}\n` +
    `   - tail_chars: ${p.tail_chars!.description}\n` +
    `   - start: ${p.start!.description}\n` +
    `   - length: ${p.length!.description}\n` +
    `   - start_line: ${p.start_line!.description}\n` +
    `   - end_line: ${p.end_line!.description}\n` +
    `   - line_count: ${p.line_count!.description}\n`
  );
}
