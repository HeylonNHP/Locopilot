import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const relevantExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.css', '.scss', '.md', '.html', '.yml', '.yaml']);

function readInput() {
  return process.stdin.isTTY ? '' : readFileSync(0, 'utf8');
}

function findEditedFile(inputData) {
  if (!inputData.trim()) return null;

  try {
    const context = JSON.parse(inputData);
    return context?.tool_input?.file_path || context?.tool_input?.path || null;
  } catch {
    return null;
  }
}

function runPrettier(projectDir, filePath) {
  const result = spawnSync('npx', ['prettier', '--write', filePath], {
    cwd: projectDir,
    encoding: 'utf8',
    stdio: 'ignore',
  });

  return result.status === 0;
}

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const filePath = findEditedFile(readInput());

if (filePath && relevantExtensions.has(filePath.slice(filePath.lastIndexOf('.')))) {
  runPrettier(projectDir, filePath);
}
