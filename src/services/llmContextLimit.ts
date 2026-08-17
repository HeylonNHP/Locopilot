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
 * raw `LlmModelInfo` payload.
 *
 * Resolution order:
 *
 *   1. Text scan over `info.parameters` and `info.modelfile` for an
 *      explicit `num_ctx N` or `context_length N`. The Modelfile's
 *      `PARAMETER num_ctx N` line is the user's intent — for
 *      RoPE-scaled models this is the *extended* context, which is
 *      higher than the GGUF training context reported under
 *      `model_info.<arch>.context_length`. Preferring the text scan
 *      captures that intent.
 *   2. Structured object walk over `info` for the standard keys
 *      (`<arch>.context_length`, `num_ctx`, `context_window`,
 *      `max_position_embeddings`, `max_sequence_length`,
 *      `max_context_length`). This is the GGUF training context for
 *      Ollama, or whatever the provider exposes for OpenAI-compatible.
 */
export function getModelContextLimitFromInfo(info: LlmModelInfo): number | null {
  // 1. Modelfile / parameters text scan first — captures the user's
  //    intent for RoPE-scaled and other Modelfile-overridden models.
  for (const text of [info.parameters, info.modelfile]) {
    const parsed = parseContextLimitFromText(text);
    if (parsed !== null) {
      return parsed;
    }
  }

  // 2. Structured walk — the GGUF training context or whatever the
  //    provider advertises. Returns the first match.
  return findContextLimitInObject(info);
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

/**
 * Patterns that, when matched against a 400-style error message,
 * indicate the model rejected the request because vision/image input
 * is not supported. Conservative on purpose — a false positive would
 * silently strip image attachments from a model that actually accepts
 * them, which is the same class of bug as the OpenAI-compatible
 * vision-strip we are trying to fix. Returning `false` is the safe
 * default; the user sees a 400 in that case.
 *
 * Covers common phrasings from OpenAI, vLLM, llama.cpp-server,
 * Ollama-as-OpenAI-compatible, and similar providers. New providers
 * should add their pattern here in a 2-line diff.
 */
const VISION_UNSUPPORTED_PATTERNS: RegExp[] = [
  /image input (?:is|are) not (?:supported|allowed)/i,
  /does not support (?:image|vision|multimodal)/i,
  /vision (?:input|image) not supported/i,
  /model does not accept (?:images?|image_url)/i,
  /unsupported (?:content type|part type|message part).*image/i,
  /image_url is not supported/i,
];

/**
 * Returns true when the given error message indicates the provider
 * rejected the request because vision/image input is not supported by
 * the active model. Used by the chat route's 400 catch block to fold
 * a runtime-discovered "non-vision" signal into the vision cache (see
 * `src/services/visionCache.ts`) so the next turn strips images
 * without re-hitting the same 400.
 */
export function parseVisionUnsupportedFromError(message: string): boolean {
  if (typeof message !== 'string' || message.length === 0) {
    return false;
  }
  for (const pattern of VISION_UNSUPPORTED_PATTERNS) {
    if (pattern.test(message)) {
      return true;
    }
  }
  return false;
}

/**
 * Patterns that, when matched against a 400-style error message,
 * indicate the upstream rejected the request because a specific
 * sampling parameter is not supported by the active model. The
 * matcher additionally extracts the param name from the message so
 * the caller can be precise about which entry to mark unsupported.
 *
 * Conservative on purpose — a false positive would silently strip a
 * sampling knob the model actually accepts, which is the same class
 * of bug as the openai-compatible vision-strip the existing code is
 * designed to prevent. Returning `null` is the safe default; the user
 * sees a 400 in that case.
 *
 * Covers common phrasings from OpenAI, OpenRouter, vLLM, llama.cpp-
 * server, and similar providers. The matched param name is the exact
 * token the upstream named in the message (e.g. `"temperature"`); it
 * is the caller's responsibility to map it onto a known
 * {@link SamplingParamName} entry. New providers should add their
 * pattern here in a 2-line diff.
 */
const UNSUPPORTED_PARAM_PATTERNS: RegExp[] = [
  // "temperature is not supported", "'temperature' is not supported"
  /\b["'`]?([_a-z]\w*)["'`]?\s+is\s+not\s+supported\b/i,
  // "does not accept temperature", "does not support 'temperature'"
  /\bdoes not (?:accept|support)\s+["'`]?([_a-z]\w*)["'`]?\b/i,
  // "unsupported parameter: temperature", "unsupported parameter: 'temperature'"
  /\bunsupported (?:parameter|value|field|argument)s?\s*[:=]\s*["'`]?([_a-z]\w*)["'`]?\b/i,
  // "unknown parameter 'temperature'"
  /\bunknown (?:parameter|field|argument)s?\s*[:=]?\s*["'`]?([_a-z]\w*)["'`]?/i,
  // "value not supported for parameter `temperature`"
  /\bvalue not supported for parameter\s+["'`]?([_a-z]\w*)["'`]?/i,
  // "Unrecognized request argument supplied: temperature"
  /\bunrecognized (?:request )?arguments? supplied\s*[:=]?\s*["'`]?([_a-z]\w*)["'`]?/i,
];

/**
 * Returns the sampling-parameter name when the given error message
 * indicates the upstream rejected the request because that parameter
 * is not supported by the active model. The name is the exact token
 * the upstream named; the caller maps it onto a known
 * {@link SamplingParamName} entry before calling
 * `recordDiscoveredUnsupportedParam`.
 *
 * Returns `null` when the message does not contain a parseable
 * unsupported-parameter signal — same conservative default as
 * {@link parseVisionUnsupportedFromError}.
 */
export function parseUnsupportedParamFromError(message: string): string | null {
  if (typeof message !== 'string' || message.length === 0) {
    return null;
  }
  for (const pattern of UNSUPPORTED_PARAM_PATTERNS) {
    const match = message.match(pattern);
    const candidate = match?.[1];
    if (typeof candidate === 'string' && candidate.length > 0) {
      return candidate;
    }
  }
  return null;
}
