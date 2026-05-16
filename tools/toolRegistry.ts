/**
 * Command pattern registry for Locopilot tool handlers.
 *
 * Each tool is represented as an IToolCommand object that encapsulates its
 * argument validation and execution logic. The handleToolCall dispatcher in
 * tools.ts resolves the appropriate command from this registry rather than
 * using a monolithic switch statement.
 *
 * All per-request configuration (yolo mode, web search settings, sub-agent
 * config) is carried through a RequestContext object rather than global
 * mutable state, so multiple HTTP requests can be served concurrently.
 */

import { promises as fsp } from 'fs';
import * as path from 'path';
import { WebSearchTool, type WebSearchSettings, type WebSearchToolArgs } from './impl/webSearchTool';
import { FetchUrlTool, type FetchUrlToolArgs } from './impl/fetchUrlTool';
import { FetchImageTool, type FetchImageToolArgs, type FetchImageResult } from './impl/fetchImageTool';
import { ReadFileTool, type ReadFileToolArgs } from './impl/readFileTool';
import { PatchFileTool, type PatchFileToolArgs, type PatchFilePatch } from './impl/patchFileTool';
import { WriteFileTool, type WriteFileToolArgs } from './impl/writeFileTool';
import { runCommand, checkProcessOutput, DEFAULT_TIMEOUT_MS } from './impl/runCommandTool';
import { DEFAULT_OLLAMA_CHAT_TIMEOUT_MS, DEFAULT_WEB_SEARCH_PER_PAGE_CHAR_LIMIT } from '../constants';
import { parsePositiveTimeoutMs, parsePositiveInteger, parseQueriesInput } from './commandHelpers';
import { noopToolOutputSink, type ToolOutputSink } from './toolOutput';
import type { ToolDefinition } from '../services/llm';

// --- Per-request context type ---

/**
 * Carries all per-request/per-turn configuration that was previously stored
 * in module-level globals.  Thread this through handleToolCall() so that
 * concurrent HTTP requests see their own settings without cross-talk.
 */
export interface RequestContext {
    yoloMode: boolean;
    webSearch: WebSearchSettings;
    subAgent: SubAgentConfig;
    /** Tool names allowed by active always-apply skills; undefined = no restriction */
    allowedTools?: string[] | undefined;
}

export interface ToolWebSearchConfig {
    maxQueries: number;
    resultsPerQuery: number;
    perPageCharLimit: number;
    baseUrl: string;
    compactionModel: string;
}

export interface SubAgentConfig {
    baseUrl: string;
    model: string;
    numCtx: number;
    compactionModel: string;
    tools: ToolDefinition[];
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
    patches?: PatchFilePatch[];
    head_chars?: number;
    tail_chars?: number;
    start?: number;
    length?: number;
    start_line?: number;
    end_line?: number;
    line_count?: number;
    content?: string;
    mode?: 'overwrite' | 'append' | 'create';
    agents?: Array<{
        id?: string;
        prompt?: string;
    }>;
    skill_name?: string;
    name?: string;
    description?: string;
    body?: string;
    alwaysApply?: boolean;
    autoInvoke?: boolean;
    globPatterns?: string[];
    allowedTools?: string[];
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
        context?: RequestContext,
        signal?: AbortSignal,
    ): Promise<ToolCallResult>;
}

// --- Tool permission helper ---

/**
 * Checks whether a tool is allowed by the current RequestContext.
 * Returns an error string if the tool is not allowed, or null if it is.
 */
function checkToolAllowed(toolName: string, context?: RequestContext): string | null {
    if (context?.allowedTools && context.allowedTools.length > 0) {
        if (!context.allowedTools.includes(toolName)) {
            return `[Error: tool "${toolName}" is not allowed by the currently active skills. Allowed tools: ${context.allowedTools.join(', ')}]`;
        }
    }
    return null;
}

// --- Private adapter helpers ---

async function runWebSearch(
    args: WebSearchToolArgs,
    settings: WebSearchSettings,
    onProgress?: (message: string) => void,
    output: ToolOutputSink = noopToolOutputSink,
    signal?: AbortSignal,
): Promise<string> {
    const tool = new WebSearchTool({
        settings: {
            ...settings,
            output,
        },
        onProgress: (message: string) => {
            output.writeLine(message);
            onProgress?.(message);
        },
    });
    return tool.run(args, signal);
}

async function runFetchUrl(
    args: FetchUrlToolArgs,
    settings: WebSearchSettings,
    onProgress?: (message: string) => void,
    output: ToolOutputSink = noopToolOutputSink,
    signal?: AbortSignal,
): Promise<string> {
    const tool = new FetchUrlTool({
        settings: {
            ...settings,
            output,
        },
        onProgress: (message: string) => {
            output.writeLine(message);
            onProgress?.(message);
        },
    });
    return tool.run(args, signal);
}

