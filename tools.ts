/**
 * Terminal tool calling support for Locopilot.
 *
 * Provides Ollama-compatible tool schemas and execution handlers that allow
 * LLMs to run terminal commands on the host machine. Every command requires
 * explicit user confirmation before it is executed. Commands that complete
 * within the configured timeout return their full output; long-running
 * commands are tracked in an in-memory process registry so the LLM can
 * poll for incremental output via the `check_process_output` tool.
 */

import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import os from 'os';

// Default time (ms) to wait for a command before returning partial output
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Strips ANSI escape codes and Carriage Returns from text.
 * Carriage Returns (\r) in particular can cause the terminal cursor
 * to move backwards and overwrite previous text, making parts of
 * the output "disappear".
 */
export function sanitize(text: string): string {
    return text
        // Normalize line endings to LF
        .replace(/\r\n/g, '\n')
        // Remove remaining lone Carriage Returns that could overwrite text
        .replace(/\r/g, '')
        // Strip ANSI escape codes (colors, cursor moves, screen clears)
        // eslint-disable-next-line no-control-regex
        .replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
}

// --- Internal process registry ---

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

const processRegistry = new Map<number, ProcessEntry>();
let nextProcessId = 1;
let isYoloMode = false;

// --- Helpers ---

/**
 * Returns true if YOLO mode is currently enabled.
 */
export function isYolo(): boolean {
    return isYoloMode;
}

function defaultShell(): string {
    return os.platform() === 'win32' ? 'powershell' : 'bash';
}

function shellArgs(shell: string): [string, string] {
    if (shell === 'powershell') return ['powershell', '-Command'];
    if (shell === 'cmd')        return ['cmd', '/C'];
    return [shell, '-c'];
}

function buildOutput(
    entry: ProcessEntry,
    finished: boolean,
    processId: number | null,
): string {
    const parts: string[] = [];
    const sanitizedStdout = sanitize(entry.stdout);
    const sanitizedStderr = sanitize(entry.stderr);

    if (sanitizedStdout) parts.push(`stdout:\n${sanitizedStdout}`);
    if (sanitizedStderr) parts.push(`stderr:\n${sanitizedStderr}`);
    if (parts.length === 0) parts.push('(no output yet)');

    if (finished) {
        parts.push(`exit_code: ${entry.exitCode ?? 'unknown'}`);
    } else {
        parts.push(`status: still running (process_id=${processId})`);
        parts.push('Use check_process_output to get updated output.');
    }
    return parts.join('\n');
}

// --- Tool schemas (Ollama / OpenAI function-calling format) ---

export interface OllamaToolParameter {
    type: string;
    description: string;
    enum?: string[];
}

export interface OllamaTool {
    type: 'function';
    function: {
        name: string;
        description: string;
        parameters: {
            type: 'object';
            properties: Record<string, OllamaToolParameter>;
            required: string[];
        };
    };
}

