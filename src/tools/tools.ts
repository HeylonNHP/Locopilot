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

import {
  createSkillToolSchema,
  getToolPrompt as getCreateSkillPrompt,
} from './impl/createSkillTool';
import { fetchImageToolSchema, getToolPrompt as getFetchImagePrompt } from './impl/fetchImageTool';
import { fetchUrlToolSchema, getToolPrompt as getFetchUrlPrompt } from './impl/fetchUrlTool';
import { getToolPrompt as getLoadSkillPrompt, loadSkillToolSchema } from './impl/loadSkillTool';
import {
  getToolPrompt as getMCPCallPrompt,
  mcpCallToolSchema,
  tryRunNamespacedMCPCall,
} from './impl/mcpTool';
import { getToolPrompt as getPatchFilePrompt, patchFileToolSchema } from './impl/patchFileTool';
import { getToolPrompt as getReadFilePrompt, readFileToolSchema } from './impl/readFileTool';
import { getToolPrompt as getReadPdfPrompt, readPdfToolSchema } from './impl/readPdfTool';
import {
  getToolPrompt as getRenderMermaidPrompt,
  renderMermaidToolSchema,
} from './impl/renderMermaidTool';
import {
  checkProcessOutputToolSchema,
  defaultShell,
  getToolPrompt as getRunCommandPrompt,
  runCommandToolSchema,
} from './impl/runCommandTool';
import {
  getToolPrompt as getSearchMcpToolsPrompt,
  searchMcpToolsToolSchema,
} from './impl/searchMcpToolsTool';
import { getToolPrompt as getSubAgentPrompt, subAgentToolSchema } from './impl/subAgentTool';
import { getToolPrompt as getWebSearchPrompt, webSearchToolSchema } from './impl/webSearchTool';
import { getToolPrompt as getWriteFilePrompt, writeFileToolSchema } from './impl/writeFileTool';

// Keep defaultShell export (used in runCommandToolSchema via defaultShell() call)
export { defaultShell } from './impl/runCommandTool';

import { noopToolOutputSink, type ToolOutputSink } from './toolOutput';
import {
  type RequestContext,
  type ToolCallArguments,
  type ToolCallResult,
  toolRegistry,
} from './toolRegistry';
export type { ToolOutputSink } from './toolOutput';

/**
 * Strips ANSI escape codes and Carriage Returns from text.
 * Carriage Returns (\r) in particular can cause the terminal cursor
 * to move backwards and overwrite previous text, making parts of
 * the output "disappear".
 */
export function sanitize(text: string): string {
  return (
    text
      // Normalize line endings to LF
      .replaceAll('\r\n', '\n')
      // Remove remaining lone Carriage Returns that could overwrite text
      .replaceAll('\r', '')
      // Strip ANSI escape codes (colors, cursor moves, screen clears)
      .replaceAll(
        new RegExp(
          `[${String.fromCodePoint(0x1b)}${String.fromCodePoint(0x9b)}][#();?[]*(?:\\d{1,4}(?:;\\d{0,4})*)?[\\d<=>A-ORZcf-nqry]`,
          'g'
        ),
        ''
      )
  );
}

// --- Internal process registry ---

// --- Tool schemas ---

export interface ToolSchema {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, ToolSchemaParameter>;
    required: string[];
  };
}

export interface ToolSchemaParameter {
  type: string;
  description?: string;
  items?: ToolSchemaParameter;
  enum?: string[];
  properties?: Record<string, ToolSchemaParameter>;
  required?: string[];
}

export type OllamaToolParameter = ToolSchemaParameter;

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
    function: webSearchToolSchema,
  },
  {
    type: 'function',
    function: fetchUrlToolSchema,
  },
  {
    type: 'function',
    function: fetchImageToolSchema,
  },
  {
    type: 'function',
    function: readFileToolSchema,
  },
  {
    type: 'function',
    function: patchFileToolSchema,
  },
  {
    type: 'function',
    function: writeFileToolSchema,
  },
  {
    type: 'function',
    function: subAgentToolSchema,
  },
  {
    type: 'function',
    function: loadSkillToolSchema,
  },
  {
    type: 'function',
    function: createSkillToolSchema,
  },
  {
    type: 'function',
    function: readPdfToolSchema,
  },
  {
    type: 'function',
    function: mcpCallToolSchema,
  },
  {
    type: 'function',
    function: searchMcpToolsToolSchema,
  },
  {
    type: 'function',
    function: renderMermaidToolSchema,
  },
];

