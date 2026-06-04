/**
 * Loads MCP server configuration from `~/.locopilot/mcp.json`.
 *
 * Phase 1 policy:
 * - Missing file → return an empty config (no error).
 * - Malformed JSON → log to stderr and return an empty config; the
 *   application continues to run, just without MCP.
 * - Top-level `servers` (VS Code) is normalised to `mcpServers`.
 * - Phase 1 only accepts `type: "stdio"`; other transport types are
 *   rejected with a logged warning per server.
 * - All server names are validated against `/^[a-z0-9_-]+$/i` to
 *   prevent them from leaking into filesystem paths unsafely.
 */

import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';

import {
    MCPConfigError,
    type MCPRootConfig,
    type MCPServerConfig,
} from './types';
import { MCP_FORBIDDEN_SERVER_NAMES } from './schemaAdapter';

const VALID_NAME_REGEX = /^[a-z0-9_-]+$/i;
const MAX_NAME_LENGTH = 64;

/**
 * Environment variables that must never be overridden via mcp.json.
 * See B1 in the bug report: PATH / LD_PRELOAD / NODE_OPTIONS / IFS
 * / BASH_FUNC_* can be used by an attacker (or a careless user) to
 * pivot into arbitrary code execution inside the spawned MCP child.
 * The wildcard catch-all for BASH_FUNC_* covers exported bash
 * functions, which bash implements as env vars named
 * `BASH_FUNC_<name>%%`.
 */
const DANGEROUS_ENV_KEYS: ReadonlySet<string> = new Set([
    'PATH',
    'LD_PRELOAD',
    'LD_LIBRARY_PATH',
    'DYLD_INSERT_LIBRARIES',
    'DYLD_LIBRARY_PATH',
    'NODE_OPTIONS',
    'NODE_PATH',
    'PYTHONPATH',
    'IFS',
    'SHELLOPTS',
    'BASH_ENV',
    'ENV',
]);

function isDangerousEnvKey(key: string): boolean {
    if (DANGEROUS_ENV_KEYS.has(key)) return true;
    // bash function exports are exposed as `BASH_FUNC_name%%`. We refuse
    // the whole namespace rather than try to enumerate every name.
    if (key.startsWith('BASH_FUNC_') && key.endsWith('%%')) return true;
    return false;
}

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

