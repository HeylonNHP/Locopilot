import { spawnSync } from 'node:child_process';

function runEslintFull(projectDir) {
  const result = spawnSync('npx', ['eslint', '.', '-f', 'json'], {
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

  let totalErrors = 0;
  let totalWarnings = 0;
  let fixableErrors = 0;
  let fixableWarnings = 0;
  const fileLines = [];

  for (const report of reports) {
    let filePath = report?.filePath || '';
    if (projectDir && filePath.startsWith(projectDir)) {
      filePath = filePath.slice(projectDir.length + 1);
    }

    const messages = Array.isArray(report?.messages) ? report.messages : [];
    if (messages.length === 0) continue;

    const fileErrors = messages.filter((m) => m?.severity === 2).length;
    const fileWarnings = messages.filter((m) => m?.severity === 1).length;
    const fileFixable = messages.filter((m) => m?.severity === 2 && m?.fix).length;
    const fileFixableWarnings = messages.filter((m) => m?.severity === 1 && m?.fix).length;

    totalErrors += fileErrors;
    totalWarnings += fileWarnings;
    fixableErrors += fileFixable;
    fixableWarnings += fileFixableWarnings;

    fileLines.push(`  \`${filePath}\` (${fileErrors} error${fileErrors !== 1 ? 's' : ''}, ${fileWarnings} warning${fileWarnings !== 1 ? 's' : ''}):`);

    for (const msg of messages) {
      const line = msg?.line ?? '?';
      const col = msg?.column ?? '?';
      const rule = msg?.ruleId ?? 'unknown';
      const severity = msg?.severity === 2 ? 'error' : 'warning';
      const messageText = String(msg?.message ?? '').split('\n')[0];
      const fixTag = msg?.fix ? ' [auto-fixable]' : '';
      fileLines.push(`    L${line}:${col}  ${severity}  ${rule}  ${messageText}${fixTag}`);
    }
  }

  if (totalErrors === 0 && totalWarnings === 0) return null;

  let summary = `ESLint: ${totalErrors} error${totalErrors !== 1 ? 's' : ''}, ${totalWarnings} warning${totalWarnings !== 1 ? 's' : ''}`;
  if (fixableErrors > 0 || fixableWarnings > 0) {
    summary += ` (${fixableErrors} fixable error${fixableErrors !== 1 ? 's' : ''}, ${fixableWarnings} fixable warning${fixableWarnings !== 1 ? 's' : ''})`;
  }

  return `${summary}\n${fileLines.join('\n')}`;
}

function runTypeCheck(projectDir) {
  const result = spawnSync('npx', ['tsc', '--noEmit'], {
    cwd: projectDir,
    encoding: 'utf8',
  });

  if (result.status === 0) return null;

  const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
  if (!output) return null;

  const errorCount = (output.match(/error TS/g) || []).length;
  const lines = output.split('\n');
  const truncated = lines.length > 30 ? `${lines.slice(0, 30).join('\n')}\n  ... and ${lines.length - 30} more line(s)` : output;

  return `TypeScript (${errorCount} error${errorCount !== 1 ? 's' : ''}):\n${truncated}`;
}

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const sections = [];

const eslintOutput = runEslintFull(projectDir);
if (eslintOutput) sections.push(eslintOutput);

const tscOutput = runTypeCheck(projectDir);
if (tscOutput) sections.push(tscOutput);

if (!sections.length) process.exit(0);

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'Stop',
    additionalContext: `Full project lint and type-check results. Please review and fix the issues below:\n\n${sections.join('\n\n')}`,
  },
}));
