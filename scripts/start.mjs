#!/usr/bin/env node
/**
 * Production server launcher — resolves the port, then starts Next.js.
 *
 * Reads $PORT (default 3000) and the optional $LOCOPILOT_HOST bind host.
 * If the preferred port is busy, scans upward for the first free port.
 * Passes the resolved port (and host, when set) to Next.js.
 *
 * Usage:  node scripts/start.mjs
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describeBindHost, parseBindHost } from './bindHost.mjs';

const { dirname, join } = path;

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

/**
 * Load a single KEY=value line from .env so the wrapper sees it before
 * Next.js starts. Next.js loads .env internally, but by then we've already
 * resolved the port and bind host — so we read them ourselves here.
 *
 * A real process.env value wins. The check is per key, so setting PORT in the
 * environment does not stop LOCOPILOT_HOST from being read from .env.
 */
function loadEnvVar(key) {
  if (process.env[key]) return;
  const envPath = join(ROOT, '.env');
  if (!existsSync(envPath)) return;
  const prefix = `${key}=`;
  const lines = readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith(prefix)) {
      const val = trimmed.slice(prefix.length).replaceAll(/^["']|["']$/g, '');
      if (val) process.env[key] = val;
      return;
    }
  }
}

loadEnvVar('PORT');
loadEnvVar('LOCOPILOT_HOST');
const PREFERRED = Number(process.env.PORT) || 3000;
const MAX_ATTEMPTS = 100;

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close();
      resolve(true);
    });
    server.listen(port, '127.0.0.1');
  });
}

async function resolvePort() {
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const candidate = PREFERRED + i;
    if (await isPortAvailable(candidate)) {
      return candidate;
    }
  }
  console.error(
    `Could not find a free port after ${MAX_ATTEMPTS} attempts (starting from ${PREFERRED})`
  );
  process.exit(1);
}

/**
 * Resolve the optional LOCOPILOT_HOST override. Returns the host, or null to
 * keep Next.js's default bind (0.0.0.0, all interfaces). Fails fast on a
 * malformed value rather than silently binding wider than intended.
 */
function resolveBindHost() {
  try {
    return parseBindHost(process.env.LOCOPILOT_HOST);
  } catch (err) {
    console.error(`✗ ${err.message}`);
    process.exit(1);
  }
}

async function main() {
  // Validate config.json first (rejects legacy single-provider shape)
  const { validateConfig } = await import(pathToFileURL(join(__dirname, 'validateConfig.mjs')));
  if (!validateConfig(join(ROOT, 'config.json'))) {
    process.exit(1);
  }

  const port = await resolvePort();
  const host = resolveBindHost();
  console.log(`Starting server on port ${port} (bind host: ${describeBindHost(host)})...`);

  const nextArgs = ['node_modules/next/dist/bin/next', 'start', '-p', String(port)];
  if (host) nextArgs.push('-H', host);
  const next = spawn('node', nextArgs, {
    cwd: join(__dirname, '..'),
    stdio: 'inherit',
    shell: true,
  });

  next.on('exit', (code) => process.exit(code));
}

try {
  await main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
