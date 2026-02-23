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
import { WebSearchTool, type WebSearchSettings, type WebSearchToolArgs } from './webSearchTool.js';

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

const DEFAULT_WEB_SEARCH_SETTINGS: WebSearchSettings = {
    maxQueries: 3,
    resultsPerQuery: 3,
    requestTimeoutMs: 12_000,
    perPageCharLimit: 2_500,
};

let webSearchSettings: WebSearchSettings = { ...DEFAULT_WEB_SEARCH_SETTINGS };

const isWindows = os.platform() === 'win32';

// --- Interrupt support ---

// Set to true by requestInterrupt(); cleared by clearInterrupt().
// The tool-call loop in index.ts checks this between tool invocations.
let interruptRequested = false;

// Resolvers registered by the currently running runCommand call so it can be
// cancelled from outside without waiting for the process to finish naturally.
let activeInterruptResolve: ((result: string) => void) | null = null;

/**
 * Request an interrupt. If a command is currently executing its child process
 * will be killed and the pending promise resolved immediately. The tool-call
 * loop in index.ts should check isInterruptRequested() after each tool
 * invocation and break early when true.
 */
export function requestInterrupt(): void {
    interruptRequested = true;
    if (activeInterruptResolve) {
        activeInterruptResolve('[Interrupted by user.]');
        activeInterruptResolve = null;
    }
}

/** Clears the interrupt flag. Call this at the start of every new user turn. */
export function clearInterrupt(): void {
    interruptRequested = false;
    activeInterruptResolve = null;
}

/** Returns true if an interrupt has been requested for the current turn. */
export function isInterruptRequested(): boolean {
    return interruptRequested;
}

// --- Helpers ---

/**
 * Returns true if YOLO mode is currently enabled.
 */
export function isYolo(): boolean {
    return isYoloMode;
}

