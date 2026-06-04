/**
 * Process-global registry of live MCP server connections.
 *
 * Phase 2 policy:
 * - All three SDK transports are supported: `stdio`, `http`
 *   (streamable-http), and `sse`.
 * - Connections are lazy: nothing is spawned until the first call to
 *   `connect()` for a given server, or until a tool call needs the
 *   connection. The full `connectAll()` (eager warmup) is available
 *   but is not invoked at startup.
 * - One `Client` per server name; multiple concurrent tool calls
 *   against the same server share the same client.
 * - `notifications/tools/list_changed` is handled by the SDK's
 *   built-in `listChanged.handlers.tools.onChanged` callback (the
 *   SDK re-fetches the tool list and hands us the updated array).
 * - Per-request state (AbortSignal, approval tokens) is **not** stored
 *   on the handle. It's passed into `callTool()` from the dispatcher.
 * - `shutdown()` is wired to `process.on('SIGTERM')` and the Next.js
 *   `process.on('beforeExit')` so spawned subprocesses are reaped when
 *   the dev server stops.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import {
    MCPConnectionError,
    type MCPClientHandle,
    type MCPRootConfig,
    type MCPServerConfig,
    type MCPToolInfo,
} from './types';
import { expandEnvRefsInRecord } from './envExpansion';

const CLIENT_NAME = 'locopilot';
const CLIENT_VERSION = '0.0.1';

const DEFAULT_TIMEOUT_SECONDS = 60;

/**
 * Build the appropriate SDK transport for a given server config.
 *
 * - stdio  → StdioClientTransport (spawns a subprocess)
 * - http   → StreamableHTTPClientTransport (HTTP POST + optional SSE)
 * - sse    → SSEClientTransport (legacy; still common in the wild)
 *
 * Env-var expansion (`${env.X}`) is applied to the `headers` field
 * here (defence in depth — `configLoader` already expands them, but
 * the runtime also expands in case a server was added via a future
 * API that bypasses the loader).
 *
 * Return type is the union of the three concrete SDK classes rather
 * than the `Transport` interface because the SDK ships a known type
 * mismatch: `StreamableHTTPClientTransport.sessionId` is exposed via a
 * `string | undefined` getter that doesn't satisfy the interface's
 * `sessionId?: string` declaration. The concrete classes themselves
 * do satisfy the interface at runtime.
 */
function buildTransport(config: MCPServerConfig): StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport {
    const transport = config.transport;
    if (transport.type === 'stdio') {
        const stdioArgs: {
            command: string;
            args?: string[];
            env?: Record<string, string>;
            cwd?: string;
        } = {
            command: transport.command,
            args: transport.args ?? [],
        };
        if (transport.env !== undefined) stdioArgs.env = transport.env;
        if (transport.cwd !== undefined) stdioArgs.cwd = transport.cwd;
        return new StdioClientTransport(stdioArgs);
    }

    // HTTP / SSE: parse the URL once so malformed configs fail loudly.
    const url = new URL(transport.url);
    // Re-expand env vars at runtime (the loader already did this; this
    // is defence in depth for any config added through a non-loader path).
    const headersResult = expandEnvRefsInRecord(
        transport.headers,
        `MCP server "${config.name}" headers`,
    );
    if (headersResult.warnings.length > 0) {
        for (const w of headersResult.warnings) console.warn(`[mcp] ${w}`);
    }
    const headers = headersResult.expanded ?? {};

    if (transport.type === 'http') {
        // Pass headers via requestInit so the SDK sends them on every POST
        // (including the initial `initialize` request). We deliberately do
        // NOT set `authProvider` — OAuth is a Phase 3 concern (see plan).
        return new StreamableHTTPClientTransport(url, {
            requestInit: { headers },
        });
    }

    // SSE — the SDK keeps SSEClientTransport around for legacy servers.
    // We pass `requestInit.headers` for the POST side; the initial SSE
    // request is opened by the SDK and will not pick up these headers
    // (the SDK has a separate `eventSourceInit` for that, which we
    // intentionally leave alone so users don't accidentally break
    // auth by editing two fields).
    return new SSEClientTransport(url, {
        requestInit: { headers },
    });
}

/**
 * Connecting-placeholder handle. Carries the transport + abort controller so
 * `disconnect()` / `closeAll()` can tear down the in-flight spawn even if
 * `client.connect(transport)` never completes.
 */
