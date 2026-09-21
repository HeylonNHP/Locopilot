/**
 * Type definitions for MCP (Model Context Protocol) server support.
 *
 * Phase 2 (standardisation):
 * - All three SDK transports are supported: `stdio`, `http`
 *   (streamable-http), and `sse`.
 * - The on-disk shape (`MCPServerConfig`) was already forward-compatible
 *   with HTTP/SSE in Phase 1; Phase 2 fills in the runtime support.
 * - Per-server `autoApprove` and per-tool `disabledTools` continue to
 *   be enforced; Phase 2 also adds a generalised approval registry
 *   (see `app/lib/approvalRegistry.ts`) that can issue per-tool,
 *   per-call approval tokens.
 * - `notifications/tools/list_changed` is handled via the SDK's
 *   `listChanged.handlers.tools.onChanged` option (see
 *   `mcp/clientManager.ts`).
 */

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// --- On-disk configuration types ---

/**
 * A stdio MCP server: spawned as a subprocess. The server communicates
 * over stdin/stdout using the MCP JSON-RPC protocol.
 */
export interface MCPStdioServerConfig {
  type: 'stdio';
  /** Executable to run (e.g. "npx", "node", "/usr/local/bin/my-mcp"). */
  command: string;
  /** Command-line arguments passed verbatim to the executable. */
  args?: string[] | undefined;
  /**
   * Extra environment variables to add to the child process environment.
   * Values may use the `${env.X}` form (added in Phase 2) to reference
   * the process's environment at load time. The DANGEROUS_ENV_KEYS
   * blocklist is applied — see `mcp/dangerousEnv.ts`.
   */
  env?: Record<string, string> | undefined;
  /** Optional working directory for the spawned process. */
  cwd?: string | undefined;
}

/**
 * HTTP-based MCP server. The SDK uses a `StreamableHTTPClientTransport`
 * which sends JSON-RPC over HTTP POST and may receive responses via
 * SSE on the same connection (the modern MCP transport).
 *
 * Phase 2 also keeps the legacy SSE transport (`type: "sse"`) for
 * compatibility with servers that haven't migrated yet; both types
 * share the same `{ url, headers }` shape.
 */
export interface MCPHttpServerConfig {
  type: 'http' | 'sse';
  url: string;
  /**
   * Optional HTTP headers to send with every JSON-RPC request.
   * Values may use the `${env.X}` form to reference the process's
   * environment at load time (the DANGEROUS_ENV_KEYS blocklist is
   * applied — see `mcp/dangerousEnv.ts`).
   */
  headers?: Record<string, string> | undefined;
}

/**
 * OAuth 2.1 client configuration for an HTTP/SSE MCP server.
 *
 * The MCP spec mandates OAuth 2.1 + PKCE for remote servers. The
 * Locopilot implementation is intentionally minimal: it persists
 * the (deregistered) client ID, the configured scopes, and an
 * optional authorization-server URL override; everything else
 * (tokens, code verifier, dynamically-registered client info) is
 * kept in `~/.locopilot/mcp-oauth-tokens.json` so secrets never
 * land in `mcp.json`.
 */
export interface MCPOAuthConfig {
  /**
   * OAuth 2.1 client ID. If absent, the SDK falls back to Dynamic
   * Client Registration (RFC 7591) if the server advertises a
   * `registration_endpoint`. Most public MCP servers accept this.
   */
  clientId?: string | undefined;
  /**
   * OAuth 2.1 client secret. Most MCP servers don't use one
   * (public clients with PKCE are the recommended pattern), so
   * this is rare. Values may use `${env.X}` expansion at load time
   * (the DANGEROUS_ENV_KEYS blocklist is applied).
   */
  clientSecret?: string | undefined;
  /**
   * SEP-991 / CIMD: a public HTTPS URL the authorization server fetches to
   * identify this client. Required for authorization servers that advertise
   * `client_id_metadata_document_supported: true` but reject RFC 7591 Dynamic
   * Client Registration (e.g. Atlassian's MCP server).
   *
   * MUST be https with a non-root path (the SDK enforces this). The document is
   * fetched by the authorization server over the public internet, so it cannot be
   * a loopback URL. Public information, not a secret. A configured `clientId`
   * always takes precedence.
   */
  clientMetadataUrl?: string | undefined;
  /**
   * OAuth 2.1 scopes to request, as an array of scope strings.
   * The provider joins them with a single space before sending
   * the request, per RFC 6749 §3.3.
   */
  scopes?: string[] | undefined;
  /**
   * Optional override for the authorization server base URL.
   * When set, the SDK skips the RFC 9728 / 8414 well-known
   * discovery dance and uses this URL directly. Useful for
   * private deployments that don't publish the well-known
   * document.
   */
  authorizationServerUrl?: string | undefined;
}

