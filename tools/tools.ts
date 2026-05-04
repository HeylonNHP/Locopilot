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

import { getToolPrompt as getWebSearchPrompt } from './impl/webSearchTool';
import { getToolPrompt as getFetchUrlPrompt } from './impl/fetchUrlTool';
import { getToolPrompt as getFetchImagePrompt } from './impl/fetchImageTool';
import { getToolPrompt as getReadFilePrompt } from './impl/readFileTool';
import { getToolPrompt as getPatchFilePrompt } from './impl/patchFileTool';
import { getToolPrompt as getWriteFilePrompt } from './impl/writeFileTool';
import { getToolPrompt as getSubAgentPrompt } from './impl/subAgentTool';
import { getToolPrompt as getRunCommandPrompt } from './impl/runCommandTool';
import { runCommandToolSchema } from './impl/runCommandTool';
import { checkProcessOutputToolSchema } from './impl/runCommandTool';
import { subAgentToolSchema } from './impl/subAgentTool';

// Keep defaultShell export (used in runCommandToolSchema via defaultShell() call)
export { defaultShell } from './impl/runCommandTool';
import { toolRegistry } from './toolRegistry';
import { terminalToolOutputSink, type ToolOutputSink } from './toolOutput';
import { buildToolUseNudge } from '../services/toolUseNudge';
import type { RequestContext, ToolCallArguments, ToolCallResult } from './toolRegistry';
export { requestInterrupt, registerInterruptHandler, unregisterInterruptHandler, getInterruptHint, installKeyInterruptListener, removeKeyInterruptListener, clearInterrupt, isInterruptRequested } from './interruptManager';
export type { RequestContext, ToolCallArguments, ToolCallResult };
export type { ToolOutputSink } from './toolOutput';
export { terminalToolOutputSink } from './toolOutput';

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

// --- Tool schemas ---

export interface ToolSchema {
    name: string;
    description: string;
    parameters: {
        type: 'object';
        properties: Record<string, {
            type: string;
            description: string;
            items?: {
                type: 'object';
                properties?: Record<string, { type: string; description: string }>;
                required?: string[];
                description?: string;
            };
        }>;
        required: string[];
    };
}

export interface OllamaToolParameter {
    type: string;
    description?: string;
    enum?: string[];
    items?: {
        type: string;
        description?: string;
        enum?: string[];
        items?: {
            type: string;
            description?: string;
            enum?: string[];
            properties?: Record<string, OllamaToolParameter>;
            required?: string[];
        };
        properties?: Record<string, OllamaToolParameter>;
        required?: string[];
    };
    properties?: Record<string, OllamaToolParameter>;
    required?: string[];
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
    function: runCommandToolSchema,
},
{
    type: 'function',
    function: checkProcessOutputToolSchema,
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
                            'Provide multiple distinct queries to improve search coverage and obtain diverse information while respecting the configured max_queries setting.',
                    },
                    max_queries: {
                        type: 'number',
                        description:
                            'Maximum number of queries to run for this call. Uses the configured max_queries setting when omitted.',
                    },
                    use_playwright: {
                        type: 'boolean',
                        description:
                            'When true, uses a real browser (Playwright) to render each result page before extracting text. ' +
                            'Useful for JavaScript-heavy pages, SPAs, or sites that require client-side rendering. ' +
                            'May be slower but provides more complete content extraction.',
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
                    use_playwright: {
                        type: 'boolean',
                        description:
                            'When true, uses a real browser (Playwright) to render the page before extracting text. ' +
                            'Useful for JavaScript-heavy pages, SPAs, or sites that require client-side rendering. ' +
                            'May be slower but provides more complete content extraction.',
                    },
                },
                required: ['url'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'fetch_image',
            description:
                'Fetches an image from a URL or local file path and attaches it to the conversation. ' +
                'Only use this with vision-capable models. After the tool call, the image will be visible to you. ' +
                'Supported formats: JPEG, PNG, GIF, WebP, BMP. Maximum size: 10 MB.',
            parameters: {
                type: 'object',
                properties: {
                    source: {
                        type: 'string',
                        description:
                            'A full http/https URL (e.g. https://example.com/photo.jpg) or an absolute ' +
                            'local file path (e.g. /home/user/photo.png or C:\\Users\\user\\photo.png).',
                    },
                },
                required: ['source'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'read_file',
            description:
                'Reads a file from the host filesystem. Use head_chars to read the first N characters, ' +
                'tail_chars to read the last N characters, or start/length to read a specific range.',
            parameters: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: 'A file path to read from, absolute or relative to the current agent working directory.',
                    },
                    head_chars: {
                        type: 'number',
                        description: 'Read only the first N characters of the file.',
                    },
                    tail_chars: {
                        type: 'number',
                        description: 'Read only the last N characters of the file.',
                    },
                    start: {
                        type: 'number',
                        description: 'Zero-based character index at which to begin reading.',
                    },
                    length: {
                        type: 'number',
                        description: 'Number of characters to read starting at start.',
                    },
                },
                required: ['path'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'patch_file',
            description:
                'Applies targeted replacements to an existing file. ' +
                'Each patch provides an exact old string and a new string. ' +
                'Prefer this for small edits instead of rewriting the whole file.',
            parameters: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: 'A file path to patch, absolute or relative to the current agent working directory.',
                    },
                    patches: {
                        type: 'array',
                        description: 'An array of targeted replacements to apply atomically.',
                        items: {
                            type: 'object',
                            properties: {
                                old: {
                                    type: 'string',
                                    description: 'The exact text to replace. Include enough surrounding context to make the match unique.',
                                },
                                new: {
                                    type: 'string',
                                    description: 'The replacement text.',
                                },
                            },
                            required: ['old', 'new'],
                        },
                    },
                },
                required: ['path', 'patches'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'write_file',
            description:
                'Writes text to a file on the host filesystem. Supports overwrite, append, and create-only semantics. ' +
                'If a target file already exists and overwrite is requested, the tool will replace it immediately. ' +
                'Use mode="create" to ensure a file is only created when missing.',
            parameters: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: 'A file path to write to, absolute or relative to the current agent working directory.',
                    },
                    content: {
                        type: 'string',
                        description: 'The text content to write into the file.',
                    },
                    mode: {
                        type: 'string',
                        description: 'The write mode: overwrite, append, or create.',
                        enum: ['overwrite', 'append', 'create'],
                    },
                },
                required: ['path', 'content'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'run_subagents',
            description:
                'Your primary tool for scaling beyond simple tasks. Sub-agents execute work in isolation and return only their final answer — saving thousands of context tokens. ' +
                'Use proactively for ANY multi-step work: research, file edits, code changes, comparisons, audits. ' +
                'Each sub-agent gets all normal tools, runs its own autonomous loop, and returns only its conclusion. ' +
                'You do NOT need the user to ask for sub-agents — they are a default tool, not a special case. ' +
                'Sub-agents are sequential; include ALL context inline; they cannot spawn further sub-agents.',
            parameters: {
                type: 'object',
                properties: {
                    agents: {
                        type: 'array',
                        description:
                            'One or more sub-agents to run sequentially. Each one needs a short id and a fully self-contained prompt. ' +
                            'Write each prompt as if the sub-agent has no prior context — include file paths, goals, constraints, and any relevant background.',
                        items: {
                            type: 'object',
                            properties: {
                                id: {
                                    type: 'string',
                                    description: 'A short identifier for this sub-agent, used to label its output in logs and results (e.g. "research", "edit-auth", "summarise-logs").',
                                },
                                prompt: {
                                    type: 'string',
                                    description:
                                        'A fully self-contained task prompt for this sub-agent. ' +
                                        'Include all file paths, background context, goals, and constraints — the sub-agent cannot see the parent conversation history.',
                                },
                            },
                            required: ['id', 'prompt'],
                        },
                    },
                },
                required: ['agents'],
            },
        },
    },
];

