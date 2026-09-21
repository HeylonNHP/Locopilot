/**
 * Pure decision helpers for the MCP OAuth client-registration and
 * failure-diagnosis paths.
 *
 * Why this is its own file:
 * - It is deliberately dependency-free: no `node:*`, no MCP SDK, no
 *   `debugLogger`, no I/O. That keeps the standalone `scripts/test-*.mjs`
 *   regression suite network-free and side-effect-free — importing
 *   `clientManager` / `oauthProvider` would drag in pino and the token
 *   store. This mirrors the `CLAUDE.md` guidance to separate business
 *   logic from I/O.
 * - The registration-strategy chain and the failure taxonomy are the two
 *   pieces of OAuth behaviour that are easiest to get subtly wrong and
 *   most valuable to pin with unit tests, so they live here as pure
 *   functions rather than inline in `clientManager` / `oauthProvider`.
 *
 * Design notes:
 * - The client-registration strategy is a small priority chain
 *   (`configured -> cimd -> dcr -> unavailable`). The actual selection
 *   inside the SDK is still delegated to the SDK; this helper only exists
 *   so the UI/diagnostics can describe what will happen without importing
 *   the SDK.
 * - The failure taxonomy is a discriminated union produced by a single
 *   pure function, mirroring the `types.ts` / `events.ts` unions. Callers
 *   switch on `kind` and use `userMessage` verbatim.
 */

// --- Client-registration strategy ---

export type ClientRegistrationStrategy = 'configured' | 'cimd' | 'dcr' | 'unavailable';

/**
 * The inputs that decide how the SDK will obtain a client identity for a
 * server, in priority order.
 */
export interface ClientRegistrationStrategyInput {
  /** A pre-registered `oauth.clientId` is configured in mcp.json. */
  clientConfigured: boolean;
  /** An `oauth.clientMetadataUrl` (SEP-991 / CIMD document) is configured. */
  cimdConfigured: boolean;
  /** The authorization server advertises `client_id_metadata_document_supported: true`. */
  asSupportsCimd: boolean;
  /** The authorization server advertises a `registration_endpoint` (RFC 7591 DCR). */
  asHasDcrEndpoint: boolean;
}

/**
 * Resolve the client-registration strategy as a priority chain. A
 * pre-registered `clientId` always wins; otherwise CIMD is preferred over
 * DCR, and if neither is available the flow cannot register a client at
 * all. This mirrors the order the SDK itself applies in
 * `client/auth.js` (`authInternal`): configured clientInformation ->
 * URL-based client id (SEP-991) -> `registerClient`.
 */
export function resolveClientRegistrationStrategy(
  input: ClientRegistrationStrategyInput
): ClientRegistrationStrategy {
  if (input.clientConfigured) return 'configured';
  if (input.cimdConfigured && input.asSupportsCimd) return 'cimd';
  if (input.asHasDcrEndpoint) return 'dcr';
  return 'unavailable';
}

/**
 * What the provider should expose as `clientMetadataUrl`. A configured
 * pre-registered client always wins; otherwise hand the URL to the SDK and
 * let it gate on `client_id_metadata_document_supported`
 * (`client/auth.js`, the SEP-991 `shouldUseUrlBasedClientId` branch).
 */
export function providerClientMetadataUrl(oauth: {
  clientId?: string | undefined;
  clientMetadataUrl?: string | undefined;
}): string | undefined {
  if (oauth.clientId !== undefined) return undefined;
  return oauth.clientMetadataUrl;
}

// --- Failure classification ---

/**
 * The narrow set of failure shapes the MCP OAuth path can produce. Used to
 * drive both the user-facing message and the `auth_required` vs `error`
 * status decision in `clientManager`.
 */
export type MCPOAuthFailureKind =
  | 'authorization_required'
  | 'registration_rejected'
  | 'registration_unavailable'
  | 'cimd_unusable'
  | 'token_exchange_failed'
  | 'authorization_timeout'
  | 'other';

/**
 * Everything `classifyMCPOAuthFailure` needs to label a connect/auth
 * failure. Kept explicit (rather than passing the error object) so the
 * classifier stays pure and trivially testable.
 */
export interface MCPOAuthFailureInput {
  /** The connect attempt was user-triggered (the "Authenticate" button / code paste). */
  interactive: boolean;
  /** The failure was the SDK's `UnauthorizedError`. */
  isUnauthorized: boolean;
  /** HTTP status extracted from the error, when one is available. */
  httpStatus: number | undefined;
  /** RFC 6749 `error` code carried by an SDK `OAuthError` subclass. */
  oauthErrorCode: string | undefined;
  /** The raw error message (may be empty for `ServerError`). */
  errorMessage: string;
  /** An authorization URL is currently stashed for this server. */
  authUrlStashed: boolean;
  /** `oauth.clientId` is configured. */
  clientConfigured: boolean;
  /** `oauth.clientMetadataUrl` is configured. */
  cimdConfigured: boolean;
  /** What discovery told us about the authorization server, when known. */
  discovery:
    | { clientIdMetadataDocumentSupported: boolean; registrationEndpointPresent: boolean }
    | undefined;
}

