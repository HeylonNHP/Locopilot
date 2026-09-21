/**
 * POST /api/mcp/auth
 *
 * Phase 3.5: re-authenticate an OAuth 2.1 MCP server.
 *
 * Request body: `{ server: string, code?: string }`
 *
 * Two modes:
 *  - `{ server }` only: drop any saved tokens and start a fresh
 *    authorization flow. The real authorization URL is returned in
 *    the response (when the SDK has produced one) and the handle is
 *    flipped to `auth_required` so the chat UI can render a clickable
 *    "Authenticate" button plus a direct authorization link.
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

import { type NextRequest, NextResponse } from 'next/server';

import { guardSameOriginMutation } from '@/app/api/mcp/originGuard';
import { getClientManager, loadMCPConfig, reauthenticateMCPServer } from '@/mcp';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const VALID_NAME_REGEX = /^[\w-]+$/i;

interface AuthBody {
  server?: unknown;
  code?: unknown;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  // F16: reject cross-site / CORS-simple POSTs FIRST. This route both
  // WIPES stored tokens and opens a browser tab, so any web page the
  // user visits could otherwise trigger it. There is no cookie/session
  // auth in this local single-user app, so a CSRF token would protect
  // nothing extra — the same-origin guard is the real control.
  const guard = guardSameOriginMutation(request);
  if (guard !== null) return guard;

  let body: AuthBody;
  try {
    body = (await request.json()) as AuthBody;
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body.' }, { status: 400 });
  }

  if (typeof body.server !== 'string' || !VALID_NAME_REGEX.test(body.server)) {
    return NextResponse.json(
      { ok: false, error: 'Invalid or missing "server" (must match /^[a-z0-9_-]+$/i).' },
      { status: 400 }
    );
  }
  const serverName = body.server;

  // Pre-flight: does the server exist and have an OAuth block?
  const config = await loadMCPConfig();
  if (!config.mcpServers[serverName]) {
    return NextResponse.json(
      { ok: false, error: `unknown MCP server "${serverName}"` },
      { status: 404 }
    );
  }
  if (config.mcpServers[serverName]?.oauth === undefined) {
    // No explicit "oauth" block — `buildOAuthProvider` falls back
    // to an empty one so DCR + auth still works for this explicit
    // authenticate request. To use a pre-registered client instead,
    // add "oauth": { "clientId": ... } to the server's config.
    console.warn(
      `[mcp-oauth:${serverName}] No explicit "oauth" block in mcp.json — ` +
        `using an empty OAuth config for DCR on this authenticate attempt.`
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
        { status: 400 }
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
      { status: 400 }
    );
  }
  // D3: surface the REAL authorization URL when one was stashed by the
  // SDK's `redirectToAuthorization`, so the UI can render a direct link
  // immediately. Omit the field entirely when no URL exists yet.
  const authUrl = result.authUrl;
  return NextResponse.json(
    authUrl === undefined
      ? { ok: true, server: serverName, connected: false }
      : { ok: true, server: serverName, connected: false, authUrl }
  );
}
