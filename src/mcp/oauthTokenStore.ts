/**
 * On-disk persistence for OAuth 2.1 tokens, PKCE verifiers, and
 * dynamically-registered client information used by the MCP OAuth
 * flow.
 *
 * Why this is its own file (not folded into `configLoader.ts`):
 * - Tokens and code verifiers are secrets; we keep them out of
 *   `mcp.json` so the user's edited config file stays free of
 *   `access_token: "ya29..."`-style noise. The split also makes it
 *   easy to gitignore the token file in the future.
 * - Writes are independent of the `mcp.json` write queue. A token
 *   save from the SDK doesn't have to be serialised with config
 *   edits; the queue in `configLoader.ts` is for one specific
 *   shape.
 * - The store is keyed by server name, NOT by transport URL, so
 *   re-pointing a server to a different host (e.g. moving from a
 *   staging URL to a production URL with the same name) wipes
 *   stale tokens. That is the safe default.
 *
 * Atomic-write pattern: every save goes through `tmp + rename`
 * using the same convention as `mcp/configLoader.ts` and
 * `services/configManager.ts`. A crash mid-write can never leave
 * a half-written tokens file.
 *
 * Two readers, deliberately (F19):
 * - `loadOAuthTokenStore()` is the tolerant READ path used when
 *   loading state for a connect. A corrupt file must not break MCP
 *   startup, so it logs and returns an empty store.
 * - `loadOAuthTokenStoreStrict()` throws on any failure other than
 *   ENOENT and is what the SAVE path must use. The save is a
 *   read-modify-write; if the read silently degraded to "empty
 *   store", the write would persist a store containing ONLY the
 *   server being saved and destroy every other server's
 *   tokens/client-info/verifiers. This is the same reasoning as
 *   `configLoader.saveMCPServerDisabled`, which reads the raw file
 *   directly for exactly this reason.
 *
 * File locking / cross-process coordination: not implemented.
 * Locopilot is a single-user dev tool; two concurrent
 * `next dev` instances writing to the same `~/.locopilot/`
 * directory is not a supported scenario. If that ever becomes a
 * concern, the existing `configWriteQueue` in `configLoader.ts`
 * can be mirrored here.
 *
 * The on-disk JSON is always written with explicit `'utf8'`
 * encoding and without a BOM, mirroring the policy used by
 * `mcp/configLoader.ts`.
 */

import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type {
  MCPOAuthTokenStoreFile,
  MCPSavedClientInformation,
  MCPSavedOAuthState,
  MCPSavedOAuthTokens,
} from './types';

import { MCP_CONFIG_DIRNAME } from './configLoader';

export const MCP_OAUTH_TOKENS_FILENAME = 'mcp-oauth-tokens.json';

/**
 * Module-level queue for serialising writes to the tokens file.
 * Same shape as `saveQueue` in `mcp/configLoader.ts`; the `.then(task, task)`
 * pattern guarantees an earlier failure doesn't poison the queue.
 */
let writeQueue: Promise<void> = Promise.resolve();

function getStorePath(): string {
  return path.join(os.homedir(), MCP_CONFIG_DIRNAME, MCP_OAUTH_TOKENS_FILENAME);
}

function emptyState(): MCPSavedOAuthState {
  return {};
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parse + validate the raw JSON text of the token store. Throws on
 * malformed JSON or a wrong root shape so the caller can decide
 * whether to tolerate the failure (read path) or abort (save path).
 *
 * Strips a leading UTF-8 BOM (Notepad on Windows writes one) so
 * `JSON.parse` doesn't reject the file, and sanitises each server
 * entry via `sanitiseState` — an entry we don't recognise is
 * dropped rather than surfaced as garbage.
 */
function parseTokenStore(raw: string, storePath: string): MCPOAuthTokenStoreFile {
  const stripped = raw.codePointAt(0) === 0xfeff ? raw.slice(1) : raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch (err) {
    throw new Error(`${storePath} is not valid JSON: ${(err as Error).message}`);
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`${storePath} root must be a JSON object`);
  }
  const rawServers = parsed.servers;
  // A missing `servers` key is treated as "no servers yet" (nothing
  // to lose). A present-but-wrong-shaped `servers` value is a hard
  // error — treating it as empty on the save path would truncate
  // the file.
  if (rawServers !== undefined && !isPlainObject(rawServers)) {
    throw new Error(`${storePath} "servers" must be a JSON object`);
  }
  const servers: Record<string, MCPSavedOAuthState> = {};
  if (isPlainObject(rawServers)) {
    for (const [name, value] of Object.entries(rawServers)) {
      if (!isPlainObject(value)) continue;
      servers[name] = sanitiseState(value);
    }
  }
  return { version: 1, servers };
}