interface ConnectingHandle {
    name: string;
    config: MCPServerConfig;
    status: 'connecting';
    client: undefined;
    /**
     * Concrete SDK transport. Typed as the concrete-union return type
     * of `buildTransport()` rather than the SDK's `Transport` interface
     * because `StreamableHTTPClientTransport.sessionId` is `string |
     * undefined` (via a getter) which doesn't satisfy the interface's
     * `sessionId?: string` declaration under `exactOptionalPropertyTypes`.
     */
    transport: StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport;
    abortController: AbortController;
    tools: [];
    /** Resolved when the connecting promise resolves (success or failure). */
    settled: Promise<void>;
    /** Set by the in-flight connect task; cleared on settle. */
    setHandle: (handle: MCPClientHandle) => void;
    setError: (err: unknown) => void;
}

class MCPClientManager {
    /**
     * Live, fully-connected handles. The value is the resolved
     * `MCPClientHandle`. The map is the source of truth for status
     * queries (`get` / `list`).
     */
    private handles = new Map<string, MCPClientHandle>();

    /**
     * In-flight connect promises, keyed by server name. Multiple
     * concurrent callers receive the SAME promise, so we never spawn
     * the same subprocess twice. The promise resolves to the final
     * `MCPClientHandle` (or rejects with `MCPConnectionError`).
     */
    private inFlight = new Map<string, Promise<MCPClientHandle>>();

    private rootConfig: MCPRootConfig = { mcpServers: {} };

    /**
     * Replace the in-memory root config without affecting already-open
     * connections. Callers (e.g. `reloadMCP()`) explicitly close existing
     * handles before calling this.
     */
    setRootConfig(config: MCPRootConfig): void {
        this.rootConfig = config;
    }

    getRootConfig(): MCPRootConfig {
        return this.rootConfig;
    }

    /**
     * Lazily connect to the named server. Idempotent: returns the
     * existing handle if already connected, or awaits the in-flight
     * connect if one is already running.
     */
    connect(serverName: string): Promise<MCPClientHandle> {
        // Already connected? Return the cached handle.
        const existing = this.handles.get(serverName);
        if (existing && existing.status === 'connected') {
            return Promise.resolve(existing);
        }

        // Another caller is connecting? Reuse the in-flight promise so
        // we don't spawn a duplicate subprocess. This replaces the
        // older "poll the handles map" pattern (which had no timeout —
        // see A9 in the bug report). The shared promise itself bounds
        // the wait because it resolves once `client.connect()` returns
        // (or rejects if the handshake fails).
        const inFlight = this.inFlight.get(serverName);
        if (inFlight) return inFlight;

        const config = this.rootConfig.mcpServers[serverName];
        if (!config) {
            return Promise.reject(new MCPConnectionError(`unknown MCP server "${serverName}"`, serverName));
        }
        if (config.disabled) {
            return Promise.reject(new MCPConnectionError(`MCP server "${serverName}" is disabled in config`, serverName));
        }

        const promise = this.openConnection(serverName, config);
        this.inFlight.set(serverName, promise);
        // Clean up the in-flight map once settled (success OR failure)
        // so future calls either reuse the cached handle or start a
        // fresh connect.
        const cleanup = (): void => {
            if (this.inFlight.get(serverName) === promise) {
                this.inFlight.delete(serverName);
            }
        };
        promise.then(cleanup, cleanup);
        return promise;
    }

