import { AsyncLocalStorage } from 'node:async_hooks';
import { type ChildProcess, spawn } from 'node:child_process';
import os from 'node:os';

import type { ToolSchema } from '@/tools/toolSchema';

import {
  PROCESS_REGISTRY_TTL_MS,
  RUN_COMMAND_HEAD_PREVIEW_BYTES,
  RUN_COMMAND_INLINE_MAX_BYTES,
  RUN_COMMAND_MAX_SPOOL_BYTES,
  RUN_COMMAND_OUTPUT_MAX_BYTES,
  RUN_COMMAND_TAIL_PREVIEW_BYTES,
  RUN_COMMAND_TIMEOUT_MS,
  RUN_OUTPUT_SWEEP_INTERVAL_MS,
} from '@/constants';
import { isRunOutputSpillEnabled, OutputSpool, type SpoolLimits } from '@/tools/outputSpool';
import { killProcessTree } from '@/tools/processTree';
import {
  cleanupStaleOutputs,
  describeOutputFile,
  type OutputScope,
  runOutputDirectory,
} from '@/tools/runCommandOutputStore';
import { noopToolOutputSink, type ToolOutputSink } from '@/tools/toolOutput';
import {
  getAgentWorkingDirectory,
  resolveAgentPath,
  setAgentWorkingDirectory,
  type WorkingDirectoryScope,
} from '@/tools/workingDirectory';

const isWindows = os.platform() === 'win32';

const APPROVAL_SENTENCE = 'The user will be asked to approve the command before it runs.';

/**
 * Bounds of the capture that backs a `run_command` result. The inline budget
 * is what the model reads verbatim; the head and tail budgets are the preview
 * that stands in for the omitted middle, which always stays on disk.
 */
const SPOOL_LIMITS: SpoolLimits = {
  inlineMaxBytes: RUN_COMMAND_INLINE_MAX_BYTES,
  headMaxBytes: RUN_COMMAND_HEAD_PREVIEW_BYTES,
  tailMaxBytes: RUN_COMMAND_TAIL_PREVIEW_BYTES,
  maxSpoolBytes: RUN_COMMAND_MAX_SPOOL_BYTES,
};

export const runCommandToolSchema: ToolSchema = {
  name: 'run_command',
  description: `Executes a terminal command in the specified shell on the host machine. ${APPROVAL_SENTENCE} Returns the captured stdout/stderr. A large output is kept in a file: the result shows an excerpt of it and the line range to read with read_file(path, start_line, end_line).`,
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to execute.' },
      shell: {
        type: 'string',
        description: `Shell to use. Defaults to '${defaultShell()}'. Supported values: bash, sh, zsh, powershell, cmd.`,
      },
      timeout_seconds: {
        type: 'number',
        description: 'How many seconds to wait before returning partial output. Defaults to 30.',
      },
      cwd: {
        type: 'string',
        description:
          'Optional working directory for the command. If omitted, Locopilot defaults to the current agent working directory, which starts at the user home directory (Linux HOME or Windows USERPROFILE).',
      },
    },
    required: ['command'],
  },
};

export const checkProcessOutputToolSchema: ToolSchema = {
  name: 'check_process_output',
  description:
    'Returns the current captured stdout/stderr of a command that was previously started with run_command and is still running (or has since completed). Also reports whether the process has finished and its exit code.',
  parameters: {
    type: 'object',
    properties: {
      process_id: { type: 'number', description: 'The process_id returned by run_command.' },
      poll_interval_seconds: {
        type: 'number',
        description:
          'Optional seconds to wait before sampling stdout/stderr again. Use a higher value when the command is expected to run for a long time.',
      },
    },
    required: ['process_id'],
  },
};

interface RequestProcessState {
  registry: Map<number, ProcessEntry>;
  nextId: number;
}

const requestProcessState = new AsyncLocalStorage<RequestProcessState>();

