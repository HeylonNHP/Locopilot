/* global console */
import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

const source = path.resolve(projectRoot, 'node_modules/@dqbd/tiktoken/tiktoken_bg.wasm');
const destDir = path.resolve(projectRoot, 'public/wasm');
const destination = path.resolve(destDir, 'tiktoken_bg.wasm');

try {
  mkdirSync(destDir, { recursive: true });
  copyFileSync(source, destination);
  // eslint-disable-next-line no-console
  console.log(`Copied tiktoken_bg.wasm to ${destination}`);
} catch (err) {
  throw new Error(
    `Failed to copy tiktoken_bg.wasm: ${err instanceof Error ? err.message : String(err)}`
  );
}
