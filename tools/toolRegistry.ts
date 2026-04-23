/**
 * Command pattern registry for Locopilot tool handlers.
 *
 * Each tool is represented as an IToolCommand object that encapsulates its
 * argument validation and execution logic. The handleToolCall dispatcher in
 * tools.ts resolves the appropriate command from this registry rather than
 * using a monolithic switch statement.
 */

import chalk from 'chalk';
import { WebSearchTool, type WebSearchSettings, type WebSearchToolArgs } from './impl/webSearchTool.js';
import { FetchUrlTool, type FetchUrlToolArgs } from './impl/fetchUrlTool.js';
import { FetchImageTool, type FetchImageToolArgs, type FetchImageResult } from './impl/fetchImageTool.js';
import { ReadFileTool, type ReadFileToolArgs } from './impl/readFileTool.js';
import { WriteFileTool, type WriteFileToolArgs } from './impl/writeFileTool.js';
import { runCommand, checkProcessOutput, DEFAULT_TIMEOUT_MS } from './impl/runCommandTool.js';
import { DEFAULT_OLLAMA_CHAT_TIMEOUT_MS, DEFAULT_WEB_SEARCH_PER_PAGE_CHAR_LIMIT } from '../constants.js';
import { parsePositiveTimeoutMs, parsePositiveInteger, parseQueriesInput } from './commandHelpers.js';
import { terminalToolOutputSink, type ToolOutputSink } from './toolOutput.js';

// --- Shared mutable state ---

let isYoloMode = false;

const DEFAULT_WEB_SEARCH_SETTINGS: WebSearchSettings = {
    maxQueries: 3,
    resultsPerQuery: 3,
    requestTimeoutMs: DEFAULT_OLLAMA_CHAT_TIMEOUT_MS,
    perPageCharLimit: DEFAULT_WEB_SEARCH_PER_PAGE_CHAR_LIMIT,
    baseUrl: '', // Will be set by setWebSearchConfig() from config
    compactionModel: '',
};

let webSearchSettings: WebSearchSettings = { ...DEFAULT_WEB_SEARCH_SETTINGS };

export function isYolo(): boolean {
    return isYoloMode;
}

export function setYoloMode(enabled: boolean): void {
    isYoloMode = enabled;
}

export interface ToolWebSearchConfig {
    maxQueries: number;
    resultsPerQuery: number;
    perPageCharLimit: number;
    baseUrl: string; // REQUIRED - must come from config
    compactionModel: string;
}

export function setWebSearchConfig(config: ToolWebSearchConfig): void {
    webSearchSettings = {
        ...webSearchSettings,
        maxQueries: Math.max(1, Math.floor(config.maxQueries)),
        resultsPerQuery: Math.max(1, Math.floor(config.resultsPerQuery)),
        perPageCharLimit: Number.isFinite(config.perPageCharLimit)
            ? Math.max(0, Math.floor(config.perPageCharLimit))
            : DEFAULT_WEB_SEARCH_PER_PAGE_CHAR_LIMIT,
        baseUrl: config.baseUrl, // ALWAYS use the config's base URL
        compactionModel: config.compactionModel.trim(),
    };
}

// --- Shared tool argument and result types ---

export interface ToolCallArguments {
    command?: string;
    shell?: string;
    timeout_seconds?: number;
    cwd?: string;
    process_id?: number;
    poll_interval_seconds?: number;
    prompt?: string;
    queries?: string[] | string;
    max_queries?: number;
    use_playwright?: boolean;
    url?: string;
    source?: string;
    path?: string;
    head_chars?: number;
    tail_chars?: number;
    start?: number;
    length?: number;
    content?: string;
    mode?: 'overwrite' | 'append' | 'create';
    confirm_overwrite?: boolean;
}

/** Result returned by a tool command. Most tools only set content; vision tools also set images. */
export interface ToolCallResult {
    content: string;
    images?: string[];
}

// --- Command interface ---

export interface IToolCommand {
    execute(
        args: ToolCallArguments,
        onProgress?: (message: string) => void,
        output?: ToolOutputSink,
    ): Promise<ToolCallResult>;
}

// --- Private adapter helpers ---

async function runWebSearch(
    args: WebSearchToolArgs,
    onProgress?: (message: string) => void,
    output: ToolOutputSink = terminalToolOutputSink,
): Promise<string> {
    const tool = new WebSearchTool({
        settings: webSearchSettings,
        onProgress: (message: string) => {
            output.writeLine(chalk.dim(message));
            onProgress?.(message);
        },
    });
    return tool.run(args);
}

async function runFetchUrl(
    args: FetchUrlToolArgs,
    onProgress?: (message: string) => void,
    output: ToolOutputSink = terminalToolOutputSink,
): Promise<string> {
    const tool = new FetchUrlTool({
        settings: webSearchSettings,
        onProgress: (message: string) => {
            output.writeLine(chalk.dim(message));
            onProgress?.(message);
        },
    });
    return tool.run(args);
}