interface ProcessEntry {
  process: ChildProcess;
  command: string;
  shell: string;
  stdout: OutputSpool;
  stderr: OutputSpool;
  startedAt: Date;
  done: boolean;
  exitCode: number | null;
  spillEnabled: boolean;
  /** True when the command was interrupted instead of finishing on its own. */
  aborted: boolean;
  ttlTimer?: ReturnType<typeof setTimeout>;
}

/**
 * Timestamp of the last sweep of the artifact store.
 *
 * WHY a timestamp and not a flag: the sweep is housekeeping, not part of
 * the command. A burst of commands must not turn into a burst of directory
 * walks, but a long-lived process must still sweep again eventually — so
 * the guard is a clock, not a boolean.
 */
let lastStoreSweepAt = 0;

/**
 * Sweeps the artifact store when it is due. Never throws: a store that
 * cannot be swept is a housekeeping problem, not a command failure.
 */
function sweepOutputStore(): void {
  const now = Date.now();
  if (now - lastStoreSweepAt < RUN_OUTPUT_SWEEP_INTERVAL_MS) return;
  lastStoreSweepAt = now;
  cleanupStaleOutputs(now);
}

/**
 * Returns the per-request process registry and id counter, throwing
 * if the caller has not entered the request scope. Concurrent
 * `run_command` calls from different sessions each carry their own
 * per-request Map and id counter, so cross-session contention cannot
 * happen.
 */
function getRequestState(): RequestProcessState {
  const store = requestProcessState.getStore();
  if (!store) {
    throw new Error(
      'runCommand / checkProcessOutput called outside of an HTTP request scope. ' +
        'Call enterRequestScope() at the top of every request that uses these tools.'
    );
  }
  return store;
}

/**
 * Call at the start of each HTTP request to create an isolated process registry.
 */
export function enterRequestScope(): void {
  requestProcessState.enterWith({ registry: new Map(), nextId: 1 });
}

export const DEFAULT_TIMEOUT_MS = RUN_COMMAND_TIMEOUT_MS;

export function defaultShell(): string {
  // Always use powershell on Windows regardless of which shell launched Node,
  // so the LLM inherits the right default even when started from cmd or bash.
  if (isWindows) return 'powershell';
  // On other platforms prefer the user's $SHELL, falling back to bash.
  const loginShell = os.userInfo().shell;
  return loginShell ? (loginShell.split('/').pop() ?? 'bash') : 'bash';
}

/**
 * Determines the effective shell to use, accounting for platform-specific overrides.
 */
function getEffectiveShell(
  requestedShell?: string,
  output: ToolOutputSink = noopToolOutputSink
): string {
  const shell = (requestedShell || defaultShell()).toLowerCase();
  if (isWindows) {
    // If the model requested a POSIX-style shell on Windows, override to
    // powershell and warn so the model understands the environment.
    const posixShells = new Set(['bash', 'sh', 'zsh', 'ksh', 'fish']);
    if (posixShells.has(shell) && shell !== 'powershell') {
      output.writeLine(
        `Warning: requested shell '${shell}' is not native on Windows; using 'powershell' instead.`
      );
      return 'powershell';
    }
  }
  return shell;
}

/**
 * Returns spawning configuration (binary and stdin flags) for a given shell.
 */
function getShellConfig(shell: string): { bin: string; args: string[] } {
  if (shell === 'powershell') {
    return { bin: 'powershell', args: ['-NoProfile', '-NonInteractive', '-Command', '-'] };
  }

  // cmd.exe needs explicit flags for predictable stdin-driven script execution.
  // /D disables AutoRun; /Q turns echo off for cleaner output.
  if (shell === 'cmd' || shell === 'cmd.exe') {
    return { bin: 'cmd.exe', args: ['/D', '/Q'] };
  }

  // bash, sh, zsh, fish, etc. can read commands directly from stdin.
  return { bin: shell, args: [] };
}

