/**
 * Expands `${env.VAR}` references in user-supplied strings (HTTP
 * headers, stdio env values) using the process's actual environment.
 *
 * Rules:
 * - `${env.HOME}` → reads `process.env.HOME`
 * - `$HOME`       → reads `process.env.HOME` (legacy POSIX form)
 * - `$$`          → literal `$` (escape)
 * - Unresolved references resolve to the empty string and emit a
 *   warning (so the user can see why their header is blank in the
 *   server log)
 *
 * Why a custom expander:
 * - Node's `util.format` doesn't expand env vars
 * - The full shell-style expansion (`${VAR:-default}`, `${VAR:+alt}`,
 *   etc.) is overkill and a security risk: it would let a user write
 *   `${PATH:-/tmp}` and override a security-critical env var via the
 *   config file. The minimal `${env.VAR}` form is the only one we
 *   support.
 *
 * The DANGEROUS env-var blocklist is applied here too: `${env.PATH}`
 * is rejected at write time, not at use time, so the user sees a
 * clear error when they save the config, not a confusing connection
 * failure later.
 */

import { isDangerousEnvKey } from './dangerousEnv';

const ENV_REF_PATTERN = /\$\{env\.([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;
const DOLLAR_ESCAPE = '$$';

export interface EnvExpansionResult {
    value: string;
    warnings: string[];
}

/**
 * Expand `${env.X}` / `$X` references in `input` from `process.env`.
 * Returns the expanded string plus any warnings (unresolved refs,
 * skipped dangerous keys).
 */
export function expandEnvRefs(input: string, context: string): EnvExpansionResult {
    if (typeof input !== 'string' || input.length === 0) {
        return { value: input ?? '', warnings: [] };
    }

    const warnings: string[] = [];
    const expanded = input.replace(ENV_REF_PATTERN, (match, braced: string | undefined, bare: string | undefined) => {
        // $$ → literal $
        if (match === DOLLAR_ESCAPE) return '$';
        const name = braced ?? bare ?? '';
        if (isDangerousEnvKey(name)) {
            warnings.push(`${context}: refused to expand dangerous env var "${name}"`);
            return '';
        }
        const value = process.env[name];
        if (value === undefined) {
            warnings.push(`${context}: env var "${name}" is not set`);
            return '';
        }
        return value;
    });

    return { value: expanded, warnings };
}

/**
 * Expand `${env.X}` references in every value of a record. Returns
 * the new record and any warnings aggregated across all entries.
 */
export function expandEnvRefsInRecord(
    record: Record<string, string> | undefined,
    context: string,
): { expanded: Record<string, string> | undefined; warnings: string[] } {
    if (record === undefined) return { expanded: undefined, warnings: [] };
    const expanded: Record<string, string> = {};
    const warnings: string[] = [];
    for (const [key, value] of Object.entries(record)) {
        if (isDangerousEnvKey(key)) {
            warnings.push(`${context}: refusing to use dangerous env key "${key}"`);
            continue;
        }
        const result = expandEnvRefs(value, `${context} header "${key}"`);
        expanded[key] = result.value;
        warnings.push(...result.warnings);
    }
    return { expanded, warnings };
}
