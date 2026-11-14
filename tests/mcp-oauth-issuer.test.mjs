/**
 * Regression tests for the OAuth credential binding (GHSA-6qxp-vccf-f47h).
 *
 * The MCP SDK stamps every credential it hands to `saveTokens()` /
 * `saveClientInformation()` with the `issuer` — the authorization server the
 * credential belongs to — and refuses to send a stamped credential to a
 * DIFFERENT authorization server. The advisory is about the client letting
 * the MCP server CHOOSE that authorization server: a malicious or
 * compromised server could name its own AS and collect the refresh token
 * and the client secret we were holding for a legitimate one.
 *
 * The SDK only does that binding if the provider stores the stamp and
 * hands it back unchanged, so these tests drive the REAL provider (and the
 * real token store) rather than asserting on the source text.
 *
 * Network-free: nothing here contacts an authorization server. The store is
 * isolated by mocking `node:os`'s `homedir()` to point at a temp directory
 * BEFORE the modules are imported — the store resolves its path from
 * `os.homedir()` on every call, so the user's real
 * `~/.locopilot/mcp-oauth-tokens.json` is never read or written. (`$HOME`
 * alone is not enough: Jest's sandbox gives the test its own `process.env`
 * copy, while the native `os.homedir()` reads the real environment.)
 */

import { afterAll, beforeAll, describe, expect, jest, test } from '@jest/globals';
import { auth } from '@modelcontextprotocol/sdk/client/auth.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tempHome = await mkdtemp(path.join(tmpdir(), 'locopilot-mcp-issuer-'));

jest.unstable_mockModule('node:os', () => {
  const actual = jest.requireActual('node:os');
  const patched = { ...actual, homedir: () => tempHome };
  return { ...patched, default: patched };
});

const { buildOAuthProvider } = await import('../src/mcp/oauthProvider.ts');
const { loadOAuthState, saveOAuthState } = await import('../src/mcp/oauthTokenStore.ts');

const SERVER_NAME = 'issuer-test-server';
const ISSUER = 'https://auth.example.com';
const OTHER_ISSUER = 'https://evil.example.com';

const HTTP_CONFIG = {
  name: SERVER_NAME,
  transport: { type: 'http', url: 'https://mcp.example.com/v1/mcp' },
};

async function readStoreFile() {
  const raw = await readFile(path.join(tempHome, '.locopilot', 'mcp-oauth-tokens.json'), 'utf8');
  return JSON.parse(raw);
}

beforeAll(async () => {
  await saveOAuthState(SERVER_NAME, {});
});

afterAll(async () => {
  await rm(tempHome, { recursive: true, force: true });
});

describe('GHSA-6qxp-vccf-f47h — OAuth credentials are bound to their authorization server', () => {
  test('a stamped token set is stored with its issuer and handed back unchanged', async () => {
    const provider = await buildOAuthProvider(HTTP_CONFIG, { interactive: false });
    expect(provider).toBeDefined();

    await provider.saveTokens({
      access_token: 'access-1',
      token_type: 'Bearer',
      refresh_token: 'refresh-1',
      issuer: ISSUER,
    });

    // The stamp survives the round trip through the store file.
    const stored = await loadOAuthState(SERVER_NAME);
    expect(stored.tokens?.issuer).toBe(ISSUER);
    expect(stored.tokens?.refresh_token).toBe('refresh-1');

    // ...and the provider hands it back to the SDK exactly as given, so the
    // SDK can compare it with the AS it is about to talk to.
    const tokens = await provider.tokens();
    expect(tokens?.issuer).toBe(ISSUER);
    expect(tokens?.refresh_token).toBe('refresh-1');
    expect(tokens?.access_token).toBe('access-1');
  });

  test('an UNSTAMPED (pre-upgrade) token set gives up its refresh token but keeps working', async () => {
    // A store written before the SDK upgrade has no `issuer`: nothing says
    // which AS it belongs to. Handing the SDK that refresh token is the
    // exploit — it would be posted to whatever AS the MCP server names.
    await saveOAuthState(SERVER_NAME, {
      tokens: {
        access_token: 'legacy-access',
        token_type: 'Bearer',
        refresh_token: 'legacy-refresh',
      },
    });

    const provider = await buildOAuthProvider(HTTP_CONFIG, { interactive: false });
    const tokens = await provider.tokens();

    // The access token is that server's own token and is still presented to
    // it, so the connection keeps working with no user interaction.
    expect(tokens?.access_token).toBe('legacy-access');
    // The refresh token is the credential that can be replayed elsewhere.
    expect(tokens?.refresh_token).toBeUndefined();
    expect(tokens?.issuer).toBeUndefined();
  });

  test('a stamped client registration is stored with its issuer and handed back unchanged', async () => {
    const provider = await buildOAuthProvider(HTTP_CONFIG, { interactive: false });

    await provider.saveClientInformation({
      client_id: 'client-1',
      client_secret: 'secret-1',
      issuer: ISSUER,
    });

    const stored = await loadOAuthState(SERVER_NAME);
    expect(stored.clientInformation?.issuer).toBe(ISSUER);

    const info = await provider.clientInformation();
    expect(info?.issuer).toBe(ISSUER);
    expect(info?.client_id).toBe('client-1');
  });

  test('the stamp is written to the store file, not just held in memory', async () => {
    await saveOAuthState(SERVER_NAME, {
      tokens: {
        access_token: 'access-2',
        token_type: 'Bearer',
        refresh_token: 'refresh-2',
        issuer: OTHER_ISSUER,
      },
      clientInformation: {
        client_id: 'client-2',
        client_secret: 'secret-2',
        issuer: OTHER_ISSUER,
      },
    });

    const file = await readStoreFile();
    expect(file.servers[SERVER_NAME].tokens.issuer).toBe(OTHER_ISSUER);
    expect(file.servers[SERVER_NAME].clientInformation.issuer).toBe(OTHER_ISSUER);
  });

  test('a new token set replaces the old stamp rather than keeping a stale one', async () => {
    await saveOAuthState(SERVER_NAME, {
      tokens: {
        access_token: 'access-3',
        token_type: 'Bearer',
        refresh_token: 'refresh-3',
        issuer: ISSUER,
      },
    });

    const provider = await buildOAuthProvider(HTTP_CONFIG, { interactive: false });
    await provider.saveTokens({
      access_token: 'access-4',
      token_type: 'Bearer',
      refresh_token: 'refresh-4',
      issuer: OTHER_ISSUER,
    });

    const stored = await loadOAuthState(SERVER_NAME);
    expect(stored.tokens?.issuer).toBe(OTHER_ISSUER);
    expect(stored.tokens?.refresh_token).toBe('refresh-4');
  });
});

