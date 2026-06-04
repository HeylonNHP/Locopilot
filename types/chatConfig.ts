import type { ChatMessage } from '../services/llm';
import type { SessionTokenStats } from '../history';

export interface Config {
    baseUrl: string;
    lastModel?: string;
    compactionModel?: string;
    numCtx?: number;
    chatTimeoutMs?: number;
    yolo?: boolean;
    thinkingEnabled?: boolean;
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
        modelOverride?: string,
    ) => void;
    updateModel: (model: string) => Promise<void>;
    updateSession: (sessionId: number, messages: ChatMessage[], sessionNamed: boolean) => void;
    /** Optional override for message input (web API injects this) */
    promptProvider?: (prompt: string) => Promise<string>;
}
