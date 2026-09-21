/**
 * Process-tree termination helpers (server-only leaf module).
 *
 * WHY this is its own module: both `@/mcp/clientManager` (stdio MCP servers,
 * fix F6) and `@/tools/impl/runCommandTool` (`run_command`) need to reap a
 * spawned child AND every descendant it created. Keeping the implementation
 * here — importing only `node:child_process` and `node:os` — means neither
 * caller depends on the other, so this file cannot introduce an import cycle
 * with `@/mcp`.
 *
 * WHY a whole tree, not just the child: the SDK's `StdioClientTransport`
 * spawns via `cross-spawn`, which routes any non-`.exe` command (`npx`, `npm`,
 * `.cmd` shims) through `cmd.exe /d /s /c`. The real MCP server (`node`) is
 * therefore a GRANDCHILD of the process we hold a handle to. The SDK's
 * `transport.close()` / `client.close()` kill only the DIRECT child, so that
 * grandchild survives every disconnect / HMR reload / app exit (F6).
 */

import { type ChildProcess, spawnSync } from 'node:child_process';
import os from 'node:os';

const isWindows = os.platform() === 'win32';

/**
 * Direct children of `pid`, via `pgrep -P`.
 *
 * FAIL-CLOSED: any failure (pgrep missing, non-zero exit, unparsable output)
 * yields an empty list, so the caller's walk simply stops rather than
 * guessing — a wrong pid here would mean SIGKILLing an unrelated process.
 */
function listChildPids(pid: number): number[] {
  const result = spawnSync('pgrep', ['-P', String(pid)], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result.error || result.status !== 0 || typeof result.stdout !== 'string') {
    return [];
  }
  return result.stdout
    .split('\n')
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((value) => Number.isInteger(value) && value > 0);
}

/**
 * Kill an entire process tree given only the root pid.
 *
 * Used by `clientManager.teardownHandle` (F6) BEFORE `transport.close()`,
 * because the SDK drops its `_process` handle on close — after that `get pid()`
 * returns null and the parent-pid chain taskkill / pgrep needs is gone.
 *
 * No-ops for a non-integer / non-positive pid and for our OWN pid: a stray
 * `process.kill(process.pid, 'SIGKILL')` would take down the host.
 */
export function killProcessTreeByPid(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return;

  if (isWindows) {
    // taskkill /T walks the whole descendant chain; /F forces termination.
    const result = spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    if (result.error || result.status !== 0) {
      // taskkill can fail when the tree is already gone or is access-restricted.
      // Fall back to a direct kill so the root pid is not leaked.
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already dead */
      }
    }
    return;
  }

  // POSIX: the SDK does NOT spawn the child detached, so it shares OUR process
  // group. A `process.kill(-pid)` group kill would therefore target the wrong
  // group (our own!). Walk the descendants via `pgrep -P` instead and SIGKILL
  // them deepest-first, then the root pid.
  for (const childPid of listChildPids(pid)) {
    killProcessTreeByPid(childPid);
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* already dead */
  }
}

/**
 * Kill a `ChildProcess` and its whole tree.
 *
 * Moved verbatim from `runCommandTool.ts`, which spawns the shell DETACHED on
 * POSIX (`detached: !isWindows`) — so here the negative-pid group kill is
 * correct and `run_command` relies on that group semantics. Keep this variant
 * separate from `killProcessTreeByPid`: the two have opposite group
 * assumptions. (The MCP stdio transport does not spawn detached, hence the
 * pid-only walker above.)
 */
export function killProcessTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) return;

  if (isWindows) {
    const taskkillResult = spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
      stdio: 'ignore',
    });
    if (taskkillResult.error || taskkillResult.status !== 0) {
      // taskkill may fail on some Windows environments or when the process tree
      // is already gone. Fall back to a direct child kill attempt.
      try {
        child.kill('SIGTERM');
      } catch {
        /* already dead */
      }

      try {
        child.kill('SIGKILL');
      } catch {
        /* already dead */
      }
    }
    return;
  }

  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    /* best-effort group termination failed */
  }

  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    /* best-effort group escalation failed */
  }

  try {
    child.kill('SIGKILL');
  } catch {
    /* already dead */
  }
}