function defaultShell(): string {
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
function getEffectiveShell(requestedShell?: string): string {
    const shell = (requestedShell || defaultShell()).toLowerCase();
    if (isWindows) {
        // If the model requested a POSIX-style shell on Windows, override to
        // powershell and warn so the model understands the environment.
        const posixShells = new Set(['bash', 'sh', 'zsh', 'ksh', 'fish']);
        if (posixShells.has(shell) && shell !== 'powershell') {
            console.log(chalk.yellow(`Warning: requested shell '${shell}' is not native on Windows; using 'powershell' instead.`));
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
    // cmd, bash, sh, zsh, fish, etc. all read stdin with no extra flags
    return { bin: shell === 'cmd' ? 'cmd' : shell, args: [] };
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
    if (parts.length === 0) parts.push('(no output)');

    if (finished) {
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
    items?: {
        type: string;
    };
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

export interface ToolWebSearchConfig {
    maxQueries: number;
    resultsPerQuery: number;
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
    {
        type: 'function',
        function: {
            name: 'web_search',
            description:
                'Searches the web using DuckDuckGo and returns extracted page text from top results. ' +
                'Use this when current chat context is not enough and external sources are required.',
            parameters: {
                type: 'object',
                properties: {
                    prompt: {
                        type: 'string',
                        description:
                            'User request text for deriving search queries if explicit queries are not supplied.',
                    },
                    queries: {
                        type: 'array',
                        items: { type: 'string' },
                        description:
                            'Optional list of explicit search queries to run, for example: ["Cairns Lagoon opening hours", "Cairns Lagoon facts", "Cairns Lagoon entry fee"]. ' +
                            'Provide multiple distinct queries to improve search coverage and obtain diverse information.',
                    },
                    max_queries: {
                        type: 'number',
                        description:
                            'Maximum number of queries to run for this call. Uses configured default when omitted.',
                    },
                    results_per_query: {
                        type: 'number',
                        description:
                            'Number of DuckDuckGo results to fetch per query. Uses configured default when omitted.',
                    },
                },
                required: [],
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

export function setWebSearchConfig(config: ToolWebSearchConfig): void {
    webSearchSettings = {
        ...webSearchSettings,
        maxQueries: Math.max(1, Math.floor(config.maxQueries)),
        resultsPerQuery: Math.max(1, Math.floor(config.resultsPerQuery)),
    };
}

function parseQueriesInput(raw: unknown): string[] {
    if (Array.isArray(raw)) {
        return raw
            .flatMap((item) => String(item).split(/\n|,|;/))
            .map((item) => item.trim())
            .filter((item) => item.length > 0);
    }

    if (typeof raw === 'string') {
        const trimmed = raw.trim();
        if (!trimmed) return [];
        if (!trimmed.startsWith('[')) {
            return trimmed
                .split(/\n|,|;/)
                .map((item) => item.trim())
                .filter((item) => item.length > 0);
        }

        try {
            const parsed = JSON.parse(trimmed) as unknown;
            if (Array.isArray(parsed)) {
                return parsed
                    .map((item) => String(item).trim())
                    .filter((item) => item.length > 0);
            }
        } catch {
            return [];
        }
    }

    return [];
}

async function runWebSearch(args: WebSearchToolArgs): Promise<string> {
    const tool = new WebSearchTool({
        settings: webSearchSettings,
        onProgress: (message) => {
            console.log(chalk.dim(message));
        },
    });
    return tool.run(args);
}

async function runCommand(
    command: string,
    shell?: string,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<string> {
    const effectiveShell = getEffectiveShell(shell);

    // Show the user what the AI wants to run
    console.log(chalk.yellow(`\n[Tool Call] The AI ${isYoloMode ? 'is executing' : 'wants to run'} the following command:`));
    console.log(chalk.bold(`  Shell:   ${effectiveShell}`));
    console.log(chalk.bold(`  Command: ${command}\n`));

    let approved = isYoloMode;
    if (!approved) {
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
    console.log(chalk.dim('(Press Ctrl+C at any time to interrupt the AI loop.)\n'));

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
    processRegistry.set(processId, entry);

    const config = getShellConfig(effectiveShell);
    const child = spawn(config.bin, config.args, { stdio: ['pipe', 'pipe', 'pipe'] });
    entry.process = child;

    child.stdin!.write(command + '\n');
    child.stdin!.end();

    child.stdout?.on('data', (chunk: Buffer) => { entry.stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { entry.stderr += chunk.toString(); });

    return new Promise<string>((resolve) => {
        const finalize = (code: number, result?: string) => {
            activeInterruptResolve = null;
            clearTimeout(timer);
            entry.done = true;
            entry.exitCode = code;
            resolve(result || buildOutput(entry, true, null));
        };

        // Register interrupt handler
        activeInterruptResolve = (result: string) => {
            try { child.kill(); } catch { /* already dead */ }
            finalize(-1, result);
        };

        const timer = setTimeout(() => {
            activeInterruptResolve = null;
            // Still running after timeout – return partial output so the LLM can check back
            resolve(buildOutput(entry, false, processId));
        }, timeoutMs);

        child.on('close', (code) => {
            console.log(chalk.dim(`Command (process_id=${processId}) finished with exit code ${code}.\n`));
            finalize(code ?? 0);
        });

        child.on('error', (err) => {
            entry.stderr += `\nSpawn error: ${err.message}`;
            finalize(-1);
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
    prompt?: string;
    queries?: string[] | string;
    max_queries?: number;
    results_per_query?: number;
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
        '3. web_search(prompt?, queries?, max_queries?, results_per_query?)\n' +
        '   Search DuckDuckGo and return extracted page text from top result pages.\n' +
        '   Use this when external web context is needed. Provide explicit queries as\n' +
        '   an array when possible; aim for 2-3 distinct queries for complex requests\n' +
        '   to ensure comprehensive coverage. The tool will respect the max_queries limit.\n\n' +
        'Tool-use policy:\n' +
        '- If a user request requires terminal/filesystem/system inspection, call run_command directly.\n' +
        '- Do NOT ask the user for permission yourself; ' +
        (isYoloMode
            ? 'the user has already provided implicit consent via YOLO mode.'
            : 'the application already prompts for approval.') + '\n' +
        '- Do NOT only print a shell snippet/code block when the task requires execution.\n' +
        '- If run_command returns a process_id, periodically call check_process_output until completion.\n' +
        `- The default shell on this machine is '${defaultShell()}'. Always use commands appropriate for that shell.\n` +
        '- If a command exits with a non-zero exit code, read the stderr carefully, correct the command, and try again.\n' +
        '  Do NOT give up or tell the user it failed after a single attempt — diagnose and retry with a fixed command.\n\n' +
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

        case 'web_search': {
            const parsedQueries = parseQueriesInput(args.queries);
            const webArgs: WebSearchToolArgs = {};

            if (typeof args.prompt === 'string' && args.prompt.trim().length > 0) {
                webArgs.prompt = args.prompt;
            }
            if (parsedQueries.length > 0) {
                webArgs.queries = parsedQueries;
            }
            if (args.max_queries !== undefined) {
                webArgs.max_queries = args.max_queries;
            }
            if (args.results_per_query !== undefined) {
                webArgs.results_per_query = args.results_per_query;
            }

            if (!webArgs.prompt && (!webArgs.queries || webArgs.queries.length === 0)) {
                return '[Error: web_search requires either "prompt" or "queries"]';
            }

            return runWebSearch(webArgs);
        }

        default:
            return `[Unknown tool: ${name}]`;
    }
}