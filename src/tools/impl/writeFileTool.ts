import { appendFile, mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { ToolSchema } from '@/tools/tools';

import { resolveAgentPath, type WorkingDirectoryScope } from '../workingDirectory';

export const writeFileToolSchema: ToolSchema = {
  name: 'write_file',
  description:
    'Writes text to a file on the host filesystem. Supports overwrite, append, and create-only semantics. If a target file already exists and overwrite is requested, the tool will replace it immediately. Use mode to control behavior: overwrite (create or replace), append (add to existing or create), or create (only if missing).',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description:
          'A file path to write to, absolute or relative to the agent working directory.',
      },
      content: { type: 'string', description: 'The text content to write into the file.' },
      mode: {
        type: 'string',
        description:
          'The write mode: overwrite (create or replace), append (add to existing or create), or create (only if the file does not already exist).',
      },
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
  scope?: WorkingDirectoryScope | undefined;
}

function isValidMode(value: unknown): value is 'overwrite' | 'append' | 'create' {
  return value === 'overwrite' || value === 'append' || value === 'create';
}

function formatWriteResult(absPath: string, action: string, content: string): string {
  return [
    'write_file_result:',
    `path: ${absPath}`,
    `action: ${action}`,
    `bytes_written: ${Buffer.byteLength(content, 'utf8')}`,
  ].join('\n');
}

export class WriteFileTool {
  private readonly scope: WorkingDirectoryScope | undefined;

  constructor(options: WriteFileToolOptions = {}) {
    this.scope = options.scope;
  }
  async run(args: WriteFileToolArgs, signal?: AbortSignal): Promise<string> {
    const rawPath = (args.path ?? '').trim();
    if (!rawPath) {
      return '[write_file error: missing required argument "path".]';
    }

    const absPath = resolveAgentPath(this.scope, rawPath);

    if (typeof args.content !== 'string') {
      return '[write_file error: missing required argument "content".]';
    }

    const mode = args.mode ? args.mode.trim().toLowerCase() : 'overwrite';
    if (!isValidMode(mode)) {
      return '[write_file error: invalid "mode". Expected "overwrite", "append", or "create".]';
    }
    const parent = path.dirname(absPath);
    await mkdir(parent, { recursive: true, signal });

    let fileExists = false;
    try {
      const fileStat = await stat(absPath, { signal });
      fileExists = fileStat ? fileStat.isFile() : false;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        return `[write_file error: unable to access path: ${err instanceof Error ? err.message : String(err)}]`;
      }
    }

    try {
      if (mode === 'create') {
        if (fileExists) {
          return [
            'write_file_warning:',
            `path: ${absPath}`,
            'action: create',
            'warning: file already exists. Use mode "overwrite" to replace it, or mode "append" to add to it.',
          ].join('\n');
        }
        await writeFile(absPath, args.content, { encoding: 'utf8', flag: 'wx', signal });
        return formatWriteResult(absPath, 'create', args.content);
      }

      if (mode === 'overwrite') {
        await writeFile(absPath, args.content, { encoding: 'utf8', signal });
        return formatWriteResult(absPath, 'overwrite', args.content);
      }

      // mode === 'append'
      // `appendFile`'s options type in @types/node doesn't include `Abortable`,
      // so we assign to a variable first — TypeScript skips excess-property
      // checks on non-literals, while the runtime still receives `signal`.
      const appendOpts = { encoding: 'utf8' as const, signal };
      await appendFile(absPath, args.content, appendOpts);

      return formatWriteResult(absPath, 'append', args.content);
    } catch (err) {
      return `[write_file error: failed to write file: ${err instanceof Error ? err.message : String(err)}]`;
    }
  }
}

export function getToolPrompt(): string {
  return (
    `8. ${writeFileToolSchema.name}(path, content, mode?)\n` +
    `   ${writeFileToolSchema.description}\n\n` +
    `   - path: ${writeFileToolSchema.parameters.properties.path!.description}\n` +
    `   - content: ${writeFileToolSchema.parameters.properties.content!.description}\n` +
    `   - mode: ${writeFileToolSchema.parameters.properties.mode!.description}\n`
  );
}
