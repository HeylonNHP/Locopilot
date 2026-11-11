/**
 * Regression tests for the MCP OAuth client-registration fixes (D1).
 *
 * These checks are intentionally network-free and follow the repository's
 * lightweight PASS/FAIL harness convention (`tests/mcp-config.test.mjs`).
 * The user's real `~/.locopilot/mcp.json` and `mcp-oauth-tokens.json` are
 * never read or written: the SDK integration test stubs `globalThis.fetch`
 * entirely in memory.
 *
 * Imports are deliberately limited to pure modules (`oauthDiagnostics`,
 * `configLoader`) plus the SDK's `auth` entry point. Importing
 * `clientManager` / `oauthProvider` would drag in pino and the token store
 * and make this script side-effecting. The D3/D4 wiring is therefore
 * asserted against the source text (no import) — the same technique
 * `tests/provider-persistence.test.mjs` uses.
 */

import { describe, expect, test } from '@jest/globals';
import { auth } from '@modelcontextprotocol/sdk/client/auth.js';
import { readFile } from 'node:fs/promises';

const {
  buildOAuthClientName,
  classifyMCPOAuthFailure,
  providerClientMetadataUrl,
  resolveClientRegistrationStrategy,
} = await import('../src/mcp/oauthDiagnostics.ts');
const { parseMCPConfig } = await import('../src/mcp/configLoader.ts');

describe('D2 — classifyMCPOAuthFailure regression', () => {
  /** A complete `MCPOAuthFailureInput` with benign defaults, so each check
   *  only states the field(s) under test. */
  function failureInput(overrides) {
    return {
      interactive: true,
      isUnauthorized: false,
      httpStatus: undefined,
      oauthErrorCode: undefined,
      errorMessage: '',
      authUrlStashed: false,
      clientConfigured: false,
      cimdConfigured: false,
      discovery: undefined,
      ...overrides,
    };
  }

  // The Atlassian shape: the AS advertises CIMD (`client_id_metadata_document_supported`)
  // and a DCR endpoint, no client identity is configured, and the interactive
  // connect fails during registration.
  const ATLASSIAN_DISCOVERY = {
    clientIdMetadataDocumentSupported: true,
    registrationEndpointPresent: true,
  };

  test('interactive DCR rejection with CIMD advertised -> registration_rejected (auth problem, transport reaped)', () => {
    const c = classifyMCPOAuthFailure(failureInput({ discovery: ATLASSIAN_DISCOVERY }));
    expect(c.isAuthProblem).toBe(true);
    expect(c.kind).toBe('registration_rejected');
    expect(c.keepTransport).toBe(false);
  });
  test('401 / UnauthorizedError -> authorization_required and transport kept', () => {
    const c = classifyMCPOAuthFailure(failureInput({ isUnauthorized: true }));
    expect(c.isAuthProblem).toBe(true);
    expect(c.keepTransport).toBe(true);
    expect(c.kind).toBe('authorization_required');
  });
  test('the same registration failure on a non-interactive connect is NOT an auth problem', () => {
    const c = classifyMCPOAuthFailure(
      failureInput({ interactive: false, discovery: ATLASSIAN_DISCOVERY })
    );
    expect(c.isAuthProblem).toBe(false);
  });
  test('a plain transport failure with no discovery facts is NOT an auth problem', () => {
    const c = classifyMCPOAuthFailure(failureInput({ errorMessage: 'fetch failed' }));
    expect(c.isAuthProblem).toBe(false);
  });
  test('AS offers neither CIMD nor DCR -> registration_unavailable', () => {
    const c = classifyMCPOAuthFailure(
      failureInput({
        discovery: { clientIdMetadataDocumentSupported: false, registrationEndpointPresent: false },
      })
    );
    expect(c.kind).toBe('registration_unavailable');
    expect(c.isAuthProblem).toBe(true);
    expect(c.keepTransport).toBe(false);
  });
  test('clientMetadataUrl configured but rejected -> cimd_unusable', () => {
    const c = classifyMCPOAuthFailure(
      failureInput({ cimdConfigured: true, discovery: ATLASSIAN_DISCOVERY })
    );
    expect(c.kind).toBe('cimd_unusable');
    expect(c.isAuthProblem).toBe(true);
    expect(c.keepTransport).toBe(false);
  });
  test('a failure AFTER the auth URL was stashed is NOT blamed on registration', () => {
    // `discovery.clientIdMetadataDocumentSupported` describes the SERVER, not
    // the failure, so on its own it would mislabel every post-consent failure
    // against a CIMD-advertising server as a registration problem. A stashed
    // authorization URL proves the SDK already had a client identity (it only
    // stashes once it reaches `redirectToAuthorization`), so the guard must win
    // even when `cimdConfigured` is set.
    const c = classifyMCPOAuthFailure(
      failureInput({
        authUrlStashed: true,
        cimdConfigured: true,
        discovery: ATLASSIAN_DISCOVERY,
        errorMessage: 'boom',
      })
    );
    expect(c.isAuthProblem).toBe(false);
    expect(c.kind).toBe('other');
    expect(c.userMessage).toBe('boom');
  });
});

