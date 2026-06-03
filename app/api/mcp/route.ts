/**
 * REST endpoints for MCP (Model Context Protocol) server inspection.
 *
 *   GET  /api/mcp        - list configured servers, their status, and tools
 *                          (?connect=<name> forces a lazy connect for that one server)
 *   POST /api/mcp        - { action: "reload" } closes all live clients and
 *                          re-reads the on-disk config.
 *
 * Phase 1 deliberately keeps this read-mostly. Server add/remove/edit
 * is done by editing `~/.locopilot/mcp.json` directly; a richer UI is
 * planned for Phase 2.
 */

import { NextRequest, NextResponse } from 'next/server';

import { listMCPServersWithStatus, reloadMCP } from '../../../mcp';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
    const connectName = request.nextUrl.searchParams.get('connect');
    try {
        const result = await listMCPServersWithStatus(connectName ? { connect: connectName } : {});
        return NextResponse.json(result);
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return NextResponse.json(
            { error: `Failed to list MCP servers: ${message}` },
            { status: 500 },
        );
    }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
    let body: Record<string, unknown>;
    try {
        body = (await request.json()) as Record<string, unknown>;
    } catch {
        return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
    }

    const action = body.action;
    if (action !== 'reload') {
        return NextResponse.json(
            { error: 'Unknown action. Phase 1 supports only { action: "reload" }.' },
            { status: 400 },
        );
    }

    try {
        const result = await reloadMCP();
        return NextResponse.json({ ok: true, ...result });
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return NextResponse.json(
            { error: `MCP reload failed: ${message}` },
            { status: 500 },
        );
    }
}
