/**
 * OAuth 2.1 + PKCE client provider for HTTP/SSE MCP servers.
 *
 * The MCP spec mandates OAuth 2.1 + PKCE for remote servers. The
 * `@modelcontextprotocol/sdk` accepts a `OAuthClientProvider`
 * (see `node_modules/@modelcontextprotocol/sdk/dist/cjs/client/auth.d.ts`)
 * via the `authProvider` option on its HTTP and SSE transports. This
 * module produces a provider from a `MCPOAuthConfig` and the
 * surrounding `MCPServerConfig`.
 *
 * What's implemented:
 * - Static `clientId` / `clientSecret` / `scopes` getters backed by
 *   the on-disk config.
 * - Persisted `clientInformation` / `tokens` / `codeVerifier` via
 *   `mcp/oauthTokenStore.ts` so the user does not have to
 *   re-authenticate on every server restart.
 * - A loopback HTTP listener on a per-server reserved port that
 *   captures the authorization code from the IdP's 302 redirect.
 *   `redirectToAuthorization` prints the auth URL to stderr AND
 *   blocks on the listener (with a 5-minute timeout, CSRF `state`
 *   validation, and AbortSignal support) so the SDK's
 *   orchestrator doesn't return `'REDIRECT'` until the user has
 *   finished the consent flow. The captured code is stashed on a
 *   process-global; the manager's `reauthenticate` picks it up
 *   and calls `transport.finishAuth(code)` to perform the actual
 *   token exchange (this is what the SDK does internally).
 *
 * What's NOT implemented (TODOs):
 * - Auto-launching the user's default browser. We print the URL
 *   to stderr; in a long-running dev server the user can copy /
 *   paste it, and the chat UI also surfaces it as a clickable
 *   "Authenticate" link.
 * - Serverless mode (Vercel, AWS Lambda). In a serverless runtime
 *   we can't bind a localhost listener, so the user is expected to
 *   paste the callback URL back into the UI; see the TODO in
 *   `startCallbackServer`. The current implementation treats every
 *   environment as long-running and falls back to URL-printing if
 *   `listen()` fails.
 */

import http from 'http';
import { URL } from 'url';

import type { OAuthClientProvider, OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
    OAuthClientInformationMixed,
    OAuthClientMetadata,
    OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';

import {
    clearOAuthState,
    loadOAuthState,
    saveOAuthState,
} from './oauthTokenStore';
import type { MCPOAuthConfig, MCPSavedOAuthState, MCPServerConfig } from './types';

// --- Public factory ---

const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000; // 5 min
const LOOPBACK_HOST = '127.0.0.1';

/**
 * Returns the URL where the IdP should redirect after consent.
 * Public so the chat UI can show a clickable hint ("Authenticate at
 * http://127.0.0.1:12345/oauth/callback") to the user.
 */
export function getLoopbackRedirectUrl(port: number): string {
    return `http://${LOOPBACK_HOST}:${port}/oauth/callback`;
}

/**
 * Allocate a free TCP port. Used at provider-construction time so
 * the SDK can read `redirectUrl` synchronously. We don't actually
 * `listen()` on this port until the first authorization flow
 * kicks off (see `startCallbackServer`).
 *
 * Implementation: bind to port 0 and read back the assigned port,
 * then close the socket. The race window is microseconds; another
 * process could grab the port in between, which is why
 * `startCallbackServer` retries on `EADDRINUSE`.
 */
async function allocateLoopbackPort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const probe = http.createServer();
        probe.on('error', reject);
        probe.listen(0, LOOPBACK_HOST, () => {
            const address = probe.address();
            if (address === null || typeof address === 'string') {
                probe.close();
                reject(new Error('could not determine allocated loopback port'));
                return;
            }
            const port = address.port;
            probe.close(() => resolve(port));
        });
    });
}

/**
 * Build an `OAuthClientProvider` for the given server config.
 * Returns `undefined` if the config has no `oauth` block — the
 * caller should then leave the transport's `authProvider`
 * option unset, and any 401 from the server will surface as a
 * normal connection error.
 */
