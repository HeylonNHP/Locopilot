import type { ChatMessage } from '@/app/lib/chatStore';
import type { CompactStats } from '@/services/compact';
import type { ToolCallArguments } from '@/tools/tools';

/**
 * Token statistics payload emitted on the `done` SSE event.
 */
export interface SseTokenStats {
  promptEvalCount: number;
  evalCount: number;
  totalTokens: number;
  tokenLimit: number;
  promptTps?: number;
  evalTps?: number;
  isEstimated?: boolean;
  /**
   * The model's runtime cap as known to the server at the end of the
   * turn. Mirrors the `status.modelContextLimit` field so the client
   * can rely on the `done` event alone to learn the cap on a turn
   * that emitted no informative `status` events (e.g. an instant
   * stop with no tool calls).
   */
  modelContextLimit?: number | null;
}

/**
 * Payload map for every event emitted by the chat SSE stream in
 * `src/app/api/chat/route.ts`. Keeping the contract in one shared file lets
 * the producer and the consumer stay in sync at compile time.
 */
export interface SseEventPayloadMap {
  session_created: { sessionId: number };
  thinking: { content: string };
  chunk: { content: string };
  tool_call: { name: string; arguments: ToolCallArguments | Record<string, unknown> };
  tool_result: { name: string; result: string; duration: number; toolCallId?: string };
  tool_progress: { name: string; message: string };
  subagent_output: { agentId: string; message: string };
  subagent_chunk: { agentId: string; type: 'thinking' | 'content'; text: string };
  approval_request: {
    requestId: string;
    toolName: string;
    args: ToolCallArguments | Record<string, unknown>;
    toolCallName?: string;
    fromSubAgent?: boolean;
  };
  status: {
    phase: string;
    tokensUsed?: number;
    tokenLimit?: number;
    tps?: number | null;
    isEstimated?: boolean;
    iteration?: number;
    maxIterations?: number;
    attempt?: number;
    maxRetries?: number;
    /**
     * The model's runtime cap as known to the server. Set on every
     * `status` event so the client can render an authoritative cap
     * (e.g. "capped by model limit" in SettingsModal) without ever
     * computing the clamp itself. Null when the server has no
     * resolved cap (probes failed and no 400 has been observed).
     */
    modelContextLimit?: number | null;
  };  compact_progress: { message: string };
  compact: { messages: ChatMessage[]; stats: CompactStats };
  done: {
    content: string;
    thinking: string;
    sessionId: number;
    tokenStats: SseTokenStats;
    doneReason: 'stop' | 'length' | 'load' | 'unload';
  };
  error: { message: string };
  write_error: { message: string };
  clear_assistant: object;
}
