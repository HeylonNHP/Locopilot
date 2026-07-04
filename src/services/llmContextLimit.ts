/**
 * Shared utilities for discovering and parsing an LLM model's maximum
 * context-window size (in tokens).
 *
 * The cap is needed because the client UI wants to:
 *   - clamp the user-configured `numCtx` against whatever the model will
 *     actually accept, so the chat request doesn't fail with a 400;
 *   - report a token-budget percentage to the user that reflects what the
 *     model will really do, not what the user typed into Settings.
 *
 * Discovery happens in three places, in this order of authority:
 *
 *   1. Proactive — `getLlmModelContextLimit` (per-adapter, walks the
 *      model-info payload).
 *   2. Reactive — `parseContextLimitFromError` parses the model cap out
 *      of an OpenAI-compatible 400 error body when a request was sent
 *      with a `numCtx` the model rejected.
 *   3. Hard-coded — the title-generation route uses a constant
 *      unrelated to the model (see titleGeneration.ts).
 *
 * This module holds (1) and (2) so they can be tested and reused without
 * depending on a specific adapter's request handler.
 */

import type { LlmModelInfo } from './adapters/llmAdapter';

/**
 * Keys (at any nesting level) whose value should be treated as the
 * model's context-window size. The `(?:^|[._])` prefix is intentional:
 * Ollama reports e.g. `llama.context_length` and we want the dotted form
 * to match.
 *
 * `max_context_length` is also accepted because some OpenAI-compatible
 * providers (LM Studio) advertise it that way.
 */
export const CONTEXT_LIMIT_KEY_PATTERN =
  /(?:^|[._])(?:context_length|num_ctx|context_window|max_position_embeddings|max_sequence_length|max_context_length)$/i;

/**
 * Parse a positive integer from a value that may be a number or a string.
 * Returns null for anything non-integer, non-positive, or unparseable.
 */
export function parsePositiveInteger(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value > 0 ? value : null;
  }
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

/**
 * Recursively walk an object looking for any key matching
 * {@link CONTEXT_LIMIT_KEY_PATTERN}. Returns the first positive integer
 * found, or null. Walks depth-first; if the same key appears in multiple
 * places, the first one wins. Earlier keys in the alternation are not
 * prioritised — the recursion order is the source order of `Object.entries`.
 */
export function findContextLimitInObject(value: unknown): number | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
    if (CONTEXT_LIMIT_KEY_PATTERN.test(key)) {
      const parsed = parsePositiveInteger(nestedValue);
      if (parsed !== null) {
        return parsed;
      }
    }

    const nestedLimit = findContextLimitInObject(nestedValue);
    if (nestedLimit !== null) {
      return nestedLimit;
    }
  }

  return null;
}

/**
 * Scan free-form text (typically an Ollama `modelfile` or `parameters`
 * string) for a `num_ctx N` or `context_length N` declaration. Some
 * Ollama model cards specify the window size only in the modelfile and
 * do not surface it under `model_info.<arch>.context_length`.
 */
export function parseContextLimitFromText(value: unknown): number | null {
  if (typeof value !== 'string') {
    return null;
  }

  const patterns = [/\bnum_ctx\s+(\d+)\b/i, /\bcontext_length\s+(\d+)\b/i];

  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (!match?.[1]) {
      continue;
    }
    const parsed = Number.parseInt(match[1], 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return null;
}

/**
 * Adapter-facing entry point: extract the model context limit from a
 * raw `LlmModelInfo` payload. Tries the structured object walk first
 * (works for any provider that returns the value under a known key in
 * JSON), then falls back to scanning the modelfile/parameters text (an
 * Ollama-specific surface that some OpenAI-compatible providers also
 * emulate).
 */
export function getModelContextLimitFromInfo(info: LlmModelInfo): number | null {
  const structuredLimit = findContextLimitInObject(info);
  if (structuredLimit !== null) {
    return structuredLimit;
  }

  for (const text of [info.parameters, info.modelfile]) {
    const parsed = parseContextLimitFromText(text);
    if (parsed !== null) {
      return parsed;
    }
  }

  return null;
}

/**
 * Parse the model context limit out of an OpenAI-compatible 400 error
 * body. The reference message format is:
 *
 *   "This model's maximum context length is 16385 tokens. Please reduce
 *    the length of the messages."
 *
 * vLLM uses a similar but more verbose phrasing that the regex below
 * also matches:
 *
 *   "This model's maximum context length is 4096 tokens, however you
 *    requested 8192 tokens (8192 in the messages, 0 in the completion)."
 *
 * Anthropic and llama.cpp-server use different phrasing and are not
 * currently supported; if/when an Anthropic adapter is added, extend
 * this function with the additional pattern.
 *
 * Returns null if the message does not contain a parseable positive
 * integer cap.
 */
export function parseContextLimitFromError(message: string): number | null {
  const match = message.match(/maximum context length is (\d+) tokens/i);
  if (!match?.[1]) {
    return null;
  }
  const parsed = Number.parseInt(match[1], 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}
