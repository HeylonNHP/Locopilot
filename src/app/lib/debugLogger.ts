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

import path from 'node:path';
import fs from 'node:fs';
import pino from 'pino';

// Ensure logs directory exists (server-side only)
const logDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

const pinoLogger = pino(
  {
    level: 'debug',
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  pino.destination(path.join(logDir, 'locopilot-debug.log')),
);

export interface ToolTraceEntry {
  /** Which layer produced this log entry */
  layer: 'frontend' | 'route' | 'adapter' | 'history' | 'chatSession';
  /** What happened at this boundary */
  action: 'push' | 'convert' | 'persist' | 'load' | 'merge' | 'normalize' | 'synthesize' | 'send' | 'receive' | 'filter';
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
      `[trace] layer=${entry.layer} action=${entry.action} role=${entry.role ?? 'n/a'}`,
    );
  },

  /** Log a summary of the full message array at a boundary */
  messageArraySummary(
    label: string,
    messages: Array<{ role?: string; tool_call_id?: string; tool_calls?: unknown[] }>,
    context?: { sessionId?: number; requestId?: string },
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
      `[trace] ${label}: ${messages.length} messages`,
    );
  },

  /** Generic debug log for ad-hoc tracing */
  debug(label: string, data?: Record<string, unknown>) {
    pinoLogger.debug(data ?? {}, `[trace] ${label}`);
  },

  /** Flush the log destination (call at end of request) */
  async flush() {
    // pino.destination is synchronous by default, but we can flush explicitly
    pinoLogger.flush();
  },
};

export { truncate };
