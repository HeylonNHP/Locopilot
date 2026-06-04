/**
 * POST /api/mcp/auth
 *
 * Phase 3.5: re-authenticate an OAuth 2.1 MCP server.
 *
 * Request body: `{ server: string, code?: string }`
 *
 * Two modes:
 *  - `{ server }` only: drop any saved tokens and start a fresh
 *    authorization flow. The server's URL is printed to the
 *    locopilot dev-server stderr (so a headless user can copy /
 *    paste it) and the handle is flipped to `auth_required` so
 *    the chat UI can render a clickable "Authenticate" button.
 *  - `{ server, code }`: forward the captured authorization code
 *    to the SDK via `transport.finishAuth(code)` and retry the
 *    connection. Used by the serverless fallback (where the
 *    loopback listener isn't available and the user pastes the
 *    code back via the chat).
 *
 * Response shape:
 *  - Success: `{ ok: true, server, connected: boolean, authUrl?: string }`
 *  - Failure: `{ ok: false, error: string }`
 *
 * Idempotent: calling with a server that is already connected is
 * a no-op (`ok: true, connected: true`).
 */

import { NextRequest, NextResponse } from 'next/server';

import { getClientManager, loadMCPConfig, reauthenticateMCPServer } from '../../../../mcp';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const VALID_NAME_REGEX = /^[a-z0-9_-]+$/i;

interface AuthBody {
    server?: unknown;
    code?: unknown;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
    let body: AuthBody;
    try {
        body = (await request.json()) as AuthBody;
    } catch {
        return NextResponse.json({ ok: false, error: 'Invalid JSON body.' }, { status: 400 });
    }

    if (typeof body.server !== 'string' || !VALID_NAME_REGEX.test(body.server)) {
        return NextResponse.json(
            { ok: false, error: 'Invalid or missing "server" (must match /^[a-z0-9_-]+$/i).' },
            { status: 400 },
        );
    }
    const serverName = body.server;

    // Pre-flight: does the server exist and have an OAuth block?
    const config = await loadMCPConfig();
    if (!config.mcpServers[serverName]) {
        return NextResponse.json(
            { ok: false, error: `unknown MCP server "${serverName}"` },
            { status: 404 },
        );
    }
    if (config.mcpServers[serverName]?.oauth === undefined) {
        return NextResponse.json(
            { ok: false, error: `MCP server "${serverName}" has no OAuth config` },
            { status: 400 },
        );
    }

    const manager = getClientManager();
    manager.setRootConfig(config);

    // Manual-code path: user pasted the code (serverless /
    // loopback-listen-failed). Forward to the SDK.
    if (typeof body.code === 'string' && body.code.length > 0) {
        const result = await manager.finishAuthAndRetry(serverName, body.code);
        if (!result.ok) {
            return NextResponse.json(
                { ok: false, error: result.reason ?? 'finishAuth failed' },
                { status: 400 },
            );
        }
        return NextResponse.json({ ok: true, server: serverName, connected: result.connected });
    }

    // No-code path: drop tokens and re-trigger the connect. The
    // catch in `openConnection` will flip the handle to
    // `auth_required` and emit the `auth-required` event.
    const result = await reauthenticateMCPServer(serverName);
    if (!result.ok) {
        return NextResponse.json(
            { ok: false, error: result.reason ?? 'reauthenticate failed' },
            { status: 400 },
        );
    }
    return NextResponse.json({ ok: true, server: serverName, connected: false });
}