describe('D1 — client-registration strategy helpers', () => {
  test('providerClientMetadataUrl returns the URL when no clientId is set', () => {
    expect(
      providerClientMetadataUrl({ clientMetadataUrl: 'https://client.example.com/meta.json' })
    ).toBe('https://client.example.com/meta.json');
  });
  test('providerClientMetadataUrl returns undefined when clientId is set', () => {
    expect(
      providerClientMetadataUrl({
        clientId: 'abc',
        clientMetadataUrl: 'https://client.example.com/meta.json',
      })
    ).toBeUndefined();
  });
  test('providerClientMetadataUrl returns undefined when neither is set', () => {
    expect(providerClientMetadataUrl({})).toBeUndefined();
  });
  test("resolveClientRegistrationStrategy -> 'configured' wins over everything", () => {
    expect(
      resolveClientRegistrationStrategy({
        clientConfigured: true,
        cimdConfigured: true,
        asSupportsCimd: true,
        asHasDcrEndpoint: true,
      })
    ).toBe('configured');
  });
  test("resolveClientRegistrationStrategy -> 'cimd' when AS advertises CIMD", () => {
    expect(
      resolveClientRegistrationStrategy({
        clientConfigured: false,
        cimdConfigured: true,
        asSupportsCimd: true,
        asHasDcrEndpoint: true,
      })
    ).toBe('cimd');
  });
  test("resolveClientRegistrationStrategy -> 'dcr' when CIMD unsupported but DCR offered", () => {
    expect(
      resolveClientRegistrationStrategy({
        clientConfigured: false,
        cimdConfigured: true,
        asSupportsCimd: false,
        asHasDcrEndpoint: true,
      })
    ).toBe('dcr');
  });
  test("resolveClientRegistrationStrategy -> 'unavailable' when neither is available", () => {
    expect(
      resolveClientRegistrationStrategy({
        clientConfigured: false,
        cimdConfigured: true,
        asSupportsCimd: false,
        asHasDcrEndpoint: false,
      })
    ).toBe('unavailable');
  });
});

describe('D1 - buildOAuthClientName (DCR client identity)', () => {
  test("buildOAuthClientName('atlassian') -> 'Locopilot (atlassian)'", () => {
    expect(buildOAuthClientName('atlassian')).toBe('Locopilot (atlassian)');
  });
  test("buildOAuthClientName('  atlassian  ') trims -> 'Locopilot (atlassian)'", () => {
    expect(buildOAuthClientName('  atlassian  ')).toBe('Locopilot (atlassian)');
  });
  test("buildOAuthClientName('') falls back to 'Locopilot'", () => {
    expect(buildOAuthClientName('')).toBe('Locopilot');
  });
  test("buildOAuthClientName('   ') (whitespace only) falls back to 'Locopilot'", () => {
    expect(buildOAuthClientName('   ')).toBe('Locopilot');
  });
});

