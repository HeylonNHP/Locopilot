/**
 * GET /api/mcp/config-path
 *
 * Returns the absolute filesystem path to the user's MCP config
 * file (`~/.locopilot/mcp.json`). Exposed to the browser so the
 * sidebar can show a clickable hint in the empty-state / footer.
 *
 * The path is computed on the server via `os.homedir()`; we never
 * trust a client-supplied path.
 */

import { NextResponse } from 'next/server';

import { getMCPConfigPath } from '../../../../mcp';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
    return NextResponse.json({ path: getMCPConfigPath() });
}
