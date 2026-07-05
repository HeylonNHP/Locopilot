/**
 * Utilities for cleaning model and tool-generated text before it enters
 * the conversation history or gets tokenized.
 *
 * This module strips reserved LLM control tokens such as <|fim_prefix|>
 * from assistant content, tool results, and persisted messages so the
 * tokenizer and provider do not see invalid internal markers.
 */
import type {
  ChatMessage,
  PersistedChatMessage,
  SubagentLogMessage,
  ToolCall,
} from './adapters/llmAdapter';

const SPECIAL_LLM_TOKENS = [
  '<|fim_prefix|>',
  '<|fim_suffix|>',
  '<|fim_middle|>',
  '<|fim_pad|>',
  '<|endoftext|>',
  '<|channel|>',
  '<channel|>',
];

const SPECIAL_LLM_TOKENS_PATTERN = new RegExp(
  SPECIAL_LLM_TOKENS.map((token) => token.replaceAll(/[$()*+.?[\\\]^{|}]/g, String.raw`\$&`)).join('|'),
  'g'
);

function stripSpecialTokensFromValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return stripSpecialTokens(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => stripSpecialTokensFromValue(item));
  }

  if (value && typeof value === 'object') {
    const cleanedObject: Record<string, unknown> = {};
    for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
      cleanedObject[key] = stripSpecialTokensFromValue(nestedValue);
    }
    return cleanedObject;
  }

  return value;
}

export function stripSpecialTokens(text: string): string {
  if (!text) return text;
  return text.replace(SPECIAL_LLM_TOKENS_PATTERN, '');
}

export function sanitizeChatMessage(message: ChatMessage): ChatMessage;
export function sanitizeChatMessage(message: SubagentLogMessage): SubagentLogMessage;
export function sanitizeChatMessage(message: PersistedChatMessage): PersistedChatMessage;
export function sanitizeChatMessage(message: PersistedChatMessage): PersistedChatMessage {
  if (message.role === 'subagent_log') {
    const sanitized: SubagentLogMessage = {
      role: 'subagent_log',
      content: stripSpecialTokens(message.content ?? ''),
    };
    if (message.subagentId) {
      sanitized.subagentId = stripSpecialTokens(message.subagentId);
    }
    return sanitized;
  }

  const sanitizedMessage: ChatMessage = {
    role: message.role,
    content: stripSpecialTokens(message.content ?? ''),
  };

  if (message.thinking !== undefined) {
    sanitizedMessage.thinking = stripSpecialTokens(message.thinking);
  }

  if (message.images?.length) {
    sanitizedMessage.images = [...message.images];
  }

  if (message.tool_call_id !== undefined) {
    sanitizedMessage.tool_call_id = message.tool_call_id;
  }

  if (message.tool_calls && message.tool_calls.length > 0) {
    sanitizedMessage.tool_calls = message.tool_calls.map((toolCall) => ({
      id: toolCall.id,
      function: {
        name: stripSpecialTokens(toolCall.function.name),
        arguments: stripSpecialTokensFromValue(
          toolCall.function.arguments
        ) as ToolCall['function']['arguments'],
      },
    })) as [ToolCall, ...ToolCall[]];
  }

  if (typeof message.createdAt === 'string') {
    sanitizedMessage.createdAt = message.createdAt;
  }

  return sanitizedMessage;
}
