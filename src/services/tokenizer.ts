import { encoding_for_model, get_encoding, init } from '@dqbd/tiktoken/init';

import { APPROX_CHARS_PER_TOKEN, IMAGE_TOKEN_ESTIMATE } from '../constants';
import { type ChatMessage } from './llm';
import { stripSpecialTokens } from './textUtils';

interface TiktokenLike {
  encode(text: string): Uint32Array | number[];
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
    // Pre-allocate an array of `estimated` slots, each representing a token.
    // Using Array.from avoids the unicorn/no-new-array lint warning while
    // preserving the original behavior: a sparse/empty array would change
    // the array's length semantics, so we keep the fill value of 0.
    return Array.from({ length: estimated }, () => 0);
  },
  estimateTokens(text: string): number {
    return estimateHeuristicTextTokens(text);
  },
};

let wasmReady = false;

async function initializeWasm(): Promise<void> {
  if (wasmReady) return;

  await init(async (imports) => {
    if (typeof globalThis.window === 'undefined') {
      // Server: load WASM directly from node_modules. We use dynamic imports so
      // this code path does not pull Node.js built-ins into any client bundle.
      const { readFileSync } = await import('node:fs');
      const { fileURLToPath } = await import('node:url');
      // Resolve relative to this module so the path is statically scoped to
      // node_modules and Turbopack's NFT trace does not mark the whole project.
      const wasmUrl = new URL('../../node_modules/@dqbd/tiktoken/tiktoken_bg.wasm', import.meta.url);
      const wasmPath = fileURLToPath(wasmUrl);
      const bytes = readFileSync(wasmPath);
      return WebAssembly.instantiate(bytes, imports);
    }

    // Client: fetch the WASM file copied to the public directory by the
    // postinstall/prebuild script (scripts/copy-wasm.mjs).
    const response = await fetch('/wasm/tiktoken_bg.wasm');
    const bytes = await response.arrayBuffer();
    return WebAssembly.instantiate(bytes, imports);
  });

  wasmReady = true;
}

// Initialize at module load. Any import of this module will await this before
// the exported functions can be called, so the public API stays synchronous.
await initializeWasm().catch((err) => {
  console.error('Failed to initialize tiktoken WASM; using heuristic fallback:', err);
});

let encoder: TiktokenLike | null = null;
let currentEncoderModel: string | null = null;

function getEncoder(model: string): TiktokenLike {
  if (encoder && currentEncoderModel === model) return encoder;

  if (!wasmReady) {
    encoder = fallbackEncoder;
    currentEncoderModel = model;
    return encoder;
  }

  try {
    encoder = encoding_for_model(model as never);
    currentEncoderModel = model;
  } catch {
    // Model doesn't have a known encoding — keep whatever encoder we already
    // have (or fall back to cl100k_base on first load). We still record
    // currentEncoderModel so we don't retry encoding_for_model every call.
    if (encoder) {
      currentEncoderModel = model;
    } else {
      try {
        encoder = get_encoding('cl100k_base');
        currentEncoderModel = 'cl100k_base';
      } catch {
        encoder = fallbackEncoder;
        currentEncoderModel = 'cl100k_base';
      }
    }
  }

  return encoder ?? fallbackEncoder;
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
        activeEncoder,
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