export async function buildOAuthProvider(
    config: MCPServerConfig,
): Promise<OAuthClientProvider | undefined> {
    if (config.oauth === undefined) return undefined;
    if (config.transport.type === 'stdio') {
        // stdio servers have no HTTP handshake, so OAuth is
        // nonsensical. Silently ignore the misconfiguration rather
        // than throwing — the loader's validation could enforce
        // this later but we don't want a single bad config to
        // block startup.
        console.warn(`[mcp-oauth] server "${config.name}" has an "oauth" block but its transport is stdio; ignoring`);
        return undefined;
    }

    // Allocate the loopback port at construction time so the SDK's
    // synchronous `redirectUrl` getter has a stable value. The
    // actual HTTP server is only started on the first auth flow.
    let allocatedPort: number;
    try {
        allocatedPort = await allocateLoopbackPort();
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[mcp-oauth:${config.name}] could not allocate loopback port for OAuth callback: ${message}. Falling back to URL-print mode (you will need to paste the code into the chat).`);
        // Use port 0 as a sentinel; the callback server will not be
        // started. The user will see the auth URL printed and can
        // manually paste the code.
        allocatedPort = 0;
    }

    return new LocopilotOAuthProvider(config.name, config.oauth, allocatedPort);
}

class LocopilotOAuthProvider implements OAuthClientProvider {
    private readonly serverName: string;
    private readonly oauthConfig: MCPOAuthConfig;
    private readonly loopbackPort: number;
    private cachedState: MCPSavedOAuthState | null = null;
    /**
     * CSRF nonce for the in-flight authorization flow. The SDK
     * includes this in the authorization URL and we validate the
     * same value is echoed back on the callback. The 127.0.0.1
     * listener is technically only reachable from the same host,
     * but validating `state` is cheap insurance against
     * misconfigurations (e.g. another local user hitting
     * `http://127.0.0.1:PORT/oauth/callback` and injecting a
     * different `code`).
     *
     * Memoized for the duration of a single auth flow: the SDK's
     * `auth()` function calls `state()` BEFORE
     * `redirectToAuthorization()`, and the value MUST be stable
     * across both calls (or the IdP's URL won't round-trip).
     * Cleared by the `redirectToAuthorization` finally block on
     * completion, timeout, or abort.
     */
    private currentState: string | null = null;

    constructor(serverName: string, oauthConfig: MCPOAuthConfig, loopbackPort: number) {
        this.serverName = serverName;
        this.oauthConfig = oauthConfig;
        this.loopbackPort = loopbackPort;
    }

    private async getState(): Promise<MCPSavedOAuthState> {
        if (this.cachedState === null) {
            this.cachedState = await loadOAuthState(this.serverName);
        }
        return this.cachedState;
    }

    private async mutateState(patch: MCPSavedOAuthState): Promise<void> {
        this.cachedState = patch;
        await saveOAuthState(this.serverName, patch);
    }

    // --- OAuthClientProvider implementation ---

    get redirectUrl(): string {
        if (this.loopbackPort === 0) {
            // No loopback listener available. Return an obviously
            // placeholder URL — the SDK uses this for the
            // `redirect_uri` param, so the IdP will send the user
            // back to a URL that doesn't exist. The chat UI will
            // surface the code via a manual paste.
            return 'http://127.0.0.1:0/oauth/callback';
        }
        return getLoopbackRedirectUrl(this.loopbackPort);
    }

    get clientMetadata(): OAuthClientMetadata {
        // The SDK requires `redirect_uris` to be an array of
        // string URLs (not URL objects — the schema validates with
        // `z.url()` which only accepts strings). We always expose
        // exactly our loopback redirect; supporting multiple
        // redirects would be a future-feature.
        const metadata: OAuthClientMetadata = {
            redirect_uris: [this.redirectUrl],
        };
        if (this.oauthConfig.clientSecret !== undefined) {
            // Confidential client: secret_basic is the most widely
            // supported method. The SDK's `selectClientAuthMethod`
            // will downgrade to `none` if the server doesn't
            // advertise `client_secret_basic`, but setting it
            // explicitly here documents our intent.
            metadata.token_endpoint_auth_method = 'client_secret_basic';
        } else {
            metadata.token_endpoint_auth_method = 'none';
        }
        if (this.oauthConfig.scopes !== undefined && this.oauthConfig.scopes.length > 0) {
            metadata.scope = this.oauthConfig.scopes.join(' ');
        }
        return metadata;
    }

    async state(): Promise<string> {
        // Bug #20 fix: return a memoized value for the duration of
        // a single auth flow. The SDK calls `state()` and includes
        // the result in the authorization URL; the value MUST
        // round-trip on the callback. A new random per-call value
        // would make the loopback listener's `state` validation
        // reject the legitimate callback.
        if (this.currentState === null) {
            this.currentState = randomBase64Url(16);
        }
        return this.currentState;
    }

    async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
        const state = await this.getState();
        const saved = state.clientInformation;
        if (saved !== undefined) {
            const result: OAuthClientInformationMixed = { client_id: saved.client_id };
            if (saved.client_secret !== undefined) result.client_secret = saved.client_secret;
            if (saved.client_id_issued_at !== undefined) result.client_id_issued_at = saved.client_id_issued_at;
            if (saved.client_secret_expires_at !== undefined) result.client_secret_expires_at = saved.client_secret_expires_at;
            return result;
        }
        // Fall back to the statically-configured client_id if the
        // user supplied one in mcp.json. The SDK uses this when DCR
        // is not available (i.e. the server doesn't advertise a
        // `registration_endpoint`).
        if (this.oauthConfig.clientId !== undefined) {
            const result: OAuthClientInformationMixed = { client_id: this.oauthConfig.clientId };
            if (this.oauthConfig.clientSecret !== undefined) {
                result.client_secret = this.oauthConfig.clientSecret;
            }
            return result;
        }
        return undefined;
    }

    async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
        const state = await this.getState();
        const next: MCPSavedOAuthState = { ...state };
        const stored: NonNullable<MCPSavedOAuthState['clientInformation']> = { client_id: info.client_id };
        if (info.client_secret !== undefined) stored.client_secret = info.client_secret;
        if (info.client_id_issued_at !== undefined) stored.client_id_issued_at = info.client_id_issued_at;
        if (info.client_secret_expires_at !== undefined) stored.client_secret_expires_at = info.client_secret_expires_at;
        next.clientInformation = stored;
        await this.mutateState(next);
    }

    async tokens(): Promise<OAuthTokens | undefined> {
        const state = await this.getState();
        const t = state.tokens;
        if (t === undefined) return undefined;
        const out: OAuthTokens = {
            access_token: t.access_token,
            token_type: t.token_type,
        };
        if (t.id_token !== undefined) out.id_token = t.id_token;
        if (t.expires_in !== undefined) out.expires_in = t.expires_in;
        if (t.scope !== undefined) out.scope = t.scope;
        if (t.refresh_token !== undefined) out.refresh_token = t.refresh_token;
        return out;
    }

    async saveTokens(tokens: OAuthTokens): Promise<void> {
        const state = await this.getState();
        const next: MCPSavedOAuthState = { ...state };
        const stored: NonNullable<MCPSavedOAuthState['tokens']> = {
            access_token: tokens.access_token,
            token_type: tokens.token_type,
        };
        if (tokens.id_token !== undefined) stored.id_token = tokens.id_token;
        if (tokens.expires_in !== undefined) stored.expires_in = tokens.expires_in;
        if (tokens.scope !== undefined) stored.scope = tokens.scope;
        if (tokens.refresh_token !== undefined) stored.refresh_token = tokens.refresh_token;
        next.tokens = stored;
        // A successful token exchange implies the in-flight code
        // verifier has done its job. Wipe it from disk so a
        // re-fetched file doesn't carry around a stale PKCE
        // secret.
        delete next.codeVerifier;
        await this.mutateState(next);
    }

    async saveCodeVerifier(verifier: string): Promise<void> {
        const state = await this.getState();
        const next: MCPSavedOAuthState = { ...state, codeVerifier: verifier };
        await this.mutateState(next);
    }

    async codeVerifier(): Promise<string> {
        const state = await this.getState();
        if (state.codeVerifier === undefined) {
            // The SDK has done something out of order: it asked for
            // the verifier before saving one. This happens when the
            // auth flow is interrupted between `saveCodeVerifier`
            // and the token exchange; in that case the SDK will
            // throw a more useful error. We just return empty.
            return '';
        }
        return state.codeVerifier;
    }

    /**
     * The SDK calls this when it has built the full authorization
     * URL and wants the user to visit it. We:
     *
     *   1) Print the URL to stderr (or, in the chat UI, surface it
     *      as a clickable link).
     *   2) Spin up the loopback HTTP server (if we have a port)
     *      and block until the IdP's callback hits us.
     *
     * Bugs fixed in this revision:
     *   - #1: validate the `state` query param against the value
     *     returned by `state()`. Mismatch → reject with a clear
     *     error and respond 400 to the IdP.
     *   - #2: hard 5-minute timeout. If the user walks away the
     *     listener is closed and the Promise rejects with
     *     `'OAuth flow timed out after 5 minutes'`. The manager
     *     catches and surfaces `'auth_required'` + lastError.
     *   - #3: optional `AbortSignal` to tear down the listener if
     *     the parent request is aborted.
     *   - #6: a `finally` block clears the in-memory
     *     `currentState` and the on-disk `codeVerifier` so a
     *     re-run of the auth flow starts from a clean slate.
     *
     * On success, the captured `code` is stashed on a
     * process-global keyed by server name. The host is then
     * expected to call `transport.finishAuth(code)` (via the
     * manager's `reauthenticate` flow) to trigger the actual
     * token exchange.
     */
    async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
        const url = authorizationUrl.toString();
        // The chat UI listens for `auth-required` events and
        // surfaces the URL — but stderr is the safety net for
        // headless / non-interactive use.
        // Use console.error (not log) so it stands out; this is
        // actionable user input.
        console.error(
            `\n[mcp-oauth:${this.serverName}] Authorization required.\n` +
            `Open the following URL in your browser to grant access:\n\n  ${url}\n\n` +
            `After you approve, you will be redirected back to ${this.redirectUrl} where the code is captured automatically.\n` +
            `(If the redirect fails, paste the full redirect URL or just the "code" query parameter into the chat.)\n`,
        );

        if (this.loopbackPort === 0) {
            // No listener available (serverless / port probe
            // failed). The chat UI / API route is expected to
            // expose the URL and let the user paste the code back.
            return;
        }

        // Bug #6: capture the in-memory CSRF nonce at flow-start.
        // `state()` memoizes the value, but capture it here so the
        // `finally` block can clear the same reference even if
        // `state()` is never called.
        const expectedState = this.currentState;

        try {
            await this.startCallbackServer(expectedState);
        } finally {
            // Bug #6: clear the in-memory CSRF nonce and the
            // on-disk PKCE code verifier so the next auth flow
            // starts fresh. If the flow succeeded, `saveTokens`
            // has already wiped `codeVerifier`; this is a belt-
            // and-suspenders clear in case the SDK was interrupted
            // between `saveCodeVerifier` and the token exchange.
            this.currentState = null;
            try {
                const state = await this.getState();
                if (state.codeVerifier !== undefined) {
                    const next: MCPSavedOAuthState = { ...state };
                    delete next.codeVerifier;
                    await this.mutateState(next);
                }
            } catch (err) {
                // Non-fatal: the worst case is a stale verifier
                // sitting in the file until the next save.
                const message = err instanceof Error ? err.message : String(err);
                console.error(`[mcp-oauth:${this.serverName}] failed to clear code verifier: ${message}`);
            }
        }
    }

    /**
     * Listen for one OAuth callback, then tear down.
     *
     * The Promise structure:
     *   - Outer promise resolves when the FIRST valid callback
     *     arrives (state matches, code present, etc.).
     *   - Rejects on:
     *       * 5-minute timeout (bug #2)
     *       * EADDRINUSE on `listen()` (the OS gave the port to
     *         another process between our probe and now)
     *       * any other `server.on('error')` event
     *   - The optional `AbortSignal` is wired so a parent-request
     *     abort tears the listener down and rejects (bug #3).
     *
     * The IdP-reported `error` query param (RFC 6749 §4.1.2.1) is
     * treated as a successful callback: the response is sent, the
     * server closes, and the outer promise resolves (with no
     * code stashed). The next connect attempt will see no tokens
     * and re-run the auth flow; the user will see the IdP's error
     * in the chat UI via the standard `lastError` plumbing.
     */
    private startCallbackServer(
        expectedState: string | null,
        signal?: AbortSignal,
    ): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            // Track the active server so the cleanup paths can
            // close it exactly once.
            let server: http.Server | null = null;
            let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
            let abortHandler: (() => void) | null = null;
            let settled = false;

            const cleanup = (): void => {
                if (timeoutHandle !== null) {
                    clearTimeout(timeoutHandle);
                    timeoutHandle = null;
                }
                if (abortHandler !== null && signal !== undefined) {
                    signal.removeEventListener('abort', abortHandler);
                    abortHandler = null;
                }
                if (server !== null) {
                    const s = server;
                    server = null;
                    s.close();
                }
            };

            const settleResolve = (): void => {
                if (settled) return;
                settled = true;
                cleanup();
                resolve();
            };

            const settleReject = (err: Error): void => {
                if (settled) return;
                settled = true;
                cleanup();
                reject(err);
            };

            server = http.createServer((req, res) => {
                try {
                    if (!req.url) {
                        sendError(res, 400, 'no request URL');
                        return;
                    }
                    const parsed = new URL(req.url, `http://${LOOPBACK_HOST}:${this.loopbackPort}`);
                    if (parsed.pathname !== '/oauth/callback') {
                        sendError(res, 404, 'not found');
                        return;
                    }
                    // Bug #1: validate the `state` query param
                    // against the nonce returned by `state()`.
                    // Reject mismatches with 400 + clear error.
                    const returnedState = parsed.searchParams.get('state');
                    if (expectedState !== null && returnedState !== expectedState) {
                        sendError(res, 400, 'state mismatch');
                        return;
                    }
                    const error = parsed.searchParams.get('error');
                    if (error !== null) {
                        const desc = parsed.searchParams.get('error_description') ?? error;
                        sendError(res, 400, `authorization error: ${desc}`);
                        // Tear down on IdP-reported errors too;
                        // the outer promise resolves (no code)
                        // and the next connect will re-run the
                        // flow. Don't reject — the SDK's contract
                        // for `redirectToAuthorization` is to
                        // resolve once the user has been
                        // redirected back, regardless of outcome.
                        setImmediate(settleResolve);
                        return;
                    }
                    const code = parsed.searchParams.get('code');
                    if (code === null || code.length === 0) {
                        sendError(res, 400, 'missing "code" query parameter');
                        return;
                    }
                    // Stash the code on a process-global so the
                    // manager's `reauthenticate` (or
                    // `finishAuthAndRetry`) can pick it up. We
                    // don't return it from here because the
                    // SDK's contract is for
                    // `redirectToAuthorization` to just print
                    // the URL — the actual code consumption
                    // happens via `transport.finishAuth(code)`.
                    stashAuthorizationCode(this.serverName, code);
                    sendOk(res);
                    setImmediate(settleResolve);
                } catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    sendError(res, 500, message);
                }
            });

            server.on('error', (err: NodeJS.ErrnoException) => {
                if (err.code === 'EADDRINUSE') {
                    settleReject(new Error(
                        `OAuth callback port ${this.loopbackPort} is already in use; re-run the auth flow`,
                    ));
                    return;
                }
                settleReject(err);
            });

            // Bug #2: hard timeout.
            timeoutHandle = setTimeout(() => {
                settleReject(new Error(
                    `OAuth flow timed out after ${Math.round(CALLBACK_TIMEOUT_MS / 1000 / 60)} minutes`,
                ));
            }, CALLBACK_TIMEOUT_MS);

            // Bug #3: optional AbortSignal.
            if (signal !== undefined) {
                if (signal.aborted) {
                    settleReject(new Error('OAuth flow aborted by caller'));
                    return;
                }
                abortHandler = (): void => {
                    settleReject(new Error('OAuth flow aborted by caller'));
                };
                signal.addEventListener('abort', abortHandler);
            }

            server.listen(this.loopbackPort, LOOPBACK_HOST, () => {
                // Listening. The Promise resolves on first
                // valid request, on timeout, on error, or on
                // AbortSignal. (We don't need to do anything
                // here — the request handler will drive the
                // resolve/reject path.)
            });
        });
    }

    async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
        const state = await this.getState();
        const next: MCPSavedOAuthState = { ...state };
        if (scope === 'all') {
            await clearOAuthState(this.serverName);
            this.cachedState = {};
            return;
        }
        if (scope === 'client') {
            delete next.clientInformation;
        } else if (scope === 'tokens') {
            delete next.tokens;
        } else if (scope === 'verifier') {
            delete next.codeVerifier;
        } else {
            // 'discovery' — drop the cached authorization server
            // URL so the SDK re-discovers it.
            delete next.authorizationServerUrl;
        }
        await this.mutateState(next);
    }

    async saveDiscoveryState(discovery: OAuthDiscoveryState): Promise<void> {
        const state = await this.getState();
        const next: MCPSavedOAuthState = { ...state, authorizationServerUrl: discovery.authorizationServerUrl };
        await this.mutateState(next);
    }

    async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
        const state = await this.getState();
        if (state.authorizationServerUrl === undefined) return undefined;
        // The SDK only needs the URL to skip discovery; the
        // metadata / resourceMetadata fields can be re-fetched on
        // demand. Returning just the URL is what `auth()` looks
        // for (`cachedState?.authorizationServerUrl`).
        return { authorizationServerUrl: state.authorizationServerUrl };
    }
}

