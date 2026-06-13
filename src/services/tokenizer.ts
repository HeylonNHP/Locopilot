import { createRequire } from 'node:module';

import { APPROX_CHARS_PER_TOKEN, IMAGE_TOKEN_ESTIMATE } from '../constants';
import { type ChatMessage } from './llm';
import { stripSpecialTokens } from './textUtils';

let encoder: TiktokenLike | null = null;
let currentEncoderModel: string | null = null;
const require = createRequire(import.meta.url);

interface TiktokenLike {
  encode(text: string): number[];
  estimateTokens?: (text: string) => number;
}

// Fallback approximate encoder when the real tiktoken WASM fails to load.
// Uses a rough heuristic of ~4 characters per token (typical for GPT-like tokenizers).
function estimateHeuristicTextTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / APPROX_CHARS_PER_TOKEN));
}

const fallbackEncoder: TiktokenLike = {
  encode(text: string): number[] {
    const estimated = estimateHeuristicTextTokens(text);
    return new Array(estimated).fill(0);
  },
  estimateTokens(text: string): number {
    return estimateHeuristicTextTokens(text);
  },
};

type TiktokenModule = {
  encoding_for_model: (model: string) => TiktokenLike;
  get_encoding: (encoding: string) => TiktokenLike;
};

function loadTiktoken(): TiktokenModule | null {
  try {
    return require('@dqbd/tiktoken') as TiktokenModule;
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
    // Model doesn't have a known encoding — keep whatever encoder we already
    // have (or fall back to cl100k_base on first load). We still record
    // currentEncoderModel so we don't retry encoding_for_model every call.
    if (encoder) {
      currentEncoderModel = model;
    } else {
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
  if (typeof activeEncoder.estimateTokens === 'function') {
    return activeEncoder.estimateTokens(cleanedText);
  }
  return activeEncoder.encode(cleanedText).length;
}

function countMessageTokensWithEncoder(message: ChatMessage, activeEncoder: TiktokenLike): number {
  let total = 4;
  total += countTextTokensWithEncoder(message.role, activeEncoder);
  total += countTextTokensWithEncoder(message.content ?? '', activeEncoder);
  total += countTextTokensWithEncoder(message.thinking ?? '', activeEncoder);

  if (message.tool_calls && message.tool_calls.length > 0) {
    for (const toolCall of message.tool_calls) {
      total += countTextTokensWithEncoder(toolCall.function?.name ?? '', activeEncoder);
      total += countTextTokensWithEncoder(
        JSON.stringify(toolCall.function?.arguments ?? {}),
        activeEncoder
      );
    }
  }

  if (message.images && message.images.length > 0) {
    total += message.images.length * IMAGE_TOKEN_ESTIMATE;
  }

  return total;
}

export function countTextTokens(text: string, model: string): number {
  const activeEncoder = getEncoder(model);
  return countTextTokensWithEncoder(text, activeEncoder);
}

export function countMessageTokens(message: ChatMessage, model: string): number {
  const activeEncoder = getEncoder(model);
  return countMessageTokensWithEncoder(message, activeEncoder);
}

export function countMessagesTokens(messages: ChatMessage[], model: string): number {
  const activeEncoder = getEncoder(model);
  let total = 0;

  for (const message of messages) {
    total += countMessageTokensWithEncoder(message, activeEncoder);
  }

  return messages.length > 0 ? total + 2 : 0;
}
