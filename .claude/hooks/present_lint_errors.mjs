import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

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

function runEslintOnFile(projectDir, filePath) {
  const result = spawnSync('npx', ['eslint', '--no-ignore', '-f', 'json', filePath], {
    cwd: projectDir,
    encoding: 'utf8',
  });

  if (result.status !== 0 && result.status !== 1) return null;
  if (!result.stdout?.trim()) return null;

  let reports;
  try {
    reports = JSON.parse(result.stdout);
  } catch {
    return null;
  }

  if (!Array.isArray(reports) || reports.length === 0) return null;

  const report = reports[0];
  const messages = Array.isArray(report?.messages) ? report.messages : [];
  if (messages.length === 0) return null;

  const relPath = projectDir && filePath.startsWith(projectDir)
    ? filePath.slice(projectDir.length + 1)
    : filePath;

  const errors = messages.filter((m) => m?.severity === 2);
  const warnings = messages.filter((m) => m?.severity === 1);
  const fixableErrors = errors.filter((m) => m?.fix).length;
  const fixableWarnings = warnings.filter((m) => m?.fix).length;

  const lines = messages.map((msg) => {
    const line = msg?.line ?? '?';
    const col = msg?.column ?? '?';
    const rule = msg?.ruleId ?? 'unknown';
    const severity = msg?.severity === 2 ? 'error' : 'warning';
    const messageText = String(msg?.message ?? '').split('\n')[0];
    const fixTag = msg?.fix ? ' [auto-fixable]' : '';
    return `  L${line}:${col}  ${severity}  ${rule}  ${messageText}${fixTag}`;
  });

  let summary = `ESLint in \`${relPath}\`: ${errors.length} error${errors.length !== 1 ? 's' : ''}, ${warnings.length} warning${warnings.length !== 1 ? 's' : ''}`;
  if (fixableErrors > 0 || fixableWarnings > 0) {
    summary += ` (${fixableErrors} fixable error${fixableErrors !== 1 ? 's' : ''}, ${fixableWarnings} fixable warning${fixableWarnings !== 1 ? 's' : ''})`;
  }

  return `${summary}\n${lines.join('\n')}`;
}

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const filePath = findEditedFile(readInput());

if (!filePath) process.exit(0);
if (!filePath.endsWith('.ts') && !filePath.endsWith('.tsx') && !filePath.endsWith('.js') && !filePath.endsWith('.jsx') && !filePath.endsWith('.mjs') && !filePath.endsWith('.cjs')) {
  process.exit(0);
}

const outputText = runEslintOnFile(projectDir, filePath);
if (!outputText) process.exit(0);

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PostToolUse',
    additionalContext: `Lint results for the file you just edited. Please review and fix the issues:\n\n${outputText}`,
  },
}));
