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
 * - Auto-launch the user's default browser after printing the
 *   auth URL to stderr, falling back to stderr-only if the
 *   browser cannot be opened.
 *
 * What's NOT implemented (TODOs):
 * - Serverless mode (Vercel, AWS Lambda). In a serverless runtime
 *   we can't bind a localhost listener, so the user is expected to
 *   paste the callback URL back into the UI; see the TODO in
 *   `startCallbackServer`. The current implementation treats every
 *   environment as long-running and falls back to URL-printing if
 *   `listen()` fails.
 */

/** @format */

import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { spawn } from 'node:child_process';
import * as http from 'node:http';

import type {
  MCPOAuthConfig,
  MCPSavedOAuthState,
  MCPServerConfig,
} from './types';

import { clearOAuthState, loadOAuthState, saveOAuthState } from './oauthTokenStore';

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
 * the SDK's synchronous `redirectUrl` getter has a stable value.
 * The actual HTTP server is only started on the first authorization
 * flow kickoff (see `startCallbackServer`).
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
 * Cross-platform helper: launch the user's default browser to the
 * given URL.
 *   - Windows : uses `cmd /c start "" <url>` (start is a cmd builtin)
 *   - macOS   : uses `open <url>`
 *   - Linux   : uses `xdg-open <url>`
 *
 * The child is spawned detached with stdio ignored and unref'd so
 * opening the browser never blocks Locopilot or keeps a handle on
 * the child. Resolves `true` once the spawn succeeds, `false` if
 * the command itself could not be launched (e.g. xdg-open missing).
 */
function launchBrowser(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const platform = process.platform;
      let child: ReturnType<typeof spawn>;
      if (platform === 'win32') {
        child = spawn('cmd', ['/c', 'start', '', url], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        });
      } else if (platform === 'darwin') {
        child = spawn('open', [url], { detached: true, stdio: 'ignore' });
      } else {
        child = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
      }

      child.on('error', (err) => {
        console.error(
          `[mcp-oauth] could not launch browser: ${err instanceof Error ? err.message : String(err)}`
        );
        resolve(false);
      });
      child.on('spawn', () => {
        // Detach the child so it outlives this process and we don't
        // hold a pipe handle open waiting for the browser to exit.
        child.unref();
        resolve(true);
      });
    } catch (err) {
      console.error(
        `[mcp-oauth] browser launch error: ${err instanceof Error ? err.message : String(err)}`
      );
      resolve(false);
    }
  });
}

/**
 * Build an `OAuthClientProvider` for the given server config.
 * Returns a non-undefined provider even when `config.oauth` is absent,
 * so the SDK can drive Dynamic Client Registration (RFC 7591) and
 * the OAuth 2.1 consent flow. Returns `undefined` if the transport is
 * stdio (OAuth is not meaningful for stdio).
 *
 * `opts.interactive` must be `true` only for a connect attempt the
 * user explicitly triggered (the "Authenticate" button, or the
 * code-paste fallback) — see `redirectToAuthorization` below, which
 * refuses to print the auth URL / launch a browser / start the
 * loopback listener unless this is `true`. The caller (`clientManager.
 * openConnection`) is responsible for only calling this at all when
 * `interactive` is true or a cached token already exists — see the
 * comment there for why that split matters.
 */
