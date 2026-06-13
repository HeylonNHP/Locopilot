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
 *
 * Each entry is a code-injection or RCE vector when an attacker (or
 * a careless user editing `~/.locopilot/mcp.json`) can set it on a
 * spawned MCP child process. The list is non-exhaustive by design
 * — if you find a new vector, add it here.
 *
 * The list is consulted in two places:
 *  1. `mcp/configLoader.ts` rejects stdio `env` blocks that contain
 *     these keys at parse time.
 *  2. `mcp/envExpansion.ts` refuses to expand these keys when
 *     resolving `${env.X}` placeholders.
 *
 * The blocklist is intentionally strict: when in doubt, refuse the
 * key. A user can always rename a key in their config (e.g.
 * `MY_SERVER_PATH`) and reference it indirectly.
 */
export const DANGEROUS_ENV_KEYS: ReadonlySet<string> = new Set([
    // General: shell/library injection vectors
    'PATH',
    'LD_PRELOAD',
    'LD_LIBRARY_PATH',
    'DYLD_INSERT_LIBRARIES',
    'DYLD_LIBRARY_PATH',
    'NODE_OPTIONS',
    'NODE_PATH',
    'IFS',
    'SHELLOPTS',
    'BASH_ENV',
    'ENV',
    'BASH_XTRACEFD', // hijack file descriptor used for xtrace output
    'GLOBIGNORE', // can hide injected files from shell globbing

    // Python: arbitrary code execution at interpreter startup
    'PYTHONPATH',
    'PYTHONSTARTUP', // Python reads and EXECUTES this file at startup
    'PYTHONINSPECT',

    // Java / JVM: -javaagent / -cp / arbitrary -D args at startup
    'JAVA_TOOL_OPTIONS', // JVM reads this on every java invocation
    '_JAVA_OPTIONS',     // same, but the underscored form takes precedence
    'JVM_TOOL_OPTIONS',  // HotSpot-specific
    'CLASSPATH',         // classpath hijack for any `java -cp ...` MCP server

    // Ruby: -r flag enables arbitrary `require`
    'RUBYOPT',
    'RUBYLIB',

    // Perl: -e / -d flags enable arbitrary code
    'PERL5OPT',
    'PERLLIB',
    'PERL5LIB',
]);

export function isDangerousEnvKey(key: string): boolean {
    if (DANGEROUS_ENV_KEYS.has(key)) return true;
    // bash function exports are exposed as `BASH_FUNC_name%%`. We refuse
    // the whole namespace rather than try to enumerate every name.
    if (key.startsWith('BASH_FUNC_') && key.endsWith('%%')) return true;
    return false;
}