export function getMCPConfigPath(): string {
    return path.join(os.homedir(), MCP_CONFIG_DIRNAME, MCP_CONFIG_FILENAME);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateServerName(name: string, key: string): void {
    if (name.length === 0 || name.length > MAX_NAME_LENGTH) {
        throw new MCPConfigError(
            `MCP server key "${key}" has an invalid name length (must be 1-${MAX_NAME_LENGTH} characters)`,
        );
    }
    if (!VALID_NAME_REGEX.test(name)) {
        throw new MCPConfigError(
            `MCP server name "${name}" is invalid: only letters, digits, underscore and dash are allowed`,
        );
    }
    if (name.includes('..') || name.startsWith('.') || name.startsWith('-')) {
        throw new MCPConfigError(
            `MCP server name "${name}" is invalid: must not start with a dot or dash, and must not contain ".."`,
        );
    }
}

function validateStdioConfig(server: MCPServerConfig, key: string): void {
    const transport = server.transport;
    if (transport.type !== 'stdio') {
        throw new MCPConfigError(
            `MCP server "${key}": transport type "${transport.type}" is not supported in Phase 1 (only "stdio" is implemented)`,
        );
    }
    if (typeof transport.command !== 'string' || transport.command.trim().length === 0) {
        throw new MCPConfigError(`MCP server "${key}": stdio transport requires a non-empty "command"`);
    }
    if (transport.args !== undefined) {
        if (!Array.isArray(transport.args) || !transport.args.every((arg) => typeof arg === 'string')) {
            throw new MCPConfigError(`MCP server "${key}": stdio "args" must be an array of strings`);
        }
    }
    if (transport.env !== undefined) {
        if (!isPlainObject(transport.env) ||
            !Object.values(transport.env).every((value) => typeof value === 'string')) {
            throw new MCPConfigError(`MCP server "${key}": stdio "env" must be a string→string object`);
        }
        for (const envKey of Object.keys(transport.env)) {
            if (isDangerousEnvKey(envKey)) {
                throw new MCPConfigError(
                    `MCP config error: server "${key}" sets env key "${envKey}" which can lead to code injection. ` +
                    `Remove it or rename it (e.g. MY_SERVER_PATH).`,
                );
            }
        }
    }
    if (transport.cwd !== undefined && typeof transport.cwd !== 'string') {
        throw new MCPConfigError(`MCP server "${key}": stdio "cwd" must be a string`);
    }
    if (server.autoApprove !== undefined) {
        if (!Array.isArray(server.autoApprove) ||
            !server.autoApprove.every((entry) => typeof entry === 'string')) {
            throw new MCPConfigError(`MCP server "${key}": "autoApprove" must be an array of strings`);
        }
    }
    if (server.timeoutSeconds !== undefined) {
        if (typeof server.timeoutSeconds !== 'number' ||
            !Number.isFinite(server.timeoutSeconds) ||
            server.timeoutSeconds <= 0) {
            throw new MCPConfigError(`MCP server "${key}": "timeoutSeconds" must be a positive finite number`);
        }
    }
    if (server.disabledTools !== undefined) {
        if (!Array.isArray(server.disabledTools) ||
            !server.disabledTools.every((entry) => typeof entry === 'string')) {
            throw new MCPConfigError(`MCP server "${key}": "disabledTools" must be an array of strings`);
        }
    }
}

function normaliseServer(raw: unknown, key: string): MCPServerConfig {
    if (!isPlainObject(raw)) {
        throw new MCPConfigError(`MCP server "${key}" must be an object`);
    }

    const name = typeof raw.name === 'string' && raw.name.trim().length > 0 ? raw.name.trim() : key;
    validateServerName(name, key);
    validateServerName(key, key);

    if (name !== key) {
        throw new MCPConfigError(
            `MCP server "${key}": the "name" field ("${name}") must match the key ("${key}")`,
        );
    }

    if (MCP_FORBIDDEN_SERVER_NAMES.has(name)) {
        throw new MCPConfigError(
            `MCP server "${name}" conflicts with a native Locopilot tool name. ` +
            `Choose a different server name to avoid shadowing the native tool.`,
        );
    }

    if (!isPlainObject(raw.transport)) {
        throw new MCPConfigError(`MCP server "${key}" is missing a "transport" object`);
    }

    const transportRaw = raw.transport;
    const transportType = typeof transportRaw.type === 'string' ? transportRaw.type : 'stdio';
    if (transportType !== 'stdio' && transportType !== 'http' && transportType !== 'sse') {
        throw new MCPConfigError(
            `MCP server "${key}": unknown transport type "${transportType}" (allowed: stdio, http, sse)`,
        );
    }

    const transport: MCPServerConfig['transport'] = transportType === 'stdio'
        ? {
            type: 'stdio',
            command: String(transportRaw.command ?? ''),
            args: Array.isArray(transportRaw.args)
                ? transportRaw.args.map((arg) => String(arg))
                : undefined,
            env: isPlainObject(transportRaw.env)
                ? Object.fromEntries(
                    Object.entries(transportRaw.env).map(([k, v]) => [k, String(v)]),
                )
                : undefined,
            cwd: typeof transportRaw.cwd === 'string' ? transportRaw.cwd : undefined,
        }
        : {
            type: transportType as 'http' | 'sse',
            url: String(transportRaw.url ?? ''),
            headers: isPlainObject(transportRaw.headers)
                ? Object.fromEntries(
                    Object.entries(transportRaw.headers).map(([k, v]) => [k, String(v)]),
                )
                : undefined,
        };

    const server: MCPServerConfig = {
        name,
        transport,
    };
    if (typeof raw.description === 'string') {
        server.description = raw.description;
    }
    if (Array.isArray(raw.autoApprove)) {
        server.autoApprove = raw.autoApprove.map((entry) => String(entry));
    }
    if (typeof raw.timeoutSeconds === 'number') {
        server.timeoutSeconds = raw.timeoutSeconds;
    }
    if (Array.isArray(raw.disabledTools)) {
        server.disabledTools = raw.disabledTools.map((entry) => String(entry));
    }
    if (typeof raw.disabled === 'boolean') {
        server.disabled = raw.disabled;
    }

    validateStdioConfig(server, key);
    return server;
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
        mcpServers[key] = normaliseServer(value, key);
    }

    return { mcpServers };
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
        const stripped = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
        parsed = JSON.parse(stripped);
    } catch (err) {
        console.error(`[mcp] ${configPath} is not valid JSON: ${(err as Error).message}`);
        return { mcpServers: {} };
    }

    try {
        return parseMCPConfig(parsed);
    } catch (err) {
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
    return Object.values(config.mcpServers)
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name));
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
        throw new MCPConfigError(
            `MCP server "${name}" conflicts with a native Locopilot tool name`,
        );
    }

    const task = async (): Promise<void> => {
        const configPath = getMCPConfigPath();
        const tmpPath = configPath + '.tmp';

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
                throw new MCPConfigError(
                    `MCP config file does not exist at ${configPath}; create it before toggling servers`,
                );
            }
            throw err;
        }

        // Strip a leading UTF-8 BOM (Notepad on Windows writes one) so
        // `JSON.parse` doesn't reject the file. We do NOT write a BOM on
        // the way out (see `writeFile` call below), so the on-disk file
        // stays clean after a save.
        const stripped = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
        let parsed: unknown;
        try {
            parsed = JSON.parse(stripped);
        } catch (err) {
            throw new MCPConfigError(
                `${configPath} is not valid JSON: ${(err as Error).message}`,
            );
        }

        if (!isPlainObject(parsed)) {
            throw new MCPConfigError(`${configPath} root must be a JSON object`);
        }
        // Re-validate the file before mutating it. If the current
        // state would be rejected by `parseMCPConfig` (e.g. a
        // malformed server entry, a `name` field that doesn't match
        // the key, an unknown transport type), the next read would
        // silently drop the whole file's servers — data loss.
        // Force the user to fix their config file before they can
        // toggle servers.
        try {
            parseMCPConfig(parsed);
        } catch (err) {
            throw new MCPConfigError(
                `MCP config is invalid and cannot be edited safely: ${err instanceof Error ? err.message : String(err)}`,
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
            throw new MCPConfigError(
                `MCP server "${name}" is malformed (not a JSON object)`,
            );
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

        // Explicit `'utf8'` encoding — never the platform default — so
        // we never accidentally write a UTF-8 BOM on Windows.
        const json = JSON.stringify(nextRoot, null, 2);
        await fsp.writeFile(tmpPath, json, { encoding: 'utf8' });
        await fsp.rename(tmpPath, configPath);
    };

    // Chain on both success and failure so a single failed save can't
    // poison the queue for the next caller. `.then(task, task)` mirrors
    // the pattern in `services/configManager.ts`.
    saveQueue = saveQueue.then(task, task);
    return saveQueue;
}