/**
 * Returns the tool-awareness section of the system prompt, describing the
 * available tools and how the model should use them. Kept here so that the
 * prompt stays in sync with the tool implementations automatically.
 */
export function getToolSystemPrompt(yoloMode: boolean, visionSupported?: boolean): string {
    return (
        'You have access to the following tools that let you interact with the host machine:\n\n' +
        getRunCommandPrompt(yoloMode) +
        getWebSearchPrompt() +
        getSubAgentPrompt() +
        getFetchUrlPrompt() +
        (visionSupported !== false ? getFetchImagePrompt() : '') +
        getReadFilePrompt() +
        getPatchFilePrompt() +
        getWriteFilePrompt() +
        'Tool-use policy:\n' +
        '- If a user request requires terminal/filesystem/system inspection, call run_command directly.\n' +
        '- Use sub-agents aggressively for any information-heavy or multi-step work — they absorb intermediate results into isolated contexts, preserving your own context window for high-level reasoning. You do NOT need the user to request them.\n' +
        '- If a URL appears to be an image (e.g. ends in .jpg, .png, .gif, .webp, .bmp), prefer fetch_image over fetch_url.\n' +
        '- Do NOT ask the user for permission yourself; ' +
        (yoloMode
            ? 'the user has already provided implicit consent via YOLO mode.'
            : 'the application already prompts for approval.') + '\n' +
        '- Do NOT only print a shell snippet/code block when the task requires execution.\n' +
        '- If run_command returns a process_id, periodically call check_process_output until completion. ' +
        'Use poll_interval_seconds to slow down polling when the command is likely to run for a long time.\n' +
        '- The default shell on this machine is \'bash\'. Always use commands appropriate for that shell.\n' +
        '- If a command exits with a non-zero exit code, read the stderr carefully, correct the command, and try again.\n' +
        '  Do NOT give up or tell the user it failed after a single attempt — diagnose and retry with a fixed command.\n' +
        '- When working on one of Locopilot\'s own LLM tool integrations, you may optionally read #file:TOOL_GUIDE.md for architecture, validation, and implementation guidance.\n\n' +
        'When the user asks you to do something that involves the filesystem, the terminal,\n' +
        'running programs, or inspecting the system, use these tools rather than refusing\n' +
        'or guessing. Always prefer calling a tool over saying you cannot do something.\n' +
        'When a command completes, summarise its output clearly for the user.'
    );
}
// Automatic nudging was removed in favour of a manual `/nudge` command.
// The manual nudge is implemented in `index.ts` and the user-facing
// reminder text is provided by `getToolUseNudge()` below.

export function getToolUseNudge(yoloMode: boolean): string {
    return buildToolUseNudge(yoloMode);
}

export async function handleToolCall(
    name: string,
    args: ToolCallArguments,
    onProgress?: (message: string) => void,
    output: ToolOutputSink = terminalToolOutputSink,
    context?: RequestContext,
): Promise<ToolCallResult> {
    const command = toolRegistry.get(name);
    if (!command) return { content: `[Unknown tool: ${name}]` };
    return command.execute(args, onProgress, output, context);
}