function appendWorkingDirectoryProbe(
  command: string,
  shell: string,
  workdirMarker: string
): string {
  if (shell === 'cmd' || shell === 'cmd.exe') {
    // cmd.exe: run the probe, then branch on the runtime errorlevel so the
    // final exit code reflects whether the *command* failed (0 vs non-zero).
    // `echo` does not modify errorlevel, so the `if errorlevel` check below
    // still sees the command's status. The exact code is collapsed to 1 for
    // any failure, which is sufficient because the caller only cares whether
    // the exit code is 0.
    return [
      `${command}`,
      `echo ${workdirMarker}%CD%`,
      'if errorlevel 1 exit /b 1',
      'exit /b 0',
    ].join('\n');
  }

  if (shell === 'powershell') {
    // powershell: capture $LASTEXITCODE immediately after the command, then
    // print the probe and exit with the command's real status. Fall back to 0
    // when the command was not a native app (no exit code is meaningful then).
    return [
      `${command}`,
      'Write-Output "' + `${workdirMarker}` + '$PWD"',
      '$__lc_exit = $LASTEXITCODE',
      'if ($null -eq $__lc_exit) { $__lc_exit = 0 }',
      'exit $__lc_exit',
    ].join('\n');
  }

  // POSIX shells (bash/sh/zsh/fish): run the command, capture its exit
  // status, print the probe, then exit with the command's real status.
  //
  // The old `; printf ...` form made the probe the last statement, so the
  // shell's exit status was always the probe's (0) — every command looked
  // successful. Using a newline (rather than `;`) also avoids a bash syntax
  // error when the command itself ends in `&`.
  return `${command}\n__lc_exit=$?\nprintf '%s\n' "${workdirMarker}$PWD"\nexit $__lc_exit`;
}

/**
 * Describes one captured stream: how big the FULL stream was, where the
 * artifact that holds it lives, and — when the excerpt is lossy — which
 * lines of the artifact the excerpt left out.
 *
 * The counts come from the artifact on disk, not from the in-memory
 * capture, so they describe the file the model is about to open.
 */
function describeStream(label: string, spool: OutputSpool, spillEnabled: boolean): string[] {
  const stats = spool.stats();
  if (spillEnabled && stats.spoolPath && stats.totalBytes > 0) {
    const artifact = describeOutputFile(stats.spoolPath);
    if (artifact.bytes === 0) {
      // The artifact is missing or empty. A path the model cannot open is
      // worse than no path at all, so the marker says that the file is not
      // available instead of pointing at a file that is not there — and it
      // never prints a line range that `read_file` would reject.
      return [
        `${label}: [${stats.totalBytes} bytes were captured but the output file is not available]`,
      ];
    }
    const lines = [
      `${label}: [${artifact.bytes} bytes, ${artifact.lines} lines] redacted output: ${stats.spoolPath}`,
    ];
    if (stats.truncated) {
      // The range the excerpt left out, in the line numbering of the file.
      // The counts are clamped to the file: the artifact can be shorter than
      // the stream when the spool cap stopped the write.
      const first = Math.min(stats.headEndLine + 1, artifact.lines);
      const last = Math.min(stats.tailStartLine - 1, artifact.lines);
      if (first <= last) {
        lines.push(
          `${label}: [the excerpt above is lossy — ${stats.omittedBytes} bytes are not shown; ` +
            `read lines ${first}-${last} with read_file(path="${stats.spoolPath}", ` +
            `start_line=${first}, end_line=${last})]`
        );
      } else {
        lines.push(
          `${label}: [the excerpt above is lossy — ${stats.omittedBytes} bytes are not shown; ` +
            `they are in the file]`
        );
      }
      if (stats.headLineTruncated) {
        lines.push(
          `${label}: [the first line of the excerpt is cut short — the file holds it whole]`
        );
      }
    } else {
      lines.push(`${label}: [the excerpt above is the whole output]`);
    }
    if (stats.spoolTruncated) {
      lines.push(
        `${label}: [the artifact stopped at the spool cap, so it holds less than the ` +
          `${stats.totalBytes} bytes the stream produced]`
      );
    }
    return lines;
  }
  if (stats.truncated) {
    return [`${label}: [output truncated after ${RUN_COMMAND_OUTPUT_MAX_BYTES} UTF-8 bytes]`];
  }
  return [];
}

