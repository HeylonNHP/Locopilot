export type CompletionMode = 'normal' | 'prompt-loop';
export type LlmProvider = 'ollama' | 'openai-compatible';

/**
 * Canonical reasoning-effort levels, ordered from least to most effort.
 * This is the single source of truth for the `ReasoningEffort` type and for
 * every validation list / UI dropdown across the codebase. Add or remove a
 * level here and the type, the API validators, and the UI all stay in sync.
 *
 * Wire mapping:
 *   - 'off'   → 'none'   (forced off, even for models with reasoning on by default)
 *   - 'none'  → 'none'
 *   - 'minimal' → 'minimal'
 *   - 'low'   → 'low'
 *   - 'medium'→ 'medium'
 *   - 'high'  → 'high'
 *   - 'xhigh' → 'xhigh'   (OpenAI-compatible ceiling)
 *   - 'max'   → 'max'     (Ollama-only highest level; OpenAI-compatible
 *                        providers cap at 'xhigh')
 *
 * Distinct from `thinkingEnabled` (a boolean) which maps to Ollama's
 * `think` field. The two coexist. For OpenAI-compatible providers the
 * level maps to `reasoning_effort`; for Ollama it maps to Ollama's
 * `think` level (low/medium/high/max).
 * Defaults to 'off' (which resolves to 'none') so models with reasoning
 * on by default (e.g. gpt-5.6-luna on the Airia gateway) are not silently
 * forced into reasoning when called with tools.
 */
export const REASONING_EFFORTS = [
  'off',
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/** Human-readable labels for each reasoning-effort level (UI display). */
export const REASONING_EFFORT_LABELS: Record<ReasoningEffort, string> = {
  off: 'Off',
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Max',
};

/** Type guard: is `value` a valid reasoning-effort level? */
export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === 'string' && (REASONING_EFFORTS as readonly string[]).includes(value);
}

/**
 * Configuration for the openai-compatible adapter's transient-error
 * retry layer (429, 408, 409, 5xx, network). Retry runs INSIDE the
 * adapter so every caller — main chat, sub-agents, compaction,
 * title generation, prompt-loop judge — benefits, not just the chat
 * route. Pre-stream only: once any chunk has been yielded, mid-stream
 * failures still propagate (the chat route's existing retry loop is
 * the safety net for that case).
 */
export interface AdapterRetryConfig {
  /** Master switch. Defaults to true. */
  enabled?: boolean;
  /** Total attempts (1 = no retry). Capped at 10 to prevent runaway. */
  maxAttempts?: number;
  /** Initial backoff in ms; doubles each retry up to `maxDelayMs`. */
  baseDelayMs?: number;
  /** Hard ceiling on a single sleep. Also clamps server-supplied Retry-After. */
  maxDelayMs?: number;
  /** HTTP statuses that should be retried. Defaults to the openai SDK's shouldRetry set plus 408. */
  retryableStatuses?: number[];
}

/**
 * Configuration for a single LLM provider endpoint. The multi-provider
 * config stores an array of these; each carries its own authentication,
 * base URL, default model, and provider adapter.
 */
export interface ProviderConfig {
  /** Stable identifier used in request bodies and the UI state. */
  id: string;
  /** Human-readable label shown in the model selector. */
  name: string;
  provider: LlmProvider;
  baseUrl: string;
  /**
   * API key for OpenAI-compatible providers, sent as a Bearer token in
   * the Authorization header. For Ollama providers, sent as a Bearer
   * token when configured (for authenticated/remote Ollama endpoints);
   * unused by local Ollama instances.
   */
  apiKey?: string;
  /** Default model for this provider. */
  model?: string;
  /** Per-provider default context window. Falls back to the global numCtx. */
  numCtx?: number;
}

