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
 * - A loopback HTTP listener on a per-server PINNED port that
 *   captures the authorization code from the IdP's 302 redirect,
 *   with a 5-minute timeout, CSRF `state` validation, and
 *   AbortSignal support. The port is persisted (F10) so the
 *   `redirect_uri` a dynamically-registered client was registered
 *   against stays valid across restarts.
 * - Non-blocking authorization (F9): `redirectToAuthorization`
 *   stashes the auth URL, emits an `auth-required` event, launches
 *   the browser, then returns immediately while the listener runs
 *   in the background and reports back through `OAuthFlowHooks`.
 *   The captured code is stashed on a process-global; the manager's
 *   `reauthenticate` picks it up and calls
 *   `transport.finishAuth(code)` to perform the actual token
 *   exchange (this is what the SDK does internally).
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

import type { MCPOAuthConfig, MCPSavedOAuthState, MCPServerConfig } from './types';

import { emitMCPEvent } from './events';
import { clearOAuthState, loadOAuthState, saveOAuthState } from './oauthTokenStore';

// --- Public factory ---

const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000; // 5 min
const LOOPBACK_HOST = '127.0.0.1';
/**
 * F18: fallback key for the per-flow PKCE verifier map when the flow
 * id (`state`) is somehow unavailable. A single slot shared by every
 * flow is the very thing this fix removes, so this is only a safety
 * net — normal flows always have a state.
 */
const DEFAULT_FLOW_KEY = '__default__';

/**
 * Hooks the client manager injects to own the background
 * authorization flow (F9). `buildOAuthProvider` no longer blocks the
 * caller for up to 5 minutes: `redirectToAuthorization` starts the
 * loopback listener in the background and reports its outcome through
 * these callbacks. The manager keeps the transport alive while the
 * flow is in flight and runs the token exchange when `onCode` fires.
 *
 * Deliberately defined here (not imported from `clientManager`) so
 * there is no import cycle: the provider is the producer, the manager
 * is the consumer.
 */
export interface OAuthFlowHooks {
  /** Aborts the background listener when the handle is torn down. */
  signal: AbortSignal;
  /** A loopback callback captured a code — run the token exchange. */
  onCode: (code: string, state: string | null) => void;
  /** The flow ended without a code (timeout, abort, port busy, IdP error). */
  onFailure: (message: string) => void;
}

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
 * Bind-probe a specific loopback port. Resolves `true` when the port
 * is currently free on `LOOPBACK_HOST`, `false` otherwise (in use, or
 * an error). F10: used to decide whether a pinned port is still usable
 * before reusing it.
 */
async function canBindLoopbackPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = http.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, LOOPBACK_HOST, () => {
      probe.close(() => resolve(true));
    });
  });
}

/**
 * Resolve the loopback callback port for a server (F10). Prefers a
 * persisted `loopbackPort` when it is still bindable, otherwise
 * allocates an ephemeral port and persists it. Pinning keeps the
 * `redirect_uri` stable so a dynamically-registered client stays
 * valid across restarts — a fresh ephemeral port each construction
 * would make the IdP reject the new redirect with
 * `invalid_redirect_uri`, which the SDK does NOT recover from
 * programmatically.
 *
 * A persist failure is logged and non-fatal: the in-memory port is
 * still returned so the current flow works; the worst case is that the
 * port changes again on the next restart.
 */
