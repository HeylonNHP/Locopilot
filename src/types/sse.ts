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
  };
  compact_progress: { message: string };
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
  model_context_limit: { limit: number };
}

export type SseEventName = keyof SseEventPayloadMap;

export type SseEvent<N extends SseEventName = SseEventName> = {
  event: N;
  data: SseEventPayloadMap[N];
};

/** Union of all possible chat SSE frames. */
export type AnySseEvent = SseEvent<SseEventName>;
