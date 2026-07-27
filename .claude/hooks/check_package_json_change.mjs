import { spawnSync } from 'node:child_process';
import process from 'node:process';

const result = spawnSync('git', ['diff', '--name-only'], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
});

if (result.status === 0) {
  const changedFiles = (result.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (changedFiles.includes('package.json')) {
    process.stdout.write('⚠ package.json was modified — remember to run `npm install` if dependencies changed.\n');
  }
}