export async function buildOAuthProvider(
  config: MCPServerConfig,
  opts: { interactive: boolean }
): Promise<OAuthClientProvider | undefined> {
  if (config.transport.type === 'stdio') {
    // stdio servers have no HTTP handshake, so OAuth is
    // nonsensical. Silently ignore the misconfiguration rather
    // than throwing — the loader's validation could enforce
    // this later but we don't want a single bad config to
    // block startup.
    console.warn(
      `[mcp-oauth] server "${config.name}" has an "oauth" block but its transport is stdio; ignoring`
    );
    return undefined;
  }

  // If the user didn't set an `oauth` block, fall back to an empty
  // one (local only — we don't mutate the shared config object) so
  // DCR + auth still works once the user clicks "Authenticate".
  const oauthConfig = config.oauth ?? {};

  // Allocate the loopback port at construction time so the SDK's
  // synchronous `redirectUrl` getter has a stable value. The
  // actual HTTP server is only started on the first auth flow
  // kickoff (see `startCallbackServer`).
  let allocatedPort: number;
  try {
    allocatedPort = await allocateLoopbackPort();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[mcp-oauth:${config.name}] could not allocate loopback port for OAuth callback: ${message}. Falling back to URL-print mode (you will need to paste the code into the chat).`
    );
    // Use port 0 as a sentinel; the callback server will not be
    // started. The user will see the auth URL printed and can
    // manually paste the code.
    allocatedPort = 0;
  }

  return new LocopilotOAuthProvider(
    config.name,
    oauthConfig,
    allocatedPort,
    opts.interactive
  );
}

class LocopilotOAuthProvider implements OAuthClientProvider {
  private readonly serverName: string;
  private readonly oauthConfig: MCPOAuthConfig;
  private readonly loopbackPort: number;
  /**
   * `true` only when this provider was built for a connect attempt
   * the user explicitly triggered. `redirectToAuthorization` checks
   * this before doing anything user-visible — see that method.
   */
  private readonly interactive: boolean;
  private cachedState: MCPSavedOAuthState | null = null;

  constructor(
    serverName: string,
    oauthConfig: MCPOAuthConfig,
    loopbackPort: number,
    interactive: boolean
  ) {
    this.serverName = serverName;
    this.oauthConfig = oauthConfig;
    this.loopbackPort = loopbackPort;
    this.interactive = interactive;
  }
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
    // Confidential client: secret_basic is the most widely supported
    // method. The SDK's `selectClientAuthMethod` will downgrade to `none`
    // if the server doesn't advertise `client_secret_basic`, but setting
    // it explicitly here documents our intent.
    metadata.token_endpoint_auth_method =
      this.oauthConfig.clientSecret === undefined ? 'none' : 'client_secret_basic';
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
      this.currentState = await randomBase64Url(16);
    }
    return this.currentState;
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    const state = await this.getState();
    const saved = state.clientInformation;
    if (saved !== undefined) {
      const result: OAuthClientInformationMixed = { client_id: saved.client_id };
      if (saved.client_secret !== undefined) result.client_secret = saved.client_secret;
      if (saved.client_id_issued_at !== undefined)
        result.client_id_issued_at = saved.client_id_issued_at;
      if (saved.client_secret_expires_at !== undefined)
        result.client_secret_expires_at = saved.client_secret_expires_at;
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
    const stored: NonNullable<MCPSavedOAuthState['clientInformation']> = {
      client_id: info.client_id,
    };
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
   *   3) Auto-launch the user's default browser.
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
   *     `currentState`. The on-disk `codeVerifier` is only wiped
   *     here when the callback did NOT deliver a code (timeout,
   *     abort, IdP-reported error) — a captured code still needs
   *     that verifier for the token exchange the caller runs
   *     afterwards (see the "IMPORTANT" note below).
   *   - #7: auto-launch the browser after printing the URL.
   *     If the launch fails, fall back to stderr printing.
   *
   * On success, the captured `code` is stashed on a
   * process-global keyed by server name. The host is then
   * expected to call `transport.finishAuth(code)` (via the
   * manager's `reauthenticate` flow) to trigger the actual
   * token exchange.
   *
   * Non-interactive guard: this is also reachable from a
   * background/eager connect (e.g. a cached token that turned out
   * to be expired and failed to refresh). We never want an
   * unattended connect to pop a browser window or start a 5-minute
   * loopback wait — only a connect the user explicitly triggered
   * (the "Authenticate" button, or the code-paste fallback) sets
   * `interactive: true`. When it's not set, we log a hint and
   * return immediately; the SDK treats that the same as "user
   * hasn't completed the flow yet" and surfaces `UnauthorizedError`
   * back to the caller, which `clientManager` maps to the
   * `auth_required` status the UI already renders a button for.
   */
  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    if (!this.interactive) {
      console.error(
        `[mcp-oauth:${this.serverName}] Sign-in required, but this was a background ` +
          `connect attempt, so it was not started automatically. Click "Authenticate" ` +
          `for "${this.serverName}" in the MCP panel to sign in.`
      );
      return;
    }
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
        `(If the redirect fails, paste the full redirect URL or just the "code" query parameter into the chat.)\n`
    );

    // Auto-launch the user's default browser.
    // Cross-platform: use `start` on Windows, `open` on macOS/Linux.
    const browserLaunchSuccess = await launchBrowser(url);
    if (!browserLaunchSuccess) {
      // Fall back to stderr — the user can still copy/paste.
      console.error(
        `[mcp-oauth:${this.serverName}] Note: Could not auto-launch browser. Open the URL above manually in your browser.\n`
      );
    }

    if (this.loopbackPort === 0) {
      // No listener available (serverless / port probe
      // failed). The chat UI / API route is expected to
      // expose the URL and let the user paste the code back.
      return;
    }

    // Bug #1: capture the in-memory CSRF nonce at flow-start.
    // `state()` memoizes the value, but capture it here so the
    // `finally` block can clear the same reference even if
    // `state()` is never called.
    const expectedState = this.currentState;

    let codeCaptured = false;
    try {
      const result = await this.startCallbackServer(expectedState);
      codeCaptured = result.codeCaptured;
    } finally {
      // Bug #6: clear the in-memory CSRF nonce so the next auth
      // flow starts fresh.
      this.currentState = null;
      // IMPORTANT: only wipe the on-disk PKCE code verifier when
      // NO code was captured (timeout, abort, server error, or an
      // IdP-reported `error` param). The token exchange itself
      // (`transport.finishAuth(code)`, driven by `reauthenticate`'s
      // pending-code check or the manual code-paste route) runs
      // AFTER this method has already returned — deleting the
      // verifier here unconditionally, as a prior revision did,
      // wiped it before that exchange ever ran, so every
      // authorization attempt failed PKCE validation on the very
      // next step. `saveTokens` deletes it on a real successful
      // exchange; this is only for the abandoned-flow case.
      if (!codeCaptured) {
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
  }

  /**
   * Listen for one OAuth callback, then tear down.
   *
   * The Promise structure:
   *   - Outer promise resolves with `{ codeCaptured }` when the
   *     FIRST callback settles the flow — `codeCaptured: true` for
   *     a real code, `false` for an IdP-reported error. The caller
   *     uses this to decide whether the on-disk PKCE verifier is
   *     still needed (see `redirectToAuthorization`).
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
   * and re-run the flow; the user will see the IdP's error
   * in the chat UI via the standard `lastError` plumbing.
   */
  private startCallbackServer(
    expectedState: string | null,
    signal?: AbortSignal
  ): Promise<{ codeCaptured: boolean }> {
    return new Promise<{ codeCaptured: boolean }>((resolve, reject) => {
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

      const settleResolve = (codeCaptured: boolean): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ codeCaptured });
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
          // against the value returned by `state()`.
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
            // and the next connect will re-run the flow.
            // Don't reject — the SDK's contract
            // for `redirectToAuthorization` is to
            // resolve once the user has been
            // redirected back, regardless of outcome.
            setImmediate(() => settleResolve(false));
            return;
          }
          const code = parsed.searchParams.get('code');
          if (code === null || code.length === 0) {
            sendError(res, 400, 'missing "code" query parameter');
            return;
          }
          // Stash the code on a process-global so the
          // manager's `reauthenticate` (or
          // `finishAuthAndRetry`) can pick it up.
          stashAuthorizationCode(this.serverName, code);
          sendOk(res);
          setImmediate(() => settleResolve(true));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          sendError(res, 500, message);
        }
      });

      server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          settleReject(
            new Error(
              `OAuth callback port ${this.loopbackPort} is already in use; re-run the auth flow`
            )
          );
          return;
        }
        settleReject(err);
      });

      // Bug #2: hard timeout.
      timeoutHandle = setTimeout(() => {
        settleReject(
          new Error(
            `OAuth flow timed out after ${Math.round(CALLBACK_TIMEOUT_MS / 1000 / 60)} minutes`
          )
        );
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

  async invalidateCredentials(
    scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'
  ): Promise<void> {
    const state = await this.getState();
    const next: MCPSavedOAuthState = { ...state };
    if (scope === 'all') {
      await clearOAuthState(this.serverName);
      this.cachedState = {};
      return;
    }
    switch (scope) {
      case 'client': {
        delete next.clientInformation;
        break;
      }
      case 'tokens': {
        delete next.tokens;
        break;
      }
      case 'verifier': {
        delete next.codeVerifier;
        break;
      }
      default: {
        // 'discovery' — drop the cached authorization server
        // URL so the SDK re-discovers it.
        delete next.authorizationServerUrl;
      }
    }
    await this.mutateState(next);
  }

  async saveDiscoveryState(discovery: OAuthDiscoveryState): Promise<void> {
    const state = await this.getState();
    const next: MCPSavedOAuthState = {
      ...state,
      authorizationServerUrl: discovery.authorizationServerUrl,
    };
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
      '</body></html>'
  );
}

function sendError(res: http.ServerResponse, code: number, message: string): void {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(`OAuth callback error: ${message}\n`);
}

async function randomBase64Url(byteLength: number): Promise<string> {
  // Node's `crypto` is built-in. We avoid the `randomBytes` -> base64
  // dance and do the URL-safe encoding inline; this is used as a
  // CSRF nonce on the OAuth flow, not a high-value secret.
  const bytes = new Uint8Array(byteLength);
  // `globalThis.crypto` is available in Node 19+ and is the
  // standard web-crypto API. Fall back to a dynamic `node:crypto`
  // import for older runtimes (conditional so we don't pull it in
  // when the global API is present).
  const cryptoObj = (
    globalThis as { crypto?: { getRandomValues: (buf: Uint8Array) => Uint8Array } }
  ).crypto;
  if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
    cryptoObj.getRandomValues(bytes);
  } else {
    // Fallback for older Node versions. Dynamically imported so
    // the dependency is only loaded when the global API is absent.
    const nodeCrypto = await import('node:crypto');
    nodeCrypto.randomFillSync(bytes);
  }
  return base64UrlEncode(bytes);
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    // String concatenation in a tight loop is fine for
    // 16-byte CSRF nonces; a 4KB buffer would warrant a
    // different approach.
    binary += String.fromCodePoint(byte);
  }
  // `btoa` is a global in Node 22+ and works on latin-1 strings.
  // Wrap in try/catch for older runtimes.
  if (typeof (globalThis as { btoa?: (s: string) => string }).btoa === 'function') {
    const btoa = (globalThis as { btoa: (s: string) => string }).btoa;
    return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  }
  // Fallback for environments without `btoa` (older Node). `binary`
  // is a latin-1 string built from bytes 0-255, so Buffer round-trips
  // it losslessly. Buffer is always available in Node.
  return Buffer.from(binary, 'latin1').toString('base64url');
}