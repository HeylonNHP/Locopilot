// Shared global constants used across Locopilot modules.
export const DEFAULT_OLLAMA_CHAT_TIMEOUT_MS = 720_000; // 12 minutes
export const OLLAMA_CONNECT_TIMEOUT_MS = 5000; // connection check timeout
export const DEFAULT_NUM_CTX = 131072;
export const DEFAULT_WEB_SEARCH_MAX_QUERIES = 3;
export const DEFAULT_WEB_SEARCH_RESULTS_PER_QUERY = 3;
export const DEFAULT_WEB_SEARCH_PER_PAGE_CHAR_LIMIT = 5000;
export const IMAGE_TOKEN_ESTIMATE = 1024;
export const APPROX_CHARS_PER_TOKEN = 4;
export const AUTO_COMPACT_THRESHOLD_PCT = 92;
export const COMPACT_WARNING_THRESHOLD_PCT = 85;
export const COMPACT_WARNING_TOKEN_INTERVAL = 500;
export const MAX_EMPTY_RESPONSE_RECOVERY_ATTEMPTS = 2;
export const READ_FILE_TOKEN_WARN_PCT = 25;
export const READ_FILE_TOKEN_CRITICAL_PCT = 50;
export const READ_FILE_CHAR_WARN_THRESHOLD = 100_000; // ~25,000 tokens — warns when model/context size unknown

/**
 * Phase 3 (MCP Tool Search). If the total number of connected MCP
 * tools exceeds this threshold, the chat route automatically flips to
 * the lazy "stub" tool-definitions path even if the user hasn't
 * explicitly enabled `config.mcpToolSearch`. Keeps the per-turn tool
 * token cost bounded as the user connects more servers.
 */
export const MCP_TOOL_SEARCH_THRESHOLD = 20;