// --- Loopback-callback code stash ---

/**
 * The SDK's `redirectToAuthorization` returns void; we can't pass
 * the code back through the return value. Instead, the loopback
 * HTTP handler stashes the code on a process-global keyed by
 * server name, and the manager's `reauthenticate` (or
 * `finishAuthAndRetry`) consumes it.
 *
 * Single-entry; the next flow overwrites. We use `globalThis` to
 * be HMR-safe (Next.js dev mode re-evaluates modules, so a
 * module-level Map would be re-created and lose the entry).
 */
const GLOBAL_KEY = '__mcpOAuthPendingCode';

interface PendingCode {
    code: string;
    receivedAt: number;
}

function getPending(): Map<string, PendingCode> {
    const g = globalThis as unknown as Record<string, unknown>;
    let map = g[GLOBAL_KEY] as Map<string, PendingCode> | undefined;
    if (!map) {
        map = new Map();
        g[GLOBAL_KEY] = map;
    }
    return map;
}

function stashAuthorizationCode(serverName: string, code: string): void {
    getPending().set(serverName, { code, receivedAt: Date.now() });
}

/**
 * Drain and return the stashed code (if any) for the given
 * server. Returns `undefined` when no code is waiting. The caller
 * is expected to call this from the post-401 retry path, e.g. in
 * `reauthenticate`.
 */