/**
 * Strict reader: throws on any failure EXCEPT ENOENT.
 *
 * ENOENT legitimately means "the file does not exist yet" → empty
 * store. Every other failure (EBUSY / EPERM while an anti-virus
 * scanner holds the file, EACCES, malformed JSON, …) propagates so
 * the caller can abort instead of acting on a phantom empty store.
 *
 * The SAVE path (`saveOAuthState`) MUST use this reader; using the
 * tolerant `loadOAuthTokenStore()` would turn a transient read
 * failure into data loss for every other server.
 */
export async function loadOAuthTokenStoreStrict(): Promise<MCPOAuthTokenStoreFile> {
  const storePath = getStorePath();
  let raw: string;
  try {
    raw = await fsp.readFile(storePath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code === 'ENOENT') {
      return { version: 1, servers: {} };
    }
    throw err;
  }
  return parseTokenStore(raw, storePath);
}

/**
 * Read the entire token store from disk. Returns an empty object
 * if the file doesn't exist or is unreadable / malformed. The
 * `servers` field is always present after this call so callers can
 * index it without a null check.
 *
 * Errors are logged but never thrown: a missing or corrupt tokens
 * file should not break MCP startup. The next save will create
 * the file fresh.
 *
 * NOTE (F19): this tolerant behaviour is correct for the READ path
 * only. The SAVE path must go through `loadOAuthTokenStoreStrict()`
 * — read-modify-writing on top of a silently-emptied store would
 * destroy every other server's entries.
 */
