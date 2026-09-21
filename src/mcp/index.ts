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

import type { ToolDefinition } from '@/services/adapters/llmAdapter';

import type { MCPServerConfig } from './types';

import { getClientManager } from './clientManager';
import { listMCPServers, loadMCPConfig } from './configLoader';
import { peekAuthorizationUrl } from './oauthProvider';
import {
  buildMCPToolDefinitions,
  buildMCPToolDefinitionsForSearch,
  buildMCPToolStubs,
  buildNamespacedName,
  mcpToolStubToOllamaTool,
} from './schemaAdapter';

export { getClientManager, type MCPClientManager } from './clientManager';
export {
  getMCPConfigPath,
  listMCPServers,
  loadMCPConfig,
  saveMCPServerDisabled,
} from './configLoader';
// Push-based event bus + config file watcher. The SSE route in
// `app/api/mcp/events/route.ts` subscribes to these so the sidebar
// can drop its 5s polling loop.
export { emitMCPEvent, type MCPEvent, subscribeMCPEvents } from './events';
// Phase 3.5: the OAuth-related symbols are re-exported so API
// routes can import them from a single facade. The underlying
// implementation lives in `mcp/oauthProvider.ts`; we deliberately
// keep the public surface narrow so tests and consumers don't
// reach into the SDK auth types unless they need to.
export {
  buildOAuthProvider,
  consumeAuthorizationCode,
  getLoopbackRedirectUrl,
  peekAuthorizationUrl,
} from './oauthProvider';
export {
  clearOAuthState,
  loadOAuthState,
  MCP_OAUTH_TOKENS_FILENAME,
  saveOAuthState,
} from './oauthTokenStore';
export {
  buildMCPToolDefinitions,
  buildMCPToolDefinitionsForSearch,
  buildMCPToolStubs,
  buildNamespacedName,
  type DispatchContext,
  dispatchMCPToolCall,
  type DispatchOptions,
  matchesAutoApprovePattern,
  MCP_NAMESPACED_NAME_REGEX,
  MCP_SERVER_NAME_REGEX,
  MCP_TOOL_NAME_REGEX,
  MCP_TOOL_NAMESPACE_PREFIX,
  MCP_TOOL_NAMESPACE_SEPARATOR,
  type MCPToolStub,
  mcpToolStubToOllamaTool,
  parseMCPToolName,
} from './schemaAdapter';
export type { MCPRootConfig, MCPServerConfig } from './types';
export {
  type MCPClientHandle,
  MCPConfigError,
  MCPConnectionError,
  type MCPConnectionStatus,
  type MCPToolInfo,
} from './types';

export type {
  MCPOAuthTokenStoreFile,
  MCPSavedClientInformation,
  MCPSavedOAuthState,
  MCPSavedOAuthTokens,
} from './types';
import { startMCPConfigWatcher } from './configWatcher';

// Start the config file watcher exactly once per process. Calling
// again from another import site is a no-op (idempotent guard inside
// the watcher module).
startMCPConfigWatcher();

export interface MCPStatusEntry {
  name: string;
  description: string | undefined;
  transport: 'stdio' | 'http' | 'sse';
  status: 'disconnected' | 'connecting' | 'connected' | 'error' | 'not_loaded' | 'auth_required';
  lastError?: string | undefined;
  authUrl?: string | undefined;
  tools: Array<{ name: string; description: string | undefined; fullName: string }>;
  toolCount: number;
}

export interface MCPListResult {
  servers: MCPStatusEntry[];
}

export interface MCPListOptions {
  connect?: string;
  eagerConnectTimeoutMs?: number;
  /**
   * F7: dial servers that still need it while listing. DEFAULT false — a plain
   * status read must never spawn children or emit `state` events, which is what
   * made the SSE snapshot re-dial every unreachable server on every SSE
   * (re)connect and spin the connect→SSE→GET /api/mcp→connect loop.
   */
  eagerConnect?: boolean;
  /** F7: bypass the per-server retry backoff (explicit user action). */
  force?: boolean;
}

