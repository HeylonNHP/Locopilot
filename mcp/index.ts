/**
 * Public facade for MCP (Model Context Protocol) support.
 *
 * Exported for use by:
 * - `app/api/chat/route.ts` (build tool defs, dispatch calls)
 * - `app/api/mcp/route.ts` (status listing, reload)
 * - `tools/impl/mcpTool.ts` (delegate to `dispatchMCPToolCall`)
 * - `app/hooks/useSlashCommands.ts` (use the same status source as the API)
 *
 * Phase 2 adds HTTP/SSE transports, `notifications/tools/list_changed`
 * handling, and a generalised approval registry — all wired through
 * the same public surface.
 */

import type { ToolDefinition } from '../services/adapters/llmAdapter';
import { getClientManager } from './clientManager';
import { loadMCPConfig, listMCPServers } from './configLoader';
import {
    buildMCPToolDefinitions,
    buildMCPToolDefinitionsForSearch,
    buildMCPToolStubs,
    dispatchMCPToolCall,
    mcpToolStubToOllamaTool,
    parseMCPToolName,
    buildNamespacedName,
} from './schemaAdapter';
import type { MCPRootConfig, MCPServerConfig } from './types';

export type { MCPRootConfig, MCPServerConfig } from './types';
export {
    MCPConfigError,
    MCPConnectionError,
    MCPProtocolError,
    type MCPClientHandle,
    type MCPToolInfo,
    type MCPConnectionStatus,
} from './types';
export {
    loadMCPConfig,
    listMCPServers,
    getMCPConfigPath,
    saveMCPServerDisabled,
} from './configLoader';
export {
    getClientManager,
    type MCPClientManager,
} from './clientManager';
export {
    buildMCPToolDefinitions,
    buildMCPToolDefinitionsForSearch,
    buildMCPToolStubs,
    dispatchMCPToolCall,
    mcpToolStubToOllamaTool,
    parseMCPToolName,
    buildNamespacedName,
    MCP_TOOL_NAMESPACE_PREFIX,
    MCP_TOOL_NAMESPACE_SEPARATOR,
    type DispatchContext,
    type DispatchOptions,
    type MCPToolStub,
} from './schemaAdapter';

// Push-based event bus + config file watcher. The SSE route in
// `app/api/mcp/events/route.ts` subscribes to these so the sidebar
// can drop its 5s polling loop.
export { subscribeMCPEvents, emitMCPEvent, type MCPEvent } from './events';
import { startMCPConfigWatcher } from './configWatcher';

// Start the config file watcher exactly once per process. Calling
// again from another import site is a no-op (idempotent guard inside
// the watcher module).
startMCPConfigWatcher();

export interface MCPStatusEntry {
    name: string;
    description: string | undefined;
    transport: 'stdio' | 'http' | 'sse';
    status: 'disconnected' | 'connecting' | 'connected' | 'error' | 'not_loaded';
    lastError?: string | undefined;
    tools: Array<{ name: string; description: string | undefined; fullName: string }>;
    toolCount: number;
}

export interface MCPListResult {
    servers: MCPStatusEntry[];
}

/**
 * Read the latest config from disk, build a status report, and
 * eagerly connect to every enabled server (within the per-call
 * timeout) so the returned listing includes the live tool set.
 *
 * Phase 2: all three transports (stdio, http, sse) are supported.
 * The shared `connectAllEnabled()` helper is used to warm every
 * enabled server in parallel with a single overall deadline.
 */
