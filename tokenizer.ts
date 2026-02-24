import { encoding_for_model, get_encoding, Tiktoken } from '@dqbd/tiktoken';
import type { ChatMessage } from './ollamaApi.js';

let encoder: Tiktoken | null = null;

function getEncoder(model: string): Tiktoken {
    if (encoder) return encoder;

    try {
        encoder = encoding_for_model(model as Parameters<typeof encoding_for_model>[0]);
    } catch {
        encoder = get_encoding('cl100k_base');
    }

    return encoder;
}

function countTextTokensWithEncoder(text: string, activeEncoder: Tiktoken): number {
    if (!text) return 0;
    return activeEncoder.encode(text).length;
}

export function countTextTokens(text: string, model: string): number {
    const activeEncoder = getEncoder(model);
    return countTextTokensWithEncoder(text, activeEncoder);
}

export function countMessagesTokens(messages: ChatMessage[], model: string): number {
    const activeEncoder = getEncoder(model);
    let total = 0;

    for (const message of messages) {
        total += 4;
        total += countTextTokensWithEncoder(message.role, activeEncoder);
        total += countTextTokensWithEncoder(message.content ?? '', activeEncoder);

        if (message.tool_calls && message.tool_calls.length > 0) {
            for (const toolCall of message.tool_calls) {
                total += countTextTokensWithEncoder(toolCall.function.name, activeEncoder);
                total += countTextTokensWithEncoder(JSON.stringify(toolCall.function.arguments), activeEncoder);
            }
        }
    }

    return total + 2;
}