/**
 * Read the latest config from disk, build a status report, and
 * (only when explicitly asked) eagerly connect to every enabled
 * server so the returned listing includes the live tool set.
 *
 * Phase 2: all three transports (stdio, http, sse) are supported.
 * The shared `connectAllEnabled()` helper is used to warm every
 * enabled server in parallel with a single overall deadline.
 *
 * F7: eager connecting is now OPT-IN via `eagerConnect: true`. A
 * plain status read (the SSE initial snapshot, a passive UI poll)
 * must be side-effect free — dialling from a listing is what closed
 * the `connect → SSE → GET /api/mcp → connect` feedback loop.
 */
export async function listMCPServersWithStatus(
  options: MCPListOptions = {}
): Promise<MCPListResult> {
  const config = await loadMCPConfig();
  const manager = getClientManager();
  manager.setRootConfig(config);

  // If the caller asked for a single specific server, honour that
  // (the API still supports `?connect=<name>` for explicit lazy
  // connects) — and force past the backoff because the request is
  // an explicit user action. Otherwise only warm every enabled
  // server when the caller opted in with `eagerConnect`.
  if (options.connect) {
    const target = config.mcpServers[options.connect];
    if (target) {
      try {
        // Not user-initiated authentication — a GET listing request
        // must never itself trigger the OAuth browser-redirect flow.
        // See `openConnection` in `clientManager.ts`.
        await manager.connect(target.name, { interactive: false, force: true });
      } catch (err) {
        // Surface the error in the per-server entry below; don't fail the listing.
        console.error(
          `[mcp] eager connect to "${options.connect}" failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  } else if (options.eagerConnect === true) {
    await connectAllEnabled(options.eagerConnectTimeoutMs ?? 5000, {
      force: options.force === true,
    });
  }

  const servers = listMCPServers(config);
  const out: MCPStatusEntry[] = [];

  for (const server of servers) {
    if (server.disabled) {
      const entry: MCPStatusEntry = {
        name: server.name,
        description: server.description,
        transport: server.transport.type,
        status: 'not_loaded',
        tools: [],
        toolCount: 0,
      };
      out.push(entry);
      continue;
    }

    const handle = manager.get(server.name);
    if (!handle) {
      const entry: MCPStatusEntry = {
        name: server.name,
        description: server.description,
        transport: server.transport.type,
        status: 'disconnected',
        tools: [],
        toolCount: 0,
      };
      // Phase 3.5 / F9: when the server has an `oauth` block it will
      // need the user's consent, so hint the UI that OAuth is the
      // reason it can't auto-connect. Surface the REAL authorization
      // URL when one has been stashed by `redirectToAuthorization`
      // (D3); never fabricate a placeholder, and omit the field when no
      // URL exists yet so the UI renders no link. The chat UI combines
      // this with the `lastError` text to render the "Authenticate"
      // button.
      if (server.oauth !== undefined) {
        const authUrl = peekAuthorizationUrl(server.name);
        if (authUrl !== undefined) entry.authUrl = authUrl;
      }
      out.push(entry);
      continue;
    }

    const entry: MCPStatusEntry = {
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
    };
    // Phase 3.5 / F9 / D3: when the handle is in `auth_required`,
    // include the REAL authorization URL that `redirectToAuthorization`
    // stashed for this server (if the SDK has reached that step yet).
    // The old code hard-coded an unusable `127.0.0.1:0` placeholder and
    // relied on a terminal-only hint for the real URL; we now return the
    // real URL, or omit the field entirely when none is known, so the UI
    // can render a direct link without inventing one.
    if (handle.status === 'auth_required') {
      const authUrl = peekAuthorizationUrl(server.name);
      if (authUrl !== undefined) entry.authUrl = authUrl;
    }
    out.push(entry);
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
export async function connectAllEnabled(
  timeoutMs = 5000,
  opts: { force?: boolean } = {}
): Promise<void> {
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
    enabledServers.map((s) =>
      manager.connect(s.name, { interactive: false, force: opts.force === true })
    )
  );
  await Promise.race([connectPromise, deadline]);
  if (deadlineTimer) clearTimeout(deadlineTimer);

  // Drain rejections on the next tick so we log them without
  // blocking the caller. `Promise.allSettled` already swallowed
  // them; we just want visibility.
  connectPromise
    .then((results) => {
      for (const r of results) {
        if (r.status === 'rejected') {
          const reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
          console.error(`[mcp] eager connect failed: ${reason}`);
        }
      }
    })
    .catch(() => {
      /* ignore */
    });
}

/**
 * Reload the on-disk config, close all live connections, and return
 * the new state. Invoked by `POST /api/mcp` with `{ action: "reload" }`.
 */
export async function reloadMCP(): Promise<MCPListResult> {
  const manager = getClientManager();
  await manager.closeAll();
  // F7: a reload is an explicit user action, so opt into the eager
  // warm-up and bypass the per-server retry backoff.
  return listMCPServersWithStatus({ eagerConnect: true, force: true });
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
  const stubs = await buildMCPToolStubs();
  return stubs.length;
}

export interface MCPToolsForRequest {
  toolCount: number;
  definitions: ToolDefinition[];
}

/**
 * F7(e): single entry point for the chat route's tool list. Runs the eager
 * connect ONCE (was twice: getMCPToolCount + getMergedMCPToolDefinitions*) and
 * builds the stub list ONCE (was twice on the search path). `forceSearch` maps
 * to `config.mcpToolSearch === true`; otherwise search turns on above the
 * threshold — mirroring the previous decision exactly.
 */
export async function getMCPToolsForRequest(options: {
  searchThreshold: number;
  forceSearch?: boolean;
}): Promise<MCPToolsForRequest> {
  await connectAllEnabled(5000);
  const stubs = await buildMCPToolStubs();
  const toolCount = stubs.length;
  const enableSearch = options.forceSearch === true || toolCount > options.searchThreshold;
  const definitions = enableSearch
    ? stubs.map(mcpToolStubToOllamaTool)
    : await buildMCPToolDefinitions();
  return { toolCount, definitions };
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
 * Phase 3.5: re-authenticate a server with OAuth 2.1 + PKCE.
 *
 * Drops any saved tokens and triggers a fresh connection attempt
 * so the SDK builds a new authorization URL. The handle is
 * flipped to `auth_required` and the real authorization URL (when
 * the SDK has reached that step) is returned here and also pushed
 * to the chat UI via the `auth-required` event on the MCP event bus.
 *
 * Used by `POST /api/mcp/auth`.
 */
export async function reauthenticateMCPServer(
  serverName: string
): Promise<{ ok: boolean; reason?: string; authUrl?: string }> {
  const manager = getClientManager();
  const config = await loadMCPConfig();
  manager.setRootConfig(config);
  if (!config.mcpServers[serverName]) {
    return { ok: false, reason: `unknown MCP server "${serverName}"` };
  }
  // No explicit "oauth" block is fine — `buildOAuthProvider` falls
  // back to an empty config so DCR can still run. This is safe here
  // specifically because this function is only reachable from the
  // user explicitly clicking "Authenticate" (`POST /api/mcp/auth`);
  // see `clientManager.openConnection`'s `interactive` gate.
  try {
    // F9: the background OAuth flow no longer self-completes inside
    // the HTTP request, so surface the authorization URL (when the
    // SDK handed one back) to the caller / UI.
    const { authUrl } = await manager.reauthenticate(serverName);
    return authUrl === undefined ? { ok: true } : { ok: true, authUrl };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: message };
  }
}