async function runReadFile(
    args: ReadFileToolArgs,
    output: ToolOutputSink = noopToolOutputSink,
    model?: string,
    numCtx?: number,
    signal?: AbortSignal,
): Promise<string> {
    const tool = new ReadFileTool({ output, model, numCtx });
    return tool.run(args, signal);
}

async function runPatchFile(
    args: PatchFileToolArgs,
    output: ToolOutputSink = noopToolOutputSink,
    signal?: AbortSignal,
): Promise<string> {
    const tool = new PatchFileTool({ output });
    return tool.run(args, signal);
}

async function runWriteFile(
    args: WriteFileToolArgs,
    output: ToolOutputSink = noopToolOutputSink,
    signal?: AbortSignal,
): Promise<string> {
    const tool = new WriteFileTool({ output });
    return tool.run(args, signal);
}

function runFetchImage(
    args: FetchImageToolArgs,
    onProgress?: (message: string) => void,
    output: ToolOutputSink = noopToolOutputSink,
    signal?: AbortSignal,
): Promise<FetchImageResult> {
    const tool = new FetchImageTool({
        onProgress: (message: string) => {
            output.writeLine(message);
            onProgress?.(message);
        },
    });
    return tool.run(args, signal);
}

// --- Tool command registry ---

export const toolRegistry = new Map<string, IToolCommand>([
    [
        'run_command',
        {
            async execute(args, onProgress, output = noopToolOutputSink, context, signal) {
                const permErr = checkToolAllowed('run_command', context);
                if (permErr) return { content: permErr };
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
                return {
                    content: await runCommand(
                        args.command, args.shell, timeoutMs, onProgress, cwd, output,
                        context?.yoloMode ?? false,
                        signal,
                    ),
                };
            },
        },
    ],
    [
        'check_process_output',
        {
            async execute(args, onProgress, _output, context, signal) {
                const permErr = checkToolAllowed('check_process_output', context);
                if (permErr) return { content: permErr };
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

                return { content: await checkProcessOutput(args.process_id, waitMs, onProgress, signal) };
            },
        },
    ],
    [
        'web_search',
        {
            async execute(args, onProgress, output = noopToolOutputSink, context, signal) {
                const permErr = checkToolAllowed('web_search', context);
                if (permErr) return { content: permErr };
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

                return {
                    content: await runWebSearch(
                        webArgs,
                        context?.webSearch ?? {
                            maxQueries: 3,
                            resultsPerQuery: 3,
                            requestTimeoutMs: DEFAULT_OLLAMA_CHAT_TIMEOUT_MS,
                            perPageCharLimit: DEFAULT_WEB_SEARCH_PER_PAGE_CHAR_LIMIT,
                            baseUrl: '',
                            compactionModel: '',
                        },
                        onProgress,
                        output,
                        signal,
                    ),
                };
            },
        },
    ],
    [
        'fetch_url',
        {
            async execute(args, onProgress, output = noopToolOutputSink, context, signal) {
                const permErr = checkToolAllowed('fetch_url', context);
                if (permErr) return { content: permErr };
                if (typeof args.url !== 'string' || args.url.trim().length === 0) {
                    return { content: '[Error: missing required argument "url"]' };
                }
                return {
                    content: await runFetchUrl(
                        {
                            url: args.url,
                            use_playwright: args.use_playwright === true,
                        },
                        context?.webSearch ?? {
                            maxQueries: 3,
                            resultsPerQuery: 3,
                            requestTimeoutMs: DEFAULT_OLLAMA_CHAT_TIMEOUT_MS,
                            perPageCharLimit: DEFAULT_WEB_SEARCH_PER_PAGE_CHAR_LIMIT,
                            baseUrl: '',
                            compactionModel: '',
                        },
                        onProgress,
                        output,
                        signal,
                    ),
                };
            },
        },
    ],
    [
        'fetch_image',
        {
            async execute(args, onProgress, output = noopToolOutputSink, context, signal) {
                const permErr = checkToolAllowed('fetch_image', context);
                if (permErr) return { content: permErr };
                if (typeof args.source !== 'string' || args.source.trim().length === 0) {
                    return { content: '[Error: missing required argument "source"]' };
                }
                return runFetchImage({ source: args.source }, onProgress, output, signal);
            },
        },
    ],
    [
        'read_file',
        {
            async execute(args, _onProgress, output = noopToolOutputSink, context, signal) {
                const permErr = checkToolAllowed('read_file', context);
                if (permErr) return { content: permErr };
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
                        start_line: args.start_line,
                        end_line: args.end_line,
                        line_count: args.line_count,
                    }, output, context?.subAgent?.model, context?.subAgent?.numCtx, signal),
                };
            },
        },
    ],
    [
        'patch_file',
        {
            async execute(args, _onProgress, output = noopToolOutputSink, context, signal) {
                const permErr = checkToolAllowed('patch_file', context);
                if (permErr) return { content: permErr };
                if (typeof args.path !== 'string' || args.path.trim().length === 0) {
                    return { content: '[Error: missing required argument "path"]' };
                }
                if (!Array.isArray(args.patches) || args.patches.length === 0) {
                    return { content: '[Error: missing required argument "patches"]' };
                }
                return {
                    content: await runPatchFile({
                        path: args.path,
                        patches: args.patches,
                    }, output, signal),
                };
            },
        },
    ],
    [
        'write_file',
        {
            async execute(args, _onProgress, output = noopToolOutputSink, context, signal) {
                const permErr = checkToolAllowed('write_file', context);
                if (permErr) return { content: permErr };
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
                    }, output, signal),
                };
            },
        },
    ],
    [
        'run_subagents',
        {
            async execute(args, onProgress, output = noopToolOutputSink, context, signal) {
                const permErr = checkToolAllowed('run_subagents', context);
                if (permErr) return { content: permErr };
                const { SubAgentTool } = await import('./impl/subAgentTool');
                const tool = new SubAgentTool();
                return tool.execute(args, onProgress, output, context, signal);
            },
        },
    ],
    [
        'load_skill',
        {
            async execute(args, _onProgress, _output, context) {
                const permErr = checkToolAllowed('load_skill', context);
                if (permErr) return { content: permErr };
                if (typeof args.skill_name !== 'string' || args.skill_name.trim().length === 0) {
                    return { content: '[Error: missing required argument "skill_name"]' };
                }

                // Dynamic import to avoid circular deps (skillManager imports from services/)
                const { getSkillByName, discoverSkills, loadSkillState, getEnabledSkills } = await import('../services/skillManager');
                const skillName = args.skill_name.trim();
                const skill = getSkillByName(skillName);

                if (!skill) {
                    // Re-discover in case cache is stale
                    const allSkills = discoverSkills();
                    const state = loadSkillState();
                    const enabled = getEnabledSkills(allSkills, state);
                    const available = enabled
                        .filter((s) => s.autoInvoke)
                        .map((s) => s.name)
                        .join(', ');
                    return { content: `[Skill "${skillName}" not found or not enabled. Available skills: ${available || '(none)'}]` };
                }

                return { content: skill.body };
            },
        },
    ],
    [
        'create_skill',
        {
            async execute(args, _onProgress, _output, context) {
                const permErr = checkToolAllowed('create_skill', context);
                if (permErr) return { content: permErr };
                if (typeof args.name !== 'string' || args.name.trim().length === 0) {
                    return { content: '[Error: missing required argument "name"]' };
                }
                if (typeof args.description !== 'string' || args.description.trim().length === 0) {
                    return { content: '[Error: missing required argument "description"]' };
                }
                if (typeof args.body !== 'string' || args.body.trim().length === 0) {
                    return { content: '[Error: missing required argument "body"]' };
                }

                const sanitizedName = args.name.trim().toLowerCase().replace(/\s+/g, '-');
                const skillDir = path.join(process.cwd(), '.locopilot', 'skills', sanitizedName);
                const skillMdPath = path.join(skillDir, 'SKILL.md');

                const alwaysApply = args.alwaysApply === true;
                const autoInvoke = args.autoInvoke !== false; // default true

                let frontmatter = `---\nname: ${sanitizedName}\ndescription: ${args.description.trim()}\nalwaysApply: ${alwaysApply}\nautoInvoke: ${autoInvoke}\n`;

                if (Array.isArray(args.globPatterns) && args.globPatterns.length > 0) {
                    frontmatter += `globPatterns: ${JSON.stringify(args.globPatterns)}\n`;
                }
                if (Array.isArray(args.allowedTools) && args.allowedTools.length > 0) {
                    frontmatter += `allowedTools: ${JSON.stringify(args.allowedTools)}\n`;
                }

                frontmatter += `---\n\n${args.body.trim()}\n`;

                try {
                    await fsp.mkdir(skillDir, { recursive: true });
                    await fsp.writeFile(skillMdPath, frontmatter, 'utf-8');

                    // Dynamic import to avoid circular deps
                    const { invalidateSkillCache } = await import('../services/skillManager');
                    invalidateSkillCache();

                    return { content: `Skill "${sanitizedName}" created successfully at ${skillMdPath}.` };
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    return { content: `[Error: failed to create skill "${sanitizedName}": ${msg}]` };
                }
            },
        },
    ],
]);
