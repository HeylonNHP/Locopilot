#!/usr/bin/env node
/**
 * Production server launcher — resolves the port, then starts Next.js.
 *
 * Reads $PORT (default 3000). If the preferred port is busy, scans
 * upward for the first free port. Passes the resolved port to Next.js.
 *
 * Usage:  node scripts/start.mjs
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { dirname, join } = path;

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

/**
 * Load PORT from .env so the wrapper sees it before Next.js starts.
 * Next.js loads .env internally, but by then we've already resolved
 * the port — so we read it ourselves here.
 */
function loadEnvPort() {
  if (process.env.PORT) return;
  const envPath = join(ROOT, '.env');
  if (!existsSync(envPath)) return;
  const lines = readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('PORT=')) {
      const val = trimmed.slice(5).replaceAll(/^["']|["']$/g, '');
      if (val) process.env.PORT = val;
      return;
    }
  }
}

loadEnvPort();
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
  console.error(`Could not find a free port after ${MAX_ATTEMPTS} attempts (starting from ${PREFERRED})`);
  process.exit(1);
}

async function main() {
  const port = await resolvePort();
  console.log(`Starting server on port ${port}...`);

  const next = spawn(
    'node',
    ['node_modules/next/dist/bin/next', 'start', '-p', String(port)],
    {
      cwd: join(__dirname, '..'),
      stdio: 'inherit',
      shell: true,
    }
  );

  next.on('exit', (code) => process.exit(code));
}

try {
  await main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
