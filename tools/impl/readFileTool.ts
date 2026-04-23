import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { terminalToolOutputSink, type ToolOutputSink } from '../toolOutput.js';

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
        this.output.writeLine(`[ReadFileTool] ${message}`);
    }

    async run(args: ReadFileToolArgs): Promise<string> {
        const rawPath = (args.path ?? '').trim();
        if (!rawPath) {
            const errorMsg = '[read_file error: missing required argument "path".]';
            this.log(errorMsg);
            return errorMsg;
        }

        const absPath = resolve(rawPath);
        let fileStat;
        try {
            fileStat = await stat(absPath);
        } catch (error) {
            const errorMsg = `[read_file error: unable to access file: ${error instanceof Error ? error.message : String(error)}]`;
            this.log(errorMsg);
            return errorMsg;
        }

        if (!fileStat.isFile()) {
            const errorMsg = '[read_file error: target path is not a regular file.]';
            this.log(errorMsg);
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

            this.log(`Result for path ${absPath}:\n${result}`);
            return result;
        } catch (error) {
            const errorMsg = `[read_file error: failed to read file: ${error instanceof Error ? error.message : String(error)}]`;
            this.log(errorMsg);
            return errorMsg;
        }
    }
}

export function getToolPrompt(): string {
    return (
        '5. read_file(path, head_chars, tail_chars, start, length)\n' +
        '   Read a local file from the host machine.\n' +
        '   Use head_chars to read only the first N characters, tail_chars to read only the last N characters,\n' +
        '   or start/length to read a specific character range.\n\n'
    );
}