export type MCPTransportConfig = MCPStdioServerConfig | MCPHttpServerConfig;

export interface MCPServerConfig {
  /**
   * Display name for the server. Used as the namespace segment in
   * `mcp__<name>__<tool>` and shown in `/mcp list`. Must match
   * `/^[a-z0-9_-]+$/i` (validated by the loader).
   */
  name: string;
  /** Free-form description shown in listings. */
  description?: string | undefined;
  /** Transport-specific connection details. */
  transport: MCPTransportConfig;
  /**
   * Per-tool allowlist. If present, only the listed tool names are
   * exposed without an explicit approval prompt; everything else goes
   * through the existing approval registry. If absent, every tool call
   * requires approval (Phase 1 default).
   */
  autoApprove?: string[] | undefined;
  /** Per-server timeout in seconds (default: 60). */
  timeoutSeconds?: number | undefined;
  /** Per-server tool blocklist. */
  disabledTools?: string[] | undefined;
  /** Manual override: server is loaded but never connected. */
  disabled?: boolean | undefined;
  /**
   * OAuth 2.1 client configuration. Only meaningful for `http` and
   * `sse` transports. When set, the client manager builds an
   * `OAuthClientProvider` and wires it into the SDK transport so
   * the MCP `initialize` handshake can complete on a 401-protected
   * server. See `mcp/oauthProvider.ts` for the implementation.
   */
  oauth?: MCPOAuthConfig | undefined;
}

/**
 * Shape of the on-disk MCP config file (`~/.locopilot/mcp.json`).
 * The `mcpServers` key is canonical and matches the Claude/Cursor/Cline
 * convention. A top-level `servers` key (VS Code compatibility) is
 * also accepted and normalised to `mcpServers` by the loader.
 */
export interface MCPRootConfig {
  mcpServers: Record<string, MCPServerConfig>;
  /** Reserved for forward compatibility; currently ignored. */
  $schema?: string;
}

// --- OAuth 2.1 + PKCE types (Phase 3.5) ---

/**
 * Subset of the SDK's `OAuthClientInformation` that's safe to
 * round-trip through `mcp.json` (it has no secrets). Tokens and
 * the PKCE code verifier are NEVER written here — they live in
 * `~/.locopilot/mcp-oauth-tokens.json` (see `mcp/oauthTokenStore.ts`).
 */
export interface MCPSavedClientInformation {
  client_id: string;
  client_secret?: string | undefined;
  client_id_issued_at?: number | undefined;
  client_secret_expires_at?: number | undefined;
  /**
   * The `redirect_uris` this client was registered against (F10). Used to
   * detect that the current loopback redirect no longer matches the
   * registration, so we re-register instead of sending a redirect the IdP
   * will reject with `invalid_redirect_uri`.
   *
   * Absent on entries written before this fix — that absence deliberately
   * triggers a one-time re-registration.
   */
  redirect_uris?: string[] | undefined;
}

/** Narrow slice of RFC 8414 authorization-server metadata kept for diagnostics. */
export interface MCPSavedAuthorizationServerMetadata {
  client_id_metadata_document_supported?: boolean | undefined;
  registration_endpoint?: string | undefined;
  authorization_endpoint?: string | undefined;
  token_endpoint?: string | undefined;
}

/**
 * Subset of the SDK's `OAuthTokens` that we persist. We deliberately
 * keep the field names identical to the SDK so the JSON file is
 * round-trippable with no transformation.
 */
export interface MCPSavedOAuthTokens {
  access_token: string;
  id_token?: string | undefined;
  token_type: string;
  expires_in?: number | undefined;
  scope?: string | undefined;
  refresh_token?: string | undefined;
}

/**
 * Persisted state for a single OAuth-enabled MCP server. Kept on
 * disk so the user does not have to re-authenticate on every
 * server restart. The file is `~/.locopilot/mcp-oauth-tokens.json`.
 */
