import { appendFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { formatToolTranscript, terminalToolOutputSink, type ToolOutputSink } from '../toolOutput.js';

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
        this.output = options.output ?? terminalToolOutputSink;
    }

    private log(message: string): void {
        this.output.writeLine(message);
    }

    async run(args: WriteFileToolArgs): Promise<string> {
        const rawPath = (args.path ?? '').trim();
        if (!rawPath) {
            const errorMsg = '[write_file error: missing required argument "path".]';
            this.log(formatToolTranscript({
                title: 'write_file error',
                tone: 'error',
                rows: [
                    { label: 'reason', value: 'missing required argument "path".' },
                ],
            }));
            return errorMsg;
        }

        if (typeof args.content !== 'string') {
            const errorMsg = '[write_file error: missing required argument "content".]';
            this.log(formatToolTranscript({
                title: 'write_file error',
                tone: 'error',
                rows: [
                    { label: 'path', value: resolve(rawPath), kind: 'path' },
                    { label: 'reason', value: 'missing required argument "content".' },
                ],
            }));
            return errorMsg;
        }

        const mode = args.mode ? args.mode.trim().toLowerCase() : 'overwrite';
        if (!isValidMode(mode)) {
            const errorMsg = '[write_file error: invalid "mode". Expected "overwrite", "append", or "create".]';
            this.log(formatToolTranscript({
                title: 'write_file error',
                tone: 'error',
                rows: [
                    { label: 'path', value: resolve(rawPath), kind: 'path' },
                    { label: 'reason', value: 'invalid "mode". Expected "overwrite", "append", or "create".' },
                ],
            }));
            return errorMsg;
        }

        const absPath = resolve(rawPath);
        const parent = dirname(absPath);
        await mkdir(parent, { recursive: true });

        let fileExists = false;
        try {
            const fileStat = await stat(absPath);
            fileExists = fileStat.isFile();
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                const errorMsg = `[write_file error: unable to access path: ${error instanceof Error ? error.message : String(error)}]`;
                this.log(formatToolTranscript({
                    title: 'write_file error',
                    tone: 'error',
                    rows: [
                        { label: 'path', value: absPath, kind: 'path' },
                        { label: 'reason', value: error instanceof Error ? error.message : String(error), kind: 'block' },
                    ],
                }));
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
                    this.log(formatToolTranscript({
                        title: 'write_file warning',
                        tone: 'warning',
                        rows: [
                            { label: 'path', value: absPath, kind: 'path' },
                            { label: 'action', value: 'create' },
                            { label: 'warning', value: 'file already exists. Use mode "overwrite" to replace it, or mode "append" to add to it.', kind: 'block' },
                        ],
                    }));
                    return warning;
                }
                await writeFile(absPath, args.content, { encoding: 'utf8', flag: 'wx' });
                const result = [
                    'write_file_result:',
                    `path: ${absPath}`,
                    'action: create',
                    `bytes_written: ${Buffer.byteLength(args.content, 'utf8')}`,
                ].join('\n');
                this.log(formatToolTranscript({
                    title: 'write_file result',
                    tone: 'success',
                    rows: [
                        { label: 'path', value: absPath, kind: 'path' },
                        { label: 'action', value: 'create' },
                        { label: 'bytes_written', value: String(Buffer.byteLength(args.content, 'utf8')) },
                    ],
                }));
                return result;
            }

            if (mode === 'overwrite') {
                await writeFile(absPath, args.content, { encoding: 'utf8' });
                const result = [
                    'write_file_result:',
                    `path: ${absPath}`,
                    'action: overwrite',
                    `bytes_written: ${Buffer.byteLength(args.content, 'utf8')}`,
                ].join('\n');
                this.log(formatToolTranscript({
                    title: 'write_file result',
                    tone: 'success',
                    rows: [
                        { label: 'path', value: absPath, kind: 'path' },
                        { label: 'action', value: 'overwrite' },
                        { label: 'bytes_written', value: String(Buffer.byteLength(args.content, 'utf8')) },
                    ],
                }));
                return result;
            }

            // mode === 'append'
            await appendFile(absPath, args.content, { encoding: 'utf8' });
            const result = [
                'write_file_result:',
                `path: ${absPath}`,
                'action: append',
                `bytes_written: ${Buffer.byteLength(args.content, 'utf8')}`,
            ].join('\n');
            this.log(formatToolTranscript({
                title: 'write_file result',
                tone: 'success',
                rows: [
                    { label: 'path', value: absPath, kind: 'path' },
                    { label: 'action', value: 'append' },
                    { label: 'bytes_written', value: String(Buffer.byteLength(args.content, 'utf8')) },
                ],
            }));
            return result;
        } catch (error) {
            const errorMsg = `[write_file error: failed to write file: ${error instanceof Error ? error.message : String(error)}]`;
            this.log(formatToolTranscript({
                title: 'write_file error',
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
    return (
        '7. write_file(path, content, mode)\n' +
        '   Write text to a local file.\n' +
        '   Use mode="overwrite" to create or replace a file,\n' +
        '   mode="append" to add to an existing file or create it if missing,\n' +
        '   and mode="create" to create a new file only if it does not already exist.\n' +
        '   For small edits to an existing file, prefer patch_file instead of rewriting the whole file.\n\n'
    );
}