export interface Config {
  /**
   * Provider endpoints, each with their own authentication and default
   * model. The UI aggregates models from every provider and the user
   * picks which provider/model to use per turn. The legacy top-level
   * `provider`/`baseUrl`/`apiKey` fields are no longer supported;
   * old configs must be migrated to this array format (rejected at
   * startup otherwise — see scripts/validateConfig.mjs).
   */
  providers?: ProviderConfig[];
  /**
   * The id of the provider currently selected in the UI. When absent,
   * the active provider is inferred from the selected model (falling
   * back to the first provider). Persisted so the UI remembers which
   * endpoint credentials to use after reload.
   */
  activeProviderId?: string;
  /**
   * Persisted model selection. Renamed from `lastModel` to match the
   * in-memory store key (`state.model`) and the UI label ("Model").
   * `lastModel` is still read on load for backward compatibility with
   * older `config.json` files but is no longer written.
   *
   * IMPORTANT: changing this field does NOT change `numCtx`. When the
   * user picks a new model in the ModelSelector, the PUT /api/config
   * request deliberately omits `numCtx` so the user's configured
   * maximum context size is preserved. The effective (clamped) value
   * is now applied by the server via capResolver and reported back on
   * every chat turn's `status` SSE event. Do not "fix" the
   * ModelSelector by adding `numCtx` to the PUT body — that would
   * silently re-apply a value the user may have set for a different
   * model. See WEBUI_MIGRATION.md §"numCtx preservation across model
   * changes" and §"backend-side numCtx enforcement".
   */
  model?: string;
  /** @deprecated Use `model` instead. Read-only for backward compat. */
  lastModel?: string;
  compactionModel?: string;
  numCtx?: number;
  chatTimeoutMs?: number;
  yolo?: boolean;
  thinkingEnabled?: boolean;
  /**
   * Reasoning effort. For OpenAI-compatible providers this maps to the
   * `reasoning_effort` wire field; for Ollama it maps to Ollama's `think`
   * level (low/medium/high/max).
   *   - 'off'    → 'none'   (explicit off; required for models with
   *                        reasoning forced on by the provider)
   *   - 'none'   → 'none'
   *   - 'minimal'→ 'minimal'
   *   - 'low'    → 'low'
   *   - 'medium' → 'medium'
   *   - 'high'   → 'high'
   *   - 'xhigh'  → 'xhigh'  (OpenAI-compatible cap; Ollama treats as 'max')
   *   - 'max'    → 'max'    (Ollama-only highest level)
   *
   * Distinct from `thinkingEnabled` (a boolean) which maps to Ollama's
   * `think` field. The two coexist.
   * Defaults to 'off' (which resolves to 'none') so models with reasoning
   * on by default (e.g. gpt-5.6-luna on the Airia gateway) are not silently
   * forced into reasoning when called with tools.
   */
  reasoningEffort?: ReasoningEffort;
  /**
   * Reasoning effort for the compaction model. Same canonical value space
   * as `reasoningEffort`; threaded through the compaction pipeline to the
   * provider adapters. Defaults to 'off' (no explicit level forwarded).
   */
  compactionReasoningEffort?: ReasoningEffort;
  /**
   * When true, the chat route prepends a `[Sent YYYY-MM-DD HH:MM]` header
   * to each user-role message in the LLM-bound conversation. The
   * messages.created_at column is always populated regardless of this flag,
   * so toggling it later retroactively changes LLM visibility for every
   * persisted message. Defaults to true.
   */
  promptTimestamps?: boolean;
  /**
   * When true (the default), the model is instructed to cite its web-research
   * sources using numbered links and a trailing Sources list. Toggled by the
   * "Cite sources after web research" checkbox in the Settings modal. The
   * numbered SOURCES block is always appended to web_search/fetch_url tool
   * results regardless of this flag; this flag only gates the *instruction*
   * to cite (system-prompt directive + tool-result reminder).
   */
  citeSources?: boolean;
  webSearch?: {
    maxQueries: number;
    resultsPerQuery: number;
    perPageCharLimit: number;
  };
  skills?: {
    enabled: string[];
    disabled: string[];
  };
  tools?: {
    disabledMain: string[];
    disabledSubAgent: string[];
  };
  /**
   * Retry behaviour for the openai-compatible adapter. See
   * `AdapterRetryConfig` for field semantics. Defaults are applied
   * server-side in the PUT merge; any field omitted here falls back
   * to those defaults. Persisted to `config.json` so user overrides
   * survive restarts.
   */
  retry?: AdapterRetryConfig;
  /**
   * Phase 3 (MCP Tool Search). When true, the chat route surfaces
   * MCP tools to the LLM as stubs (name + truncated description
   * only); the model must call `search_mcp_tools` to retrieve the
   * full JSON Schema before invoking the tool. Saves a lot of
   * tokens when many MCP servers are connected. Also auto-enabled
   * when the total connected MCP tool count exceeds
   * `MCP_TOOL_SEARCH_THRESHOLD` in `constants.ts`.
   */
  mcpToolSearch?: boolean;
  /** Completion mode: 'normal' (default) or 'prompt-loop' (auto-continue). */
  completionMode?: CompletionMode;
  /** Max prompt-loop iterations before giving up; 0 = unlimited. */
  maxPromptLoopIterations?: number;
}
