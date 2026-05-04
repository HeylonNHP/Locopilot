import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import os from 'os';
import { terminalToolOutputSink, type ToolOutputSink } from '../toolOutput';
import { getAgentWorkingDirectory, resolveAgentPath, setAgentWorkingDirectory } from '../workingDirectory';
import {
    sanitize,
    getInterruptHint,
    registerInterruptHandler,
    unregisterInterruptHandler,
} from '../tools';
import { AsyncLocalStorage } from 'async_hooks';

const isWindows = os.platform() === 'win32';

import type { ToolSchema } from '../../tools/tools';

export const runCommandToolSchema: ToolSchema = {
    name: 'run_command',
    description: 'Executes a terminal command in the specified shell on the host machine. The user will be asked to approve the command before it runs. Returns the full stdout/stderr when the command finishes within the timeout, or partial output plus a process_id when it is still running. Use check_process_output to poll a long-running command for progress.',
    parameters: {
        type: 'object',
        properties: {
            command:         { type: 'string', description: 'The shell command to execute.' },
            shell:           { type: 'string', description: `Shell to use. Defaults to '${defaultShell()}'. Supported values: bash, sh, zsh, powershell, cmd.` },
            timeout_seconds: { type: 'number', description: 'How many seconds to wait before returning partial output. Defaults to 30.' },
            cwd:             { type: 'string', description: 'Optional working directory for the command. If omitted, Locopilot defaults to the current agent working directory, which starts at the user home directory (Linux HOME or Windows USERPROFILE).' },
        },
        required: ['command'],
    },
};

export const checkProcessOutputToolSchema: ToolSchema = {
    name: 'check_process_output',
    description: 'Returns the current accumulated stdout/stderr of a command that was previously started with run_command and is still running (or has since completed). Also reports whether the process has finished and its exit code.',
    parameters: {
        type: 'object',
        properties: {
            process_id:            { type: 'number', description: 'The process_id returned by run_command.' },
            poll_interval_seconds: { type: 'number', description: 'Optional seconds to wait before sampling stdout/stderr again. Use a higher value when the command is expected to run for a long time.' },
        },
        required: ['process_id'],
    },
};

interface RequestProcessState {
    registry: Map<number, ProcessEntry>;
    nextId: number;
}

const requestProcessState = new AsyncLocalStorage<RequestProcessState>();

// Global fallback registry for non-request (CLI/tests) usage
const globalFallbackRegistry = new Map<number, ProcessEntry>();
let globalFallbackNextId = 1;

// Swappable command confirmation function (default: Inquirer confirm prompt)
let confirmCommand: (msg: string) => Promise<boolean> = async (msg) => confirm({ message: msg, default: false });

export function setCommandConfirmationPrompt(fn: (msg: string) => Promise<boolean>): void {
    confirmCommand = fn;
}

interface ProcessEntry {
    process: ChildProcess;
    command: string;
    shell: string;
    stdout: string;
    stderr: string;
    startedAt: Date;
    done: boolean;
    exitCode: number | null;
}


const WORKDIR_MARKER = '__LOCOPILOT_WORKDIR__:';

/**
 * Call at the start of each HTTP request to create an isolated process registry.
 */
export function enterRequestScope(): void {
    requestProcessState.enterWith({ registry: new Map(), nextId: 1 });
}

