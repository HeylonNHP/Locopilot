// Shared global constants used across Locopilot modules.
export const DEFAULT_OLLAMA_CHAT_TIMEOUT_MS = 720_000; // 12 minutes// connection check timeout
export const DEFAULT_NUM_CTX = 131072;
export const DEFAULT_WEB_SEARCH_MAX_QUERIES = 3;
export const DEFAULT_WEB_SEARCH_RESULTS_PER_QUERY = 3;
export const DEFAULT_WEB_SEARCH_PER_PAGE_CHAR_LIMIT = 5000;
export const DEFAULT_WEB_REQUEST_TIMEOUT_MS = 15_000;
/**
 * Timeout for model listing / info probes (`/v1/models`, `/api/tags`,
 * `/api/show`). Some hosted OpenAI-compatible endpoints (e.g. OpenRouter
 * and reverse-proxied gateways) routinely take 20–30 s to respond on the
 * first call, well past the 15 s web-search budget. The response is
 * cached for 5 minutes, so this delay only matters once per window.
 */
export const MODEL_LIST_TIMEOUT_MS = 60_000;
/**
 * Maximum number of result pages to fetch in parallel for a single
 * `web_search` query. Higher values reduce wall-clock time but risk
 * rate-limiting by target sites.
 */
export const DEFAULT_WEB_SEARCH_PARALLEL_PAGE_FETCHES = 5;
export const IMAGE_TOKEN_ESTIMATE = 1024;
export const APPROX_CHARS_PER_TOKEN = 4;
export const AUTO_COMPACT_THRESHOLD_PCT = 92;
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

/** Default name for newly created sessions before a title is generated. */
export const DEFAULT_SESSION_NAME = 'New chat';

// ── Stream & keepalive timeouts ────────────────────────────────────────────

/** SSE keepalive interval for the chat stream. Emits a `: \n\n` comment. */
export const SSE_KEEPALIVE_MS = 5_000;

/** SSE keepalive interval for the MCP events stream. Longer than chat because MCP traffic is sparse. */
export const MCP_SSE_KEEPALIVE_MS = 15_000;

// ── Image upload / fetch timeouts ─────────────────────────────────────────

/** Abort timeout for the client-side image upload pipeline. */
export const IMAGE_UPLOAD_TIMEOUT_MS = 60_000;

/** Default fetch timeout for the `fetch_image` tool. */
export const IMAGE_FETCH_TIMEOUT_MS = 60_000;

// ── TPS status / retry defaults (mirror `configDefaults.ts`) ──────────────

/** Min interval between TPS-bearing `status` events emitted by the chat route. */
export const TPS_STATUS_MIN_INTERVAL_MS = 800;

/** Backoff ceiling for compaction aggressive-retry factor (`Math.max(1.5, …)`). */
export const COMPACT_MIN_RETRY_FACTOR = 1.5;
/** Compaction aggressive-retry target ratio (`newTokenCount / (numCtx * 0.75)`). */
export const COMPACT_RETRY_TARGET_RATIO = 0.75;

// ── Cache TTLs ─────────────────────────────────────────────────────────────

/** TTL for the model cap cache and the vision-support cache (kept in lockstep). */
export const CAP_CACHE_TTL_MS = 5 * 60 * 1_000;

// ── Compaction pipeline ────────────────────────────────────────────────────

/** Minimum message count before auto-compact will run. */
export const MIN_MESSAGES_FOR_COMPACTION = 4;

/** Context floor for the compact split/measure routines (same value as in `compact/measure.ts`). */
export const MEASUREMENT_CTX_FLOOR = 32_768;

/** Default prompt-loop iteration cap before giving up; 0 = unlimited. */
export const DEFAULT_MAX_PROMPT_LOOP_ITERATIONS = 4;

// ── Tool / process lifecycle ──────────────────────────────────────────────

/** Default `run_command` timeout (the legacy `DEFAULT_TIMEOUT_MS` in runCommandTool). */
export const RUN_COMMAND_TIMEOUT_MS = 30_000;

/** Maximum captured UTF-8 bytes retained for each run_command output stream. */
export const RUN_COMMAND_OUTPUT_MAX_BYTES = 256 * 1024;

/** TTL after which the process registry forgets an entry. */
export const PROCESS_REGISTRY_TTL_MS = 5 * 60 * 1_000;

/** Per-page fetch budget enforced by the web search DDG pagination step. */
export const DDG_PAGE_2_OFFSET = 10;
/** Per-page offset step for DDG pagination beyond page 2. */
export const DDG_PAGE_N_OFFSET_STEP = 15;

// ── HTTP status codes (light-weight) ──────────────────────────────────────

/** HTTP 400 Bad Request — used as the status for validation-error early returns. */
export const HTTP_BAD_REQUEST = 400;
/** HTTP 403 Forbidden. */
export const HTTP_FORBIDDEN = 403;
/** HTTP 404 Not Found. */
export const HTTP_NOT_FOUND = 404;
/** HTTP 408 Request Timeout. */
export const HTTP_REQUEST_TIMEOUT = 408;
/** HTTP 409 Conflict. */
export const HTTP_CONFLICT = 409;
/** HTTP 413 Payload Too Large. */
export const HTTP_PAYLOAD_TOO_LARGE = 413;
/** HTTP 422 Unprocessable Entity. */
export const HTTP_UNPROCESSABLE_ENTITY = 422;
/** HTTP 429 Too Many Requests. */
export const HTTP_TOO_MANY_REQUESTS = 429;
/** HTTP 500 Internal Server Error. */
export const HTTP_INTERNAL_SERVER_ERROR = 500;
/** HTTP 502 Bad Gateway. */
export const HTTP_BAD_GATEWAY = 502;
/** HTTP 503 Service Unavailable. */
export const HTTP_SERVICE_UNAVAILABLE = 503;
/** HTTP 504 Gateway Timeout. */
export const HTTP_GATEWAY_TIMEOUT = 504;

// ── SSE content type ──────────────────────────────────────────────────────

/** Content-Type for SSE responses (the literal `text/event-stream`). */
export const SSE_CONTENT_TYPE = 'text/event-stream';
