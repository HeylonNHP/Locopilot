/**
 * Same-origin guard for state-changing MCP routes (F16).
 *
 * Locopilot's API is served to a local single-user app, so the ambient
 * capability is not a cookie but "a loopback HTTP server exists": any web page
 * the user visits can fire a CORS-simple `fetch()` POST at it. These checks make
 * such a request non-simple and cross-site-detected:
 *   1. JSON Content-Type — forces a preflight for cross-origin fetch, which this
 *      app never approves (no CORS headers anywhere).
 *   2. Sec-Fetch-Site — browser-set, page JS cannot forge it.
 *   3. Origin/Referer fallback compared against Host, for older browsers.
 * Returns a ready-to-return error response, or `null` when the request is OK.
 */
import { type NextRequest, NextResponse } from 'next/server';

const ALLOWED_FETCH_SITES = new Set(['same-origin', 'same-site', 'none']);

export function guardSameOriginMutation(request: NextRequest): NextResponse | null {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    return NextResponse.json(
      { ok: false, error: 'Content-Type must be application/json.' },
      { status: 415 }
    );
  }
  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite !== null && !ALLOWED_FETCH_SITES.has(fetchSite)) {
    return NextResponse.json({ ok: false, error: 'Cross-site request rejected.' }, { status: 403 });
  }
  if (fetchSite === null) {
    const source = request.headers.get('origin') ?? request.headers.get('referer');
    if (source === null || source === 'null') {
      return NextResponse.json({ ok: false, error: 'Missing origin.' }, { status: 403 });
    }
    let sourceHost: string;
    try {
      sourceHost = new URL(source).host;
    } catch {
      return NextResponse.json({ ok: false, error: 'Invalid origin.' }, { status: 403 });
    }
    const targetHost = request.headers.get('host');
    if (targetHost !== null && sourceHost !== targetHost) {
      return NextResponse.json(
        { ok: false, error: 'Origin does not match host.' },
        { status: 403 }
      );
    }
  }
  return null;
}