    /**
     * Internal: perform the actual connect. Creates the transport,
     * the client, and the AbortController that `disconnect()` will
     * signal on. The connecting placeholder is stored in
     * `handles` immediately so the status query works mid-handshake.
     */
    private async openConnection(serverName: string, config: MCPServerConfig): Promise<MCPClientHandle> {
        // Phase 2: build the SDK transport from the config. The transport
        // is built BEFORE the client so a malformed URL or invalid header
        // fails fast (synchronously) — no need to start a subprocess.
        const transport = buildTransport(config);

        // Phase 2 (feature C): wire up the `notifications/tools/list_changed`
        // handler. The SDK only activates the handler if the server
        // advertises `capabilities.tools.listChanged: true`, so this is
        // a no-op for servers that don't support live tool updates. When
        // a notification arrives, the SDK re-fetches the tool list and
        // hands us the new array via `onChanged`.
        const onToolsChanged = (err: Error | null, items: unknown): void => {
            if (err) {
                console.error(`[mcp:${serverName}] tools/list_changed failed: ${err.message}`);
                return;
            }
            // The SDK passes the auto-refreshed tool array as `items` (typed
            // as Tool[] but treated as unknown at the Client constructor
            // signature). We re-project it into our `MCPToolInfo` shape and
            // patch the live handle so the next chat request sees the new
            // tool list immediately.
            const handle = this.handles.get(serverName);
            if (!handle || handle.status !== 'connected') return;
            const newTools: MCPToolInfo[] = Array.isArray(items)
                ? items.map((t) => {
                    const tt = t as { name?: unknown; description?: unknown; inputSchema?: unknown };
                    const inputSchema = (tt.inputSchema && typeof tt.inputSchema === 'object')
                        ? (tt.inputSchema as MCPToolInfo['inputSchema'])
                        : { type: 'object' as const };
                    return {
                        name: typeof tt.name === 'string' ? tt.name : '',
                        description: typeof tt.description === 'string' ? tt.description : undefined,
                        inputSchema,
                    };
                }).filter((t) => t.name.length > 0)
                : [];
            // Apply per-server `disabledTools` filter so the list matches
            // what the dispatcher would expose.
            const blocklist = handle.config.disabledTools ?? [];
            handle.tools = newTools.filter((t) => !blocklist.includes(t.name));
            console.log(`[mcp:${serverName}] tool list refreshed: ${handle.tools.length} tool(s)`);
        };

        const client = new Client(
            { name: CLIENT_NAME, version: CLIENT_VERSION },
            {
                capabilities: {},
                listChanged: {
                    tools: {
                        autoRefresh: true,
                        onChanged: onToolsChanged,
                    },
                },
            },
        );

        // Per-connect AbortController — signalled by `disconnect()` so the
        // SDK tears down the JSON-RPC request in flight. This is the
        // cleanest way to make `reloadMCP()` (or any in-flight abort) kill
        // a child that has already been spawned and is currently waiting
        // on `listTools()` / `callTool()`.
        const abortController = new AbortController();

        client.onerror = (err) => {
            const handle = this.handles.get(serverName);
            if (handle) {
                handle.status = 'error';
                handle.lastError = err.message;
            }
            // Route server-side stderr-ish errors to the locopilot stderr
            // so they show up in the dev-server log without crashing anything.
            console.error(`[mcp:${serverName}] client error: ${err.message}`);
        };

        client.onclose = () => {
            const handle = this.handles.get(serverName);
            if (handle && handle.status !== 'error') {
                handle.status = 'disconnected';
            }
        };

        // Install the connecting placeholder so `disconnect()` /
        // `closeAll()` can find and tear down the transport + child
        // process even if `client.connect()` never returns. We resolve
        // / reject the promise via a deferred pair stored on the
        // placeholder; the spawn task below calls them when it settles.
        let resolvePlaceholder!: (handle: MCPClientHandle) => void;
        let rejectPlaceholder!: (err: unknown) => void;
        const settled = new Promise<void>((resolve, reject) => {
            resolvePlaceholder = () => resolve();
            rejectPlaceholder = (err) => reject(err);
        });
        const placeholder: ConnectingHandle = {
            name: serverName,
            config,
            status: 'connecting',
            client: undefined,
            transport,
            abortController,
            tools: [],
            settled,
            setHandle: resolvePlaceholder,
            setError: rejectPlaceholder,
        };
        // Cast through unknown: `handles` is typed as MCPClientHandle, but
        // the connecting placeholder is structurally compatible (all
        // required fields except `client` are set, and `status` is the
        // literal 'connecting'). The D2 fix prefers a real alias, but
        // since the map is read-only and `disconnect` is the only place
        // that mutates during the connecting phase, we keep a single
        // union type here for type safety.
        this.handles.set(serverName, placeholder as unknown as MCPClientHandle);

        try {
            // Pass the AbortSignal into client.connect() so the SDK
            // tears down the handshake cleanly if the user aborts /
            // disconnects while we're still initialising.
            // The cast to `Transport` is required because the SDK
            // ships a known type mismatch on `StreamableHTTPClientTransport.sessionId`
            // (getter is `string | undefined` but the interface declares
            // `sessionId?: string`). All three concrete classes do
            // structurally implement the interface at runtime.
            await client.connect(transport as unknown as Transport, { signal: abortController.signal });
            if (abortController.signal.aborted) {
                // disconnect() won the race — close everything and bail.
                try { await client.close(); } catch { /* ignore */ }
                throw new MCPConnectionError(`MCP server "${serverName}" connection was aborted before completion`, serverName);
            }

            const listResult = await client.listTools(undefined, { signal: abortController.signal });
            const tools: MCPToolInfo[] = listResult.tools.map((t) => ({
                name: t.name,
                description: t.description,
                inputSchema: {
                    type: 'object' as const,
                    ...(t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : {}),
                },
            }));

            const handle: MCPClientHandle = {
                name: serverName,
                config,
                client,
                status: 'connected',
                tools,
                lastConnectedAt: Date.now(),
            };
            this.handles.set(serverName, handle);
            placeholder.setHandle(handle);
            return handle;
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            const failed: MCPClientHandle = {
                name: serverName,
                config,
                client,
                status: 'error',
                tools: [],
                lastError: message,
            };
            // Only overwrite the placeholder with a failed handle if
            // nobody else has already replaced it (e.g. disconnect()
            // ran and cleared the entry).
            if (this.handles.get(serverName) === (placeholder as unknown as MCPClientHandle)) {
                this.handles.set(serverName, failed);
            }
            placeholder.setError(err);
            // Best-effort: tear down the child if the SDK didn't already
            // (the AbortSignal should have done this, but be defensive).
            try { await transport.close(); } catch { /* ignore */ }
            throw new MCPConnectionError(message, serverName);
        }
    }

