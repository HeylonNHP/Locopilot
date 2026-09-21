#!/usr/bin/env node
/**
 * Regression tests for the MCP OAuth client-registration fixes (D1).
 *
 * Run with: npx tsx scripts/test-mcp-oauth.mjs
 *
 * These checks are intentionally network-free and follow the repository's
 * lightweight PASS/FAIL harness convention (`scripts/test-mcp-config.mjs`).
 * The user's real `~/.locopilot/mcp.json` and `mcp-oauth-tokens.json` are
 * never read or written: the SDK integration test stubs `globalThis.fetch`
 * entirely in memory.
 *
 * Imports are deliberately limited to pure modules (`oauthDiagnostics`,
 * `configLoader`) plus the SDK's `auth` entry point. Importing
 * `clientManager` / `oauthProvider` would drag in pino and the token store
 * and make this script side-effecting. The D3/D4 wiring is therefore
 * asserted against the source text (no import) — the same technique
 * `scripts/test-provider-persistence.mjs` uses.
 */

import { auth } from '@modelcontextprotocol/sdk/client/auth.js';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const { classifyMCPOAuthFailure, providerClientMetadataUrl, resolveClientRegistrationStrategy } =
  await import('../src/mcp/oauthDiagnostics.ts');
const { parseMCPConfig } = await import('../src/mcp/configLoader.ts');

let pass = 0;
let fail = 0;

function check(label, fn) {
  try {
    fn();
    console.log(`  PASS  ${label}`);
    pass += 1;
  } catch (err) {
    console.error(`  FAIL  ${label}\n        ${err instanceof Error ? err.message : String(err)}`);
    fail += 1;
  }
}

async function checkAsync(label, fn) {
  try {
    await fn();
    console.log(`  PASS  ${label}`);
    pass += 1;
  } catch (err) {
    console.error(`  FAIL  ${label}\n        ${err instanceof Error ? err.message : String(err)}`);
    fail += 1;
  }
}

// ── Section 1 — D2: classifyMCPOAuthFailure regression ────────────────
console.log('D2 — classifyMCPOAuthFailure regression');

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

check(
  'interactive DCR rejection with CIMD advertised -> registration_rejected (auth problem, transport reaped)',
  () => {
    const c = classifyMCPOAuthFailure(failureInput({ discovery: ATLASSIAN_DISCOVERY }));
    assert.equal(c.isAuthProblem, true);
    assert.equal(c.kind, 'registration_rejected');
    assert.equal(c.keepTransport, false);
  }
);
check('401 / UnauthorizedError -> authorization_required and transport kept', () => {
  const c = classifyMCPOAuthFailure(failureInput({ isUnauthorized: true }));
  assert.equal(c.isAuthProblem, true);
  assert.equal(c.keepTransport, true);
  assert.equal(c.kind, 'authorization_required');
});
check('the same registration failure on a non-interactive connect is NOT an auth problem', () => {
  const c = classifyMCPOAuthFailure(
    failureInput({ interactive: false, discovery: ATLASSIAN_DISCOVERY })
  );
  assert.equal(c.isAuthProblem, false);
});
check('a plain transport failure with no discovery facts is NOT an auth problem', () => {
  const c = classifyMCPOAuthFailure(failureInput({ errorMessage: 'fetch failed' }));
  assert.equal(c.isAuthProblem, false);
});
check('AS offers neither CIMD nor DCR -> registration_unavailable', () => {
  const c = classifyMCPOAuthFailure(
    failureInput({
      discovery: { clientIdMetadataDocumentSupported: false, registrationEndpointPresent: false },
    })
  );
  assert.equal(c.kind, 'registration_unavailable');
  assert.equal(c.isAuthProblem, true);
  assert.equal(c.keepTransport, false);
});
check('clientMetadataUrl configured but rejected -> cimd_unusable', () => {
  const c = classifyMCPOAuthFailure(
    failureInput({ cimdConfigured: true, discovery: ATLASSIAN_DISCOVERY })
  );
  assert.equal(c.kind, 'cimd_unusable');
  assert.equal(c.isAuthProblem, true);
  assert.equal(c.keepTransport, false);
});
check('a failure AFTER the auth URL was stashed is NOT blamed on registration', () => {
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
  assert.equal(c.isAuthProblem, false);
  assert.equal(c.kind, 'other');
  assert.equal(c.userMessage, 'boom');
});

// ── Section 2 — D1: client-registration strategy + SEP-991 ────────────
console.log('D1 — client-registration strategy helpers');

check('providerClientMetadataUrl returns the URL when no clientId is set', () => {
  assert.equal(
    providerClientMetadataUrl({ clientMetadataUrl: 'https://client.example.com/meta.json' }),
    'https://client.example.com/meta.json'
  );
});
check('providerClientMetadataUrl returns undefined when clientId is set', () => {
  assert.equal(
    providerClientMetadataUrl({
      clientId: 'abc',
      clientMetadataUrl: 'https://client.example.com/meta.json',
    }),
    undefined
  );
});
check('providerClientMetadataUrl returns undefined when neither is set', () => {
  assert.equal(providerClientMetadataUrl({}), undefined);
});
check("resolveClientRegistrationStrategy -> 'configured' wins over everything", () => {
  assert.equal(
    resolveClientRegistrationStrategy({
      clientConfigured: true,
      cimdConfigured: true,
      asSupportsCimd: true,
      asHasDcrEndpoint: true,
    }),
    'configured'
  );
});
check("resolveClientRegistrationStrategy -> 'cimd' when AS advertises CIMD", () => {
  assert.equal(
    resolveClientRegistrationStrategy({
      clientConfigured: false,
      cimdConfigured: true,
      asSupportsCimd: true,
      asHasDcrEndpoint: true,
    }),
    'cimd'
  );
});
check("resolveClientRegistrationStrategy -> 'dcr' when CIMD unsupported but DCR offered", () => {
  assert.equal(
    resolveClientRegistrationStrategy({
      clientConfigured: false,
      cimdConfigured: true,
      asSupportsCimd: false,
      asHasDcrEndpoint: true,
    }),
    'dcr'
  );
});
check("resolveClientRegistrationStrategy -> 'unavailable' when neither is available", () => {
  assert.equal(
    resolveClientRegistrationStrategy({
      clientConfigured: false,
      cimdConfigured: true,
      asSupportsCimd: false,
      asHasDcrEndpoint: false,
    }),
    'unavailable'
  );
});