export async function loadOAuthTokenStore(): Promise<MCPOAuthTokenStoreFile> {
  const storePath = getStorePath();
  try {
    return await loadOAuthTokenStoreStrict();
  } catch (err) {
    // ENOENT never reaches here (the strict reader maps it to an
    // empty store), so this is a real read/parse failure.
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[mcp-oauth] failed to read ${storePath}: ${message}`);
    return { version: 1, servers: {} };
  }
}

/**
 * Sanitise a raw `servers[name]` value pulled from the JSON file.
 * Defensive against partial writes / hand-edits / future schema
 * drift — we accept what we recognise and drop the rest.
 */
function sanitiseState(raw: Record<string, unknown>): MCPSavedOAuthState {
  const state: MCPSavedOAuthState = emptyState();
  const client = raw.clientInformation;
  if (isPlainObject(client) && typeof client.client_id === 'string') {
    const info: MCPSavedClientInformation = { client_id: client.client_id };
    if (typeof client.client_secret === 'string') info.client_secret = client.client_secret;
    if (typeof client.client_id_issued_at === 'number')
      info.client_id_issued_at = client.client_id_issued_at;
    if (typeof client.client_secret_expires_at === 'number')
      info.client_secret_expires_at = client.client_secret_expires_at;
    // F10: round-trip the redirects the client was registered
    // against so the provider can detect a stale registration after
    // the loopback port changes. Absence (old store files) is
    // preserved deliberately — it triggers a one-time re-registration.
    if (Array.isArray(client.redirect_uris)) {
      const uris = client.redirect_uris.filter((u): u is string => typeof u === 'string');
      if (uris.length > 0) info.redirect_uris = uris;
    }
    state.clientInformation = info;
  }
  const tokens = raw.tokens;
  // F19: `token_type` is required by RFC 6749 but real-world IdPs
  // routinely omit it. Dropping the whole token set because of a
  // missing `token_type` forced a full re-auth for no reason, so we
  // default it to `'Bearer'`. The `access_token` check stays — a
  // token set with no access token is genuinely useless.
  if (isPlainObject(tokens) && typeof tokens.access_token === 'string') {
    const t: MCPSavedOAuthTokens = {
      access_token: tokens.access_token,
      token_type: typeof tokens.token_type === 'string' ? tokens.token_type : 'Bearer',
    };
    if (typeof tokens.id_token === 'string') t.id_token = tokens.id_token;
    if (typeof tokens.expires_in === 'number') t.expires_in = tokens.expires_in;
    if (typeof tokens.scope === 'string') t.scope = tokens.scope;
    if (typeof tokens.refresh_token === 'string') t.refresh_token = tokens.refresh_token;
    state.tokens = t;
  }
  if (typeof raw.codeVerifier === 'string' && raw.codeVerifier.length > 0) {
    state.codeVerifier = raw.codeVerifier;
  }
  // F18: round-trip the per-flow PKCE verifiers keyed by OAuth
  // `state` so an in-flight flow that spans a file read still finds
  // its verifier.
  if (isPlainObject(raw.codeVerifiers)) {
    const verifiers: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw.codeVerifiers)) {
      if (typeof value === 'string' && value.length > 0) verifiers[key] = value;
    }
    if (Object.keys(verifiers).length > 0) state.codeVerifiers = verifiers;
  }
  if (typeof raw.authorizationServerUrl === 'string' && raw.authorizationServerUrl.length > 0) {
    state.authorizationServerUrl = raw.authorizationServerUrl;
  }
  // F10: round-trip the pinned loopback port (validate it is a
  // usable TCP port number so a hand-edited file can't break bind).
  if (
    typeof raw.loopbackPort === 'number' &&
    Number.isInteger(raw.loopbackPort) &&
    raw.loopbackPort > 0 &&
    raw.loopbackPort <= 65_535
  ) {
    state.loopbackPort = raw.loopbackPort;
  }
  return state;
}

/**
 * Read just the saved state for a single server. Cheap when the
 * file is small; for very large files this is still O(file-size)
 * because we read the whole thing. The store is per-user and
 * not expected to grow large.
 */
export async function loadOAuthState(serverName: string): Promise<MCPSavedOAuthState> {
  const file = await loadOAuthTokenStore();
  return file.servers[serverName] ?? emptyState();
}

/**
 * Merge-and-write: read the current store, replace the entry for
 * `serverName` with `state`, and persist the result atomically.
 *
 * Passing `state = {}` effectively deletes the entry. We don't
 * physically unlink the file (so a race with a parallel write
 * doesn't lose the entry), we just write a record with no
 * recognised fields so `loadOAuthState()` returns the empty
 * default.
 *
 * Crash safety (bug #5): the write is `fsp.open` →
 * `fsp.write` → `fh.sync()` → `fsp.close` → `fsp.rename`. The
 * `fsync` between write and rename forces the tmp file's
 * contents to disk before the rename atomically swaps the
 * final path. Without the `fsync`, a power loss between rename
 * and the OS's writeback could leave a zero-length file at the
 * final path (the rename happens, the data is still in the page
 * cache). With `fsync`, the kernel has committed the data
 * before the rename, so on recovery the file is either the
 * pre-write state or the full new state \u2014 never a torn
 * partial write.
 *
 * File mode (bug #21): the parent directory is created with
 * mode 0o700 and the file is written with mode 0o600. The
 * tokens file holds OAuth access/refresh tokens and PKCE code
 * verifiers \u2014 the secrets MUST NOT be world-readable on a
 * multi-user host. We can't `chmod` an existing file (would
 * race with the rename), so the mode is set at creation time
 * and the loader is responsible for fixing any pre-existing
 * loose permissions on first read.
 *
 * F19: the read step uses the STRICT reader. A transient read
 * failure (anti-virus holding the file, EACCES, a malformed file)
 * makes the promise reject and the write is skipped entirely,
 * instead of persisting a store that contains only the server
 * being saved.
 */
export async function saveOAuthState(serverName: string, state: MCPSavedOAuthState): Promise<void> {
  if (typeof serverName !== 'string' || serverName.length === 0) {
    throw new Error('saveOAuthState: serverName is required');
  }
  const task = async (): Promise<void> => {
    const storePath = getStorePath();
    // F19: strict read. A failure here aborts the write (the task
    // rejects) so we never truncate other servers' entries.
    const current = await loadOAuthTokenStoreStrict();
    // Deep-clone the incoming state to avoid aliasing mutations
    // (the caller might continue to mutate it).
    const cloned: MCPSavedOAuthState = structuredClone(state);
    const hasAny = Object.keys(cloned).length > 0;
    if (hasAny) {
      current.servers[serverName] = cloned;
    } else {
      delete current.servers[serverName];
    }
    const tmpPath = `${storePath}.tmp`;
    const json = JSON.stringify(current, null, 2);
    // Best-effort mkdir. `fsp.mkdir` with recursive: true is
    // idempotent and won't throw on EEXIST.
    await fsp.mkdir(path.dirname(storePath), { recursive: true, mode: 0o700 });
    // Open the tmp file with mode 0o600 BEFORE writing the
    // contents; `fsp.writeFile` is open-then-write, so this
    // is the only way to set the mode atomically. The
    // previous implementation used `fsp.writeFile` with a
    // `mode` option, but that was after the fact on
    // Windows and the file may have been created with the
    // process umask first.
    const fh = await fsp.open(tmpPath, 'w', 0o600);
    try {
      await fh.writeFile(json, { encoding: 'utf8' });
      // Force the data to disk BEFORE the rename. Without
      // this, a power loss between the rename and the
      // kernel's writeback could leave a zero-length file
      // at the final path.
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fsp.rename(tmpPath, storePath);
  };
  writeQueue = writeQueue.then(task, task);
  return writeQueue;
}

/**
 * Wipe every saved field for a single server (tokens, client info,
 * code verifier, cached discovery state). Used by the `/mcp auth`
 * slash command when the user explicitly wants to re-authenticate.
 */
export async function clearOAuthState(serverName: string): Promise<void> {
  await saveOAuthState(serverName, emptyState());
}