function buildOutput(entry: ProcessEntry, finished: boolean, processId: number | null): string {
  const parts: string[] = [];
  // The capture redacts the secrets and strips the terminal control
  // sequences on the way in, so the text the model sees is the text that is
  // on the disk — the preview is a view of the artifact, not a second
  // rendering of the stream.
  const stdout = entry.stdout.text();
  const stderr = entry.stderr.text();
  const elapsedMs = Math.max(0, Date.now() - entry.startedAt.getTime());
  const elapsedSeconds = (elapsedMs / 1000).toFixed(2);

  if (stdout) parts.push(`stdout:\n${stdout}`);
  const stdoutMarker = describeStream('stdout', entry.stdout, entry.spillEnabled);
  parts.push(...stdoutMarker);
  if (stderr) parts.push(`stderr:\n${stderr}`);
  const stderrMarker = describeStream('stderr', entry.stderr, entry.spillEnabled);
  parts.push(...stderrMarker);
  if (parts.length === 0) parts.push('(no output)');

  // A failed command and a truncated capture look alike to a reader who
  // only sees the output. The exit code is the command's own verdict; the
  // artifact is where the missing bytes are. Say so once, explicitly.
  if (stdoutMarker.length > 0 || stderrMarker.length > 0) {
    parts.push(
      "note: the exit code below is the command's own status and is independent of how much " +
        'output was captured — a non-zero exit code means the command failed, not that the ' +
        'output was truncated.'
    );
  }

  if (finished) {
    parts.push(`elapsed_seconds: ${elapsedSeconds}`);
    if (entry.aborted) {
      parts.push(
        'status: aborted (the command was interrupted before it finished; the output above is ' +
          'what it produced before it was killed)',
        'exit_code: unknown (the command was aborted, so it never reported one)'
      );
    } else {
      const code = entry.exitCode ?? 'unknown';
      if (code === 0) {
        parts.push(`exit_code: ${code}`);
      } else {
        parts.push(
          `exit_code: ${code} (COMMAND FAILED — review stderr above and try a corrected command; ` +
            `do not repeat the same command unchanged)`
        );
      }
    }
  } else {
    parts.push(
      `elapsed_seconds: ${elapsedSeconds}`,
      `status: still running (process_id=${processId})`
    );
    if (entry.spillEnabled) {
      parts.push(
        'The output above is a partial snapshot — the command is still running and the artifact keeps growing.'
      );
    }
    parts.push(
      'Use check_process_output(process_id, poll_interval_seconds?) to get updated output.'
    );
  }
  return parts.join('\n');
}