/**
 * The classifier's output. `isAuthProblem` drives the handle status
 * (`auth_required` vs `error`); `keepTransport` decides whether the live
 * transport must be preserved for a later `finishAuth` (only genuine 401s
 * can ever yield a code, so registration failures must reap it).
 */
export interface MCPOAuthFailureClassification {
  /** true => surface as `auth_required` rather than `error`. */
  isAuthProblem: boolean;
  /** true => do NOT tear the transport down. */
  keepTransport: boolean;
  kind: MCPOAuthFailureKind;
  /** Accurate, actionable message shown to the user. */
  userMessage: string;
}

/**
 * Is the authorization server offering neither CIMD nor DCR? Only
 * meaningful once discovery ran (`discovery` is defined).
 */
function isRegistrationUnavailable(input: MCPOAuthFailureInput): boolean {
  const discovery = input.discovery;
  return (
    discovery !== undefined &&
    !discovery.clientIdMetadataDocumentSupported &&
    !discovery.registrationEndpointPresent
  );
}

/**
 * Classify an MCP OAuth failure into an actionable kind + message. Pure:
 * the same inputs always produce the same output, so the regression suite
 * can pin every branch offline.
 *
 * Precedence:
 *   1. 401 / `UnauthorizedError` -> a genuine consent challenge.
 *   2. non-interactive connect -> never surface as an auth problem.
 *   3. registration-looking failures -> `registration_unavailable` /
 *      `cimd_unusable` / `registration_rejected`.
 *   4. everything else -> passthrough of the original message.
 *
 * `authUrlStashed` guards step 3. An authorization URL only exists after the
 * SDK reached `redirectToAuthorization`, which happens strictly AFTER it has a
 * client identity — so if a URL was generated for this flow, registration
 * necessarily succeeded and cannot be the cause of this failure.
 *
 * Only case 1 keeps the transport alive: a registration failure can never
 * produce an authorization code, so `finishAuth` would only leak it.
 */
export function classifyMCPOAuthFailure(
  input: MCPOAuthFailureInput
): MCPOAuthFailureClassification {
  // 1. Genuine "awaiting consent" challenge. The transport must survive so
  //    the later `finishAuth(code)` can run.
  if (input.isUnauthorized || input.httpStatus === 401) {
    return {
      isAuthProblem: true,
      keepTransport: true,
      kind: 'authorization_required',
      userMessage: 'OAuth required: click "Authenticate" in the MCP panel to grant access.',
    };
  }

  // 2. A background/eager connect must never be reported as an auth
  //    problem the user has to act on — it just failed, quietly.
  if (!input.interactive) {
    return {
      isAuthProblem: false,
      keepTransport: false,
      kind: 'other',
      userMessage: input.errorMessage,
    };
  }

  // 3. Registration-looking failures. The AS either rejects DCR while
  //    advertising CIMD (the Atlassian case), advertises neither, or the
  //    error itself names client registration.
  //
  //    `authUrlStashed` is the disambiguator. `discovery.clientIdMetadataDocumentSupported`
  //    describes the SERVER, not the failure, so on its own it would label
  //    every post-consent failure against a CIMD server as a registration
  //    problem. But an authorization URL is only stashed once the SDK reaches
  //    `redirectToAuthorization`, which is after registration succeeded — so a
  //    stashed URL proves registration is not the culprit.
  const registrationLooking =
    !input.authUrlStashed &&
    (input.oauthErrorCode === 'invalid_client_metadata' ||
      /dynamic client registration|invalid oauth error response/i.test(input.errorMessage) ||
      input.discovery?.clientIdMetadataDocumentSupported === true ||
      isRegistrationUnavailable(input));

  if (registrationLooking) {
    if (isRegistrationUnavailable(input)) {
      return {
        isAuthProblem: true,
        keepTransport: false,
        kind: 'registration_unavailable',
        userMessage:
          'This server supports neither Client ID Metadata Documents nor Dynamic Client Registration. ' +
          'Set oauth.clientId (and oauth.clientSecret if required) in mcp.json.',
      };
    }
    if (input.cimdConfigured) {
      return {
        isAuthProblem: true,
        keepTransport: false,
        kind: 'cimd_unusable',
        userMessage:
          'oauth.clientMetadataUrl is set but the server did not accept it and rejected Dynamic Client ' +
          'Registration. Verify the client-metadata document is publicly reachable over HTTPS.',
      };
    }
    return {
      isAuthProblem: true,
      keepTransport: false,
      kind: 'registration_rejected',
      userMessage:
        'Server rejects Dynamic Client Registration and requires a pre-registered client. ' +
        'Set oauth.clientMetadataUrl (public HTTPS client-metadata document) or oauth.clientId in mcp.json.',
    };
  }

  // 4. Anything else (token exchange, transport, …): pass the original
  //    message through unchanged.
  return {
    isAuthProblem: false,
    keepTransport: false,
    kind: 'other',
    userMessage: input.errorMessage,
  };
}
