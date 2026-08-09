/**
 * Centralised default-value objects for Locopilot config shapes.
 *
 * These were previously hand-rebuilt in multiple routes and adapters. Each
 * site was free to drift (e.g. the openai-compatible adapter and the
 * `config/route.ts` validator carried near-duplicate retry defaults). All
 * defaults now live here so a single change is visible everywhere.
 */

import type { AdapterRetryConfig, CompletionMode, Config, LlmProvider } from '@/types/chatConfig';

import {
  DEFAULT_OLLAMA_CHAT_TIMEOUT_MS,
  DEFAULT_WEB_SEARCH_MAX_QUERIES,
  DEFAULT_WEB_SEARCH_PER_PAGE_CHAR_LIMIT,
  DEFAULT_WEB_SEARCH_RESULTS_PER_QUERY,
} from '@/constants';

export { DEFAULT_MAX_PROMPT_LOOP_ITERATIONS } from '@/constants';

// ── Provider / base URL defaults ───────────────────────────────────────────

/** Port Ollama's HTTP server listens on by default. */
export const DEFAULT_OLLAMA_PORT = 11434;

/** Default Ollama base URL used when no provider baseUrl is configured. */
export const DEFAULT_OLLAMA_BASE_URL = `http://localhost:${DEFAULT_OLLAMA_PORT}`;

/** Provider name used when no explicit provider is set. */
export const DEFAULT_PROVIDER: LlmProvider = 'ollama';

export { PROVIDER_OLLAMA, PROVIDER_OPENAI_COMPATIBLE } from '@/services/providerConstants';

// ── Retry defaults (adapter + config validator share these) ────────────────

/** Total attempts (1 = no retry). Capped at `RETRY_MAX_ATTEMPTS_LIMIT` below. */
export const DEFAULT_RETRY_MAX_ATTEMPTS = 3;

/** Initial backoff in ms; doubles each retry up to `DEFAULT_RETRY_MAX_DELAY_MS`. */
export const DEFAULT_RETRY_BASE_DELAY_MS = 1000;

/** Hard ceiling on a single sleep. Also clamps server-supplied `Retry-After`. */
export const DEFAULT_RETRY_MAX_DELAY_MS = 16_000;

/**
 * HTTP statuses that the openai-compatible adapter should retry. Mirrors the
 * OpenAI SDK's `shouldRetry` set plus `408 Request Timeout`.
 */
export const DEFAULT_RETRYABLE_STATUSES: readonly number[] = [408, 409, 429, 500, 502, 503, 504];

/** Lower bound for `retry.maxAttempts` (1 = no retry). */
export const RETRY_MAX_ATTEMPTS_MIN = 1;
/** Upper bound for `retry.maxAttempts` to prevent runaway retries. */
export const RETRY_MAX_ATTEMPTS_LIMIT = 10;

/** Validation bound for `retry.baseDelayMs`. */
export const MAX_RETRY_BASE_DELAY_MS = 60_000;

/** Validation bound for `retry.maxDelayMs`. */
export const MAX_RETRY_MAX_DELAY_MS = 600_000;

/** Canonical retry-defaults object used by both the adapter and the validator. */
export const DEFAULT_ADAPTER_RETRY: Required<AdapterRetryConfig> = {
  enabled: true,
  maxAttempts: DEFAULT_RETRY_MAX_ATTEMPTS,
  baseDelayMs: DEFAULT_RETRY_BASE_DELAY_MS,
  maxDelayMs: DEFAULT_RETRY_MAX_DELAY_MS,
  retryableStatuses: [...DEFAULT_RETRYABLE_STATUSES],
};

// ── Prompt-loop completion defaults ───────────────────────────────────────

/** Completion mode used when none is configured. */
export const DEFAULT_COMPLETION_MODE: CompletionMode = 'normal';

// ── Web search defaults ────────────────────────────────────────────────────

/**
 * Default `webSearch` block. Mirrors the constants in `constants.ts` so the
 * config validator and the chat route agree on the shape and values.
 */
export interface WebSearchSettingsShape {
  maxQueries: number;
  resultsPerQuery: number;
  perPageCharLimit: number;
}

export const DEFAULT_WEB_SEARCH_SETTINGS: Required<WebSearchSettingsShape> = {
  maxQueries: DEFAULT_WEB_SEARCH_MAX_QUERIES,
  resultsPerQuery: DEFAULT_WEB_SEARCH_RESULTS_PER_QUERY,
  perPageCharLimit: DEFAULT_WEB_SEARCH_PER_PAGE_CHAR_LIMIT,
};

/**
 * Construct the `webSearch` settings with the LLM call timeout populated.
 * Kept separate from `DEFAULT_WEB_SEARCH_SETTINGS` because the request
 * timeout depends on `DEFAULT_OLLAMA_CHAT_TIMEOUT_MS` and is consumed by
 * both `toolRegistry.ts` and the chat route's pre-flight builder.
 */
export function defaultWebSearchSettings(): Required<WebSearchSettingsShape> & {
  requestTimeoutMs: number;
} {
  return {
    ...DEFAULT_WEB_SEARCH_SETTINGS,
    requestTimeoutMs: DEFAULT_OLLAMA_CHAT_TIMEOUT_MS,
  };
}

// ── Config fallback shape ──────────────────────────────────────────────────

/**
 * Empty-but-typed `Config` used as the sentinel when no `config.json` is
 * found. Routes that previously inlined `{ baseUrl: 'http://localhost:11434' }`
 * (or the empty-string variant for new installs) should use this so all
 * "no config yet" sites fall back to the same shape. Callers that need a
 * base URL default should use `DEFAULT_OLLAMA_BASE_URL` directly.
 */
export function emptyConfig(): Config {
  return {
    model: '',
    compactionModel: '',
  };
}

/** Convenience accessor: the default Ollama base URL, exposed as a function. */
export const defaultOllamaBaseUrl = (): string => DEFAULT_OLLAMA_BASE_URL;
