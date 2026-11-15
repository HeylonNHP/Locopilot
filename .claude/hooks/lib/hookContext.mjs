/**
 * Shared context helpers for the Claude Code hooks in this directory.
 *
 * Every hook must act on the checkout the session is working in: the
 * worktree when the session runs inside one, the main checkout otherwise.
 * `CLAUDE_PROJECT_DIR` is deliberately NOT used. It can point at the main
 * checkout even for a worktree session, which makes `eslint .` walk into
 * `.claude/worktrees/*` and report that whole tree with the wrong paths.
 *
 * The checkout root is resolved with `git rev-parse --show-toplevel`,
 * which returns the worktree's own root when run inside a worktree.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

/** Reads and parses the hook's JSON stdin payload. Returns `{}` when absent or invalid. */
export function readHookInput() {
  if (process.stdin.isTTY) return {};
  try {
    const raw = readFileSync(0, 'utf8');
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/** The directory the session is working in, as reported by the hook payload. */
function sessionCwd(input) {
  return typeof input?.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
}

/** The file an Edit/Write tool call touched, resolved to an absolute path. */
export function editedFilePath(input) {
  const raw = input?.tool_input?.file_path || input?.tool_input?.path;
  if (typeof raw !== 'string' || !raw) return null;
  return path.isAbsolute(raw) ? raw : path.resolve(sessionCwd(input), raw);
}

function nearestExistingDir(filePath) {
  let dir = path.dirname(filePath);
  while (!existsSync(dir)) {
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return dir;
}

function gitToplevel(dir) {
  const result = spawnSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result.status !== 0) return null;
  const root = result.stdout.trim();
  return root || null;
}

/**
 * Resolves the root of the checkout a hook should operate on.
 *
 * For file-level hooks the edited file's own checkout wins, so a file is
 * always linted by the checkout that contains it. Otherwise the session's
 * working directory decides. Falls back to the working directory when it is
 * not inside a git repository.
 */
export function resolveCheckoutRoot(input) {
  const candidates = [];
  const editedFile = editedFilePath(input);
  if (editedFile) {
    const dir = nearestExistingDir(editedFile);
    if (dir) candidates.push(dir);
  }
  candidates.push(sessionCwd(input));

  for (const dir of candidates) {
    const root = gitToplevel(dir);
    if (root) return root;
  }
  return sessionCwd(input);
}

/** True when `filePath` lives inside `root`. */
export function isInsideRoot(root, filePath) {
  const rel = path.relative(root, filePath);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}
