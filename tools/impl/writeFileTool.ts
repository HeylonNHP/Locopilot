import { appendFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { terminalToolOutputSink, type ToolOutputSink } from '../toolOutput.js';

export interface WriteFileToolArgs {
    path?: string;
    content?: string;
    mode?: 'overwrite' | 'append' | 'create' | undefined;
    confirm_overwrite?: boolean | undefined;
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
        this.output.writeLine(`[WriteFileTool] ${message}`);
    }

    async run(args: WriteFileToolArgs): Promise<string> {
        const rawPath = (args.path ?? '').trim();
        if (!rawPath) {
            const errorMsg = '[write_file error: missing required argument "path".]';
            this.log(errorMsg);
            return errorMsg;
        }

        if (typeof args.content !== 'string') {
            const errorMsg = '[write_file error: missing required argument "content".]';
            this.log(errorMsg);
            return errorMsg;
        }

        const mode = args.mode ? args.mode.trim().toLowerCase() : 'overwrite';
        if (!isValidMode(mode)) {
            const errorMsg = '[write_file error: invalid "mode". Expected "overwrite", "append", or "create".]';
            this.log(errorMsg);
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
                this.log(errorMsg);
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
                        'warning: file already exists. Use mode "overwrite" with confirm_overwrite: true to replace it, or mode "append" to add to it.',
                    ].join('\n');
                    this.log(warning);
                    return warning;
                }
                await writeFile(absPath, args.content, { encoding: 'utf8', flag: 'wx' });
                const result = [
                    'write_file_result:',
                    `path: ${absPath}`,
                    'action: create',
                    `bytes_written: ${Buffer.byteLength(args.content, 'utf8')}`,
                ].join('\n');
                this.log(result);
                return result;
            }

            if (mode === 'overwrite') {
                if (fileExists && !args.confirm_overwrite) {
                    const warning = [
                        'write_file_warning:',
                        `path: ${absPath}`,
                        'action: overwrite',
                        'warning: file already exists and will be overwritten. To proceed, call write_file again with confirm_overwrite: true.',
                        'To preserve the existing file, use mode "append" or choose a different path.',
                    ].join('\n');
                    this.log(warning);
                    return warning;
                }
                await writeFile(absPath, args.content, { encoding: 'utf8' });
                const result = [
                    'write_file_result:',
                    `path: ${absPath}`,
                    'action: overwrite',
                    `bytes_written: ${Buffer.byteLength(args.content, 'utf8')}`,
                ].join('\n');
                this.log(result);
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
            this.log(result);
            return result;
        } catch (error) {
            const errorMsg = `[write_file error: failed to write file: ${error instanceof Error ? error.message : String(error)}]`;
            this.log(errorMsg);
            return errorMsg;
        }
    }
}

export function getToolPrompt(): string {
    return (
        '6. write_file(path, content, mode, confirm_overwrite)\n' +
        '   Write text to a local file.\n' +
        '   Use mode="overwrite" to replace an existing file (requires confirm_overwrite: true if the file already exists),\n' +
        '   mode="append" to add to an existing file or create it if missing,\n' +
        '   and mode="create" to create a new file only if it does not already exist.\n\n'
    );
}