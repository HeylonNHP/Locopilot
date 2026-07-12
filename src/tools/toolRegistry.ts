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

import { promises as fsp } from 'node:fs';
import path from 'node:path';

import type { ToolDefinition } from '../services/llm';
import type { WorkingDirectoryScope } from './workingDirectory';

import {
  DEFAULT_OLLAMA_CHAT_TIMEOUT_MS,
  DEFAULT_WEB_SEARCH_PER_PAGE_CHAR_LIMIT,
} from '../constants';
import { parsePositiveInteger, parsePositiveTimeoutMs, parseQueriesInput } from './commandHelpers';
import {
  type FetchImageResult,
  FetchImageTool,
  type FetchImageToolArgs,
} from './impl/fetchImageTool';
import { FetchUrlTool, type FetchUrlToolArgs } from './impl/fetchUrlTool';
import { runMCPCall } from './impl/mcpTool';
import { type PatchFilePatch, PatchFileTool, type PatchFileToolArgs } from './impl/patchFileTool';
import { ReadFileTool, type ReadFileToolArgs } from './impl/readFileTool';
import { ReadPdfTool, type ReadPdfToolArgs } from './impl/readPdfTool';
import { checkProcessOutput, DEFAULT_TIMEOUT_MS, runCommand } from './impl/runCommandTool';
import { runSearchMCPTools } from './impl/searchMcpToolsTool';
import {
  type WebSearchSettings,
  WebSearchTool,
  type WebSearchToolArgs,
} from './impl/webSearchTool';
import { WriteFileTool, type WriteFileToolArgs } from './impl/writeFileTool';
import { noopToolOutputSink, type ToolOutputSink } from './toolOutput';

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
  /** Tool names disabled for the main LLM (from user config) */
  disabledMainTools?: string[];
  /**
   * Per-request set of `mcp__<server>__<tool>` names the user has
   * pre-approved for this turn. Populated by the chat route from the
   * approval registry when an approval_request is resolved positively,
   * or eagerly when the server's `autoApprove` list covers the tool.
   * If the namespaced MCP tool name is in this list, `mcp_call`
   * proceeds without prompting. YOLO mode is also treated as an
   * implicit per-call approval regardless of this list.
   *
   * Stored as `string[]` to match the rest of the per-request
   * context; consumers (notably `runMCPCall`) wrap it in a `Set`
   * for O(1) membership checks.
   */
  mcpApprovals?: string[] | undefined;
  /** Model name for the current request (top-level, used by tools like read_pdf even outside sub-agents) */
  model?: string;
  /** Context window size for the current request (top-level, used by tools like read_pdf even outside sub-agents) */
  numCtx?: number;
  /**
   * Per-request identity token for working-directory tracking. Created
   * once per HTTP request (or sub-agent run) and threaded through to
   * tools that resolve relative paths via `resolveAgentPath`.
   */
  workingDirectoryScope?: WorkingDirectoryScope;
}

export interface SubAgentConfig {
  /** LLM provider (e.g. 'ollama', 'openai-compatible'). Threaded into the
   *  per-request LlmRequestContext so concurrent sub-agent runs do not
   *  clobber a shared adapter singleton. */
  provider?: 'ollama' | 'openai-compatible';
  /** Optional Bearer token for openai-compatible providers. */
  apiKey?: string;
  baseUrl: string;
  model: string;
  numCtx: number;
  compactionModel: string;
  tools: ToolDefinition[];
  /**
   * Sub-agent-local approval ledger for `mcp_call`. The chat route
   * seeds this with the parent's already-approved namespaced tool
   * names when the sub-agent's loop starts (Phase 3.4 — closes
   * the "sub-agent ignores parent pre-approvals" gap documented
   * in the Phase 1 bug-hunt). The sub-agent's approval-UX hook
   * ALSO mutates this set on a positive decision (via
   * `grantedTools`), so a single sub-agent loop that calls the
   * same MCP tool repeatedly doesn't re-prompt.
   *
   * Stored as `string[]` to match the rest of the per-request
   * context; consumers (notably `runMCPCall`) wrap it in a
   * `Set` for O(1) membership checks.
   */
  mcpApprovals?: string[] | undefined;
  /**
   * Optional hook for the parent chat route to receive an approval
   * request from inside a sub-agent. The sub-agent invokes this
   * when it tries to call a tool that requires user approval (e.g.
   * `run_command` outside YOLO mode). The chat route is responsible
   * for surfacing the request to the user (typically by sending an
   * `approval_request` SSE event on the parent's stream and
   * awaiting the corresponding /api/approve POST).
   *
   * If undefined, sub-agents fall back to the legacy behaviour:
   * run_command prompts the user via the TUI's confirm prompt (if
   * any) and proceeds. The web UI always provides this hook, so
   * the fallback is only hit in tests and the legacy TUI.
   */
  approvalRequester?: (request: {
    toolName: string;
    risk: 'command' | 'network' | 'file' | 'mcp' | 'other';
    args: unknown;
  }) => Promise<{ approved: boolean; grantedTools?: string[] }>;
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
  full_content?: boolean;
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
  start_page?: number;
  end_page?: number;
  extract_images?: boolean;
  // MCP tool-call args (Phase 1). The LLM should call the namespaced
  // `mcp__<server>__<tool>` name directly, but we expose a single
  // `mcp_call` tool that splits the namespace for clarity.
  server?: string;
  tool?: string;
  arguments?: Record<string, unknown>;
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
    signal?: AbortSignal
  ): Promise<ToolCallResult>;
}

