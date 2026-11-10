/**
 * fileTouchRecorder.ts
 *
 * Remembers which files a session read or wrote, so a stub of them can be
 * re-injected into the prompt after a compaction.
 *
 * WHY this exists: after a conversation is compacted the model loses track of
 * the files it was working on and re-reads them from scratch, costing a full
 * round of tool calls and their tokens. The information is already there —
 * every `read_file` / `patch_file` / `write_file` call names its target — but
 * it lived only inside the `tool_calls` JSON of the messages, and a
 * compaction REPLACES every message row of the session. So the touch is
 * recorded here, at the single dispatch point (`handleToolCall`), into the
 * separate `session_recent_files` table that no compaction touches.
 *
 * The hook is deliberately narrow:
 *
 *   - only the three tools that operate on a text file by `path`
 *     (`read_pdf` is binary, `run_command`'s `cwd` is a directory,
 *     `fetch_image`'s `source` may be a URL, `create_skill` writes a skill);
 *   - only on SUCCESS — these tools report failure as TEXT, not by throwing,
 *     so the result content is inspected for the error prefixes they emit;
 *   - only when there is a session id (sub-agents have none, and they call
 *     `command.execute` directly, bypassing this hook on purpose).
 *
 * Paths are stored ABSOLUTE. The agent working directory is detected from the
 * shell prompt and can drift in the middle of a session, so a relative key
 * would later resolve to a different file.
 */

import path from 'node:path';

import { debugLog } from '@/app/lib/debugLogger';
import { recordTouchedFile } from '@/services/history';

import type { RequestContext, ToolCallArguments, ToolCallResult } from './toolRegistry';

import { resolveAgentPath } from './workingDirectory';

/**
 * The tools whose `args.path` names a text file worth remembering.
 * See the module doc for why the other path-ish tools are excluded.
 */
const FILE_TOUCHING_TOOLS: ReadonlySet<string> = new Set(['read_file', 'patch_file', 'write_file']);

/**
 * Matches the two failure shapes the file tools produce:
 *   `[Error: missing required argument "path"]`  — the registry's validation
 *   `[read_file error: …]`, `[write_file error: …]`, `[patch_file error: …]`
 *
 * Every one of those tools returns its failure AS the result content instead
 * of throwing, so a successful-looking return is not evidence of success.
 */
const FAILED_RESULT = /^\[(?:Error:|\w+ error:)/u;

/**
 * Returns true when a tool result is a reported failure rather than work.
 *
 * Exported so the predicate can be tested without a database: it is the only
 * thing standing between a failed tool call and a phantom "recent file".
 */
export function isFailedToolResult(content: string): boolean {
  return FAILED_RESULT.test(content.trimStart());
}

/**
 * Records the file that `name` just touched, if it touched one.
 *
 * Called by `handleToolCall` (the MAIN route's single dispatch point) after a
 * tool returns. Sub-agents bypass `handleToolCall`, so their file reads are
 * not recorded — they have no session of their own to record against.
 *
 * Never throws: recording is a convenience for a later turn, and a failure
 * here must never turn a successful tool call into a failed one.
 *
 * @param name    – Tool name as the model called it.
 * @param args    – The tool arguments (`path` is the interesting field).
 * @param result  – The tool result, inspected for a failure prefix.
 * @param context – Request context carrying `sessionId` and the working-directory scope.
 */
export function recordToolFileTouch(
  name: string,
  args: ToolCallArguments,
  result: ToolCallResult,
  context?: RequestContext
): void {
  try {
    if (!FILE_TOUCHING_TOOLS.has(name)) return;

    const sessionId = context?.sessionId;
    if (typeof sessionId !== 'number' || !Number.isInteger(sessionId)) return;

    const rawPath = typeof args.path === 'string' ? args.path.trim() : '';
    if (rawPath === '') return;

    // A failure is text: skip it, or the model would be told the file it
    // failed to read is one of the files it has been working on.
    if (isFailedToolResult(typeof result?.content === 'string' ? result.content : '')) return;

    const absolutePath = path.resolve(resolveAgentPath(context?.workingDirectoryScope, rawPath));
    recordTouchedFile(sessionId, absolutePath, name);
  } catch (err) {
    // Belt and braces: `recordTouchedFile` already swallows its own errors,
    // but a path resolution failure must not escape into the tool result.
    try {
      debugLog.debug('recent-files-hook-failed', {
        tool: name,
        error: err instanceof Error ? err.message : String(err),
      });
    } catch {
      // The logger itself is best-effort.
    }
  }
}
