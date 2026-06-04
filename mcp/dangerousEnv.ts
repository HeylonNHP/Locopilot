/**
 * Security blocklist for environment variable names that must never
 * be overridden via `mcp.json`. Used by both the config loader (which
 * writes the user's config file to disk) and the runtime env-expansion
 * helper (which resolves `${env.X}` placeholders in HTTP headers and
 * stdio env values).
 *
 * Lives in its own file (not in `configLoader.ts` or
 * `envExpansion.ts`) so the two can share it without an import cycle.
 */

/**
 * Environment variables that must never be overridden via mcp.json.
 * See B1 in the bug report: PATH / LD_PRELOAD / NODE_OPTIONS / IFS
 * / BASH_FUNC_* can be used by an attacker (or a careless user) to
 * pivot into arbitrary code execution inside the spawned MCP child.
 * The wildcard catch-all for BASH_FUNC_* covers exported bash
 * functions, which bash implements as env vars named
 * `BASH_FUNC_<name>%%`.
 */
export const DANGEROUS_ENV_KEYS: ReadonlySet<string> = new Set([
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

export function isDangerousEnvKey(key: string): boolean {
    if (DANGEROUS_ENV_KEYS.has(key)) return true;
    // bash function exports are exposed as `BASH_FUNC_name%%`. We refuse
    // the whole namespace rather than try to enumerate every name.
    if (key.startsWith('BASH_FUNC_') && key.endsWith('%%')) return true;
    return false;
}
