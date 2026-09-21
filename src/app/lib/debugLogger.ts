/**
 * Debug logger for tracing OpenAI 400 root cause.
 * Writes structured JSON lines to ./logs/locopilot-debug.log via Pino.
 *
 * Usage:
 *   import { debugLog } from '@/app/lib/debugLogger';
 *   debugLog.toolMessage({ layer: 'adapter', action: 'convert', messageIndex: 8, ... });
 *
 * Query with jq:
 *   jq 'select(.tool_call_id == null or .tool_call_id == "")' logs/locopilot-debug.log
 *   jq 'select(.action == "convert")' logs/locopilot-debug.log
 *   jq 'select(.hasToolCallId == false and .role == "tool")' logs/locopilot-debug.log
 */

import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';

const logDir = path.join(process.cwd(), 'logs');

let pinoLogger: pino.Logger | undefined;

/**
 * Lazily create the pino logger on first use.
 *
 * Why lazy rather than at module load: `pino.destination(...)` opens a
 * SonicBoom and registers a process-exit flush hook. A process that merely
 * *imports* this module — for example a standalone `scripts/test-*.mjs` that
 * pulls in `configLoader` (which now reaches `clientManager`) — would then
 * print a spurious `sonic boom is not ready yet` stack trace the moment it
 * calls `process.exit()` before the async destination is ready. Deferring
 * creation until the first log call removes that noise for every importer
 * that never logs, with no change to the file, format, or behaviour for
 * importers that do.
 *
 * The logs directory is created here too (idempotently) so it always exists
 * before the first write. If anything fails, fall back to a silent logger so
 * the server never crashes on startup.
 */
function getLogger(): pino.Logger {
  if (pinoLogger !== undefined) return pinoLogger;
  try {
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    pinoLogger = pino(
      {
        level: 'debug',
        timestamp: pino.stdTimeFunctions.isoTime,
      },
      pino.destination(path.join(logDir, 'locopilot-debug.log'))
    );
  } catch (err) {
    console.error(
      '[debugLogger] Warning: could not initialise pino logger:',
      err instanceof Error ? err.message : String(err)
    );
    console.error('[debugLogger] Debug logging will be disabled for this session.');
    pinoLogger = pino({ level: 'silent' });
  }
  return pinoLogger;
}

export interface ToolTraceEntry {
  /** Which layer produced this log entry */
  layer: 'frontend' | 'route' | 'adapter' | 'history' | 'chatSession';
  /** What happened at this boundary */
  action:
    | 'push'
    | 'convert'
    | 'persist'
    | 'load'
    | 'merge'
    | 'normalize'
    | 'synthesize'
    | 'send'
    | 'receive'
    | 'filter';
  /** Message index in the working array (if applicable) */
  messageIndex?: number;
  /** Message role */
  role?: string;
  /** Whether the message has a non-empty tool_call_id */
  hasToolCallId?: boolean;
  /** The actual tool_call_id value (or null/undefined) */
  tool_call_id?: string | null;
  /** How many tool_calls the preceding assistant has (if applicable) */
  precedingAssistantToolCalls?: number;
  /** Short content preview for identification */
  contentPreview?: string;
  /** Session ID (if known) */
  sessionId?: number;
  /** Request/turn ID for correlation */
  requestId?: string;
  /** Any extra context */
  [key: string]: unknown;
}

export type DiagnosticPhase =
  | 'request_start'
  | 'model_request_start'
  | 'model_wait'
  | 'model_first_chunk'
  | 'model_complete'
  | 'approval_wait_start'
  | 'approval_decision'
  | 'nested_tool_start'
  | 'nested_tool_end'
  | 'compaction_start'
  | 'compaction_end'
  | 'empty_response_recovery'
  | 'context_limit_recovery'
  | 'abort'
  | 'error'
  | 'model_switched'
  | 'cleanup'
  | 'oauth_discovery'
  | 'oauth_redirect'
  | 'oauth_callback'
  | 'oauth_token_exchange'
  | 'oauth_error';

export interface DiagnosticTraceEntry {
  layer: 'route' | 'subagent' | 'adapter' | 'mcp';
  phase: DiagnosticPhase;
  requestId?: string | undefined;
  sessionId?: number | undefined;
  agentId?: string | undefined;
  tool?: string | undefined;
  toolCallId?: string | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  baseUrl?: string | undefined;
  elapsedMs?: number | undefined;
  sinceLastChunkMs?: number | undefined;
  waitMs?: number | undefined;
  attempt?: number | undefined;
  chunkCount?: number | undefined;
  messageCount?: number | undefined;
  toolCallCount?: number | undefined;
  thinkingChars?: number | undefined;
  contentChars?: number | undefined;
  result?: string | undefined;
  error?: unknown;
  [key: string]: unknown;
}

/** Return only a provider origin, never a path, query, or fragment. */
export function redactDiagnosticEndpoint(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value).origin;
  } catch {
    return '[invalid-endpoint]';
  }
}

function errorMetadata(error: unknown): Record<string, unknown> {
  if (!error || typeof error !== 'object') {
    return { errorType: typeof error };
  }

  const candidate = error as {
    name?: unknown;
    code?: unknown;
    status?: unknown;
  };
  return {
    ...(typeof candidate.name === 'string' ? { errorName: candidate.name } : {}),
    ...(typeof candidate.code === 'string' ? { errorCode: candidate.code } : {}),
    ...(typeof candidate.status === 'number' ? { errorStatus: candidate.status } : {}),
  };
}

function truncate(s: string | undefined, max = 80): string {
  if (!s) return '';
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export const debugLog = {
  /** Log a tool-message-related trace entry */
  toolMessage(entry: ToolTraceEntry) {
    const { contentPreview, ...rest } = entry;
    getLogger().debug(
      {
        ...rest,
        contentPreview: truncate(contentPreview, 120),
      },
      `[trace] layer=${entry.layer} action=${entry.action} role=${entry.role ?? 'n/a'}`
    );
  },

  /** Log a summary of the full message array at a boundary */
  messageArraySummary(
    label: string,
    messages: Array<{ role?: string; tool_call_id?: string; tool_calls?: unknown[] }>,
    context?: { sessionId?: number; requestId?: string }
  ) {
    const summary = messages.map((m, i) => ({
      i,
      role: m.role,
      hasToolCallId: !!m.tool_call_id,
      tool_call_id: m.tool_call_id ?? null,
      toolCallCount: m.tool_calls?.length ?? 0,
    }));
    getLogger().debug(
      {
        label,
        sessionId: context?.sessionId,
        requestId: context?.requestId,
        messageCount: messages.length,
        messages: summary,
      },
      `[trace] ${label}: ${messages.length} messages`
    );
  },

  /** Log a privacy-safe lifecycle breadcrumb for stalled requests. */
  diagnostic(entry: DiagnosticTraceEntry) {
    const { baseUrl, error, ...rest } = entry;
    getLogger().debug(
      {
        ...rest,
        ...(baseUrl ? { baseUrlOrigin: redactDiagnosticEndpoint(baseUrl) } : {}),
        ...(error ? errorMetadata(error) : {}),
      },
      `[diagnostic] layer=${entry.layer} phase=${entry.phase}`
    );
  },

  /** Generic debug log for ad-hoc tracing */
  debug(label: string, data?: Record<string, unknown>) {
    getLogger().debug(data ?? {}, `[trace] ${label}`);
  },
};