/**
 * Returns the tool-awareness section of the system prompt, describing the
 * available tools and how the model should use them. Kept here so that the
 * prompt stays in sync with the tool implementations automatically.
 */
export function getToolSystemPrompt(yoloMode: boolean, visionSupported?: boolean): string {
  return (
    `You have access to the following tools that let you interact with the host machine:\n\n${getRunCommandPrompt(
      yoloMode
    )}${getWebSearchPrompt()}${getSubAgentPrompt()}${getFetchUrlPrompt()}${
      visionSupported === false ? '' : getFetchImagePrompt()
    }${getReadFilePrompt()}${getPatchFilePrompt()}${getWriteFilePrompt()}${getLoadSkillPrompt()}${getCreateSkillPrompt()}${getReadPdfPrompt()}${getMCPCallPrompt()}${getSearchMcpToolsPrompt()}${getRenderMermaidPrompt()}Tool-use policy:\n` +
    `- If a user request requires terminal/filesystem/system inspection, call run_command directly.\n` +
    `- Use sub-agents aggressively for any information-heavy or multi-step work — they absorb intermediate results into isolated contexts, preserving your own context window for high-level reasoning. You do NOT need the user to request them.\n` +
    `- If a URL appears to be an image (e.g. ends in .jpg, .png, .gif, .webp, .bmp), prefer fetch_image over fetch_url.\n` +
    `- If a URL or local path ends in .pdf, prefer read_pdf over fetch_url or read_file.\n` +
    `- Do NOT ask the user for permission yourself; ${
      yoloMode
        ? 'the user has already provided implicit consent via YOLO mode.'
        : 'the application already prompts for approval.'
    }\n` +
    `- Do NOT only print a shell snippet/code block when the task requires execution.\n` +
    `- If run_command returns a process_id, periodically call check_process_output until completion. ` +
    `Use poll_interval_seconds to slow down polling when the command is likely to run for a long time.\n` +
    `- The default shell on this machine is '${defaultShell()}'. Always use commands appropriate for that shell.\n` +
    `- If a command exits with a non-zero exit code, read the stderr carefully, correct the command, and try again.\n` +
    `  Do NOT give up or tell the user it failed after a single attempt — diagnose and retry with a fixed command.\n` +
    `- When working on one of Locopilot's own LLM tool integrations, you may optionally read #file:TOOL_GUIDE.md for architecture, validation, and implementation guidance.\n\n` +
    `When the user asks you to do something that involves the filesystem, the terminal,\n` +
    `running programs, or inspecting the system, use these tools rather than refusing\n` +
    `or guessing. Always prefer calling a tool over saying you cannot do something.\n` +
    `When a command completes, summarise its output clearly for the user.\n` +
    `\n` +
    `Skills: Use \`load_skill(skill_name)\` to retrieve full instructions for any skill listed under "Available Skills" above. ` +
    `Only call load_skill when a skill is clearly relevant to the current task.`
  );
}

export async function handleToolCall(
  name: string,
  args: ToolCallArguments,
  onProgress?: (message: string) => void,
  output: ToolOutputSink = noopToolOutputSink,
  context?: RequestContext,
  signal?: AbortSignal
): Promise<ToolCallResult> {
  const command = toolRegistry.get(name);
  if (command) return command.execute(args, onProgress, output, context, signal);
  // Namespaced MCP tools (`mcp__<server>__<tool>`) are exposed to the LLM
  // but are not in the static registry — dispatch them through the MCP layer.
  const mcpResult = await tryRunNamespacedMCPCall(name, args, context, signal);
  if (mcpResult) return mcpResult;
  return { content: `[Unknown tool: ${name}]` };
}

export { type RequestContext, type ToolCallArguments, type ToolCallResult } from './toolRegistry';