export interface MCPSavedOAuthState {
  /**
   * The dynamically-registered or statically-configured OAuth
   * client information. Empty when DCR hasn't been performed yet
   * (e.g. the user is still on the pre-auth handshake).
   */
  clientInformation?: MCPSavedClientInformation | undefined;
  /**
   * The most recently issued token set. The SDK uses this on the
   * next connect; on a 401 it falls back to refresh-token flow.
   */
  tokens?: MCPSavedOAuthTokens | undefined;
  /**
   * The PKCE code verifier for an in-flight authorization flow.
   * Cleared once the code is exchanged. Only present for the
   * brief window between the user opening the auth URL and the
   * callback hitting our loopback server.
   *
   * @deprecated Superseded by `codeVerifiers` (F18). Still read as a
   * fallback so an entry written by an older build keeps working.
   */
  codeVerifier?: string | undefined;
  /**
   * PKCE code verifiers for in-flight flows, keyed by the OAuth `state`
   * (flow id) — F18. Two overlapping flows for one server used to share a
   * single slot, so flow B's verifier overwrote flow A's and the second
   * token exchange failed with `invalid_grant`. Pruned per-flow on success
   * or abandonment.
   */
  codeVerifiers?: Record<string, string> | undefined;
  /**
   * Last known authorization server URL (from RFC 9728 / 8414
   * discovery, or the static override). Persisted so subsequent
   * auth attempts can skip the well-known round-trip.
   */
  authorizationServerUrl?: string | undefined;
  /**
   * The narrow slice of the RFC 8414 authorization-server metadata that
   * discovery returned. Persisted so a later classification of a failed
   * auth attempt can tell whether the server advertised CIMD / DCR without
   * re-running discovery. Never contains secrets.
   */
  authorizationServerMetadata?: MCPSavedAuthorizationServerMetadata | undefined;
  /**
   * Pinned loopback port for this server's OAuth callback (F10). Pinning
   * keeps the `redirect_uri` stable across restarts so a persisted
   * dynamically-registered client stays valid. Absent until the first auth
   * attempt allocates one.
   */
  loopbackPort?: number | undefined;
}

/**
 * The on-disk shape of `~/.locopilot/mcp-oauth-tokens.json`.
 * Top-level `version` is reserved for forward-compat schema
 * migrations (we currently use `1`).
 */
export interface MCPOAuthTokenStoreFile {
  version: 1;
  servers: Record<string, MCPSavedOAuthState>;
}

// --- Runtime / process-global types ---

export type MCPConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'error'
  | 'auth_required';

export interface MCPToolInfo {
  name: string;
  description: string | undefined;
  /**
   * JSON Schema describing the tool's input parameters.
   *
   * F3: the index signature carries every extra JSON-Schema keyword the
   * server sent (`$defs`, `definitions`, `$ref`, `additionalProperties`,
   * `$schema`, `title`, …). Those used to be dropped when the schema was
   * handed to the model, which broke any fastmcp/pydantic/zod-generated
   * server that emits `$ref` into `$defs` — the model saw a dangling
   * reference it could not resolve.
   */
  inputSchema: {
    type: 'object';
    properties?: Record<string, unknown> | undefined;
    required?: string[] | undefined;
    [schemaKeyword: string]: unknown;
  };
}

/**
 * Concrete SDK transport union. The three transports expose slightly
 * different surfaces (e.g. only the streamable-HTTP transport has
 * `terminateSession()`); `clientManager` handles those with duck-typing.
 *
 * Retained on the handle so teardown can release the remote HTTP session
 * (F22) and reap the stdio process tree before the SDK drops the pid (F6).
 */
export type MCPClientTransport =
  | StdioClientTransport
  | StreamableHTTPClientTransport
  | SSEClientTransport;

/**
 * A live connection to a single MCP server. Process-global (one per
 * server name). Per-request state (AbortSignal, approval tokens) is
 * passed alongside the call and never stored here.
 */
export interface MCPClientHandle {
  name: string;
  config: MCPServerConfig;
  client: Client;
  status: MCPConnectionStatus;
  tools: MCPToolInfo[];
  lastError?: string;
  lastConnectedAt?: number;
  /**
   * Retained so teardown can close it exactly once, terminate the HTTP
   * session (F22) and tree-kill the stdio child (F6). The final connected
   * handle used to drop it (only the connecting placeholder kept one), so
   * `connect()`'s stale-handle path and the non-fatal-error path could never
   * reach the live transport and leaked the client/child process (F5).
   * Optional because handles that never finished connecting have none.
   */
  transport?: MCPClientTransport | undefined;
  /** Per-connect AbortController, signalled by teardown to unwind in-flight work (F5/F9). */
  abortController?: AbortController | undefined;
  /** F7: consecutive auto-connect failures. Reset on success / forced connect. */
  failureCount?: number | undefined;
  /** F7: epoch-ms; an implicit auto-connect must NOT dial before this. */
  nextRetryAt?: number | undefined;
}

// --- Error classes ---

/** Thrown when the on-disk config is malformed and unrecoverable. */
export class MCPConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MCPConfigError';
  }
}

/** Thrown when a transport (stdio) fails to start, or the handshake fails. */
export class MCPConnectionError extends Error {
  constructor(
    message: string,
    public readonly serverName?: string
  ) {
    super(message);
    this.name = 'MCPConnectionError';
  }
}
