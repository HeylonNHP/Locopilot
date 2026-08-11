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

// Ensure logs directory exists (server-side only).
// If the directory cannot be created, fall back to a silent logger
// so the server does not crash on startup.
const logDir = path.join(process.cwd(), 'logs');
try {
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }
} catch (err) {
  console.error(
    `[debugLogger] Warning: could not create logs directory at ${logDir}:`,
    err instanceof Error ? err.message : String(err)
  );
  console.error('[debugLogger] Debug logging will be disabled for this session.');
}

let pinoLogger: pino.Logger;
try {
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
  | 'abort'
  | 'error'
  | 'cleanup';

export interface DiagnosticTraceEntry {
  layer: 'route' | 'subagent' | 'adapter';
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
    pinoLogger.debug(
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
    pinoLogger.debug(
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
    pinoLogger.debug(
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
    pinoLogger.debug(data ?? {}, `[trace] ${label}`);
  },
};
