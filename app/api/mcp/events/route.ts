/**
 * GET /api/mcp/events
 *
 * Server-Sent Events stream of MCP server state changes. The sidebar
 * MCP tab opens a long-lived connection here instead of polling
 * `/api/mcp` every 5s. Whenever a server's status changes, a tool
 * list refreshes, or `mcp.json` is rewritten (manually or via
 * `PUT /api/mcp`), the bus in `mcp/events.ts` fires and we forward
 * a frame to the browser.
 *
 * Wire format: `event: mcp-state\ndata: <json>\n\n` (one frame per
 * emit). The browser-side `EventSource` calls `fetchServers()` on
 * every frame so the UI stays in sync without polling.
 *
 * Initial snapshot: a `mcp-state` frame is sent IMMEDIATELY after
 * subscription so the client doesn't have to wait for the next event
 * to render. The order (subscribe first, snapshot first) is
 * important — it guarantees the client never misses an event that
 * fires between subscription and snapshot.
 *
 * Keep-alive: a `: keep-alive` comment is sent every 15s to defeat
 * idle-timeout proxies.
 */

import type { NextRequest } from 'next/server';

import { listMCPServersWithStatus, subscribeMCPEvents, type MCPEvent } from '../../../../mcp';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const KEEPALIVE_MS = 15_000;

export async function GET(request: NextRequest): Promise<Response> {
    const encoder = new TextEncoder();

    let unsubscribe: (() => void) | null = null;
    let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
    let closed = false;

    const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
            const safeEnqueue = (chunk: string): void => {
                if (closed) return;
                try {
                    controller.enqueue(encoder.encode(chunk));
                } catch {
                    // Controller was already closed by the runtime;
                    // flip the flag so the keepalive timer stops.
                    closed = true;
                }
            };

            const sendFrame = (event: MCPEvent): void => {
                safeEnqueue(`event: mcp-state\ndata: ${JSON.stringify(event)}\n\n`);
            };

            // 1) Subscribe FIRST so we never miss an event that fires
            //    while the initial snapshot is being computed.
            unsubscribe = subscribeMCPEvents((event: MCPEvent) => {
                sendFrame(event);
            });

            // 2) Send the keep-alive ping on a regular cadence.
            //    SSE comments (lines starting with `:`) are ignored
            //    by the browser's EventSource but keep the socket
            //    warm on idle proxies.
            keepaliveTimer = setInterval(() => {
                safeEnqueue(`: keep-alive\n\n`);
            }, KEEPALIVE_MS);

            // 3) Compute the initial snapshot and send it. The
            //    `connect: undefined` here means "eagerly connect to
            //    every enabled server" (same as `GET /api/mcp`).
            try {
                const result = await listMCPServersWithStatus({});
                // The shape we send is a tiny hint + the snapshot
                // inline so the consumer can re-render without a
                // follow-up GET. The `entries` field is optional in
                // the type but always present on initial-snapshot
                // frames.
                safeEnqueue(
                    `event: mcp-state\ndata: ${JSON.stringify({
                        kind: 'snapshot',
                        entries: result.servers,
                    } as MCPEvent)}\n\n`,
                );
            } catch (err) {
                // Don't kill the stream if the initial snapshot
                // fails — just log it and let subsequent events
                // re-sync. The browser will still see the error in
                // the dev-server log via console.error below.
                const message = err instanceof Error ? err.message : String(err);
                console.error(`[mcp-events] initial snapshot failed: ${message}`);
            }

            // 4) Wire the abort signal so a client disconnect (tab
            //    closed, navigation, dev HMR reload) tears down
            //    everything cleanly.
            request.signal.addEventListener('abort', () => {
                if (closed) return;
                closed = true;
                if (unsubscribe) {
                    unsubscribe();
                    unsubscribe = null;
                }
                if (keepaliveTimer) {
                    clearInterval(keepaliveTimer);
                    keepaliveTimer = null;
                }
                try {
                    controller.close();
                } catch {
                    // Already closed — fine.
                }
            });
        },
        cancel() {
            // Triggered when the consumer side closes the stream
            // (browser navigates away, network drops). Same teardown
            // as the abort handler.
            closed = true;
            if (unsubscribe) {
                unsubscribe();
                unsubscribe = null;
            }
            if (keepaliveTimer) {
                clearInterval(keepaliveTimer);
                keepaliveTimer = null;
            }
        },
    });

    return new Response(stream, {
        status: 200,
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            // Disable Nginx-style response buffering so frames are
            // flushed as soon as we enqueue them.
            'X-Accel-Buffering': 'no',
        },
    });
}
