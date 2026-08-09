#!/usr/bin/env node
/**
 * Config shape validator — rejects legacy single-provider configs.
 *
 * The on-disk config.json must use the modern multi-provider shape:
 * a non-empty `providers` array plus `activeProviderId`. Top-level
 * `provider` / `apiKey` / `baseUrl` belong to the legacy format and
 * are no longer read by the app.
 *
 * Usage:  node scripts/validateConfig.mjs [path/to/config.json]
 *         (defaults to <cwd>/config.json)
 *
 * Exit codes: 0 = OK (or file missing — fresh install), 1 = invalid.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const LEGACY_KEYS = ['provider', 'apiKey', 'baseUrl'];

/**
 * Validate the config file at `configPath`.
 * Prints diagnostics; returns true if startup should proceed, false otherwise.
 */
export function validateConfig(configPath = path.join(process.cwd(), 'config.json')) {
  // Fresh install: no config file yet is fine — defaults apply.
  if (!existsSync(configPath)) return true;

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (err) {
    console.error(`✗ ${configPath} is not valid JSON: ${err.message}`);
    return false;
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.error(`✗ ${configPath} must contain a JSON object.`);
    return false;
  }

  const legacyKeys = LEGACY_KEYS.filter((key) => key in parsed);
  const hasProviders = Array.isArray(parsed.providers) && parsed.providers.length > 0;

  if (legacyKeys.length > 0 || !hasProviders) {
    console.error(`✗ ${configPath} is in the legacy single-provider format.`);
    if (legacyKeys.length > 0) {
      console.error(`  Legacy top-level key(s) found: ${legacyKeys.join(', ')}`);
    }
    if (!hasProviders) {
      console.error('  Missing required non-empty top-level "providers" array.');
    }
    console.error('  Migrate to the providers-array format, e.g.:');
    console.error(
      [
        '  {',
        '    "providers": [',
        '      {',
        '        "id": "my-provider",',
        '        "name": "My Provider",',
        '        "provider": "openai-compatible",',
        '        "baseUrl": "https://example.com",',
        '        "apiKey": "...",',
        '        "model": "gpt-4o"',
        '      }',
        '    ],',
        '    "activeProviderId": "my-provider"',
        '  }',
      ].join('\n')
    );
    return false;
  }

  return true;
}

// Run as a script when invoked directly (node scripts/validateConfig.mjs [path]).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const configPath = process.argv[2] ?? path.join(process.cwd(), 'config.json');
  process.exit(validateConfig(configPath) ? 0 : 1);
}
