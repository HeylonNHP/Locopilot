#!/usr/bin/env node
/**
 * Resolve the server port, with fallback and next-available logic.
 *
 * 1. Uses $PORT if set, otherwise defaults to 3000.
 * 2. If the preferred port is busy, scans upward for the first free port.
 * 3. Prints the resolved port number to stdout for use in npm scripts.
 *
 * Usage:  node scripts/resolve-port.mjs
 *         node scripts/resolve-port.mjs  (reads $PORT or defaults to 3000)
 */

import { createServer } from 'node:net';

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
      process.stdout.write(String(candidate));
      return;
    }
  }
  console.error(`Could not find a free port after ${MAX_ATTEMPTS} attempts (starting from ${PREFERRED})`);
  process.exit(1);
}

resolvePort();
