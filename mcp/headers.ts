/**
 * Parses curl-style `-H "Key: Value"` header strings into a plain
 * `{key: value}` map. Used by the MCP HTTP/SSE transports so users can
 * paste a `curl` invocation directly into their `~/.locopilot/mcp.json`
 * `headers` field.
 *
 * Rules:
 * - `Key: Value`  →  `{ "Key": "Value" }`
 * - `Key:Value`   →  `{ "Key": "Value" }`  (single space optional)
 * - leading/trailing whitespace is stripped
 * - duplicate keys (case-insensitive) overwrite with a warning
 * - the result is case-preserving (first-seen casing wins for display)
 *   but lookup is case-insensitive at the transport level
 *
 * Used by the MCP HTTP/SSE transports.
 */

export interface ParseCurlHeadersResult {
    headers: Record<string, string>;
    warnings: string[];
}

/**
 * Parse a single `-H "Key: Value"` token (without the `-H` flag itself).
 * Returns null if the token is not a `Key: Value` pair.
 */
export function parseCurlHeader(token: string): { key: string; value: string } | null {
    if (typeof token !== 'string') return null;
    const idx = token.indexOf(':');
    if (idx <= 0) return null; // require at least one char before `:`
    const key = token.slice(0, idx).trim();
    const value = token.slice(idx + 1).trim();
    if (key.length === 0) return null;
    return { key, value };
}

/**
 * Parse an array of `-H "Key: Value"` tokens into a header map.
 * Empty input returns an empty object. Tokens that are not valid
 * `Key: Value` pairs are silently skipped (with a warning). The
 * first-seen casing for a key wins; later duplicates overwrite but
 * produce a warning so the user knows the config is ambiguous.
 */
export function parseCurlHeaders(input: string[] | undefined): ParseCurlHeadersResult {
    const headers: Record<string, string> = {};
    const warnings: string[] = [];
    if (!Array.isArray(input)) return { headers, warnings };

    const seenLower = new Set<string>();
    for (const raw of input) {
        if (typeof raw !== 'string') continue;
        const parsed = parseCurlHeader(raw);
        if (!parsed) {
            // Tolerate a leading "-H " that some users may include in
            // the string entries of the JSON array. Strip it and retry.
            const stripped = raw.replace(/^\s*-H\s+/, '');
            const retry = parseCurlHeader(stripped);
            if (!retry) {
                warnings.push(`Skipping malformed header token: ${JSON.stringify(raw)}`);
                continue;
            }
            applyHeader(headers, seenLower, retry.key, retry.value, warnings);
            continue;
        }
        applyHeader(headers, seenLower, parsed.key, parsed.value, warnings);
    }

    return { headers, warnings };
}

function applyHeader(
    headers: Record<string, string>,
    seenLower: Set<string>,
    key: string,
    value: string,
    warnings: string[],
): void {
    const lower = key.toLowerCase();
    if (seenLower.has(lower)) {
        warnings.push(`Duplicate header "${key}" (overwriting previous value)`);
    }
    seenLower.add(lower);
    headers[key] = value;
}
