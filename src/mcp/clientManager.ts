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
 * - Shutdown (`closeAll()`) is wired to `process.on('SIGTERM' | 'SIGINT' |
 *   'beforeExit')` so spawned subprocesses are reaped when the dev server
 *   stops. The manager itself is pinned on `globalThis` (F1) so Next.js
 *   dev-mode HMR reuses it instead of orphaning live children and stacking
 *   duplicate signal handlers.
 */

import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import { debugLog } from '@/app/lib/debugLogger';
import { logger } from '@/app/lib/logger';
import { killProcessTreeByPid } from '@/tools/processTree';

import { expandEnvRefsInRecord } from './envExpansion';
import { emitMCPEvent } from './events';
import { classifyMCPOAuthFailure } from './oauthDiagnostics';
import {
  buildOAuthProvider,
  consumeAuthorizationCode,
  peekAuthorizationUrl,
} from './oauthProvider';
import { clearOAuthState, loadOAuthState } from './oauthTokenStore';
import {
  type MCPClientHandle,
  MCPConnectionError,
  type MCPRootConfig,
  type MCPServerConfig,
  type MCPToolInfo,
} from './types';

const CLIENT_NAME = 'locopilot';
const CLIENT_VERSION = '0.0.1';

const DEFAULT_TIMEOUT_SECONDS = 60;

/**
 * F7: per-server auto-connect backoff. After a failed (or `auth_required`)
 * connect, an implicit/lazy connect for the same server is suppressed until
 * `nextRetryAt`, which grows exponentially from BASE up to MAX with ±25%
 * jitter.
 *
 * Without this, a broken server is re-dialled by every chat request AND every
 * `?connect=` listing, and each failure fans an SSE `state` frame out to the
 * MCP tab, whose refetch re-dials again — the connect → SSE → refetch loop.
 */
const CONNECT_BACKOFF_BASE_MS = 5000;
const CONNECT_BACKOFF_MAX_MS = 300_000;

/**
 * F7: the epoch-ms `nextRetryAt` for the Nth consecutive failure.
 *
 * Exponential growth caps at `CONNECT_BACKOFF_MAX_MS`; the ±25% jitter stops
 * a fleet of failing servers from all retrying on the same tick (and stops a
 * single broken server from producing a perfectly periodic retry storm).
 */
function computeNextRetryAt(failureCount: number): number {
  const exponential = CONNECT_BACKOFF_BASE_MS * 2 ** (failureCount - 1);
  const capped = Math.min(exponential, CONNECT_BACKOFF_MAX_MS);
  const jitter = 0.75 + Math.random() * 0.5;
  return Date.now() + Math.round(capped * jitter);
}

/**
 * The SDK's `StreamableHTTPError` / `SseError` both carry the raw
 * HTTP status on a `.code` field. When we deliberately don't attach
 * an OAuth provider (see `openConnection`), a 401 from the server
 * surfaces as one of these instead of `UnauthorizedError`, so we
 * check `.code` too when deciding whether to show the "needs auth"
 * status.
 */
function extractHttpStatusCode(err: unknown): number | undefined {
  if (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    typeof (err as { code: unknown }).code === 'number'
  ) {
    return (err as { code: number }).code;
  }
  return undefined;
}

/**
 * The RFC 6749 `error` code carried by the SDK's `OAuthError` subclasses
 * (`InvalidClientError`, `InvalidClientMetadataError`, `ServerError`, … —
 * see `@modelcontextprotocol/sdk/server/auth/errors.js`). Duck-typed off a
 * string `errorCode` property so we don't have to import every SDK error
 * class just to classify a failure. Returns `undefined` when the error
 * carries no usable code (e.g. an empty `ServerError`).
 */
function extractOAuthErrorCode(err: unknown): string | undefined {
  if (
    typeof err === 'object' &&
    err !== null &&
    'errorCode' in err &&
    typeof (err as { errorCode: unknown }).errorCode === 'string'
  ) {
    return (err as { errorCode: string }).errorCode;
  }
  return undefined;
}

/**
 * The SDK's OAuth error classes (`InvalidClientError`,
 * `InvalidClientMetadataError`, `ServerError`, etc. — see
 * `@modelcontextprotocol/sdk/server/auth/errors.js`) carry the RFC
 * 6749 `error` code on an `errorCode` getter and an optional
 * `error_uri` on `errorUri`, but their `.message` is set to
 * `error_description`, which the IdP can legally omit. When that
 * happens `err.message` alone is `''`, which is useless for
 * diagnosing e.g. a failed Dynamic Client Registration. This pulls
 * out whatever detail is actually available so the console log
 * says WHY, not just THAT, something failed.
 */
function describeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (typeof err !== 'object' || err === null) {
    return message;
  }
  const details: string[] = [];
  if ('errorCode' in err && typeof (err as { errorCode: unknown }).errorCode === 'string') {
    details.push(`oauth error: ${(err as { errorCode: string }).errorCode}`);
  }
  if ('errorUri' in err && typeof (err as { errorUri: unknown }).errorUri === 'string') {
    details.push(`error_uri: ${(err as { errorUri: string }).errorUri}`);
  }
  if (details.length === 0) {
    return message;
  }
  const base = message.length > 0 ? message : '(no error_description from server)';
  return `${base} [${details.join(', ')}]`;
}

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
function buildTransport(
  config: MCPServerConfig,
  authProvider: {
    provider: ReturnType<typeof buildOAuthProvider> extends Promise<infer T> ? T : never;
  }
): StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport {
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
    `MCP server "${config.name}" headers`
  );
  if (headersResult.warnings.length > 0) {
    for (const w of headersResult.warnings) console.warn(`[mcp] ${w}`);
  }
  const headers = headersResult.expanded ?? {};

  if (transport.type === 'http') {
    // Build the transport options conditionally so we don't
    // pass `authProvider: undefined` to a field typed as
    // `authProvider?: OAuthClientProvider` under
    // `exactOptionalPropertyTypes: true`. The `requestInit`
    // header bag is always present (even when empty) so
    // the SDK sends the same shape on every POST including
    // the `initialize` handshake.
    const httpOpts: ConstructorParameters<typeof StreamableHTTPClientTransport>[1] = {
      requestInit: { headers },
    };
    if (authProvider.provider !== undefined) {
      httpOpts.authProvider = authProvider.provider;
    }
    return new StreamableHTTPClientTransport(url, httpOpts);
  }

  // SSE — the SDK keeps SSEClientTransport around for legacy servers
  // that haven't migrated to streamable-HTTP. The SDK's SSE transport
  // merges `requestInit.headers` into the common headers used by BOTH
  // the initial EventSource GET and the recurring POST, so the
  // Authorization / API-key headers set here apply to both sides.
  // (No separate `eventSourceInit.headers` is needed for auth.)
  const sseOpts: ConstructorParameters<typeof SSEClientTransport>[1] = {
    requestInit: { headers },
  };
  if (authProvider.provider !== undefined) {
    sseOpts.authProvider = authProvider.provider;
  }
  return new SSEClientTransport(url, sseOpts);
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

  /**
   * FIX 4: the AbortController of the MOST RECENT in-flight connect for a
   * server. `connect()` deletes a stale handle from `handles` and yields inside
   * `replaceStaleHandleThenConnect` (awaiting teardown) before `openConnection`
   * installs a placeholder, so a concurrent `disconnect()` would find no handle
   * to abort and then await the handshake for up to the full request timeout
   * (60s). This map lets `disconnect()` cancel that handshake directly. Entries
   * are removed by `teardownHandle` once the handshake they guarded is over.
   */
  private readonly connectControllers = new Map<string, AbortController>();

  private rootConfig: MCPRootConfig = { mcpServers: {} };

  /**
   * Replace the in-memory root config without affecting already-open
   * connections. Callers (e.g. `reloadMCP()`) explicitly close existing
   * handles before calling this.
   */
  setRootConfig(config: MCPRootConfig): void {
    this.rootConfig = config;
  }
  /**
   * Lazily connect to the named server. Idempotent: returns the
   * existing handle if already connected, or awaits the in-flight
   * connect if one is already running.
   *
   * `opts.interactive` (default `false`) must be `true` only for a
   * connect the user explicitly asked for — the "Authenticate"
   * button (`reauthenticate`). Every other caller (eager warmup,
   * on-demand tool-call connects, the `?connect=` listing param)
   * leaves it `false`, which tells `openConnection` never to trigger
   * the SDK's Dynamic Client Registration / browser-redirect flow —
   * see the comment there.
   *
   * `opts.force` (default `false`) bypasses the F7 backoff for a
   * user-initiated reconnect. An implicit connect for a server whose
   * `nextRetryAt` is still in the future resolves the cached handle
   * WITHOUT dialling — see the silent-skip comment below.
   */
  connect(
    serverName: string,
    opts: { interactive?: boolean; force?: boolean } = {}
  ): Promise<MCPClientHandle> {
    const interactive = opts.interactive ?? false;
    const force = opts.force ?? false;
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

    // FIX 1: an `auth_required` handle owns a live background OAuth flow whose
    // loopback listener is tied to this connect's AbortController. An implicit
    // connect (connectAllEnabled on every chat turn, `?eager=1`, a reload) must
    // neither tear it down — which would abort the listener, wipe the PKCE
    // verifier and make the user's already-open consent page redirect to a dead
    // port — nor re-dial it. Only the user's Authenticate action (`interactive`,
    // or `force` for an explicit retry) may restart the flow. Resolve the cached
    // handle silently: no spawn, no placeholder, no event. The F7 backoff skip
    // below still covers `error` and `disconnected` handles.
    if (!force && !interactive && existing?.status === 'auth_required') {
      return Promise.resolve(existing);
    }

    // F7: silent backoff skip. An implicit connect (not forced, not
    // interactive) for a server that recently failed resolves the cached
    // handle WITHOUT spawning, WITHOUT creating a placeholder and WITHOUT
    // emitting any event. The silence is the whole point: emitting here would
    // push an SSE frame, the MCP tab would refetch, and the refetch would call
    // `connect()` again — the connect → SSE → refetch loop. A forced connect
    // (the "Connect" button) or an interactive one (auth) always dials, so the
    // user can retry immediately.
    if (
      !force &&
      !interactive &&
      existing?.nextRetryAt !== undefined &&
      Date.now() < existing.nextRetryAt
    ) {
      return Promise.resolve(existing);
    }

    const config = this.rootConfig.mcpServers[serverName];
    if (!config) {
      return Promise.reject(
        new MCPConnectionError(`unknown MCP server "${serverName}"`, serverName)
      );
    }
    if (config.disabled) {
      return Promise.reject(
        new MCPConnectionError(`MCP server "${serverName}" is disabled in config`, serverName)
      );
    }

    // F5: a stale `error` / `disconnected` / `auth_required` handle may still
    // own a live client + child (a non-fatal `onerror` does not stop the SDK).
    // Tear it down before dialling, inside the shared in-flight promise so
    // concurrent callers coalesce and `disconnect()` sees the stale entry gone.
    const promise = this.replaceStaleHandleThenConnect(
      existing,
      serverName,
      config,
      interactive || force
    );
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
   * F5: replace a stale handle with a fresh connection. When a handle exists it
   * is removed from the map FIRST (so a late `onclose` from the dying client
   * cannot clobber the placeholder we are about to install) and torn down via
   * the shared `teardownHandle`, then `openConnection` dials anew.
   *
   * The prior failure count is threaded through so the fresh failure (if this
   * attempt also fails) continues the F7 backoff sequence.
   */
  private async replaceStaleHandleThenConnect(
    existing: MCPClientHandle | undefined,
    serverName: string,
    config: MCPServerConfig,
    interactive: boolean
  ): Promise<MCPClientHandle> {
    const previousFailureCount = existing?.failureCount ?? 0;
    if (existing !== undefined) {
      this.handles.delete(serverName);
      await this.teardownHandle(serverName, existing);
    }
    return this.openConnection(serverName, config, interactive, previousFailureCount);
  }

  /**
   * Internal: perform the actual connect. Creates the transport,
   * the client, and the AbortController that `disconnect()` will
   * signal on. The connecting placeholder is stored in
   * `handles` immediately so the status query works mid-handshake.
   */
  private async openConnection(
    serverName: string,
    config: MCPServerConfig,
    interactive: boolean,
    previousFailureCount = 0
  ): Promise<MCPClientHandle> {
    // Phase 3.5 / gate against unattended OAuth: a live OAuth
    // provider is only attached when either (a) this connect was
    // explicitly triggered by the user (`interactive: true` — the
    // "Authenticate" button or the code-paste fallback), or (b) we
    // already hold a saved access token for this server, in which
    // case attaching the provider just lets the transport send it
    // as a Bearer header — no interactive flow is involved.
    //
    // Without this gate, a background/eager connect (every chat
    // request warms every enabled server) would attach a live
    // provider to ANY non-stdio server that doesn't have a token
    // yet, and the SDK auto-triggers Dynamic Client Registration
    // and the browser-redirect flow the moment it sees a 401 —
    // completely unattended, for servers the user never asked to
    // authenticate. Skipping the provider means the 401 instead
    // surfaces as a plain HTTP error, which the catch block below
    // maps to the same `auth_required` status — the UI's
    // "Authenticate" button is the only thing that can turn
    // `interactive` on.
    let hasCachedToken = false;
    if (config.transport.type !== 'stdio' && !interactive) {
      const cachedState = await loadOAuthState(serverName);
      hasCachedToken = cachedState.tokens?.access_token !== undefined;
    }
    const shouldAttachOAuthProvider =
      config.transport.type !== 'stdio' && (interactive || hasCachedToken);
    // F9: create the per-connect AbortController BEFORE building the OAuth
    // provider, so the background loopback listener it starts can be tied to
    // this connect's lifetime and aborted by `teardownHandle` / `disconnect`.
    // (This used to be declared further down — now a single declaration.)
    const abortController = new AbortController();
    // FIX 4: register this handshake's controller immediately so a concurrent
    // `disconnect()` can cancel it even before the connecting placeholder
    // reaches the `handles` map (the stale-replace window).
    this.connectControllers.set(serverName, abortController);
    // The provider is async because it allocates a loopback port
    // for the OAuth callback.
    const provider = shouldAttachOAuthProvider
      ? await buildOAuthProvider(config, {
          interactive,
          flow: {
            // The listener outlives the HTTP request that started the flow (F9).
            // `onCode` runs the token exchange + reconnect in the background;
            // `onFailure` only annotates a handle still awaiting auth.
            signal: abortController.signal,
            onCode: (code) => {
              void this.completeAuthorization(serverName, code);
            },
            onFailure: (message) => {
              this.markAuthorizationFlowFailed(serverName, message);
            },
          },
        })
      : undefined;
    // Phase 2: build the SDK transport from the config. The transport
    // is built BEFORE the client so a malformed URL or invalid header
    // fails fast (synchronously) — no need to start a subprocess.
    const transport = buildTransport(config, { provider });

    // Phase 2 (feature C): wire up the `notifications/tools/list_changed`
    // handler. The SDK only activates the handler if the server
    // advertises `capabilities.tools.listChanged: true`, so this is
    // a no-op for servers that don't support live tool updates. When
    // a notification arrives, the SDK re-fetches the tool list and
    // hands us the new array via `onChanged`.
    // F12: identity holder for THIS connect attempt. The callbacks below
    // resolve their target through it rather than through
    // `this.handles.get(serverName)` alone, so a late callback from a client
    // that has since been REPLACED cannot clobber the healthy new handle.
    // Assigned at each handle creation (placeholder, connected, failed).
    const liveHandle: { current: MCPClientHandle | undefined } = { current: undefined };

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
      // F12: a late refresh from a replaced client must not patch the new handle.
      if (!handle || handle !== liveHandle.current) return;
      if (handle.status !== 'connected') return;
      const newTools: MCPToolInfo[] = Array.isArray(items)
        ? items
            .map((t) => {
              const tt = t as { name?: unknown; description?: unknown; inputSchema?: unknown };
              const inputSchema =
                tt.inputSchema && typeof tt.inputSchema === 'object'
                  ? (tt.inputSchema as MCPToolInfo['inputSchema'])
                  : { type: 'object' as const };
              return {
                name: typeof tt.name === 'string' ? tt.name : '',
                description: typeof tt.description === 'string' ? tt.description : undefined,
                inputSchema,
              };
            })
            .filter((t) => t.name.length > 0)
        : [];
      // Apply per-server `disabledTools` filter so the list matches
      // what the dispatcher would expose.
      const blocklist = handle.config.disabledTools ?? [];
      handle.tools = newTools.filter((t) => !blocklist.includes(t.name));
      logger.info('mcp', `[${serverName}] tool list refreshed: ${handle.tools.length} tool(s)`);
      // Notify the SSE channel — the consumer will re-fetch the
      // full status listing to pick up the new tool names + counts.
      emitMCPEvent({ kind: 'tools', serverName });
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
      }
    );

    // NOTE: the per-connect AbortController is created ABOVE, before the OAuth
    // provider is built (F9), so the background loopback listener it starts
    // shares this connect's lifetime. It is signalled by `disconnect()` /
    // `teardownHandle` to unwind any in-flight JSON-RPC request — the cleanest
    // way to make `reloadMCP()` (or any in-flight abort) kill a child that has
    // already spawned and is waiting on `listTools()` / `callTool()`.

    // The MCP SDK `Client` exposes only `onerror`/`onclose` property
    // callbacks (see `@modelcontextprotocol/sdk/shared/protocol`), not
    // an EventTarget / `addEventListener` API, so we attach directly.
    // eslint-disable-next-line unicorn/prefer-add-event-listener
    client.onerror = (err) => {
      const description = describeError(err);
      // Route server-side stderr-ish errors to the locopilot stderr
      // so they show up in the dev-server log without crashing anything.
      console.error(`[mcp:${serverName}] client error: ${description}`);
      // F12: ignore a late error from a client that has already been replaced.
      const handle = this.handles.get(serverName);
      if (!handle || handle !== liveHandle.current) return;
      handle.status = 'error';
      handle.lastError = description;
      emitMCPEvent({
        kind: 'state',
        serverName,
        status: handle.status,
        lastError: handle.lastError,
      });
    };

    // eslint-disable-next-line unicorn/prefer-add-event-listener
    client.onclose = () => {
      // F12: a late close from a replaced client must not downgrade the new
      // handle; and an `error` handle is the more specific state, so never
      // overwrite it with `disconnected`.
      const handle = this.handles.get(serverName);
      if (!handle || handle !== liveHandle.current) return;
      if (handle.status === 'error') return;
      handle.status = 'disconnected';
      emitMCPEvent({ kind: 'state', serverName, status: handle.status });
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
    // Nothing currently awaits `placeholder.settled` — it's exposed
    // for a future consumer (see the field doc above), not read
    // anywhere today. Without this, every failed connect rejects an
    // orphaned promise with zero listeners: a genuine, deterministic
    // unhandled rejection on every single `auth_required`/`error`
    // outcome, completely independent of the OAuth/DCR error path
    // it superficially resembles in the logs. A `.catch()` here
    // doesn't stop a real future consumer from also attaching its
    // own handler later — multiple listeners on one promise are
    // fine — it just guarantees this one is never unhandled.
    settled.catch(() => {
      /* intentionally ignored — see comment above */
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
    // F12: this placeholder is the handle the callbacks should target until it
    // is replaced by the connected (or failed) handle.
    liveHandle.current = placeholder as unknown as MCPClientHandle;
    // Notify the SSE channel that a 'connecting' placeholder now
    // exists so the UI can show the "Connecting..." pill.
    emitMCPEvent({ kind: 'state', serverName, status: 'connecting' });

    // Pass the AbortSignal into client.connect() so the SDK
    // tears down the handshake cleanly if the user aborts /
    // disconnects while we're still initialising.
    // The cast to `Transport` is required because the SDK
    // ships a known type mismatch on `StreamableHTTPClientTransport.sessionId`
    // (getter is `string | undefined` but the interface declares
    // `sessionId?: string`). All three concrete classes do
    // structurally implement the interface at runtime.
    // Phase 3.5 fix: a 401 can surface from `client.connect()`
    // itself (an OAuth-provider-backed handshake) OR from
    // `client.listTools()` (a separate JSON-RPC call issued AFTER
    // `connect()` already resolved — this is what actually happens
    // when no OAuth provider is attached, since `initialize` isn't
    // guarded but `tools/list` is). Both are funnelled through this
    // single handler so neither is an unguarded escape hatch that
    // surfaces as a raw unhandled rejection instead of the
    // `auth_required` / `error` status the UI understands.
    const handleConnectionFailure = async (err: unknown) => {
      const message = describeError(err);
      // Phase 3.5: a 401 from the MCP server surfaces as
      // an `UnauthorizedError` thrown by the SDK's OAuth
      // middleware. We translate that into an `auth_required`
      // status so the UI can show a "needs auth" pill, and
      // emit a dedicated `auth-required` event so the chat
      // route can also display the auth URL inline.
      //
      // Bug #16 fix: on auth failure the transport is
      // STILL ALIVE (the SDK's `_authThenStart()` runs
      // `auth()` synchronously from inside the transport,
      // throws, and the abort controller is set but the
      // listener ports etc. are still bound). We deliberately
      // DO NOT close the transport here — `finishAuthAndRetry`
      // will need it to perform the token exchange. Closing
      // it would make the retry path unreachable.
      //
      // D2 fix: a client-registration failure (e.g. an authorization server
      // that rejects RFC 7591 Dynamic Client Registration) is just as much an
      // auth problem as a 401 — it needs the user's Authenticate affordance
      // and an accurate reason — but it must NOT keep the transport alive,
      // because no authorization code can ever arrive for it. The pure,
      // unit-tested `classifyMCPOAuthFailure` labels the failure and decides
      // both, using the AS metadata we persisted at discovery time.
      const httpStatus = extractHttpStatusCode(err);
      const oauthErrorCode = extractOAuthErrorCode(err);
      const discoveryState = await loadOAuthState(serverName);
      const meta = discoveryState.authorizationServerMetadata;
      const classification = classifyMCPOAuthFailure({
        interactive,
        isUnauthorized: err instanceof UnauthorizedError,
        httpStatus,
        oauthErrorCode,
        errorMessage: message,
        authUrlStashed: peekAuthorizationUrl(serverName) !== undefined,
        clientConfigured: config.oauth?.clientId !== undefined,
        cimdConfigured: config.oauth?.clientMetadataUrl !== undefined,
        discovery:
          meta === undefined
            ? undefined
            : {
                clientIdMetadataDocumentSupported:
                  meta.client_id_metadata_document_supported === true,
                registrationEndpointPresent: meta.registration_endpoint !== undefined,
              },
      });
      const isAuthRequired = classification.isAuthProblem;
      // D4: leave an on-disk breadcrumb for the underlying cause. The
      // MCP/OAuth path previously logged only via `console.*`, so a field
      // failure like a rejected client registration left NO trace in
      // `logs/locopilot-debug.log`.
      debugLog.diagnostic({
        layer: 'mcp',
        phase: 'oauth_error',
        serverName,
        failureKind: classification.kind,
        httpStatus,
        oauthErrorCode,
        isAuthRequired,
      });
      // F7: continue the backoff sequence from the handle this connect is
      // replacing (0 for a first-ever attempt).
      const failureCount = previousFailureCount + 1;
      const failed: MCPClientHandle = {
        name: serverName,
        config,
        client,
        status: isAuthRequired ? 'auth_required' : 'error',
        tools: [],
        // D2/D4: for an auth problem use the classifier's accurate,
        // actionable message (it names the real cause — e.g. that the
        // server rejects Dynamic Client Registration — rather than the
        // SDK's `UnauthorizedError`/empty `ServerError` text). Every other
        // failure keeps the raw described error.
        lastError: isAuthRequired ? classification.userMessage : message,
        // F5: retain the transport + controller so teardown can reach them —
        // aborting the background OAuth listener (F9), terminating the HTTP
        // session (F22) and tree-killing the stdio child (F6).
        transport,
        abortController,
        // F7: record the failure so an implicit retry backs off.
        failureCount,
        nextRetryAt: computeNextRetryAt(failureCount),
      };
      if (!classification.keepTransport) {
        // Non-auth failures (and registration failures, which can never
        // yield a code): reap the client/child now. The AbortSignal usually
        // already tore it down, but be defensive — and route it through
        // `teardownHandle` so the stdio GRANDCHILD is tree-killed (F6) even
        // when the direct `cmd.exe` child is already gone.
        await this.teardownHandle(serverName, failed);
      }
      // Only overwrite the placeholder with a failed handle if
      // nobody else has already replaced it (e.g. disconnect()
      // ran and cleared the entry).
      if (this.handles.get(serverName) === (placeholder as unknown as MCPClientHandle)) {
        this.handles.set(serverName, failed);
        // F12: retarget the callbacks at the failed handle.
        liveHandle.current = failed;
      }
      // Always emit a state change so the UI reflects the
      // new pill. For auth_required we ALSO emit the
      // dedicated event with the auth URL hint; the
      // regular `state` event keeps the existing UI in
      // sync without a special case. F7: the post-transition
      // status/`lastError` let the bus drop a repeat frame.
      emitMCPEvent({
        kind: 'state',
        serverName,
        status: failed.status,
        lastError: failed.lastError,
      });
      if (isAuthRequired) {
        // F9/D3: carry the real authorization URL (when one was stashed by
        // `redirectToAuthorization`) so the UI can render a direct link
        // instead of only relying on the dev-server stderr.
        emitMCPEvent({
          kind: 'auth-required',
          serverName,
          authUrl: peekAuthorizationUrl(serverName),
        });
      }
      placeholder.setError(err);
      // For non-auth failures, surface a connection error so
      // the caller's promise chain can branch. For
      // `auth_required` we surface a specialised error so
      // the API route can render a 401 with a different
      // shape (`{ authRequired: true, authUrl?: string }`).
      if (isAuthRequired) {
        throw new MCPConnectionError(
          `MCP server "${serverName}" requires OAuth 2.1 authentication`,
          serverName
        );
      }
      throw new MCPConnectionError(message, serverName);
    };

    // F11: resolve the per-server request timeout ONCE (the config's
    // `timeoutSeconds`, default 60s) so it applies to BOTH the `initialize`
    // handshake and the `tools/list` call. Previously neither passed a
    // `timeout`, so the SDK's hard 60s default applied even when the config
    // said `timeoutSeconds: 5`.
    const requestTimeoutMs = this.getTimeoutMs(serverName);

    try {
      await client.connect(transport as unknown as Transport, {
        signal: abortController.signal,
        timeout: requestTimeoutMs,
      });

      if (abortController.signal.aborted) {
        // disconnect() won the race — close everything and bail.
        try {
          await client.close();
        } catch {
          /* ignore */
        }
        try {
          await transport.close();
        } catch {
          /* ignore */
        }
        throw new MCPConnectionError(
          `MCP server "${serverName}" connection was aborted before completion`,
          serverName
        );
      }

      const listResult = await client.listTools(undefined, {
        signal: abortController.signal,
        timeout: requestTimeoutMs,
      });
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
        // F5: retain the transport + controller so `teardownHandle` can close
        // the client, terminate the HTTP session (F22) and tree-kill the stdio
        // child (F6). The connected handle used to drop them, so the
        // stale-handle and non-fatal-error paths could never reach the child.
        transport,
        abortController,
        // F7: a successful connect clears the backoff.
        failureCount: 0,
        nextRetryAt: undefined,
      };
      this.handles.set(serverName, handle);
      // F12: retarget the callbacks at the connected handle.
      liveHandle.current = handle;
      placeholder.setHandle(handle);
      emitMCPEvent({ kind: 'state', serverName, status: handle.status });
      return handle;
    } catch (err) {
      if (err instanceof MCPConnectionError) {
        // Already a fully classified, final error (the abort-path
        // throw above, which already closed the client/transport
        // itself) — rethrow as-is rather than re-running the 401
        // classification or closing the transport a second time.
        throw err;
      }
      // FIX 3: the signal was aborted by `teardownHandle` (F5 stale-replace)
      // or by `disconnect()`. Both paths have already removed the handle and
      // emitted `disconnected`, so surfacing the SDK's abort rejection as a
      // second `error` state would flash a bogus Error pill for a server the
      // user just disconnected and re-trigger the very SSE refetch churn F7
      // exists to remove. Report the cancellation without re-running
      // `teardownHandle` and without emitting any event.
      if (abortController.signal.aborted) {
        throw new MCPConnectionError(
          `MCP server "${serverName}" connection was cancelled`,
          serverName
        );
      }
      return handleConnectionFailure(err);
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
    return [...this.handles.values()];
  }

  /**
   * Test-only: wipe all live handles and in-flight connects and reset the
   * in-memory root config. Does NOT close live clients — tests use this to
   * isolate cases between runs; `closeAll()` is the production teardown path.
   */
  __resetForTests(): void {
    this.handles.clear();
    this.inFlight.clear();
    this.connectControllers.clear();
    this.rootConfig = { mcpServers: {} };
  }

  /**
   * F5: tear down one handle's client + transport exactly once. Shared by
   * `connect()`'s stale-handle path (`replaceStaleHandleThenConnect`) and
   * `disconnect()`.
   *
   * Order matters:
   *  1. Detach the callbacks FIRST — no-op functions, NOT `undefined` (the SDK
   *     would invoke them on close, and `exactOptionalPropertyTypes` forbids
   *     assigning `undefined` to `onerror?: ...`). This stops a late `onclose`
   *     from a dying client mutating the handle `connect()` is about to install.
   *  2. Abort the controller so any in-flight JSON-RPC call (and the background
   *     OAuth loopback listener) unwinds.
   *  3. `terminateSession()` BEFORE `transport.close()` (F22): the HTTP DELETE
   *     needs the live `mcp-session-id`. A 405 ("server does not support
   *     session termination") is spec-legal and must not throw — we log and
   *     swallow every failure.
   *  4. Tree-kill the stdio child BEFORE `transport.close()` (F6): the SDK
   *     clears its `_process` handle on close, so `get pid()` returns null
   *     afterwards and the parent-pid chain taskkill needs is gone.
   *  5. Close the transport, then the client (each isolated).
   */
  private async teardownHandle(serverName: string, handle: MCPClientHandle): Promise<void> {
    const client = handle.client;
    const transport = handle.transport;

    // FIX 4: if this teardown owns the registered in-flight connect controller,
    // drop it now — the handshake it guarded is being torn down.
    const ownsConnectController =
      handle.abortController !== undefined &&
      this.connectControllers.get(serverName) === handle.abortController;
    if (ownsConnectController) {
      this.connectControllers.delete(serverName);
    }

    // 1. Detach callbacks FIRST so nothing re-enters while we tear down.
    if (client) {
      // eslint-disable-next-line unicorn/prefer-add-event-listener
      client.onerror = () => {
        /* detached during teardown */
      };
      // eslint-disable-next-line unicorn/prefer-add-event-listener
      client.onclose = () => {
        /* detached during teardown */
      };
    }

    // 2. Abort any in-flight work tied to this handle.
    handle.abortController?.abort();

    // 3. Terminate the streamable-HTTP session (duck-typed: only that
    //    transport has `terminateSession`), errors logged + swallowed.
    if (transport) {
      const terminate = (transport as { terminateSession?: () => Promise<void> }).terminateSession;
      if (typeof terminate === 'function') {
        try {
          await terminate.call(transport);
        } catch (err) {
          console.error(`[mcp:${serverName}] terminateSession failed: ${describeError(err)}`);
        }
      }
    }

    // 4. Tree-kill the stdio child (and its grandchild) before the SDK drops
    //    the pid. `killProcessTreeByPid` is a no-op for a non-integer pid.
    const childPid = (transport as { pid?: number | null } | undefined)?.pid;
    if (typeof childPid === 'number') {
      killProcessTreeByPid(childPid);
    }

    // 5. Close transport then client.
    if (transport) {
      try {
        await transport.close();
      } catch (err) {
        console.error(`[mcp:${serverName}] error closing transport: ${describeError(err)}`);
      }
    }
    if (client) {
      try {
        await client.close();
      } catch (err) {
        console.error(`[mcp:${serverName}] error closing client: ${describeError(err)}`);
      }
    }

    // FIX 4: ensure the registered controller for the handshake we just tore
    // down is gone by the end of teardown (it may have been re-added while we
    // awaited the transport/client close).
    if (ownsConnectController) {
      this.connectControllers.delete(serverName);
    }
  }

  /**
   * Disconnect and remove a single server. Idempotent. Safe to call
   * while a connect is in flight: we abort the in-flight connect
   * and await its settlement before tearing the handle down, so the
   * child process is always reaped exactly once.
   */
  async disconnect(serverName: string): Promise<void> {
    // 1. Capture the in-flight promise (if any) so we can await it
    //    and guarantee teardown happens after the connect settles.
    const inFlight = this.inFlight.get(serverName);

    // 2. Look up the current handle. It may be a connecting
    //    placeholder OR a fully-connected client.
    const handle = this.handles.get(serverName);
    if (!handle && !inFlight) return;
    this.handles.delete(serverName);
    // After delete() the map has no entry for this name; the SSE
    // consumer will re-render and see the server as removed. F7: report the
    // post-transition status so the bus can dedupe.
    emitMCPEvent({ kind: 'state', serverName, status: 'disconnected' });

    // 3. Signal the AbortController BEFORE awaiting the in-flight connect
    //    (F9). A `connecting` handshake owns a controller to unwind the
    //    handshake; an `auth_required` handle owns one to stop the background
    //    OAuth loopback listener. This MUST precede `await inFlight`.
    if (
      handle !== undefined &&
      (handle.status === 'connecting' || handle.status === 'auth_required')
    ) {
      try {
        handle.abortController?.abort();
      } catch {
        /* ignore */
      }
    }

    // 3b. FIX 4: also abort the controller registered for an in-flight connect
    // that has no handle in the map yet (the stale-replace window: `connect()`
    // deleted the old handle and is awaiting teardown before installing the
    // placeholder). Without this, `disconnect()` would await the handshake for
    // up to the full request timeout instead of cancelling it promptly.
    const connectController = this.connectControllers.get(serverName);
    if (connectController !== undefined && !connectController.signal.aborted) {
      try {
        connectController.abort();
      } catch {
        /* ignore */
      }
    }

    // 4. Await the in-flight connect (if any) so its catch block
    //    has a chance to clean up; we don't care about its result
    //    because we're tearing down regardless.
    if (inFlight) {
      try {
        await inFlight;
      } catch {
        /* expected: the aborted connect rejects */
      }
    }

    // 5. Re-read the map: the connect task may have replaced the entry with a
    //    fully-connected (or failed) handle before our abort landed. Tear down
    //    exactly one — and drop it from the map if the connect re-populated it
    //    after our delete, so `get()` never reports a dead client.
    const latest = this.handles.get(serverName);
    const toTeardown = latest ?? handle;
    if (toTeardown === undefined) return;
    if (latest !== undefined && this.handles.get(serverName) === latest) {
      this.handles.delete(serverName);
    }
    await this.teardownHandle(serverName, toTeardown);
  }

  /**
   * Disconnect every server. Called from `shutdownMCP()` (public API)
   * and from SIGTERM/beforeExit handlers.
   */
  async closeAll(): Promise<void> {
    const names = [...new Set([...this.handles.keys(), ...this.inFlight.keys()])];
    await Promise.allSettled(names.map((name) => this.disconnect(name)));
  }

  /**
   * Phase 3.5 / F9: re-authenticate a server with OAuth 2.1 + PKCE.
   *
   * NON-BLOCKING as of F9. The flow:
   *   1) Wipe the saved token / client-info state for the server so the SDK
   *      starts from a clean slate.
   *   2) Tear down any existing handle (aborting any in-flight connect and the
   *      previous background OAuth listener).
   *   3) Call `connect({ interactive: true })`. The SDK builds an authorization
   *      URL, calls our provider's `redirectToAuthorization` (which prints the
   *      URL, emits `auth-required` and starts the loopback listener in the
   *      BACKGROUND), then throws `UnauthorizedError`. `openConnection` maps
   *      that to `auth_required`.
   *   4) Return the peeked authorization URL (if known) instead of blocking for
   *      up to 5 minutes. The background listener owns completion: when the
   *      browser hits it, `OAuthFlowHooks.onCode` calls `completeAuthorization`,
   *      which runs `finishAuthAndRetry`.
   *
   * We deliberately do NOT consume a pending authorization code here any more:
   * doing so could steal a code from a live background flow.
   *
   * Bug #4 fix: a non-`auth_required` failure (bad URL, TLS error, crash) is
   * recorded on the handle's `lastError` with a `state` event so the UI sees
   * the real reason instead of a misleading "needs auth" pill.
   */
  async reauthenticate(serverName: string): Promise<{ authUrl?: string | undefined }> {
    const config = this.rootConfig.mcpServers[serverName];
    if (!config) {
      throw new MCPConnectionError(`unknown MCP server "${serverName}"`, serverName);
    }
    if (config.oauth === undefined) {
      // No explicit "oauth" block — `buildOAuthProvider` falls
      // back to an empty one so DCR + auth still works. This call
      // is always `interactive: true`, so it's safe to let it drive DCR here.
      console.warn(
        `[mcp-oauth:${serverName}] No explicit "oauth" block in mcp.json — ` +
          `using an empty OAuth config for DCR on this authenticate attempt. ` +
          `To use a pre-registered client instead, add "oauth": { "clientId": ... } ` +
          `to the server's config.`
      );
    }
    // Drop any cached state so the SDK starts from scratch.
    await clearOAuthState(serverName);
    // Tear down any existing handle (idempotent) and await any in-flight
    // connect from a parallel caller.
    await this.disconnect(serverName);
    // F9: `interactive: true` is what lets `redirectToAuthorization` launch the
    // browser and start the loopback listener. Because that now returns
    // immediately, `connect()` rejects with `auth_required` instead of blocking.
    try {
      await this.connect(serverName, { interactive: true });
    } catch (err) {
      if (
        err instanceof MCPConnectionError &&
        this.handles.get(serverName)?.status === 'auth_required'
      ) {
        // Expected for the first handshake: the background listener owns
        // completion, so hand the UI the URL we stashed for it.
        return { authUrl: peekAuthorizationUrl(serverName) };
      }
      // Bug #4: a non-auth failure was silently being collapsed into a
      // misleading "needs auth" pill. Record the actual cause and re-emit a
      // `state` event so the UI shows the truthful error. (The old text told
      // the user to hunt for an auth URL in the dev-server log — wrong, because
      // in this path no auth URL was ever generated.)
      const message = describeError(err);
      const handle = this.handles.get(serverName);
      if (handle !== undefined) {
        handle.lastError = `OAuth sign-in for "${serverName}" failed: ${message}`;
        handle.status = 'error';
        emitMCPEvent({
          kind: 'state',
          serverName,
          status: handle.status,
          lastError: handle.lastError,
        });
      }
      return {};
    }
    // Connected (likely a previous valid token just needed a refresh).
    return {};
  }

  /**
   * F9: the background OAuth loopback listener captured an authorization code.
   * Run the SDK's token exchange and reconnect. Called from `OAuthFlowHooks`
   * `onCode`, i.e. AFTER the HTTP request that started the flow has returned —
   * so failures cannot be thrown to a caller; they are recorded on the handle
   * and pushed out as a `state` event.
   */
  private async completeAuthorization(serverName: string, code: string): Promise<void> {
    const result = await this.finishAuthAndRetry(serverName, code);
    if (!result.ok) {
      // D4: record the failed token exchange on disk (the MCP path otherwise
      // only logged to console).
      // `reason` (not `error`) is deliberate: `errorMetadata` only keeps
      // name/code/status from an object, so a plain string passed as `error`
      // would be recorded as `{ errorType: 'string' }` and the actual reason
      // would be lost.
      debugLog.diagnostic({
        layer: 'mcp',
        phase: 'oauth_token_exchange',
        serverName,
        result: 'failed',
        reason: result.reason,
      });
      const handle = this.handles.get(serverName);
      if (handle !== undefined) {
        handle.status = 'error';
        handle.lastError = `OAuth flow did not complete: ${result.reason ?? 'unknown error'}`;
        emitMCPEvent({
          kind: 'state',
          serverName,
          status: handle.status,
          lastError: handle.lastError,
        });
      }
    }
  }

  /**
   * F9: the background OAuth loopback listener ended WITHOUT a code (timeout,
   * abort, port busy, IdP error). Only annotate a handle still waiting for
   * auth — a flow that has since been superseded (or a manual retry that has
   * already connected) must not be clobbered.
   */
  private markAuthorizationFlowFailed(serverName: string, message: string): void {
    const handle = this.handles.get(serverName);
    if (handle === undefined || handle.status !== 'auth_required') return;
    // D4: when the listener ended because the 5-minute callback window
    // elapsed, name the cause and the recovery action instead of the generic
    // "did not complete" prefix (which reads as if the user did something
    // wrong). Any other cause keeps the generic wording.
    const timedOut = /timed?\s*out|timeout/i.test(message);
    handle.lastError = timedOut
      ? `Timed out after 5 minutes waiting for the browser callback. Click Authenticate to retry, or paste the redirect URL via /mcp auth ${serverName}.`
      : `OAuth flow did not complete: ${message}`;
    debugLog.diagnostic({
      layer: 'mcp',
      phase: 'oauth_error',
      serverName,
      failureKind: timedOut ? 'authorization_timeout' : 'other',
    });
    emitMCPEvent({
      kind: 'state',
      serverName,
      status: handle.status,
      lastError: handle.lastError,
    });
  }

  /**
   * Finish an in-flight OAuth flow by calling the SDK's
   * `transport.finishAuth(code)` and reconnecting with a fresh
   * transport.
   *
   * Called by:
   * - `completeAuthorization` (F9), which the background OAuth
   *   loopback listener invokes through `OAuthFlowHooks.onCode`
   *   when the user completes the consent flow in their browser.
   * - The `/api/mcp/auth` POST route — when the user pastes
   *   the code manually (serverless / port-collision
   *   fallback).
   *
   * Bug #16 fix: the SDK's `transport.finishAuth(code)` does
   * the token exchange (via `auth()` with `authorizationCode`
   * set) and writes the new tokens via `saveTokens()`. After
   * the exchange the existing transport is still "started" —
   * we cannot call `client.connect(transport)` on it again
   * because the SDK throws `'already started'`. So we close
   * the failed handle (transport + client) and let
   * `connect()` build a fresh transport. The fresh transport
   * will see the saved tokens and complete the handshake
   * without re-running the OAuth dance.
   *
   * The transport reference lives on the `auth_required`
   * handle (set in the catch block of `openConnection`); we
   * duck-type to support all three SDK transports (only
   * `http` and `sse` actually have a `finishAuth` method,
   * but the type is open).
   *
   * If no code is stashed and no code is provided, this is a
   * no-op (returns `{ ok: false, reason: 'no code' }`). The
   * caller can then surface a useful error to the user.
   */
  async finishAuthAndRetry(
    serverName: string,
    providedCode: string | undefined
  ): Promise<{ ok: boolean; connected: boolean; reason?: string }> {
    const code = providedCode ?? consumeAuthorizationCode(serverName);
    if (code === undefined || code.length === 0) {
      return { ok: false, connected: false, reason: 'no authorization code available' };
    }
    const handle = this.handles.get(serverName);
    if (handle === undefined) {
      return { ok: false, connected: false, reason: 'no in-flight connection' };
    }
    const transport = (handle as unknown as { transport?: unknown }).transport;
    if (transport === undefined) {
      return { ok: false, connected: false, reason: 'no transport on handle' };
    }
    // The SDK's transports both expose `finishAuth(code)`.
    // StreamableHTTPClientTransport and SSEClientTransport
    // declare it explicitly. We duck-type to keep this
    // method portable across the two.
    const finishAuth = (transport as { finishAuth?: (c: string) => Promise<void> }).finishAuth;
    if (typeof finishAuth !== 'function') {
      return { ok: false, connected: false, reason: 'transport does not support finishAuth' };
    }
    try {
      await finishAuth.call(transport, code);
    } catch (err) {
      const message = describeError(err);
      return { ok: false, connected: false, reason: `finishAuth failed: ${message}` };
    }
    // `finishAuth` did the token exchange; the saved tokens
    // are now in `oauthTokenStore`. Tear down the failed
    // handle (its transport is "started" and can't be
    // reused) and start a fresh connect that will see the
    // saved tokens and complete the handshake.
    await this.disconnect(serverName);
    try {
      await this.connect(serverName, { interactive: true });
      return { ok: true, connected: true };
    } catch (err) {
      const message = describeError(err);
      return { ok: false, connected: false, reason: `reconnect after auth failed: ${message}` };
    }
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
}

/**
 * F1: process-global manager state.
 *
 * Pinned on `globalThis` (like `mcp/events.ts` / `mcp/configWatcher.ts` /
 * `mcp/oauthProvider.ts`) because Next.js dev-mode HMR re-evaluates this
 * module on every edit. A module-level `const manager` created a NEW manager
 * each edit, orphaning the previous one's live stdio children and re-registering
 * the signal handlers on top of the old ones. `shutdownPromise` makes shutdown
 * idempotent / re-entrant — concurrent SIGTERM + beforeExit (or a manual
 * `shutdownMCP()` racing a signal) all await the SAME `closeAll()` instead of
 * firing it twice.
 */
interface MCPClientManagerState {
  manager: MCPClientManager;
  shutdownRegistered: boolean;
  shutdownPromise: Promise<void> | null;
}

const GLOBAL_KEY = '__mcpClientManager';

function getManagerState(): MCPClientManagerState {
  const g = globalThis as unknown as Record<string, unknown>;
  let state = g[GLOBAL_KEY] as MCPClientManagerState | undefined;
  if (!state) {
    state = { manager: new MCPClientManager(), shutdownRegistered: false, shutdownPromise: null };
    g[GLOBAL_KEY] = state;
  }
  return state;
}

/**
 * Idempotent, re-entrant shutdown: the first caller starts `closeAll()` and
 * every later caller awaits that same promise.
 */
function shutdownClientManager(state: MCPClientManagerState): Promise<void> {
  state.shutdownPromise ??= state.manager.closeAll().catch((err: unknown) => {
    console.error(`[mcp] shutdown closeAll failed: ${describeError(err)}`);
  });
  return state.shutdownPromise;
}

function ensureShutdownHandlers(state: MCPClientManagerState): void {
  if (state.shutdownRegistered) return;
  state.shutdownRegistered = true;
  const handler = (): void => {
    void shutdownClientManager(state);
  };
  process.once('SIGTERM', handler);
  process.once('SIGINT', handler);
  process.once('beforeExit', handler);
}

/**
 * Public accessor for the process-global singleton. Pinned on `globalThis` so
 * Next.js dev-mode HMR reuses the SAME manager instead of orphaning live
 * children and stacking duplicate signal handlers (F1). Tests can call
 * `getClientManager().__resetForTests()` to wipe state.
 */
export function getClientManager(): MCPClientManager {
  const state = getManagerState();
  ensureShutdownHandlers(state);
  return state.manager;
}

export type { MCPClientManager };