export async function listMCPServersWithStatus(options: { connect?: string; eagerConnectTimeoutMs?: number } = {}): Promise<MCPListResult> {
    const config = await loadMCPConfig();
    const manager = getClientManager();
    manager.setRootConfig(config);

    // If the caller asked for a single specific server, honour that
    // (the API still supports `?connect=<name>` for explicit lazy
    // connects). Otherwise eagerly warm every enabled server.
    if (options.connect) {
        const target = config.mcpServers[options.connect];
        if (target) {
            try {
                await manager.connect(target.name);
            } catch (err) {
                // Surface the error in the per-server entry below; don't fail the listing.
                console.error(`[mcp] eager connect to "${options.connect}" failed: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
    } else {
        await connectAllEnabled(options.eagerConnectTimeoutMs ?? 5000);
    }

    const servers = listMCPServers(config);
    const out: MCPStatusEntry[] = [];

    for (const server of servers) {
        if (server.disabled) {
            out.push({
                name: server.name,
                description: server.description,
                transport: server.transport.type,
                status: 'not_loaded',
                tools: [],
                toolCount: 0,
            });
            continue;
        }

        const handle = manager.get(server.name);
        if (!handle) {
            out.push({
                name: server.name,
                description: server.description,
                transport: server.transport.type,
                status: 'disconnected',
                tools: [],
                toolCount: 0,
            });
            continue;
        }

        out.push({
            name: server.name,
            description: server.description,
            transport: server.transport.type,
            status: handle.status,
            lastError: handle.lastError,
            tools: handle.tools.map((t) => ({
                name: t.name,
                description: t.description,
                fullName: buildNamespacedName(server.name, t.name),
            })),
            toolCount: handle.tools.length,
        });
    }

    return { servers: out };
}

/**
 * Eagerly connect to every enabled (non-disabled) MCP server in
 * parallel, with a single overall timeout. Failures are logged but
 * never thrown: a single broken server must not break the whole
 * feature (or block the chat route from rendering its tool list).
 *
 * Used by `getMergedMCPToolDefinitions` (so the LLM sees MCP tool
 * schemas on the first request) and by `listMCPServersWithStatus`
 * (so the `/mcp list` slash command shows tools immediately).
 */
export async function connectAllEnabled(timeoutMs = 5000): Promise<void> {
    const config = await loadMCPConfig();
    const manager = getClientManager();
    manager.setRootConfig(config);

    const enabledServers = Object.values(config.mcpServers).filter((s) => !s.disabled);
    if (enabledServers.length === 0) return;

    // Race every eager connect against an overall deadline. Each
    // individual connect has its own AbortController inside the
    // manager, so the in-flight ones will be torn down when the
    // caller aborts (e.g. the chat route's req.signal). The deadline
    // here is just a backstop so a slow / wedged server can't hold
    // up the chat route's first byte.
    let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
    const deadline = new Promise<void>((resolve) => {
        deadlineTimer = setTimeout(() => resolve(), timeoutMs);
    });
    const connectPromise = Promise.allSettled(
        enabledServers.map((s) => manager.connect(s.name)),
    );
    await Promise.race([connectPromise, deadline]);
    if (deadlineTimer) clearTimeout(deadlineTimer);

    // Drain rejections on the next tick so we log them without
    // blocking the caller. `Promise.allSettled` already swallowed
    // them; we just want visibility.
    connectPromise.then((results) => {
        for (const r of results) {
            if (r.status === 'rejected') {
                const reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
                console.error(`[mcp] eager connect failed: ${reason}`);
            }
        }
    }).catch(() => { /* ignore */ });
}

/**
 * Reload the on-disk config, close all live connections, and return
 * the new state. Invoked by `POST /api/mcp` with `{ action: "reload" }`.
 */
export async function reloadMCP(): Promise<MCPListResult> {
    const manager = getClientManager();
    await manager.closeAll();
    return listMCPServersWithStatus();
}

/**
 * Build the merged tool list (static native tools + dynamic MCP tools)
 * for a chat request. This is the single entry point used by
 * `app/api/chat/route.ts`.
 *
 * Eagerly connects to every enabled MCP server (with a 5s overall
 * deadline) so the LLM sees the merged tool list on the first
 * request — see A4 in the bug report. Servers that fail to connect
 * are logged but excluded from the returned list (a broken server
 * must not break the chat).
 */
export async function getMergedMCPToolDefinitions(): Promise<ToolDefinition[]> {
    await connectAllEnabled(5000);
    return buildMCPToolDefinitions();
}

/**
 * Phase 3 (MCP Tool Search): the lazy-schema variant of
 * `getMergedMCPToolDefinitions`. Returns stub tool definitions
 * (namespaced name + truncated description + empty `properties`)
 * for every connected MCP tool, instead of the full JSON Schema.
 *
 * The chat route picks one of the two flavours based on
 * `config.mcpToolSearch` and the total MCP tool count. No difference
 * in connection behaviour — the eager `connectAllEnabled` still runs
 * so the stub list reflects whatever would have been sent in the
 * non-search path.
 */
export async function getMergedMCPToolDefinitionsForSearch(): Promise<ToolDefinition[]> {
    await connectAllEnabled(5000);
    return buildMCPToolDefinitionsForSearch();
}

/**
 * Total number of MCP tools currently available (i.e. connected +
 * healthy). Cheap — walks the client manager's handles and counts
 * their `tools` arrays without building any full schemas.
 *
 * Used by the chat route to decide whether to enable Tool Search
 * automatically (the threshold lives in `MCP_TOOL_SEARCH_THRESHOLD`
 * in `constants.ts`).
 */
export async function getMCPToolCount(): Promise<number> {
    await connectAllEnabled(5000);
    return (await buildMCPToolStubs()).length;
}

/**
 * Look up a single server's config by name (no connection side
 * effects). Used by the chat route to honour per-server
 * `autoApprove` lists in the inline approval gate (see A5).
 */
export async function getMCPServerConfig(name: string): Promise<MCPServerConfig | null> {
    const config = await loadMCPConfig();
    return config.mcpServers[name] ?? null;
}

/**
 * Graceful shutdown: closes every open MCP client. Wired to process
 * signal handlers in `getClientManager()`, and exported here so
 * tests and the MCP API route can trigger it deterministically.
 */
export async function shutdownMCP(): Promise<void> {
    const manager = getClientManager();
    await manager.closeAll();
}
