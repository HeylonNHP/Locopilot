/**
 * Process-global pub/sub bus for MCP server state changes.
 *
 * The frontend's MCP tab used to poll `/api/mcp` every 5s to keep the
 * status pills in sync. That was wasteful and laggy. The new contract
 * is push-based: every state transition inside `MCPClientManager` and
 * every `mcp.json` rewrite emits an event here, and the SSE route
 * (`app/api/mcp/events/route.ts`) streams those events to the browser.
 *
 * Design notes:
 * - This is a singleton stashed on `globalThis` so Next.js's dev HMR
 *   doesn't create a second bus when `mcp/events.ts` re-evaluates.
 *   (Same trick Prisma / NextAuth use.)
 * - Listeners are called synchronously. The bus wraps each listener
 *   call in a try/catch so a misbehaving subscriber can't poison the
 *   manager's call path.
 * - `subscribe` returns an unsubscribe function so route handlers can
 *   clean up on `request.signal.aborted` without juggling indexes.
 *
 * The event payload is intentionally small: the actual status listing
 * is computed by the consumer (via `listMCPServersWithStatus`) so we
 * don't have to re-shape per-server entries on the producer side.
 */

export type MCPStatusEntry = {
  name: string;
  description: string | undefined;
  transport: 'stdio' | 'http' | 'sse';
  status: 'disconnected' | 'connecting' | 'connected' | 'error' | 'not_loaded' | 'auth_required';
  lastError?: string | undefined;
  authUrl?: string | undefined;
  tools: Array<{ name: string; description: string | undefined; fullName: string }>;
  toolCount: number;
};

export type MCPEvent =
  /** A single server transitioned state (connecting/connected/error/disconnected). */
  | { kind: 'state'; serverName: string }
  /** A server's tool list was refreshed (notifications/tools/list_changed). */
  | { kind: 'tools'; serverName: string }
  /** The on-disk mcp.json was modified externally (or by `PUT /api/mcp`). */
  | { kind: 'config' }
  /**
   * A server hit a 401 / unauthorized response. The UI should
   * surface a "needs auth" pill and offer a click-to-authenticate
   * action. The actual IdP authorization URL is printed to the
   * dev-server stderr; the loopback listener handles the
   * callback internally so the UI never has to display the
   * URL (bug #18: there used to be an `authUrl` field here
   * that the client never read).
   */
  | { kind: 'auth-required'; serverName: string }
  /** Initial full-state payload sent by the SSE route right after subscribing. */
  | { kind: 'snapshot'; entries: MCPStatusEntry[] };

type Listener = (event: MCPEvent) => void;

interface MCPEventBus {
  listeners: Set<Listener>;
}

const GLOBAL_KEY = '__mcpEventBus';

function getBus(): MCPEventBus {
  const g = globalThis as unknown as Record<string, unknown>;
  let bus = g[GLOBAL_KEY] as MCPEventBus | undefined;
  if (!bus) {
    bus = { listeners: new Set() };
    g[GLOBAL_KEY] = bus;
  }
  return bus;
}

/**
 * Subscribe to MCP events. Returns an unsubscribe function. Safe to
 * call from any module (server-side only — this file should not be
 * imported from client components).
 */
export function subscribeMCPEvents(fn: Listener): () => void {
  const bus = getBus();
  bus.listeners.add(fn);
  return () => {
    bus.listeners.delete(fn);
  };
}

/**
 * Fire an event to all current subscribers. Failures are isolated per
 * listener so a single misbehaving subscriber can't stop delivery to
 * the rest. Never throws.
 */
export function emitMCPEvent(event: MCPEvent): void {
  const bus = getBus();
  for (const fn of bus.listeners) {
    try {
      fn(event);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Use console.error rather than throwing — emit() is called
      // from deep inside the client manager and the last thing
      // we want is a bad listener breaking the connect path.
      console.error(`[mcp-events] listener threw: ${message}`);
    }
  }
}