export const TOOLS: OllamaTool[] = [
    {
        type: 'function',
        function: {
            name: 'run_command',
            description:
                'Executes a terminal command in the specified shell on the host machine. ' +
                'The user will be asked to approve the command before it runs. ' +
                'Returns the full stdout/stderr when the command finishes within the timeout, ' +
                'or partial output plus a process_id when it is still running. ' +
                'Use check_process_output to poll a long-running command for progress.',
            parameters: {
                type: 'object',
                properties: {
                    command: {
                        type: 'string',
                        description: 'The shell command to execute.',
                    },
                    shell: {
                        type: 'string',
                        description:
                            `Shell to use. Defaults to '${defaultShell()}'. ` +
                            'Supported values: bash, sh, zsh, powershell, cmd.',
                    },
                    timeout_seconds: {
                        type: 'number',
                        description:
                            'How many seconds to wait before returning partial output. ' +
                            'Defaults to 30. Use a higher value for commands known to be slow.',
                    },
                },
                required: ['command'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'check_process_output',
            description:
                'Returns the current accumulated stdout/stderr of a command that was ' +
                'previously started with run_command and is still running (or has since ' +
                'completed). Also reports whether the process has finished and its exit code.',
            parameters: {
                type: 'object',
                properties: {
                    process_id: {
                        type: 'number',
                        description: 'The process_id returned by run_command.',
                    },
                },
                required: ['process_id'],
            },
        },
    },
];

// --- Tool handlers ---

/**
 * Enables or disables YOLO mode. In YOLO mode, commands requested by the
 * AI are executed automatically without user confirmation.
 */
export function setYoloMode(enabled: boolean): void {
    isYoloMode = enabled;
}

async function runCommand(
    command: string,
    shell: string = defaultShell(),
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<string> {
    // Show the user what the AI wants to run
    console.log(chalk.yellow(`\n[Tool Call] The AI ${isYoloMode ? 'is executing' : 'wants to run'} the following command:`));
    console.log(chalk.bold(`  Shell:   ${shell}`));
    console.log(chalk.bold(`  Command: ${command}\n`));

    let approved = false;
    if (isYoloMode) {
        approved = true;
    } else {
        try {
            approved = await confirm({ message: 'Allow this command to run?', default: false });
        } catch (e: unknown) {
            if (e instanceof Error && e.name === 'ExitPromptError') {
                return '[Command rejected: user exited prompt]';
            }
            throw e;
        }
    }

    if (!approved) {
        console.log(chalk.red('Command rejected by user.\n'));
        return '[Command was rejected by the user.]';
    }

    const processId = nextProcessId++;
    console.log(chalk.dim(`Running command (process_id=${processId})...\n`));

    const entry: ProcessEntry = {
        process: null as unknown as ChildProcess, // assigned immediately below
        command,
        shell,
        stdout: '',
        stderr: '',
        startedAt: new Date(),
        done: false,
        exitCode: null,
    };
    processRegistry.set(processId, entry);

    const [shellBin, shellFlag] = shellArgs(shell);
    const child = spawn(shellBin, [shellFlag, command], { stdio: 'pipe' });
    entry.process = child;

    child.stdout.on('data', (chunk: Buffer) => { entry.stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { entry.stderr += chunk.toString(); });

    return new Promise<string>((resolve) => {
        const timer = setTimeout(() => {
            // Still running after timeout – return partial output so the LLM can check back
            resolve(buildOutput(entry, false, processId));
        }, timeoutMs);

        child.on('close', (code) => {
            clearTimeout(timer);
            entry.done = true;
            entry.exitCode = code;
            console.log(chalk.dim(`Command (process_id=${processId}) finished with exit code ${code}.\n`));
            resolve(buildOutput(entry, true, null));
        });

        child.on('error', (err) => {
            clearTimeout(timer);
            entry.done = true;
            entry.exitCode = -1;
            entry.stderr += `\nSpawn error: ${err.message}`;
            resolve(buildOutput(entry, true, null));
        });
    });
}

function checkProcessOutput(processId: number): string {
    const entry = processRegistry.get(processId);
    if (!entry) {
        return `[No process found with process_id=${processId}]`;
    }
    return buildOutput(entry, entry.done, entry.done ? null : processId);
}

// --- Public dispatcher ---

export interface ToolCallArguments {
    command?: string;
    shell?: string;
    timeout_seconds?: number;
    process_id?: number;
}

/**
 * Returns the tool-awareness section of the system prompt, describing the
 * available tools and how the model should use them. Kept here so that the
 * prompt stays in sync with the tool implementations automatically.
 */
export function getToolSystemPrompt(): string {
    return (
        'You have access to the following tools that let you interact with the host machine:\n\n' +
        '1. run_command(command, shell?, timeout_seconds?)\n' +
        '   Execute a shell command on the host machine. ' +
        (isYoloMode
            ? 'The command will run automatically with user consent.'
            : 'The user will be asked to approve it before it runs.') + '\n' +
        '   Returns stdout/stderr when the command finishes, or partial\n' +
        `   output plus a process_id if still running after the timeout (default ${DEFAULT_TIMEOUT_MS / 1000}s).\n\n` +
        '2. check_process_output(process_id)\n' +
        '   Poll a long-running command for its current stdout/stderr and whether it has\n' +
        '   finished. Use this to check on commands that are still in progress.\n\n' +
        'Tool-use policy:\n' +
        '- If a user request requires terminal/filesystem/system inspection, call run_command directly.\n' +
        '- Do NOT ask the user for permission yourself; ' +
        (isYoloMode
            ? 'the user has already provided implicit consent via YOLO mode.'
            : 'the application already prompts for approval.') + '\n' +
        '- Do NOT only print a shell snippet/code block when the task requires execution.\n' +
        '- If run_command returns a process_id, periodically call check_process_output until completion.\n\n' +
        'When the user asks you to do something that involves the filesystem, the terminal,\n' +
        'running programs, or inspecting the system, use these tools rather than refusing\n' +
        'or guessing. Always prefer calling a tool over saying you cannot do something.\n' +
        'When a command completes, summarise its output clearly for the user.'
    );
}

/**
 * Heuristic to detect assistant replies that look like plain-text commands
 * or permission requests instead of actual tool-calls. Kept here so the
 * tools module fully describes its own runtime behaviour.
 */
export function shouldNudgeForToolCall(content: string): boolean {
    const normalized = content.toLowerCase();
    return (
        normalized.trim() === '' ||
        normalized.includes('```bash') ||
        normalized.includes('```sh') ||
        normalized.includes('would you like me to run') ||
        normalized.includes('let me execute') ||
        normalized.includes('executing...') ||
        normalized.includes('i cannot access') ||
        normalized.includes('i do not have access')
    );
}

export function getToolUseNudge(): string {
    return (
        'Tool-use reminder: do not ask for permission and do not only print shell commands. ' +
        'If terminal access is needed, call run_command directly now. ' +
        (isYoloMode
            ? 'The command will execute automatically.'
            : 'I (the app) will ask the human user for approval before execution.')
    );
}

export async function handleToolCall(
    name: string,
    args: ToolCallArguments,
): Promise<string> {
    switch (name) {
        case 'run_command': {
            if (!args.command) return '[Error: missing required argument "command"]';
            const timeoutMs = args.timeout_seconds !== undefined
                ? args.timeout_seconds * 1000
                : DEFAULT_TIMEOUT_MS;
            return runCommand(args.command, args.shell, timeoutMs);
        }

        case 'check_process_output': {
            if (args.process_id === undefined) {
                return '[Error: missing required argument "process_id"]';
            }
            return checkProcessOutput(args.process_id);
        }

        default:
            return `[Unknown tool: ${name}]`;
    }
}