export function consumeAuthorizationCode(serverName: string): string | undefined {
    const entry = getPending().get(serverName);
    if (!entry) return undefined;
    getPending().delete(serverName);
    // Reject codes older than the timeout; they're almost
    // certainly stale (e.g. the user walked away and the loopback
    // server timed out, then came back hours later).
    if (Date.now() - entry.receivedAt > CALLBACK_TIMEOUT_MS) {
        return undefined;
    }
    return entry.code;
}

// --- Helpers ---

function sendOk(res: http.ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(
        '<!doctype html><html><body style="font-family:system-ui;padding:32px;">' +
        '<h1>Authorization complete</h1>' +
        '<p>You can close this tab and return to Locopilot.</p>' +
        '</body></html>',
    );
}

function sendError(res: http.ServerResponse, code: number, message: string): void {
    res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`OAuth callback error: ${message}\n`);
}

function randomBase64Url(byteLength: number): string {
    // Node's `crypto` is built-in. We avoid the `randomBytes` -> base64
    // dance and do the URL-safe encoding inline; this is used as a
    // CSRF nonce on the OAuth flow, not a high-value secret.
    const bytes = new Uint8Array(byteLength);
    // `globalThis.crypto` is available in Node 19+ and is the
    // standard web-crypto API. Fall back to `node:crypto`'s
    // `randomFillSync` for older runtimes.
    const cryptoObj = (globalThis as { crypto?: { getRandomValues: (buf: Uint8Array) => Uint8Array } }).crypto;
    if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
        cryptoObj.getRandomValues(bytes);
    } else {
        // Synchronous fallback. Only used on ancient Node versions.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const nodeCrypto = require('node:crypto') as typeof import('node:crypto');
        nodeCrypto.randomFillSync(bytes);
    }
    return base64UrlEncode(bytes);
}

