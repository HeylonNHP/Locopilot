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

import chalk from 'chalk';
import readline from 'readline';
import { WebSearchTool, getToolPrompt as getWebSearchPrompt, type WebSearchSettings, type WebSearchToolArgs } from './tools/webSearchTool.js';
import { FetchUrlTool, getToolPrompt as getFetchUrlPrompt, type FetchUrlToolArgs } from './tools/fetchUrlTool.js';
import { runCommand, checkProcessOutput, getToolPrompt as getRunCommandPrompt, defaultShell, DEFAULT_TIMEOUT_MS } from './runCommandTool.js';

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

let isYoloMode = false;

const DEFAULT_WEB_SEARCH_SETTINGS: WebSearchSettings = {
    maxQueries: 3,
    resultsPerQuery: 3,
    requestTimeoutMs: 12_000,
    perPageCharLimit: 2_500,
};

let webSearchSettings: WebSearchSettings = { ...DEFAULT_WEB_SEARCH_SETTINGS };

// --- Interrupt support ---

// Set to true by requestInterrupt(); cleared by clearInterrupt().
// The tool-call loop in index.ts checks this between tool invocations.
let interruptRequested = false;

// Resolvers registered by tools (e.g. run_command) so they can be
// cancelled from outside without waiting for the natural finish.
let activeInterruptHandler: ((result: string) => void) | null = null;

let keyInterruptListener: ((s: string, k: readline.Key) => void) | null = null;
let prevRawMode: boolean | null = null;
const DEFAULT_INTERRUPT_KEY_SPEC = 'Ctrl+X';
let currentInterruptKeySpec = DEFAULT_INTERRUPT_KEY_SPEC;

/**
 * Request an interrupt. If a tool is currently executing its work
 * will be killed or cancelled and the pending promise resolved immediately. 
 * The tool-call loop in index.ts should check isInterruptRequested() after
 * each tool invocation and break early when true.
 */
export function requestInterrupt(): void {
    interruptRequested = true;
    if (activeInterruptHandler) {
        activeInterruptHandler('[Interrupted by user.]');
        activeInterruptHandler = null;
    }
}

/**
 * Registers a handler to be called when an interrupt is requested.
 * Used by tools like run_command to kill child processes.
 */
export function registerInterruptHandler(handler: (result: string) => void): void {
    activeInterruptHandler = handler;
}

/**
 * Unregisters the current interrupt handler.
 */
export function unregisterInterruptHandler(): void {
    activeInterruptHandler = null;
}

/**
 * Returns a human-readable hint about how to interrupt the AI loop.
 */
export function getInterruptHint(): string {
    return `Press ${chalk.bold(currentInterruptKeySpec)} to interrupt the AI loop.`;
}

/**
 * Installs a keypress listener that calls requestInterrupt() when a specific
 * key combination is pressed. This is used to provide an alternative to
 * Ctrl+C which many users find themselves pressing accidentally.
 *
 * NOTE: only works in TTY environments.
 */
export function installKeyInterruptListener(keySpec = 'Ctrl+X'): void {
    if (!process.stdin.isTTY) return;

    currentInterruptKeySpec = keySpec;
    const spec = keySpec.toLowerCase();
    const isCtrl = spec.startsWith('ctrl+');
    const keyName = isCtrl ? spec.slice(5) : spec;

    readline.emitKeypressEvents(process.stdin);

    // Save current raw mode and enable it so we get keypresses immediately.
    // setRawMode(true) disables the OS TTY processing that converts Ctrl+C → SIGINT,
    // so we must handle Ctrl+C manually inside the keypress listener.
    prevRawMode = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    // Ensure stdin is flowing so keypress events are emitted between Inquirer prompts.
    process.stdin.resume();

    keyInterruptListener = (str: string, key: readline.Key) => {
        if (!key) return;

        // Raw mode suppresses the OS SIGINT for Ctrl+C, so re-raise it manually
        // so the normal top-level exit handler fires (i.e. Ctrl+C still kills the app).
        if (key.ctrl && key.name === 'c') {
            process.kill(process.pid, 'SIGINT');
            return;
        }

        const match = isCtrl
            ? (key.ctrl && key.name === keyName)
            : (key.name === keyName || str === keySpec);

        if (match) {
            console.log(chalk.yellow(`\n[${keySpec} pressed — interrupting AI loop...]\n`));
            requestInterrupt();
        }
    };

    process.stdin.on('keypress', keyInterruptListener);
}

/**
 * Removes the keypress listener and restores the previous TTY raw mode.
 */
export function removeKeyInterruptListener(): void {
    if (!process.stdin.isTTY || !keyInterruptListener) {
        currentInterruptKeySpec = DEFAULT_INTERRUPT_KEY_SPEC;
        return;
    }

    process.stdin.off('keypress', keyInterruptListener);
    if (prevRawMode !== null) {
        process.stdin.setRawMode(prevRawMode);
    }

    keyInterruptListener = null;
    prevRawMode = null;
    currentInterruptKeySpec = DEFAULT_INTERRUPT_KEY_SPEC;
}

/** Clears the interrupt flag. Call this at the start of every new user turn. */
export function clearInterrupt(): void {
    interruptRequested = false;
    activeInterruptHandler = null;
}

/** Returns true if an interrupt has been requested for the current turn. */
export function isInterruptRequested(): boolean {
    return interruptRequested;
}

/**
 * Returns true if YOLO mode is currently enabled.
 */
export function isYolo(): boolean {
    return isYoloMode;
}

