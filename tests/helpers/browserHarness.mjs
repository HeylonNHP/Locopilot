/**
 * Shared plumbing for the tests that run real code in headless Chromium: bundle
 * an entry point with esbuild (so the REAL modules are exercised, not copies)
 * and serve the result over HTTP (ES modules cannot be loaded over file://).
 */

import esbuild from 'esbuild';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repository root. */
export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Writes the harness entry point and page into `outDir` and bundles the entry
 * into `harness.mjs` next to them.
 *
 * `outDir` has to be inside the repository, because the bundler resolves bare
 * imports (`mermaid`) from there upwards.
 *
 * @param {{ outDir: string, entry: string, html: string }} harness
 */
export async function buildHarness({ outDir, entry, html }) {
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, 'harness.entry.ts'), entry, 'utf8');
  await fs.writeFile(path.join(outDir, 'index.html'), html, 'utf8');

  await esbuild.build({
    entryPoints: [path.join(outDir, 'harness.entry.ts')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    outfile: path.join(outDir, 'harness.mjs'),
    absWorkingDir: repoRoot,
    logLevel: 'warning',
  });
}

/**
 * Serves a directory on an ephemeral port of 127.0.0.1.
 *
 * @param {string} directory - the directory to serve.
 * @returns {Promise<{ server: http.Server, port: number }>} the running server.
 */
export function serveStatic(directory) {
  return new Promise((resolve) => {
    const server = http.createServer(async (request, response) => {
      const urlPath = decodeURIComponent((request.url ?? '/').split('?')[0]);
      const relative = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
      const filePath = path.resolve(directory, relative);

      if (!filePath.startsWith(path.resolve(directory))) {
        response.writeHead(403).end('forbidden');
        return;
      }

      try {
        const body = await fs.readFile(filePath);
        const type = filePath.endsWith('.mjs')
          ? 'text/javascript'
          : filePath.endsWith('.html')
            ? 'text/html'
            : 'application/octet-stream';
        response.writeHead(200, { 'content-type': type });
        response.end(body);
      } catch {
        response.writeHead(404).end('not found');
      }
    });

    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}