export async function runCommand(
  command: string,
  shell?: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  onProgress?: (message: string) => void,
  cwd?: string,
  output: ToolOutputSink = noopToolOutputSink,
  scope?: WorkingDirectoryScope,
  yoloMode: boolean = false,
  signal?: AbortSignal,
  sessionId?: number
): Promise<string> {
  const effectiveShell = getEffectiveShell(shell, output);
  const approvedYolo = yoloMode;
  const trimmedCwd = cwd?.trim();
  const workingDirectory = trimmedCwd
    ? resolveAgentPath(scope, trimmedCwd)
    : getAgentWorkingDirectory(scope);

  const workdirNonce = crypto.randomUUID
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
  const workdirMarker = `__LOCOPILOT_WORKDIR_${workdirNonce}__:`;

  const commandToExecute = appendWorkingDirectoryProbe(command, effectiveShell, workdirMarker);

  // Show the user what the AI wants to run
  output.writeLine(`\n─── ${approvedYolo ? 'Executing' : 'Requesting'} Terminal Command ───`);
  output.writeLine(`  Shell:   ${effectiveShell}`);
  output.writeLine(`  Command: ${command}\n`);

  const store = getRequestState();
  const processId = store.nextId++;
  output.writeLine(`  Running (id=${processId})...\n`);

  // The spill is on by default: without a spool file there is nowhere to
  // recover the omitted bytes from, so the bounded capture would throw
  // data away. `LOCOPILOT_RUN_OUTPUT_SPILL=0` brings the old bounded
  // capture back, byte for byte.
  const spillEnabled = isRunOutputSpillEnabled();
  if (spillEnabled) sweepOutputStore();

  // The artifact lives in the store's directory, under a directory that
  // belongs to this session and this run only: the session's artifacts can
  // be removed with the session, and two runs can never collide.
  const runId = `run-${processId}-${workdirNonce}`;
  const outputScope: OutputScope = { sessionId, runId };
  const artifactDirectory = runOutputDirectory(outputScope);

  const entry: ProcessEntry = {
    process: null as unknown as ChildProcess, // assigned immediately below
    command,
    shell: effectiveShell,
    stdout: new OutputSpool({
      limits: SPOOL_LIMITS,
      directory: artifactDirectory,
      name: `${runId}-stdout.log`,
      enabled: spillEnabled,
    }),
    stderr: new OutputSpool({
      limits: SPOOL_LIMITS,
      directory: artifactDirectory,
      name: `${runId}-stderr.log`,
      enabled: spillEnabled,
    }),
    startedAt: new Date(),
    done: false,
    exitCode: null,
    spillEnabled,
    aborted: false,
  };
  store.registry.set(processId, entry);

  const config = getShellConfig(effectiveShell);

  // The abort handler has to be registered BEFORE the spawn. `spawn` installs
  // Node's own abort listener, and that listener emits the child's 'error'
  // event SYNCHRONOUSLY: our 'error' handler finalizes the command, and
  // finalizing removes this handler — a listener removed while the 'abort'
  // event is being dispatched never runs. A handler registered after the
  // spawn would therefore never fire and the process group would survive
  // the abort, leaving the command's children running with the stdout pipe
  // still open.
  let spawned: ChildProcess | null = null;
  const abortHandler = (): void => {
    entry.aborted = true;
    // The whole process GROUP has to die. The child is spawned detached on
    // POSIX, so its pid is the process-group leader and the negative-pid
    // group kill inside `killProcessTree` reaches every descendant. A
    // plain `child.kill()` would leave the command's own children
    // running, holding the pipe open and writing into the artifact after
    // the tool has already answered.
    if (spawned) killProcessTree(spawned);
  };
  if (signal) {
    signal.addEventListener('abort', abortHandler, { once: true });
  }

  const child = spawn(config.bin, config.args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: !isWindows,
    cwd: workingDirectory,
    signal,
  });
  spawned = child;
  entry.process = child;

  if (signal?.aborted) {
    // The signal was already aborted when the command started, so the
    // 'abort' event has fired and the handler above will never run.
    abortHandler();
  }

  child.stdout?.on('data', (chunk: Buffer) => {
    entry.stdout.append(chunk);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    entry.stderr.append(chunk);
  });
  child.stdout?.on('data', () => {
    onProgress?.('run_command: receiving stdout...');
  });
  child.stderr?.on('data', () => {
    onProgress?.('run_command: receiving stderr...');
  });

  return new Promise<string>((resolve) => {
    let settled = false;
    let returnedPartial = false;

    const finalize = (code: number, result?: string) => {
      if (settled) return;
      settled = true;

      if (abortHandler && signal) {
        signal.removeEventListener('abort', abortHandler);
      }
      clearTimeout(timer);
      if (entry.ttlTimer) clearTimeout(entry.ttlTimer);
      entry.done = true;
      entry.exitCode = code;
      if (!returnedPartial) {
        // The entry's owning registry is the one that was created in
        // the request scope when the command was spawned. The store
        // must still be live here because no async hop has happened
        // since then. If it isn't, something has torn down the
        // request scope early — fall through (the process has exited
        // and the entry is no longer useful to any other consumer).
        const currentStore = requestProcessState.getStore();
        currentStore?.registry.delete(processId);
      }
      // The artifact has to be complete on disk before the model is pointed
      // at it, and the counts in the marker are read FROM the artifact — so
      // the capture is finished BEFORE the output is built. The file handles
      // have to be closed exactly once; both calls are idempotent, so a
      // finalizer that runs twice (the abort path and the close path can
      // both fire) is harmless.
      entry.stdout.finish();
      entry.stderr.finish();
      entry.stdout.dispose();
      entry.stderr.dispose();
      const finalOutput = result || buildOutput(entry, true, null);
      resolve(finalOutput);
    };

    const timer = setTimeout(() => {
      if (settled) return;
      // Still running after timeout – return partial output so the LLM can check back
      onProgress?.('run_command: still running, returning partial output...');
      returnedPartial = true;

      // The snapshot the model is about to see has to include the bytes
      // that arrived without a trailing newline, and the artifact has to
      // hold every byte the command produced so far.
      entry.stdout.flush();
      entry.stderr.flush();

      // TTL cleanup: if the LLM never polls the process again, forcibly kill
      // it and remove the registry entry after 5 minutes to prevent leaks.
      // Capture the request store here so the timer callback doesn't have
      // to re-enter AsyncLocalStorage (the request scope may already be
      // gone by the time the timer fires).
      const owningStore = store;
      entry.ttlTimer = setTimeout(() => {
        killProcessTree(child);
        owningStore.registry.delete(processId);
        // The process is dead now, so the artifacts can be closed for good.
        entry.stdout.finish();
        entry.stderr.finish();
        entry.stdout.dispose();
        entry.stderr.dispose();
      }, PROCESS_REGISTRY_TTL_MS);

      // We don't unregister interrupt handler here because the process
      // is still running and the user might still want to interrupt it
      // while we are waiting for the next LLM turn.
      // However, buildOutput needs to know it's not "finished" in the exit sense.
      resolve(buildOutput(entry, false, processId));
    }, timeoutMs);

    child.on('close', (code) => {
      if (signal?.aborted) entry.aborted = true;
      entry.stdout.finish();
      entry.stderr.finish();
      const exitCode = code ?? 0;
      // The probe is emitted last, so the bounded collector's tail retains it.
      const stdoutLines = entry.stdout.text().split(/\r?\n/);
      let markerLineIndex = -1;
      let detectedWorkingDirectory: string | null = null;

      for (const [index, stdoutLine] of stdoutLines.entries()) {
        const line = stdoutLine ?? '';
        if (!line.startsWith(workdirMarker)) {
          continue;
        }

        const candidate = line.slice(workdirMarker.length).trim();
        if (candidate.length > 0) {
          detectedWorkingDirectory = candidate;
          markerLineIndex = index;
        }
      }

      if (detectedWorkingDirectory) {
        stdoutLines.splice(markerLineIndex, 1);
        entry.stdout.replaceText(stdoutLines.join('\n').trimEnd());
        setAgentWorkingDirectory(scope, detectedWorkingDirectory);
      }

      output.writeLine(`\n  Process ${processId} exited with code ${code}.\n`);
      onProgress?.('run_command: completed.');
      finalize(exitCode);
    });

    child.on('error', (err) => {
      if (signal?.aborted || (err instanceof Error && err.name === 'AbortError')) {
        // The command was interrupted, not broken: the artifact still holds
        // everything it produced before it was killed, and the exit code is
        // not the command's verdict.
        entry.aborted = true;
        // The group is killed here as well as in the abort handler, because
        // the two run in an order nobody controls: Node's own abort
        // listener emits this 'error' event synchronously, and the abort
        // handler may never be reached at all. Killing twice is harmless.
        killProcessTree(child);
        onProgress?.('run_command: aborted.');
        finalize(-1);
        return;
      }
      entry.stderr.append(Buffer.from(`\nSpawn error: ${err.message}`));
      onProgress?.('run_command: spawn error.');
      finalize(-1);
    });

    if (!child.stdin) {
      entry.stderr.append(Buffer.from('\nSpawn error: shell stdin is not available.'));
      onProgress?.('run_command: stdin unavailable.');
      finalize(-1);
      return;
    }

    child.stdin.on('error', (err) => {
      entry.stderr.append(Buffer.from(`\nstdin error: ${err.message}`));
      onProgress?.('run_command: stdin error.');
      finalize(-1);
    });

    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    try {
      child.stdin.write(`${commandToExecute}\n`);
      child.stdin.end();
    } catch (err: unknown) {
      entry.stderr.append(
        Buffer.from(`\nstdin write error: ${err instanceof Error ? err.message : String(err)}`)
      );
      onProgress?.('run_command: stdin write failure.');
      finalize(-1);
    }
  });
}

