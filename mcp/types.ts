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

// --- Runtime / process-global types ---

export type MCPConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface MCPToolInfo {
    name: string;
    description: string | undefined;
    /** JSON Schema describing the tool's input parameters. */
    inputSchema: {
        type: 'object';
        properties?: Record<string, unknown> | undefined;
        required?: string[] | undefined;
    };
}

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
    constructor(message: string, public readonly serverName?: string) {
        super(message);
        this.name = 'MCPConnectionError';
    }
}

/** Thrown for protocol-level errors (invalid JSON-RPC, unexpected response, etc.). */
export class MCPProtocolError extends Error {
    constructor(message: string, public readonly serverName?: string) {
        super(message);
        this.name = 'MCPProtocolError';
    }
}
