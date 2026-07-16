export type CompletionMode = 'normal' | 'prompt-loop';
export type LlmProvider = 'ollama' | 'openai-compatible';

/**
 * Reasoning effort for OpenAI-compatible providers. Maps to the
 * `reasoning_effort` field on the wire:
 *   - 'off'   → 'none'   (forced off, even for models with reasoning on by default)
 *   - 'none'  → 'none'
 *   - 'minimal' → 'minimal'
 *   - 'low'   → 'low'
 *   - 'medium'→ 'medium'
 *   - 'high'  → 'high'
 *   - 'xhigh' → 'xhigh'
 *
 * Distinct from `thinkingEnabled` (a boolean) which maps to Ollama's
 * `think` field. The two coexist: `reasoningEffort` is for
 * OpenAI-compatible providers, `thinkingEnabled` is for Ollama.
 * Defaults to 'off' (which resolves to 'none') so models with reasoning
 * on by default (e.g. gpt-5.6-luna on the Airia gateway) are not silently
 * forced into reasoning when called with tools.
 */
export type ReasoningEffort = 'off' | 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

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
  /** API key for OpenAI-compatible providers. Ignored by Ollama. */
  apiKey?: string;
  /** Default model for this provider. */
  model?: string;
  /** Per-provider default context window. Falls back to the global numCtx. */
  numCtx?: number;
}

export interface Config {
  provider?: LlmProvider;
  /** API key for OpenAI-compatible providers. Ignored by Ollama. */
  apiKey?: string;
  baseUrl: string;
  /**
   * Multiple provider endpoints, each with their own authentication and
   * default model. When this array is present and non-empty, the UI
   * aggregates models from every provider and the user picks which
   * provider/model to use per turn. The legacy top-level
   * `provider`/`baseUrl`/`apiKey`/`model` fields still act as the
   * default (and only) provider when `providers` is absent or empty.
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
   * Reasoning effort for OpenAI-compatible providers. Maps to the
   * `reasoning_effort` field on the wire:
   *   - 'off'   → 'none'   (forced off, even for models with reasoning on by default)
   *   - 'none'  → 'none'
   *   - 'minimal' → 'minimal'
   *   - 'low'   → 'low'
   *   - 'medium'→ 'medium'
   *   - 'high'  → 'high'
   *   - 'xhigh' → 'xhigh'
   *
   * Distinct from `thinkingEnabled` (a boolean) which maps to Ollama's
   * `think` field. The two coexist: `reasoningEffort` is for
   * OpenAI-compatible providers, `thinkingEnabled` is for Ollama.
   * Defaults to 'off' (which resolves to 'none') so models with reasoning
   * on by default (e.g. gpt-5.6-luna on the Airia gateway) are not silently
   * forced into reasoning when called with tools.
   */
  reasoningEffort?: ReasoningEffort;
  /**
   * When true, the chat route prepends a `[Sent YYYY-MM-DD HH:MM]` header
   * to each user-role message in the LLM-bound conversation. The
   * messages.created_at column is always populated regardless of this flag,
   * so toggling it later retroactively changes LLM visibility for every
   * persisted message. Defaults to true.
   */
  promptTimestamps?: boolean;
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