describe('D1 — SEP-991 URL-based client_id through the SDK (offline fetch stub)', () => {
  const AUTH_SERVER = 'https://auth.example.com/VCeDk8ZHncY';
  const SERVER_URL = 'https://mcp.example.com/v1/mcp/authv2';
  const CLIENT_METADATA_URL = 'https://client.example.com/.well-known/oauth-client-metadata.json';
  const REGISTRATION_ENDPOINT = `${AUTH_SERVER}/dcr/register`;

  function jsonResponse(body) {
    return {
      ok: true,
      status: 200,
      json: async () => body,
      body: { cancel: async () => {} },
    };
  }

  test('auth() returns REDIRECT with a URL-based client_id and never POSTs to /dcr/register', async () => {
    const requests = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : (input.url ?? String(input));
      const method = (init?.method ?? 'GET').toUpperCase();
      requests.push({ url, method });
      if (url.includes('oauth-protected-resource')) {
        return jsonResponse({ resource: SERVER_URL, authorization_servers: [AUTH_SERVER] });
      }
      if (url.includes('oauth-authorization-server') || url.includes('openid-configuration')) {
        return jsonResponse({
          issuer: AUTH_SERVER,
          authorization_endpoint: `${AUTH_SERVER}/authorize`,
          token_endpoint: `${AUTH_SERVER}/token`,
          registration_endpoint: REGISTRATION_ENDPOINT,
          response_types_supported: ['code'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
          client_id_metadata_document_supported: true,
        });
      }
      return { ok: false, status: 404, json: async () => ({}), body: { cancel: async () => {} } };
    };

    try {
      const savedClientInfo = [];
      let codeVerifier = null;
      let recordedAuthUrl = null;
      const provider = {
        redirectUrl: 'http://127.0.0.1:12345/oauth/callback',
        // Exercise the real mapping helper rather than hard-coding the URL.
        clientMetadataUrl: providerClientMetadataUrl({ clientMetadataUrl: CLIENT_METADATA_URL }),
        clientMetadata: {
          redirect_uris: ['http://127.0.0.1:12345/oauth/callback'],
          token_endpoint_auth_method: 'none',
        },
        state: () => 'test-flow-state',
        clientInformation: () => {},
        saveClientInformation: (info) => {
          savedClientInfo.push(info);
        },
        saveCodeVerifier: (verifier) => {
          codeVerifier = verifier;
        },
        codeVerifier: () => codeVerifier,
        redirectToAuthorization: (url) => {
          recordedAuthUrl = url;
        },
        tokens: () => {},
        saveTokens: () => {},
      };

      const result = await auth(provider, { serverUrl: SERVER_URL });
      expect(result).toBe('REDIRECT');
      expect(recordedAuthUrl).toBeInstanceOf(URL);
      expect(recordedAuthUrl.searchParams.get('client_id')).toBe(CLIENT_METADATA_URL);
      expect(savedClientInfo.length).toBeGreaterThan(0);
      expect(savedClientInfo[0].client_id).toBe(CLIENT_METADATA_URL);
      const registrationPosts = requests.filter(
        (request) => request.method === 'POST' && request.url.includes('/dcr/register')
      );
      expect(registrationPosts).toHaveLength(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('D1 — parseMCPConfig validates oauth.clientMetadataUrl', () => {
  function cfg(oauth) {
    return {
      mcpServers: {
        srv: { name: 'srv', transport: { type: 'http', url: 'https://example.com/mcp' }, oauth },
      },
    };
  }

  const VALID_CIMD = 'https://client.example.com/.well-known/oauth-client-metadata.json';

  test('accepts a valid https non-root clientMetadataUrl', () => {
    const out = parseMCPConfig(cfg({ clientMetadataUrl: VALID_CIMD }));
    expect(out.mcpServers.srv.oauth.clientMetadataUrl).toBe(VALID_CIMD);
  });
  test('expands ${env.X} in clientMetadataUrl (sibling-field parity)', () => {
    process.env.LOCOPILOT_TEST_CIMD = VALID_CIMD;
    try {
      const out = parseMCPConfig(cfg({ clientMetadataUrl: '${env.LOCOPILOT_TEST_CIMD}' }));
      expect(out.mcpServers.srv.oauth.clientMetadataUrl).toBe(VALID_CIMD);
    } finally {
      delete process.env.LOCOPILOT_TEST_CIMD;
    }
  });
  test('rejects an http:// clientMetadataUrl', () => {
    expect(() =>
      parseMCPConfig(cfg({ clientMetadataUrl: 'http://client.example.com/meta.json' }))
    ).toThrow(/clientMetadataUrl/);
  });
  test('rejects an https clientMetadataUrl with a root pathname', () => {
    expect(() => parseMCPConfig(cfg({ clientMetadataUrl: 'https://example.com' }))).toThrow(
      /clientMetadataUrl/
    );
  });
  test('rejects a non-URL clientMetadataUrl', () => {
    expect(() => parseMCPConfig(cfg({ clientMetadataUrl: 'not-a-url' }))).toThrow(
      /clientMetadataUrl/
    );
  });
});

// ── Section 4 — D3: source-wiring assertions ──────────────────────────
// Read the real sources (never imported — they drag in pino / the token
// store). The wiring is small and string-shaped, so a source assertion is the
// cheapest regression guard that the placeholder URL and the misleading log
// hint never come back.
async function readSource(relativePath) {
  return readFile(new URL(relativePath, import.meta.url), 'utf8');
}

const mcpIndexSource = await readSource('../src/mcp/index.ts');

const clientManagerSource = await readSource('../src/mcp/clientManager.ts');

const mcpTabSource = await readSource('../src/components/sidebar/MCPTab.tsx');

const oauthProviderSource = await readSource('../src/mcp/oauthProvider.ts');

describe('D3 — auth-URL wiring (source assertions)', () => {
  test('src/mcp/index.ts no longer fabricates a 127.0.0.1:0 auth URL', () => {
    expect(mcpIndexSource.includes('http://127.0.0.1:0/oauth/callback')).toBe(false);
  });
  test('src/mcp/index.ts reads the real stashed authorization URL', () => {
    expect(mcpIndexSource.includes('peekAuthorizationUrl(server.name)')).toBe(true);
  });
  test('src/mcp/clientManager.ts no longer tells the user to hunt the dev-server log', () => {
    expect(clientManagerSource.includes('Check the dev-server log for the auth URL')).toBe(false);
  });
  test('src/mcp/clientManager.ts uses classifyMCPOAuthFailure', () => {
    expect(clientManagerSource.includes('classifyMCPOAuthFailure')).toBe(true);
  });
  test('MCPTab.tsx renders the authorization link', () => {
    expect(mcpTabSource.includes('Open authorization page')).toBe(true);
  });
  test('MCPTab.tsx reads authUrl from the POST response', () => {
    expect(mcpTabSource.includes('data.authUrl')).toBe(true);
  });
  test('oauthProvider.ts exposes clearAuthorizationUrl', () => {
    expect(oauthProviderSource.includes('clearAuthorizationUrl')).toBe(true);
  });
  test('oauthProvider.ts sends client_name in the DCR client metadata', () => {
    expect(oauthProviderSource.includes('client_name: buildOAuthClientName(this.serverName)')).toBe(
      true
    );
  });
});

describe('D4 — MCP OAuth diagnostics (source assertions)', () => {
  test('src/mcp/clientManager.ts logs oauth_error diagnostics', () => {
    expect(clientManagerSource.includes("phase: 'oauth_error'")).toBe(true);
  });
});
