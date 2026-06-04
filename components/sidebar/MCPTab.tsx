'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { MCPStatusEntry } from '@/mcp';

const STATUS_LABEL: Record<MCPStatusEntry['status'], string> = {
    connected: 'Connected',
    connecting: 'Connecting…',
    disconnected: 'Disconnected',
    error: 'Error',
    not_loaded: 'Disabled',
};

function toolCountLabel(n: number): string {
    if (n === 0) return 'No tools';
    if (n === 1) return '1 tool';
    return `${n} tools`;
}

function truncate(s: string, max: number): string {
    if (s.length <= max) return s;
    return s.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}

export default function MCPTab() {
    const [servers, setServers] = useState<MCPStatusEntry[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [configPath, setConfigPath] = useState<string>('~/.locopilot/mcp.json');

    const togglingRef = useRef(false);

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

        const source = new EventSource('/api/mcp/events');
        source.addEventListener('mcp-state', scheduleFetch);
        source.onerror = () => {
            // EventSource auto-reconnects with an exponential backoff,
            // so we don't need to manually re-open. We DO want to log
            // so dev sees a transient drop on the console.
            // (EventSource fires `onerror` on every retry attempt
            // until the stream comes back — this is expected, not a
            // bug.)
        };

        return () => {
            if (debounceTimer !== null) {
                clearTimeout(debounceTimer);
                debounceTimer = null;
            }
            source.removeEventListener('mcp-state', scheduleFetch);
            source.close();
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
                prev.map((s) => (s.name === name ? { ...s, status: currentlyDisabled ? 'disconnected' : 'not_loaded' } : s)),
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
        [fetchServers],
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

    return (
        <>
            <div className="skills-panel-header">
                <div className="skills-panel-header-title">MCP</div>
                <div className="skills-panel-header-actions">
                    <button
                        className="skills-panel-header-btn"
                        onClick={reloadFromDisk}
                        aria-label="Reload MCP config from disk"
                        title="Reload from disk"
                    >
                        ↻
                    </button>
                    <button
                        className="skills-panel-header-btn"
                        onClick={fetchServers}
                        aria-label="Refresh MCP servers"
                        title="Refresh"
                    >
                        ⟳
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
                                Add servers to <code className="skills-panel-empty-code">{configPath}</code>{' '}
                                and click <span aria-hidden="true">↻</span> to reload.
                            </p>
                        </div>
                    )}
                    {servers.map((server) => {
                        const isDisabled = server.status === 'not_loaded';
                        const showError = server.status === 'error' && server.lastError;
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
                                </div>
                                {server.description && (
                                    <div className="skills-panel-mcp-item-desc">{server.description}</div>
                                )}
                                {showError && (
                                    <div
                                        className="skills-panel-mcp-item-error"
                                        title={server.lastError}
                                    >
                                        {truncate(server.lastError ?? '', 200)}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}

            <div className="skills-panel-footer">
                <p className="skills-panel-footer-hint">
                    Edit{' '}
                    <code title={configPath}>~/.locopilot/mcp.json</code> to add servers. Click{' '}
                    <span aria-hidden="true">↻</span> to reload.
                </p>
            </div>
        </>
    );
}
