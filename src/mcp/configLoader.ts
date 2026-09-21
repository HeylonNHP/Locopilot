/**
 * Loads MCP server configuration from `~/.locopilot/mcp.json`.
 *
 * Phase 2 policy:
 * - Missing file → return an empty config (no error).
 * - Malformed JSON → log to stderr and return an empty config; the
 *   application continues to run, just without MCP.
 * - Top-level `servers` (VS Code) is normalised to `mcpServers`.
 * - All three SDK transports are accepted: `stdio`, `http`, `sse`.
 *   Type-specific validation lives in `validateStdioConfig` and
 *   `validateHttpConfig`, both dispatched by `validateTransportConfig`.
 * - All server names are validated against `/^[a-z0-9_-]+$/i` to
 *   prevent them from leaking into filesystem paths unsafely.
 * - `${env.X}` placeholders in stdio `env` and HTTP `headers` are
 *   expanded at load time. A blocklist (`DANGEROUS_ENV_KEYS`) refuses
 *   to expand or set any key that could lead to code injection
 *   (PATH, LD_PRELOAD, NODE_OPTIONS, IFS, BASH_FUNC_*, etc.).
 */

import { promises as fsp, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isDangerousEnvKey } from './dangerousEnv';
import { expandEnvRefs, expandEnvRefsInRecord } from './envExpansion';
import { MCP_FORBIDDEN_SERVER_NAMES } from './schemaAdapter';
import {
  MCPConfigError,
  type MCPOAuthConfig,
  type MCPRootConfig,
  type MCPServerConfig,
} from './types';

const VALID_NAME_REGEX = /^[\w-]+$/i;
const MAX_NAME_LENGTH = 64;

export const MCP_CONFIG_DIRNAME = '.locopilot';
export const MCP_CONFIG_FILENAME = 'mcp.json';

/**
 * Module-level queue for serialising writes to `mcp.json`. Mirrors the
 * `configWriteQueue` pattern in `services/configManager.ts` so that
 * concurrent PUTs from the UI don't race against each other and lose
 * data (e.g. two toggles clicked within the same tick).
 *
 * Always chain onto the previous promise: `.then(task, task)` (both
 * success and failure branches run `task`) so an earlier failure
 * doesn't poison the queue.
 */
let saveQueue: Promise<void> = Promise.resolve();

/**
 * Ensure the MCP config file exists at the default path. If it is
 * already present this is a no-op. If it is missing, the parent
 * directory is created (recursively, with mode 0o700 \u2014 see
 * bug #21) and a minimal `{}` JSON object is written atomically
 * (tmp + rename, with an explicit `fh.sync()` between the write
 * and the rename for crash safety \u2014 see bug #5).
 *
 * Errors are logged and swallowed — this is a convenience init, not
 * a critical path.
 */
