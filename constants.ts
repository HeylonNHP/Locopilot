// Shared global constants used across Locopilot modules.
export const DEFAULT_OLLAMA_CHAT_TIMEOUT_MS = 720_000; // 12 minutes
export const OLLAMA_CONNECT_TIMEOUT_MS = 5000; // connection check timeout
export const DEFAULT_NUM_CTX = 131072;
export const DEFAULT_WEB_SEARCH_MAX_QUERIES = 3;
export const DEFAULT_WEB_SEARCH_RESULTS_PER_QUERY = 3;
export const DEFAULT_WEB_SEARCH_PER_PAGE_CHAR_LIMIT = 5000;
export const AUTO_COMPACT_THRESHOLD_PCT = 92;
export const COMPACT_WARNING_THRESHOLD_PCT = 85;
export const COMPACT_WARNING_TOKEN_INTERVAL = 500;
export const MAX_EMPTY_RESPONSE_RECOVERY_ATTEMPTS = 2;
export const READ_FILE_TOKEN_WARN_PCT = 25;
export const READ_FILE_TOKEN_CRITICAL_PCT = 50;