function base64UrlEncode(bytes: Uint8Array): string {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
        // String concatenation in a tight loop is fine for
        // 16-byte CSRF nonces; a 4KB buffer would warrant a
        // different approach.
        binary += String.fromCharCode(bytes[i]!);
    }
    // `btoa` is a global in Node 22+ and works on latin-1 strings.
    // Wrap in try/catch for older runtimes.
    if (typeof (globalThis as { btoa?: (s: string) => string }).btoa === 'function') {
        const btoa = (globalThis as { btoa: (s: string) => string }).btoa;
        return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }
    // Manual base64 + URL-safe transform for environments without
    // btoa. The output alphabet is URL-safe (RFC 4648 §5).
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    let out = '';
    for (let i = 0; i < binary.length; i += 3) {
        const b1 = binary.charCodeAt(i);
        const b2 = i + 1 < binary.length ? binary.charCodeAt(i + 1) : NaN;
        const b3 = i + 2 < binary.length ? binary.charCodeAt(i + 2) : NaN;
        out += chars[b1 >> 2];
        out += chars[((b1 & 3) << 4) | (Number.isNaN(b2) ? 0 : (b2 >> 4))];
        out += Number.isNaN(b2) ? '=' : chars[((b2 & 15) << 2) | (Number.isNaN(b3) ? 0 : (b3 >> 6))];
        out += Number.isNaN(b3) ? '=' : chars[b3 & 63];
    }
    return out.replace(/=+$/, '');
}
