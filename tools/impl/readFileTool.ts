import { readFile, stat } from 'node:fs/promises';
import { formatToolTranscript, terminalToolOutputSink, type ToolOutputSink } from '../toolOutput';
import { resolveAgentPath } from '../workingDirectory';

import type { ToolSchema } from '../../tools/tools';

export const readFileToolSchema: ToolSchema = {
    name: 'read_file',
    description: 'Reads a file from the host filesystem. Use head_chars to read the first N characters, tail_chars to read the last N characters, or start/length to read a specific character range. Supports absolute paths, relative paths (resolved against the agent working directory), and ~/ paths.',
    parameters: {
        type: 'object',
        properties: {
            path:        { type: 'string', description: 'A file path to read from, absolute or relative to the agent working directory.' },
            head_chars:  { type: 'number', description: 'Read only the first N characters of the file.' },
            tail_chars:  { type: 'number', description: 'Read only the last N characters of the file.' },
            start:       { type: 'number', description: 'Zero-based character index at which to begin reading.' },
            length:      { type: 'number', description: 'Number of characters to read starting at start.' },
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
}

export interface ReadFileToolOptions {
    output?: ToolOutputSink;
}

function isPositiveInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && Math.floor(value) === value && value >= 0;
}

export class ReadFileTool {
    private readonly output: ToolOutputSink;

    constructor(options: ReadFileToolOptions = {}) {
        this.output = options.output ?? terminalToolOutputSink;
    }

    private log(message: string): void {
        this.output.writeLine(message);
    }

    async run(args: ReadFileToolArgs): Promise<string> {
        const rawPath = (args.path ?? '').trim();
        if (!rawPath) {
            const errorMsg = '[read_file error: missing required argument "path".]';
            this.log(formatToolTranscript({
                title: 'read_file error',
                tone: 'error',
                rows: [
                    { label: 'reason', value: 'missing required argument "path".' },
                ],
            }));
            return errorMsg;
        }

        const absPath = resolveAgentPath(this.output, rawPath);
        let fileStat;
        try {
            fileStat = await stat(absPath);
        } catch (error) {
            const errorMsg = `[read_file error: unable to access file: ${error instanceof Error ? error.message : String(error)}]`;
            this.log(formatToolTranscript({
                title: 'read_file error',
                tone: 'error',
                rows: [
                    { label: 'path', value: absPath, kind: 'path' },
                    { label: 'reason', value: error instanceof Error ? error.message : String(error), kind: 'block' },
                ],
            }));
            return errorMsg;
        }

        if (!fileStat.isFile()) {
            const errorMsg = '[read_file error: target path is not a regular file.]';
            this.log(formatToolTranscript({
                title: 'read_file error',
                tone: 'error',
                rows: [
                    { label: 'path', value: absPath, kind: 'path' },
                    { label: 'reason', value: 'target path is not a regular file.' },
                ],
            }));
            return errorMsg;
        }

        const { head_chars, tail_chars, start, length } = args;
        if (head_chars !== undefined && tail_chars !== undefined) {
            const errorMsg = '[read_file error: specify only one of "head_chars" or "tail_chars".]';
            this.log(errorMsg);
            return errorMsg;
        }
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

        try {
            const fileContents = await readFile(absPath, { encoding: 'utf8' });
            let excerpt = fileContents;
            let rangeDescription = 'full file';

            if (head_chars !== undefined) {
                excerpt = fileContents.slice(0, head_chars);
                rangeDescription = `first ${head_chars} character${head_chars === 1 ? '' : 's'}`;
            } else if (tail_chars !== undefined) {
                excerpt = fileContents.slice(-tail_chars);
                rangeDescription = `last ${tail_chars} character${tail_chars === 1 ? '' : 's'}`;
            } else if (start !== undefined || length !== undefined) {
                const from = start ?? 0;
                const until = length !== undefined ? from + length : fileContents.length;
                excerpt = fileContents.slice(from, until);
                rangeDescription = `characters ${from} to ${Math.max(from, until - 1)}`;
            }

            const result = [
                'read_file_result:',
                `path: ${absPath}`,
                `range: ${rangeDescription}`,
                'contents:',
                excerpt.length > 0 ? excerpt : '(empty)',
            ].join('\n');

            this.log(formatToolTranscript({
                title: 'read_file result',
                tone: 'success',
                rows: [
                    { label: 'path', value: absPath, kind: 'path' },
                    { label: 'range', value: rangeDescription },
                    { label: 'contents', value: excerpt, kind: 'block' },
                ],
            }));
            return result;
        } catch (error) {
            const errorMsg = `[read_file error: failed to read file: ${error instanceof Error ? error.message : String(error)}]`;
            this.log(formatToolTranscript({
                title: 'read_file error',
                tone: 'error',
                rows: [
                    { label: 'path', value: absPath, kind: 'path' },
                    { label: 'reason', value: error instanceof Error ? error.message : String(error), kind: 'block' },
                ],
            }));
            return errorMsg;
        }
    }
}

export function getToolPrompt(): string {
    const s = readFileToolSchema;
    const p = s.parameters.properties;
    return (
        `6. ${s.name}(path, head_chars?, tail_chars?, start?, length?)\n` +
        `   ${s.description}\n\n` +
        `   - path: ${p.path!.description}\n` +
        `   - head_chars: ${p.head_chars!.description}\n` +
        `   - tail_chars: ${p.tail_chars!.description}\n` +
        `   - start: ${p.start!.description}\n` +
        `   - length: ${p.length!.description}\n`
    );
}