export const DEFAULT_TIMEOUT_MS = 30_000;

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
function getEffectiveShell(requestedShell?: string, output: ToolOutputSink = terminalToolOutputSink): string {
    const shell = (requestedShell || defaultShell()).toLowerCase();
    if (isWindows) {
        // If the model requested a POSIX-style shell on Windows, override to
        // powershell and warn so the model understands the environment.
        const posixShells = new Set(['bash', 'sh', 'zsh', 'ksh', 'fish']);
        if (posixShells.has(shell) && shell !== 'powershell') {
            output.writeLine(chalk.yellow(`Warning: requested shell '${shell}' is not native on Windows; using 'powershell' instead.`));
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

function appendWorkingDirectoryProbe(command: string, shell: string): string {
    if (shell === 'cmd' || shell === 'cmd.exe') {
        return `${command} & echo ${WORKDIR_MARKER}%CD%`;
    }

    if (shell === 'powershell') {
        return `${command}; Write-Output ${WORKDIR_MARKER}$PWD`;
    }

    return `${command}; printf '%s\n' "${WORKDIR_MARKER}$PWD"`;
}

function buildOutput(
    entry: ProcessEntry,
    finished: boolean,
    processId: number | null,
): string {
    const parts: string[] = [];
    const sanitizedStdout = sanitize(entry.stdout);
    const sanitizedStderr = sanitize(entry.stderr);
    const elapsedMs = Math.max(0, Date.now() - entry.startedAt.getTime());
    const elapsedSeconds = (elapsedMs / 1000).toFixed(2);

    if (sanitizedStdout) parts.push(`stdout:\n${sanitizedStdout}`);
    if (sanitizedStderr) parts.push(`stderr:\n${sanitizedStderr}`);
    if (parts.length === 0) parts.push('(no output)');

    if (finished) {
        parts.push(`elapsed_seconds: ${elapsedSeconds}`);
        const code = entry.exitCode ?? 'unknown';
        if (code !== 0) {
            parts.push(
                `exit_code: ${code} (COMMAND FAILED — review stderr above and try a corrected command; ` +
                `do not repeat the same command unchanged)`
            );
        } else {
            parts.push(`exit_code: ${code}`);
        }
    } else {
        parts.push(`elapsed_seconds: ${elapsedSeconds}`);
        parts.push(`status: still running (process_id=${processId})`);
        parts.push('Use check_process_output(process_id, poll_interval_seconds?) to get updated output.');
    }
    return parts.join('\n');
}

function killProcessTree(child: ChildProcess): void {
    const pid = child.pid;
    if (!pid) return;

    if (isWindows) {
        const taskkillResult = spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
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

export async function runCommand(
    command: string,
    shell?: string,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
    onProgress?: (message: string) => void,
    cwd?: string,
    output: ToolOutputSink = terminalToolOutputSink,
    yoloMode: boolean = false,
): Promise<string> {
    const effectiveShell = getEffectiveShell(shell, output);
    const approvedYolo = yoloMode;
    const agentOutput = output ?? terminalToolOutputSink;
    const trimmedCwd = cwd?.trim();
    const workingDirectory = trimmedCwd
        ? resolveAgentPath(agentOutput, trimmedCwd)
        : getAgentWorkingDirectory(agentOutput);
    const commandToExecute = appendWorkingDirectoryProbe(command, effectiveShell);

    // Show the user what the AI wants to run
    output.writeLine(chalk.cyan(`\n─── ${approvedYolo ? 'Executing' : 'Requesting'} Terminal Command ───`));
    output.writeLine(`${chalk.bold('  Shell:')}   ${chalk.dim(effectiveShell)}`);
    output.writeLine(`${chalk.bold('  Command:')} ${chalk.green(command)}\n`);

    let approved = approvedYolo;
    if (!approved) {
        try {
            approved = await confirmCommand('Allow this command to run?');
        } catch (e: unknown) {
            if (e instanceof Error && e.name === 'ExitPromptError') {
                return '[Command rejected: user exited prompt]';
            }
            throw e;
        }
    }

    if (!approved) {
        output.writeLine(chalk.red('  Command rejected by user.\n'));
        return '[Command was rejected by the user.]';
    }

    const store = requestProcessState.getStore();
    const processId = store ? store.nextId++ : globalFallbackNextId++;
    output.writeLine(chalk.dim(`  Running (id=${processId})... (${getInterruptHint()})\n`));

    const entry: ProcessEntry = {
        process: null as unknown as ChildProcess, // assigned immediately below
        command,
        shell: effectiveShell,
        stdout: '',
        stderr: '',
        startedAt: new Date(),
        done: false,
        exitCode: null,
    };
    const procRegistry = store?.registry ?? globalFallbackRegistry;
    procRegistry.set(processId, entry);

    const config = getShellConfig(effectiveShell);
    const child = spawn(config.bin, config.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: !isWindows,
        cwd: workingDirectory,
    });
    entry.process = child;

    child.stdout?.on('data', (chunk: Buffer) => { entry.stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { entry.stderr += chunk.toString(); });
    child.stdout?.on('data', () => {
        onProgress?.('run_command: receiving stdout...');
    });
    child.stderr?.on('data', () => {
        onProgress?.('run_command: receiving stderr...');
    });

    return new Promise<string>((resolve) => {
        let settled = false;
        let returnedPartial = false;
        let interruptHandlerId = -1;

        const finalize = (code: number, result?: string) => {
            if (settled) return;
            settled = true;

            unregisterInterruptHandler(interruptHandlerId);
            clearTimeout(timer);
            entry.done = true;
            entry.exitCode = code;
            if (!returnedPartial) {
                const procRegistry = requestProcessState.getStore()?.registry ?? globalFallbackRegistry;
                procRegistry.delete(processId);
            }
            resolve(result || buildOutput(entry, true, null));
        };

        // Register interrupt handler
        interruptHandlerId = registerInterruptHandler((result: string) => {
            entry.stderr += `${entry.stderr ? '\n' : ''}${result}`;
            killProcessTree(child);
            finalize(-1);
        });

        const timer = setTimeout(() => {
            if (settled) return;
            // Still running after timeout – return partial output so the LLM can check back
            onProgress?.('run_command: still running, returning partial output...');
            returnedPartial = true;
            
            // We don't unregister interrupt handler here because the process 
            // is still running and the user might still want to interrupt it 
            // while we are waiting for the next LLM turn.
            // However, buildOutput needs to know it's not "finished" in the exit sense.
            resolve(buildOutput(entry, false, processId));
        }, timeoutMs);

        child.on('close', (code) => {
            const exitCode = code ?? 0;
            const stdoutLines = entry.stdout.split(/\r?\n/);
            let markerLineIndex = -1;
            let detectedWorkingDirectory: string | null = null;

            for (let index = 0; index < stdoutLines.length; index += 1) {
                const line = stdoutLines[index] ?? '';
                if (!line.startsWith(WORKDIR_MARKER)) {
                    continue;
                }

                const candidate = line.slice(WORKDIR_MARKER.length).trim();
                if (candidate.length > 0) {
                    detectedWorkingDirectory = candidate;
                    markerLineIndex = index;
                }
            }

            if (detectedWorkingDirectory) {
                stdoutLines.splice(markerLineIndex, 1);
                entry.stdout = stdoutLines.join('\n').trimEnd();
                setAgentWorkingDirectory(agentOutput, detectedWorkingDirectory);
            }

            output.writeLine('\n' + chalk.dim(`  Process ${processId} exited with code ${code}.\n`));
            onProgress?.('run_command: completed.');
            finalize(exitCode);
        });

        child.on('error', (err) => {
            entry.stderr += `\nSpawn error: ${err.message}`;
            onProgress?.('run_command: spawn error.');
            finalize(-1);
        });

        if (!child.stdin) {
            entry.stderr += '\nSpawn error: shell stdin is not available.';
            onProgress?.('run_command: stdin unavailable.');
            finalize(-1);
            return;
        }

        child.stdin.on('error', (err) => {
            entry.stderr += `\nstdin error: ${err.message}`;
            onProgress?.('run_command: stdin error.');
            finalize(-1);
        });

        try {
            child.stdin.write(commandToExecute + '\n');
            child.stdin.end();
        } catch (err: unknown) {
            entry.stderr += `\nstdin write error: ${err instanceof Error ? err.message : String(err)}`;
            onProgress?.('run_command: stdin write failure.');
            finalize(-1);
        }
    });
}

function waitForProcessSnapshot(entry: ProcessEntry, waitMs: number): Promise<void> {
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

        if (entry.done) {
            finish();
        }
    });
}

export async function checkProcessOutput(
    processId: number,
    waitMs: number = 0,
    onProgress?: (message: string) => void,
): Promise<string> {
    const procRegistry = requestProcessState.getStore()?.registry ?? globalFallbackRegistry;
    const entry = procRegistry.get(processId);
    if (!entry) {
        return `[No process found with process_id=${processId}]`;
    }

    if (!entry.done && waitMs > 0) {
        onProgress?.(`check_process_output: waiting ${Math.round(waitMs / 1000)}s before sampling...`);
        await waitForProcessSnapshot(entry, waitMs);
    }

    if (entry.done) {
        const output = buildOutput(entry, true, null);
        const procRegistry = requestProcessState.getStore()?.registry ?? globalFallbackRegistry;
        procRegistry.delete(processId);
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
    const cmdDesc = runCommandToolSchema.description
        .replace('The user will be asked to approve the command before it runs.',
            isYolo ? 'The command will run automatically with user consent.' : 'The user will be asked to approve it before it runs.');
    const checkLine = `2. ${checkProcessOutputToolSchema.name}(process_id, poll_interval_seconds?)`;
    const checkDesc = checkProcessOutputToolSchema.description;

    const paramRows = (props: Record<string, { description: string }>) =>
        Object.entries(props).map(([k, v]) => `      - ${k}: ${v.description}`).join('\n');

    return (
        `${cmdLine}\n   ${cmdDesc}\n${paramRows(runCommandToolSchema.parameters.properties)}\n\n` +
        `${checkLine}\n   ${checkDesc}\n${paramRows(checkProcessOutputToolSchema.parameters.properties)}\n`
    );
}
