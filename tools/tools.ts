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

import { getToolPrompt as getWebSearchPrompt } from './impl/webSearchTool.js';
import { getToolPrompt as getFetchUrlPrompt } from './impl/fetchUrlTool.js';
import { getToolPrompt as getFetchImagePrompt } from './impl/fetchImageTool.js';
import { getToolPrompt as getReadFilePrompt } from './impl/readFileTool.js';
import { getToolPrompt as getPatchFilePrompt } from './impl/patchFileTool.js';
import { getToolPrompt as getWriteFilePrompt } from './impl/writeFileTool.js';
import { getToolPrompt as getSubAgentPrompt } from './impl/subAgentTool.js';
import { getToolPrompt as getRunCommandPrompt, defaultShell } from './impl/runCommandTool.js';
import { isYolo, toolRegistry, setSubAgentConfig, setYoloMode, setWebSearchConfig } from './toolRegistry.js';
import { terminalToolOutputSink, type ToolOutputSink } from './toolOutput.js';
import type { SubAgentConfig, ToolCallArguments, ToolCallResult, ToolWebSearchConfig } from './toolRegistry.js';
export { requestInterrupt, registerInterruptHandler, unregisterInterruptHandler, getInterruptHint, installKeyInterruptListener, removeKeyInterruptListener, clearInterrupt, isInterruptRequested } from './interruptManager.js';
export { isYolo, setSubAgentConfig, setYoloMode, setWebSearchConfig };
export type { SubAgentConfig, ToolCallArguments, ToolCallResult, ToolWebSearchConfig };
export type { ToolOutputSink } from './toolOutput.js';
export { terminalToolOutputSink } from './toolOutput.js';

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
        function: {
            name: 'run_command',
            description:
                'Executes a terminal command in the specified shell on the host machine. ' +
                'The user will be asked to approve the command before it runs. ' +
                'Returns the full stdout/stderr when the command finishes within the timeout, ' +
                    'or partial output plus a process_id when it is still running. ' +
                    'Use check_process_output to poll a long-running command for progress, ' +
                    'and pass a larger poll_interval_seconds when you want fewer status checks.',
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
                    cwd: {
                        type: 'string',
                        description:
                            'Optional working directory for the command. If omitted, Locopilot uses the tool\'s current default working directory.',
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
                    'completed). Also reports whether the process has finished and its exit code. ' +
                    'Use poll_interval_seconds to intentionally wait longer between snapshots ' +
                    'when the command is expected to take a long time.',
            parameters: {
                type: 'object',
                properties: {
                    process_id: {
                        type: 'number',
                        description: 'The process_id returned by run_command.',
                    },
                        poll_interval_seconds: {
                            type: 'number',
                            description:
                                'Optional seconds to wait before sampling stdout/stderr again. ' +
                                'Use this to reduce polling frequency for long-running commands.',
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
                        description: 'A file path to read from, absolute or relative to the current working directory.',
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
                        description: 'A file path to patch, absolute or relative to the current working directory.',
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
                        description: 'A file path to write to, absolute or relative to the current working directory.',
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
                'Delegate one or more bounded, independent tasks to isolated sub-agents so you can tackle complex work in parallel logical streams without polluting the parent conversation context. ' +
                'Ideal for: research across multiple topics, independent file edits, multi-step investigations, comparisons, or any work that can be cleanly decomposed into separate units. ' +
                'Each sub-agent runs its own full tool-calling loop with access to all normal tools, so it can read files, run commands, search the web, and iterate autonomously until its task is complete. ' +
                'Only the final response from each sub-agent is returned to you, keeping the parent history concise. ' +
                'Sub-agents are sequential and each receives only the prompt you write for it — include all required context inline.',
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
export function getToolSystemPrompt(): string {
    return (
        'You have access to the following tools that let you interact with the host machine:\n\n' +
        getRunCommandPrompt(isYolo()) +
        getWebSearchPrompt() +
        getFetchUrlPrompt() +
        getFetchImagePrompt() +
        getReadFilePrompt() +
        getPatchFilePrompt() +
        getWriteFilePrompt() +
        getSubAgentPrompt() +
        'Tool-use policy:\n' +
        '- If a user request requires terminal/filesystem/system inspection, call run_command directly.\n' +
        '- If a URL appears to be an image (e.g. ends in .jpg, .png, .gif, .webp, .bmp), prefer fetch_image over fetch_url.\n' +
        '- Do NOT ask the user for permission yourself; ' +
        (isYolo()
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

export function getToolUseNudge(): string {
    return (
        'Tool-use reminder: your previous response appears uncertain or incomplete. ' +
        'If you are not entirely certain, call web_search now and then answer using the fetched evidence. ' +
        'Do not use result_N placeholders; cite full URLs inline. ' +
        'If terminal access is needed, call run_command directly now. ' +
        (isYolo()
            ? 'The command will execute automatically.'
            : 'I (the app) will ask the human user for approval before execution.')
    );
}

export async function handleToolCall(
    name: string,
    args: ToolCallArguments,
    onProgress?: (message: string) => void,
    output: ToolOutputSink = terminalToolOutputSink,
): Promise<ToolCallResult> {
    const command = toolRegistry.get(name);
    if (!command) return { content: `[Unknown tool: ${name}]` };
    return command.execute(args, onProgress, output);
}