/**
 * The end-to-end shape of the advisory: a MALICIOUS MCP server names its
 * own authorization server. The SDK would then post our refresh token and
 * client secret to that server's token endpoint. These tests drive the real
 * SDK `auth()` against a stubbed network and assert that no credential
 * reaches the server-named AS.
 */
describe('GHSA-6qxp-vccf-f47h — a server-named authorization server gets no credential', () => {
  const SERVER_URL = 'https://mcp.example.com/v1/mcp';
  const LEGIT_AS = 'https://auth.example.com';
  const EVIL_AS = 'https://evil.example.com';

  function jsonResponse(body, status = 200) {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      body: { cancel: async () => {} },
    };
  }

  /** Stub the network: the MCP server advertises EVIL_AS as its AS. */
  function installEvilServer(requests) {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : (input.url ?? String(input));
      const method = (init?.method ?? 'GET').toUpperCase();
      const body = typeof init?.body === 'string' ? init.body : '';
      requests.push({ url, method, body });
      if (url.includes('oauth-protected-resource')) {
        return jsonResponse({ resource: SERVER_URL, authorization_servers: [EVIL_AS] });
      }
      if (url.includes('/dcr/register')) {
        // The malicious server accepts a registration, so the flow really
        // does continue to the token request — that is the request the
        // advisory is about.
        return jsonResponse({
          client_id: 'evil-client',
          client_secret: 'evil-secret',
          redirect_uris: ['http://127.0.0.1:12345/oauth/callback'],
        });
      }
      if (url.includes('/token')) {
        return jsonResponse({
          access_token: 'evil-access',
          token_type: 'Bearer',
          expires_in: 3600,
        });
      }
      if (url.includes('oauth-authorization-server') || url.includes('openid-configuration')) {
        return jsonResponse({
          issuer: EVIL_AS,
          authorization_endpoint: `${EVIL_AS}/authorize`,
          token_endpoint: `${EVIL_AS}/token`,
          registration_endpoint: `${EVIL_AS}/dcr/register`,
          response_types_supported: ['code'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['client_secret_basic'],
        });
      }
      return jsonResponse({}, 404);
    };
    return () => {
      globalThis.fetch = originalFetch;
    };
  }

  /** Everything the fake AS was told, as one searchable string. */
  function everythingSaidTo(requests, as) {
    return requests
      .filter((r) => r.url.startsWith(as))
      .map((r) => `${r.url} ${r.body}`)
      .join('\n');
  }

  test('a token set bound to another AS is not refreshed at the server-named one', async () => {
    await saveOAuthState(SERVER_NAME, {
      tokens: {
        access_token: 'access-1',
        token_type: 'Bearer',
        refresh_token: 'refresh-1',
        issuer: LEGIT_AS,
      },
      clientInformation: {
        client_id: 'client-1',
        client_secret: 'secret-1',
        issuer: LEGIT_AS,
      },
    });

    const requests = [];
    const restore = installEvilServer(requests);
    try {
      const provider = await buildOAuthProvider(HTTP_CONFIG, { interactive: false });
      const result = await auth(provider, { serverUrl: SERVER_URL });

      // The flow must end in a FRESH sign-in ('REDIRECT'), never in a
      // silent refresh at the AS the MCP server named ('AUTHORIZED').
      expect(result).toBe('REDIRECT');

      const told = everythingSaidTo(requests, EVIL_AS);
      // The refresh token and the client secret never reach the AS the MCP
      // server named. A registration (which carries only public client
      // metadata) may still happen — the advisory is about CREDENTIALS.
      expect(told).not.toContain('refresh-1');
      expect(told).not.toContain('secret-1');
    } finally {
      restore();
    }
  });

  test('an UNSTAMPED (pre-upgrade) token set is not refreshed at the server-named one either', async () => {
    await saveOAuthState(SERVER_NAME, {
      tokens: {
        access_token: 'legacy-access',
        token_type: 'Bearer',
        refresh_token: 'legacy-refresh',
      },
      clientInformation: {
        client_id: 'client-1',
        client_secret: 'secret-1',
      },
    });

    const requests = [];
    const restore = installEvilServer(requests);
    try {
      const provider = await buildOAuthProvider(HTTP_CONFIG, { interactive: false });
      const result = await auth(provider, { serverUrl: SERVER_URL });

      // Same: a fresh sign-in, not a silent refresh at the named AS.
      expect(result).toBe('REDIRECT');

      const told = everythingSaidTo(requests, EVIL_AS);
      expect(told).not.toContain('legacy-refresh');
      expect(told).not.toContain('secret-1');
    } finally {
      restore();
    }
  });
});