async function runReadFile(
    args: ReadFileToolArgs,
    output: ToolOutputSink = terminalToolOutputSink,
): Promise<string> {
    const tool = new ReadFileTool({ output });
    return tool.run(args);
}

async function runWriteFile(
    args: WriteFileToolArgs,
    output: ToolOutputSink = terminalToolOutputSink,
): Promise<string> {
    const tool = new WriteFileTool({ output });
    return tool.run(args);
}

function runFetchImage(
    args: FetchImageToolArgs,
    onProgress?: (message: string) => void,
    output: ToolOutputSink = terminalToolOutputSink,
): Promise<FetchImageResult> {
    const tool = new FetchImageTool({
        onProgress: (message: string) => {
            output.writeLine(chalk.dim(message));
            onProgress?.(message);
        },
    });
    return tool.run(args);
}

// --- Tool command registry ---

export const toolRegistry = new Map<string, IToolCommand>([
    [
        'run_command',
        {
            async execute(args, onProgress, output = terminalToolOutputSink) {
                if (!args.command) return { content: '[Error: missing required argument "command"]' };
                let timeoutMs = DEFAULT_TIMEOUT_MS;
                if (args.timeout_seconds !== undefined) {
                    const parsedTimeoutMs = parsePositiveTimeoutMs(args.timeout_seconds);
                    if (parsedTimeoutMs === null) {
                        return { content: '[Error: invalid argument "timeout_seconds" (expected a positive finite number)]' };
                    }
                    timeoutMs = parsedTimeoutMs;
                }
                const cwd = typeof args.cwd === 'string' && args.cwd.trim().length > 0 ? args.cwd : undefined;
                if (args.cwd !== undefined && cwd === undefined) {
                    return { content: '[Error: invalid argument "cwd" (expected a non-empty string)]' };
                }
                return { content: await runCommand(args.command, args.shell, timeoutMs, onProgress, cwd, output) };
            },
        },
    ],
    [
        'check_process_output',
        {
            async execute(args, onProgress) {
                if (args.process_id === undefined) {
                    return { content: '[Error: missing required argument "process_id"]' };
                }
                let waitMs = 0;
                if (args.poll_interval_seconds !== undefined) {
                    const parsedWaitMs = parsePositiveTimeoutMs(args.poll_interval_seconds);
                    if (parsedWaitMs === null) {
                        return { content: '[Error: invalid argument "poll_interval_seconds" (expected a positive finite number)]' };
                    }
                    waitMs = parsedWaitMs;
                }

                return { content: await checkProcessOutput(args.process_id, waitMs, onProgress) };
            },
        },
    ],
    [
        'web_search',
        {
            async execute(args, onProgress, output = terminalToolOutputSink) {
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
                        return { content: '[Error: invalid argument "max_queries" (expected an integer between 1 and 10)]' };
                    }
                    webArgs.max_queries = parsedMaxQueries;
                }
                if (args.use_playwright === true) {
                    webArgs.use_playwright = true;
                }

                if (!webArgs.prompt && (!webArgs.queries || webArgs.queries.length === 0)) {
                    return { content: '[Error: web_search requires either "prompt" or "queries"]' };
                }

                return { content: await runWebSearch(webArgs, onProgress, output) };
            },
        },
    ],
    [
        'fetch_url',
        {
            async execute(args, onProgress, output = terminalToolOutputSink) {
                if (typeof args.url !== 'string' || args.url.trim().length === 0) {
                    return { content: '[Error: missing required argument "url"]' };
                }
                return { content: await runFetchUrl({ 
                    url: args.url,
                    use_playwright: args.use_playwright === true,
                }, onProgress, output) };
            },
        },
    ],
    [
        'fetch_image',
        {
            async execute(args, onProgress, output = terminalToolOutputSink) {
                if (typeof args.source !== 'string' || args.source.trim().length === 0) {
                    return { content: '[Error: missing required argument "source"]' };
                }
                return runFetchImage({ source: args.source }, onProgress, output);
            },
        },
    ],
    [
        'read_file',
        {
            async execute(args, _onProgress, output = terminalToolOutputSink) {
                if (typeof args.path !== 'string' || args.path.trim().length === 0) {
                    return { content: '[Error: missing required argument "path"]' };
                }
                return {
                    content: await runReadFile({
                        path: args.path,
                        head_chars: args.head_chars,
                        tail_chars: args.tail_chars,
                        start: args.start,
                        length: args.length,
                    }, output),
                };
            },
        },
    ],
    [
        'write_file',
        {
            async execute(args, _onProgress, output = terminalToolOutputSink) {
                if (typeof args.path !== 'string' || args.path.trim().length === 0) {
                    return { content: '[Error: missing required argument "path"]' };
                }
                if (typeof args.content !== 'string') {
                    return { content: '[Error: missing required argument "content"]' };
                }
                return {
                    content: await runWriteFile({
                        path: args.path,
                        content: args.content,
                        mode: args.mode,
                        confirm_overwrite: args.confirm_overwrite,
                    }, output),
                };
            },
        },
    ],
]);