// --- Tool permission helper ---

/**
 * Checks whether a tool is allowed by the current RequestContext.
 * Returns an error string if the tool is not allowed, or null if it is.
 */
function checkToolAllowed(toolName: string, context?: RequestContext): string | null {
  if (context?.allowedTools && context.allowedTools.length > 0 && !context.allowedTools.includes(toolName)) {
      return `[Error: tool "${toolName}" is not allowed by the currently active skills. Allowed tools: ${context.allowedTools.join(', ')}]`;
    }
  return null;
}

// --- Private adapter helpers ---

async function runWebSearch(
  args: WebSearchToolArgs,
  settings: WebSearchSettings,
  onProgress?: (message: string) => void,
  output: ToolOutputSink = noopToolOutputSink,
  signal?: AbortSignal
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
  model?: string,
  numCtx?: number,
  signal?: AbortSignal
): Promise<string> {
  const tool = new FetchUrlTool({
    settings: {
      ...settings,
      output,
    },
    model,
    numCtx,
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
  scope: WorkingDirectoryScope | undefined,
  model?: string,
  numCtx?: number,
  signal?: AbortSignal
): Promise<string> {
  const tool = new ReadFileTool({ output, scope, model, numCtx });
  return tool.run(args, signal);
}

async function runPatchFile(
  args: PatchFileToolArgs,
  output: ToolOutputSink = noopToolOutputSink,
  scope: WorkingDirectoryScope | undefined,
  signal?: AbortSignal
): Promise<string> {
  const tool = new PatchFileTool({ output, scope });
  return tool.run(args, signal);
}

async function runWriteFile(
  args: WriteFileToolArgs,
  scope: WorkingDirectoryScope | undefined,
  signal?: AbortSignal
): Promise<string> {
  const tool = new WriteFileTool({ scope });
  return tool.run(args, signal);
}

function runFetchImage(
  args: FetchImageToolArgs,
  onProgress?: (message: string) => void,
  output: ToolOutputSink = noopToolOutputSink,
  signal?: AbortSignal
): Promise<FetchImageResult> {
  const tool = new FetchImageTool({
    onProgress: (message: string) => {
      output.writeLine(message);
      onProgress?.(message);
    },
  });
  return tool.run(args, signal);
}

async function runReadPdf(
  args: ReadPdfToolArgs,
  output: ToolOutputSink = noopToolOutputSink,
  scope: WorkingDirectoryScope | undefined,
  model?: string,
  numCtx?: number,
  signal?: AbortSignal
): Promise<ToolCallResult> {
  const tool = new ReadPdfTool({ output, scope, model, numCtx });
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
            return {
              content:
                '[Error: invalid argument "timeout_seconds" (expected a positive finite number)]',
            };
          }
          timeoutMs = parsedTimeoutMs;
        }
        const cwd =
          typeof args.cwd === 'string' && args.cwd.trim().length > 0 ? args.cwd : undefined;
        if (args.cwd !== undefined && cwd === undefined) {
          return { content: '[Error: invalid argument "cwd" (expected a non-empty string)]' };
        }
        return {
          content: await runCommand(
            args.command,
            args.shell,
            timeoutMs,
            onProgress,
            cwd,
            output,
            context?.workingDirectoryScope,
            context?.yoloMode ?? false,
            signal
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
            return {
              content:
                '[Error: invalid argument "poll_interval_seconds" (expected a positive finite number)]',
            };
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
            return {
              content:
                '[Error: invalid argument "max_queries" (expected an integer between 1 and 10)]',
            };
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
            signal
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
              full_content: args.full_content === true,
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
            context?.model,  // Use parent's Airia model, not the subagent's local model
            context?.numCtx,
            signal
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
          content: await runReadFile(
            {
              path: args.path,
              head_chars: args.head_chars,
              tail_chars: args.tail_chars,
              start: args.start,
              length: args.length,
              start_line: args.start_line,
              end_line: args.end_line,
              line_count: args.line_count,
            },
            output,
            context?.workingDirectoryScope,
            context?.subAgent?.model ?? context?.model,
            context?.subAgent?.numCtx ?? context?.numCtx,
            signal
          ),
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
          content: await runPatchFile(
            {
              path: args.path,
              patches: args.patches,
            },
            output,
            context?.workingDirectoryScope,
            signal
          ),
        };
      },
    },
  ],
  [
    'write_file',
    {
      async execute(args, _onProgress, _output = noopToolOutputSink, context, signal) {
        const permErr = checkToolAllowed('write_file', context);
        if (permErr) return { content: permErr };
        if (typeof args.path !== 'string' || args.path.trim().length === 0) {
          return { content: '[Error: missing required argument "path"]' };
        }
        if (typeof args.content !== 'string') {
          return { content: '[Error: missing required argument "content"]' };
        }
        return {
          content: await runWriteFile(
            {
              path: args.path,
              content: args.content,
              mode: args.mode,
            },
            context?.workingDirectoryScope,
            signal
          ),
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
        const {
          getSkillByName,
          discoverSkills,
          loadSkillState,
          getEnabledSkills,
          invalidateSkillCache,
        } = await import('../services/skillManager');
        const skillName = args.skill_name.trim();
        const skill = getSkillByName(skillName);

        if (!skill) {
          // Cache may be stale — invalidate before re-discovering
          invalidateSkillCache();
          // Re-discover in case cache is stale
          const allSkills = discoverSkills();
          const state = loadSkillState();
          const enabled = getEnabledSkills(allSkills, state);
          const available = enabled
            .filter((s) => s.autoInvoke)
            .map((s) => s.name)
            .join(', ');
          return {
            content: `[Skill "${skillName}" not found or not enabled. Available skills: ${available || '(none)'}]`,
          };
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

        const sanitizedName = args.name.trim().toLowerCase().replaceAll(/\s+/g, '-');

        // Validate skill name to prevent path traversal
        if (
          sanitizedName.length === 0 ||
          sanitizedName.length > 64 ||
          /^[.-]/.test(sanitizedName)
        ) {
          return {
            content: `[Error: invalid skill name "${sanitizedName}". Names must be kebab-case, 1-64 chars, and may not contain path separators or "..".]`,
          };
        }
        if (sanitizedName.includes('\0') || /[/\\]/.test(sanitizedName) || sanitizedName.includes('..')) {
          return {
            content: `[Error: invalid skill name "${sanitizedName}". Names must be kebab-case, 1-64 chars, and may not contain path separators or "..".]`,
          };
        }

        const skillsBaseDir = path.resolve(process.cwd(), '.locopilot', 'skills');
        const skillDir = path.resolve(skillsBaseDir, sanitizedName);
        if (!skillDir.startsWith(skillsBaseDir + path.sep) && skillDir !== skillsBaseDir) {
          return {
            content: `[Error: invalid skill name "${sanitizedName}". Names must be kebab-case, 1-64 chars, and may not contain path separators or "..".]`,
          };
        }

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
          await fsp.writeFile(skillMdPath, frontmatter, 'utf8');

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
  [
    'read_pdf',
    {
      async execute(args, _onProgress, output = noopToolOutputSink, context, signal) {
        const permErr = checkToolAllowed('read_pdf', context);
        if (permErr) return { content: permErr };
        if (typeof args.path !== 'string' || args.path.trim().length === 0) {
          return { content: '[Error: missing required argument "path"]' };
        }
        const pdfArgs: ReadPdfToolArgs = {
          path: args.path,
          extract_images: args.extract_images === true,
        };
        if (args.start_page !== undefined) pdfArgs.start_page = args.start_page;
        if (args.end_page !== undefined) pdfArgs.end_page = args.end_page;
        return runReadPdf(
          pdfArgs,
          output,
          context?.workingDirectoryScope,
          context?.subAgent?.model ?? context?.model,
          context?.subAgent?.numCtx ?? context?.numCtx,
          signal
        );
      },
    },
  ],
  [
    'mcp_call',
    {
      async execute(args, _onProgress, _output, context, signal) {
        const permErr = checkToolAllowed('mcp_call', context);
        if (permErr) return { content: permErr };
        return runMCPCall(args, context, signal);
      },
    },
  ],
  [
    // Phase 3 (MCP Tool Search). Meta-tool: reads tool schema
    // metadata from the client manager, never invokes anything
    // dangerous, so it has no approval gate and no skill /
    // disabled-tool check. (It's the LLM's way of asking
    // "what's the shape of mcp__github__list_issues?" — the
    // answer is a JSON Schema, not a real call.)
    'search_mcp_tools',
    {
      async execute(args, _onProgress, _output, _context, _signal) {
        return runSearchMCPTools(args);
      },
    },
  ],
]);