function waitForProcessSnapshot(
  entry: ProcessEntry,
  waitMs: number,
  signal?: AbortSignal
): Promise<void> {
  if (waitMs <= 0 || entry.done) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve) => {
    const child = entry.process;
    let settled = false;

    const cleanup = () => {
      if (child) {
        child.off('close', handleClose);
      }
      clearTimeout(timer);
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };

    const handleClose = () => {
      finish();
    };

    const timer = setTimeout(() => {
      finish();
    }, waitMs);

    child?.once('close', handleClose);

    if (signal) {
      signal.addEventListener('abort', finish, { once: true });
    }

    if (entry.done) {
      finish();
    }
  });
}

export async function checkProcessOutput(
  processId: number,
  waitMs: number = 0,
  onProgress?: (message: string) => void,
  signal?: AbortSignal
): Promise<string> {
  const store = getRequestState();
  const entry = store.registry.get(processId);
  if (!entry) {
    return `[No process found with process_id=${processId}]`;
  }

  if (!entry.done && waitMs > 0) {
    onProgress?.(`check_process_output: waiting ${Math.round(waitMs / 1000)}s before sampling...`);
    await waitForProcessSnapshot(entry, waitMs, signal);
  }

  if (entry.done) {
    const output = buildOutput(entry, true, null);
    if (entry.ttlTimer) clearTimeout(entry.ttlTimer);
    store.registry.delete(processId);
    entry.stdout.dispose();
    entry.stderr.dispose();
    return output;
  }

  onProgress?.('check_process_output: returning partial output.');
  return buildOutput(entry, false, processId);
}

