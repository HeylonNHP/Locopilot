import { spawnSync } from 'node:child_process';
import process from 'node:process';

import { readHookInput, resolveCheckoutRoot } from './lib/hookContext.mjs';

// Diff the checkout the session runs in (worktree or main), not whichever
// directory the hook process happened to start in.
const projectDir = resolveCheckoutRoot(readHookInput());

const result = spawnSync('git', ['-C', projectDir, 'diff', '--name-only'], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
});

if (result.status === 0) {
  const changedFiles = (result.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (changedFiles.includes('package.json')) {
    process.stdout.write(
      '⚠ package.json was modified — remember to run `npm install` if dependencies changed.\n'
    );
  }
}
