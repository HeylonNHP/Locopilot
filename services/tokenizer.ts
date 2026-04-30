import { type ChatMessage } from './llm';
import { stripSpecialTokens } from './textUtils';

let encoder: TiktokenLike | null = null;
let currentEncoderModel: string | null = null;
const IMAGE_TOKEN_ESTIMATE = 1024;

interface TiktokenLike {
    encode(text: string): number[];
}

// Fallback approximate encoder when the real tiktoken WASM fails to load.
// Uses a rough heuristic of ~4 characters per token (typical for GPT-like tokenizers).
const fallbackEncoder: TiktokenLike = {
    encode(text: string): number[] {
        const estimated = Math.max(1, Math.ceil(text.length / 4));
        return new Array(estimated).fill(0);
    },
};

function loadTiktoken(): { encoding_for_model: (model: string) => TiktokenLike; get_encoding: (encoding: string) => TiktokenLike } | null {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        return require('@dqbd/tiktoken');
    } catch {
        return null;
    }
}

function getEncoder(model: string): TiktokenLike {
    if (encoder && currentEncoderModel === model) return encoder;

    const tiktoken = loadTiktoken();
    if (!tiktoken) {
        encoder = fallbackEncoder;
        currentEncoderModel = model;
        return encoder;
    }

    try {
        encoder = tiktoken.encoding_for_model(model);
        currentEncoderModel = model;
    } catch {
        if (!encoder) {
            try {
                encoder = tiktoken.get_encoding('cl100k_base');
                currentEncoderModel = 'cl100k_base';
            } catch {
                encoder = fallbackEncoder;
                currentEncoderModel = 'cl100k_base';
            }
        }
    }

    return encoder;
}

function countTextTokensWithEncoder(text: string, activeEncoder: TiktokenLike): number {
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
