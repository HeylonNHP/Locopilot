/**
 * REST endpoints for MCP (Model Context Protocol) server inspection.
 *
 *   GET  /api/mcp        - list configured servers, their status, and tools
 *                          (?connect=<name> forces a lazy connect for that one server;
 *                           ?eager=1 opts into eager connection of every enabled
 *                           server and ?force=1 bypasses the per-server retry
 *                           backoff — both are F7 opt-ins used by the sidebar for
 *                           first-load discovery / explicit retry, so a plain GET
 *                           never re-dials a broken server)
 *   POST /api/mcp        - { action: "reload" } closes all live clients and
 *                          re-reads the on-disk config.
 *   PUT  /api/mcp        - { name, action: "enable" | "disable" } flips the
 *                          `disabled` flag for one server in
 *                          `~/.locopilot/mcp.json` and reloads the in-memory
 *                          client manager so the change takes effect.
 *
 * Phase 1 deliberately keeps this read-mostly. Server add/remove/edit
 * is done by editing `~/.locopilot/mcp.json` directly; a richer UI is
 * planned for Phase 2.
 */

import { type NextRequest, NextResponse } from 'next/server';

import {
  listMCPServersWithStatus,
  MCPConfigError,
  type MCPListResult,
  reloadMCP,
  saveMCPServerDisabled,
} from '@/mcp';

export const dynamic = 'force-dynamic';

// Same regex as `mcp/configLoader.ts` (re-declared here so the API
// layer can reject obvious garbage before round-tripping to disk).
const VALID_NAME_REGEX = /^[\w-]+$/i;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const params = request.nextUrl.searchParams;
  const connectName = params.get('connect');
  // F7: eagerly connecting every enabled server is now OPT-IN. The
  // sidebar sends `?eager=1` for first-load discovery and explicit
  // retries; `?force=1` additionally bypasses the retry backoff. A
  // plain GET must be side-effect free, otherwise the SSE-driven
  // refetch re-dials unreachable servers and spins the
  // connect→SSE→GET /api/mcp→connect loop.
  const eager = params.get('eager') === '1';
  const force = params.get('force') === '1';
  try {
    const result = await listMCPServersWithStatus(
      connectName ? { connect: connectName } : { eagerConnect: eager, force }
    );
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: `Failed to list MCP servers: ${message}` }, { status: 500 });
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
      { status: 400 }
    );
  }

  try {
    const result = await reloadMCP();
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: `MCP reload failed: ${message}` }, { status: 500 });
  }
}

interface PutBody {
  name: string;
  action: 'enable' | 'disable';
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  let body: PutBody;
  try {
    body = (await request.json()) as PutBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const { name, action } = body;

  if (typeof name !== 'string' || !VALID_NAME_REGEX.test(name)) {
    return NextResponse.json(
      { error: 'Invalid or missing "name" (must match /^[a-z0-9_-]+$/i).' },
      { status: 400 }
    );
  }
  if (action !== 'enable' && action !== 'disable') {
    return NextResponse.json(
      { error: 'Invalid "action" (must be "enable" or "disable").' },
      { status: 400 }
    );
  }

  try {
    await saveMCPServerDisabled(name, action === 'disable');
  } catch (err) {
    if (err instanceof MCPConfigError) {
      // Unknown server / bad shape / parse error — treat as 400
      // (the user can fix it by editing mcp.json).
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: `MCP save failed: ${message}` }, { status: 500 });
  }

  // Reload the in-memory client manager so the change takes effect.
  // Returns the fresh status listing in the same shape as GET.
  let result: MCPListResult;
  try {
    result = await reloadMCP();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json(
      { error: `MCP reload after save failed: ${message}` },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true, servers: result.servers });
}