/**
 * Returns the run_command and check_process_output tool section for the system prompt.
 */
export function getToolPrompt(isYolo: boolean): string {
  const cmdLine = `1. ${runCommandToolSchema.name}(command, shell?, timeout_seconds?, cwd?)`;
  const cmdDesc = runCommandToolSchema.description.replace(
    APPROVAL_SENTENCE,
    isYolo
      ? 'The command will run automatically with user consent.'
      : 'The user will be asked to approve it before it runs.'
  );
  const checkLine = `2. ${checkProcessOutputToolSchema.name}(process_id, poll_interval_seconds?)`;
  const checkDesc = checkProcessOutputToolSchema.description;

  const paramRows = (props: Record<string, { description?: string }>) =>
    Object.entries(props)
      .map(([k, v]) => `      - ${k}: ${v.description ?? ''}`)
      .join('\n');

  return (
    `${cmdLine}\n   ${cmdDesc}\n${paramRows(runCommandToolSchema.parameters.properties)}\n\n` +
    `${checkLine}\n   ${checkDesc}\n${paramRows(checkProcessOutputToolSchema.parameters.properties)}\n\n` +
    `Output handling: a large output is kept in a file under the temporary directory; the result\n` +
    `shows an excerpt of it (the head and the tail), the path of the file and the line range that\n` +
    `the excerpt left out. The byte and line counts describe the whole file, not the excerpt, and\n` +
    `the exit code is the command's own status — it says nothing about how much output was\n` +
    `captured. Read the file with read_file(path, start_line, end_line) instead of running the\n` +
    `command again. Secrets in the output are replaced with [REDACTED].\n`
  );
}