console.log('D1 — SEP-991 URL-based client_id through the SDK (offline fetch stub)');

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

await checkAsync(
  'auth() returns REDIRECT with a URL-based client_id and never POSTs to /dcr/register',
  async () => {
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
      assert.equal(result, 'REDIRECT', 'auth() should enter the redirect flow');
      assert.ok(recordedAuthUrl instanceof URL, 'redirectToAuthorization should receive a URL');
      assert.equal(
        recordedAuthUrl.searchParams.get('client_id'),
        CLIENT_METADATA_URL,
        'the authorization URL must carry the client-metadata URL as client_id'
      );
      assert.ok(
        savedClientInfo.length > 0,
        'saveClientInformation should be called for the URL-based client id'
      );
      assert.equal(savedClientInfo[0].client_id, CLIENT_METADATA_URL);
      const registrationPosts = requests.filter(
        (request) => request.method === 'POST' && request.url.includes('/dcr/register')
      );
      assert.equal(
        registrationPosts.length,
        0,
        'no POST should hit the Dynamic Client Registration endpoint'
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  }
);

// ── Section 3 — D1: config validation ─────────────────────────────────
console.log('D1 — parseMCPConfig validates oauth.clientMetadataUrl');

function cfg(oauth) {
  return {
    mcpServers: {
      srv: { name: 'srv', transport: { type: 'http', url: 'https://example.com/mcp' }, oauth },
    },
  };
}

const VALID_CIMD = 'https://client.example.com/.well-known/oauth-client-metadata.json';

check('accepts a valid https non-root clientMetadataUrl', () => {
  const out = parseMCPConfig(cfg({ clientMetadataUrl: VALID_CIMD }));
  assert.equal(out.mcpServers.srv.oauth.clientMetadataUrl, VALID_CIMD);
});
check('expands ${env.X} in clientMetadataUrl (sibling-field parity)', () => {
  process.env.LOCOPILOT_TEST_CIMD = VALID_CIMD;
  try {
    const out = parseMCPConfig(cfg({ clientMetadataUrl: '${env.LOCOPILOT_TEST_CIMD}' }));
    assert.equal(out.mcpServers.srv.oauth.clientMetadataUrl, VALID_CIMD);
  } finally {
    delete process.env.LOCOPILOT_TEST_CIMD;
  }
});
check('rejects an http:// clientMetadataUrl', () => {
  assert.throws(
    () => parseMCPConfig(cfg({ clientMetadataUrl: 'http://client.example.com/meta.json' })),
    /clientMetadataUrl/
  );
});
check('rejects an https clientMetadataUrl with a root pathname', () => {
  assert.throws(
    () => parseMCPConfig(cfg({ clientMetadataUrl: 'https://example.com' })),
    /clientMetadataUrl/
  );
});
check('rejects a non-URL clientMetadataUrl', () => {
  assert.throws(() => parseMCPConfig(cfg({ clientMetadataUrl: 'not-a-url' })), /clientMetadataUrl/);
});

// ── Section 4 — D3: source-wiring assertions ──────────────────────────
console.log('D3 — auth-URL wiring (source assertions)');

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

check('src/mcp/index.ts no longer fabricates a 127.0.0.1:0 auth URL', () => {
  assert.equal(mcpIndexSource.includes('http://127.0.0.1:0/oauth/callback'), false);
});
check('src/mcp/index.ts reads the real stashed authorization URL', () => {
  assert.equal(mcpIndexSource.includes('peekAuthorizationUrl(server.name)'), true);
});
check('src/mcp/clientManager.ts no longer tells the user to hunt the dev-server log', () => {
  assert.equal(clientManagerSource.includes('Check the dev-server log for the auth URL'), false);
});
check('src/mcp/clientManager.ts uses classifyMCPOAuthFailure', () => {
  assert.equal(clientManagerSource.includes('classifyMCPOAuthFailure'), true);
});
check('MCPTab.tsx renders the authorization link', () => {
  assert.equal(mcpTabSource.includes('Open authorization page'), true);
});
check('MCPTab.tsx reads authUrl from the POST response', () => {
  assert.equal(mcpTabSource.includes('data.authUrl'), true);
});
check('oauthProvider.ts exposes clearAuthorizationUrl', () => {
  assert.equal(oauthProviderSource.includes('clearAuthorizationUrl'), true);
});

// ── Section 5 — D4: diagnostics source assertions ─────────────────────
console.log('D4 — MCP OAuth diagnostics (source assertions)');
check('src/mcp/clientManager.ts logs oauth_error diagnostics', () => {
  assert.equal(clientManagerSource.includes("phase: 'oauth_error'"), true);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