export async function ensureMCPConfigFile(): Promise<void> {
  const configPath = getMCPConfigPath();
  try {
    await fsp.access(configPath);
    return; // already exists
  } catch {
    // doesn't exist — fall through to creation
  }

  try {
    const dir = path.join(os.homedir(), MCP_CONFIG_DIRNAME);
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
    const tmpPath = `${configPath}.tmp`;
    // Open with mode 0o600 BEFORE writing so the file is
    // never briefly world-readable (bug #21). The previous
    // implementation used `fsp.writeFile` with a mode
    // option, which on some platforms creates the file
    // with the process umask first and chmods after.
    const fh = await fsp.open(tmpPath, 'w', 0o600);
    try {
      await fh.writeFile('{}', { encoding: 'utf8' });
      // Crash-safety: force the write to disk before the
      // rename. Without this a power loss between rename
      // and the OS writeback could leave a zero-length
      // mcp.json on disk (bug #5).
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fsp.rename(tmpPath, configPath);
  } catch (err) {
    console.error(`[mcp] failed to create default MCP config: ${(err as Error).message}`);
  }
}

export function getMCPConfigPath(): string {
  return path.join(os.homedir(), MCP_CONFIG_DIRNAME, MCP_CONFIG_FILENAME);
}

/**
 * F8: synchronously create `~/.locopilot/`. `fs.watch()` throws ENOENT
 * synchronously when its path is missing, and `ensureMCPConfigFile()` is
 * async and only calls `mkdir` after several awaits — so the config watcher
 * lost a cold-start race against it. The watcher calls this BEFORE watch(dir).
 * Best-effort: failures are logged and swallowed.
 */
export function ensureMCPConfigDirSync(): void {
  try {
    mkdirSync(path.dirname(getMCPConfigPath()), { recursive: true, mode: 0o700 });
  } catch (err) {
    console.error(`[mcp] failed to create MCP config directory: ${(err as Error).message}`);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateServerName(name: string, key: string): void {
  if (name.length === 0 || name.length > MAX_NAME_LENGTH) {
    throw new MCPConfigError(
      `MCP server key "${key}" has an invalid name length (must be 1-${MAX_NAME_LENGTH} characters)`
    );
  }
  if (!VALID_NAME_REGEX.test(name)) {
    throw new MCPConfigError(
      `MCP server name "${name}" is invalid: only letters, digits, underscore and dash are allowed`
    );
  }
  if (name.includes('..') || name.startsWith('.') || name.startsWith('-')) {
    throw new MCPConfigError(
      `MCP server name "${name}" is invalid: must not start with a dot or dash, and must not contain ".."`
    );
  }
}

/**
 * F13: validate the RAW stdio transport object directly (no coercion).
 * Previously `normaliseServer` coerced (`String(...)`, `.map(String)`)
 * and dropped bad values before this ran, so the loud errors below were
 * dead code on the parse path (`"args": "foo"` was silently dropped,
 * `{"FOO":123}` became `"123"`).
 */
function validateStdioConfig(transportRaw: Record<string, unknown>, key: string): void {
  if (typeof transportRaw.command !== 'string' || transportRaw.command.trim().length === 0) {
    throw new MCPConfigError(`MCP server "${key}": stdio transport requires a non-empty "command"`);
  }
  if (
    transportRaw.args !== undefined &&
    (!Array.isArray(transportRaw.args) ||
      !transportRaw.args.every((arg) => typeof arg === 'string'))
  ) {
    throw new MCPConfigError(`MCP server "${key}": stdio "args" must be an array of strings`);
  }
  if (transportRaw.env !== undefined) {
    if (
      !isPlainObject(transportRaw.env) ||
      !Object.values(transportRaw.env).every((value) => typeof value === 'string')
    ) {
      throw new MCPConfigError(`MCP server "${key}": stdio "env" must be a string→string object`);
    }
    for (const envKey of Object.keys(transportRaw.env)) {
      // F13: this rejection is now actually reachable — raw validation
      // runs BEFORE `expandEnvRefsInRecord` skips dangerous keys with a
      // warning, so the loud error is no longer dead code.
      if (isDangerousEnvKey(envKey)) {
        throw new MCPConfigError(
          `MCP config error: server "${key}" sets env key "${envKey}" which can lead to code injection. ` +
            `Remove it or rename it (e.g. MY_SERVER_PATH).`
        );
      }
    }
  }
  if (transportRaw.cwd !== undefined && typeof transportRaw.cwd !== 'string') {
    throw new MCPConfigError(`MCP server "${key}": stdio "cwd" must be a string`);
  }
}

/**
 * F13: validate the RAW http/sse transport object directly (no coercion).
 * `type` is passed in explicitly (rather than read from a normalised
 * transport) so the existing `http`/`sse` error wording is preserved.
 */
function validateHttpConfig(
  transportRaw: Record<string, unknown>,
  key: string,
  type: string
): void {
  if (typeof transportRaw.url !== 'string' || transportRaw.url.trim().length === 0) {
    throw new MCPConfigError(`MCP server "${key}": ${type} transport requires a non-empty "url"`);
  }
  // Light URL-shape check. We don't validate the scheme strictly (some
  // users run local servers on `http://localhost:...`); a runtime
  // connection error will surface a real config issue more clearly.
  let parsed: URL;
  try {
    parsed = new URL(transportRaw.url);
  } catch {
    throw new MCPConfigError(`MCP server "${key}": "${transportRaw.url}" is not a valid URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new MCPConfigError(
      `MCP server "${key}": URL scheme must be http(s); got "${parsed.protocol}"`
    );
  }
  const headers = transportRaw.headers;
  if (headers !== undefined) {
    if (
      !isPlainObject(headers) ||
      !Object.values(headers).every((value) => typeof value === 'string')
    ) {
      throw new MCPConfigError(
        `MCP server "${key}": ${type} "headers" must be a string→string object`
      );
    }
    const headerRecord = headers as Record<string, string>;
    for (const headerKey of Object.keys(headerRecord)) {
      // Header names are case-insensitive per RFC 7230, but we keep
      // the user's original casing in the config. Just sanity-check
      // the shape.
      if (headerKey.trim().length === 0 || /[\n\r]/.test(headerKey)) {
        throw new MCPConfigError(
          `MCP server "${key}": header name ${JSON.stringify(headerKey)} is invalid`
        );
      }
      if (/[\n\r]/.test(headerRecord[headerKey] ?? '')) {
        throw new MCPConfigError(
          `MCP server "${key}": header "${headerKey}" contains a CR/LF (header-injection attempt)`
        );
      }
    }
  }
}

/**
 * F13: server-level (transport-agnostic) shape checks. Previously these
 * lived inside `validateStdioConfig`, so an HTTP/SSE server's
 * `"autoApprove": "x"` / `"timeoutSeconds": "30"` was silently ignored.
 * They now run for every transport, before any coercion.
 */
function validateServerMeta(raw: Record<string, unknown>, key: string): void {
  if (
    raw.autoApprove !== undefined &&
    (!Array.isArray(raw.autoApprove) ||
      !raw.autoApprove.every((entry) => typeof entry === 'string'))
  ) {
    throw new MCPConfigError(`MCP server "${key}": "autoApprove" must be an array of strings`);
  }
  if (
    raw.timeoutSeconds !== undefined &&
    (typeof raw.timeoutSeconds !== 'number' ||
      !Number.isFinite(raw.timeoutSeconds) ||
      raw.timeoutSeconds <= 0)
  ) {
    throw new MCPConfigError(
      `MCP server "${key}": "timeoutSeconds" must be a positive finite number`
    );
  }
  if (
    raw.disabledTools !== undefined &&
    (!Array.isArray(raw.disabledTools) ||
      !raw.disabledTools.every((entry) => typeof entry === 'string'))
  ) {
    throw new MCPConfigError(`MCP server "${key}": "disabledTools" must be an array of strings`);
  }
  if (raw.disabled !== undefined && typeof raw.disabled !== 'boolean') {
    throw new MCPConfigError(`MCP server "${key}": "disabled" must be a boolean`);
  }
}

/**
 * F13: dispatch to the transport-specific validator with the RAW
 * transport object + type string, so validation happens BEFORE
 * coercion/expansion.
 */
function validateTransportConfig(
  transportRaw: Record<string, unknown>,
  transportType: string,
  key: string
): void {
  if (transportType === 'stdio') {
    validateStdioConfig(transportRaw, key);
  } else {
    validateHttpConfig(transportRaw, key, transportType);
  }
}

/**
 * FIX 2: validate + normalise ONE raw server entry, throwing the existing
 * `MCPConfigError` messages (name regex / forbidden-name / transport shape /
 * the F13 raw-shape validators) for a single server. Extracted so both the
 * strict and lenient parsers share exactly the same per-server validation.
 */
function normaliseOneServer(raw: unknown, key: string): MCPServerConfig {
  if (!isPlainObject(raw)) {
    throw new MCPConfigError(`MCP server "${key}" must be an object`);
  }

  const name = typeof raw.name === 'string' && raw.name.trim().length > 0 ? raw.name.trim() : key;
  validateServerName(name, key);
  validateServerName(key, key);

  if (name !== key) {
    throw new MCPConfigError(
      `MCP server "${key}": the "name" field ("${name}") must match the key ("${key}")`
    );
  }

  if (MCP_FORBIDDEN_SERVER_NAMES.has(name)) {
    throw new MCPConfigError(
      `MCP server "${name}" conflicts with a native Locopilot tool name. ` +
        `Choose a different server name to avoid shadowing the native tool.`
    );
  }

  if (!isPlainObject(raw.transport)) {
    throw new MCPConfigError(`MCP server "${key}" is missing a "transport" object`);
  }

  const transportRaw = raw.transport;
  const transportType = typeof transportRaw.type === 'string' ? transportRaw.type : 'stdio';
  if (transportType !== 'stdio' && transportType !== 'http' && transportType !== 'sse') {
    throw new MCPConfigError(
      `MCP server "${key}": unknown transport type "${transportType}" (allowed: stdio, http, sse)`
    );
  }

  // F13: validate the RAW shapes BEFORE coercion/expansion, so the loud
  // validators (and the dangerous-key rejection) run on exactly what the
  // user wrote rather than on values already coerced or silently dropped.
  validateServerMeta(raw, key);
  validateTransportConfig(transportRaw, transportType, key);

  // Expand `${env.X}` placeholders in stdio env and HTTP headers.
  // Done in `normaliseServer` so the expanded form is what the runtime
  // sees — the user can leave the raw `${env.X}` form in their config
  // and it'll be evaluated at load time. The raw records are validated
  // above, so `expandEnvRefsInRecord` receives them directly (no
  // `String(...)` coercion that could hide a bad shape).
  let expandedStdioEnv: Record<string, string> | undefined;
  if (transportType === 'stdio' && transportRaw.env !== undefined) {
    const envResult = expandEnvRefsInRecord(
      transportRaw.env as Record<string, string>,
      `MCP server "${key}" stdio env`
    );
    if (envResult.warnings.length > 0) {
      for (const w of envResult.warnings) console.warn(`[mcp] ${w}`);
    }
    expandedStdioEnv = envResult.expanded;
  }
  let expandedHttpHeaders: Record<string, string> | undefined;
  if (transportType !== 'stdio' && transportRaw.headers !== undefined) {
    const headersResult = expandEnvRefsInRecord(
      transportRaw.headers as Record<string, string>,
      `MCP server "${key}" ${transportType} headers`
    );
    if (headersResult.warnings.length > 0) {
      for (const w of headersResult.warnings) console.warn(`[mcp] ${w}`);
    }
    expandedHttpHeaders = headersResult.expanded;
  }

  // F13: build the transport/server objects from the already-validated
  // raw values WITHOUT coercion — a bad shape must now fail loudly in
  // the validators above, not be silently dropped or stringified here.
  const transport: MCPServerConfig['transport'] =
    transportType === 'stdio'
      ? {
          type: 'stdio',
          command: transportRaw.command as string,
          args: transportRaw.args as string[] | undefined,
          env: expandedStdioEnv,
          cwd: transportRaw.cwd as string | undefined,
        }
      : {
          type: transportType as 'http' | 'sse',
          url: transportRaw.url as string,
          headers: expandedHttpHeaders,
        };

  const server: MCPServerConfig = {
    name,
    transport,
  };
  if (typeof raw.description === 'string') {
    server.description = raw.description;
  }
  if (raw.autoApprove !== undefined) {
    server.autoApprove = raw.autoApprove as string[];
  }
  if (raw.timeoutSeconds !== undefined) {
    server.timeoutSeconds = raw.timeoutSeconds as number;
  }
  if (raw.disabledTools !== undefined) {
    server.disabledTools = raw.disabledTools as string[];
  }
  if (raw.disabled !== undefined) {
    server.disabled = raw.disabled as boolean;
  }
  if (isPlainObject(raw.oauth)) {
    server.oauth = normaliseOAuthConfig(raw.oauth, name);
  }

  return server;
}

/**
 * Validate and shape the `oauth` block from raw config. We accept
 * the documented subset (clientId / clientSecret / clientMetadataUrl /
 * scopes / authorizationServerUrl) and silently drop anything else — keeps
 * the loader forward-compatible with future SDK fields without
 * forcing a config bump.
 *
 * `${env.X}` expansion is applied to the secret (the only field
 * expected to carry a credential) and to `clientMetadataUrl` (which
 * points at a public document but is still convenient to keep in
 * the environment) so a user can keep both out of `mcp.json`.
 *
 * Bug #8 fix: an unresolved `${env.X}` reference in `clientSecret`
 * used to silently fall through to the empty string, leaving the
 * SDK to send an empty `client_secret` and the user with a
 * confusing "unauthorized client" error. We now scan the original
 * input for any `${env.X}` token whose `expandEnvRefs` reported
 * it as "not set" and reject the whole server config with a
 * clear `MCPConfigError`. (The other OAuth fields are
 * `clientId` and `scopes` — `clientId` is also expanded and we
 * apply the same check for symmetry, since a blank `client_id`
 * is just as broken as a blank `client_secret`.)
 *
 * `clientMetadataUrl` (SEP-991 / CIMD) is validated to be an HTTPS
 * URL with a non-root pathname — the same constraint the SDK applies
 * in its `isHttpsUrl` check — so a bad value fails loudly at load
 * time rather than mid-auth.
 */
function normaliseOAuthConfig(raw: Record<string, unknown>, key: string): MCPOAuthConfig {
  const result: MCPOAuthConfig = {};
  if (typeof raw.clientId === 'string' && raw.clientId.length > 0) {
    const expanded = expandEnvRefs(raw.clientId, `MCP server "${key}" oauth.clientId`);
    if (expanded.warnings.length > 0) {
      for (const w of expanded.warnings) console.warn(`[mcp] ${w}`);
    }
    assertNoUnresolvedEnvRefs(
      raw.clientId,
      expanded.warnings,
      `MCP server "${key}" oauth.clientId`
    );
    result.clientId = expanded.value;
  }
  if (typeof raw.clientSecret === 'string' && raw.clientSecret.length > 0) {
    const expanded = expandEnvRefs(raw.clientSecret, `MCP server "${key}" oauth.clientSecret`);
    if (expanded.warnings.length > 0) {
      for (const w of expanded.warnings) console.warn(`[mcp] ${w}`);
    }
    assertNoUnresolvedEnvRefs(
      raw.clientSecret,
      expanded.warnings,
      `MCP server "${key}" oauth.clientSecret`
    );
    result.clientSecret = expanded.value;
  }
  if (Array.isArray(raw.scopes)) {
    const scopes: string[] = [];
    for (const entry of raw.scopes) {
      if (typeof entry === 'string' && entry.trim().length > 0) {
        scopes.push(entry.trim());
      }
    }
    if (scopes.length > 0) result.scopes = scopes;
  }
  if (typeof raw.clientMetadataUrl === 'string' && raw.clientMetadataUrl.length > 0) {
    const expanded = expandEnvRefs(
      raw.clientMetadataUrl,
      `MCP server "${key}" oauth.clientMetadataUrl`
    );
    if (expanded.warnings.length > 0) {
      for (const w of expanded.warnings) console.warn(`[mcp] ${w}`);
    }
    assertNoUnresolvedEnvRefs(
      raw.clientMetadataUrl,
      expanded.warnings,
      `MCP server "${key}" oauth.clientMetadataUrl`
    );
    const url = expanded.value;
    // Mirror the SDK's `isHttpsUrl` (client/auth.js): the authorization
    // server fetches this document over the public internet, so it must
    // be https and live at a non-root pathname. Fail loudly at load time
    // rather than letting the SDK throw mid-auth.
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new MCPConfigError(
        `MCP server "${key}" oauth.clientMetadataUrl must be a valid HTTPS URL with a non-root pathname ` +
          `(got "${url}")`
      );
    }
    if (parsed.protocol !== 'https:' || parsed.pathname === '/') {
      throw new MCPConfigError(
        `MCP server "${key}" oauth.clientMetadataUrl must be a valid HTTPS URL with a non-root pathname ` +
          `(got "${url}")`
      );
    }
    result.clientMetadataUrl = url;
  }
  if (typeof raw.authorizationServerUrl === 'string' && raw.authorizationServerUrl.length > 0) {
    result.authorizationServerUrl = raw.authorizationServerUrl;
  }
  return result;
}

/**
 * Inspect the warnings returned by `expandEnvRefs` and throw a
 * `MCPConfigError` if any of them indicate an unresolved
 * `${env.X}` reference in the original input. Used by
 * `normaliseOAuthConfig` to surface typos / missing env vars in
 * the OAuth credentials at config-load time (bug #8) instead of
 * failing the actual connect with a confusing "Unauthorized
 * client" error from the IdP.
 *
 * We match the warning text rather than the original input
 * directly because `expandEnvRefs` already has the canonical
 * warning format (`<context>: env var "<name>" is not set`).
 * "Refused to expand dangerous env var" warnings are NOT
 * treated as unresolved — the expansion was intentionally
 * blocked for security reasons, and the empty-string result
 * is the right answer (the upstream code logs the warning).
 */
function assertNoUnresolvedEnvRefs(
  _original: string,
  warnings: readonly string[],
  context: string
): void {
  for (const w of warnings) {
    if (w.includes('is not set')) {
      throw new MCPConfigError(
        `${context} contains an unresolved env var: ${w}. ` +
          `Set the env var in your shell before starting Locopilot, or remove the \${env.X} reference.`
      );
    }
  }
}

/**
 * Parse a config object that has already been JSON-decoded. Useful for
 * testing. Throws `MCPConfigError` on validation failures.
 */
export function parseMCPConfig(raw: unknown): MCPRootConfig {
  if (!isPlainObject(raw)) {
    throw new MCPConfigError('MCP config root must be an object');
  }

  // Accept either the canonical `mcpServers` or the VS Code `servers` key.
  const serversField = (raw.mcpServers ?? raw.servers) as unknown;
  if (serversField === undefined) {
    // No servers block at all — return an empty config (not an error).
    return { mcpServers: {} };
  }
  if (!isPlainObject(serversField)) {
    throw new MCPConfigError('"mcpServers" must be an object keyed by server name');
  }

  const mcpServers: Record<string, MCPServerConfig> = {};
  for (const [key, value] of Object.entries(serversField)) {
    mcpServers[key] = normaliseOneServer(value, key);
  }

  return { mcpServers };
}

/**
 * FIX 2: per-server lenient parser. Unlike `parseMCPConfig`, a single malformed
 * server no longer blanks the WHOLE config — valid entries are kept and each
 * invalid one is reported as `{ server, message }`.
 *
 * This matters because F13 made the raw validators reachable: a config that
 * merely carried a bad field (a numeric env value, `timeoutSeconds` as a
 * string, `args` as a string, a `PATH` env key, …) used to coerce silently and
 * now throws. Strict parsing would therefore drop EVERY server from the UI and
 * tool list and make the broken file un-fixable from the sidebar (PUT
 * /api/mcp re-parses the whole file).
 *
 * Structural problems (root not an object, `mcpServers` not an object) still
 * throw exactly as `parseMCPConfig` does — only individual server entries are
 * skipped instead of aborting the whole file.
 *
 * `source` is an optional label (e.g. the file path) prefixed to each error
 * message for context.
 */
export function parseMCPConfigLenient(
  raw: unknown,
  source?: string
): { config: MCPRootConfig; errors: { server: string; message: string }[] } {
  if (!isPlainObject(raw)) {
    throw new MCPConfigError('MCP config root must be an object');
  }

  // Accept either the canonical `mcpServers` or the VS Code `servers` key.
  const serversField = (raw.mcpServers ?? raw.servers) as unknown;
  if (serversField === undefined) {
    // No servers block at all — return an empty config (not an error).
    return { config: { mcpServers: {} }, errors: [] };
  }
  if (!isPlainObject(serversField)) {
    throw new MCPConfigError('"mcpServers" must be an object keyed by server name');
  }

  const mcpServers: Record<string, MCPServerConfig> = {};
  const errors: { server: string; message: string }[] = [];
  for (const [key, value] of Object.entries(serversField)) {
    try {
      mcpServers[key] = normaliseOneServer(value, key);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({
        server: key,
        message: source === undefined ? message : `${source}: ${message}`,
      });
    }
  }

  return { config: { mcpServers }, errors };
}

/**
 * Load the on-disk MCP config. Returns an empty config if the file
 * does not exist. Logs and returns an empty config if the file is
 * malformed (so the rest of the app keeps working).
 */
export async function loadMCPConfig(): Promise<MCPRootConfig> {
  const configPath = getMCPConfigPath();
  let text: string;
  try {
    text = await fsp.readFile(configPath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code === 'ENOENT') {
      // Missing file is the normal Phase 1 state.
      // Create the default config file so subsequent writes
      // (e.g. toggling a server) don't fail.
      await ensureMCPConfigFile();
      return { mcpServers: {} };
    }
    console.error(`[mcp] failed to read ${configPath}: ${(err as Error).message}`);
    return { mcpServers: {} };
  }

  let parsed: unknown;
  try {
    // C5 fix: some editors (Notepad on Windows in particular) write
    // a UTF-8 BOM at the start of the file. `JSON.parse` rejects
    // that as a stray character; strip it explicitly before parsing.
    const stripped = text.codePointAt(0) === 0xfeff ? text.slice(1) : text;
    parsed = JSON.parse(stripped);
  } catch (err) {
    console.error(`[mcp] ${configPath} is not valid JSON: ${(err as Error).message}`);
    return { mcpServers: {} };
  }

  try {
    // FIX 2: parse leniently so ONE malformed server does not blank the whole
    // config. Each skipped server is logged individually.
    const { config, errors } = parseMCPConfigLenient(parsed);
    for (const error of errors) {
      console.error(`[mcp] ignoring server "${error.server}": ${error.message}`);
    }
    return config;
  } catch (err) {
    // Structural problems (root / `mcpServers` not an object) still blank the
    // config exactly as before — only individual bad servers are skipped.
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[mcp] ${configPath} failed validation: ${message}`);
    return { mcpServers: {} };
  }
}

/**
 * Returns a stable, sorted, shallow-clone snapshot of the server map.
 * Used by the API layer to list servers without exposing internal state.
 */
export function listMCPServers(config: MCPRootConfig): MCPServerConfig[] {
  return Object.values(config.mcpServers).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Atomically set the `disabled` flag on a single MCP server in
 * `~/.locopilot/mcp.json`. All other server entries, and every other
 * field of the touched server, are preserved verbatim.
 *
 * The write is serialised behind a module-level promise queue so two
 * concurrent saves can't race (last-write-wins is fine for now, but at
 * least we don't lose data on a no-op race). The file is written via
 * the standard `tmp + rename` pattern used by `services/configManager.ts`
 * so a crash mid-write can never leave a half-written `mcp.json` on disk.
 *
 * The on-disk JSON is always written with explicit `'utf8'` encoding
 * and without a BOM, so a save followed by a load never trips the
 * BOM-stripping branch in `loadMCPConfig()`. The `disabled` field is
 * written explicitly as a boolean (even when `false`) for clarity in
 * the on-disk file.
 *
 * Throws `MCPConfigError` if the server name is not present in the
 * current config (or is invalid per the loader's naming rules).
 * Re-throws lower-level I/O errors unchanged so the API layer can
 * surface a useful 500.
 *
 * NB: this function does NOT use `loadMCPConfig()` internally —
 * `loadMCPConfig()` deliberately swallows parse/validation errors and
 * returns an empty config (so the chat route keeps working when the
 * file is broken). That swallowing policy is wrong for a write path:
 * a save that falls back to an empty config would silently destroy
 * the user's existing servers. We therefore read + parse the file
 * directly here and surface errors to the caller.
 */
export async function saveMCPServerDisabled(name: string, disabled: boolean): Promise<void> {
  // Defense in depth: the API layer also validates, but a direct
  // caller could pass anything. The regex is the same one used by
  // the loader to validate server keys.
  if (typeof name !== 'string' || !VALID_NAME_REGEX.test(name) || name.length > MAX_NAME_LENGTH) {
    throw new MCPConfigError(`MCP server name "${name}" is invalid`);
  }
  if (MCP_FORBIDDEN_SERVER_NAMES.has(name)) {
    throw new MCPConfigError(`MCP server "${name}" conflicts with a native Locopilot tool name`);
  }

  const task = async (): Promise<void> => {
    const configPath = getMCPConfigPath();

    // Read + parse the raw file. We do NOT go through `loadMCPConfig`
    // because that swallows errors and would mask a broken file as
    // "no servers configured" — a save in that state would overwrite
    // the user's existing config with an empty one.
    let raw: string;
    try {
      raw = await fsp.readFile(configPath, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | null)?.code;
      if (code === 'ENOENT') {
        // File doesn't exist yet — create it, then retry the read.
        await ensureMCPConfigFile();
        raw = await fsp.readFile(configPath, 'utf8');
      } else {
        throw err;
      }
    }

    // Strip a leading UTF-8 BOM (Notepad on Windows writes one) so
    // `JSON.parse` doesn't reject the file. We do NOT write a BOM on
    // the way out (see `writeFile` call below), so the on-disk file
    // stays clean after a save.
    const stripped = raw.codePointAt(0) === 0xfeff ? raw.slice(1) : raw;
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripped);
    } catch (err) {
      throw new MCPConfigError(`${configPath} is not valid JSON: ${(err as Error).message}`);
    }

    if (!isPlainObject(parsed)) {
      throw new MCPConfigError(`${configPath} root must be a JSON object`);
    }
    // Re-validate the file before mutating it. If the current
    // state would be rejected by `parseMCPConfig` (e.g. a
    // malformed server entry, a `name` field that doesn't match
    // the key, an unknown transport type), the next read would
    // silently drop the whole file's servers — data loss.
    //
    // FIX 2: validate PER SERVER so toggling a HEALTHY server still works while
    // a DIFFERENT server entry is malformed. Only the TARGET server must be
    // valid; structural problems (root / `mcpServers` not an object) still
    // abort the save via the throw below.
    let lenientErrors: { server: string; message: string }[];
    try {
      lenientErrors = parseMCPConfigLenient(parsed).errors;
    } catch (err) {
      throw new MCPConfigError(
        `MCP config is invalid and cannot be edited safely: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    const targetError = lenientErrors.find((error) => error.server === name);
    if (targetError !== undefined) {
      throw new MCPConfigError(
        `MCP config is invalid and cannot be edited safely: ${targetError.message}`
      );
    }
    const serversField = (parsed.mcpServers ?? parsed.servers) as unknown;
    if (!isPlainObject(serversField)) {
      throw new MCPConfigError(`${configPath} has no "mcpServers" object`);
    }
    if (!(name in serversField)) {
      throw new MCPConfigError(`MCP server "${name}" is not configured`);
    }

    // Re-shape the parent object so we preserve the original key
    // order and the original `mcpServers` vs `servers` spelling
    // (some users follow the VS Code `servers` convention). We
    // also preserve any other top-level fields (e.g. `$schema`).
    const nextServers: Record<string, unknown> = { ...serversField };
    const target = nextServers[name];
    if (!isPlainObject(target)) {
      throw new MCPConfigError(`MCP server "${name}" is malformed (not a JSON object)`);
    }
    // Always write `disabled` explicitly (even when `false`) for
    // round-trip stability: the on-disk shape is then unambiguous
    // and we don't have to worry about `exactOptionalPropertyTypes`.
    nextServers[name] = { ...target, disabled };

    const nextRoot: Record<string, unknown> = { ...parsed };
    if ('mcpServers' in parsed) {
      nextRoot.mcpServers = nextServers;
    } else {
      nextRoot.servers = nextServers;
    }

    // Crash-safety + mode (bugs #5 + #21): open the tmp
    // file with mode 0o600 BEFORE writing the JSON, force
    // the write to disk with `fh.sync()` before the
    // rename, and close in `finally`. The previous
    // implementation skipped the `fsync`, which meant a
    // power loss between the rename and the kernel's
    // writeback could leave a zero-length `mcp.json` on
    // disk. The mode is set at `open` time so the file is
    // never briefly world-readable on a multi-user host.
    const tmpPath = `${configPath}.tmp`;
    const json = JSON.stringify(nextRoot, null, 2);
    const fh = await fsp.open(tmpPath, 'w', 0o600);
    try {
      await fh.writeFile(json, { encoding: 'utf8' });
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fsp.rename(tmpPath, configPath);
  };

  // Chain on both success and failure so a single failed save can't
  // poison the queue for the next caller. `.then(task, task)` mirrors
  // the pattern in `services/configManager.ts`.
  saveQueue = saveQueue.then(task, task);
  return saveQueue;
}
