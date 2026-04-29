import { encoding_for_model, get_encoding, Tiktoken } from '@dqbd/tiktoken';
import { type ChatMessage } from './llm';
import { stripSpecialTokens } from './textUtils';

let encoder: Tiktoken | null = null;
let currentEncoderModel: string | null = null;
const IMAGE_TOKEN_ESTIMATE = 1024;

function getEncoder(model: string): Tiktoken {
    if (encoder && currentEncoderModel === model) return encoder;

    try {
        encoder = encoding_for_model(model as Parameters<typeof encoding_for_model>[0]);
        currentEncoderModel = model;
    } catch {
        if (!encoder) {
            encoder = get_encoding('cl100k_base');
            currentEncoderModel = 'cl100k_base';
        }
    }

    return encoder;
}

function countTextTokensWithEncoder(text: string, activeEncoder: Tiktoken): number {
    const cleanedText = stripSpecialTokens(text);
    if (!cleanedText) return 0;
    return activeEncoder.encode(cleanedText).length;
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
        total += countTextTokensWithEncoder(message.thinking ?? '', activeEncoder);

        if (message.tool_calls && message.tool_calls.length > 0) {
            for (const toolCall of message.tool_calls) {
                total += countTextTokensWithEncoder(toolCall.function.name, activeEncoder);
                total += countTextTokensWithEncoder(JSON.stringify(toolCall.function.arguments), activeEncoder);
            }
        }

        if (message.images && message.images.length > 0) {
            // Vision payloads are not text tokens, so use a fixed conservative budget per image.
            total += message.images.length * IMAGE_TOKEN_ESTIMATE;
        }
    }

    return total + 2;
}
