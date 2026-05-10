import { appendFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { StatOptions } from 'node:fs';
import { noopToolOutputSink, type ToolOutputSink } from '../toolOutput';
import { resolveAgentPath } from '../workingDirectory';

import type { ToolSchema } from '../../tools/tools';

export const writeFileToolSchema: ToolSchema = {
    name: 'write_file',
    description: 'Writes text to a file on the host filesystem. Supports overwrite, append, and create-only semantics. If a target file already exists and overwrite is requested, the tool will replace it immediately. Use mode to control behavior: overwrite (create or replace), append (add to existing or create), or create (only if missing).',
    parameters: {
        type: 'object',
        properties: {
            path:  { type: 'string', description: 'A file path to write to, absolute or relative to the agent working directory.' },
            content:{ type: 'string', description: 'The text content to write into the file.' },
            mode:  { type: 'string', description: 'The write mode: overwrite (create or replace), append (add to existing or create), or create (only if the file does not already exist).' },
        },
        required: ['path', 'content'],
    },
};

export interface WriteFileToolArgs {
    path?: string;
    content?: string;
    mode?: 'overwrite' | 'append' | 'create' | undefined;
}

export interface WriteFileToolOptions {
    output?: ToolOutputSink;
}

function isValidMode(value: unknown): value is 'overwrite' | 'append' | 'create' {
    return value === 'overwrite' || value === 'append' || value === 'create';
}

export class WriteFileTool {
    private readonly output: ToolOutputSink;

    constructor(options: WriteFileToolOptions = {}) {
        this.output = options.output ?? noopToolOutputSink;
    }

    private log(message: string): void {
        this.output.writeLine(message);
    }

    async run(args: WriteFileToolArgs, signal?: AbortSignal): Promise<string> {
        const rawPath = (args.path ?? '').trim();
        if (!rawPath) {
            const errorMsg = '[write_file error: missing required argument "path".]';
            return errorMsg;
        }

        const absPath = resolveAgentPath(this.output, rawPath);

        if (typeof args.content !== 'string') {
            const errorMsg = '[write_file error: missing required argument "content".]';
            return errorMsg;
        }

        const mode = args.mode ? args.mode.trim().toLowerCase() : 'overwrite';
        if (!isValidMode(mode)) {
            const errorMsg = '[write_file error: invalid "mode". Expected "overwrite", "append", or "create".]';
            return errorMsg;
        }
        const parent = dirname(absPath);
        await mkdir(parent, { recursive: true, signal } as unknown as Parameters<typeof mkdir>[1]);

        let fileExists = false;
        try {
            const fileStat = await stat(absPath, { signal } as unknown as Parameters<typeof stat>[1]);
            fileExists = fileStat.isFile();
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                const errorMsg = `[write_file error: unable to access path: ${error instanceof Error ? error.message : String(error)}]`;
                return errorMsg;
            }
        }

        try {
            if (mode === 'create') {
                if (fileExists) {
                    const warning = [
                        'write_file_warning:',
                        `path: ${absPath}`,
                        'action: create',
                        'warning: file already exists. Use mode "overwrite" to replace it, or mode "append" to add to it.',
                    ].join('\n');
                    return warning;
                }
                await writeFile(absPath, args.content, { encoding: 'utf8', flag: 'wx', signal } as any);
                const result = [
                    'write_file_result:',
                    `path: ${absPath}`,
                    'action: create',
                    `bytes_written: ${Buffer.byteLength(args.content, 'utf8')}`,
                ].join('\n');
                return result;
            }

            if (mode === 'overwrite') {
                await writeFile(absPath, args.content, { encoding: 'utf8', signal } as any);
                const result = [
                    'write_file_result:',
                    `path: ${absPath}`,
                    'action: overwrite',
                    `bytes_written: ${Buffer.byteLength(args.content, 'utf8')}`,
                ].join('\n');
                return result;
            }

            // mode === 'append'
            await appendFile(absPath, args.content, { encoding: 'utf8', signal } as any);
            const result = [
                'write_file_result:',
                `path: ${absPath}`,
                'action: append',
                `bytes_written: ${Buffer.byteLength(args.content, 'utf8')}`,
            ].join('\n');
            return result;
        } catch (error) {
            const errorMsg = `[write_file error: failed to write file: ${error instanceof Error ? error.message : String(error)}]`;
            return errorMsg;
        }
    }
}

export function getToolPrompt(): string {
    const s = writeFileToolSchema;
    const p = s.parameters.properties;
    return (
        `8. ${s.name}(path, content, mode?)\n` +
        `   ${s.description}\n\n` +
        `   - path: ${p.path!.description}\n` +
        `   - content: ${p.content!.description}\n` +
        `   - mode: ${p.mode!.description}\n`
    );
}