    /**
     * Returns the current handle without attempting a connection.
     */
    get(serverName: string): MCPClientHandle | undefined {
        return this.handles.get(serverName);
    }

    /**
     * List all currently-known handles (any status).
     */
    list(): MCPClientHandle[] {
        return Array.from(this.handles.values());
    }

    /**
     * Disconnect and remove a single server. Idempotent. Safe to call
     * while a connect is in flight: we abort the in-flight connect
     * and await its settlement before closing the transport, so the
     * child process is always reaped exactly once.
     */
    async disconnect(serverName: string): Promise<void> {
        // 1. Capture the in-flight promise (if any) so we can await it
        //    inside the try/finally and guarantee the transport gets
        //    closed even if the connect resolves concurrently.
        const inFlight = this.inFlight.get(serverName);

        // 2. Look up the current handle. It may be a connecting
        //    placeholder OR a fully-connected client.
        const handle = this.handles.get(serverName);
        if (!handle && !inFlight) return;
        this.handles.delete(serverName);

        // 3. Signal the AbortController so any in-flight SDK call
        //    (handshake or listTools) rejects cleanly. Do this BEFORE
        //    closing the transport so the SDK has a chance to unwind.
        if (handle && handle.status === 'connecting') {
            const placeholder = handle as unknown as ConnectingHandle;
            try { placeholder.abortController.abort(); } catch { /* ignore */ }
        }

        // 4. Await the in-flight connect (if any) so its catch block
        //    has a chance to clean up; we don't care about its result
        //    because we're tearing down regardless.
        if (inFlight) {
            try { await inFlight; } catch { /* expected: the aborted connect rejects */ }
        }

        // 5. Close the transport and client. Re-read the handle from
        //    the map because the connect task may have replaced it
        //    with a fully-connected entry before our abort landed.
        const latest = this.handles.get(serverName);
        const transport = (latest && (latest as unknown as ConnectingHandle).transport)
            || (handle && (handle as unknown as ConnectingHandle).transport);
        try {
            if (transport) {
                await transport.close();
            }
        } catch (err) {
            console.error(`[mcp:${serverName}] error closing transport: ${(err as Error).message}`);
        }
        try {
            if (latest && latest.client) {
                await latest.client.close();
            } else if (handle && handle.status !== 'connecting' && handle.client) {
                await handle.client.close();
            }
        } catch (err) {
            console.error(`[mcp:${serverName}] error closing client: ${(err as Error).message}`);
        }
    }

    /**
     * Disconnect every server. Called from `shutdownMCP()` (public API)
     * and from SIGTERM/beforeExit handlers.
     */
    async closeAll(): Promise<void> {
        const names = Array.from(new Set([...this.handles.keys(), ...this.inFlight.keys()]));
        await Promise.allSettled(names.map((name) => this.disconnect(name)));
    }

    /**
     * Returns the effective timeout (in ms) for a given server, falling
     * back to the per-server config value and finally to the default.
     */
    getTimeoutMs(serverName: string): number {
        const handle = this.handles.get(serverName);
        const config = handle?.config ?? this.rootConfig.mcpServers[serverName];
        const seconds = config?.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
        return Math.max(1, Math.floor(seconds * 1000));
    }

    /**
     * Test-only: wipe all in-memory state.
     */
    __resetForTests(): void {
        this.handles = new Map();
        this.inFlight = new Map();
        this.rootConfig = { mcpServers: {} };
    }
}

const manager = new MCPClientManager();

let shutdownRegistered = false;
function ensureShutdownHandlers(): void {
    if (shutdownRegistered) return;
    shutdownRegistered = true;
    const handler = (): void => {
        void manager.closeAll();
    };
    process.once('SIGTERM', handler);
    process.once('SIGINT', handler);
    process.once('beforeExit', handler);
}

/**
 * Public accessor for the module-level singleton. Tests can call
 * `getClientManager().__resetForTests()` to wipe state.
 */
export function getClientManager(): MCPClientManager {
    ensureShutdownHandlers();
    return manager;
}

export type { MCPClientManager };
