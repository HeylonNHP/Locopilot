import { IMAGE_TOKEN_ESTIMATE } from '../constants';

export const APPROX_CHARS_PER_TOKEN = 4;

export interface TokenizableToolCall {
    function?: {
        name?: string | null;
        arguments?: unknown;
    } | null;
}

export interface TokenizableMessage {
    role?: string | null;
    content?: string | null;
    thinking?: string | null;
    tool_calls?: ReadonlyArray<TokenizableToolCall> | null;
    images?: ReadonlyArray<unknown> | null;
}

export function estimateTextTokens(text: string): number {
    if (!text) {
        return 0;
    }

    return Math.max(1, Math.ceil(text.length / APPROX_CHARS_PER_TOKEN));
}

export function estimateMessagesTokens(messages: ReadonlyArray<TokenizableMessage>): number {
    let total = 0;

    for (const message of messages) {
        total += 4;
        total += estimateTextTokens(message.role ?? '');
        total += estimateTextTokens(message.content ?? '');
        total += estimateTextTokens(message.thinking ?? '');

        if (message.tool_calls && message.tool_calls.length > 0) {
            for (const toolCall of message.tool_calls) {
                total += estimateTextTokens(toolCall.function?.name ?? '');
                total += estimateTextTokens(JSON.stringify(toolCall.function?.arguments ?? {}));
            }
        }

        if (message.images && message.images.length > 0) {
            total += message.images.length * IMAGE_TOKEN_ESTIMATE;
        }
    }

    return messages.length > 0 ? total + 2 : 0;
}