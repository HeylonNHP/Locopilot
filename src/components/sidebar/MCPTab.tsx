'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import type { MCPStatusEntry } from '@/mcp';

const STATUS_LABEL: Record<MCPStatusEntry['status'], string> = {
  connected: 'Connected',
  connecting: 'Connecting…',
  disconnected: 'Disconnected',
  error: 'Error',
  not_loaded: 'Disabled',
  auth_required: 'Needs auth',
};

function toolCountLabel(n: number): string {
  if (n === 0) return 'No tools';
  if (n === 1) return '1 tool';
  return `${n} tools`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1)).trimEnd()  }…`;
}

export default function MCPTab() {
  const [servers, setServers] = useState<MCPStatusEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [configPath, setConfigPath] = useState<string>('~/.locopilot/mcp.json');

  const togglingRef = useRef(false);
  // Bug #10 fix: track in-flight Authenticate POSTs so a
  // double-click doesn't fire two parallel requests. The ref
  // is the source of truth; the version state is just a
  // tick to re-render the button's `disabled` prop when the
  // set changes.
  const inFlightAuthsRef = useRef<Set<string>>(new Set());
  const [, setInFlightAuthsVersion] = useState(0);

  const fetchServers = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await fetch('/api/mcp');
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as { servers: MCPStatusEntry[] };
      setServers(data.servers ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load MCP servers');
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchConfigPath = useCallback(async () => {
    try {
      const res = await fetch('/api/mcp/config-path');
      if (!res.ok) return;
      const data = (await res.json()) as { path?: string };
      if (data.path) setConfigPath(data.path);
    } catch {
      // Non-fatal: the empty-state just falls back to the tilde path.
    }
  }, []);

  useEffect(() => {
    fetchServers();
    fetchConfigPath();
  }, [fetchServers, fetchConfigPath]);

  // Push-based refresh via SSE. The backend publishes every MCP
  // state transition, tool-list change, and mcp.json rewrite on
  // `/api/mcp/events`; we just call the existing `fetchServers()`
  // (debounced) on every frame. The 5s `setInterval` it replaces
  // is gone — no more polling.
  //
  // Same `togglingRef` pause applies: while a `PUT /api/mcp` is in
  // flight we don't want the SSE-triggered refresh to clobber the
  // optimistic update that will be overwritten by the PUT response
  // a few hundred ms later.
  useEffect(() => {
    const DEBOUNCE_MS = 150;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleFetch = (): void => {
      if (togglingRef.current) return;
      if (debounceTimer !== null) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        void fetchServers();
      }, DEBOUNCE_MS);
    };

    // Manual reconnect logic. EventSource auto-reconnects only for
    // transient network errors (readyState === CONNECTING). If the
    // server returns a non-2xx status, the stream is closed and
    // the browser will NOT retry — the whole point of this SSE
    // migration is silently lost on a single server hiccup. We
    // detect CLOSED and reopen with exponential backoff capped
    // at 30s.
    let source: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let backoffMs = 1000;
    const MAX_BACKOFF_MS = 30_000;
    let disposed = false;

    const open = (): void => {
      if (disposed) return;
      source = new EventSource('/api/mcp/events');
      source.addEventListener('mcp-state', scheduleFetch);
      source.addEventListener('open', () => {
        // Successful (re)connect — reset backoff.
        backoffMs = 1000;
      });
      source.onerror = () => {
        if (!source) return;
        if (source.readyState === EventSource.CLOSED) {
          // Permanent failure (server returned non-2xx, etc.).
          // Close the dead handle and schedule a manual
          // reconnect with exponential backoff.
          source.close();
          source = null;
          if (reconnectTimer !== null) clearTimeout(reconnectTimer);
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
            open();
          }, backoffMs);
        }
        // else: readyState === CONNECTING — the browser is
        // already retrying on its own. Nothing to do.
      };
    };
    open();

    return () => {
      disposed = true;
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (source) {
        source.removeEventListener('mcp-state', scheduleFetch);
        source.close();
        source = null;
      }
    };
  }, [fetchServers]);

  const toggleServer = useCallback(
    async (name: string, currentlyDisabled: boolean) => {
      const action = currentlyDisabled ? 'enable' : 'disable';
      togglingRef.current = true;
      // Optimistic update: flip the local pill to "Disabled" or
      // "Disconnected" depending on the new state. The server
      // response replaces local state on success, so any
      // mismatch here is corrected within one round-trip.
      setServers((prev) =>
        prev.map((s) =>
          s.name === name ? { ...s, status: currentlyDisabled ? 'disconnected' : 'not_loaded' } : s
        )
      );
      try {
        const res = await fetch('/api/mcp', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, action }),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(data.error ?? `HTTP ${res.status}`);
        }
        const data = (await res.json()) as { servers: MCPStatusEntry[] };
        setServers(data.servers ?? []);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to update MCP server');
        // Revert by re-fetching authoritative state.
        await fetchServers();
      } finally {
        togglingRef.current = false;
      }
    },
    [fetchServers]
  );

  const reloadFromDisk = useCallback(async () => {
    try {
      setError(null);
      const res = await fetch('/api/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reload' }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      await fetchServers();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reload MCP config');
    }
  }, [fetchServers]);

  const authenticateServer = useCallback(
    async (name: string) => {
      // Bug #10 fix: in-flight guard. The Authenticate button
      // fires a POST to /api/mcp/auth; a double-click would
      // send two parallel requests and could double-trigger
      // the loopback listener / token-exchange path. Track
      // the set of names currently in flight and disable
      // re-entry until the response lands (success OR error).
      if (inFlightAuthsRef.current.has(name)) {
        return;
      }
      inFlightAuthsRef.current.add(name);
      setInFlightAuthsVersion((v) => v + 1);
      try {
        setError(null);
        const res = await fetch('/api/mcp/auth', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ server: name }),
        });
        const data = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          error?: string;
          connected?: boolean;
        };
        if (!res.ok || data.ok !== true) {
          throw new Error(data.error ?? `HTTP ${res.status}`);
        }
        // The auth URL is printed to the dev-server stderr. We
        // can't show it inline (the SDK doesn't hand it back to
        // the browser for security), but a fresh connect
        // attempt will surface it via the chat route's
        // auth-required handling and via the server log.
        // Eagerly re-fetch the server list so the pill flips
        // from "needs auth" to "connecting" / "connected".
        await fetchServers();
      } catch (err) {
        setError(err instanceof Error ? err.message : `Failed to authenticate ${name}`);
      } finally {
        inFlightAuthsRef.current.delete(name);
        setInFlightAuthsVersion((v) => v + 1);
      }
    },
    [fetchServers]
  );

  return (
    <>
      <div className="skills-panel-header">
        <div className="skills-panel-header-title">MCP</div>
        <div className="skills-panel-header-actions">
          <button
            className="skills-panel-header-btn"
            onClick={reloadFromDisk}
            aria-label="Reload MCP config from disk"
            title="Reload config"
          >
            ↻
          </button>
        </div>
      </div>

      {loading && servers.length === 0 ? (
        <div className="skills-panel-empty">Loading MCP servers…</div>
      ) : error ? (
        <div className="skills-panel-error" style={{ margin: '12px' }}>
          <span className="skills-panel-error-text">{error}</span>
          <button className="skills-panel-error-retry" onClick={fetchServers}>
            Retry
          </button>
        </div>
      ) : (
        <div className="skills-panel-body">
          {servers.length === 0 && (
            <div className="skills-panel-empty">
              <p className="skills-panel-empty-title">No MCP servers configured</p>
              <p className="skills-panel-empty-hint">
                Add servers to <code className="skills-panel-empty-code">{configPath}</code> and
                click <span aria-hidden="true">↻</span> to reload.
              </p>
            </div>
          )}
          {servers.map((server) => {
            const isDisabled = server.status === 'not_loaded';
            const showError = server.status === 'error' && server.lastError;
            const showAuth = server.status === 'auth_required';
            return (
              <div key={server.name} className="skills-panel-mcp-item">
                <div className="skills-panel-mcp-item-row">
                  <div className="skills-panel-mcp-item-info">
                    <div className="skills-panel-mcp-item-name">{server.name}</div>
                    <div className="skills-panel-mcp-item-badges">
                      <span
                        className={`skills-panel-mcp-transport skills-panel-mcp-transport--${server.transport}`}
                        title={`Transport: ${server.transport}`}
                      >
                        {server.transport}
                      </span>
                      <span
                        className={`skills-panel-mcp-status skills-panel-mcp-status--${server.status}`}
                      >
                        {STATUS_LABEL[server.status]}
                      </span>
                      <span
                        className="skills-panel-mcp-toolcount"
                        title={`${server.toolCount} tool${server.toolCount === 1 ? '' : 's'} available`}
                      >
                        {toolCountLabel(server.toolCount)}
                      </span>
                    </div>
                  </div>
                  {showAuth ? (
                    // Phase 3.5: an OAuth-protected
                    // server whose 401 we have not
                    // yet satisfied. The button
                    // calls /api/mcp/auth which
                    // drops the saved tokens and
                    // re-triggers the connect; the
                    // SDK prints the auth URL to
                    // the dev-server stderr and
                    // starts the loopback listener.
                    // Bug #10 fix: disabled while
                    // a request is in flight.
                    <button
                      className="skills-panel-mcp-auth-btn"
                      onClick={() => authenticateServer(server.name)}
                      disabled={inFlightAuthsRef.current.has(server.name)}
                      title="Open the OAuth authorization URL printed to the dev-server stderr"
                    >
                      {inFlightAuthsRef.current.has(server.name)
                        ? 'Authenticating…'
                        : 'Authenticate'}
                    </button>
                  ) : (
                    <label
                      className="skills-panel-toggle-switch"
                      htmlFor={`mcp-toggle-${server.name}`}
                      aria-label={`${isDisabled ? 'Enable' : 'Disable'} ${server.name}`}
                    >
                      <input
                        id={`mcp-toggle-${server.name}`}
                        type="checkbox"
                        checked={!isDisabled}
                        disabled={server.status === 'connecting'}
                        aria-disabled={server.status === 'connecting'}
                        onChange={() => toggleServer(server.name, isDisabled)}
                      />
                      <span className="skills-panel-toggle-switch-slider" />
                    </label>
                  )}
                </div>
                {server.description && (
                  <div className="skills-panel-mcp-item-desc">{server.description}</div>
                )}
                {showError && (
                  <div className="skills-panel-mcp-item-error" title={server.lastError}>
                    {truncate(server.lastError ?? '', 200)}
                  </div>
                )}
                {showAuth && (
                  <div className="skills-panel-mcp-item-error" title={server.lastError ?? ''}>
                    {truncate(server.lastError ?? 'OAuth 2.1 + PKCE required.', 200)}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="skills-panel-footer">
        <p className="skills-panel-footer-hint">
          Edit <code title={configPath}>~/.locopilot/mcp.json</code> to add servers. Click{' '}
          <span aria-hidden="true">↻</span> to reload.
        </p>
      </div>
    </>
  );
}
