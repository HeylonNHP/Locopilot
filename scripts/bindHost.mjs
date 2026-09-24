#!/usr/bin/env node
/**
 * Bind-host parser for the web server launcher.
 *
 * Reads the optional LOCOPILOT_HOST override (from the process environment or
 * .env) and normalises it into a value suitable for `next start|dev -H`.
 *
 * When the override is unset (the default), callers pass nothing to Next.js so
 * it keeps its own default bind (0.0.0.0 — all interfaces). This module never
 * changes that default; it only validates an explicit override.
 *
 * Usage:  imported by scripts/dev.mjs and scripts/start.mjs
 */

/**
 * Charset is deliberately conservative: IPv4/IPv6 literals and DNS hostnames
 * only — no whitespace and no shell metacharacters, so a value can never be
 * misread as a CLI flag or interpreted by a shell. IPv6 must be UNBRACKETED
 * (use `::1`, not `[::1]`).
 */
const BIND_HOST_PATTERN = /^[\w.:-]+$/;

/**
 * Parse and validate the optional LOCOPILOT_HOST override.
 *
 * Returns the normalised host, or `null` when unset/blank. `null` means
 * "leave Next.js's default bind (0.0.0.0, all interfaces) untouched".
 *
 * Throws for a value that is present but malformed, so the caller can fail
 * fast rather than silently binding more widely than the user intended.
 */
export function parseBindHost(raw) {
  const value = String(raw ?? '')
    .trim()
    .replaceAll(/^["']|["']$/g, '')
    .trim();

  if (!value) return null;

  if (value.startsWith('-') || !BIND_HOST_PATTERN.test(value)) {
    throw new Error(
      `LOCOPILOT_HOST=${JSON.stringify(raw)} is not a valid hostname or IP address. ` +
        'Allowed characters: letters, digits, ".", ":", "-", "_" — and it must not start ' +
        'with "-". Use an unbracketed IPv6 address (e.g. ::1).'
    );
  }

  return value;
}

/**
 * Human-readable description of the effective bind host, for the launcher's
 * startup log. A nullish host means Next.js's own wildcard default.
 */
export function describeBindHost(host) {
  return host ?? '0.0.0.0 / all interfaces';
}
