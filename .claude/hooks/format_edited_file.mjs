import { spawnSync } from 'node:child_process';
import path from 'node:path';

import {
  editedFilePath,
  isInsideRoot,
  readHookInput,
  resolveCheckoutRoot,
} from './lib/hookContext.mjs';

const relevantExtensions = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.css',
  '.scss',
  '.md',
  '.html',
  '.yml',
  '.yaml',
]);

function runPrettier(projectDir, filePath) {
  const result = spawnSync('npx', ['prettier', '--write', filePath], {
    cwd: projectDir,
    encoding: 'utf8',
    stdio: 'ignore',
  });

  return result.status === 0;
}

const input = readHookInput();
const filePath = editedFilePath(input);
// Format in the checkout that owns the edited file; ignore files outside it.
const projectDir = resolveCheckoutRoot(input);

if (
  filePath &&
  isInsideRoot(projectDir, filePath) &&
  relevantExtensions.has(path.extname(filePath))
) {
  runPrettier(projectDir, filePath);
}