// --- Tool handlers ---

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
                'When using these results in your final answer, you MUST cite the full result URL(s) ' +
                'inline immediately after the relevant sentence(s). Do NOT use result_N placeholders.',
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
    {
        type: 'function',
        function: {
            name: 'fetch_url',
            description:
                'Fetches content from one specific URL and returns extracted page text. ' +
                'Use this to follow links discovered during web_search or to revisit a known page directly.',
            parameters: {
                type: 'object',
                properties: {
                    url: {
                        type: 'string',
                        description: 'A full http or https URL to fetch, for example: https://example.com/article',
                    },
                },
                required: ['url'],
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

function parseFiniteNumber(value: unknown): number | null {
    if (typeof value !== 'number') return null;
    return Number.isFinite(value) ? value : null;
}

function parsePositiveInteger(
    value: unknown,
    min = 1,
    max = Number.MAX_SAFE_INTEGER,
): number | null {
    const parsed = parseFiniteNumber(value);
    if (parsed === null) return null;
    const floored = Math.floor(parsed);
    if (floored < min || floored > max) return null;
    return floored;
}

function parsePositiveTimeoutMs(seconds: unknown): number | null {
    const parsedSeconds = parseFiniteNumber(seconds);
    if (parsedSeconds === null || parsedSeconds <= 0) return null;
    const ms = Math.floor(parsedSeconds * 1000);
    if (!Number.isFinite(ms) || ms < 1) return null;
    return Math.min(ms, 3_600_000);
}

function parseQueriesInput(raw: unknown): string[] {
    const splitAndNormalize = (value: string): string[] => {
        return value
            .split(/\n|,|;/)
            .map((item) => item.trim())
            .filter((item) => item.length > 0);
    };

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
            return splitAndNormalize(trimmed);
        }

        try {
            const parsed = JSON.parse(trimmed) as unknown;
            if (Array.isArray(parsed)) {
                return parsed
                    .map((item) => String(item).trim())
                    .filter((item) => item.length > 0);
            }
        } catch {
            return splitAndNormalize(trimmed);
        }

        return splitAndNormalize(trimmed);
    }

    return [];
}

async function runWebSearch(
    args: WebSearchToolArgs,
    onProgress?: (message: string) => void,
): Promise<string> {
    const tool = new WebSearchTool({
        settings: webSearchSettings,
        onProgress: (message) => {
            console.log(chalk.dim(message));
            onProgress?.(message);
        },
    });
    return tool.run(args);
}

async function runFetchUrl(
    args: FetchUrlToolArgs,
    onProgress?: (message: string) => void,
): Promise<string> {
    const tool = new FetchUrlTool({
        settings: webSearchSettings,
        onProgress: (message) => {
            console.log(chalk.dim(message));
            onProgress?.(message);
        },
    });
    return tool.run(args);
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
    url?: string;
}

/**
 * Returns the tool-awareness section of the system prompt, describing the
 * available tools and how the model should use them. Kept here so that the
 * prompt stays in sync with the tool implementations automatically.
 */
export function getToolSystemPrompt(): string {
    return (
        'You have access to the following tools that let you interact with the host machine:\n\n' +
        getRunCommandPrompt(isYoloMode) +
        getWebSearchPrompt() +
        getFetchUrlPrompt() +
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

// Automatic nudging was removed in favour of a manual `/nudge` command.
// The manual nudge is implemented in `index.ts` and the user-facing
// reminder text is provided by `getToolUseNudge()` below.

export function getToolUseNudge(): string {
    return (
        'Tool-use reminder: your previous response appears uncertain or incomplete. ' +
        'If you are not entirely certain, call web_search now and then answer using the fetched evidence. ' +
        'Do not use result_N placeholders; cite full URLs inline. ' +
        'If terminal access is needed, call run_command directly now. ' +
        (isYoloMode
            ? 'The command will execute automatically.'
            : 'I (the app) will ask the human user for approval before execution.')
    );
}

export async function handleToolCall(
    name: string,
    args: ToolCallArguments,
    onProgress?: (message: string) => void,
): Promise<string> {
    switch (name) {
        case 'run_command': {
            if (!args.command) return '[Error: missing required argument "command"]';
            let timeoutMs = DEFAULT_TIMEOUT_MS;
            if (args.timeout_seconds !== undefined) {
                const parsedTimeoutMs = parsePositiveTimeoutMs(args.timeout_seconds);
                if (parsedTimeoutMs === null) {
                    return '[Error: invalid argument "timeout_seconds" (expected a positive finite number)]';
                }
                timeoutMs = parsedTimeoutMs;
            }
            return runCommand(args.command, args.shell, timeoutMs, onProgress);
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
                const parsedMaxQueries = parsePositiveInteger(args.max_queries, 1, 10);
                if (parsedMaxQueries === null) {
                    return '[Error: invalid argument "max_queries" (expected an integer between 1 and 10)]';
                }
                webArgs.max_queries = parsedMaxQueries;
            }
            if (args.results_per_query !== undefined) {
                const parsedResultsPerQuery = parsePositiveInteger(args.results_per_query, 1, 10);
                if (parsedResultsPerQuery === null) {
                    return '[Error: invalid argument "results_per_query" (expected an integer between 1 and 10)]';
                }
                webArgs.results_per_query = parsedResultsPerQuery;
            }

            if (!webArgs.prompt && (!webArgs.queries || webArgs.queries.length === 0)) {
                return '[Error: web_search requires either "prompt" or "queries"]';
            }

            return runWebSearch(webArgs, onProgress);
        }

        case 'fetch_url': {
            if (typeof args.url !== 'string' || args.url.trim().length === 0) {
                return '[Error: missing required argument "url"]';
            }
            const fetchArgs: FetchUrlToolArgs = {
                url: args.url,
            };
            return runFetchUrl(fetchArgs, onProgress);
        }

        default:
            return `[Unknown tool: ${name}]`;
    }
}