async function resolveLoopbackPort(serverName: string): Promise<number> {
  const saved = await loadOAuthState(serverName);
  const pinned = saved.loopbackPort;
  if (pinned !== undefined && (await canBindLoopbackPort(pinned))) {
    return pinned;
  }
  const port = await allocateLoopbackPort();
  try {
    const next: MCPSavedOAuthState = { ...saved, loopbackPort: port };
    await saveOAuthState(serverName, next);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[mcp-oauth:${serverName}] could not persist loopback port ${port}: ${message}. ` +
        `The redirect URI may change on the next restart, which can require re-registering the client.`
    );
  }
  return port;
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
 *
 * `opts.flow` (F9) carries the background-flow hooks. When present,
 * `redirectToAuthorization` runs the loopback listener in the
 * background and reports back through the hooks instead of blocking
 * the caller.
 */
export async function buildOAuthProvider(
  config: MCPServerConfig,
  opts: { interactive: boolean; flow?: OAuthFlowHooks }
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

  // Resolve the loopback port at construction time so the SDK's
  // synchronous `redirectUrl` getter has a stable value. F10: this
  // reuses the port we persisted last time (when still bindable) so
  // the `redirect_uri` a dynamically-registered client was
  // registered against stays valid. The actual HTTP server is only
  // started on the first auth flow kickoff (see `startCallbackServer`).
  let allocatedPort: number;
  try {
    allocatedPort = await resolveLoopbackPort(config.name);
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
    opts.interactive,
    opts.flow
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
  /** F9: background-flow hooks injected by the client manager (optional). */
  private readonly flow: OAuthFlowHooks | undefined;
  private cachedState: MCPSavedOAuthState | null = null;
  /**
   * F18: the OAuth `state` (flow id) of the current flow, captured in
   * `state()`. Keys this flow's PKCE verifier and pending code. Unlike
   * `currentState` it is NOT cleared by `runCallbackFlow`'s finally —
   * the later token exchange on this same provider still needs it.
   */
  private flowState: string | null = null;
  /**
   * F9: guards against a second `redirectToAuthorization` starting a
   * second loopback listener on the same port.
   */
  private flowInFlight = false;

  constructor(
    serverName: string,
    oauthConfig: MCPOAuthConfig,
    loopbackPort: number,
    interactive: boolean,
    flow: OAuthFlowHooks | undefined
  ) {
    this.serverName = serverName;
    this.oauthConfig = oauthConfig;
    this.loopbackPort = loopbackPort;
    this.interactive = interactive;
    this.flow = flow;
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
    // F18/FIX 7: remember the state (flow id) so the PKCE verifier and the
    // pending code can be keyed by it. We deliberately do NOT clear this in
    // `redirectToAuthorization`: the later `codeVerifier()` call on the same
    // provider instance needs to resolve THIS flow's verifier. `flowState`
    // intentionally persists for the lifetime of this provider instance —
    // `runCallbackFlow`'s finally only resets `currentState`, because the token
    // exchange runs AFTER the callback settles and still needs it. The provider
    // instance is per-connect (a fresh one is built for every `openConnection`),
    // so this is not a process- or manager-global leak.
    this.flowState = this.currentState;
    return this.currentState;
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    const state = await this.getState();
    const saved = state.clientInformation;
    if (saved !== undefined) {
      // FIX 6: a saved dynamically-registered client must not shadow a
      // statically-configured `oauth.clientId` the user added LATER. Prefer the
      // configured app registration unless the saved client IS that client.
      if (
        this.oauthConfig.clientId !== undefined &&
        saved.client_id !== this.oauthConfig.clientId
      ) {
        // We return the CONFIGURED client information rather than `undefined`.
        // The SDK (`authInternal` in client/auth.js) treats an `undefined`
        // clientInformation() as "no client yet" and falls into Dynamic Client
        // Registration — the opposite of preserving the configured clientId —
        // so returning the configured object is what actually keeps it.
        return this.configuredClientInformation();
      }
      // F10: a dynamically-registered client is only valid for the
      // redirect_uris it was registered against. If the current
      // `redirectUrl` isn't among them (e.g. the loopback port moved
      // before it was pinned, or an old store file has no recorded
      // redirects), forget the client so the SDK performs a fresh
      // Dynamic Client Registration against the current redirect.
      // `invalid_redirect_uri` is NOT in the SDK's programmatic
      // recovery set, so it must be prevented, not recovered.
      //
      // A statically-configured `clientId` cannot be re-registered,
      // so we always return it and let the IdP reject a genuinely bad
      // redirect.
      const isDynamicallyRegistered = this.oauthConfig.clientId === undefined;
      const redirectMatches =
        saved.redirect_uris !== undefined && saved.redirect_uris.includes(this.redirectUrl);
      if (isDynamicallyRegistered && !redirectMatches) {
        // Clear via the get/mutate helpers (not a raw file write) so a
        // concurrent save through `mutateState` cannot resurrect it.
        const cleared: MCPSavedOAuthState = { ...state };
        delete cleared.clientInformation;
        await this.mutateState(cleared);
        return undefined;
      }
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
      return this.configuredClientInformation();
    }
    return undefined;
  }

  /**
   * FIX 6: build the OAuth client information from the statically-configured
   * `oauth.clientId` / `oauth.clientSecret`. Returns `undefined` when no
   * `clientId` is configured (the SDK then drives Dynamic Client Registration).
   */
  private configuredClientInformation(): OAuthClientInformationMixed | undefined {
    const clientId = this.oauthConfig.clientId;
    if (clientId === undefined) return undefined;
    const result: OAuthClientInformationMixed = { client_id: clientId };
    if (this.oauthConfig.clientSecret !== undefined) {
      result.client_secret = this.oauthConfig.clientSecret;
    }
    return result;
  }

  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    const state = await this.getState();
    const next: MCPSavedOAuthState = { ...state };
    const stored: NonNullable<MCPSavedOAuthState['clientInformation']> = {
      client_id: info.client_id,
    };
    if (info.client_secret !== undefined) stored.client_secret = info.client_secret;
    if (info.client_id_issued_at !== undefined)
      stored.client_id_issued_at = info.client_id_issued_at;
    if (info.client_secret_expires_at !== undefined)
      stored.client_secret_expires_at = info.client_secret_expires_at;
    // F10: persist the redirects the registration was made against so
    // `clientInformation()` can later tell whether the saved client is
    // still valid for the current loopback redirect.
    const redirects =
      'redirect_uris' in info && Array.isArray(info.redirect_uris)
        ? info.redirect_uris
        : this.clientMetadata.redirect_uris;
    stored.redirect_uris = redirects.map(String);
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
    // F18: a successful token exchange implies THIS flow's code
    // verifier has done its job. Remove only our entry (keyed by the
    // flow's `state`) so a concurrent flow for the same server keeps
    // its verifier; drop the map entirely once empty. Also delete the
    // legacy single-slot field.
    const key = this.flowState ?? DEFAULT_FLOW_KEY;
    if (next.codeVerifiers !== undefined) {
      const remaining = { ...next.codeVerifiers };
      delete remaining[key];
      if (Object.keys(remaining).length > 0) {
        next.codeVerifiers = remaining;
      } else {
        delete next.codeVerifiers;
      }
    }
    delete next.codeVerifier;
    await this.mutateState(next);
  }

  async saveCodeVerifier(verifier: string): Promise<void> {
    const state = await this.getState();
    // F18: key the verifier by the flow's `state` (flow id). The SDK
    // calls `state()` before `saveCodeVerifier()`, so `flowState` is
    // set here. Two overlapping flows for one server used to share a
    // single slot, so flow B's verifier clobbered flow A's and the
    // first exchange failed PKCE with `invalid_grant`.
    const key = this.flowState ?? DEFAULT_FLOW_KEY;
    const next: MCPSavedOAuthState = {
      ...state,
      codeVerifiers: { ...state.codeVerifiers, [key]: verifier },
    };
    await this.mutateState(next);
  }

  async codeVerifier(): Promise<string> {
    const state = await this.getState();
    // F18: resolve this flow's verifier, falling back to the legacy
    // single-slot field for entries written by an older build.
    const fromFlow = this.flowState === null ? undefined : state.codeVerifiers?.[this.flowState];
    if (fromFlow !== undefined) return fromFlow;
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
   *   1) Print the URL to stderr and stash it (F9) so the client
   *      manager / chat UI can surface a clickable link.
   *   2) Emit an `auth-required` event carrying the URL.
   *   3) Auto-launch the user's default browser.
   *   4) If we have a loopback port, start the listener in the
   *      BACKGROUND and return immediately (F9).
   *
   * Bugs fixed in this revision:
   *   - #1 / F17: validate the `state` query param against the value
   *     returned by `state()`, failing CLOSED (a missing `state` is a
   *     mismatch). See `startCallbackServer`.
   *   - #2: hard 5-minute timeout inside `startCallbackServer`.
   *   - #3: optional `AbortSignal` (now supplied via `flow.signal`).
   *   - #6 / F9: the in-memory `currentState` is cleared in
   *     `runCallbackFlow`'s `finally`, while `flowState` is kept so a
   *     pending token exchange can still resolve its verifier. The
   *     on-disk verifier is only cleared when NO code was captured.
   *   - #7: auto-launch the browser after printing the URL.
   *
   * F9 (non-blocking): this method used to `await startCallbackServer`
   * and thus block the HTTP request for up to 5 minutes, with the
   * browser auto-launch happening inside the request. It now returns
   * immediately after kicking off `runCallbackFlow`; the SDK then
   * throws `UnauthorizedError`, `openConnection` flips the handle to
   * `auth_required` (another engineer keeps the transport alive for
   * the exchange), and the outcome is reported through `OAuthFlowHooks`.
   *
   * On success, the captured `code` is stashed on a process-global
   * keyed by server name + `state`. The host is then expected to call
   * `transport.finishAuth(code)` (via the manager's `reauthenticate`
   * flow) to trigger the actual token exchange.
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
    // F9: stash the URL so the client manager (and the UI via
    // `peekAuthorizationUrl`) can retrieve it AFTER the HTTP request
    // that started this flow has already returned.
    stashAuthorizationUrl(this.serverName, url);
    // F9: the flow now runs in the background and outlives the HTTP
    // request, so the UI needs a real link rather than relying on the
    // dev-server stderr.
    emitMCPEvent({ kind: 'auth-required', serverName: this.serverName, authUrl: url });
    // stderr is the safety net for headless / non-interactive use.
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

    // F9: a per-provider guard so a second call cannot start a second
    // listener on the same port. The SDK will still throw
    // `UnauthorizedError` on the second call, which is correct.
    if (this.flowInFlight) {
      console.error(
        `[mcp-oauth:${this.serverName}] An OAuth callback listener is already running for this provider; not starting a second one.`
      );
      return;
    }
    this.flowInFlight = true;

    // F9: capture the CSRF nonce now and run the listener in the
    // background. We deliberately do NOT await: blocking here for up
    // to 5 minutes is the bug being fixed. The SDK call that invoked
    // us throws `UnauthorizedError` as soon as we return, which is the
    // intended `auth_required` transition.
    const expectedState = this.currentState;
    void this.runCallbackFlow(expectedState);
  }

  /**
   * Background owner of one loopback authorization flow (F9).
   *
   * Runs `startCallbackServer` (which may take up to 5 minutes) and
   * reports the outcome through the injected `OAuthFlowHooks`:
   *   - a captured code → `flow.onCode(code, state)` (handled inside
   *     `startCallbackServer` just before the listener closes);
   *   - no code (timeout / abort / IdP error / port busy) → this
   *     flow's verifier is cleared and, unless the caller aborted us,
   *     `flow.onFailure(message)` is called.
   *
   * `finally` clears `currentState` (so the next flow starts fresh)
   * but KEEPS `flowState`: the pending token exchange that follows a
   * captured code runs on this same provider instance and must still
   * resolve this flow's PKCE verifier.
   */
  private async runCallbackFlow(expectedState: string | null): Promise<void> {
    try {
      const result = await this.startCallbackServer(expectedState, this.flow?.signal);
      if (!result.codeCaptured) {
        // Timeout / abort / IdP-reported error: no exchange will run,
        // so this flow's verifier is dead weight.
        await this.clearVerifier();
      }
    } catch (err) {
      if (this.flow?.signal.aborted) {
        // The handle was torn down deliberately; clean up quietly and
        // do NOT report a failure the user never caused.
        await this.clearVerifier();
      } else {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[mcp-oauth:${this.serverName}] OAuth callback flow failed: ${message}`);
        await this.clearVerifier();
        this.flow?.onFailure(message);
      }
    } finally {
      this.currentState = null;
      this.flowInFlight = false;
    }
  }

  /**
   * Remove only THIS flow's PKCE verifier (plus the legacy single-slot
   * field) via the get/mutate helpers, so a concurrent flow keeps
   * theirs and a concurrent save cannot resurrect ours (F18).
   */
  private async clearVerifier(): Promise<void> {
    try {
      const state = await this.getState();
      const key = this.flowState ?? DEFAULT_FLOW_KEY;
      const next: MCPSavedOAuthState = { ...state };
      let changed = false;
      if (next.codeVerifiers !== undefined) {
        const remaining = { ...next.codeVerifiers };
        delete remaining[key];
        if (Object.keys(remaining).length > 0) {
          next.codeVerifiers = remaining;
        } else {
          delete next.codeVerifiers;
        }
        changed = true;
      }
      if (next.codeVerifier !== undefined) {
        delete next.codeVerifier;
        changed = true;
      }
      if (changed) {
        await this.mutateState(next);
      }
    } catch (err) {
      // Non-fatal: the worst case is a stale verifier sitting in the
      // file until the next save.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[mcp-oauth:${this.serverName}] failed to clear code verifier: ${message}`);
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
          // Bug #1 / F17: validate the `state` query param against
          // the value returned by `state()`. FAIL CLOSED: a null
          // `expectedState` (which should not happen — the SDK always
          // calls `state()` first) or a missing `state` on the
          // callback is treated as a mismatch, so we never accept an
          // unauthenticated callback.
          //
          // A constant-time comparison is deliberately NOT used here:
          // this is a loopback-only listener bound to 127.0.0.1, the
          // nonce is a 16-byte CSPRNG value, and PKCE is the real
          // control protecting the code exchange — so a timing side
          // channel on this compare buys an attacker nothing.
          const returnedState = parsed.searchParams.get('state');
          if (expectedState === null || returnedState === null || returnedState !== expectedState) {
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
          // Stash the code on a process-global (keyed by server name
          // AND `state`; F18) so the manager's `reauthenticate` (or
          // `finishAuthAndRetry`) can pick it up.
          stashAuthorizationCode(this.serverName, code, expectedState);
          sendOk(res);
          // F9: close the listener BEFORE the token exchange runs, so
          // the port is free (and a retry that re-binds it does not
          // hit EADDRINUSE). `settleResolve` tears the server down;
          // `onCode` then hands the flow back to the client manager.
          setImmediate(() => {
            settleResolve(true);
            this.flow?.onCode(code, expectedState);
          });
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
        // F18: invalidating "the verifier" means the legacy single
        // slot AND the whole per-flow map.
        delete next.codeVerifier;
        delete next.codeVerifiers;
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
 * F18: entries are stored in a per-server ARRAY tagged with the
 * OAuth `state` (flow id). Two overlapping flows for one server used
 * to share a single slot, so flow B's code overwrote flow A's and the
 * wrong code/verifier pairing failed PKCE. `consumeAuthorizationCode`
 * now selects by `state`, and refuses to guess when more than one
 * fresh entry exists and no state was supplied.
 *
 * We use `globalThis` to be HMR-safe (Next.js dev mode re-evaluates
 * modules, so a module-level Map would be re-created and lose the
 * entry).
 */
const GLOBAL_KEY = '__mcpOAuthPendingCode';

interface PendingCode {
  code: string;
  state: string | null;
  receivedAt: number;
}

function getPending(): Map<string, PendingCode[]> {
  const g = globalThis as unknown as Record<string, unknown>;
  let map = g[GLOBAL_KEY] as Map<string, PendingCode[]> | undefined;
  if (!map) {
    map = new Map();
    g[GLOBAL_KEY] = map;
  }
  return map;
}

function pruneExpired(entries: PendingCode[], now: number): PendingCode[] {
  return entries.filter((entry) => now - entry.receivedAt <= CALLBACK_TIMEOUT_MS);
}

function stashAuthorizationCode(serverName: string, code: string, state: string | null): void {
  const map = getPending();
  const now = Date.now();
  const fresh = pruneExpired(map.get(serverName) ?? [], now);
  fresh.push({ code, state, receivedAt: now });
  map.set(serverName, fresh);
}

/**
 * Drain and return the stashed code (if any) for the given server.
 * Returns `undefined` when no matching code is waiting. The caller
 * is expected to call this from the post-401 retry path, e.g. in
 * `reauthenticate`.
 *
 * F18:
 * - with a `state`, returns the exact match (and removes only it);
 * - without a `state`, returns a code ONLY when exactly one fresh
 *   entry exists — otherwise it logs and returns `undefined` rather
 *   than guessing, which is what caused the wrong-code/verifier
 *   pairing.
 *
 * Expired entries are pruned on every read.
 */
export function consumeAuthorizationCode(serverName: string, state?: string): string | undefined {
  const map = getPending();
  const now = Date.now();
  const entries = pruneExpired(map.get(serverName) ?? [], now);
  if (entries.length === 0) {
    map.delete(serverName);
    return undefined;
  }
  if (state !== undefined) {
    const index = entries.findIndex((entry) => entry.state === state);
    if (index === -1) {
      map.set(serverName, entries);
      return undefined;
    }
    const [entry] = entries.splice(index, 1);
    if (entries.length > 0) {
      map.set(serverName, entries);
    } else {
      map.delete(serverName);
    }
    return entry?.code;
  }
  if (entries.length !== 1) {
    // Never guess which flow a bare code belongs to. Keep the
    // entries so a subsequent caller with a `state` can still match.
    map.set(serverName, entries);
    console.error(
      `[mcp-oauth:${serverName}] ${entries.length} pending authorization codes; cannot choose one without a state, ignoring.`
    );
    return undefined;
  }
  const [only] = entries;
  map.delete(serverName);
  return only?.code;
}

// --- Authorization-URL stash (F9) ---

/**
 * F9: the flow runs in the background, so the authorization URL is no
 * longer available as a local variable on the request that started it.
 * We stash the latest URL per server on a `globalThis`-pinned map so
 * the client manager / UI can retrieve it later. The `auth-required`
 * event also carries it; this is the pull-based counterpart.
 */
const AUTH_URL_GLOBAL_KEY = '__mcpOAuthAuthUrl';

function getAuthUrls(): Map<string, string> {
  const g = globalThis as unknown as Record<string, unknown>;
  let map = g[AUTH_URL_GLOBAL_KEY] as Map<string, string> | undefined;
  if (!map) {
    map = new Map();
    g[AUTH_URL_GLOBAL_KEY] = map;
  }
  return map;
}

function stashAuthorizationUrl(serverName: string, url: string): void {
  getAuthUrls().set(serverName, url);
}

/**
 * Return the most recently stashed authorization URL for a server, or
 * `undefined` when none is known. Non-consuming (`peek`): the caller
 * may read it more than once (e.g. re-render the UI).
 */
export function peekAuthorizationUrl(serverName: string): string | undefined {
  return getAuthUrls().get(serverName);
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
