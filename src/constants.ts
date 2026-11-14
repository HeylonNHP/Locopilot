// Shared global constants used across Locopilot modules.
export const DEFAULT_OLLAMA_CHAT_TIMEOUT_MS = 720_000; // 12 minutes// connection check timeout
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
 * Maximum number of result pages one `web_search` call downloads and extracts
 * at the same time, SHARED by all of its queries (they run in parallel). A page
 * holds its slot until its compaction finishes, so this stays a little above
 * `WEB_COMPACTION_MAX_CONCURRENT_REQUESTS`: the compaction slots stay full
 * while a few more pages download. Higher values reduce wall-clock time but
 * risk rate-limiting by target sites.
 */
export const DEFAULT_WEB_SEARCH_PARALLEL_PAGE_FETCHES = 12;

/**
 * Longest a SINGLE web-page compaction request (one LLM call) may run before it
 * is abandoned. The page then falls back to its first `perPageCharLimit`
 * characters, and the tool result SAYS so (see `buildTruncationNote`). Before
 * this existed the call inherited the 12-minute chat timeout, so one hung call
 * held a whole query for 12 minutes. Raise it if you compact with a slow local
 * model; lowering it trades summaries for speed.
 */
export const WEB_COMPACTION_REQUEST_TIMEOUT_MS = 60_000;

/**
 * Most web-page compaction requests in flight at once, across EVERY query and
 * every `web_search` / `fetch_url` call in the process. This is the throttle
 * that keeps a 10-query search from sending 150 requests at a provider at once:
 * Ollama Cloud answered 429 to about half of 32 simultaneous compactions
 * (CONFIRMATIONS.md A-010). Raise it for a provider with a higher limit.
 */
export const WEB_COMPACTION_MAX_CONCURRENT_REQUESTS = 10;

/**
 * Retry policy for a compaction request that fails with a transient status
 * (429, 5xx, ...). Total attempts, then an exponential backoff from the base
 * delay up to the ceiling; a server `Retry-After` is honoured, up to the
 * ceiling. Not used for an OpenAI-compatible provider, whose adapter retries
 * on its own (see `src/services/adapters/openaiCompatibleAdapter.ts`).
 */
export const WEB_COMPACTION_RETRY_MAX_ATTEMPTS = 4;
export const WEB_COMPACTION_RETRY_BASE_DELAY_MS = 1_000;
export const WEB_COMPACTION_RETRY_MAX_DELAY_MS = 16_000;

/**
 * DuckDuckGo searches in flight at once within one `web_search` call. The
 * queries run in parallel; this and the stagger below are what keep that from
 * looking like a burst to DuckDuckGo (which answers a burst with a CAPTCHA).
 */
export const WEB_SEARCH_MAX_CONCURRENT_SEARCHES = 3;

/** Query N waits N × this long before its first DuckDuckGo request. */
export const WEB_SEARCH_QUERY_START_STAGGER_MS = 300;
export const IMAGE_TOKEN_ESTIMATE = 1024;
export const APPROX_CHARS_PER_TOKEN = 4;
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

/**
 * How long the updates of a conversation that is NOT on screen may wait before
 * they are applied to the store together (`src/app/lib/updateBatcher.ts`).
 * Nothing about a background stream is visible except the sidebar's streaming
 * dot (which is never batched), and every ordinary dispatch — a session
 * switch, a turn's end, an error — applies the queue first, so a longer
 * interval costs nothing the user can see while it saves a re-render of the
 * conversation on screen for every piece of text that arrives behind it.
 */
export const BACKGROUND_UPDATE_INTERVAL_MS = 1000;

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

/**
 * How many auto-compactions in a row may FAIL in one turn before the chat
 * route stops trying for the rest of that turn.
 *
 * WHY a latch is needed: the trigger fires on a RESERVED MARGIN (see
 * `computeCompactionTriggerTokens`), so it is reached earlier and stays
 * reached — a compaction that throws leaves the history exactly as it was,
 * which means the very next loop iteration would try again, and again, paying
 * for the same summarisation each time. Two attempts keep a transient provider
 * failure recoverable; a third against the same unchanged history is not going
 * to fail differently. The sub-agent path is deliberately stateless: it is
 * re-entered from scratch on each of its own iterations, and its history is
 * short-lived.
 */
export const MAX_COMPACTION_FAILURES_PER_TURN = 2;

/** Context floor for the compact split/measure routines (same value as in `compact/measure.ts`). */
export const MEASUREMENT_CTX_FLOOR = 32_768;

/** Default prompt-loop iteration cap before giving up; 0 = unlimited. */
export const DEFAULT_MAX_PROMPT_LOOP_ITERATIONS = 4;

/**
 * Consecutive final responses containing an invalid ```mermaid fence that are
 * rejected and retried with a syntax-error fix-up nudge before the response is
 * accepted as-is (0 disables the check entirely). Separate from the
 * empty-response cap so the two recovery streaks cannot starve each other.
 */
export const MAX_MERMAID_RECOVERY_ATTEMPTS = 3;

// ── Tool / process lifecycle ──────────────────────────────────────────────

/** Default `run_command` timeout (the legacy `DEFAULT_TIMEOUT_MS` in runCommandTool). */
export const RUN_COMMAND_TIMEOUT_MS = 30_000;

/** Maximum captured UTF-8 bytes retained for each run_command output stream. */
export const RUN_COMMAND_OUTPUT_MAX_BYTES = 256 * 1024;

/** Bytes of a run_command stream that may be inlined into the tool result verbatim. */
export const RUN_COMMAND_INLINE_MAX_BYTES = 8 * 1024;

/** Bytes kept from the head of a run_command stream when the output is too large to inline. */
export const RUN_COMMAND_HEAD_PREVIEW_BYTES = 32 * 1024;

/** Bytes kept from the tail of a run_command stream when the output is too large to inline. */
export const RUN_COMMAND_TAIL_PREVIEW_BYTES = 8 * 1024;

/** Hard cap on the bytes written to a single run_command spool file. */
export const RUN_COMMAND_MAX_SPOOL_BYTES = 10 * 1024 * 1024;

/** How long a run_command artifact is kept before the sweeper evicts it. */
export const RUN_OUTPUT_RETENTION_MS = 24 * 60 * 60 * 1000;

/** Maximum number of artifacts one session may keep. */
export const RUN_OUTPUT_SESSION_MAX_FILES = 100;

/** Maximum total size of the artifacts one session may keep. */
export const RUN_OUTPUT_SESSION_MAX_BYTES = 250 * 1024 * 1024;

/** Maximum number of artifacts kept across every session. */
export const RUN_OUTPUT_GLOBAL_MAX_FILES = 1000;

/** Maximum total size of the artifacts kept across every session. */
export const RUN_OUTPUT_GLOBAL_MAX_BYTES = 1024 * 1024 * 1024;

/** Minimum interval between two sweeps of the run output store. */
export const RUN_OUTPUT_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

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
