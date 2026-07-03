import type { SessionTokenStats } from '@/services/history';

import type { ChatMessage } from '../services/llm';

export type CompletionMode = 'normal' | 'prompt-loop';
export type LlmProvider = 'ollama' | 'openai-compatible';

export interface Config {
  provider?: LlmProvider;
  /** API key for OpenAI-compatible providers. Ignored by Ollama. */
  apiKey?: string;
  baseUrl: string;
  /**
   * Persisted model selection. Renamed from `lastModel` to match the
   * in-memory store key (`state.model`) and the UI label ("Model").
   * `lastModel` is still read on load for backward compatibility with
   * older `config.json` files but is no longer written.
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

export interface ChatContext {
  baseUrl: string;
  currentModel: string;
  numCtx: number;
  messages: ChatMessage[];
  currentSessionId: number;
  config: Config;
  systemPrompt: string;
  thinkingSupported?: boolean;
  saveConfig: (config: Config) => Promise<void>;
  updateNumCtx: (numCtx: number) => void;
  saveSession: (tokenStats?: SessionTokenStats | null) => void;
  refreshTokenStatus: (
    phase: string,
    tokensUsedOverride?: number,
    tokenSource?: 'estimated' | 'ollama',
    modelOverride?: string
  ) => void;
  updateModel: (model: string) => Promise<void>;
  updateSession: (sessionId: number, messages: ChatMessage[], sessionNamed: boolean) => void;
  /** Optional override for message input (web API injects this) */
  promptProvider?: (prompt: string) => Promise<string>;
}
