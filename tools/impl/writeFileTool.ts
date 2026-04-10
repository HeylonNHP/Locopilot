import { appendFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export interface WriteFileToolArgs {
    path?: string;
    content?: string;
    mode?: 'overwrite' | 'append' | 'create' | undefined;
    confirm_overwrite?: boolean | undefined;
}

function isValidMode(value: unknown): value is 'overwrite' | 'append' | 'create' {
    return value === 'overwrite' || value === 'append' || value === 'create';
}

export class WriteFileTool {
    async run(args: WriteFileToolArgs): Promise<string> {
        const rawPath = (args.path ?? '').trim();
        if (!rawPath) {
            return '[write_file error: missing required argument "path".]';
        }

        if (typeof args.content !== 'string') {
            return '[write_file error: missing required argument "content".]';
        }

        const mode = args.mode ? args.mode.trim().toLowerCase() : 'overwrite';
        if (!isValidMode(mode)) {
            return '[write_file error: invalid "mode". Expected "overwrite", "append", or "create".]';
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
                return `[write_file error: unable to access path: ${error instanceof Error ? error.message : String(error)}]`;
            }
        }

        try {
            if (mode === 'create') {
                if (fileExists) {
                    return [
                        'write_file_warning:',
                        `path: ${absPath}`,
                        'action: create',
                        'warning: file already exists. Use mode "overwrite" with confirm_overwrite: true to replace it, or mode "append" to add to it.',
                    ].join('\n');
                }
                await writeFile(absPath, args.content, { encoding: 'utf8', flag: 'wx' });
                return [
                    'write_file_result:',
                    `path: ${absPath}`,
                    'action: create',
                    `bytes_written: ${Buffer.byteLength(args.content, 'utf8')}`,
                ].join('\n');
            }

            if (mode === 'overwrite') {
                if (fileExists && !args.confirm_overwrite) {
                    return [
                        'write_file_warning:',
                        `path: ${absPath}`,
                        'action: overwrite',
                        'warning: file already exists and will be overwritten. To proceed, call write_file again with confirm_overwrite: true.',
                        'To preserve the existing file, use mode "append" or choose a different path.',
                    ].join('\n');
                }
                await writeFile(absPath, args.content, { encoding: 'utf8' });
                return [
                    'write_file_result:',
                    `path: ${absPath}`,
                    'action: overwrite',
                    `bytes_written: ${Buffer.byteLength(args.content, 'utf8')}`,
                ].join('\n');
            }

            // mode === 'append'
            await appendFile(absPath, args.content, { encoding: 'utf8' });
            return [
                'write_file_result:',
                `path: ${absPath}`,
                'action: append',
                `bytes_written: ${Buffer.byteLength(args.content, 'utf8')}`,
            ].join('\n');
        } catch (error) {
            return `[write_file error: failed to write file: ${error instanceof Error ? error.message : String(error)}]`;
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
