import { spawnSync } from 'node:child_process';

const result = spawnSync('git', ['diff', '--name-only'], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
});

if (result.status !== 0) {
  process.exit(0);
}

const changedFiles = (result.stdout || '')
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean);

if (!changedFiles.includes('package.json')) {
  process.exit(0);
}

process.stdout.write('⚠ package.json was modified — remember to run `npm install` if dependencies changed.\n');
